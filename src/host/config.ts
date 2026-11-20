import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** 文本模型接入参数；API Key 只供 Host 使用，不进入前端契约。 */
export interface ModelConfig {
  baseUrl: string;
  modelId: string;
  apiKey: string;
  contextWindow: number;
  maxTokens: number;
  timeoutMs: number;
  imageInput?: true;
}

export interface HostConfig {
  dataDir: string;
  port: number;
  model: ModelConfig | null;
  embedding: EmbeddingConfig | null;
  image: { apiKey: string; modelId: SeedreamModelId; timeoutMs: number } | null;
}

/** 可选的兼容 /embeddings 服务；凭证只留在 Host，不随执行计划持久化。 */
export interface EmbeddingConfig {
  baseUrl: string;
  modelId: string;
  apiKey: string;
  timeoutMs: number;
  dimensions?: number;
}

/** 校验可选向量配置，完全留空时不启用任何向量请求。 */
function embeddingConfig(env: NodeJS.ProcessEnv): EmbeddingConfig | null {
  const baseUrl = env.ZHIBAN_EMBEDDING_BASE_URL?.trim();
  const modelId = env.ZHIBAN_EMBEDDING_MODEL_ID?.trim();
  const apiKey = env.ZHIBAN_EMBEDDING_API_KEY?.trim();
  if (![baseUrl, modelId, apiKey].some(Boolean)) return null;
  if (!baseUrl || !modelId || !apiKey)
    throw new Error(
      "向量模型需要同时配置 ZHIBAN_EMBEDDING_BASE_URL、ZHIBAN_EMBEDDING_MODEL_ID 和 ZHIBAN_EMBEDDING_API_KEY",
    );
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
    throw new Error("向量模型地址必须使用 HTTPS，或指向本机 HTTP 服务");
  if (url.username || url.password || url.search || url.hash)
    throw new Error("向量模型 Base URL 不能包含凭证、查询参数或片段");
  const dimensions = env.ZHIBAN_EMBEDDING_DIMENSIONS?.trim();
  const parsedDimensions = dimensions ? positiveInteger(dimensions, 0, "ZHIBAN_EMBEDDING_DIMENSIONS") : undefined;
  if (parsedDimensions !== undefined && parsedDimensions > 16384) throw new Error("向量维度不能超过 16384");
  return {
    baseUrl: url.toString().replace(/\/$/, ""),
    modelId,
    apiKey,
    timeoutMs: positiveInteger(env.ZHIBAN_EMBEDDING_TIMEOUT_MS, 10000, "ZHIBAN_EMBEDDING_TIMEOUT_MS"),
    ...(parsedDimensions !== undefined && { dimensions: parsedDimensions }),
  };
}

export type SeedreamModelId = "doubao-seedream-5-0-pro-260628" | "doubao-seedream-5-0-flash-260915";

/** 固定 Run 受理时的模型方案；密钥轮换不会改变已有 Run 的指纹。 */
export function modelPlanFingerprint(model: ModelConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        baseUrl: model.baseUrl,
        modelId: model.modelId,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        timeoutMs: model.timeoutMs,
        ...(model.imageInput ? { imageInput: true } : {}),
      }),
    )
    .digest("hex");
}

/** 读取正整数配置，缺省时返回约定默认值并拒绝非法输入。 */
function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return parsed;
}

/** 使用已核对的服务端能力作为自动额度；未知模型须显式声明，不能套用统一的输出上限。 */
function modelTokenLimits(url: URL, modelId: string): { contextWindow: number; maxTokens: number } | null {
  if (
    url.hostname === "api.deepseek.com" &&
    ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4-pro"].includes(modelId)
  )
    // DeepSeek 官方 /models 与文档于 2026-10-25 核对；这里只描述模型能力，不另设业务额度。
    return { contextWindow: 1_048_576, maxTokens: 393_216 };
  return null;
}

/** 自动采用已知模型的能力；仅用户显式配置时下调，并拒绝超过服务端能力的值。 */
function modelTokenLimit(value: string | undefined, maximum: number | undefined, name: string): number {
  if (value === undefined || value.trim() === "auto") {
    if (maximum !== undefined) return maximum;
    throw new Error(`${name} 无法自动识别，请填写该模型实际支持的值`);
  }
  const configured = positiveInteger(value, 0, name);
  if (maximum !== undefined && configured > maximum) throw new Error(`${name} 超过该模型支持的最大值 ${maximum}`);
  return configured;
}

/** 加载并校验 Host 监听、存储、模型和运行限制配置。 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  savedModel: Readonly<Record<string, string>> = {},
): HostConfig {
  const port = positiveInteger(env.ZHIBAN_PORT, 3210, "ZHIBAN_PORT");
  if (port > 65535) throw new Error("ZHIBAN_PORT 超出端口范围");

  const envBaseUrl = env.ZHIBAN_MODEL_BASE_URL?.trim();
  const envModelId = env.ZHIBAN_MODEL_ID?.trim();
  const envApiKey = env.ZHIBAN_MODEL_API_KEY?.trim();
  // 环境变量必须成组提供，避免把新旧配置拼成一个不可用的模型。
  const configuredFields = [envBaseUrl, envModelId, envApiKey].filter(Boolean).length;
  if (configuredFields !== 0 && configuredFields !== 3) {
    throw new Error("文本模型需要同时配置 ZHIBAN_MODEL_BASE_URL、ZHIBAN_MODEL_ID 和 ZHIBAN_MODEL_API_KEY");
  }
  const fromEnvironment = configuredFields === 3;
  const baseUrl = fromEnvironment ? envBaseUrl : savedModel.MODEL_BASE_URL?.trim();
  const modelId = fromEnvironment ? envModelId : savedModel.MODEL_ID?.trim();
  const apiKey = fromEnvironment ? envApiKey : savedModel.MODEL_API_KEY?.trim();
  const selectedFields = [baseUrl, modelId, apiKey].filter(Boolean).length;
  if (selectedFields !== 0 && selectedFields !== 3) throw new Error("加密模型配置不完整");

  let model: ModelConfig | null = null;
  if (baseUrl && modelId && apiKey) {
    const url = new URL(baseUrl);
    // 非本机模型只允许 HTTPS；本机 HTTP 用于开发和本地服务。
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
      throw new Error("模型地址必须使用 HTTPS，或指向本机 HTTP 服务");
    }
    // Runtime Plan 会持久化 Base URL，禁止把凭证藏在 URL 中。
    if (url.username || url.password || url.search || url.hash) {
      throw new Error("模型 Base URL 不能包含用户名、密码、查询参数或片段");
    }
    const limits = modelTokenLimits(url, modelId);
    const contextWindow = modelTokenLimit(
      env.ZHIBAN_MODEL_CONTEXT_WINDOW ?? (fromEnvironment ? undefined : savedModel.MODEL_CONTEXT_WINDOW),
      limits?.contextWindow,
      "ZHIBAN_MODEL_CONTEXT_WINDOW",
    );
    const maxTokens = modelTokenLimit(
      env.ZHIBAN_MODEL_MAX_TOKENS ?? (fromEnvironment ? undefined : savedModel.MODEL_MAX_TOKENS),
      limits?.maxTokens,
      "ZHIBAN_MODEL_MAX_TOKENS",
    );
    if (maxTokens >= contextWindow) throw new Error("模型最大输出必须小于上下文窗口，请同时核对两项配置");
    model = {
      baseUrl: url.toString().replace(/\/$/, ""),
      modelId,
      apiKey,
      contextWindow,
      maxTokens,
      timeoutMs: positiveInteger(
        env.ZHIBAN_MODEL_TIMEOUT_MS ?? (fromEnvironment ? undefined : savedModel.MODEL_TIMEOUT_MS),
        120_000,
        "ZHIBAN_MODEL_TIMEOUT_MS",
      ),
      ...(env.ZHIBAN_MODEL_IMAGE_INPUT === "true" || (!fromEnvironment && savedModel.MODEL_IMAGE_INPUT === "true")
        ? { imageInput: true as const }
        : {}),
    };
  }

  const seedreamApiKey = env.ZHIBAN_SEEDREAM_API_KEY?.trim() || env.ARK_API_KEY?.trim();
  return {
    dataDir: resolve(env.ZHIBAN_DATA_DIR?.trim() || ".data"),
    port,
    model,
    embedding: embeddingConfig(env),
    image: seedreamApiKey
      ? {
          apiKey: seedreamApiKey,
          modelId: imageModelId(env.ZHIBAN_SEEDREAM_MODEL_ID),
          timeoutMs: positiveInteger(env.ZHIBAN_IMAGE_TIMEOUT_MS, 180_000, "ZHIBAN_IMAGE_TIMEOUT_MS"),
        }
      : null,
  };
}

/** 只接受已明确核对生成与编辑能力的图片模型。 */
function imageModelId(value: string | undefined): SeedreamModelId {
  const id = value?.trim() || "doubao-seedream-5-0-flash-260915";
  if (id !== "doubao-seedream-5-0-pro-260628" && id !== "doubao-seedream-5-0-flash-260915")
    throw new Error("ZHIBAN_SEEDREAM_MODEL_ID 目前只支持 Seedream 5.0 pro 或 flash 的已核对模型 ID");
  return id;
}
