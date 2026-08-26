/**
 * ask / stop / regenerate 路由共用的 SSE 帮助函数。
 *
 * `buildSseController` 把 `ReadableStreamDefaultController` 包成带类型的
 * `send(event, data)`。编码（TextEncoder、`event: ... / data: ... / 空行`
 * 帧格式、JSON 序列化）与 ask.ts 原实现逐字节一致，保证 SSE 协议兼容。
 */

export interface SseSend {
  (event: string, data: unknown): void;
}

export interface SseController {
  send: SseSend;
  /** 包一层 close，避免路由直接依赖 stream 内部 API。 */
  close: () => void;
}

export function buildSseController(controller: ReadableStreamDefaultController): SseController {
  const encoder = new TextEncoder();
  const send: SseSend = (event, data) => {
    controller.enqueue(encoder.encode(`event: ${event}\n`));
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };
  return {
    send,
    close: () => controller.close(),
  };
}

/**
 * 构造所有流式路由共用的 SSE Response。集中维护 cache / no-cache / keep-alive
 * 头策略，避免散落多处。
 */
export function sseResponse(stream: ReadableStream): Response {
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
