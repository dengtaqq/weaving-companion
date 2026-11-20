/** 当前研究任务的进展笔记；不能代替商家事实、授权或审核结论。 */
export interface ResearchMemoryItem {
  id: string;
  note: string;
  evidenceIds: string[];
}

/** 三类工作记忆随研究委派持久化，不跨任务自动采用。 */
export interface ResearchMemory {
  hypotheses: ResearchMemoryItem[];
  triedApproaches: ResearchMemoryItem[];
  openQuestions: ResearchMemoryItem[];
}

/** 同一版本上按ID增量更新；显式删除使容量耗尽后仍可整理。 */
export interface ResearchMemoryPatch {
  baseRevision: number;
  hypotheses?: ResearchMemoryItem[];
  triedApproaches?: ResearchMemoryItem[];
  openQuestions?: ResearchMemoryItem[];
  removeIds?: Partial<Record<keyof ResearchMemory, string[]>>;
}

/** 记忆和已整理工具边界共同提交，避免仅凭存在一条笔记裁剪全部历史。 */
export interface ResearchMemorySnapshot {
  revision: number;
  memory: ResearchMemory;
  coveredToolCallIds: string[];
}
