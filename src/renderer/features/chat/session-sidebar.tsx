import type { SessionRecord } from "../../../shared/contracts.js";
import { Icon } from "../../components/ui.js";
/** 会话列表独立滚动，折叠时保留中央输入区宽度。 */
export function SessionSidebar({
  sessions,
  currentId,
  open,
  onToggle,
  onSelect,
  onCreate,
  onManage,
}: {
  sessions: SessionRecord[];
  currentId: string | undefined;
  open: boolean;
  onToggle: () => void;
  onSelect: (session: SessionRecord) => void;
  onCreate: () => void;
  onManage: () => void;
}) {
  if (!open) return null;
  return (
    <aside className="session-sidebar" aria-label="会话列表">
      <header>
        <strong>对话</strong>
        <button type="button" className="icon-button quiet-button" aria-label="收起会话列表" onClick={onToggle}>
          <Icon name="panel" size={16} />
        </button>
      </header>
      <button type="button" className="new-chat" onClick={onCreate}>
        <Icon name="plus" />
        新对话
      </button>
      <div className="session-sidebar-list">
        {sessions.map((session) => (
          <button
            type="button"
            key={session.sessionId}
            className={currentId === session.sessionId ? "selected" : ""}
            onClick={() => onSelect(session)}
          >
            <strong>{session.title}</strong>
            <small>
              {session.scope === "MERCHANT" ? "商家会话" : "普通对话"} ·{" "}
              {new Date(session.updatedAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}
            </small>
          </button>
        ))}
        {!sessions.length && <p className="muted">暂无会话</p>}
      </div>
      <button type="button" className="quiet-button" onClick={onManage}>
        管理会话与回收站
      </button>
    </aside>
  );
}
