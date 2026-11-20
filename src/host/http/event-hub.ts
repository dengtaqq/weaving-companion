import type { ServerResponse } from "node:http";
import type { FastifyReply } from "fastify";
import type { RuntimeEvent } from "../../shared/contracts.js";
import type { DbClient } from "../infrastructure/sqlite/db-client.js";

const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_BUFFER_EVENTS = 2_000;
const HEARTBEAT_MS = 15_000;

/** 广播已持久化的会话事件，管理 SSE 补发、背压与连接资源。 */
export class EventHub {
  private readonly subscribers = new Map<string, Set<(event: RuntimeEvent) => void>>();
  private readonly clients = new Set<ServerResponse>();
  private closed = false;

  /** 绑定事件补发所需的数据库。 */
  constructor(private readonly db: DbClient) {}

  /** 向当前会话的 SSE 订阅者广播已提交事件。 */
  publish(event: RuntimeEvent): void {
    for (const send of this.subscribers.get(event.sessionId) ?? []) send(event);
  }

  /** 在路由完成鉴权后接管响应，先补历史再持续推送。 */
  async open(reply: FastifyReply, sessionId: string, initialSeq: number): Promise<void> {
    if (this.closed) throw new Error("EVENT_STREAM_CLOSED");
    const session = await this.db.getSession(sessionId);
    if (!session || session.lifecycleStatus === "TRASHED") throw new Error("SESSION_NOT_FOUND");
    if (this.closed) throw new Error("EVENT_STREAM_CLOSED");
    // 查库期间页面可能已离开；响应已断开时不再登记心跳和订阅。
    if (reply.raw.destroyed || reply.raw.writableEnded) return;
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    response.flushHeaders();
    this.clients.add(response);
    let cursor = initialSeq;
    let replaying = true;
    let draining = false;
    let closed = false;
    let bufferBytes = 0;
    const buffer: RuntimeEvent[] = [];
    const listeners = this.subscribers.get(sessionId) ?? new Set<(event: RuntimeEvent) => void>();

    /** 注销连接及其心跳和缓存；订阅关闭不取消 Agent 任务。 */
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      buffer.length = 0;
      listeners.delete(send);
      if (!listeners.size) this.subscribers.delete(sessionId);
      this.clients.delete(response);
    };
    /** 编码一条 SSE 消息，并等待写缓冲恢复以限制慢客户端。 */
    const write = async (event: RuntimeEvent) => {
      if (closed || response.destroyed || response.writableEnded) return;
      if (response.writableLength > MAX_BUFFER_BYTES) throw new Error("SSE_BACKPRESSURE");
      if (!response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)) {
        await new Promise<void>((resolve, reject) => {
          /** 移除本次背压等待的监听和超时。 */
          const clear = () => {
            clearTimeout(timeout);
            response.off("drain", drained);
            response.off("close", disconnected);
          };
          /** 写缓冲恢复后继续补发。 */
          const drained = () => {
            clear();
            resolve();
          };
          /** 断线后结束补发等待。 */
          const disconnected = () => {
            clear();
            resolve();
          };
          const timeout = setTimeout(() => {
            clear();
            reject(new Error("SSE_BACKPRESSURE"));
          }, HEARTBEAT_MS);
          response.once("drain", drained);
          response.once("close", disconnected);
        });
      }
    };
    /** 发送控制事件，要求页面重取持久快照后续订。 */
    const requireSnapshot = async (reason: string) => {
      await write({
        eventId: `snapshot_${crypto.randomUUID()}`,
        sessionId,
        runId: null,
        seq: cursor,
        type: "session.snapshot.required",
        occurredAt: new Date().toISOString(),
        payload: { reason },
      });
      response.end();
    };
    /** 校验事件连续性并推进当前连接的游标。 */
    const deliver = async (event: RuntimeEvent) => {
      if (closed || event.seq <= cursor) return;
      if (event.seq !== cursor + 1) {
        await requireSnapshot("EVENT_GAP");
        cleanup();
        return;
      }
      await write(event);
      cursor = event.seq;
    };
    /** 串行清空实时事件缓冲，避免异步写入打乱顺序。 */
    const drain = async () => {
      if (draining || replaying || closed) return;
      draining = true;
      try {
        while (buffer.length && !closed) {
          buffer.sort((a, b) => a.seq - b.seq);
          const event = buffer.shift();
          if (!event) break;
          bufferBytes -= Buffer.byteLength(JSON.stringify(event));
          await deliver(event);
        }
      } finally {
        draining = false;
      }
    };
    /** 缓存广播；历史补发完成后交给同一写循环。 */
    const send = (event: RuntimeEvent) => {
      if (closed || event.seq <= cursor) return;
      buffer.push(event);
      bufferBytes += Buffer.byteLength(JSON.stringify(event));
      if (buffer.length > MAX_BUFFER_EVENTS || bufferBytes > MAX_BUFFER_BYTES) {
        response.destroy();
        cleanup();
        return;
      }
      void drain().catch(() => response.destroy());
    };
    const heartbeat = setInterval(() => {
      if (response.writableLength > MAX_BUFFER_BYTES) response.destroy();
      else if (!closed && !response.writableEnded && !response.writableNeedDrain) response.write(": heartbeat\n\n");
    }, HEARTBEAT_MS);
    response.once("close", cleanup);
    response.once("error", () => {
      response.destroy();
      cleanup();
    });
    listeners.add(send);
    this.subscribers.set(sessionId, listeners);
    // 先订阅后查询，保证快照与实时流交接期间的事件仍能补发或从缓冲收到。
    try {
      if (initialSeq > session.lastSeq) {
        await requireSnapshot("CURSOR_AHEAD");
        cleanup();
        return;
      }
      while (!closed) {
        const events = await this.db.listEvents(sessionId, cursor, 500);
        for (const event of events) {
          if (closed) return;
          await deliver(event);
        }
        if (events.length < 500) break;
      }
      replaying = false;
      await drain();
    } catch {
      response.destroy();
      cleanup();
    }
  }

  /** 停止新订阅并关闭 SSE 连接，使 HTTP 服务能够退出。 */
  close(): void {
    this.closed = true;
    for (const response of this.clients) response.destroy();
    this.clients.clear();
    this.subscribers.clear();
  }
}
