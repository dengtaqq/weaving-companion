import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { TextGenerationJobRecord } from "../../../../shared/contracts.js";
import type { DbClient } from "../../../infrastructure/sqlite/db-client.js";

export type PublicationToolStore = Pick<
  DbClient,
  | "readTaskHistory"
  | "getRun"
  | "getRunPlan"
  | "listTextGenerationJobs"
  | "listContentDrafts"
  | "getPublication"
  | "getPublicationReviews"
  | "createPublicationConversation"
>;
const schema = Type.Object({
  operation: Type.Union([Type.Literal("SUBMIT"), Type.Literal("STATUS")]),
  instruction: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  draftId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  newDraft: Type.Optional(Type.Boolean()),
});

const historySchema = Type.Object({
  ...schema.properties,
  operation: Type.Union([Type.Literal("SUBMIT"), Type.Literal("STATUS"), Type.Literal("READ_INPUT")]),
  jobId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  section: Type.Optional(Type.Union([Type.Literal("INPUT"), Type.Literal("RESULT")])),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12000 })),
});

/** 将普通聊天请求交给同一持久任务链，不允许模型批准费用或导出。 */
export function createPublicationTool(
  store: PublicationToolStore,
  sessionId: string,
  runId: string,
  modelId: string,
  imageModelId: string | null,
  historyReadEnabled = false,
): ToolDefinition {
  /** 返回真实执行状态和当前稿件，受理回执不能被描述为已生成。 */
  async function result(job: TextGenerationJobRecord | undefined, draftId?: string) {
    const target = draftId ?? job?.source?.workflow?.draftId ?? job?.resultDraftId ?? undefined;
    const publication = target ? await store.getPublication(sessionId, target) : null;
    const reviews = target ? await store.getPublicationReviews(sessionId, target) : null;
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            imageProvider: imageModelId ?? "unconfigured",
            imageRequestSpec: {
              width: 1280,
              height: 1920,
              aspectRatio: "2:3",
              imageCountPerConfirmation: 1,
              priceQuote: null,
            },
            jobId: job?.jobId ?? null,
            status: job?.status ?? null,
            workflow: job?.source?.workflow ?? null,
            publication,
            reviews,
            notice:
              "提交仅表示受理。后台继续执行，结果与确认卡在当前聊天显示。费用和最终确认必须由用户点击卡片。卡片列出服务、张数、尺寸与计费规则，本工具不提供金额报价，不承诺列出金额。尺寸是1280×1920（2:3），不要编造3:4。不要转去工作台、只交提示词或宣称已出图。",
          }),
        },
      ],
      details: { risk: "write", scope: "session", jobId: job?.jobId ?? null },
    };
  }
  return {
    name: "publication_task",
    label: "创作与修改图文",
    description:
      (historyReadEnabled
        ? "READ_INPUT按jobId与section=INPUT/RESULT分段回读本会话原任务/结果，offset/limit控制区间，有nextOffset须继续；这不是重新执行。"
        : "") +
      "在当前聊天创建或修改一篇图文、生成图片、按当前图片改图、审核和准备发布包。SUBMIT忠实提交用户完整要求，只要文案时不追加封面规划、配图、审核或整套交付，自动延续当前篇；明确另写一篇才newDraft=true。STATUS读取真实稿件和执行状态。后台异步执行，用户在聊天内确认费用后才出图，最终确认后才导出。聊天中已有文案可作为参考创建受管稿件。受理后只简短告知提交与后续卡片，不轮询、不另交未保存正文或仅交付提示词；用户要求查进度、核对内容或回执时用STATUS，真实成品返回后才引用正文和图片。内部任务没有此工具时按原合同完成，不重复发起编排。",
    parameters: historyReadEnabled ? historySchema : schema,
    /** 固定当前 Run 与会话，并让同一轮重复调用返回原任务。 */
    async execute(_toolCallId, params: Static<typeof historySchema>, signal) {
      if (signal?.aborted) throw new Error("TOOL_ABORTED");
      const run = await store.getRun(runId);
      const plan = await store.getRunPlan(runId);
      if (
        run?.sessionId !== sessionId ||
        run.status !== "RUNNING" ||
        !plan?.policy.allowedToolIds.includes("publication_task")
      )
        throw new Error("TOOL_PUBLICATION_NOT_ALLOWED");
      if (params.operation === "READ_INPUT") {
        if (!historyReadEnabled || plan.executionPolicy?.history !== "MAIN" || !params.jobId)
          throw new Error("TASK_HISTORY_NOT_ALLOWED");
        const record = await store.readTaskHistory(
          sessionId,
          params.jobId,
          params.section ?? "INPUT",
          params.offset ?? 0,
          params.limit ?? 6000,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(record) }],
          details: { risk: "read", scope: "session", jobId: params.jobId },
        };
      }
      const jobs = (await store.listTextGenerationJobs(sessionId)).filter((job) => job.purpose === "PUBLICATION_CHAT");
      const prior = jobs.find((job) => job.source?.originRunId === runId);
      if (params.operation === "SUBMIT" && prior) return result(prior);
      const latest = jobs[0];
      const drafts = await store.listContentDrafts(sessionId);
      const draftId = params.newDraft
        ? undefined
        : (params.draftId ?? latest?.source?.workflow?.draftId ?? drafts[0]?.draftId);
      if (params.operation === "STATUS") return result(latest, draftId);
      if (!params.instruction?.trim()) throw new Error("PUBLICATION_INPUT_INVALID");
      const current = draftId ? await store.getPublication(sessionId, draftId) : null;
      const job = await store.createPublicationConversation(
        sessionId,
        {
          message: params.instruction.trim(),
          originRunId: runId,
          ...(!params.newDraft && !current && latest ? { rootJobId: latest.jobId } : {}),
          ...(current && {
            draftId: current.draft.draftId,
            draftRevision: current.draft.currentRevision,
            publicationRevision: current.publication.revision,
          }),
        },
        modelId,
        imageModelId,
        `chat-tool:${runId}`,
      );
      return result(job);
    },
  };
}
