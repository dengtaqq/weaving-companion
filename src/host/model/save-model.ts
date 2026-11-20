import { loadEnvFile } from "node:process";
import { loadConfig } from "../config.js";
import { FileStore } from "../infrastructure/files/files.js";
import { EncryptedSecretStore } from "../infrastructure/security/secret-store.js";

/** 从项目本地配置与显式进程环境读取模型参数，并加密保存到本机数据目录。 */
async function main(): Promise<void> {
  try {
    loadEnvFile(new URL("../../../.env", import.meta.url));
  } catch (error) {
    // 未创建本地文件时保留原有环境变量用法；其他读取错误不能冒充配置缺失。
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw new Error("读取项目 .env 失败，请检查文件权限和格式。");
  }
  const masterKey = process.env.ZHIBAN_MASTER_KEY?.trim();
  if (!masterKey) throw new Error("请先通过 .env 或进程环境设置 ZHIBAN_MASTER_KEY");
  const config = loadConfig();
  if (!config.model) throw new Error("请同时配置文本模型地址、模型 ID 和 API Key");
  const files = new FileStore(config.dataDir);
  await files.prepare();
  const releaseLease = await files.acquireLease();
  try {
    const store = await EncryptedSecretStore.open(config.dataDir, masterKey);
    await store.setMany({
      MODEL_BASE_URL: config.model.baseUrl,
      MODEL_ID: config.model.modelId,
      MODEL_API_KEY: config.model.apiKey,
      // 保存自动策略而非本次解析值，后续能力更新不会被旧默认值继续锁住。
      MODEL_CONTEXT_WINDOW: process.env.ZHIBAN_MODEL_CONTEXT_WINDOW?.trim() || "auto",
      MODEL_MAX_TOKENS: process.env.ZHIBAN_MODEL_MAX_TOKENS?.trim() || "auto",
      MODEL_TIMEOUT_MS: String(config.model.timeoutMs),
      MODEL_IMAGE_INPUT: String(config.model.imageInput === true),
    });
    process.stdout.write("模型配置已加密保存到本机数据目录。\n");
  } finally {
    await releaseLease();
  }
}

main().catch((error) => {
  process.stderr.write(`保存模型配置失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
