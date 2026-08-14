// ==========================================
// shared/sse_parser.js 的类型声明（供移动端 TypeScript 使用）
// 与 sse_parser.js 的导出保持一致
// ==========================================

export interface SSEEvent {
  type: string;
  content: string;
  raw?: any;
}

export function parseSSELine(line: string): SSEEvent | null;

export interface SSEHandler {
  processLine(line: string): void;
  processChunk(text: string): void;
  flush(): string;
}

export interface SSECallbacks {
  onThinking?: (content: string, raw?: any) => void;
  onResponse?: (content: string, raw?: any) => void;
  onSpeaker?: (content: string, raw?: any) => void;
  onSilence?: (content: string, raw?: any) => void;
  onRoundEnd?: (content: string, raw?: any) => void;
  onError?: (content: string, raw?: any) => void;
  onDone?: (content: string, raw?: any) => void;
  onReplaceResponse?: (content: string, raw?: any) => void;
  onEvent?: (type: string, content: string, raw?: any) => void;
}

export function createSSEHandler(callbacks?: SSECallbacks): SSEHandler;

export function streamSSE(response: Response, callbacks: SSECallbacks): Promise<void>;

/** 迭代每条 SSE 事件，返回原始事件对象；遇到 [DONE] 或流结束自动终止。 */
export function iterateSSE(response: Response): AsyncGenerator<any, void, unknown>;