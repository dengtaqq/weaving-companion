import AjvModule from "ajv/dist/2020.js";
import { Type } from "typebox";
import type { DelegationTaskV2 } from "../../../shared/contracts.js";
import type { AgentMaterialRef, ExpertSubmissionV3, ExpertTaskV3 } from "../../../shared/expert-contract.js";
import {
  publicationPlanSchema,
  publicationReviewSchema,
  publicationReviewV2Schema,
  publicationReviewV3Schema,
} from "../../../shared/publication.js";
import { publicationRepairSchema } from "../../../shared/publication-repair.js";
import { contentOutputSchema } from "../../modules/publication/domain/content-output.js";
import { canonicalJson } from "../execution/runtime-plan.js";

export const agentMaterialRefSchema = Type.Object(
  {
    kind: Type.Union(
      ["uploaded_text", "public_evidence", "content_draft", "artifact", "expert_result"].map((kind) =>
        Type.Literal(kind),
      ),
    ),
    id: Type.String({ minLength: 1, maxLength: 100 }),
    revision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  },
  { additionalProperties: false },
);
const text = Type.String({ minLength: 1, maxLength: 1000, pattern: "\\S" });
const criteria = Type.Array(
  Type.Object({ id: Type.String({ minLength: 1, maxLength: 40 }), text }, { additionalProperties: false }),
  { minItems: 1, maxItems: 20 },
);
export const expertTaskV3Schema = Type.Object(
  {
    version: Type.Literal(3),
    executionMode: Type.Optional(Type.Union([Type.Literal("dependent"), Type.Literal("background")])),
    taskKey: Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$" }),
    targetExpertId: Type.Union([
      Type.Literal("writer"),
      Type.Literal("visual"),
      Type.Literal("reviewer"),
      Type.Literal("researcher"),
    ]),
    task: Type.String({ minLength: 1, maxLength: 8000 }),
    criteria,
    inputRefs: Type.Array(agentMaterialRefSchema, { maxItems: 20 }),
    contextSummary: Type.Union([Type.String({ minLength: 1, maxLength: 4000 }), Type.Null()]),
    missingInformation: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 10 }),
    contractId: Type.String({ minLength: 1, maxLength: 80 }),
    contractVersion: Type.Literal(1),
    payload: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);
export const expertSubmissionV3Schema = Type.Object(
  {
    version: Type.Literal(3),
    summary: Type.String({ minLength: 1, maxLength: 3000, pattern: "\\S" }),
    outcome: Type.Union([Type.Literal("READY"), Type.Literal("PARTIAL"), Type.Literal("NEEDS_INPUT")], {
      description:
        "READY表示本次任务已完整完成，questions和unmetCriterionIds必须为[]；必须回答问题才能继续时用NEEDS_INPUT。",
    }),
    structuredResult: Type.Record(Type.String(), Type.Unknown()),
    materialRefs: Type.Array(agentMaterialRefSchema, { maxItems: 20 }),
    unmetCriterionIds: Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 20, uniqueItems: true }),
    questions: Type.Array(
      Type.Object({ id: Type.String({ minLength: 1, maxLength: 40 }), text }, { additionalProperties: false }),
      {
        maxItems: 10,
        description: "阻塞本次交付的问题；READY必须为[]。不阻塞的后续建议放summary或契约允许的内部说明。",
      },
    ),
  },
  { additionalProperties: false },
);

const contracts = {
  researcher: {
    id: "researcher.report.v1",
    input: Type.Object(
      {
        questions: Type.Optional(Type.Array(text, { maxItems: 12 })),
        requiredToolIds: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 12, uniqueItems: true }),
        ),
        focusAreas: Type.Optional(
          Type.Array(
            Type.Union([Type.Literal("TOPIC_SAMPLES"), Type.Literal("COPY_STYLE"), Type.Literal("IMAGE_STYLE")]),
            { maxItems: 3, uniqueItems: true },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    output: Type.Object(
      {
        summary: Type.String({ minLength: 1, maxLength: 3000, pattern: "\\S" }),
        findings: Type.Array(
          Type.Object(
            {
              kind: Type.Union([Type.Literal("OBSERVATION"), Type.Literal("INFERENCE")]),
              area: Type.Optional(
                Type.Union([
                  Type.Literal("TOPIC_SAMPLES"),
                  Type.Literal("COPY_STYLE"),
                  Type.Literal("IMAGE_STYLE"),
                  Type.Literal("OTHER"),
                ]),
              ),
              point: text,
              evidenceIds: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
                minItems: 1,
                maxItems: 20,
                uniqueItems: true,
              }),
            },
            { additionalProperties: false },
          ),
          { maxItems: 24 },
        ),
        recommendations: Type.Array(text, { maxItems: 20 }),
        unknowns: Type.Array(text, { maxItems: 20 }),
      },
      { additionalProperties: false },
    ),
  },
  writer: {
    id: "writer.text.v1",
    input: Type.Object({ channel: Type.Optional(text), tone: Type.Optional(text) }, { additionalProperties: false }),
    output: Type.Object(
      {
        title: Type.String({ minLength: 1, maxLength: 120, pattern: "\\S" }),
        body: Type.String({ minLength: 1, maxLength: 30000, pattern: "\\S" }),
        internalNotes: Type.String({ maxLength: 3000 }),
      },
      { additionalProperties: false },
    ),
  },
  visual: {
    id: "visual.report.v1",
    input: Type.Object(
      {
        aspectRatio: Type.Optional(Type.Literal("2:3")),
        imageCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 9 })),
      },
      { additionalProperties: false },
    ),
    output: Type.Object(
      {
        summary: Type.String({ minLength: 1, maxLength: 3000, pattern: "\\S" }),
        recommendations: Type.Array(text, { minItems: 1, maxItems: 20 }),
      },
      { additionalProperties: false },
    ),
  },
  reviewer: {
    id: "reviewer.report.v1",
    input: Type.Object({ focus: Type.Optional(Type.Array(text, { maxItems: 10 })) }, { additionalProperties: false }),
    output: Type.Object(
      {
        verdict: Type.Union([Type.Literal("PASS"), Type.Literal("CHANGES_REQUIRED"), Type.Literal("LIMITED")]),
        summary: Type.String({ minLength: 1, maxLength: 3000, pattern: "\\S" }),
        issues: Type.Array(text, { maxItems: 40 }),
      },
      { additionalProperties: false },
    ),
  },
};
const publicationContracts = {
  "writer.patch.v1": {
    role: "writer",
    id: "writer.patch.v1",
    input: contracts.writer.input,
    output: publicationRepairSchema,
  },
  "visual.patch.v1": {
    role: "visual",
    id: "visual.patch.v1",
    input: contracts.visual.input,
    output: publicationRepairSchema,
  },
  "reviewer.publication.v3": {
    role: "reviewer",
    id: "reviewer.publication.v3",
    input: contracts.reviewer.input,
    output: publicationReviewV3Schema,
  },
  "writer.publication.v1": {
    role: "writer",
    id: "writer.publication.v1",
    input: contracts.writer.input,
    output: contentOutputSchema,
  },
  "visual.publication.v1": {
    role: "visual",
    id: "visual.publication.v1",
    input: contracts.visual.input,
    output: publicationPlanSchema,
  },
  "reviewer.publication.v1": {
    role: "reviewer",
    id: "reviewer.publication.v1",
    input: contracts.reviewer.input,
    output: publicationReviewSchema,
  },
  "reviewer.publication.v2": {
    role: "reviewer",
    id: "reviewer.publication.v2",
    input: contracts.reviewer.input,
    output: publicationReviewV2Schema,
  },
};
const ajv = new AjvModule.default();
const validateTask = ajv.compile<ExpertTaskV3>(expertTaskV3Schema);
const validateSubmission = ajv.compile<ExpertSubmissionV3>(expertSubmissionV3Schema);
const validators = Object.fromEntries(
  [...Object.values(contracts), ...Object.values(publicationContracts)].map((contract) => [
    contract.id,
    { input: ajv.compile(contract.input), output: ajv.compile(contract.output) },
  ]),
);

interface ExpertFewShotExample {
  payload: Record<string, unknown>;
  structuredResult: Record<string, unknown>;
}

/** 每类专家契约提供两个输入与结构化结果示例，帮助模型理解字段语义和边界。 */
const fewShotExamples: Record<string, ExpertFewShotExample[]> = {
  "researcher.report.v1": [
    {
      payload: { questions: ["样本中常见的午间饮品场景是什么？"], focusAreas: ["TOPIC_SAMPLES"] },
      structuredResult: {
        summary: "示例：本组样本集中在工作日午间饮品场景。",
        findings: [
          {
            kind: "OBSERVATION",
            area: "TOPIC_SAMPLES",
            point: "示例观察：已采集样本出现了上班族午休饮品场景。",
            evidenceIds: ["example_evidence_1"],
          },
        ],
        recommendations: ["示例建议：可进一步核对商家是否适合突出午间场景。"],
        unknowns: ["示例未知：当前样本不能说明该场景在全平台的热度。"],
      },
    },
    {
      payload: { questions: ["参考文案有哪些表达特点？"], focusAreas: ["COPY_STYLE"] },
      structuredResult: {
        summary: "示例：参考文案多用具体体验描述，少用夸张承诺。",
        findings: [
          {
            kind: "INFERENCE",
            area: "COPY_STYLE",
            point: "示例推断：短句和具体感受可能是该组文案的常见写法。",
            evidenceIds: ["example_evidence_2"],
          },
        ],
        recommendations: ["示例建议：写稿时可尝试具体描述口感，再由审核核实事实依据。"],
        unknowns: ["示例未知：样本不足以代表账号全部历史文案。"],
      },
    },
  ],
  "writer.text.v1": [
    {
      payload: { channel: "小红书", tone: "自然、克制" },
      structuredResult: {
        title: "午间的一杯燕麦香",
        body: "午休时，给自己留一点慢下来的时间。燕麦的香气配上一杯拿铁，让下午的节奏从容一些。",
        internalNotes: "示例文案；发布前仍需核对商家实际商品与服务信息。",
      },
    },
    {
      payload: { channel: "公众号", tone: "清晰、亲切" },
      structuredResult: {
        title: "把早餐时间留给一杯拿铁",
        body: "早上经过门店时，可以带上一杯拿铁开启新的一天。具体口味和供应情况以门店信息为准。",
        internalNotes: "示例文案；不包含未经核实的价格或优惠。",
      },
    },
  ],
  "visual.report.v1": [
    {
      payload: { aspectRatio: "2:3", imageCount: 1 },
      structuredResult: {
        summary: "示例：为单张封面规划清晰的饮品主体和留白区域。",
        recommendations: ["示例建议：使用实物照片时保留饮品真实外观，不额外添加未确认的促销信息。"],
      },
    },
    {
      payload: { aspectRatio: "2:3", imageCount: 2 },
      structuredResult: {
        summary: "示例：两张图片分别承担封面识别和产品细节展示。",
        recommendations: ["示例建议：两张图保持统一色调，并确保文字在手机端易读。"],
      },
    },
  ],
  "reviewer.report.v1": [
    {
      payload: { focus: ["事实依据", "用户要求"] },
      structuredResult: {
        verdict: "CHANGES_REQUIRED",
        summary: "示例：文案整体清楚，但有一项优惠描述缺少依据。",
        issues: ["示例问题：正文提到折扣，当前材料未提供折扣信息。"],
      },
    },
    {
      payload: { focus: ["标题", "渠道表达"] },
      structuredResult: {
        verdict: "PASS",
        summary: "示例：标题与正文表达一致，未发现超出本次检查范围的问题。",
        issues: [],
      },
    },
  ],
  "writer.patch.v1": [
    {
      payload: { tone: "更自然" },
      structuredResult: {
        changes: [
          {
            issueIds: ["example_issue_1"],
            field: "body",
            slotId: null,
            expectedText: "开启元气满满的一天",
            replacementText: "让早晨的节奏慢一点",
          },
        ],
      },
    },
    {
      payload: { tone: "删去夸张表达" },
      structuredResult: {
        changes: [
          {
            issueIds: ["example_issue_2"],
            field: "title",
            slotId: null,
            expectedText: "全城最好喝的拿铁",
            replacementText: "一杯燕麦拿铁",
          },
        ],
      },
    },
  ],
  "visual.patch.v1": [
    {
      payload: { aspectRatio: "2:3", imageCount: 1 },
      structuredResult: {
        changes: [
          {
            issueIds: ["example_issue_3"],
            field: "imagePrompt",
            slotId: "example_slot_1",
            expectedText: "加入醒目的折扣标签",
            replacementText: "移除折扣标签，保留饮品主体和桌面环境",
          },
        ],
      },
    },
    {
      payload: { aspectRatio: "2:3", imageCount: 2 },
      structuredResult: {
        changes: [
          {
            issueIds: ["example_issue_4"],
            field: "visualStyle",
            slotId: null,
            expectedText: "高饱和撞色",
            replacementText: "低饱和暖色，保持两张图片色调统一",
          },
        ],
      },
    },
  ],
  "reviewer.publication.v3": [
    {
      payload: { focus: ["事实", "当前图片"] },
      structuredResult: {
        version: 3,
        verdict: "CHANGES_REQUIRED",
        summary: "示例：一项旧问题已解决，图片中的价格信息仍待核实。",
        issues: [
          {
            issueId: "example_issue_5",
            severity: "BLOCKER",
            target: "FACT",
            detail: "示例问题：图片出现了本次资料未确认的价格。",
            suggestion: "移除价格信息或补充可核实来源。",
            slotId: "example_slot_2",
          },
        ],
        requirementChecks: [
          {
            requirementId: "example_requirement_1",
            status: "MET",
            evidenceRefs: [],
            explanation: "示例：当前正文符合该项表达要求。",
            issueIds: [],
          },
        ],
        previousIssueChecks: [
          {
            issueId: "example_previous_issue_1",
            status: "RESOLVED",
            explanation: "示例：当前版本已移除旧问题所指的表述。",
            evidenceRefs: [],
          },
        ],
      },
    },
    {
      payload: { focus: ["用户要求", "事实依据"] },
      structuredResult: {
        version: 3,
        verdict: "LIMITED",
        summary: "示例：部分要求已满足，但有一项需要商家补充资料。",
        issues: [],
        requirementChecks: [
          {
            requirementId: "example_requirement_2",
            status: "UNCERTAIN",
            evidenceRefs: [],
            explanation: "示例：现有材料无法确认服务时间。",
            issueIds: [],
          },
        ],
        previousIssueChecks: [
          {
            issueId: "example_previous_issue_2",
            status: "UNCERTAIN",
            explanation: "示例：缺少当前版本材料，无法判断旧问题是否解决。",
            evidenceRefs: [],
          },
        ],
      },
    },
  ],
  "writer.publication.v1": [
    {
      payload: { channel: "小红书", tone: "生活化" },
      structuredResult: {
        action: "REVISE",
        title: "午间的一杯燕麦香",
        body: "午休来一杯燕麦拿铁，给忙碌的下午留一点轻松。",
        internalNotes: "示例内容；发布前核实商家资料。",
      },
    },
    {
      payload: { channel: "小红书", tone: "简洁" },
      structuredResult: {
        action: "REPLY",
        reply: "已按要求调整正文，标题和其他条件保持不变。",
        title: "早晨的一杯拿铁",
        body: "用一杯拿铁开启今天。",
        internalNotes: "示例回复；不创建新稿时保留当前正文。",
      },
    },
  ],
  "visual.publication.v1": [
    {
      payload: { aspectRatio: "2:3", imageCount: 1 },
      structuredResult: {
        visualStyle: "自然光、暖色调、简洁桌面。",
        instructions: "突出饮品主体，标题留在上方安全区域。",
        images: [{ title: "燕麦拿铁封面", prompt: "一杯燕麦拿铁置于窗边桌面，自然光，保留真实饮品外观。" }],
      },
    },
    {
      payload: { aspectRatio: "2:3", imageCount: 2 },
      structuredResult: {
        visualStyle: "统一的浅暖色调，简洁生活方式摄影。",
        instructions: "封面突出主题，第二张展示产品细节，文字保持易读。",
        images: [
          { title: "午间封面", prompt: "桌面上的燕麦拿铁，留白充足，不添加价格或促销文字。" },
          { title: "饮品细节", prompt: "展示燕麦拿铁表面和杯身细节，背景简洁。" },
        ],
      },
    },
  ],
  "reviewer.publication.v1": [
    {
      payload: { focus: ["文案事实", "图片说明"] },
      structuredResult: {
        verdict: "CHANGES_REQUIRED",
        summary: "示例：图片说明中的优惠没有材料支持。",
        issues: [
          {
            severity: "BLOCKER",
            target: "FACT",
            detail: "示例问题：出现未经来源核实的优惠承诺。",
            suggestion: "删除该优惠承诺，或补充授权来源。",
            slotId: null,
          },
        ],
      },
    },
    {
      payload: { focus: ["标题", "内容一致性"] },
      structuredResult: { verdict: "PASS", summary: "示例：标题与正文一致，当前检查范围内未发现问题。", issues: [] },
    },
  ],
  "reviewer.publication.v2": [
    {
      payload: { focus: ["有效要求", "事实依据"] },
      structuredResult: {
        version: 2,
        verdict: "CHANGES_REQUIRED",
        summary: "示例：正文符合字数要求，但有一项事实缺少依据。",
        issues: [
          {
            issueId: "example_issue_6",
            severity: "BLOCKER",
            target: "FACT",
            detail: "示例问题：正文提到销量，当前资料未提供销量数据。",
            suggestion: "删除销量描述或补充可核实来源。",
            slotId: null,
          },
        ],
        requirementChecks: [
          {
            requirementId: "example_requirement_3",
            status: "MET",
            evidenceRefs: [],
            explanation: "示例：正文长度符合当前要求。",
            issueIds: [],
          },
        ],
      },
    },
    {
      payload: { focus: ["标题", "行动引导"] },
      structuredResult: {
        version: 2,
        verdict: "PASS",
        summary: "示例：标题和行动引导均符合本次要求。",
        issues: [],
        requirementChecks: [
          {
            requirementId: "example_requirement_4",
            status: "MET",
            evidenceRefs: [],
            explanation: "示例：正文包含清晰且不夸大的行动引导。",
            issueIds: [],
          },
        ],
      },
    },
  ],
};

/** 返回 Host 登记且随工具版本冻结的固定角色契约，不能从模型输入注册 Schema。 */
export function expertContract(role: ExpertTaskV3["targetExpertId"], contractId = contracts[role].id) {
  if (contractId === contracts[role].id) return contracts[role];
  const contract = publicationContracts[contractId as keyof typeof publicationContracts];
  if (!contract || contract.role !== role) throw new Error("EXPERT_CONTRACT_INVALID");
  return contract;
}

/** 按本次任务契约选择并校验 Few-shot 示例，避免示例字段与 Schema 漂移。 */
export function expertContractFewShotExamples(
  role: ExpertTaskV3["targetExpertId"],
  contractId = contracts[role].id,
): ExpertFewShotExample[] {
  const contract = expertContract(role, contractId);
  const examples = fewShotExamples[contract.id];
  const validator = validators[contract.id];
  if (
    !examples ||
    examples.length < 2 ||
    !validator ||
    examples.some((example) => !validator.input(example.payload) || !validator.output(example.structuredResult))
  )
    throw new Error("EXPERT_FEW_SHOT_INVALID");
  return examples;
}

/** 校验新版专业输入并转换为既有委派内部任务视图，不改变持久化的原始 V3 输入。 */
export function expertTaskView(input: DelegationTaskV2 | ExpertTaskV3): DelegationTaskV2 {
  if (input.version === 2) return input;
  if (!validateTask(input)) throw new Error("EXPERT_CONTRACT_INVALID");
  if (input.executionMode === "background" && input.targetExpertId !== "researcher")
    throw new Error("RESEARCH_BACKGROUND_ONLY");
  const contract = expertContract(input.targetExpertId, input.contractId);
  if (input.contractId !== contract.id || input.contractVersion !== 1 || !validators[contract.id]?.input(input.payload))
    throw new Error("EXPERT_CONTRACT_INVALID");
  if (new Set(input.inputRefs.map((ref) => `${ref.kind}:${ref.id}`)).size !== input.inputRefs.length)
    throw new Error("DELEGATION_RESOURCE_DUPLICATE");
  return {
    version: 2,
    taskKey: input.taskKey,
    targetExpertId: input.targetExpertId,
    task: input.task,
    criteria: input.criteria,
    inputRefs: input.inputRefs
      .filter((ref) => ref.kind === "uploaded_text" || ref.kind === "public_evidence")
      .map((ref) => ({ type: ref.kind as "uploaded_text" | "public_evidence", id: ref.id })),
    ...(input.contextSummary && { contextSummary: input.contextSummary }),
    missingInformation: input.missingInformation,
    expectedOutput: input.targetExpertId === "writer" ? "text_draft" : "text_report",
  };
}

/** 结果必须满足已冻结角色 Schema、条件 ID 和材料白名单，质量结论不由格式通过推导。 */
export function validateExpertSubmission(
  input: ExpertTaskV3,
  submission: ExpertSubmissionV3,
  materials: AgentMaterialRef[],
): void {
  if (
    !validateSubmission(submission) ||
    !validators[input.contractId]?.output(submission.structuredResult) ||
    !submission.summary.trim()
  )
    throw new Error("EXPERT_CONTRACT_INVALID");
  const ids = new Set(input.criteria.map((item) => item.id));
  if (submission.unmetCriterionIds.some((id) => !ids.has(id))) throw new Error("DELEGATION_CRITERIA_INVALID");
  if (submission.outcome === "READY" && (submission.unmetCriterionIds.length || submission.questions.length))
    throw new Error(
      "EXPERT_CONTRACT_INVALID: READY要求questions=[]且unmetCriterionIds=[]；任务已完成时将非阻塞建议放summary或允许的内部说明；确实缺少必要输入时用NEEDS_INPUT并列明问题和未满足条件。",
    );
  if (submission.outcome === "NEEDS_INPUT" && !submission.questions.length)
    throw new Error("EXPERT_CONTRACT_INVALID: NEEDS_INPUT必须提供至少一个阻塞任务的questions问题。");
  if (new Set(submission.questions.map((item) => item.id)).size !== submission.questions.length)
    throw new Error("EXPERT_CONTRACT_INVALID");
  const allowed = new Set(materials.map((ref) => canonicalJson(ref)));
  if (submission.materialRefs.some((ref) => !allowed.has(canonicalJson(ref)))) throw new Error("RESULT_SOURCE_INVALID");
}
