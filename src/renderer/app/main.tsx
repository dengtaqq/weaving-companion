import { type FormEvent, type ReactNode, StrictMode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  type ArtifactRecord,
  type ContextCheckpointRecord,
  type ContextTokenMeasurement,
  DEFAULT_PAIRING_CODE,
  type DelegationAttemptRecord,
  type DelegationRecord,
  type ExpertSelectionId,
  type MerchantRecord,
  type MessageRecord,
  type MessageSearchHit,
  type ModelAvailability,
  type RuntimeEvent,
  type SessionRecord,
  type SessionSnapshot,
  type SystemPromptSetting,
  type XhsLoginState,
} from "../../shared/contracts.js";
import type { ToolExecutionSummary } from "../../shared/tool-execution.js";
import * as api from "../api/client.js";
import { AssistantMarkdown } from "../components/assistant-markdown.js";
import { Icon } from "../components/ui.js";
import { ContextCompressionLog, ContextTokenPanel } from "../features/chat/context-token-panel.js";
import { PromptSnapshotPanel } from "../features/chat/prompt-snapshot-panel.js";
import { sessionDraftKey } from "../features/chat/session-draft.js";
import { SessionSidebar } from "../features/chat/session-sidebar.js";
import { DashboardPage } from "../features/dashboard/dashboard-page.js";
import { MerchantPage } from "../features/merchants/merchant-page.js";
import { ProductsPage } from "../features/merchants/products-page.js";
import { ChatPublicationResults } from "../features/publication/chat-publication-results.js";
import { ContentDraftPanel } from "../features/publication/content-draft-panel.js";
import { ContentStudio } from "../features/publication/content-studio.js";
import { ImageGenerationPanel } from "../features/publication/image-generation-panel.js";
import { ResearchPanel } from "../features/research/research-panel.js";
import { CapabilitiesPage } from "../features/settings/capabilities-page.js";
import { ModelPicker } from "../features/settings/model-picker.js";
import "./styles.css";
import "./workbench.css";

/** 把 Run 状态码转换为页面状态文案。 */
function runStatusLabel(status: string | null): string {
  if (status === "QUEUED") return "排队中";
  if (status === "RUNNING") return "运行中";
  if (status === "WAITING_INPUT") return "等待回答";
  if (status === "RECOVERING") return "恢复中";
  if (status === "WAITING_CONFIRMATION") return "等待确认";
  if (status === "SUCCEEDED") return "已完成";
  if (status === "FAILED") return "失败";
  if (status === "CANCELLED") return "已取消";
  return "";
}

/** 从用户文本提取第一个允许授权的小红书 HTTPS 链接。 */
function xhsUrlInText(content: string): string | null {
  for (const match of content.match(/https:\/\/[^\s<>"'`，。；、（）)\]]+/g) ?? []) {
    try {
      const url = new URL(match.replace(/[.,!?;:]+$/, ""));
      const host = url.hostname.toLowerCase();
      if (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        ["xiaohongshu.com", "xhslink.com", "xhslink.cn"].some(
          (domain) => host === domain || host.endsWith(`.${domain}`),
        )
      )
        return url.toString();
    } catch {
      // 其他文字和链接不属于小红书授权入口。
    }
  }
  return null;
}

/** 生成当前会话登录续采提示词的临时存储键。 */
function xhsLoginPromptKey(sessionId: string): string {
  return `zhiban:xhs-login-prompt:${sessionId}`;
}

/** 按字符渐进显示流式正文，避免截断多字节字符。 */
function revealText(current: string, target: string): string {
  const characters = Array.from(target);
  const visibleCount = Array.from(current).length;
  if (visibleCount >= characters.length) return target;
  const remaining = characters.length - visibleCount;
  return characters.slice(0, visibleCount + Math.max(1, Math.ceil(remaining / 30))).join("");
}

/** 将事件时间格式化为本地短时间。 */
function activityTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** 根据状态文案选择页面提示样式。 */
function statusClass(status: string): string {
  if (["运行中", "实时连接", "已完成"].includes(status)) return "status-pill success";
  if (["失败", "已取消", "连接中断"].includes(status)) return "status-pill danger";
  return "status-pill pending";
}

/** 展示配对前的工作台定位和当前可用流程。 */
function WelcomeIntro() {
  return (
    <div className="welcome-intro">
      <div className="welcome-brand">
        <span className="brand-mark">织</span>织伴 Agent
      </div>
      <div className="welcome-story">
        <span className="eyebrow">商家内容工作台</span>
        <h1>
          商家资料清楚，
          <br />
          内容创作才有依据。
        </h1>
        <p>先说目标，按需补充商家资料；统筹会根据任务委派写作、视觉或审核专家。</p>
        <div className="welcome-steps">
          <div className="welcome-step">
            <span>01</span>
            <div>
              <strong>按需补充资料</strong>
              <small>商家档案和平台链接可在需要时关联</small>
            </div>
          </div>
          <div className="welcome-step">
            <span>02</span>
            <div>
              <strong>整理诊断线索</strong>
              <small>记录公开证据与账号诊断草稿</small>
            </div>
          </div>
          <div className="welcome-step">
            <span>03</span>
            <div>
              <strong>协作撰写内容</strong>
              <small>由统筹按需委派写作、视觉或审核专家</small>
            </div>
          </div>
        </div>
      </div>
      <span className="welcome-foot">商家资料、会话与草稿保存在本机</span>
    </div>
  );
}

/** 让历史回复和运行过程共用左侧机器人头像、名称与内容列。 */
function AssistantMessage({ children, status }: { children: ReactNode; status?: string }) {
  return (
    <div className="assistant-message">
      <span className="assistant-avatar" aria-hidden="true">
        <Icon name="robot" size={22} />
      </span>
      <div className="assistant-message-body">
        <div className="speaker assistant-speaker">
          织伴
          {status && <span className="assistant-status">{status}</span>}
        </div>
        {children}
      </div>
    </div>
  );
}

/** 将一次工具启动与完成事件合并显示。 */
function ToolActivity({ started, events }: { started: RuntimeEvent; events: RuntimeEvent[] }) {
  /** 按本次启动匹配事件，避免重试 Attempt 或其他专家的相同工具 ID 串线。 */
  const matchesCall = (event: RuntimeEvent) =>
    event.runId === started.runId &&
    event.seq > started.seq &&
    event.payload.toolCallId === started.payload.toolCallId &&
    event.payload.delegationId === started.payload.delegationId;
  const nextStartSeq =
    events.find((event) => event.type === "session.tool.started" && matchesCall(event))?.seq ?? Infinity;
  const completed = events.find(
    (event) => event.type === "session.tool.completed" && matchesCall(event) && event.seq < nextStartSeq,
  );
  const stopping = events.some(
    (event) => event.type === "session.tool.timeout" && matchesCall(event) && event.seq < nextStartSeq,
  );
  const execution = completed?.payload.execution as ToolExecutionSummary | undefined;
  const skillName = started.payload.skillName;
  const skillPath = started.payload.skillPath;
  const isSkill = typeof skillName === "string";
  return (
    <div className="tool-activity">
      <span title={isSkill ? String(started.payload.skillSha256 ?? "") : undefined}>
        {isSkill
          ? `Skill · ${skillName}${skillPath !== "SKILL.md" ? ` / ${String(skillPath)}` : ""}`
          : `工具 · ${String(started.payload.toolName ?? "未知")}`}
      </span>
      <strong title={execution?.errorCode}>
        {execution?.resultUnknown
          ? "结果待核对"
          : execution?.outcome === "TIMED_OUT"
            ? "执行超时"
            : execution?.outcome === "CANCELLED"
              ? "已停止"
              : execution?.outcome === "BLOCKED"
                ? "访问受限"
                : execution?.outcome === "LIMITED"
                  ? "部分可用"
                  : !completed && stopping
                    ? "超时，正在停止"
                    : completed
                      ? completed.payload.isError
                        ? isSkill
                          ? "加载失败"
                          : "执行失败"
                        : isSkill
                          ? "已加载"
                          : "已完成"
                      : isSkill
                        ? "读取中"
                        : "执行中"}
      </strong>
      {execution && <span>{(execution.elapsedMs / 1000).toFixed(1)} 秒</span>}
    </div>
  );
}

/** 展示专家委派步骤，并按需加载任务快照和结果。 */
function DelegationActivity({
  started,
  finished,
  events,
}: {
  started: RuntimeEvent;
  finished?: RuntimeEvent;
  events: RuntimeEvent[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [record, setRecord] = useState<DelegationRecord | null>(null);
  const [attempts, setAttempts] = useState<DelegationAttemptRecord[]>([]);
  const [loadError, setLoadError] = useState("");
  const [answerDraft, setAnswerDraft] = useState("");
  const [steerDraft, setSteerDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const questionEvent = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "session.delegation.question" && event.payload.delegationId === started.payload.delegationId,
    );
  const answerEvent = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "session.delegation.answered" && event.payload.delegationId === started.payload.delegationId,
    );
  const refreshEventId =
    (answerEvent?.seq ?? 0) > (questionEvent?.seq ?? 0) ? answerEvent?.eventId : questionEvent?.eventId;

  useEffect(() => {
    if (!expanded || !started.runId) return;
    setLoadError("");
    if (finished?.eventId || refreshEventId) setRecord(null);
    let active = true;
    Promise.all([
      api.getDelegation(started.runId, String(started.payload.delegationId ?? "")),
      api.listDelegationAttempts(String(started.payload.delegationId ?? "")),
    ]).then(
      ([value, history]) => {
        if (active) {
          setRecord(value);
          setAttempts(history);
        }
      },
      (error) => {
        if (active) setLoadError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      active = false;
    };
  }, [expanded, started.runId, started.payload.delegationId, finished?.eventId, refreshEventId]);

  const input = record?.input;
  const result = record?.result;
  const childToolEvents = events.filter((event) => event.payload.delegationId === started.payload.delegationId);
  return (
    <details className="delegation-card" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>
        <span>
          委派 ·{" "}
          {{ writer: "写作", visual: "视觉", reviewer: "审核", researcher: "研究" }[
            String(started.payload.targetExpertId)
          ] ?? "专家"}
          专家
        </span>
        <strong>
          {finished
            ? runStatusLabel(String(finished.payload.status ?? "")) || "已结束"
            : record?.questionText && !record.answerText
              ? "等待回答"
              : questionEvent && (answerEvent?.seq ?? 0) < questionEvent.seq
                ? "等待回答"
                : "执行中"}
        </strong>
      </summary>
      {loadError && <p>{loadError}</p>}
      {expanded && !record && !loadError && <p>读取委派详情中…</p>}
      {record && input && (
        <div className="delegation-detail">
          <p>
            <strong>任务：</strong>
            {input.task}
          </p>
          <p>
            任务键：{record.taskKey}；尝试次数：{record.attempt}；父工具交付：{record.parentAckAt ? "已确认" : "待确认"}
          </p>
          {attempts.length > 0 && (
            <details>
              <summary>查看专家尝试历史</summary>
              {attempts.map((attempt) => (
                <p key={attempt.attempt}>
                  第 {attempt.attempt} 次：{attempt.status} · {attempt.startedAt}
                  {attempt.errorCode ? ` · ${attempt.errorCode}` : ""}
                </p>
              ))}
            </details>
          )}
          {record.researchMemory && (
            <details>
              <summary>查看研究笔记</summary>
              <p>以下是本次研究的假设和进展，尚不代表商家已确认事实。</p>
              {(["hypotheses", "triedApproaches", "openQuestions"] as const).map((kind) => (
                <div key={kind}>
                  <strong>
                    {{ hypotheses: "研究假设", triedApproaches: "已尝试路径", openQuestions: "未解决问题" }[kind]}
                  </strong>
                  <ul>
                    {record.researchMemory?.memory[kind].map((item) => (
                      <li key={item.id}>{item.note}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </details>
          )}
          {record.questionText && (
            <div>
              <p>
                <strong>专家提问：</strong>
                {record.questionText}
              </p>
              {record.answerText ? (
                <p>
                  <strong>用户回答：</strong>
                  {record.answerText}
                </p>
              ) : (
                <form
                  onSubmit={async (event) => {
                    event.preventDefault();
                    if (!answerDraft.trim()) return;
                    setSubmitting(true);
                    try {
                      setRecord(await api.answerDelegation(record.delegationId, answerDraft.trim()));
                      setAnswerDraft("");
                      setLoadError("");
                    } catch (error) {
                      setLoadError(error instanceof Error ? error.message : String(error));
                    } finally {
                      setSubmitting(false);
                    }
                  }}
                >
                  <textarea
                    aria-label="回答专家问题"
                    value={answerDraft}
                    onChange={(event) => setAnswerDraft(event.target.value)}
                    maxLength={4000}
                  />
                  <button type="submit" disabled={submitting || !answerDraft.trim()}>
                    提交回答
                  </button>
                </form>
              )}
            </div>
          )}
          {["QUEUED", "RUNNING", "WAITING_INPUT"].includes(record.status) && (
            <div>
              <form
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (!steerDraft.trim()) return;
                  setSubmitting(true);
                  try {
                    await api.steerDelegation(record.delegationId, steerDraft.trim());
                    setSteerDraft("");
                    setLoadError("");
                  } catch (error) {
                    setLoadError(error instanceof Error ? error.message : String(error));
                  } finally {
                    setSubmitting(false);
                  }
                }}
              >
                <input
                  aria-label="调整专家任务"
                  value={steerDraft}
                  onChange={(event) => setSteerDraft(event.target.value)}
                  maxLength={2000}
                />
                <button type="submit" disabled={submitting || !steerDraft.trim()}>
                  调整
                </button>
              </form>
              <button
                type="button"
                disabled={submitting}
                onClick={async () => {
                  setSubmitting(true);
                  try {
                    setRecord(await api.cancelDelegation(record.delegationId));
                    setLoadError("");
                  } catch (error) {
                    setLoadError(error instanceof Error ? error.message : String(error));
                  } finally {
                    setSubmitting(false);
                  }
                }}
              >
                终止本轮及专家任务
              </button>
            </div>
          )}
          {"version" in input && (input.version === 2 || input.version === 3) ? (
            <>
              <p>
                <strong>验收条件：</strong>
                {input.criteria.map((item) => `${item.id} ${item.text}`).join("；")}
              </p>
              <p>
                <strong>指定资料：</strong>
                {input.inputRefs.map((ref) => `${"kind" in ref ? ref.kind : ref.type}:${ref.id}`).join("、") || "无"}
              </p>
              {input.contextSummary && (
                <p>
                  <strong>主 Agent 摘要（未经核实）：</strong>
                  {input.contextSummary}
                </p>
              )}
              {input.missingInformation?.length ? (
                <p>
                  <strong>待补信息（主 Agent 声明）：</strong>
                  {input.missingInformation.join("；")}
                </p>
              ) : null}
            </>
          ) : (
            "successCriteria" in input && (
              <p>
                <strong>验收条件：</strong>
                {input.successCriteria}
              </p>
            )
          )}
          {record.inputSnapshot && (
            <details>
              <summary>查看冻结输入</summary>
              {"version" in input && input.version === 3 && (
                <p>
                  专业契约：{input.contractId} · v{input.contractVersion}
                </p>
              )}
              <p>
                父 Plan：{record.inputSnapshot.parentPlanHash}；子 Plan：{record.inputSnapshot.childPlanHash}
              </p>
              <p>商家快照：{record.inputSnapshot.merchantSnapshot?.id ?? "未关联；仅使用本会话提供的资料"}</p>
              {record.inputSnapshot.contextPacket && (
                <div>
                  <p>
                    来源消息：{record.inputSnapshot.contextPacket.parentMessage.id} · SHA-256{" "}
                    {record.inputSnapshot.contextPacket.parentMessage.sha256.slice(0, 12)}…
                  </p>
                  <p>
                    Host 核准可读资源：
                    {record.inputSnapshot.contextPacket.readableResources
                      .map((resource) => `${resource.type}:${resource.id} (${resource.sha256.slice(0, 12)}…)`)
                      .join("；") || "无"}
                  </p>
                  {record.inputSnapshot.contextPacket.recentMessages?.length ? (
                    <p>
                      近期消息来源：
                      {record.inputSnapshot.contextPacket.recentMessages
                        .map((message) => `${message.role}:${message.id} (${message.sha256.slice(0, 12)}…)`)
                        .join("；")}
                    </p>
                  ) : null}
                </div>
              )}
              <pre>{record.inputSnapshot.childPrompt}</pre>
              <details>
                <summary>查看父轮请求原文</summary>
                <pre>{record.inputSnapshot.parentPrompt}</pre>
              </details>
            </details>
          )}
          {childToolEvents.some((event) => event.type === "session.tool.started") && (
            <div className="delegation-tools">
              <strong>子 Agent 执行步骤：</strong>
              {childToolEvents
                .filter((event) => event.type === "session.tool.started")
                .map((event) => (
                  <ToolActivity key={event.eventId} started={event} events={childToolEvents} />
                ))}
            </div>
          )}
          {result &&
            ("version" in result && (result.version === 2 || result.version === 3) ? (
              <>
                <p>
                  <strong>完成情况：</strong>
                  {result.completion === "complete" ? "全部完成" : "部分完成"}
                </p>
                <p>
                  <strong>未满足条件：</strong>
                  {result.unmetCriterionIds.join("、") || "无"}
                </p>
                {result.output.title && (
                  <p>
                    <strong>标题：</strong>
                    {result.output.title}
                  </p>
                )}
                <pre>{result.output.content}</pre>
              </>
            ) : (
              "finalText" in result && <pre>{result.finalText}</pre>
            ))}
          {record.errorCode && (
            <p>
              <strong>错误：</strong>
              {record.errorCode}
            </p>
          )}
        </div>
      )}
    </details>
  );
}

/** 重启后父轮尚未再次调用委派工具时，仍让用户回答数据库里保留的问题。 */
function PendingDelegationQuestion({
  record,
  onAnswered,
}: {
  record: DelegationRecord;
  onAnswered: (record: DelegationRecord) => void;
}) {
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  return (
    <form
      className="delegation-card"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!answer.trim()) return;
        setSubmitting(true);
        try {
          onAnswered(await api.answerDelegation(record.delegationId, answer.trim()));
          setAnswer("");
          setError("");
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
          setSubmitting(false);
        }
      }}
    >
      <strong>专家等待回答：{record.questionText}</strong>
      <textarea
        aria-label="回答待恢复的专家问题"
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
        maxLength={4000}
      />
      <button type="submit" disabled={submitting || !answer.trim()}>
        提交回答
      </button>
      <button
        type="button"
        disabled={submitting}
        onClick={async () => {
          setSubmitting(true);
          try {
            onAnswered(await api.cancelDelegation(record.delegationId));
            setError("");
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
          } finally {
            setSubmitting(false);
          }
        }}
      >
        终止本轮及专家任务
      </button>
      {error && <p>{error}</p>}
    </form>
  );
}

/** 本地会话工作台：配对、会话列表、消息历史和实时回复。 */
function Workbench() {
  const navigate = useNavigate();
  const location = useLocation();
  const { sessionId, merchantId } = useParams();
  const [paired, setPaired] = useState<boolean | null>(null);
  const [hostOnline, setHostOnline] = useState<boolean | null>(null);
  const [pairingCode, setPairingCode] = useState(DEFAULT_PAIRING_CODE);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [merchants, setMerchants] = useState<MerchantRecord[]>([]);
  const [selectedMerchantId, setSelectedMerchantId] = useState("");
  const [bindingMerchant, setBindingMerchant] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [memoryNotice, setMemoryNotice] = useState("");
  const [currentMerchantName, setCurrentMerchantName] = useState("");
  const [model, setModel] = useState<ModelAvailability | null>(null);
  const [providers, setProviders] = useState<Record<string, string>>({});
  const [systemPrompt, setSystemPrompt] = useState<SystemPromptSetting | null>(null);
  const [promptDraft, setPromptDraft] = useState("");
  const [promptSaving, setPromptSaving] = useState(false);
  const [promptNotice, setPromptNotice] = useState("");
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [xhsLogin, setXhsLogin] = useState<XhsLoginState | null>(null);
  const [xhsLoginBusy, setXhsLoginBusy] = useState(false);
  const [xhsResumePending, setXhsResumePending] = useState(false);
  const xhsLoginPrompt = useRef<{ content: string; fromDraft: boolean } | null>(null);
  const resumeAfterRun = useRef(false);
  const confirmXhsLoginLatest = useRef<(() => Promise<void>) | null>(null);
  const [stream, setStream] = useState("");
  const [thinkingStream, setThinkingStream] = useState("");
  const [toolEvents, setToolEvents] = useState<RuntimeEvent[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [contextSummary, setContextSummary] = useState<Record<string, unknown> | null>(null);
  const [contextTokens, setContextTokens] = useState<ContextTokenMeasurement | null>(null);
  const latestContextTokens = useRef<ContextTokenMeasurement | null>(null);
  const committedContextTokens = useRef<ContextTokenMeasurement | null>(null);
  const [checkpoints, setCheckpoints] = useState<ContextCheckpointRecord[]>([]);
  const [pendingQuestions, setPendingQuestions] = useState<DelegationRecord[]>([]);
  const [delegationRecords, setDelegationRecords] = useState<DelegationRecord[]>([]);
  const [attachmentReadCount, setAttachmentReadCount] = useState(0);
  const [selectedArtifactIds, setSelectedArtifactIds] = useState<string[]>([]);
  const [runStatus, setRunStatus] = useState("");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [continueFromRunId, setContinueFromRunId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<MessageSearchHit[]>([]);
  const [sessionPageItems, setSessionPageItems] = useState<SessionRecord[]>([]);
  const [sessionPageCursor, setSessionPageCursor] = useState<string | null>(null);
  const [sessionPageStatus, setSessionPageStatus] = useState<"ACTIVE" | "TRASHED">("ACTIVE");
  const [sessionPageLoading, setSessionPageLoading] = useState(false);
  const currentSession = sessions.find((item) => item.sessionId === sessionId);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [sessionListOpen, setSessionListOpen] = useState(() => window.innerWidth >= 1100);
  const [theme, setTheme] = useState(() => localStorage.getItem("zhiban:theme") ?? "green");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("zhiban:theme", theme);
  }, [theme]);
  const [sessionTool, setSessionTool] = useState<"research" | "content" | "image" | "overview">("overview");
  const composerInput = useRef<HTMLTextAreaElement | null>(null);
  const cursor = useRef(0);
  const terminalRunIds = useRef(new Set<string>());
  const timeline = useRef<HTMLElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const visibleSessionId = useRef(sessionId);
  const historyExhausted = useRef(false);
  const locatedMessage = useRef("");
  const consumedComposeLocation = useRef("");
  const lastMarkedRead = useRef("");
  const stickToBottom = useRef(true);
  // 失败重试时复用同一个 clientTurnId，避免重复创建用户消息。
  const pendingTurn = useRef<{
    sessionId: string;
    content: string;
    expertRole: ExpertSelectionId | null;
    artifactIds: string[];
    continueFromRunId: string | null;
    clientTurnId: string;
  } | null>(null);

  useEffect(() => {
    const wideLayout = window.matchMedia("(min-width: 1180px)");
    /** 窄屏时收起信息栏，宽屏仍由用户明确打开以保留聊天宽度。 */
    const matchLayout = (event: MediaQueryListEvent) => {
      if (!event.matches) {
        setInspectorOpen(false);
        setSessionListOpen(false);
      }
    };
    wideLayout.addEventListener("change", matchLayout);
    return () => wideLayout.removeEventListener("change", matchLayout);
  }, []);

  useLayoutEffect(() => {
    visibleSessionId.current = sessionId;
    setMemoryNotice("");
  }, [sessionId]);

  // 仅在用户停留在底部时跟随流式回复，手动向上阅读不被打断。
  useLayoutEffect(() => {
    if (stickToBottom.current && timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight;
  });

  useEffect(() => {
    void api
      .pairingStatus()
      .then(setPaired)
      .catch((reason: unknown) => setError(String(reason)));
  }, []);

  useEffect(() => {
    const compose = (location.state as { compose?: unknown } | null)?.compose;
    if (!sessionId || consumedComposeLocation.current === location.key) return;
    consumedComposeLocation.current = location.key;
    const stored = sessionStorage.getItem(sessionDraftKey(sessionId));
    setDraft(stored !== null ? stored : typeof compose === "string" ? compose : "");
  }, [sessionId, location.key, location.state]);

  useEffect(() => {
    if (!paired) return;
    void Promise.all([api.bootstrap(), api.listSessions()])
      .then(([bootstrap, list]) => {
        setModel(bootstrap.model);
        setProviders(bootstrap.providers);
        setSessions(list);
      })
      .catch((reason: unknown) => setError(String(reason)));
  }, [paired]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (!paired || !query) {
      setSearchHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void api.searchMessages(query).then(
        (items) => {
          if (!cancelled) setSearchHits(items);
        },
        () => {
          if (!cancelled) setSearchHits([]);
        },
      );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [paired, searchQuery]);

  useEffect(() => {
    if (!paired || location.pathname !== "/sessions") return;
    let cancelled = false;
    setSessionPageItems([]);
    setSessionPageCursor(null);
    setSessionPageLoading(true);
    void api
      .listSessionPage(sessionPageStatus)
      .then(
        (result) => {
          if (cancelled) return;
          setSessionPageItems(result.items);
          setSessionPageCursor(result.nextCursor);
        },
        (reason: unknown) => {
          if (!cancelled) setError(String(reason));
        },
      )
      .finally(() => {
        if (!cancelled) setSessionPageLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [paired, location.pathname, sessionPageStatus]);

  useEffect(() => {
    if (!paired || location.pathname !== "/settings") return;
    let cancelled = false;
    void api
      .getSystemPrompt()
      .then((setting) => {
        if (cancelled) return;
        setSystemPrompt(setting);
        setPromptDraft(setting.content);
        setPromptNotice("");
      })
      .catch((reason: unknown) => {
        if (!cancelled) setPromptNotice(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [paired, location.pathname]);

  useEffect(() => {
    if (!paired || !sessionId || currentSession?.scope !== "MERCHANT") {
      setCurrentMerchantName("");
      return;
    }
    let cancelled = false;
    void api
      .getMerchant(currentSession.ownerId)
      .then((item) => {
        if (!cancelled) setCurrentMerchantName(item.merchant.name);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [paired, sessionId, currentSession?.scope, currentSession?.ownerId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 路由切换后重新读取人工维护的商家列表和名称。
  useEffect(() => {
    if (!paired) return;
    let cancelled = false;
    void api
      .listMerchants()
      .then((items) => {
        if (!cancelled) setMerchants(items);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [paired, location.pathname]);

  /** 按版本保存设置页中的全局系统提示词。 */
  async function saveSystemPrompt(content: string) {
    if (!systemPrompt || promptSaving) return;
    setPromptSaving(true);
    setPromptNotice("");
    try {
      const setting = await api.updateSystemPrompt(content, systemPrompt.revision);
      setSystemPrompt(setting);
      setPromptDraft(setting.content);
      setPromptNotice(`已保存第 ${setting.revision} 版；只影响之后受理的任务。`);
    } catch (reason) {
      setPromptNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPromptSaving(false);
    }
  }

  useEffect(() => {
    if (!paired) return;
    let cancelled = false;
    /** 轮询 Host 健康状态并更新断线提示。 */
    const refreshHealth = async () => {
      const online = await api.hostHealth();
      if (!cancelled) setHostOnline(online);
    };
    void refreshHealth();
    const timer = setInterval(() => void refreshHealth(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [paired]);

  useEffect(() => {
    if (!paired || !sessionId) return;
    let cancelled = false;
    setXhsLogin(null);
    setXhsResumePending(false);
    resumeAfterRun.current = false;
    xhsLoginPrompt.current = null;
    void api
      .getXhsLogin(sessionId)
      .then((status) => {
        if (cancelled) return;
        setXhsLogin(status);
        if (status.status === "AWAITING_LOGIN" || status.status === "READY") {
          try {
            const stored = sessionStorage.getItem(xhsLoginPromptKey(sessionId));
            if (stored) {
              const original = JSON.parse(stored) as { content?: unknown; fromDraft?: unknown };
              if (typeof original.content === "string" && typeof original.fromDraft === "boolean") {
                xhsLoginPrompt.current = { content: original.content, fromDraft: original.fromDraft };
                setXhsResumePending(status.status === "READY");
              }
            }
          } catch {
            xhsLoginPrompt.current = null;
          }
        } else {
          sessionStorage.removeItem(xhsLoginPromptKey(sessionId));
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [paired, sessionId]);

  useEffect(() => {
    if (!paired || !sessionId) return;
    let cancelled = false;
    setArtifacts([]);
    setSelectedArtifactIds([]);
    void api
      .listArtifacts(sessionId)
      .then((items) => {
        if (!cancelled) {
          setArtifacts(items);
          setSelectedArtifactIds(
            items
              .filter((item) => item.status === "READY")
              .slice(0, 50)
              .map((item) => item.artifactId),
          );
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [paired, sessionId]);

  useEffect(() => {
    if (!paired || !sessionId) {
      setCheckpoints([]);
      return;
    }
    if (runStatus === "运行中" || runStatus === "排队中") return;
    let cancelled = false;
    void api.listContextCheckpoints(sessionId).then(
      (items) => {
        if (!cancelled) setCheckpoints(items);
      },
      () => {
        if (!cancelled) setCheckpoints([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [paired, sessionId, runStatus]);

  const latestDelegationStateEventId = [...toolEvents]
    .reverse()
    .find((event) =>
      ["session.delegation.question", "session.delegation.answered", "session.delegation.finished"].includes(
        event.type,
      ),
    )?.eventId;
  useEffect(() => {
    if (!paired || !activeRunId) {
      setPendingQuestions([]);
      setDelegationRecords([]);
      return;
    }
    if (latestDelegationStateEventId) setPendingQuestions([]);
    let cancelled = false;
    void api.listDelegationsForRun(activeRunId).then(
      (items) => {
        if (!cancelled) {
          setDelegationRecords(items);
          setPendingQuestions(
            items.filter(
              (item) => item.questionText && !item.answerText && ["QUEUED", "WAITING_INPUT"].includes(item.status),
            ),
          );
        }
      },
      () => {
        if (!cancelled) {
          setPendingQuestions([]);
          setDelegationRecords([]);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [paired, activeRunId, latestDelegationStateEventId]);

  useEffect(() => {
    if (!paired || !sessionId) return;
    // 切换会话后先恢复数据库快照，再用 lastSeq 接续事件流。
    let cancelled = false;
    let socket: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 1500;
    let reconnecting = false;
    let refreshing = false;
    let targetText = "";
    let targetThinking = "";
    let visibleText = "";
    let visibleThinking = "";
    let completedMessage: MessageRecord | null = null;
    cursor.current = 0;
    terminalRunIds.current.clear();
    stickToBottom.current = true;
    historyExhausted.current = false;
    locatedMessage.current = "";
    lastMarkedRead.current = "";
    setMessages([]);
    setHistoryHasMore(false);
    setHighlightMessageId(null);
    setStream("");
    setThinkingStream("");
    setToolEvents([]);
    setContextSummary(null);
    setContextTokens(null);
    latestContextTokens.current = null;
    committedContextTokens.current = null;
    setAttachmentReadCount(0);
    setRunStatus("");
    setActiveRunId(null);
    setContinueFromRunId(null);
    setConnected(false);

    /** 将流式临时内容收口为数据库中的最终助手消息。 */
    const finishDisplayedMessage = () => {
      if (!completedMessage) return;
      const message = completedMessage;
      setMessages((current) =>
        current.some((item) => item.messageId === message.messageId) ? current : [...current, message],
      );
      completedMessage = null;
      targetText = "";
      targetThinking = "";
      visibleText = "";
      visibleThinking = "";
      setStream("");
      setThinkingStream("");
    };

    // 页面按固定节奏显示已收到的内容；完成事件要等文字显示完再替换为历史消息。
    const animation = setInterval(() => {
      if (cancelled) return;
      if (visibleThinking !== targetThinking) {
        visibleThinking = revealText(visibleThinking, targetThinking);
        setThinkingStream(visibleThinking);
      } else if (visibleText !== targetText) {
        visibleText = revealText(visibleText, targetText);
        setStream(visibleText);
      } else {
        finishDisplayedMessage();
      }
    }, 35);

    /** 以持久化快照重建当前会话、Run 和事件展示。 */
    const applySnapshot = (snapshot: SessionSnapshot) => {
      setSessions((current) =>
        current.some((item) => item.sessionId === snapshot.session.sessionId)
          ? current.map((item) => (item.sessionId === snapshot.session.sessionId ? snapshot.session : item))
          : [snapshot.session, ...current],
      );
      cursor.current = snapshot.session.lastSeq;
      completedMessage = null;
      targetText = snapshot.streamText;
      targetThinking = snapshot.thinkingText ?? "";
      visibleText = targetText;
      visibleThinking = targetThinking;
      setMessages((current) => {
        const known = new Set(snapshot.messages.map((item) => item.messageId));
        const older = current[0]?.sessionId === sessionId ? current.filter((item) => !known.has(item.messageId)) : [];
        return [...older, ...snapshot.messages];
      });
      setHistoryHasMore(!historyExhausted.current && snapshot.messages.length >= 50);
      setStream(visibleText);
      setThinkingStream(visibleThinking);
      setToolEvents(snapshot.toolEvents ?? []);
      setContextSummary(snapshot.contextSummary);
      committedContextTokens.current = snapshot.committedContextTokens ?? null;
      latestContextTokens.current = snapshot.contextTokens ?? null;
      setContextTokens(latestContextTokens.current);
      setAttachmentReadCount(snapshot.attachmentReadCount);
      setRunStatus(
        snapshot.activeRun?.cancelRequestedAt
          ? "取消中"
          : runStatusLabel(snapshot.activeRun?.status ?? snapshot.latestRun?.status ?? null),
      );
      setActiveRunId(snapshot.activeRun?.runId ?? null);
      setContinueFromRunId(
        !snapshot.activeRun && snapshot.latestRun?.status === "CANCELLED" ? snapshot.latestRun.runId : null,
      );
      setError(snapshot.latestRun?.status === "FAILED" ? (snapshot.latestRun.errorMessage ?? "模型执行失败") : "");
    };

    /** 拉取最新快照并恢复断线后的页面状态。 */
    const refreshSnapshot = async () => {
      // 事件断档或服务端要求重建时，以快照为准重新建立游标。
      if (refreshing || cancelled) return;
      refreshing = true;
      try {
        const snapshot = await api.getSessionSnapshot(sessionId);
        if (cancelled) return;
        applySnapshot(snapshot);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        socket?.close();
        socket = null;
        refreshing = false;
        if (!cancelled) scheduleReconnect();
      }
    };

    /** 按事件序号处理实时消息并触发缺口补拉。 */
    const receive = (event: RuntimeEvent) => {
      if (cancelled) return;
      // 发现事件序号断档就用持久快照重建，避免只靠 SSE 增量拼错状态。
      if (event.type === "session.snapshot.required" || event.seq > cursor.current + 1) {
        void refreshSnapshot();
        return;
      }
      if (event.seq <= cursor.current) return;
      cursor.current = event.seq;
      if (event.type === "session.message.accepted") {
        setContinueFromRunId(null);
        setActiveRunId(event.runId);
        setRunStatus("排队中");
        setContextSummary(null);
        setAttachmentReadCount(0);
      }
      if (event.type === "session.thinking.delta") targetThinking += String(event.payload.text ?? "");
      if (event.type === "session.message.delta") targetText += String(event.payload.text ?? "");
      if (event.type === "session.context.resolved") {
        setContextSummary(event.payload);
        setAttachmentReadCount(0);
      }
      if (event.type === "session.context.measured" && !event.payload.delegationId) {
        latestContextTokens.current = event.payload as unknown as ContextTokenMeasurement;
        setContextTokens(latestContextTokens.current);
      }
      if (
        event.type === "session.tool.completed" &&
        event.payload.toolName === "read_uploaded_text" &&
        event.payload.isError === false
      )
        setAttachmentReadCount((current) => current + 1);
      if (
        [
          "session.tool.started",
          "session.tool.timeout",
          "session.tool.completed",
          "session.delegation.started",
          "session.delegation.finished",
          "session.compaction.started",
          "session.compaction.finished",
          "session.microcompact.completed",
          "session.context.compressed",
          "session.delegation.question",
          "session.delegation.answered",
          "session.delegation.steered",
        ].includes(event.type)
      ) {
        setToolEvents((current) => [...current, event].slice(-100));
      }
      if (event.type === "session.message.completed") {
        targetText = String(event.payload.text ?? "");
        targetThinking = String(event.payload.thinking ?? targetThinking);
        completedMessage = {
          messageId: String(event.payload.messageId),
          sessionId,
          runId: event.runId,
          role: "assistant",
          content: targetText,
          thinking: targetThinking,
          createdAt: event.occurredAt,
        };
      }
      if (event.type === "session.execution.started") {
        finishDisplayedMessage();
        targetText = "";
        targetThinking = "";
        visibleText = "";
        visibleThinking = "";
        setStream("");
        setThinkingStream("");
        setToolEvents([]);
        setRunStatus("运行中");
        setActiveRunId(event.runId);
      }
      if (event.type === "session.execution.retrying") {
        targetText = "";
        targetThinking = "";
        visibleText = "";
        visibleThinking = "";
        setStream("");
        setThinkingStream("");
        setToolEvents([]);
        setRunStatus("排队中");
        setActiveRunId(event.runId);
      }
      if (event.type === "session.execution.cancel.requested") setRunStatus("取消中");
      if (event.type === "session.execution.finished") {
        setContinueFromRunId(event.payload.status === "CANCELLED" ? event.runId : null);
        if (event.runId) terminalRunIds.current.add(event.runId);
        if (event.payload.status === "SUCCEEDED") committedContextTokens.current = latestContextTokens.current;
        else {
          latestContextTokens.current = committedContextTokens.current;
          setContextTokens(committedContextTokens.current);
        }
        setRunStatus(runStatusLabel(typeof event.payload.status === "string" ? event.payload.status : null));
        setActiveRunId((current) => (current === event.runId ? null : current));
        if (event.payload.errorMessage || event.payload.status === "CANCELLED") {
          targetText = "";
          targetThinking = "";
          visibleText = "";
          visibleThinking = "";
          completedMessage = null;
          setStream("");
          setThinkingStream("");
          setError(event.payload.status === "CANCELLED" ? "" : String(event.payload.errorMessage));
        }
      }
    };

    /** 在 SSE 断开后安排换取新凭证并续订。 */
    const scheduleReconnect = () => {
      // 断线后逐步延长重试间隔，连接成功再恢复初始间隔。
      if (cancelled || refreshing || retry) return;
      setConnected(false);
      retry = setTimeout(() => {
        retry = null;
        void reconnect();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15_000);
    };

    /** 重连事件流并从已确认游标继续接收。 */
    const reconnect = async () => {
      if (cancelled || reconnecting) return;
      reconnecting = true;
      try {
        const nextSocket = await api.connectEvents(sessionId, cursor.current, receive, () => {
          if (!refreshing) scheduleReconnect();
        });
        if (cancelled) {
          nextSocket.close();
          return;
        }
        socket = nextSocket;
        socket.onopen = () => {
          setConnected(true);
          retryDelay = 1500;
        };
      } catch {
        scheduleReconnect();
      } finally {
        reconnecting = false;
      }
    };

    void api
      .getSessionSnapshot(sessionId)
      .then((snapshot) => {
        if (cancelled) return;
        applySnapshot(snapshot);
        void reconnect();
      })
      .catch((reason: unknown) => setError(String(reason)));
    return () => {
      cancelled = true;
      clearInterval(animation);
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [paired, sessionId]);

  useEffect(() => {
    if (!paired || !sessionId || !messages.length || document.visibilityState !== "visible") return;
    const latest = messages.at(-1);
    if (!latest || latest.sessionId !== sessionId || latest.messageId === lastMarkedRead.current) return;
    lastMarkedRead.current = latest.messageId;
    void api.markSessionRead(sessionId, latest.messageId).then(
      (updated) => setSessions((current) => current.map((item) => (item.sessionId === sessionId ? updated : item))),
      () => {
        lastMarkedRead.current = "";
      },
    );
  }, [paired, sessionId, messages]);

  useEffect(() => {
    const target = new URLSearchParams(location.search).get("message");
    if (!paired || !sessionId || !target || !messages.length || locatedMessage.current === target) return;
    locatedMessage.current = target;
    void api.messagesAround(sessionId, target).then(
      (items) => {
        setMessages(items);
        setHighlightMessageId(target);
        stickToBottom.current = false;
        requestAnimationFrame(() => document.getElementById(`message-${target}`)?.scrollIntoView({ block: "center" }));
      },
      (reason: unknown) => {
        locatedMessage.current = "";
        setError(String(reason));
      },
    );
  }, [paired, sessionId, location.search, messages.length]);

  /** 完成浏览器与本机 Host 配对。 */
  async function pair(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      await api.completePairing(pairingCode);
      setPaired(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  /** 创建普通会话并导航到新会话。 */
  async function newSession() {
    setError("");
    try {
      const session = await api.createSession();
      setSessions((current) => [session, ...current]);
      setSearchQuery("");
      navigate(`/sessions/${session.sessionId}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  /** 将当前普通会话关联到用户选择的商家。 */
  async function bindCurrentSession() {
    if (
      !sessionId ||
      !selectedMerchantId ||
      bindingMerchant ||
      ["排队中", "运行中", "恢复中", "取消中"].includes(runStatus)
    )
      return;
    setBindingMerchant(true);
    setError("");
    try {
      const updated = await api.bindSessionMerchant(sessionId, selectedMerchantId);
      setSessions((current) => current.map((item) => (item.sessionId === sessionId ? updated : item)));
      setSelectedMerchantId("");
      navigate(`/sessions/${sessionId}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBindingMerchant(false);
    }
  }

  /** 验证并提交会话消息，同时更新乐观页面状态。 */
  async function sendContent(value: string, onAccepted?: () => void) {
    const content = value.trim();
    if (
      !sessionId ||
      !content ||
      !model?.configured ||
      sending ||
      activeRunId ||
      currentSession?.lifecycleStatus === "ARCHIVED"
    )
      return;
    const selectedExpertRole: ExpertSelectionId = "team";
    const artifactIds = artifacts
      .filter((item) => item.status === "READY" && selectedArtifactIds.includes(item.artifactId))
      .map((item) => item.artifactId)
      .sort();
    stickToBottom.current = true;
    setError("");
    setRunStatus("排队中");
    setSending(true);
    const previous = pendingTurn.current;
    const clientTurnId =
      previous?.sessionId === sessionId &&
      previous.content === content &&
      previous.expertRole === selectedExpertRole &&
      previous.continueFromRunId === continueFromRunId &&
      JSON.stringify(previous.artifactIds) === JSON.stringify(artifactIds)
        ? previous.clientTurnId
        : crypto.randomUUID();
    pendingTurn.current = {
      sessionId,
      content,
      expertRole: selectedExpertRole,
      artifactIds,
      continueFromRunId,
      clientTurnId,
    };
    try {
      const result = await api.sendMessage(
        sessionId,
        content,
        clientTurnId,
        selectedExpertRole ?? undefined,
        artifactIds,
        continueFromRunId ?? undefined,
      );
      onAccepted?.();
      setDraft((current) => (current.trim() === content ? "" : current));
      sessionStorage.removeItem(sessionDraftKey(sessionId));
      if ((location.state as { compose?: unknown } | null)?.compose)
        navigate(location.pathname, { replace: true, state: null });
      // 极快任务的 SSE 终态可能先于 HTTP accepted 到达，不能再把已结束 Run 设为活动。
      if (!terminalRunIds.current.has(result.runId)) setActiveRunId(result.runId);
      setContextSummary(null);
      setAttachmentReadCount(0);
      pendingTurn.current = null;
      setMemoryNotice(
        currentSession?.scope === "MERCHANT" && /^记住[：:]/.test(content)
          ? "已按你的明确要求保存商家长期规则；可在商家页编辑或停用。"
          : "",
      );
      // 先补本地用户消息；如果事件已到达，则保持已有消息顺序。
      setMessages((current) => {
        if (current.some((item) => item.messageId === result.messageId)) return current;
        const next = [...current];
        const assistantIndex = next.findIndex((item) => item.runId === result.runId && item.role === "assistant");
        next.splice(assistantIndex < 0 ? next.length : assistantIndex, 0, {
          messageId: result.messageId,
          sessionId,
          runId: result.runId,
          role: "user",
          content,
          createdAt: new Date().toISOString(),
        });
        return next;
      });
      setSessions((current) =>
        current.map((item) => (item.sessionId === sessionId ? { ...item, updatedAt: new Date().toISOString() } : item)),
      );
    } catch (reason) {
      setDraft((current) => current || content);
      // 双标签页的占用冲突从持久快照恢复，保留草稿和真实停止入口。
      try {
        const snapshot = await api.getSessionSnapshot(sessionId);
        setActiveRunId(snapshot.activeRun?.runId ?? null);
        setContinueFromRunId(
          !snapshot.activeRun && snapshot.latestRun?.status === "CANCELLED" ? snapshot.latestRun.runId : null,
        );
        setRunStatus(
          snapshot.activeRun?.cancelRequestedAt ? "取消中" : runStatusLabel(snapshot.activeRun?.status ?? null),
        );
      } catch {
        setRunStatus("");
      }
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  }

  /** 处理输入框发送事件并避免重复提交。 */
  async function submit(event: FormEvent) {
    event.preventDefault();
    await sendContent(draft);
  }

  /** 归档时明确共享会话文字摘要，完成后进入商家页查看独立总结进度。 */
  async function archiveCurrentSession() {
    if (!sessionId || currentSession?.lifecycleStatus !== "ACTIVE" || archiving || sending || activeRunId) return;
    setArchiving(true);
    setError("");
    try {
      if (currentSession.scope === "MERCHANT") {
        await api.archiveSession(sessionId);
        setSessions(await api.listSessions());
        navigate(`/merchants/${currentSession.ownerId}?tab=memory`);
      } else {
        const archived = await api.archiveNormalSession(sessionId);
        setSessions((current) => current.map((item) => (item.sessionId === sessionId ? archived : item)));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setArchiving(false);
    }
  }

  /** 恢复原会话的写入入口，保留已经生成的商家总结。 */
  async function restoreCurrentSession() {
    if (!sessionId || archiving) return;
    setArchiving(true);
    try {
      const item = await api.restoreSession(sessionId);
      setSessions((current) => current.map((entry) => (entry.sessionId === sessionId ? item : entry)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setArchiving(false);
    }
  }

  /** 修改当前会话标题并保留服务端 revision 冲突保护。 */
  async function renameCurrentSession() {
    if (!sessionId || !currentSession) return;
    const title = window.prompt("会话标题", currentSession.title)?.trim();
    if (!title || title === currentSession.title) return;
    try {
      const updated = await api.renameSession(sessionId, title, currentSession.titleRevision);
      setSessions((current) => current.map((item) => (item.sessionId === sessionId ? updated : item)));
      setSessionPageItems((current) => current.map((item) => (item.sessionId === sessionId ? updated : item)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  /** 展示关联对象影响后，将当前会话移入可恢复回收站。 */
  async function trashCurrentSession() {
    if (!sessionId || !currentSession || activeRunId) return;
    try {
      const impact = await api.sessionDeleteImpact(sessionId);
      if (impact.activeRun) {
        setError("当前会话仍有运行中的任务，结束后才能移入回收站。");
        return;
      }
      const confirmed = window.confirm(
        `将「${currentSession.title}」移入回收站？\n消息 ${impact.messages} 条、Run ${impact.runs} 个、文件 ${impact.artifacts} 个、证据 ${impact.evidence} 条、诊断 ${impact.diagnoses} 份、报告 ${impact.reports} 份、专家任务 ${impact.delegations} 个、压缩记录 ${impact.checkpoints} 条、记忆任务 ${impact.memoryJobs} 个、工作计划 ${impact.workPlans} 个、审核意见 ${impact.publicationReviews} 份和发布记录 ${impact.publicationRecords} 条将暂时不可见。30 天内可恢复。`,
      );
      if (!confirmed) return;
      await api.trashSession(sessionId);
      setSessions((current) => current.filter((item) => item.sessionId !== sessionId));
      navigate("/sessions");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  /** 分页加载更早消息，保留当前滚动位置。 */
  async function loadOlderMessages() {
    const oldest = messages[0];
    if (!sessionId || !oldest || historyLoading || !historyHasMore) return;
    setHistoryLoading(true);
    const container = timeline.current;
    const previousHeight = container?.scrollHeight ?? 0;
    try {
      const older = await api.listMessages(sessionId, oldest.messageId);
      if (visibleSessionId.current !== sessionId) return;
      if (older.length < 50) historyExhausted.current = true;
      setHistoryHasMore(older.length === 50);
      setMessages((current) => {
        const known = new Set(current.map((item) => item.messageId));
        return [...older.filter((item) => !known.has(item.messageId)), ...current];
      });
      stickToBottom.current = false;
      requestAnimationFrame(() => {
        if (container) container.scrollTop = container.scrollHeight - previousHeight + container.scrollTop;
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setHistoryLoading(false);
    }
  }

  /** 追加下一页会话并保持稳定游标顺序。 */
  async function loadMoreSessions() {
    if (!sessionPageCursor || sessionPageLoading) return;
    setSessionPageLoading(true);
    try {
      const result = await api.listSessionPage(sessionPageStatus, sessionPageCursor);
      setSessionPageItems((current) => {
        const known = new Set(current.map((item) => item.sessionId));
        return [...current, ...result.items.filter((item) => !known.has(item.sessionId))];
      });
      setSessionPageCursor(result.nextCursor);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSessionPageLoading(false);
    }
  }

  /** 从回收站恢复一条会话，历史消息及原归档状态一同恢复。 */
  async function untrashSession(id: string) {
    try {
      const restored = await api.restoreTrashedSession(id);
      setSessionPageItems((current) => current.filter((item) => item.sessionId !== id));
      setSessions((current) => [restored, ...current.filter((item) => item.sessionId !== id)]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  /** 经影响预览和用户确认后永久删除回收站会话。 */
  async function purgeTrashedSession(item: SessionRecord) {
    try {
      const impact = await api.sessionDeleteImpact(item.sessionId);
      const confirmed = window.confirm(
        `永久删除「${item.title}」？这将移除 ${impact.messages} 条消息、${impact.runs} 个 Run、${impact.artifacts} 个文件、${impact.diagnoses} 份诊断、${impact.reports} 份报告及 ${impact.delegations} 个专家任务，以及 ${impact.workPlans} 个计划、${impact.publicationReviews} 份审核和 ${impact.publicationRecords} 条发布登记，无法恢复。${impact.sharedMemories ? `该会话仍关联 ${impact.sharedMemories} 版商家记忆，需先处理引用。` : ""}`,
      );
      if (!confirmed) return;
      await api.purgeSession(item.sessionId);
      setSessionPageItems((current) => current.filter((entry) => entry.sessionId !== item.sessionId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  const lastUserMessage = [...messages]
    .reverse()
    .find((item) => item.role === "user" && (xhsUrlInText(item.content) || currentSession?.researchScope));
  const xhsRequest =
    xhsUrlInText(draft) || (currentSession?.researchScope && draft.trim())
      ? draft.trim()
      : (xhsLoginPrompt.current?.content ?? lastUserMessage?.content ?? "");
  const xhsTargetUrl =
    xhsUrlInText(xhsRequest) ??
    (currentSession?.researchScope ? "https://www.xiaohongshu.com/search_result/?keyword=%E7%94%9F%E6%B4%BB" : null);

  /** 从输入或上一条消息提取目标链接并打开 Chrome 登录。 */
  async function startXhsLogin() {
    if (!sessionId || !xhsTargetUrl || xhsLoginBusy) return;
    setXhsLoginBusy(true);
    setError("");
    try {
      xhsLoginPrompt.current = {
        content: xhsRequest,
        fromDraft: Boolean(draft.trim() && (xhsUrlInText(draft) || currentSession?.researchScope)),
      };
      sessionStorage.setItem(xhsLoginPromptKey(sessionId), JSON.stringify(xhsLoginPrompt.current));
      setXhsLogin(await api.startXhsLogin(sessionId, xhsTargetUrl));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setXhsLoginBusy(false);
    }
  }

  /** 确认登录后开启新的用户 Run 继续原采集请求。 */
  async function confirmXhsLogin() {
    if (!sessionId || xhsLoginBusy) return;
    setXhsLoginBusy(true);
    setError("");
    try {
      const status = xhsLogin?.status === "READY" ? xhsLogin : await api.confirmXhsLogin(sessionId);
      setXhsLogin(status);
      if (status.status !== "READY") return;
      // 原 Run 可能尚在结束中；续采提示只有新消息已受理才清除。
      const original = xhsLoginPrompt.current ?? {
        content: xhsRequest,
        fromDraft: Boolean(draft.trim() && (xhsUrlInText(draft) || currentSession?.researchScope)),
      };
      xhsLoginPrompt.current = original;
      sessionStorage.setItem(xhsLoginPromptKey(sessionId), JSON.stringify(original));
      setXhsResumePending(true);
      if (activeRunId || sending) {
        resumeAfterRun.current = true;
        return;
      }
      resumeAfterRun.current = false;
      if (xhsUrlInText(original.content) || currentSession?.researchScope) {
        const content = original.fromDraft
          ? original.content
          : `请使用刚完成授权的小红书登录态重新采集，并按本轮冻结的商家研究范围继续上一次请求；需要时调用 merchant_research_save 保存候选或缺口：\n${original.content}`;
        await sendContent(content, () => {
          xhsLoginPrompt.current = null;
          setXhsResumePending(false);
          sessionStorage.removeItem(xhsLoginPromptKey(sessionId));
        });
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      const status = await api.getXhsLogin(sessionId).catch(() => null);
      if (status) setXhsLogin(status);
      if (status?.status === "UNCONFIGURED") sessionStorage.removeItem(xhsLoginPromptKey(sessionId));
    } finally {
      setXhsLoginBusy(false);
    }
  }

  /** 取消页面中的小红书登录流程并清除临时提示词。 */
  async function cancelXhsLogin() {
    if (!sessionId || xhsLoginBusy) return;
    setXhsLoginBusy(true);
    setError("");
    try {
      setXhsLogin(await api.cancelXhsLogin(sessionId));
      xhsLoginPrompt.current = null;
      setXhsResumePending(false);
      sessionStorage.removeItem(xhsLoginPromptKey(sessionId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setXhsLoginBusy(false);
    }
  }

  confirmXhsLoginLatest.current = confirmXhsLogin;
  useEffect(() => {
    // 只在旧 Run 结束时续采一次；失败后由用户重试，避免自动循环请求。
    if (
      resumeAfterRun.current &&
      !activeRunId &&
      xhsResumePending &&
      xhsLogin?.status === "READY" &&
      !xhsLoginBusy &&
      !sending
    ) {
      resumeAfterRun.current = false;
      void confirmXhsLoginLatest.current?.();
    }
  }, [activeRunId, xhsResumePending, xhsLogin?.status, xhsLoginBusy, sending]);

  /** 请求取消当前活动 Run 并刷新状态。 */
  async function cancelCurrentRun() {
    if (!activeRunId) return;
    setError("");
    try {
      const run = await api.cancelRun(activeRunId);
      if (terminalRunIds.current.has(run.runId)) return;
      setRunStatus(run.status === "RUNNING" ? "取消中" : runStatusLabel(run.status));
      if (run.status === "CANCELLED") {
        setActiveRunId(null);
        setContinueFromRunId(run.runId);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  /** 上传当前会话的文字或图片参考，并选入下一轮。 */
  async function uploadReferenceFile(file: File | undefined) {
    if (!sessionId || !file || uploading) return;
    const isImage = ["image/png", "image/jpeg", "image/webp"].includes(file.type);
    if (file.size > (isImage ? 8 : 2) * 1024 * 1024) {
      setError(isImage ? "图片不能超过 8 MB" : "文本文件不能超过 2 MB");
      return;
    }
    setUploading(true);
    setError("");
    try {
      const artifact = await api.uploadReferenceFile(sessionId, file);
      if (visibleSessionId.current !== sessionId) return;
      setArtifacts((current) => [artifact, ...current.filter((item) => item.artifactId !== artifact.artifactId)]);
      setSelectedArtifactIds((current) =>
        current.length < 50 ? [...current, artifact.artifactId] : [...current.slice(1), artifact.artifactId],
      );
      if (selectedArtifactIds.length >= 50) setError("本轮最多选择 50 个文件；已取消最早勾选的文件。");
      setDraft(
        (current) =>
          `${current}${current.trim() ? "\n" : ""}请参考刚上传的${isImage ? "图片" : "文件"}「${artifact.title}」。`,
      );
      if (isImage && !model?.imageInput)
        setError("图片已上传；当前模型未启用视觉输入，Agent 暂时看不到画面。请配置视觉模型后重启 Host。");
    } catch (reason) {
      if (visibleSessionId.current === sessionId) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  useEffect(() => {
    if (
      !sessionId ||
      new URLSearchParams(location.search).has("studio") ||
      !new URLSearchParams(location.search).has("draft")
    )
      return;
    setSessionTool("content");
    setInspectorOpen(true);
  }, [sessionId, location.search]);

  /** 打开会话辅助工具，保持聊天输入和当前表单不变。 */
  function openSessionTool(tool: typeof sessionTool) {
    setSessionTool(tool);
    setInspectorOpen(true);
  }

  /** 构建当前会话路由地址。 */
  const sessionPath = (item: SessionRecord) => `/sessions/${item.sessionId}`;
  const page = sessionId
    ? "chat"
    : location.pathname.startsWith("/merchants")
      ? "merchants"
      : location.pathname === "/sessions"
        ? "sessions"
        : location.pathname === "/settings"
          ? "settings"
          : location.pathname === "/products"
            ? "products"
            : location.pathname === "/experts"
              ? "experts"
              : location.pathname === "/skills"
                ? "skills"
                : "dashboard";
  const recentSessions = [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const matchedSessions = recentSessions.filter((item) =>
    item.title.toLowerCase().includes(searchQuery.trim().toLowerCase()),
  );
  const visibleSessionPageItems = sessionPageItems.filter((item) =>
    item.title.toLowerCase().includes(searchQuery.trim().toLowerCase()),
  );
  const isModelReady = Boolean(model?.configured);
  const isStudio = page === "chat" && new URLSearchParams(location.search).has("studio");

  if (paired === null)
    return (
      <main className="welcome">
        <WelcomeIntro />
        <div className="welcome-form">
          <div className="pair-card">
            <span className="eyebrow">连接状态</span>
            <h2>正在准备商家工作台</h2>
            <p>正在检查本机服务。若长时间未进入，请确认服务已启动。</p>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button type="button" className="primary-button" onClick={() => window.location.reload()}>
              重新连接
            </button>
          </div>
        </div>
      </main>
    );
  if (!paired)
    return (
      <main className="welcome">
        <WelcomeIntro />
        <div className="welcome-form">
          <form className="pair-card" onSubmit={pair}>
            <span className="eyebrow">进入工作台</span>
            <h2>开始商家内容工作</h2>
            <p>输入本机配对码，管理商家档案、诊断线索和会话中的文案任务。默认码 {DEFAULT_PAIRING_CODE}，已为你填好。</p>
            <label htmlFor="pair-code">本机配对码</label>
            <input
              id="pair-code"
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              value={pairingCode}
              onChange={(event) => setPairingCode(event.target.value.replace(/\D/g, ""))}
              placeholder="输入六位配对码"
            />
            <button type="submit" className="primary-button" disabled={pairingCode.length !== 6}>
              进入织伴
            </button>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="pair-note">离开页面后，已受理的会话任务仍会在本机继续运行。</div>
          </form>
        </div>
      </main>
    );

  return (
    <div className={`app-shell ${page === "chat" && !isStudio ? "chat-shell" : ""}`}>
      <header className="global-topbar">
        <strong className="top-page-title">
          {
            {
              dashboard: "仪表盘",
              sessions: "对话",
              chat: "图文工作台",
              merchants: "商家维护",
              products: "商品维护",
              experts: "专家",
              skills: "Skill",
              settings: "设置",
            }[page]
          }
        </strong>
        <div className="global-search">
          <span aria-hidden="true">⌕</span>
          <input
            aria-label="搜索会话"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              const firstSession = matchedSessions[0];
              const firstHit = searchHits[0];
              if (event.key === "Escape") setSearchQuery("");
              if (event.key === "Enter" && (firstSession || firstHit)) {
                navigate(
                  firstSession
                    ? sessionPath(firstSession)
                    : `/sessions/${firstHit?.sessionId}?message=${firstHit?.messageId}`,
                );
                setSearchQuery("");
              }
            }}
            placeholder="搜索会话..."
          />
          {searchQuery && (
            <div className="search-results">
              {matchedSessions.length || searchHits.length ? (
                <>
                  {matchedSessions.slice(0, 4).map((item) => (
                    <button
                      type="button"
                      key={item.sessionId}
                      onClick={() => {
                        navigate(sessionPath(item));
                        setSearchQuery("");
                      }}
                    >
                      <span>{item.title}</span>
                      <small>{activityTime(item.updatedAt)}</small>
                    </button>
                  ))}
                  {searchHits.slice(0, 6).map((hit) => (
                    <button
                      type="button"
                      key={hit.messageId}
                      onClick={() => {
                        navigate(`/sessions/${hit.sessionId}?message=${hit.messageId}`);
                        setSearchQuery("");
                      }}
                    >
                      <span>
                        {hit.sessionTitle} · {hit.excerpt}
                      </span>
                      <small>{activityTime(hit.createdAt)}</small>
                    </button>
                  ))}
                </>
              ) : (
                <p>没有找到会话</p>
              )}
            </div>
          )}
        </div>
        <div className="top-actions">
          <button type="button" className="primary-button compact" onClick={() => void newSession()}>
            ＋ 新建
          </button>
          <span className="top-connection">
            <i
              className={!hostOnline || (page === "chat" && !connected) ? "connection-dot waiting" : "connection-dot"}
            />
            {hostOnline === null
              ? "检查本地服务"
              : !hostOnline
                ? "本地服务中断"
                : page === "chat"
                  ? connected
                    ? "实时连接"
                    : "正在重连"
                  : "本地服务正常"}
          </span>
          <span className="avatar" title="本机用户">
            我
          </span>
        </div>
      </header>
      <div className="app-grid">
        <aside className="sidebar">
          <button type="button" className="sidebar-brand" onClick={() => navigate("/")}>
            <span className="brand-mark">织</span>
            <strong>织伴</strong>
            <small>商家工作台</small>
          </button>
          <nav aria-label="主导航">
            <button
              type="button"
              className={`nav-link ${page === "dashboard" ? "active" : ""}`}
              onClick={() => navigate("/")}
            >
              <Icon name="grid" />
              仪表盘
            </button>
            <button
              type="button"
              className={`nav-link ${page === "sessions" || page === "chat" ? "active" : ""}`}
              onClick={() => (recentSessions[0] ? navigate(sessionPath(recentSessions[0])) : void newSession())}
            >
              <Icon name="chat" />
              对话
            </button>
            <button
              type="button"
              className={`nav-link ${page === "merchants" ? "active" : ""}`}
              onClick={() => navigate("/merchants")}
            >
              <Icon name="shop" />
              商家维护
            </button>
            <button
              type="button"
              className={`nav-link ${page === "experts" ? "active" : ""}`}
              onClick={() => navigate("/experts")}
            >
              <Icon name="users" />
              专家
            </button>
            <button
              type="button"
              className={`nav-link ${page === "skills" ? "active" : ""}`}
              onClick={() => navigate("/skills")}
            >
              <Icon name="spark" />
              Skill
            </button>
            <button
              type="button"
              className={`nav-link ${page === "products" ? "active" : ""}`}
              onClick={() => navigate("/products")}
            >
              <Icon name="box" />
              商品维护
            </button>
            <div className="nav-caption spaced merchant-list-title">
              商家列表
              <button type="button" aria-label="管理商家" onClick={() => navigate("/merchants")}>
                <Icon name="plus" size={15} />
              </button>
            </div>
            {merchants.length ? (
              merchants.slice(0, 8).map((item) => (
                <button
                  type="button"
                  key={item.merchantId}
                  className={`nav-link recent ${merchantId === item.merchantId ? "active" : ""}`}
                  onClick={() => navigate(`/merchants/${item.merchantId}`)}
                >
                  <span className="recent-dot" />
                  <span className="nav-title">{item.name}</span>
                </button>
              ))
            ) : (
              <div className="nav-empty">暂无商家</div>
            )}
            <div className="nav-caption spaced">管理</div>
            <button
              type="button"
              className={`nav-link ${page === "settings" ? "active" : ""}`}
              onClick={() => navigate("/settings")}
            >
              <Icon name="settings" />
              设置
            </button>
          </nav>
          <div className="sidebar-foot">
            <fieldset className="theme-switch" aria-label="界面颜色">
              {[
                ["green", "松绿"],
                ["blue", "雾蓝"],
                ["clay", "陶棕"],
              ].map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  title={label}
                  aria-label={`${label}主题`}
                  aria-pressed={theme === value}
                  className={`theme-${value}`}
                  onClick={() => setTheme(value ?? "green")}
                />
              ))}
            </fieldset>
            <span className="avatar">我</span>
            <div>
              <strong>本机工作台</strong>
              <small>资料保存在本机</small>
            </div>
          </div>
        </aside>
        <div className="workspace">
          {page === "chat" && !isStudio && (
            <SessionSidebar
              sessions={recentSessions}
              currentId={sessionId}
              open={sessionListOpen}
              onToggle={() => setSessionListOpen((value) => !value)}
              onSelect={(item) => {
                navigate(sessionPath(item));
                if (window.innerWidth < 1100) setSessionListOpen(false);
              }}
              onCreate={() => {
                if (window.innerWidth < 1100) setSessionListOpen(false);
                void newSession();
              }}
              onManage={() => navigate("/sessions")}
            />
          )}

          <main className={page === "chat" ? "main-panel chat-main" : "main-panel"}>
            {error && (
              <div className="error-banner" role="alert">
                {error}
              </div>
            )}
            {page === "dashboard" && <DashboardPage merchants={merchants} />}
            {page === "sessions" && (
              <div className="page-content">
                <div className="page-kicker">工作台 / 会话</div>
                <div className="page-heading">
                  <div>
                    <h1>会话</h1>
                    <p>查找、继续或新建本机 Agent 会话。</p>
                  </div>
                  <button type="button" className="primary-button" onClick={() => void newSession()}>
                    ＋ 新建会话
                  </button>
                </div>
                <section className="list-card">
                  <div className="list-head">
                    <h2>
                      {sessionPageStatus === "ACTIVE" ? "全部会话" : "回收站"}{" "}
                      <span>
                        {sessionPageItems.length}
                        {sessionPageCursor ? "+" : ""}
                      </span>
                    </h2>
                    <div>
                      <button type="button" className="text-link" onClick={() => setSessionPageStatus("ACTIVE")}>
                        全部会话
                      </button>
                      <button type="button" className="text-link" onClick={() => setSessionPageStatus("TRASHED")}>
                        回收站
                      </button>
                    </div>
                  </div>
                  {visibleSessionPageItems.length ? (
                    visibleSessionPageItems.map((item) => (
                      <div className="session-row" key={item.sessionId}>
                        <button
                          type="button"
                          className="session-row-main-button"
                          onClick={() =>
                            sessionPageStatus === "TRASHED"
                              ? void untrashSession(item.sessionId)
                              : navigate(
                                  item.firstUnreadMessageId
                                    ? `${sessionPath(item)}?message=${item.firstUnreadMessageId}`
                                    : sessionPath(item),
                                )
                          }
                        >
                          <span className="row-icon">▤</span>
                          <span className="row-main">
                            <strong>
                              {item.title}
                              {item.unreadCount > 0 && sessionPageStatus === "ACTIVE"
                                ? ` · ${item.unreadCount} 条未读`
                                : ""}
                            </strong>
                            <small>
                              {sessionPageStatus === "TRASHED"
                                ? `点击恢复 · 保留至 ${item.trashExpiresAt?.slice(0, 10) ?? "待定"}`
                                : `${item.scope === "MERCHANT" ? "已关联商家" : "未关联商家"} · ${item.modelAlias || "模型待配置"}`}
                            </small>
                          </span>
                          <span className="row-time">{activityTime(item.updatedAt)}</span>
                          <span className="row-arrow">↗</span>
                        </button>
                        {sessionPageStatus === "TRASHED" && (
                          <button type="button" className="text-link" onClick={() => void purgeTrashedSession(item)}>
                            永久删除
                          </button>
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="list-empty">
                      <h3>
                        {sessionPageLoading
                          ? "正在加载"
                          : searchQuery
                            ? "没有找到匹配的会话"
                            : sessionPageStatus === "TRASHED"
                              ? "回收站为空"
                              : "还没有会话"}
                      </h3>
                      <p>{searchQuery ? "试试其他关键词。" : "新建会话后，历史记录会显示在这里。"}</p>
                      {!searchQuery && (
                        <button type="button" className="primary-button" onClick={() => void newSession()}>
                          新建会话
                        </button>
                      )}
                    </div>
                  )}
                  {sessionPageCursor && (
                    <button
                      type="button"
                      className="outline-button"
                      disabled={sessionPageLoading}
                      onClick={() => void loadMoreSessions()}
                    >
                      {sessionPageLoading ? "加载中" : "加载更多会话"}
                    </button>
                  )}
                </section>
              </div>
            )}
            {page === "merchants" && (
              <MerchantPage
                merchantId={merchantId}
                modelConfigured={isModelReady}
                onSessionCreated={(session) => setSessions((current) => [session, ...current])}
              />
            )}
            {page === "products" && (
              <ProductsPage
                merchants={merchants}
                modelConfigured={isModelReady}
                onSessionCreated={(session) => setSessions((current) => [session, ...current])}
              />
            )}
            {(page === "experts" || page === "skills") && <CapabilitiesPage page={page} />}
            {page === "settings" && (
              <div className="page-content">
                <div className="page-kicker">管理 / 设置</div>
                <div className="page-heading">
                  <div>
                    <h1>设置与连接</h1>
                    <p>查看本机服务和外部能力的接入状态。</p>
                  </div>
                </div>
                <div className="settings-grid">
                  <section className="surface-card">
                    <h2>服务与模型</h2>
                    <div className="metric-line">
                      <span>本地 Host</span>
                      <span
                        className={statusClass(hostOnline === null ? "检查中" : hostOnline ? "已完成" : "连接中断")}
                      >
                        {hostOnline === null ? "检查中" : hostOnline ? "正常" : "连接中断"}
                      </span>
                    </div>
                    <div className="metric-line">
                      <span>文本模型</span>
                      <span className={statusClass(isModelReady ? "已完成" : "待配置")}>
                        {isModelReady ? model?.alias : "待配置"}
                      </span>
                    </div>
                    <p className="muted">模型由本机 Host 注册到 Pi SDK，再由 Pi SDK 发起请求。密钥不会传给浏览器。</p>
                  </section>
                  <section className="surface-card">
                    <h2>创作与交付</h2>
                    <div className="metric-line">
                      <span>图片生成</span>
                      <span className="status-pill pending">
                        {providers.image === "unconfigured" ? "待配置" : (providers.image ?? "待配置")}
                      </span>
                    </div>
                    <div className="metric-line">
                      <span>业务数据</span>
                      <span className="status-pill pending">
                        {providers.businessData === "unconfigured" ? "待配置" : (providers.businessData ?? "待配置")}
                      </span>
                    </div>
                    <div className="metric-line">
                      <span>外部交付</span>
                      <span className="status-pill pending">
                        {providers.delivery === "unconfigured" ? "待配置" : (providers.delivery ?? "待配置")}
                      </span>
                    </div>
                    <p className="muted">
                      图片服务按当前配置使用；图文发布包可下载到本机，发布后可人工登记链接和反馈。
                    </p>
                  </section>
                </div>
                <section className="surface-card setup-card">
                  <h2>配置文本模型</h2>
                  <p>
                    在启动 Host 的终端环境中设置模型 Base URL、模型 ID 和密钥，然后重启 Host。已有加密配置可通过项目
                    README 中的方式维护。
                  </p>
                  <code>ZHIBAN_MODEL_BASE_URL · ZHIBAN_MODEL_ID · ZHIBAN_MODEL_API_KEY</code>
                  <p className="muted">具体命令见项目根目录 README.md 的“配置文本模型”。</p>
                </section>
                <section className="surface-card setup-card">
                  <h2>全局系统提示词</h2>
                  <p className="muted">
                    这是基础指令，运行时还会加入角色、Skill
                    和本轮资料。新任务受理时保存当前版本；修改不会改变已受理任务。完整组装记录可在会话概览的“本轮提示词与资料”查看。
                  </p>
                  <label htmlFor="system-prompt">提示词内容 · 第 {systemPrompt?.revision ?? "-"} 版</label>
                  <textarea
                    id="system-prompt"
                    className="system-prompt-input"
                    value={promptDraft}
                    maxLength={20_000}
                    disabled={!systemPrompt || promptSaving}
                    onChange={(event) => setPromptDraft(event.target.value)}
                    placeholder="加载系统提示词中..."
                  />
                  <div className="prompt-actions">
                    <button
                      type="button"
                      className="primary-button compact"
                      disabled={
                        !systemPrompt || !promptDraft.trim() || promptSaving || promptDraft === systemPrompt.content
                      }
                      onClick={() => void saveSystemPrompt(promptDraft)}
                    >
                      {promptSaving ? "保存中" : "保存提示词"}
                    </button>
                    <button
                      type="button"
                      className="outline-button"
                      disabled={!systemPrompt || promptSaving || systemPrompt.content === systemPrompt.defaultContent}
                      onClick={() => void saveSystemPrompt(systemPrompt?.defaultContent ?? "")}
                    >
                      恢复默认并保存
                    </button>
                  </div>
                  {promptNotice && (
                    <p className="muted" role="status">
                      {promptNotice}
                    </p>
                  )}
                </section>
              </div>
            )}
            {page === "chat" && (
              <>
                {isStudio && sessionId && (
                  <ContentStudio
                    key={sessionId}
                    sessionId={sessionId}
                    merchantId={currentSession?.scope === "MERCHANT" ? currentSession.ownerId : undefined}
                    merchantName={currentMerchantName}
                    modelConfigured={isModelReady}
                    imageInputEnabled={Boolean(model?.imageInput)}
                    provider={providers.image ?? "unconfigured"}
                    writable={currentSession?.lifecycleStatus === "ACTIVE"}
                  />
                )}
                <div className="chat-workspace-content" hidden={isStudio}>
                  <div className="chat-header">
                    <div className="chat-title">
                      <div className="page-kicker">
                        {currentSession?.scope === "MERCHANT"
                          ? `商家 / ${currentMerchantName || "已关联"}`
                          : "未关联商家"}{" "}
                        / 工作台
                      </div>
                      <h1>{currentSession?.title ?? "会话"}</h1>
                    </div>
                    <div className="chat-actions">
                      {!sessionListOpen && (
                        <button type="button" aria-label="展开会话列表" onClick={() => setSessionListOpen(true)}>
                          <Icon name="panel" />
                        </button>
                      )}
                      <details className="session-management">
                        <summary className="outline-button">管理会话</summary>
                        <div className="session-management-menu">
                          {currentSession && currentSession.lifecycleStatus !== "TRASHED" && (
                            <button
                              type="button"
                              className="outline-button"
                              onClick={() => void renameCurrentSession()}
                            >
                              改标题
                            </button>
                          )}
                          {currentSession && currentSession.lifecycleStatus !== "TRASHED" && (
                            <button
                              type="button"
                              className="outline-button"
                              disabled={Boolean(activeRunId)}
                              onClick={() => void trashCurrentSession()}
                            >
                              移入回收站
                            </button>
                          )}
                        </div>
                      </details>
                      {runStatus && <span className={statusClass(runStatus)}>{runStatus}</span>}
                      {activeRunId && ["排队中", "运行中"].includes(runStatus) && (
                        <button type="button" className="outline-button" onClick={() => void cancelCurrentRun()}>
                          取消运行
                        </button>
                      )}
                      <button
                        type="button"
                        className="outline-button inspector-toggle"
                        onClick={() => setInspectorOpen((value) => !value)}
                      >
                        {inspectorOpen ? "收起侧栏" : "工具与详情"}
                      </button>
                    </div>
                  </div>
                  {currentSession && currentSession.lifecycleStatus !== "TRASHED" && (
                    <section className="session-memory-actions" aria-label="会话归档与记忆">
                      <div className="prompt-actions">
                        {currentSession.lifecycleStatus === "ACTIVE" ? (
                          <button
                            type="button"
                            className="outline-button"
                            disabled={archiving || sending || Boolean(activeRunId)}
                            onClick={() => void archiveCurrentSession()}
                          >
                            {archiving
                              ? "正在归档…"
                              : currentSession.scope === "MERCHANT"
                                ? "归档并保存总结"
                                : "归档会话"}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="outline-button"
                            disabled={archiving}
                            onClick={() => void restoreCurrentSession()}
                          >
                            {archiving ? "正在恢复…" : "恢复会话"}
                          </button>
                        )}
                        {currentSession.scope === "MERCHANT" && (
                          <button
                            type="button"
                            className="outline-button"
                            onClick={() => navigate(`/merchants/${currentSession.ownerId}?tab=memory`)}
                          >
                            查看商家记忆
                          </button>
                        )}
                      </div>
                      <p className="muted">
                        {currentSession.scope === "MERCHANT"
                          ? currentSession.lifecycleStatus === "ARCHIVED"
                            ? "会话已归档；总结进度、失败重试和长期候选确认请到商家记忆查看。"
                            : "输入“记住：……”可保存长期规则。归档即允许会话文字摘要用于本商家后续任务；总结另行生成，长期候选需确认，附件原件不因此开放。"
                          : currentSession.lifecycleStatus === "ARCHIVED"
                            ? "会话已归档，恢复后可继续对话；普通会话归档不生成商家记忆。"
                            : "普通会话归档只整理历史；需要跨会话记忆时，请先关联商家。"}
                      </p>
                    </section>
                  )}
                  <nav className="session-tool-shortcuts" aria-label="会话工具">
                    <button type="button" onClick={() => navigate(`/sessions/${sessionId}?studio=1`)}>
                      图文工作台
                    </button>
                    <button type="button" onClick={() => openSessionTool("research")}>
                      研究与选题
                    </button>
                    <button type="button" onClick={() => openSessionTool("content")}>
                      素材与审核
                    </button>
                    <button type="button" onClick={() => openSessionTool("image")}>
                      图片任务
                    </button>
                  </nav>
                  <div className="chat-content">
                    {currentSession?.scope === "NORMAL" && (
                      <div className="info-banner">
                        <div>
                          <strong>需要商家档案时，可在这里关联</strong>
                          <p>现在也能采集公开链接并做账号诊断；关联后，这段对话的证据和草稿会归到所选商家。</p>
                        </div>
                        {merchants.length ? (
                          <div className="merchant-bind-controls">
                            <select
                              aria-label="选择关联商家"
                              value={selectedMerchantId}
                              onChange={(event) => setSelectedMerchantId(event.target.value)}
                              disabled={bindingMerchant}
                            >
                              <option value="">选择商家</option>
                              {merchants.map((item) => (
                                <option key={item.merchantId} value={item.merchantId}>
                                  {item.name}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              className="outline-button"
                              onClick={() => void bindCurrentSession()}
                              disabled={
                                !selectedMerchantId ||
                                bindingMerchant ||
                                ["排队中", "运行中", "恢复中", "取消中"].includes(runStatus)
                              }
                            >
                              关联商家
                            </button>
                          </div>
                        ) : (
                          <button type="button" className="text-link" onClick={() => navigate("/merchants")}>
                            建立商家档案 →
                          </button>
                        )}
                      </div>
                    )}
                    {!isModelReady && (
                      <div className="info-banner attention">
                        <div>
                          <strong>文本模型尚未配置</strong>
                          <p>配置 Host 后即可发送消息。</p>
                        </div>
                        <button type="button" className="text-link" onClick={() => navigate("/settings")}>
                          查看说明 →
                        </button>
                      </div>
                    )}
                    <section
                      className="timeline"
                      ref={timeline}
                      onScroll={(event) => {
                        const element = event.currentTarget;
                        stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
                      }}
                    >
                      {historyHasMore && (
                        <button
                          type="button"
                          className="outline-button"
                          disabled={historyLoading}
                          onClick={() => void loadOlderMessages()}
                        >
                          {historyLoading ? "加载中" : "加载更早消息"}
                        </button>
                      )}
                      {messages.length === 0 && !stream && !thinkingStream && runStatus !== "运行中" && (
                        <div className="chat-empty">
                          <span className="empty-symbol">✳</span>
                          <h2>开始一段新对话</h2>
                          <p>描述目标或提出问题。消息会保存在本机，会话运行由 Pi SDK 执行。</p>
                        </div>
                      )}
                      {messages.map((message, index) =>
                        message.content.trim() ? (
                          <article
                            id={`message-${message.messageId}`}
                            className={`bubble ${message.role}${highlightMessageId === message.messageId ? " search-highlight" : ""}`}
                            key={message.messageId}
                          >
                            {message.role === "assistant" ? (
                              <AssistantMessage>
                                {message.thinking && (
                                  <details className="thinking-panel">
                                    <summary>查看模型思考过程</summary>
                                    <p>{message.thinking}</p>
                                  </details>
                                )}
                                <AssistantMarkdown content={message.content} />
                                {index === messages.length - 1 &&
                                  !activeRunId &&
                                  currentSession?.scope === "MERCHANT" && (
                                    <section className="reply-next-steps" aria-label="回复后的下一步">
                                      <strong>接下来怎么做</strong>
                                      <p>
                                        {currentSession.researchScope
                                          ? "先核对报告里的来源与缺口，再直接说“按建议写一篇”，继续在这里改文案、配图、审核和下载。"
                                          : "直接说“写一篇”“改文案”或“生成一张封面”。创作、费用确认、审核和下载都可以在这段聊天完成。"}
                                      </p>
                                      <div className="prompt-actions">
                                        <button
                                          type="button"
                                          disabled={currentSession.lifecycleStatus !== "ACTIVE"}
                                          onClick={() => navigate(`/sessions/${sessionId}?studio=1`)}
                                        >
                                          进入选题与图文制作
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => navigate(`/merchants/${currentSession.ownerId}`)}
                                        >
                                          补充商家资料
                                        </button>
                                        <button type="button" onClick={() => openSessionTool("content")}>
                                          打开素材与审核
                                        </button>
                                      </div>
                                      <p className="muted">可以继续对话完成；下方会显示真实结果和需要你确认的卡片。</p>
                                    </section>
                                  )}
                              </AssistantMessage>
                            ) : (
                              <>
                                <div className="speaker">你</div>
                                <div className="bubble-content">{message.content}</div>
                              </>
                            )}
                          </article>
                        ) : null,
                      )}
                      {sessionId && (
                        <ChatPublicationResults
                          key={sessionId}
                          sessionId={sessionId}
                          onProgress={() => {
                            if (stickToBottom.current)
                              timeline.current?.scrollTo({ top: timeline.current.scrollHeight });
                          }}
                          disabled={sending || Boolean(activeRunId) || currentSession?.lifecycleStatus !== "ACTIVE"}
                        />
                      )}
                      {(thinkingStream ||
                        stream ||
                        toolEvents.length > 0 ||
                        pendingQuestions.length > 0 ||
                        delegationRecords.length > 0 ||
                        runStatus === "运行中" ||
                        runStatus === "排队中") && (
                        <article className="bubble assistant live-assistant">
                          <AssistantMessage status={activeRunId ? runStatus : undefined}>
                            {thinkingStream && (
                              <div className="thinking-panel live">
                                <strong>模型思考中</strong>
                                <p>
                                  {thinkingStream}
                                  <span className="typing-cursor" />
                                </p>
                              </div>
                            )}
                            {toolEvents
                              .filter((event) => event.type === "session.tool.started" && !event.payload.delegationId)
                              .map((event) => (
                                <ToolActivity key={event.eventId} started={event} events={toolEvents} />
                              ))}
                            {toolEvents
                              .filter((event) => event.type === "session.delegation.started")
                              .map((event) => {
                                const finished = toolEvents.find(
                                  (item) =>
                                    item.type === "session.delegation.finished" &&
                                    item.payload.delegationId === event.payload.delegationId,
                                );
                                return (
                                  <DelegationActivity
                                    key={event.eventId}
                                    started={event}
                                    finished={finished}
                                    events={toolEvents}
                                  />
                                );
                              })}
                            {pendingQuestions
                              .filter(
                                (record) =>
                                  !toolEvents.some(
                                    (event) =>
                                      event.type === "session.delegation.started" &&
                                      event.payload.delegationId === record.delegationId,
                                  ),
                              )
                              .map((record) => (
                                <PendingDelegationQuestion
                                  key={record.delegationId}
                                  record={record}
                                  onAnswered={(answered) =>
                                    setPendingQuestions((current) =>
                                      current.filter((item) => item.delegationId !== answered.delegationId),
                                    )
                                  }
                                />
                              ))}
                            {delegationRecords
                              .filter(
                                (record) =>
                                  ["SUCCEEDED", "FAILED", "CANCELLED"].includes(record.status) &&
                                  !toolEvents.some(
                                    (event) =>
                                      event.type === "session.delegation.started" &&
                                      event.payload.delegationId === record.delegationId,
                                  ),
                              )
                              .map((record) => (
                                <details className="delegation-card" key={record.delegationId}>
                                  <summary>
                                    已保存专家任务 · {record.targetExpertId} · {runStatusLabel(record.status)}
                                  </summary>
                                  <p>
                                    任务键：{record.taskKey}；交付：{record.parentAckAt ? "已确认" : "待确认"}
                                  </p>
                                  {record.result && (
                                    <pre>
                                      {"version" in record.result
                                        ? record.result.output.content
                                        : record.result.finalText}
                                    </pre>
                                  )}
                                  {record.errorCode && <p>{record.errorCode}</p>}
                                </details>
                              ))}
                            {toolEvents
                              .filter((event) => event.type === "session.compaction.started")
                              .map((event) => {
                                const finished = toolEvents.find(
                                  (item) => item.type === "session.compaction.finished" && item.seq > event.seq,
                                );
                                return (
                                  <div className="run-placeholder" key={event.eventId}>
                                    上下文压缩：
                                    {finished ? (finished.payload.status === "READY" ? "已完成" : "失败") : "进行中"}
                                    {finished?.payload.reason === "overflow" ? "（上下文溢出）" : ""}
                                  </div>
                                );
                              })}
                            {toolEvents
                              .filter((event) => event.type === "session.microcompact.completed")
                              .map((event) => (
                                <div className="run-placeholder" key={event.eventId}>
                                  {event.payload.delegationId ? "专家" : ""}工具正文清理：
                                  {String(event.payload.clearedResults)} 项， 预计减少{" "}
                                  {String(event.payload.estimatedTokensSaved)} token。
                                  {event.payload.delegationId
                                    ? "记录属于本次专家尝试。"
                                    : runStatus === "已完成"
                                      ? "已随本轮结果保留。"
                                      : runStatus === "失败" || runStatus === "已取消"
                                        ? "本轮未提交，仍使用上次成功历史。"
                                        : "本轮成功后保留。"}
                                </div>
                              ))}
                            {toolEvents
                              .filter((event) => event.type === "session.context.compressed")
                              .map((event) => (
                                <ContextCompressionLog key={event.eventId} event={event} />
                              ))}
                            {stream && <AssistantMarkdown content={stream} streaming />}
                            {(runStatus === "运行中" || runStatus === "排队中") && !stream && !thinkingStream && (
                              <div className="run-placeholder">
                                <span className="loading-dots" />
                                {runStatus === "运行中" ? "织伴正在处理请求…" : "消息已受理，等待运行…"}
                              </div>
                            )}
                          </AssistantMessage>
                        </article>
                      )}
                    </section>
                    <div className="composer-wrap">
                      <form className="composer" onSubmit={(event) => void submit(event)}>
                        {continueFromRunId && !activeRunId && currentSession?.lifecycleStatus === "ACTIVE" && (
                          <div className="composer-continuation">
                            <span>已停止执行。补充或纠正信息后，可继续上一任务；参考文件请核对本轮勾选。</span>
                            <button
                              type="button"
                              className="outline-button"
                              disabled={sending}
                              onClick={() => setContinueFromRunId(null)}
                            >
                              开始新任务
                            </button>
                          </div>
                        )}
                        <input
                          ref={fileInput}
                          type="file"
                          accept=".txt,.md,.markdown,.csv,.json,text/plain,image/png,image/jpeg,image/webp"
                          hidden
                          aria-label="选择文本文件"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.currentTarget.value = "";
                            void uploadReferenceFile(file);
                          }}
                        />
                        <textarea
                          aria-label="消息内容"
                          ref={composerInput}
                          value={draft}
                          onChange={(event) => {
                            setDraft(event.target.value);
                            if (sessionId) sessionStorage.setItem(sessionDraftKey(sessionId), event.target.value);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                              event.preventDefault();
                              event.currentTarget.form?.requestSubmit();
                            }
                          }}
                          placeholder={
                            !isModelReady
                              ? "配置文本模型后可开始对话"
                              : continueFromRunId
                                ? "补充或纠正信息，将结合原任务继续执行…"
                                : "描述目标、补充要求，或提出问题…"
                          }
                          disabled={!isModelReady || currentSession?.lifecycleStatus === "ARCHIVED"}
                        />
                        <div className="composer-footer">
                          <div className="composer-tools">
                            <button type="button" className="outline-button" onClick={() => navigate("/experts")}>
                              <Icon name="users" size={14} />
                              运营统筹
                            </button>
                            <ModelPicker model={model} />
                            <button
                              type="button"
                              className="outline-button"
                              disabled={uploading || currentSession?.lifecycleStatus === "ARCHIVED"}
                              onClick={() => fileInput.current?.click()}
                            >
                              {uploading ? "上传中…" : "＋ 文字/图片参考"}
                            </button>
                            <span>
                              {runStatus || "本机会话 · Pi SDK"}{" "}
                              <span className="composer-hint">· Enter 发送，Shift+Enter 换行</span>
                            </span>
                          </div>
                          <button
                            className="primary-button"
                            disabled={
                              !isModelReady ||
                              !draft.trim() ||
                              sending ||
                              Boolean(activeRunId) ||
                              currentSession?.lifecycleStatus === "ARCHIVED"
                            }
                            type="submit"
                          >
                            {activeRunId
                              ? runStatus === "取消中"
                                ? "停止中…"
                                : "执行中…"
                              : continueFromRunId
                                ? "补充并继续"
                                : "发送"}{" "}
                            ↗
                          </button>
                        </div>
                      </form>
                      <p className="composer-note">
                        文字参考不超过 2 MB；PNG/JPEG/WebP 图片不超过 8 MB，需启用视觉模型才能分析画面。
                      </p>
                    </div>
                  </div>
                </div>
              </>
            )}
          </main>
          {(inspectorOpen || page === "chat") && (
            <aside
              className="context-panel"
              hidden={!inspectorOpen || isStudio || page !== "chat"}
              aria-label="会话辅助工作区"
            >
              <div className="inspector-head">
                <h2>{page === "chat" ? "会话工作区" : "工作台状态"}</h2>
                <button type="button" onClick={() => setInspectorOpen(false)}>
                  收起
                </button>
              </div>
              {page === "chat" ? (
                <>
                  <div className="inspector-tabs" role="tablist" aria-label="会话辅助工具">
                    {(
                      [
                        ["research", "研究与选题"],
                        ["content", "素材审核"],
                        ["image", "图片"],
                        ["overview", "详情"],
                      ] as const
                    ).map(([tool, label]) => (
                      <button
                        type="button"
                        role="tab"
                        key={tool}
                        id={`tool-tab-${tool}`}
                        aria-selected={sessionTool === tool}
                        aria-controls={`tool-panel-${tool}`}
                        className={sessionTool === tool ? "selected" : ""}
                        onClick={() => setSessionTool(tool)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div
                    role="tabpanel"
                    id="tool-panel-research"
                    aria-labelledby="tool-tab-research"
                    hidden={sessionTool !== "research"}
                  >
                    <div className="side-block">
                      <h3>从报告到创作</h3>
                      <p>1. 阅读报告与来源缺口；有候选时可编辑采用。</p>
                      <p>2. 有可用研究时生成选题，选择一张卡片“用此选题创作”。</p>
                      <p>3. 正文完成后进入素材审核，修改并审核下载。</p>
                      <p>只有聊天文字选题时，可回到输入框填写编号或标题继续；不会自动生成选题卡。</p>
                    </div>
                    {(xhsTargetUrl || xhsLogin?.status === "AWAITING_LOGIN" || xhsLogin?.status === "VERIFYING") && (
                      <div className="info-banner xhs-login-banner">
                        <div>
                          <strong>小红书本机授权</strong>
                          <p>
                            {xhsLogin?.status === "AWAITING_LOGIN"
                              ? "请在打开的本机 Chrome 中登录。完成后回到这里确认，工作台会检查目标页并继续采集。"
                              : xhsLogin?.status === "VERIFYING"
                                ? "正在检查目标页是否可读…"
                                : xhsLogin?.status === "READY"
                                  ? xhsResumePending
                                    ? "登录已确认，原请求保留；等当前运行结束后继续采集，也可以点击重试。"
                                    : "当前会话已有已验证的授权资料目录；采集将使用该登录态。"
                                  : "如果公开页面需要登录，可在本机 Chrome 中授权当前会话。"}
                          </p>
                        </div>
                        <div className="xhs-login-actions">
                          {xhsLogin?.status === "READY" && xhsResumePending && (
                            <button
                              type="button"
                              className="primary-button compact"
                              disabled={xhsLoginBusy || !!activeRunId || sending}
                              onClick={() => void confirmXhsLogin()}
                            >
                              继续原采集请求
                            </button>
                          )}
                          {xhsLogin?.status === "AWAITING_LOGIN" ? (
                            <>
                              <button
                                type="button"
                                className="primary-button compact"
                                disabled={xhsLoginBusy}
                                onClick={() => void confirmXhsLogin()}
                              >
                                {xhsLoginBusy ? "检查中…" : "已登录，继续采集"}
                              </button>
                              <button
                                type="button"
                                className="outline-button"
                                disabled={xhsLoginBusy}
                                onClick={() => void cancelXhsLogin()}
                              >
                                取消
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="outline-button"
                              disabled={!xhsTargetUrl || xhsLoginBusy}
                              onClick={() => void startXhsLogin()}
                            >
                              {xhsLoginBusy
                                ? "正在打开…"
                                : xhsLogin?.status === "READY"
                                  ? "重新登录"
                                  : "打开 Chrome 登录"}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                    {sessionId && currentSession?.scope === "MERCHANT" && (
                      <ResearchPanel
                        defaultOpen
                        key={`research:${sessionId}`}
                        merchantId={currentSession.ownerId}
                        sessionId={sessionId}
                        refreshKey={`${messages.length}:${runStatus}`}
                        researchScope={currentSession.researchScope}
                        modelConfigured={model?.configured === true}
                        imageInputEnabled={model?.imageInput === true}
                        sessionWritable={currentSession.lifecycleStatus === "ACTIVE"}
                        retryDisabled={
                          !model?.configured ||
                          !lastUserMessage ||
                          !!activeRunId ||
                          sending ||
                          currentSession.lifecycleStatus !== "ACTIVE"
                        }
                        onRetry={
                          currentSession.researchScope
                            ? () =>
                                sendContent(
                                  `请按本会话冻结的商家研究范围重新研究。先核对商家资料和本次重点，再重新采集可用证据；保留原失败记录。请调用 merchant_research_save 保存结构化候选或来源缺口，不代替我采用。上次请求中的链接仍由我明确提供：\n${lastUserMessage?.content ?? ""}`,
                                )
                            : undefined
                        }
                      />
                    )}

                    {currentSession?.scope !== "MERCHANT" && (
                      <p className="muted">关联商家后可查看研究与选题；当前仍可在聊天中提供链接和资料。</p>
                    )}
                  </div>
                  <div
                    role="tabpanel"
                    id="tool-panel-content"
                    aria-labelledby="tool-tab-content"
                    hidden={sessionTool !== "content"}
                  >
                    {sessionId && (
                      <ContentDraftPanel
                        defaultOpen
                        key={`content:${sessionId}`}
                        sessionId={sessionId}
                        messages={messages}
                        merchantId={currentSession?.scope === "MERCHANT" ? currentSession.ownerId : null}
                        modelConfigured={model?.configured === true}
                      />
                    )}
                  </div>
                  <div
                    role="tabpanel"
                    id="tool-panel-image"
                    aria-labelledby="tool-tab-image"
                    hidden={sessionTool !== "image"}
                  >
                    {sessionId && (
                      <ImageGenerationPanel
                        defaultOpen
                        key={`image:${sessionId}`}
                        sessionId={sessionId}
                        uploads={artifacts}
                        provider={providers.image ?? "unconfigured"}
                      />
                    )}
                  </div>
                  <div
                    role="tabpanel"
                    id="tool-panel-overview"
                    aria-labelledby="tool-tab-overview"
                    hidden={sessionTool !== "overview"}
                  >
                    {currentSession?.scope === "MERCHANT" && (
                      <div className="info-banner">
                        <div>
                          <strong>
                            {currentSession.lifecycleStatus === "ARCHIVED"
                              ? "此会话已归档，恢复后可继续发送"
                              : "商家记忆"}
                          </strong>
                          <p>
                            输入“记住：……”可保存长期规则。点击归档即允许本会话文字摘要用于该商家后续会话；总结另行执行，附件原件不会因此开放。归档总结与候选确认可在商家页查看。
                          </p>
                          {memoryNotice && <p role="status">{memoryNotice}</p>}
                        </div>
                      </div>
                    )}
                    <div className="side-block">
                      <h3>当前范围</h3>
                      <strong>
                        {currentSession?.scope === "MERCHANT" ? currentMerchantName || "已关联商家" : "未关联商家"}
                      </strong>
                      <p>
                        {currentSession?.scope === "MERCHANT"
                          ? "每轮消息使用受理时冻结的商家档案与链接。"
                          : "可先采集公开证据并诊断账号；需要档案时再关联商家。"}
                      </p>
                    </div>
                    <div className="side-block">
                      <h3>最近运行</h3>
                      <span className={statusClass(runStatus || "待开始")}>{runStatus || "待开始"}</span>
                      <p>{connected ? "实时事件连接已建立。" : "正在连接事件流；历史消息会在恢复后补齐。"}</p>
                    </div>
                    <div className="side-block">
                      <h3>使用的模型</h3>
                      <strong>{currentSession?.modelAlias || model?.alias || "待配置"}</strong>
                      <p>由 Pi SDK 管理本轮模型会话。</p>
                    </div>
                    <div className="side-block">
                      <h3>会话记录</h3>
                      <strong>{messages.length} 条消息</strong>
                      <p>最近活动：{currentSession ? activityTime(currentSession.updatedAt) : "暂无"}</p>
                    </div>
                    {sessionId && (
                      <PromptSnapshotPanel
                        key={sessionId}
                        sessionId={sessionId}
                        messages={messages}
                        activeRunId={activeRunId}
                      />
                    )}
                    <ContextTokenPanel measurement={contextTokens} working={Boolean(activeRunId)} />
                    <div className="side-block">
                      <h3>已上传文件</h3>
                      {artifacts.length ? (
                        <ul className="artifact-list">
                          {artifacts.map((artifact) => (
                            <li key={artifact.artifactId}>
                              <label>
                                <input
                                  type="checkbox"
                                  checked={selectedArtifactIds.includes(artifact.artifactId)}
                                  disabled={
                                    artifact.status !== "READY" ||
                                    sending ||
                                    (selectedArtifactIds.length >= 50 &&
                                      !selectedArtifactIds.includes(artifact.artifactId))
                                  }
                                  onChange={(event) =>
                                    setSelectedArtifactIds((current) =>
                                      event.target.checked
                                        ? [...current, artifact.artifactId]
                                        : current.filter((id) => id !== artifact.artifactId),
                                    )
                                  }
                                />
                                <span>{artifact.title}</span>
                              </label>
                              <small>
                                {artifact.mimeType === "text/plain"
                                  ? "可供 Agent 读取"
                                  : artifact.mimeType.startsWith("image/")
                                    ? model?.imageInput
                                      ? "选入本轮后发送给视觉模型"
                                      : "需启用视觉模型"
                                    : "暂不支持解析"}
                              </small>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p>当前会话还没有文件。</p>
                      )}
                      <p>本轮已选 {selectedArtifactIds.length} 个文件；正文由 Agent 按需读取。</p>
                      <p>
                        最近 Run：已授权{" "}
                        {typeof contextSummary?.authorizedAttachmentCount === "number"
                          ? contextSummary.authorizedAttachmentCount
                          : "待解析"}{" "}
                        个，已列索引{" "}
                        {typeof contextSummary?.indexedAttachmentCount === "number"
                          ? contextSummary.indexedAttachmentCount
                          : "待解析"}{" "}
                        个，成功读取 {contextSummary ? attachmentReadCount : "待解析"} 次。
                      </p>
                      {typeof contextSummary?.omittedAttachmentCount === "number" &&
                        contextSummary.omittedAttachmentCount > 0 && (
                          <p>
                            另有 {contextSummary.omittedAttachmentCount} 个文件未列入索引
                            {contextSummary.attachmentIndexOmissionReason === "INDEX_LIMIT"
                              ? "（超过索引上限）"
                              : "（旧版运行）"}
                            。
                          </p>
                        )}
                      {checkpoints.length > 0 && (
                        <details>
                          <summary>长对话压缩记录（{checkpoints.length}）</summary>
                          {checkpoints.map((checkpoint) => (
                            <details key={checkpoint.checkpointId}>
                              <summary>
                                {checkpoint.reason === "overflow" ? "溢出恢复" : "阈值压缩"} · {checkpoint.status} ·{" "}
                                {checkpoint.createdAt}
                              </summary>
                              <p>
                                来源快照：{checkpoint.sourceSnapshotHash?.slice(0, 16) ?? "初始会话"}；保留边界：
                                {checkpoint.firstKeptEntryId ?? "未生成"}
                              </p>
                              <p>
                                锚点消息：{checkpoint.anchorMessageId ?? "未知"}；商家资料：
                                {checkpoint.merchantSnapshotId ?? "未关联"}；摘要策略：
                                {checkpoint.summaryTemplateVersion}
                              </p>
                              <p>
                                摘要哈希：{checkpoint.summaryHash?.slice(0, 16) ?? "未生成"}；提交快照：
                                {checkpoint.finalSnapshotHash?.slice(0, 16) ?? "未提交"}
                              </p>
                              {checkpoint.summary && <pre>{checkpoint.summary}</pre>}
                              {checkpoint.errorMessage && <p>{checkpoint.errorMessage}</p>}
                            </details>
                          ))}
                        </details>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="side-block">
                    <h3>本地服务</h3>
                    <div className="metric-line">
                      <span>Host</span>
                      <strong>{hostOnline === null ? "检查中" : hostOnline ? "正常" : "连接中断"}</strong>
                    </div>
                    <div className="metric-line">
                      <span>文本模型</span>
                      <strong>{isModelReady ? "已就绪" : "待配置"}</strong>
                    </div>
                    <div className="metric-line">
                      <span>会话</span>
                      <strong>{sessions.length} 个</strong>
                    </div>
                  </div>
                  <div className="side-note">
                    {isModelReady ? `当前模型：${model?.alias}` : "前往设置查看文本模型配置说明。"}
                  </div>
                  <div className="side-block">
                    <h3>即将接入</h3>
                    <p>产物和自动化等页面会随对应后端能力逐步开放。</p>
                  </div>
                </>
              )}
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}

/** 装配工作台顶层路由和页面入口。 */
function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Workbench />} />
        <Route path="/sessions" element={<Workbench />} />
        <Route path="/sessions/:sessionId" element={<Workbench />} />
        <Route path="/merchants" element={<Workbench />} />
        <Route path="/merchants/:merchantId" element={<Workbench />} />
        <Route path="/merchants/:merchantId/sessions/:sessionId" element={<Workbench />} />
        <Route path="/settings" element={<Workbench />} />
        <Route path="/products" element={<Workbench />} />
        <Route path="/experts" element={<Workbench />} />
        <Route path="/skills" element={<Workbench />} />
      </Routes>
    </BrowserRouter>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("缺少工作台根节点");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
