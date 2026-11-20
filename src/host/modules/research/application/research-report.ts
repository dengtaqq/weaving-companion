import type { MerchantProfileFields } from "../../../../shared/contracts.js";
import type {
  ResearchCandidate,
  ResearchDocument,
  ResearchEvidenceRef,
  ResearchScope,
} from "../../../../shared/research.js";

/** 报告仅使用已经校验的候选和冻结来源，不调用模型补全缺失结论。 */
export interface ResearchReportRow {
  candidate: ResearchCandidate;
  source: string;
  expiresAt?: string | null;
}

interface ResearchDocumentInput {
  profile: MerchantProfileFields;
  profileRevision: number;
  scope?: ResearchScope;
  windowEnd?: string;
  rows: ResearchReportRow[];
  coverage: string[];
  gaps: string[];
  evidenceRefs: ResearchEvidenceRef[];
  adopted: boolean;
  source: string;
}

const goalLabels = { KEYWORDS: "关键词", TRENDS: "近期话题", COMPETITORS: "竞品差异" } as const;
const kindLabels = { KEYWORD: "关键词", TREND: "近期话题", COMPETITOR_DIFFERENCE: "竞品内容差异" } as const;

/** 把资料正文作为纯文字排版，防止来源中的换行和 Markdown 改写固定章节。 */
function plain(value: string): string {
  return (
    value
      .trim()
      .replace(/[\r\n]+/g, " / ")
      .replace(/[\\`*_{}[\]()#+.!|<>]/g, "\\$&") || "未提供"
  );
}

/** 为候选补充类型专属字段，明确日期、定性优先级与双方证据的含义。 */
function candidateDetails(candidate: ResearchCandidate): string[] {
  if (candidate.kind === "KEYWORD")
    return [
      `- 类别：${plain(candidate.details.category)}；意图：${{ AWARENESS: "认知", COMPARISON: "比较", ACTION: "行动" }[candidate.details.intent]}；定性优先级：${candidate.details.priority}（搜索量未知）。`,
    ];
  if (candidate.kind === "TREND")
    return [
      `- 样本发布时间：${plain(candidate.details.publishedAt ?? "未知")}；建议有效至：${plain(candidate.details.validUntil ?? "未另设截止，以原观察窗口限制使用")}。`,
    ];
  return [
    `- 比较维度：${plain(candidate.details.dimension)}。`,
    `- 公开观察：${plain(candidate.details.observation)}。`,
    `- 本方证据：${candidate.details.ownEvidenceIds.map(plain).join("、")}；对方证据：${candidate.details.competitorEvidenceIds.map(plain).join("、")}。`,
  ];
}

/** 按统一五段式输出研究报告或已采用简报；未研究的类别明确标记，不生成虚构选题。 */
export function renderResearchDocument(input: ResearchDocumentInput): ResearchDocument {
  const { scope, rows, adopted } = input;
  const task = scope ? `${goalLabels[scope.goal]}研究报告` : "已采用研究简报";
  const title = `${input.profile.name}｜${task}`;
  const lines = [
    `# ${plain(title)}`,
    "",
    `固定模板 v1 · ${adopted ? "本轮冻结的已采用建议，仍属研究观察与推断" : "研究候选，待用户编辑采用"}`,
    "",
    "## 1. 商家与研究范围",
    "",
    `- 商家：${plain(input.profile.name)}；档案第 ${input.profileRevision} 版。`,
    `- 行业与服务区域：${plain(input.profile.industry)}；${plain(input.profile.serviceArea)}。`,
    `- 已登记产品/服务：${plain(input.profile.products)}。`,
    `- 目标客群：${plain(input.profile.audience)}。`,
    `- 商家目标：${plain(input.profile.goals)}。`,
    `- 本次重点：${plain(scope?.focus || (scope ? "商家整体内容机会" : "使用本轮冻结的已采用研究建议"))}。`,
  ];
  if (scope && input.windowEnd)
    lines.push(
      `- 观察窗口：${new Date(Date.parse(input.windowEnd) - scope.windowDays * 86_400_000).toISOString()} 至 ${input.windowEnd}；采集时间不等于笔记发布时间。`,
    );
  lines.push(
    "",
    "## 2. 结论与覆盖",
    "",
    `${adopted ? "本页提供" : "本次保存"} ${rows.length} 项${adopted ? "已采用建议" : "待复核候选"}。优先级为定性判断，承接条件仍需核实；未取得平台搜索量或全站热度。`,
    ...input.coverage.map((value) => `- ${plain(value)}`),
    "",
    "## 3. 研究发现",
    "",
  );
  for (const kind of ["KEYWORD", "TREND", "COMPETITOR_DIFFERENCE"] as const) {
    lines.push(`### ${kindLabels[kind]}`, "");
    const items = rows.filter((row) => row.candidate.kind === kind);
    if (!items.length) {
      const selected =
        scope && { KEYWORDS: "KEYWORD", TRENDS: "TREND", COMPETITORS: "COMPETITOR_DIFFERENCE" }[scope.goal] === kind;
      lines.push(
        adopted
          ? "本轮没有此类已采用建议。"
          : selected
            ? "本轮没有可保存的有效候选，详见待补充事项。"
            : "本次未开展此项研究。",
        "",
      );
    }
    for (const row of items) {
      const candidate = row.candidate;
      lines.push(
        `#### ${plain(candidate.title)}`,
        "",
        `- 商家关联：${plain(candidate.merchantRelevance)}。`,
        `- 适用客群：${plain(candidate.audience)}。`,
        ...candidateDetails(candidate),
        `- 证据：${candidate.evidenceIds.map(plain).join("、")}。`,
        `- 来源：${plain(row.source)}。`,
        ...(row.expiresAt ? [`- 来源有效至：${plain(row.expiresAt)}。`] : []),
        "",
      );
    }
  }
  lines.push("## 4. 后续内容方向与使用前提", "");
  if (!rows.length) lines.push("暂无有证据的可复用方向，请先补齐本轮缺口。", "");
  for (const row of rows)
    lines.push(
      `### ${plain(row.candidate.title)}`,
      "",
      `- 内容角度：${plain(row.candidate.contentAngle)}。`,
      ...(row.candidate.cautions.length
        ? row.candidate.cautions.map((value) => `- 使用前提与限制：${plain(value)}`)
        : ["- 使用前提与限制：未另列，仍需核对商家真实能力；不代表无需审核。"]),
      "",
    );
  lines.push("## 5. 证据与待补充事项", "", "### 证据来源", "");
  const refs = [...new Map(input.evidenceRefs.map((ref) => [ref.evidenceId, ref])).values()];
  if (!refs.length) lines.push("没有支撑候选的有效公开证据。", "");
  for (const ref of refs)
    lines.push(
      `- ${plain(ref.evidenceId)}：<${ref.sourceUrl.replace(/[<>\r\n]/g, "")}>；采集于 ${plain(ref.collectedAt)}。`,
    );
  lines.push("", "### 待补充事项", "");
  lines.push(
    ...(input.gaps.length
      ? [...new Set(input.gaps)].map((value) => `- ${plain(value)}`)
      : ["本轮未另外列出缺口；不表示全站样本或商家信息已经完整。"]),
  );
  lines.push(
    "",
    `来源标识：${plain(input.source)}。`,
    adopted
      ? "后续创作须保留来源和使用前提；建议采用不等于商家事实已确认。"
      : "本报告是候选研究结果。编辑采用后，后续会话才会自动读取相应建议；下载报告不会自动采用、排期或发布。",
    "",
  );
  return { templateVersion: 1, title, markdown: lines.join("\n") };
}
