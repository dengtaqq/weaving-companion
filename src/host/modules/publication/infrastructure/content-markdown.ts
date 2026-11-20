/** 使用固定排版把一版受控标题和正文转为可下载 Markdown。 */
export function renderContentMarkdown(title: string, body: string): Buffer {
  return Buffer.from(`# ${title.trim()}\n\n${body.trim()}\n`, "utf8");
}
