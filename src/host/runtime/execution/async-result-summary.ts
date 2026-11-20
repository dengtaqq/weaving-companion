import AjvModule from "ajv/dist/2020.js";

export const asyncResultSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: { summary: { type: "string", minLength: 1, maxLength: 1800 } },
} as const;
const validate = new AjvModule.default().compile<{ summary: string }>(asyncResultSummarySchema);

/** 汇总只产生有限正文，不含业务动作、授权或新的用户要求。 */
export function parseAsyncResultSummary(text: string): string {
  let value: unknown;
  try {
    value = JSON.parse(
      text
        .trim()
        .replace(/^```(?:json)?\s*/, "")
        .replace(/\s*```$/, ""),
    );
  } catch {
    throw new Error("ASYNC_RESULT_INVALID");
  }
  if (!validate(value) || !value.summary.trim()) throw new Error("ASYNC_RESULT_INVALID");
  return value.summary.trim();
}
