import { resizeImage } from "@earendil-works/pi-coding-agent";
import { MAX_INLINE_IMAGE_BYTES, MAX_MANAGED_IMAGE_BYTES } from "../../../../shared/contracts.js";

/** 从受管原图生成有界模型输入，不改变原图、引用或下载字节。 */
export async function prepareImageInput(bytes: Buffer, mimeType: string): Promise<{ bytes: Buffer; mimeType: string }> {
  if (!bytes.length || bytes.length > MAX_MANAGED_IMAGE_BYTES) throw new Error("IMAGE_INPUT_LIMIT");
  if (bytes.length <= MAX_INLINE_IMAGE_BYTES) return { bytes, mimeType };
  // SDK 的 maxBytes 限制 base64 负载；输出自然小于原始字节上限，不能扩大 Provider 输入。
  const resized = await resizeImage(bytes, mimeType, { maxBytes: MAX_INLINE_IMAGE_BYTES });
  if (!resized || !["image/png", "image/jpeg", "image/webp"].includes(resized.mimeType))
    throw new Error("IMAGE_INPUT_LIMIT");
  const prepared = Buffer.from(resized.data, "base64");
  if (!prepared.length || prepared.length > MAX_INLINE_IMAGE_BYTES) throw new Error("IMAGE_INPUT_LIMIT");
  return { bytes: prepared, mimeType: resized.mimeType };
}
