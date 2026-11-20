import { type GenerationJobRecord, MAX_MANAGED_IMAGE_BYTES } from "../../../../shared/contracts.js";

/** 检查 PNG 头、尺寸及完整 IEND 块，拒绝截断的图片字节。 */
function validPng(bytes: Buffer): boolean {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  let offset = 8;
  let first = true;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) return false;
    const kind = bytes.toString("ascii", offset + 4, offset + 8);
    if (
      first &&
      (kind !== "IHDR" ||
        length !== 13 ||
        bytes.readUInt32BE(offset + 8) === 0 ||
        bytes.readUInt32BE(offset + 12) === 0)
    )
      return false;
    if (kind === "IEND") return length === 0 && offset + 12 === bytes.length;
    first = false;
    offset += 12 + length;
  }
  return false;
}

/** 图片 Provider 返回的已解码结果与真实请求标识。 */
export interface ImageMediaResult {
  bytes: Buffer;
  mimeType: "image/png";
  providerRequestId: string | null;
}

/** 外部请求的失败分类；发出后结果不确定时不能自动重试。 */
export class ImageMediaError extends Error {
  /** 保留可用于对账的真实 Provider 请求标识。 */
  constructor(
    readonly code: string,
    readonly unknownExternal: boolean,
    readonly providerRequestId: string | null = null,
  ) {
    super(code);
  }
}

/** 将已冻结的图片任务提交到具体供应商。 */
export interface ImageMediaPort {
  /** 提交已冻结的图片任务并返回真实图片字节。 */
  submit(job: GenerationJobRecord, reference?: { mimeType: string; bytes: Buffer }): Promise<ImageMediaResult>;
}

/** 将页面的清晰度档位映射为 Seedream pro/flash 接受的精确输出像素。 */
function seedreamSize(job: GenerationJobRecord): string {
  const sizes = {
    "1024x1024": { low: "1024x1024", medium: "1536x1536", high: "2048x2048" },
    "1536x1024": { low: "1536x1024", medium: "1920x1280", high: "2496x1664" },
    "1024x1536": { low: "1024x1536", medium: "1280x1920", high: "1664x2496" },
  } as const;
  const size = sizes[job.size]?.[job.quality];
  if (!size) throw new ImageMediaError("IMAGE_SIZE_INVALID", false);
  return size;
}

/** 使用火山方舟 Seedream 5.0 pro/flash 执行一次文生图或参考图文字改图。 */
export class SeedreamImageMediaPort implements ImageMediaPort {
  /** 注入请求函数只用于隔离验证；生产固定走火山方舟官方 HTTPS 地址。 */
  constructor(
    private readonly apiKey: string,
    private readonly timeoutMs: number,
    private readonly request: typeof fetch = fetch,
    private readonly baseUrl = "https://ark.cn-beijing.volces.com/api/v3",
  ) {}

  /** 同一接口以可选 image 字段区分生图和改图，回执必须含真实 PNG 字节。 */
  async submit(job: GenerationJobRecord, reference?: { mimeType: string; bytes: Buffer }): Promise<ImageMediaResult> {
    const isEdit = job.intent === "MODIFY";
    if (isEdit !== Boolean(reference)) throw new ImageMediaError("IMAGE_REFERENCE_INVALID", false);
    const input = {
      model: job.modelId,
      prompt: job.prompt,
      size: seedreamSize(job),
      output_format: "png",
      response_format: "b64_json",
      watermark: false,
      ...(reference ? { image: `data:${reference.mimeType};base64,${reference.bytes.toString("base64")}` } : {}),
    };
    let response: Response;
    try {
      response = await this.request(`${this.baseUrl}/images/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ImageMediaError("IMAGE_PROVIDER_RESULT_UNKNOWN", true);
    }
    const requestId = response.headers.get("x-request-id") ?? response.headers.get("x-tt-logid");
    if (!response.ok) {
      // 408/5xx 可能发生在请求执行后，保守保留结果未知；其余 4xx 是明确拒绝。
      throw new ImageMediaError(
        `IMAGE_PROVIDER_HTTP_${response.status}`,
        response.status === 408 || response.status >= 500,
        requestId,
      );
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ImageMediaError("IMAGE_PROVIDER_RESPONSE_INVALID", true, requestId);
    }
    const items = (data as { data?: Array<{ b64_json?: unknown; output_format?: unknown }> })?.data;
    const item = items?.[0];
    if (!item || items?.length !== 1 || (item.output_format && item.output_format !== "png"))
      throw new ImageMediaError("IMAGE_PROVIDER_RESPONSE_INVALID", true, requestId);
    const encoded = item.b64_json;
    if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
      throw new ImageMediaError("IMAGE_PROVIDER_RESPONSE_INVALID", true, requestId);
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length > MAX_MANAGED_IMAGE_BYTES || !validPng(bytes))
      throw new ImageMediaError("IMAGE_PROVIDER_IMAGE_INVALID", true, requestId);
    return { bytes, mimeType: "image/png", providerRequestId: requestId };
  }
}
