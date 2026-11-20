import AjvModule from "ajv/dist/2020.js";
import {
  type PublicationRepairBasis,
  type PublicationRepairOutput,
  publicationRepairSchema,
} from "../../../../shared/publication-repair.js";

export const PUBLICATION_REPAIR_VERSION = "publication-repair-v1";
const validate = new AjvModule.default().compile<PublicationRepairOutput>(publicationRepairSchema);

/** 校验问题、字段和唯一原文定位后只替换选中片段，未涉及字段及图片引用原样保留。 */
export function applyPublicationRepair(text: string, basis: PublicationRepairBasis) {
  let output: unknown;
  try {
    output = JSON.parse(text);
  } catch {
    throw new Error("PUBLICATION_REPAIR_INVALID");
  }
  if (!validate(output)) throw new Error("PUBLICATION_REPAIR_INVALID");
  if (!output.changes.length) throw new Error("PUBLICATION_REPAIR_NO_PROGRESS");
  const draft = { ...basis.draft };
  const publication = { ...basis.publication, images: basis.publication.images.map((image) => ({ ...image })) };
  const groups = new Map<string, PublicationRepairOutput["changes"]>();
  const covered = new Set<string>();
  for (const change of output.changes) {
    const isCopy = ["title", "body", "internalNotes"].includes(change.field);
    const isImage = ["imageTitle", "imagePrompt"].includes(change.field);
    const issues = change.issueIds.map((id) => basis.issues.find((issue) => issue.issueId === id));
    if (
      isCopy !== (basis.scope === "COPY") ||
      isImage !== (change.slotId !== null) ||
      issues.some(
        (issue) =>
          !issue ||
          (isCopy
            ? !["COPY", "FACT"].includes(issue.target)
            : issue.target !== "INSTRUCTIONS" && issue.target !== "IMAGE") ||
          (isImage && (issue.slotId !== change.slotId || issue.target !== "IMAGE")) ||
          (!isCopy && !isImage && issue?.target !== "INSTRUCTIONS"),
      ) ||
      change.expectedText === change.replacementText
    )
      throw new Error("PUBLICATION_REPAIR_SCOPE_INVALID");
    for (const id of change.issueIds) covered.add(id);
    const key = `${change.field}:${change.slotId ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), change]);
  }
  if (basis.issues.some((issue) => !covered.has(issue.issueId))) throw new Error("PUBLICATION_REPAIR_INCOMPLETE");
  for (const changes of groups.values()) {
    const first = changes[0];
    if (!first) throw new Error("PUBLICATION_REPAIR_INVALID");
    const slot = publication.images.find((image) => image.slotId === first.slotId);
    const field = first.field === "imageTitle" ? "title" : first.field === "imagePrompt" ? "prompt" : first.field;
    const target = first.slotId ? slot : basis.scope === "COPY" ? draft : publication;
    if (!target || !(field in target)) throw new Error("PUBLICATION_REPAIR_SCOPE_INVALID");
    const record = target as unknown as Record<string, string>;
    const original = record[field];
    if (typeof original !== "string") throw new Error("PUBLICATION_REPAIR_SCOPE_INVALID");
    const ranges = changes
      .map((change) => {
        const start = original.indexOf(change.expectedText);
        if (start < 0 || original.indexOf(change.expectedText, start + 1) !== -1)
          throw new Error("PUBLICATION_REPAIR_ANCHOR_INVALID");
        return { ...change, start, end: start + change.expectedText.length };
      })
      .sort((a, b) => a.start - b.start);
    if (ranges.some((range, index) => index > 0 && (ranges[index - 1]?.end ?? 0) > range.start))
      throw new Error("PUBLICATION_REPAIR_ANCHOR_INVALID");
    let value = original;
    for (const range of ranges.reverse())
      value = value.slice(0, range.start) + range.replacementText + value.slice(range.end);
    if (value === original) throw new Error("PUBLICATION_REPAIR_NO_PROGRESS");
    record[field] = value;
  }
  return { draft, publication };
}
