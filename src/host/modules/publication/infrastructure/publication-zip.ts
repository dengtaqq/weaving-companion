import type { PublicationSnapshot } from "../../../../shared/publication.js";

/** 计算 ZIP 文件头所需的 CRC32，不引入系统命令或额外运行依赖。 */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 用固定安全文件名构建标准 UTF-8 ZIP，图片原字节不重复压缩。 */
function zip(files: Array<{ name: string; bytes: Buffer }>): Buffer {
  const entries: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const checksum = crc32(file.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(file.bytes.length, 18);
    local.writeUInt32LE(file.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(file.bytes.length, 20);
    central.writeUInt32LE(file.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    entries.push(local, name, file.bytes);
    directory.push(central, name);
    offset += local.length + name.length + file.bytes.length;
  }
  const centralBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, centralBytes, end]);
}

/** 只将用户确认版本的文案、配图和发布说明打包，保留可核对的版本清单。 */
export function renderPublicationZip(snapshot: PublicationSnapshot, imageBytes: Buffer[]): Buffer {
  const { draft, publication, images } = snapshot;
  const imageFiles = images.map((image, index) => ({
    name: `图片/${String(index + 1).padStart(2, "0")}-${index === 0 ? "封面" : "内页"}.${image.mimeType === "image/jpeg" ? "jpg" : image.mimeType === "image/webp" ? "webp" : "png"}`,
    bytes: imageBytes[index] as Buffer,
  }));
  const instructions = [
    "# 发布说明",
    "",
    "渠道：小红书",
    "状态：已确认的本地交付文件，尚未向平台发布。",
    "",
    "## 图片顺序",
    ...imageFiles.map((file, index) => `${index + 1}. ${file.name}：${publication.images[index]?.title}`),
    "",
    "## 本次发布要求",
    publication.instructions || "未另行填写；发布前请核对正文、话题、门店信息和活动有效期。",
    "",
    "## 版本",
    `文案第 ${draft.currentRevision} 版；图文编排第 ${publication.revision} 版。`,
  ].join("\n");
  return zip([
    { name: "文案.txt", bytes: Buffer.from(`${draft.title}\n\n${draft.body}\n`) },
    { name: "发布说明.md", bytes: Buffer.from(instructions) },
    {
      name: "版本清单.json",
      bytes: Buffer.from(
        JSON.stringify(
          {
            version: 1,
            draftId: draft.draftId,
            draftRevision: draft.currentRevision,
            draftHash: draft.sha256,
            publicationRevision: publication.revision,
            sourceRunId: draft.sourceRunId,
            source: snapshot.source,
            images: images.map((image, index) => ({
              file: imageFiles[index]?.name,
              artifactId: image.artifactId,
              sha256: image.blobHash,
            })),
          },
          null,
          2,
        ),
      ),
    },
    ...imageFiles,
  ]);
}
