import type { DatabaseSync } from "node:sqlite";
import { MEMORY_ENTRY_LIMIT } from "../../../../shared/contracts.js";
import type { MemoryEmbeddingRecord, MemoryEmbeddingRef } from "../domain/memory-retrieval.js";
import { normalizeMemoryVector } from "../domain/memory-retrieval.js";

/** 在 Worker 内保存派生向量，缓存始终绑定商家、不可变记忆版本与模型指纹。 */
export function createMemoryEmbeddingOperations(db: DatabaseSync, transact: <T>(operation: () => T) => T) {
  /** 验证缓存操作引用真实归属和版本，不允许凭缓存键读取其他商家的正文。 */
  function requireVersion(merchantId: string, ref: MemoryEmbeddingRef): void {
    const row = db
      .prepare(`SELECT r.sha256 FROM merchant_memory m JOIN merchant_memory_revision r ON r.memory_id=m.memory_id
      WHERE m.merchant_id=? AND m.memory_id=? AND r.revision=?`)
      .get(merchantId, ref.memoryId, ref.revision);
    if (!row || row.sha256 !== ref.sha256) throw new Error("MEMORY_EMBEDDING_SOURCE_INVALID");
  }
  return {
    /** 只返回请求精确版本的缓存，缺失缓存交给应用层生成。 */
    getMemoryEmbeddings: (
      merchantId: string,
      embeddingKey: string,
      refs: MemoryEmbeddingRef[],
    ): MemoryEmbeddingRecord[] => {
      if (refs.length > MEMORY_ENTRY_LIMIT) throw new Error("MEMORY_EMBEDDING_LIMIT");
      const result: MemoryEmbeddingRecord[] = [];
      for (const ref of refs) {
        requireVersion(merchantId, ref);
        const row = db
          .prepare(`SELECT dimensions, vector FROM merchant_memory_embedding
          WHERE merchant_id=? AND memory_id=? AND revision=? AND memory_sha256=? AND embedding_key=?`)
          .get(merchantId, ref.memoryId, ref.revision, ref.sha256, embeddingKey);
        if (!row) continue;
        const dimensions = Number(row.dimensions);
        const bytes = row.vector as Uint8Array;
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== dimensions * 4)
          throw new Error("MEMORY_EMBEDDING_CACHE_INVALID");
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const vector = Array.from({ length: dimensions }, (_, index) => view.getFloat32(index * 4, true));
        result.push({
          memoryId: ref.memoryId,
          revision: ref.revision,
          sha256: ref.sha256,
          vector: normalizeMemoryVector(vector, dimensions),
        });
      }
      return result;
    },
    /** 同事务核验来源并写入小批向量，版本删除时由外键级联移除派生缓存。 */
    saveMemoryEmbeddings: (
      merchantId: string,
      embeddingKey: string,
      records: MemoryEmbeddingRecord[],
      now: string,
    ): void =>
      transact(() => {
        if (records.length > MEMORY_ENTRY_LIMIT) throw new Error("MEMORY_EMBEDDING_LIMIT");
        for (const record of records) {
          requireVersion(merchantId, record);
          const vector = normalizeMemoryVector(record.vector);
          const bytes = Buffer.alloc(vector.length * 4);
          vector.forEach((value, index) => {
            bytes.writeFloatLE(value, index * 4);
          });
          db.prepare(`INSERT INTO merchant_memory_embedding
          (merchant_id,memory_id,revision,memory_sha256,embedding_key,dimensions,vector,created_at)
          VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(memory_id,revision,embedding_key) DO UPDATE SET
          vector=excluded.vector, dimensions=excluded.dimensions, created_at=excluded.created_at`).run(
            merchantId,
            record.memoryId,
            record.revision,
            record.sha256,
            embeddingKey,
            vector.length,
            bytes,
            now,
          );
        }
      }),
  };
}
