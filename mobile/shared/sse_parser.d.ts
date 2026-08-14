// TypeScript 声明：sse_parser.js（移动端共享 SSE 解析工具）
// 该文件为纯 JS 实现，这里补充类型声明，使 `yield* iterateSSE(response)` 能赋给任意具体 chunk 类型。

export interface SseEvent {
  type: string;
  content: string;
  [key: string]: unknown;
}

export function parseSSELine(line: string): SseEvent | null;

export function createSSEHandler(callbacks?: Record<string, (content: string, rawEvent?: unknown) => void>): {
  processLine(line: string): void;
  processChunk(text: string): void;
  flush(): string;
};

export async function streamSSE(response: Response, callbacks?: Record<string, (...args: unknown[]) => void>): Promise<void>;

export async function* iterateSSE(response: Response): AsyncGenerator<any>;