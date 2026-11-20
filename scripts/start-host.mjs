import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { loadEnvFile } from "node:process";

/** 先读取项目根目录的可选本地配置，保留显式进程环境且不输出配置内容。 */
function loadLocalEnvironment() {
  try {
    loadEnvFile(new URL("../.env", import.meta.url));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw new Error("读取项目 .env 失败，请检查文件权限和格式。");
  }
}

/** 在 Windows 启动进程未继承用户配置时，补齐主密钥和图片服务密钥。 */
function loadWindowsUserSecrets() {
  if (process.platform !== "win32") return;
  const needsMasterKey = !process.env.ZHIBAN_MASTER_KEY?.trim();
  const needsImageKey = !process.env.ZHIBAN_SEEDREAM_API_KEY?.trim() && !process.env.ARK_API_KEY?.trim();
  if (!needsMasterKey && !needsImageKey) return;
  try {
    // 只读取固定的三项用户配置，不读取机器配置或把凭证放入命令参数。
    const command = [
      "$values = @{};",
      "foreach ($name in @('ZHIBAN_MASTER_KEY', 'ZHIBAN_SEEDREAM_API_KEY', 'ARK_API_KEY')) {",
      "$values[$name] = [Environment]::GetEnvironmentVariable($name, 'User')",
      "}; $values | ConvertTo-Json -Compress",
    ].join(" ");
    const output = execFileSync(
      join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 5000 },
    );
    const values = JSON.parse(output);
    if (!values || typeof values !== "object") return;
    for (const variable of ["ZHIBAN_MASTER_KEY", "ZHIBAN_SEEDREAM_API_KEY", "ARK_API_KEY"]) {
      // 任一进程级图片 Key 都优先于两种用户级图片 Key，避免切换供应商凭证。
      if (variable === "ZHIBAN_MASTER_KEY" ? !needsMasterKey : !needsImageKey) continue;
      const secret = values[variable];
      if (typeof secret === "string" && secret.trim()) process.env[variable] = secret.trim();
    }
  } catch {
    // 用户配置不可读或子进程超时，沿用未配置/锁定状态，不输出可能含密钥的异常。
  }
}

/** 从 macOS 钥匙串补齐启动密钥，显式环境变量优先。 */
function loadKeychainSecret(variable, service) {
  if (process.platform !== "darwin" || process.env[variable]?.trim()) return;
  const account = process.env.USER || process.env.LOGNAME;
  if (!account) return;
  try {
    const secret = execFileSync("/usr/bin/security", ["find-generic-password", "-a", account, "-s", service, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (secret) process.env[variable] = secret;
  } catch {
    // 条目缺失或不可读取时沿用 Host 的未配置/锁定状态，不泄露钥匙串错误。
  }
}

loadLocalEnvironment();
loadWindowsUserSecrets();
loadKeychainSecret("ZHIBAN_MASTER_KEY", "com.zhiban.note-agent.master-key");
if (!process.env.ARK_API_KEY?.trim()) {
  loadKeychainSecret("ZHIBAN_SEEDREAM_API_KEY", "com.zhiban.note-agent.seedream-api-key");
}

await import("../dist/host/main.js");
