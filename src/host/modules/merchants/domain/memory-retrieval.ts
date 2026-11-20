import type { MerchantMemory } from "../../../../shared/contracts.js";
import type { EmbeddingConfig } from "../../../config.js";

export type EmbeddingPlan = Omit<EmbeddingConfig, "apiKey">;
export type MemorySearchPlan = { version: 1; mode: "BM25" } | { version: 1; mode: "HYBRID"; embedding: EmbeddingPlan };
export interface MemoryRank {
  item: MerchantMemory;
  score: number;
}
export interface MemoryEmbeddingRef {
  memoryId: string;
  revision: number;
  sha256: string;
}
export interface MemoryEmbeddingRecord extends MemoryEmbeddingRef {
  vector: number[];
}
const BM25_K1 = 1.2;
export const MEMORY_SEARCH_LIMIT = 10;
const BM25_B = 0.75;
const RRF_K = 60;
const segmenter = new Intl.Segmenter("zh-Hans", { granularity: "word" });
const stopWords = new Set(["的", "了", "是", "和", "与", "在", "把", "将", "我", "我们", "你", "这个", "那个"]);

/** 冻结非敏感的检索策略，旧计划缺少此字段时继续走原检索。 */
export function memorySearchPlan(config: EmbeddingConfig | null): MemorySearchPlan {
  if (!config) return { version: 1, mode: "BM25" };
  const { apiKey: _apiKey, ...embedding } = config;
  return { version: 1, mode: "HYBRID", embedding };
}

/** 在读取持久计划时校验策略与服务地址，不接受未知版本或含凭证地址。 */
export function isMemorySearchPlan(value: unknown): value is MemorySearchPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Partial<Extract<MemorySearchPlan, { mode: "HYBRID" }>>;
  if (plan.version !== 1) return false;
  if ((value as { mode?: string }).mode === "BM25")
    return Object.keys(value).every((key) => ["version", "mode"].includes(key));
  const model = plan.embedding;
  if (
    Object.keys(value).some((key) => !["version", "mode", "embedding"].includes(key)) ||
    plan.mode !== "HYBRID" ||
    !model ||
    Object.keys(model).some((key) => !["baseUrl", "modelId", "timeoutMs", "dimensions"].includes(key))
  )
    return false;
  try {
    const url = new URL(model.baseUrl);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) &&
      typeof model.modelId === "string" &&
      model.modelId.trim().length > 0 &&
      Number.isSafeInteger(model.timeoutMs) &&
      model.timeoutMs > 0 &&
      (model.dimensions === undefined ||
        (Number.isSafeInteger(model.dimensions) && model.dimensions > 0 && model.dimensions <= 16384))
    );
  } catch {
    return false;
  }
}

/** 中文按词切分并补相邻双字，英文与数字按词保留；词频用于真正的 BM25。 */
export function memoryTerms(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  const terms: string[] = [];
  const positions = new Set<string>();
  for (const part of segmenter.segment(normalized)) {
    if (!part.isWordLike || stopWords.has(part.segment)) continue;
    terms.push(part.segment);
    positions.add(`${part.index}:${part.segment}`);
  }
  for (const match of normalized.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const chars = Array.from(match[0]);
    let position = match.index;
    for (let index = 0; index < chars.length - 1; index++) {
      const term = chars.slice(index, index + 2).join("");
      if (!stopWords.has(term) && !positions.has(`${position}:${term}`)) terms.push(term);
      position += chars[index]?.length ?? 0;
    }
  }
  return terms;
}

/** 仅在调用方提供的冻结语料中计算词频、逆文档频率与长度归一化。 */
export function rankMemoryBm25(memories: readonly MerchantMemory[], query: string): MemoryRank[] {
  if (!query.trim()) return memories.map((item) => ({ item, score: 0 }));
  const queryTerms = [...new Set(memoryTerms(query))];
  if (!queryTerms.length || !memories.length) return [];
  const documents = memories.map((item) => {
    const terms = memoryTerms(`${item.title}\n${item.content}`);
    const frequency = new Map<string, number>();
    for (const term of terms) frequency.set(term, (frequency.get(term) ?? 0) + 1);
    return { item, frequency, length: terms.length };
  });
  const averageLength = documents.reduce((sum, doc) => sum + doc.length, 0) / documents.length || 1;
  const documentFrequency = new Map(
    queryTerms.map((term) => [term, documents.filter((doc) => doc.frequency.has(term)).length]),
  );
  return documents
    .map((doc) => {
      let score = 0;
      for (const term of queryTerms) {
        const tf = doc.frequency.get(term) ?? 0;
        if (!tf) continue;
        const df = documentFrequency.get(term) ?? 0;
        const idf = Math.log1p((documents.length - df + 0.5) / (df + 0.5));
        score += (idf * (tf * (BM25_K1 + 1))) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / averageLength));
      }
      return { item: doc.item, score };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** 保留旧计划的字面计分语义，避免升级后恢复时改变其检索策略。 */
export function rankLegacyMemory(memories: readonly MerchantMemory[], query: string): MemoryRank[] {
  const normalized = query.trim().toLowerCase();
  const terms = [
    ...new Set(
      [
        normalized,
        ...normalized.split(/\s+/),
        ...(normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []).flatMap((word) =>
          Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2)),
        ),
      ].filter(Boolean),
    ),
  ];
  return memories
    .map((item) => ({
      item,
      score: terms.reduce(
        (score, term) => score + (`${item.title}\n${item.content}`.toLowerCase().includes(term) ? term.length : 0),
        0,
      ),
    }))
    .filter((hit) => !normalized || hit.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** 校验并归一化向量，拒绝空向量、非有限数值、零模长与不匹配维度。 */
export function normalizeMemoryVector(value: unknown, dimensions?: number): number[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 16384 ||
    (dimensions !== undefined && value.length !== dimensions) ||
    value.some((item) => typeof item !== "number" || !Number.isFinite(item))
  )
    throw new Error("EMBEDDING_VECTOR_INVALID");
  const scale = Math.max(...value.map((item) => Math.abs(item as number)));
  if (!scale) throw new Error("EMBEDDING_VECTOR_INVALID");
  const scaled = (value as number[]).map((item) => item / scale);
  const norm = Math.sqrt(scaled.reduce((sum, item) => sum + item * item, 0));
  return scaled.map((item) => Math.fround(item / norm));
}

/** 对已归一化的同维向量计算余弦相似度。 */
export function memoryVectorSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) throw new Error("EMBEDDING_DIMENSION_MISMATCH");
  return Math.max(
    -1,
    Math.min(
      1,
      left.reduce((sum, item, index) => sum + item * (right[index] ?? 0), 0),
    ),
  );
}

/** 使用排名倒数融合两路结果，避免直接相加不可比较的 BM25 与余弦分数。 */
export function fuseMemoryRanks(lexical: readonly MemoryRank[], semantic: readonly MemoryRank[]): MemoryRank[] {
  const hits = new Map<string, MemoryRank>();
  for (const ranking of [lexical, semantic]) {
    for (const [index, hit] of ranking.slice(0, MEMORY_SEARCH_LIMIT).entries()) {
      const previous = hits.get(hit.item.memoryId);
      hits.set(hit.item.memoryId, { item: hit.item, score: (previous?.score ?? 0) + 1 / (RRF_K + index + 1) });
    }
  }
  return [...hits.values()].sort((a, b) => b.score - a.score);
}
