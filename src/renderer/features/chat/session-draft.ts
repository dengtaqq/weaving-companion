/** 生成会话待发送草稿的本机临时存储键。 */
export function sessionDraftKey(sessionId: string): string {
  return `zhiban:session-draft:${sessionId}`;
}
