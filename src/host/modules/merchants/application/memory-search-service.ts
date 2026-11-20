import { createHash } from "node:crypto";
import type { MerchantMemory } from "../../../../shared/contracts.js";
import type { EmbeddingConfig } from "../../../config.js";
import type { DbClient } from "../../../infrastructure/sqlite/db-client.js";
import {
  fuseMemoryRanks,
  MEMORY_SEARCH_LIMIT,
  type MemoryEmbeddingRecord,
  type MemoryRank,
  type MemorySearchPlan,
  memoryVectorSimilarity,
  normalizeMemoryVector,
  rankMemoryBm25,
} from "../domain/memory-retrieval.js";

export interface MemorySearchBudget {
  /** 外发每次向量请求前预留模型调用额度。 */
  reserve(): Promise<string | null>;
  /** 请求完成后结算实际或未知 token 用量。 */
  settle(key: string, tokens: number | null): Promise<void>;
}
export interface MemorySearchResult {
  hits: MemoryRank[];
  strategy: "BM25" | "HYBRID";
  fallbackReason?: "EMBEDDING_CONFIG_CHANGED" | "EMBEDDING_UNAVAILABLE";
}
type EmbeddingStore = Pick<DbClient, "getMemoryEmbeddings" | "saveMemoryEmbeddings">;
const EMBEDDING_BATCH_SIZE = 16;
// 只作为初始噪声过滤线，不代表普适的语义正确率；业务质量仍需实际样例验收。
const MIN_VECTOR_SIMILARITY = 0.35;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** 标记额度持久化失败，禁止把任务暂停或结算失败伪装成普通检索降级。 */
class EmbeddingBudgetFailure extends Error {
  /** 保留原错误供运行适配器处理，不包含模型返回正文。 */
  constructor(readonly original: unknown) {
    super("EMBEDDING_BUDGET_FAILED");
  }
}

/** 在小规模冻结记忆集合内执行 BM25，配置可用时增加向量并用排名融合。 */
export class MemorySearchService {
  /** 绑定本地派生缓存和仅 Host 可见的可选向量配置。 */
  constructor(
    private readonly store: EmbeddingStore,
    private readonly config: EmbeddingConfig | null,
  ) {}

  /** 不扩大冻结集合；服务异常降级，用户取消和任务额度错误继续传播。 */
  async search(
    merchantId: string,
    memories: readonly MerchantMemory[],
    query: string,
    plan: MemorySearchPlan,
    signal?: AbortSignal,
    budget?: MemorySearchBudget,
  ): Promise<MemorySearchResult> {
    signal?.throwIfAborted();
    if (memories.some((item) => item.merchantId !== merchantId)) throw new Error("TOOL_MERCHANT_NOT_AUTHORIZED");
    const lexical = rankMemoryBm25(memories, query);
    if (plan.mode === "BM25" || !query.trim() || !memories.length)
      return { hits: lexical.slice(0, MEMORY_SEARCH_LIMIT), strategy: "BM25" };
    const config = this.config;
    // 冻结配置不匹配时不能把商家文字发送给新地址，改用同一集合的本地检索。
    if (
      !config ||
      config.baseUrl !== plan.embedding.baseUrl ||
      config.modelId !== plan.embedding.modelId ||
      config.dimensions !== plan.embedding.dimensions ||
      config.timeoutMs !== plan.embedding.timeoutMs
    )
      return {
        hits: lexical.slice(0, MEMORY_SEARCH_LIMIT),
        strategy: "BM25",
        fallbackReason: "EMBEDDING_CONFIG_CHANGED",
      };
    const requestSignal = AbortSignal.any([AbortSignal.timeout(config.timeoutMs), ...(signal ? [signal] : [])]);
    try {
      const embeddingKey = createHash("sha256")
        .update(
          JSON.stringify({
            version: 1,
            baseUrl: config.baseUrl,
            modelId: config.modelId,
            dimensions: config.dimensions ?? null,
          }),
        )
        .digest("hex");
      const refs = memories.map(({ memoryId, revision, sha256 }) => ({ memoryId, revision, sha256 }));
      const cached = await this.store.getMemoryEmbeddings(merchantId, embeddingKey, refs);
      const [queryVector] = await this.embed(config, [query], requestSignal, budget);
      if (!queryVector) throw new Error("EMBEDDING_VECTOR_INVALID");
      const vectors = new Map(
        cached.filter((item) => item.vector.length === queryVector.length).map((item) => [item.memoryId, item.vector]),
      );
      const missing = memories.filter((item) => !vectors.has(item.memoryId));
      for (let offset = 0; offset < missing.length; offset += EMBEDDING_BATCH_SIZE) {
        const batch = missing.slice(offset, offset + EMBEDDING_BATCH_SIZE);
        const generated = await this.embed(
          config,
          batch.map((item) => `${item.title}\n${item.content}`),
          requestSignal,
          budget,
          queryVector.length,
        );
        const records: MemoryEmbeddingRecord[] = batch.map((item, index) => {
          const vector = generated[index];
          if (!vector) throw new Error("EMBEDDING_VECTOR_INVALID");
          vectors.set(item.memoryId, vector);
          return { memoryId: item.memoryId, revision: item.revision, sha256: item.sha256, vector };
        });
        requestSignal.throwIfAborted();
        await this.store.saveMemoryEmbeddings(merchantId, embeddingKey, records);
      }
      requestSignal.throwIfAborted();
      const semantic = memories
        .map((item) => ({ item, score: memoryVectorSimilarity(queryVector, vectors.get(item.memoryId) ?? []) }))
        .filter((hit) => hit.score >= MIN_VECTOR_SIMILARITY)
        .sort((a, b) => b.score - a.score);
      return { hits: fuseMemoryRanks(lexical, semantic).slice(0, MEMORY_SEARCH_LIMIT), strategy: "HYBRID" };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof EmbeddingBudgetFailure) throw error.original;
      return { hits: lexical.slice(0, MEMORY_SEARCH_LIMIT), strategy: "BM25", fallbackReason: "EMBEDDING_UNAVAILABLE" };
    }
  }

  /** 调用兼容 /embeddings 接口；每个实际请求独立计费，不自动重试或跟随重定向。 */
  private async embed(
    config: EmbeddingConfig,
    texts: string[],
    signal: AbortSignal,
    budget?: MemorySearchBudget,
    dimensions?: number,
  ): Promise<number[][]> {
    signal.throwIfAborted();
    let key: string | null = null;
    try {
      key = (await budget?.reserve()) ?? null;
    } catch (error) {
      throw new EmbeddingBudgetFailure(error);
    }
    let tokens: number | null = null;
    let vectors: number[][] | null = null;
    let failure: { error: unknown } | null = null;
    try {
      signal.throwIfAborted();
      const response = await fetch(`${config.baseUrl}/embeddings`, {
        method: "POST",
        redirect: "error",
        signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.modelId,
          input: texts,
          encoding_format: "float",
          ...(config.dimensions !== undefined && { dimensions: config.dimensions }),
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("EMBEDDING_REQUEST_FAILED");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("EMBEDDING_RESPONSE_INVALID");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > MAX_RESPONSE_BYTES) throw new Error("EMBEDDING_RESPONSE_TOO_LARGE");
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        data?: { index?: unknown; embedding?: unknown }[];
        usage?: { total_tokens?: unknown };
      };
      if (
        typeof result.usage?.total_tokens === "number" &&
        Number.isSafeInteger(result.usage.total_tokens) &&
        result.usage.total_tokens >= 0
      )
        tokens = result.usage.total_tokens;
      if (!Array.isArray(result.data) || result.data.length !== texts.length)
        throw new Error("EMBEDDING_RESPONSE_INVALID");
      const ordered: number[][] = new Array(texts.length);
      for (const row of result.data) {
        if (
          !row ||
          typeof row.index !== "number" ||
          !Number.isInteger(row.index) ||
          row.index < 0 ||
          row.index >= texts.length ||
          ordered[row.index]
        )
          throw new Error("EMBEDDING_RESPONSE_INVALID");
        ordered[row.index] = normalizeMemoryVector(row.embedding, dimensions ?? config.dimensions);
      }
      const vectorDimensions = ordered[0]?.length;
      if (!vectorDimensions || ordered.some((vector) => vector.length !== vectorDimensions))
        throw new Error("EMBEDDING_DIMENSION_MISMATCH");
      vectors = ordered;
    } catch (error) {
      failure = { error };
    }
    // 先结算再传播请求失败；额度存储失败必须显式终止，不能被检索降级吞掉。
    if (key && budget) {
      try {
        await budget.settle(key, tokens);
      } catch (error) {
        throw new EmbeddingBudgetFailure(error);
      }
    }
    if (failure) throw failure.error;
    if (!vectors) throw new Error("EMBEDDING_RESPONSE_INVALID");
    return vectors;
  }
}
