import { createHash, randomUUID } from "node:crypto";
import type { PublicPageEvidenceRecord } from "../../../../shared/contracts.js";
import type { FileStore } from "../../../infrastructure/files/files.js";
import type { DbClient } from "../../../infrastructure/sqlite/db-client.js";
import { prepareImageInput } from "../../media/infrastructure/image-input.js";
import type { CollectedPublicPage } from "./public-page-collector.js";

/** 先保存截图字节，再由证据事务同时登记来源与素材，取消后不能登记迟到结果。 */
export async function saveCollectedPublicPage(
  store: Pick<DbClient, "createPublicEvidence">,
  files: Pick<FileStore, "putBlob">,
  merchantId: string | null,
  sessionId: string,
  runId: string,
  collected: CollectedPublicPage,
  signal?: AbortSignal,
): Promise<PublicPageEvidenceRecord> {
  const { imageCaptures, ...page } = collected;
  const images = [];
  if (["COLLECTED", "LIMITED"].includes(page.status)) {
    for (const capture of (imageCaptures ?? []).slice(0, 3)) {
      signal?.throwIfAborted();
      const blob = await files.putBlob(Buffer.from(capture.bytes));
      images.push({
        artifactId: `art_${randomUUID()}`,
        blobHash: blob.hash,
        mimeType: "image/png" as const,
        sizeBytes: blob.size,
        description: capture.description,
        captureKind: "PAGE_IMAGE_SCREENSHOT" as const,
      });
    }
  }
  signal?.throwIfAborted();
  return store.createPublicEvidence(merchantId, sessionId, runId, { ...page, ...(images.length && { images }) });
}

/** 只把归属与哈希复核通过的受管截图送入模型；每次回执最多五张。 */
export async function publicPageImageContent(
  store: Pick<DbClient, "getArtifact">,
  files: Pick<FileStore, "readBlob">,
  sessionId: string,
  pages: PublicPageEvidenceRecord[],
  enabled: boolean,
  signal?: AbortSignal,
): Promise<Array<{ type: "image"; data: string; mimeType: string }>> {
  if (!enabled) return [];
  const content: Array<{ type: "image"; data: string; mimeType: string }> = [];
  for (const page of pages) {
    if (page.sessionId !== sessionId || !["COLLECTED", "LIMITED"].includes(page.status)) continue;
    for (const image of page.images ?? []) {
      if (content.length >= 5) return content;
      signal?.throwIfAborted();
      const artifact = await store.getArtifact(image.artifactId);
      if (
        artifact?.sessionId !== sessionId ||
        artifact.kind !== "public_reference_image" ||
        artifact.status !== "READY" ||
        artifact.blobHash !== image.blobHash ||
        artifact.mimeType !== image.mimeType ||
        artifact.sizeBytes !== image.sizeBytes
      )
        throw new Error("PUBLIC_IMAGE_INVALID");
      const bytes = await files.readBlob(image.blobHash);
      if (createHash("sha256").update(bytes).digest("hex") !== image.blobHash) throw new Error("PUBLIC_IMAGE_INVALID");
      const prepared = await prepareImageInput(bytes, image.mimeType);
      content.push({ type: "image", data: prepared.bytes.toString("base64"), mimeType: prepared.mimeType });
    }
  }
  return content;
}
