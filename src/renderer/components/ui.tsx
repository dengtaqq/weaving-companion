import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

const iconPaths: Record<string, ReactNode> = {
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  chat: <path d="M4 4h16v12H9l-5 4V4Z" />,
  shop: (
    <>
      <path d="M4 9h16l-2-5H6L4 9ZM5 10v10h14V10M9 20v-6h6v6" />
      <path d="M4 9c0 3 4 3 4 0 0 3 4 3 4 0 0 3 4 3 4 0 0 3 4 3 4 0" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="7" r="3" />
      <path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-4-5" />
    </>
  ),
  spark: <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4M18 4h4" />,
  robot: (
    <>
      <rect x="4" y="7" width="16" height="13" rx="4" />
      <path d="M12 3v4M2 11v5M22 11v5M9 16h6" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="15" cy="12" r="1" />
    </>
  ),
  box: (
    <>
      <path d="m12 3 9 5-9 5-9-5 9-5ZM3 8v10l9 5 9-5V8M12 13v10M7 5.5l9 5" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  settings: (
    <>
      <path d="m9 3-1 3-3 1-2 3 2 3-1 3 3 2 3-1 3 2 3-2 3 1 2-3-1-3 1-3-3-2-3 1-3-2Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M14 9l-3 3 3 3" />
    </>
  ),
  right: <path d="m9 5 7 7-7 7" />,
  down: <path d="m6 9 6 6 6-6" />,
  file: (
    <>
      <path d="M5 3h9l5 5v13H5V3ZM14 3v6h5M8 13h8M8 17h6" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8" cy="8" r="2" />
      <path d="m3 17 6-5 4 3 3-4 5 6" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M7 3v4M17 3v4M3 11h18" />
    </>
  ),
  check: <path d="m5 12 4 4 10-10" />,
};
/** 使用同一组线性图标保持导航、按钮与设计稿一致。 */
export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {iconPaths[name] ?? iconPaths.file}
    </svg>
  );
}

/** 对话框统一处理滚动、焦点圈定和关闭，避免浮层挤占主工作区。 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  wide = false,
  fullScreen = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  fullScreen?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    /** 关闭时保留键盘可达性，并将 Tab 约束在当前弹层。 */
    function dialogKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const fields = Array.from(
        panel.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
        ) ?? [],
      ).filter((field) => field.getClientRects().length);
      const first = fields[0],
        last = fields.at(-1);
      if (!first) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", dialogKey);
    return () => {
      document.removeEventListener("keydown", dialogKey);
      previous?.focus();
    };
  }, []);
  const content = (
    <div className={`modal-backdrop ${fullScreen ? "full-screen-backdrop" : ""}`}>
      <div
        className={`modal-panel ${wide ? "wide" : ""} ${fullScreen ? "full-screen" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panel}
      >
        <header className="modal-heading">
          <h2>{title}</h2>
          <button type="button" className="icon-button quiet-button" aria-label="关闭弹窗" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  );
  // 全屏预览脱离内容容器，避免容器查询和滚动区域限制 fixed 弹层尺寸。
  return fullScreen ? createPortal(content, document.body) : content;
}
