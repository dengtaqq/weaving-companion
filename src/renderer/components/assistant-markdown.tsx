import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  /** 安全渲染助手回复中的链接并限制外部跳转属性。 */
  a({ children, href, title }) {
    return (
      <a href={href} title={title} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  /** 给助手回复中的 Markdown 表格添加工作台容器。 */
  table({ children }) {
    return (
      <div className="markdown-table-scroll">
        <table>{children}</table>
      </div>
    );
  },
  /** 阻止助手 Markdown 直接加载远程图片。 */
  img({ alt }) {
    // 未登记的图片地址不能由回复正文自动加载或当成已生成产物。
    return <span className="markdown-image-placeholder">[图片：{alt || "未提供说明"}]</span>;
  },
};

/** 安全展示历史和流式助手 Markdown 正文。 */
export function AssistantMarkdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
  return (
    <div className="bubble-content markdown-content">
      <Markdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {content}
      </Markdown>
      {streaming && <span className="typing-cursor" aria-hidden="true" />}
    </div>
  );
}
