import { useEffect, useState } from "react";
import type { MessageRecord } from "../../../shared/contracts.js";
import { type PromptSnapshot, promptSnapshotMarkdown } from "../../../shared/prompt-snapshot.js";
import { getPromptSnapshots, promptSnapshotDownloadUrl } from "../../api/client.js";

/** 在会话概览按轮次、角色和尝试查看启动时记录，不用当前设置回算历史。 */
export function PromptSnapshotPanel({
  sessionId,
  messages,
  activeRunId,
}: {
  sessionId: string;
  messages: MessageRecord[];
  activeRunId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [delegationId, setDelegationId] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [loadedKey, setLoadedKey] = useState("");
  const [snapshots, setSnapshots] = useState<PromptSnapshot[]>([]);
  const [delegations, setDelegations] = useState<Array<{ delegationId: string; targetExpertId: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const runIds = [
    ...new Set(
      [
        activeRunId,
        ...messages
          .slice()
          .reverse()
          .map((message) => message.runId),
      ].filter((id): id is string => Boolean(id)),
    ),
  ];
  const runId = selectedRunId || runIds[0] || "";
  const selectionKey = `${runId}:${delegationId}`;
  const snapshot =
    loadedKey === selectionKey ? (snapshots.find((item) => item.attempt === attempt) ?? snapshots.at(-1)) : undefined;

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh 是用户显式刷新同一只读资源的触发版本。
  useEffect(() => {
    if (!open || !runId) return;
    let cancelled = false;
    setLoading(true);
    setSnapshots([]);
    setNotice("");
    setError("");
    void getPromptSnapshots(sessionId, runId, delegationId)
      .then((result) => {
        if (cancelled) return;
        setLoadedKey(`${runId}:${delegationId}`);
        setSnapshots(result.snapshots);
        setAttempt(result.snapshots.at(-1)?.attempt ?? 0);
        if (!delegationId) setDelegations(result.delegations);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, runId, delegationId, open, refresh]);

  /** 复制当前选择的快照，剪贴板失败时保留正文供手动选取。 */
  async function copySnapshot() {
    if (!snapshot) return;
    try {
      await navigator.clipboard.writeText(promptSnapshotMarkdown(snapshot));
      setNotice("已复制当前快照");
    } catch {
      setNotice("剪贴板不可用，请下载 Markdown 或手动复制正文");
    }
  }

  return (
    <details className="side-block prompt-snapshot-panel" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>本轮提示词与资料</summary>
      <p>查看启动时的只读记录。基础指令在设置页编辑，修改只影响之后受理的任务。</p>
      {open && (
        <>
          <label>
            会话轮次
            <select
              value={runId}
              onChange={(event) => {
                setSelectedRunId(event.target.value);
                setDelegationId("");
                setDelegations([]);
                setSnapshots([]);
              }}
            >
              {!runIds.length && <option value="">暂无运行记录</option>}
              {runIds.map((id) => {
                const message = messages.find((item) => item.runId === id && item.role === "user");
                return (
                  <option key={id} value={id}>
                    {message?.content.slice(0, 32) || id}
                  </option>
                );
              })}
            </select>
          </label>
          <label>
            执行角色
            <select
              value={delegationId}
              onChange={(event) => {
                setDelegationId(event.target.value);
                setSnapshots([]);
              }}
            >
              <option value="">主 Agent</option>
              {delegations.map((item) => (
                <option key={item.delegationId} value={item.delegationId}>
                  {item.targetExpertId} · {item.delegationId.slice(-8)}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={loading || !runId} onClick={() => setRefresh((value) => value + 1)}>
            刷新记录
          </button>
          {loading && <p role="status">读取快照中…</p>}
          {error && <p role="alert">读取失败：{error}</p>}
          {!loading && !error && !snapshot && <p>未记录。旧任务不会按当前配置重建；排队或准备中的任务可稍后刷新。</p>}
          {!loading && !error && snapshot && (
            <>
              <label>
                运行尝试
                <select
                  value={snapshot.attempt}
                  onChange={(event) => {
                    setAttempt(Number(event.target.value));
                    setNotice("");
                  }}
                >
                  {snapshots.map((item) => (
                    <option key={item.attempt} value={item.attempt}>
                      Attempt {item.attempt} · {item.createdAt}
                    </option>
                  ))}
                </select>
              </label>
              <p>
                记录时间：{snapshot.createdAt} · 基础提示词第 {snapshot.systemPromptRevision ?? "未知"} 版
              </p>
              <p>
                这是启动时准备使用的指令和固定资料，不包含完整历史、后续工具结果、动态进度或图片字节，也不证明请求已发送或任务完成。
              </p>
              <div className="prompt-actions">
                <button type="button" onClick={() => void copySnapshot()}>
                  复制 Markdown
                </button>
                <a
                  className="outline-button"
                  href={promptSnapshotDownloadUrl(sessionId, runId, snapshot.attempt, delegationId)}
                  download
                >
                  下载 Markdown
                </a>
              </div>
              {notice && <p role="status">{notice}</p>}
              <h4>系统指令来源（按组装顺序）</h4>
              {snapshot.systemSections.map((section) => (
                <details key={section.id}>
                  <summary>{section.title}</summary>
                  <pre>{section.content}</pre>
                </details>
              ))}
              <details>
                <summary>SDK 有效系统文本</summary>
                <pre>{snapshot.systemPrompt}</pre>
              </details>
              <h4>本轮固定资料</h4>
              {!snapshot.contextSections.length && <p>无固定资料注入。</p>}
              {snapshot.contextSections.map((section) => (
                <details key={section.id}>
                  <summary>{section.title}</summary>
                  <pre>{section.content}</pre>
                </details>
              ))}
              <details>
                <summary>实际工具与 Skill 版本</summary>
                <p>{snapshot.toolIds.join("、") || "无工具"}</p>
                {snapshot.tools.map((tool) => (
                  <details key={tool.name}>
                    <summary>{tool.name}</summary>
                    <p>{tool.description}</p>
                    <pre>{JSON.stringify(tool.parameters, null, 2)}</pre>
                  </details>
                ))}
                {snapshot.skills.map((skill) => (
                  <p key={skill.name}>
                    {skill.name} · {skill.sha256}
                  </p>
                ))}
              </details>
              <details>
                <summary>版本与完整性</summary>
                <p>
                  Run：{snapshot.runId} · Attempt {snapshot.attempt}
                </p>
                <p>适配器：{snapshot.adapterVersion}</p>
                <p>组装版本：{snapshot.assemblyVersion}</p>
                <p>Plan hash：{snapshot.planHash ?? "无"}</p>
                <p>快照 SHA-256：{snapshot.sha256}</p>
              </details>
            </>
          )}
        </>
      )}
    </details>
  );
}
