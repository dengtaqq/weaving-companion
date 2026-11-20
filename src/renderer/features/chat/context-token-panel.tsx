import type {
  ContextCompressionMeasurement,
  ContextTokenMeasurement,
  RuntimeEvent,
} from "../../../shared/contracts.js";

/** 以一致的分组格式显示 token 数量，避免把缺失值显示为零。 */
function tokenCount(value: number | null): string {
  return value === null ? "未知" : value.toLocaleString("zh-CN");
}

/** 展示当前有效上下文的估算与窗口占比，独立标注 Provider 最近输入报告。 */
export function ContextTokenPanel({
  measurement,
  working,
}: {
  measurement: ContextTokenMeasurement | null;
  working: boolean;
}) {
  return (
    <div className="side-block">
      <h3>当前上下文长度</h3>
      {measurement ? (
        <>
          <strong>
            {tokenCount(measurement.estimatedTokens)} / {tokenCount(measurement.contextWindow)} token ·{" "}
            {measurement.usedPercent}%
          </strong>
          <progress
            className="context-token-meter"
            aria-label="上下文窗口占用"
            max={100}
            value={Math.min(100, measurement.usedPercent)}
          />
          <p>
            {working ? "本轮工作上下文估算" : "上次成功上下文估算"}，窗口剩余 {tokenCount(measurement.remainingTokens)}{" "}
            token。
          </p>
          <p>
            预留 {tokenCount(measurement.reserveTokens)}；扣除预留后可用{" "}
            {tokenCount(measurement.remainingBeforeReserve)} token。
          </p>
          <p>最近一次 Provider 输入量：{tokenCount(measurement.providerInputTokens)} token；与当前长度估算分开统计。</p>
          <p>
            {measurement.requestIndex > 0 ? `本轮第 ${measurement.requestIndex} 次模型请求` : "首次请求前"} ·{" "}
            {new Date(measurement.measuredAt).toLocaleTimeString("zh-CN")}
          </p>
        </>
      ) : (
        <p>尚无计量记录，下次运行后显示。已有历史不会按消息条数猜测长度。</p>
      )}
    </div>
  );
}

/** 展示单次压缩前后同口径估算；失败与工作副本状态不冒充提交成功。 */
export function ContextCompressionLog({ event }: { event: RuntimeEvent }) {
  const value = event.payload as unknown as ContextCompressionMeasurement;
  const scope = event.payload.delegationId ? `专家尝试 ${event.payload.attempt} · ` : "";
  return (
    <div className="run-placeholder context-compression-log">
      {scope}
      {value.kind}：压缩前 {tokenCount(value.before.estimatedTokens)} → 压缩后{" "}
      {tokenCount(value.after?.estimatedTokens ?? null)} token。
      {value.status === "COMPLETED"
        ? ` 预计减少 ${tokenCount(value.savedTokens)} token（${value.savedPercent ?? 0}%）。`
        : " 本次压缩失败，未生成压缩后计量。"}
      <span>记录属于工作副本，是否保留以所属任务结果为准。</span>
    </div>
  );
}
