// ==========================================
// SSE 解析工具
// 解析 SSE 流文本，按事件类型分发
// 支持事件类型：thinking, response, speaker, silence, round_end, error, done, replace_response
// ==========================================

/**
 * 解析单行 SSE 数据
 * @param {string} line - SSE 行文本（如 "data: {\"type\":\"response\",\"content\":\"hello\"}"）
 * @returns {object|null} 解析后的事件对象，格式为 { type, content }，解析失败返回 null
 */
export function parseSSELine(line) {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('data: ')) {
    return null;
  }

  const data = trimmed.slice(6);
  if (data === '[DONE]') {
    return { type: 'done', content: '' };
  }

  try {
    const chunk = JSON.parse(data);
    return {
      type: chunk.type || 'unknown',
      content: chunk.content ?? '',
      raw: chunk,
    };
  } catch (e) {
    return null;
  }
}

/**
 * 创建 SSE 事件处理器
 * @param {object} callbacks - 事件回调函数
 * @param {function} [callbacks.onThinking] - 思考中事件回调 (content, rawEvent) => void
 * @param {function} [callbacks.onResponse] - 回复内容事件回调 (content, rawEvent) => void
 * @param {function} [callbacks.onSpeaker] - 说话人事件回调 (content, rawEvent) => void
 * @param {function} [callbacks.onSilence] - 沉默事件回调 (content, rawEvent) => void
 * @param {function} [callbacks.onRoundEnd] - 轮次结束事件回调 (content, rawEvent) => void
 * @param {function} [callbacks.onError] - 错误事件回调 (content, rawEvent) => void
 * @param {function} [callbacks.onDone] - 流结束事件回调 (content, rawEvent) => void
 * @param {function} [callbacks.onReplaceResponse] - 替换回复事件回调 (content, rawEvent) => void
 * @param {function} [callbacks.onEvent] - 所有事件的通用回调 (type, content, rawEvent) => void
 * @returns {object} 处理器对象，包含 processLine(line) 和 processChunk(text) 方法
 */
export function createSSEHandler(callbacks = {}) {
  const {
    onThinking,
    onResponse,
    onSpeaker,
    onSilence,
    onRoundEnd,
    onError,
    onDone,
    onReplaceResponse,
    onEvent,
  } = callbacks;

  let buffer = '';

  /**
   * 处理单行 SSE 数据
   * @param {string} line - 单行文本
   */
  function processLine(line) {
    const event = parseSSELine(line);
    if (!event) return;

    const { type, content, raw } = event;

    // 通用回调
    if (onEvent) {
      onEvent(type, content, raw);
    }

    // 按类型分发
    switch (type) {
      case 'thinking':
        onThinking && onThinking(content, raw);
        break;
      case 'response':
        onResponse && onResponse(content, raw);
        break;
      case 'speaker':
        onSpeaker && onSpeaker(content, raw);
        break;
      case 'silence':
        onSilence && onSilence(content, raw);
        break;
      case 'round_end':
        onRoundEnd && onRoundEnd(content, raw);
        break;
      case 'error':
        onError && onError(content, raw);
        break;
      case 'done':
        onDone && onDone(content, raw);
        break;
      case 'replace_response':
        onReplaceResponse && onReplaceResponse(content, raw);
        break;
      default:
        break;
    }
  }

  /**
   * 处理一块文本（可能包含多行），自动处理缓冲区
   * @param {string} text - 文本块
   */
  function processChunk(text) {
    buffer += text;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      processLine(line);
    }
  }

  /**
   * 清空缓冲区（流结束时调用）
   * @returns {string} 缓冲区剩余内容
   */
  function flush() {
    const remaining = buffer;
    buffer = '';
    return remaining;
  }

  return {
    processLine,
    processChunk,
    flush,
  };
}

/**
 * 从 fetch Response 创建 SSE 流处理器
 * @param {Response} response - fetch 返回的 Response 对象
 * @param {object} callbacks - 事件回调（同 createSSEHandler）
 * @returns {Promise<void>} 流处理完成的 Promise
 */
export async function streamSSE(response, callbacks) {
  const handler = createSSEHandler(callbacks);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      handler.processChunk(text);
    }
    // 处理缓冲区剩余内容
    const remaining = handler.flush();
    if (remaining.trim()) {
      handler.processLine(remaining);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * 从 fetch Response 迭代 SSE 事件（async generator 版）
 * 与 callback 式 streamSSE 互补，适合 `for await (const chunk of iterateSSE(response))` 消费。
 * 每条 yield 的是原始解析后的事件对象（含 type/content/query/count/results/speaker 等全部字段），
 * 遇到 [DONE] 或流结束自动终止（不额外 yield done 事件，与既有调用方行为一致）。
 * @param {Response} response - fetch 返回的 Response 对象
 * @returns {AsyncGenerator<object>} 事件对象生成器
 */
export async function* iterateSSE(response) {
  if (!response || !response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const event = parseSSELine(line);
        if (!event) continue;
        if (event.type === 'done') return; // [DONE] 终止
        yield event.raw ?? { type: event.type, content: event.content };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
