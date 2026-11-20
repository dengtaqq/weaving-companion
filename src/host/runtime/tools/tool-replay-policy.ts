/** 稳定本地读取可重放；未知工具默认阻止自动重试。 */
const REPLAYABLE_READ_TOOLS = new Set([
  "session_context",
  "list_uploaded_files",
  "read_uploaded_text",
  "read_skill",
  "evidence_get",
  "account_diagnosis_get",
  "merchant_profile_get",
  "merchant_catalog_get",
  "merchant_links_list",
  "read_expert_method",
  "merchant_memory_search",
  "merchant_memory_get",
  "merchant_research_get",
]);
const IDEMPOTENT_TASK_TOOLS = new Set([
  "delegate_task",
  "delegation_submit",
  "publication_task",
  "research_memory_update",
]);

/** 统一判断自动重放边界；重启可复用稳定任务键，overflow 回滚则仍需阻止再次提交。 */
export function blocksToolReplay(toolName: string, reason: "overflow" | "startup"): boolean {
  if (REPLAYABLE_READ_TOOLS.has(toolName)) return false;
  if (reason === "startup" && IDEMPOTENT_TASK_TOOLS.has(toolName)) return false;
  return true;
}
