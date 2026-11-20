import type { AccountDiagnosisRecord } from "../../../../shared/contracts.js";

/** 将已保存的账号诊断版本渲染成带来源和缺口的公开资料报告。 */
export function renderPublicDiagnosisReport(diagnosis: AccountDiagnosisRecord, merchantName: string): string {
  if (
    diagnosis.status !== "DRAFT" ||
    !diagnosis.evidenceRefs.length ||
    diagnosis.evidenceRefs.some((ref) => !ref.visibleTextSha256) ||
    diagnosis.report.findings.some((finding) => !finding.kind)
  ) {
    throw new Error("PUBLIC_REPORT_SOURCE_INCOMPLETE");
  }
  const lines = [
    `# ${merchantName.replace(/[\r\n#]/g, " ")} · 公开资料诊断报告`,
    "",
    `- 诊断版本：v${diagnosis.version}（${diagnosis.diagnosisId}）`,
    `- 草稿生成时间：${diagnosis.createdAt}`,
    `- 人工档案版本：${diagnosis.profileRevision ?? "未关联"}`,
    `- 证据数量：${diagnosis.evidenceRefs.length}`,
    "- 报告范围：仅依据下列实际采集到的公开页面可见内容；缺少商家后台经营数据。",
    "- 结论性质：模型分析，经用户选择导出；观察与推断并非人工确认的商家事实。",
    "",
    "## 范围与结论",
    "",
    diagnosis.report.scope,
    "",
    diagnosis.report.summary,
    "",
    "## 观察与推断",
    "",
    ...diagnosis.report.findings.map(
      (finding, index) =>
        `${index + 1}. **${finding.kind === "OBSERVATION" ? "直接观察" : "基于证据的推断"}**：${finding.point}（证据：${finding.evidenceIds.join("、")}）`,
    ),
    "",
    "## 建议",
    "",
    ...(diagnosis.report.actions.length
      ? diagnosis.report.actions.map(
          (action, index) => `${index + 1}. ${action.action}（证据：${action.evidenceIds.join("、")}）`,
        )
      : ["暂无有证据支撑的建议。"]),
    "",
    "## 未知与待补资料",
    "",
    ...diagnosis.report.unknowns.map((item) => `- ${item}`),
    "- 商家后台经营数据尚未接入；无法核实曝光、转化、成交、客群和经营效果。",
    "",
    "## 证据目录",
    "",
    ...diagnosis.evidenceRefs.flatMap((ref) => [
      `### ${ref.evidenceId}`,
      "",
      `- 来源：<${ref.sourceUrl}>`,
      `- 最终地址：${ref.finalUrl ? `<${ref.finalUrl}>` : "未记录"}`,
      `- 采集时间：${ref.collectedAt}`,
      `- 访问方式：${ref.accessMode}`,
      `- 可见正文 SHA-256：${ref.visibleTextSha256}`,
      "",
    ]),
  ];
  return `${lines.join("\n")}\n`;
}
