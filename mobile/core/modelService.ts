/**
 * modelService.ts — 手机端统一模型服务（对应 Python server/model_service.py）
 *
 * 核心设计：
 * 1. 手机端直接连接 Ollama / OpenRouter，不再依赖电脑端后端转发。（Phase 6 联调前的本地直连实现）
 * 2. 模型配置从本地 AsyncStorage 读取（model_priority / local_model / openrouter_model / openrouter_api_key）。
 * 3. 所有非流式/流式调用统一走 generate / generateStream / chatToolsStream，
 *    model 缺省时自动读取本地配置的主模型。
 * 4. 实现 ModelClient 抽象（non-streaming call），供分析管线（emotion/consolidation）使用。
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { ModelClient, ModelCallOptions, ModelResult } from './model';
import { setSearxngBaseUrl, deriveSearxngUrl } from './utils/webSearch';

// ========== 常量（与 Python 版一致） ==========

/** 回退模型（配置缺失时的兜底） */
export const FALLBACK_LOCAL_MODEL = 'qwen3.6:27b';
export const FALLBACK_OPENROUTER_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';

/** Ollama 默认地址（手机端通过设置页配置为电脑端地址，默认本机兜底） */
export let OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
export const OLLAMA_URL = () => `${OLLAMA_BASE_URL}/api/generate`;
export const OLLAMA_CHAT_URL = () => `${OLLAMA_BASE_URL}/api/chat`;
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** 设置 Ollama 地址（手机端设置页调用） */
export function setOllamaBaseUrl(url: string): void {
  OLLAMA_BASE_URL = normalizeOllamaUrl(url);
  // 搜索服务与 Ollama 同机：同步把 SearXNG 指向同一主机，避免手机端联网搜索走 127.0.0.1
  setSearxngBaseUrl(deriveSearxngUrl(OLLAMA_BASE_URL));
}

/**
 * 规范化 Ollama 地址（导出让连接测试等处复用）：
 *  - 去除所有空白（含换行/多余空格），防止粘贴时 URL 被插入空格
 *  - 剥离尾部 API 路径（/api/tags、/api/generate、/api/chat），避免拼出双路径
 *  - 缺省 http(s):// 协议前缀时自动补 https://
 *  - 空值回退本机默认地址
 */
export function normalizeOllamaUrl(url: string): string {
  let u = (url || '').trim();
  if (!u) return 'http://127.0.0.1:11434';
  u = u.replace(/\s+/g, '');
  u = u.replace(/\/(api\/(tags|generate|chat))(\?.*)?\/?$/i, '');
  u = u.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

// ========== 本地配置存储 ==========

const MODEL_CFG_KEY = 'atrium_model_config';

export interface ModelConfig {
  priority: 'local' | 'api';
  localModel: string;
  openrouterModel: string;
  openrouterApiKey: string;
}

export function defaultModelConfig(): ModelConfig {
  return {
    priority: 'local',
    localModel: FALLBACK_LOCAL_MODEL,
    openrouterModel: FALLBACK_OPENROUTER_MODEL,
    openrouterApiKey: '',
  };
}

/** 从本地缓存读取模型配置（未配置时返回默认值） */
export async function loadModelConfig(): Promise<ModelConfig> {
  // 恢复持久化的 Ollama 地址到模块级变量。
  // 否则每次启动都回退到 127.0.0.1（手机端即手机自身地址，连不上电脑端模型），
  // 必须先去设置页保存一次才能连上。这里在首次加载配置时一并恢复。
  try {
    const savedUrl = await AsyncStorage.getItem('atrium_ollama_base_url');
    if (savedUrl) setOllamaBaseUrl(savedUrl);
    // 显式保存的搜索地址优先（如公网隧道是两个独立地址），优先于按 Ollama 主机推导
    const savedSearxng = await AsyncStorage.getItem('atrium_searxng_base_url');
    if (savedSearxng) setSearxngBaseUrl(savedSearxng);
  } catch {
    // 忽略读取失败，沿用当前地址
  }
  try {
    const raw = await AsyncStorage.getItem(MODEL_CFG_KEY);
    if (!raw) return defaultModelConfig();
    const parsed = JSON.parse(raw);
    const def = defaultModelConfig();
    return {
      priority: parsed.priority === 'api' ? 'api' : 'local',
      localModel: parsed.localModel || def.localModel,
      openrouterModel: parsed.openrouterModel || def.openrouterModel,
      openrouterApiKey: parsed.openrouterApiKey || '',
    };
  } catch {
    return defaultModelConfig();
  }
}

/** 持久化模型配置到本地缓存 */
export async function saveModelConfig(cfg: ModelConfig): Promise<void> {
  await AsyncStorage.setItem(MODEL_CFG_KEY, JSON.stringify(cfg));
}

/** 当前生效配置（内存缓存，避免每次读取 AsyncStorage） */
let _cfgCache: ModelConfig | null = null;

export async function currentConfig(): Promise<ModelConfig> {
  if (!_cfgCache) {
    _cfgCache = await loadModelConfig();
  }
  return _cfgCache;
}

export async function refreshConfig(): Promise<ModelConfig> {
  _cfgCache = await loadModelConfig();
  return _cfgCache;
}

export async function useOpenrouter(): Promise<boolean> {
  return (await currentConfig()).priority === 'api';
}

// ========== 流式事件类型 ==========

export type StreamEvent =
  | { type: 'thinking'; content: string }
  | { type: 'response'; content: string }
  | { type: 'tool_call'; name: string; arguments: string };

// ========== 优先级门控 ==========
//
// 目标：让用户主动触发的模型请求（交互式/流式）优先于后台批量分析（如历史日记
// 情绪/摘要补全）。Ollama 对同一模型默认串行队列，若后台补全不停发请求，会挤压
// 用户请求。这里用一个"活跃用户请求计数器"表达当前是否有用户请求在跑：
//   - 交互式流式入口（generateStream / chatToolsStream）在开始时 +1，结束/异常时 -1；
//   - 后台分析经 DefaultModelClient.call 每次调用前先 waitForUserRequestIdle()，
//     只要还有用户请求在跑就等待，用户请求结束即自动恢复。
let _activeUserRequests = 0;
let _idleWaiters: Array<() => void> = [];

function _notifyIdle(): void {
  if (_activeUserRequests > 0) return;
  const waiters = _idleWaiters;
  _idleWaiters = [];
  for (const fn of waiters) fn();
}

/** 标记一次用户交互式模型请求开始（计数 +1）。 */
export function beginUserRequest(): void {
  _activeUserRequests += 1;
}

/** 标记一次用户交互式模型请求结束（计数 -1，归零时唤醒等待者）。 */
export function endUserRequest(): void {
  if (_activeUserRequests > 0) _activeUserRequests -= 1;
  _notifyIdle();
}

/**
 * 低优先级调用（后台分析）在真正发请求前调用：等待所有用户请求结束再继续。
 * 带超时兜底，避免异常状态导致后台任务永久卡死。
 */
export async function waitForUserRequestIdle(timeoutMs = 120000): Promise<void> {
  if (_activeUserRequests <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      _idleWaiters = _idleWaiters.filter((fn) => fn !== done);
      resolve();
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    _idleWaiters.push(done);
  });
}

// ========== 非流式调用（Ollama /api/generate） ==========

export interface GenerateOptions {
  model?: string | null;
  system?: string;
  numPredict?: number;
  temperature?: number;
  seed?: number | null;
  jsonMode?: boolean;
  /** JSON Schema 对象，用于约束解码（Structured Outputs）。
   *  当设置此值时，会作为 `format` 参数传给 Ollama，比 jsonMode 更严格。 */
  jsonSchema?: Record<string, unknown>;
  think?: boolean;
  timeout?: number;
  /** 标记为用户交互式请求（高优先级）：期间会阻塞后台补全等低优先级调用。 */
  highPriority?: boolean;
}

/**
 * 非流式调用本地 Ollama，返回纯文本。
 * 对应 Python generate()。
 */
export async function generate(
  prompt: string,
  opts: GenerateOptions = {},
): Promise<string> {
  const highPriority = !!opts.highPriority;
  if (highPriority) beginUserRequest();
  try {
    const cfg = await currentConfig();
    const model = opts.model || cfg.localModel;
    const payload: Record<string, unknown> = {
      model,
      prompt,
      stream: false,
      think: opts.think ?? false,
      options: {
        temperature: opts.temperature ?? 0.4,
        num_predict: opts.numPredict ?? 2048,
        num_ctx: 4096,  // 降低上下文窗口，减少 Ollama 内存压力，避免多轮后 OOM
      },
    };
    if (opts.system) payload['system'] = opts.system;
    if (opts.jsonSchema) {
      payload['format'] = opts.jsonSchema;
    } else if (opts.jsonMode) {
      payload['format'] = 'json';
    }
    if (opts.seed != null) {
      (payload['options'] as Record<string, unknown>)['seed'] = opts.seed;
    }
    const timeoutMs = opts.timeout ?? 30000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(OLLAMA_URL(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`);
      const data = await resp.json();
      return String(data.response || '');
    } catch (e: any) {
      clearTimeout(timeoutId);
      if (e?.name === 'AbortError') {
        throw new Error(`Ollama 请求超时（${timeoutMs / 1000}秒未响应）`);
      }
      throw e;
    }
  } finally {
    if (highPriority) endUserRequest();
  }
}

// ========== 流式调用（Ollama /api/generate） ==========

/** 思考标题（用于手动标签解析） */
const THINKING_HEADERS = [
  'Thinking Process:',
  'Thinking:',
  '思考过程:',
  '思考:',
  'Let me think',
  "Let's analyze",
];
const TAG_OPEN = ' thinking';
const TAG_CLOSE = ' response';
const BUFFER_THRESHOLD = 50;

/**
 * 流式调用本地 Ollama，逐 chunk 生成，自动分离 thinking/response。
 * 对应 Python generate_stream()。
 */
export async function* generateStream(
  prompt: string,
  opts: GenerateOptions = {},
): AsyncGenerator<StreamEvent> {
  beginUserRequest();
  try {
    yield* _generateStreamInner(prompt, opts);
  } finally {
    endUserRequest();
  }
}

async function* _generateStreamInner(
  prompt: string,
  opts: GenerateOptions = {},
): AsyncGenerator<StreamEvent> {
  const cfg = await currentConfig();
  const model = opts.model || cfg.localModel;
  const payload: Record<string, unknown> = {
    model,
    prompt,
    system: opts.system || '',
    stream: true,
    think: opts.think ?? false,
    options: {
      num_predict: opts.numPredict ?? 2048,
      num_ctx: 4096,
      temperature: opts.temperature ?? 0.6,
    },
  };
  if (opts.jsonSchema) {
    payload['format'] = opts.jsonSchema;
  } else if (opts.jsonMode) {
    payload['format'] = 'json';
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  // 声明在 try 外，使 catch 之后的流式读取逻辑也能访问
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let streamTimeoutId: ReturnType<typeof setTimeout> | null = null;
  const decoder = new TextDecoder();
  let buffer = '';

  const readLine = async (): Promise<Record<string, unknown> | null> => {
    if (!reader) return null;
    while (true) {
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue; // 跳过空行，避免递归
        try {
          return JSON.parse(line);
        } catch {
          continue; // 跳过解析失败行，避免递归
        }
      }
      const { done, value } = await reader!.read();
      if (done) {
        if (buffer.trim()) {
          try {
            const parsed = JSON.parse(buffer);
            buffer = '';
            return parsed;
          } catch {
            buffer = '';
            return null;
          }
        }
        return null;
      }
      buffer += decoder.decode(value, { stream: true });
    }
  };

  try {
    const resp = await fetch(OLLAMA_URL(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`);
    if (!resp.body) return;

    reader = resp.body.getReader();
    // 流读取超时（120秒），防止 reader.read() 永久挂起
    streamTimeoutId = setTimeout(() => {
      if (reader) {
        try { reader.cancel(); } catch {}
      }
    }, 120000);
  } catch (e: any) {
    clearTimeout(timeoutId);
    if (e?.name === 'AbortError') {
      throw new Error('Ollama 请求超时（30秒未响应）');
    }
    throw e;
  }

  try {
    // think=False：直接逐 token 输出 response
    if (!(opts.think ?? false)) {
      let chunk: Record<string, unknown> | null;
      while ((chunk = await readLine()) !== null) {
        const token = String(chunk.response || '');
        if (token) yield { type: 'response', content: token };
        if (chunk.done) break;
      }
      return;
    }

    // think=True：状态机 detecting → thinking → response
    let state: 'detecting' | 'thinking' | 'response' = 'detecting';
    let rawBuffer = '';

    let chunk: Record<string, unknown> | null;
    while ((chunk = await readLine()) !== null) {
      // 1. Ollama 原生分离的 thinking 字段
      if (chunk.thinking) {
        if (state === 'detecting') state = 'response';
        yield { type: 'thinking', content: String(chunk.thinking) };
      }

      const rawResp = String(chunk.response || '');
      if (!rawResp) {
        if (chunk.done) break;
        continue;
      }

      if (state === 'detecting') {
        rawBuffer += rawResp;
        const stripped = rawBuffer.trimStart();
        if (rawBuffer.includes(TAG_CLOSE)) {
          const parts = rawBuffer.split(TAG_CLOSE, 1);
          const idx = rawBuffer.indexOf(TAG_CLOSE);
          let thinkingText = rawBuffer.slice(0, idx).replace(TAG_OPEN, '').trim();
          let responseText = rawBuffer.slice(idx + TAG_CLOSE.length).trim();
          for (const h of THINKING_HEADERS) {
            if (thinkingText.startsWith(h)) {
              thinkingText = thinkingText.slice(h.length).trim();
              break;
            }
          }
          if (thinkingText) yield { type: 'thinking', content: thinkingText };
          if (responseText) yield { type: 'response', content: responseText };
          state = 'response';
          rawBuffer = '';
        } else if (rawBuffer.length >= BUFFER_THRESHOLD) {
          const isThinking =
            THINKING_HEADERS.some((h) => stripped.startsWith(h)) ||
            stripped.startsWith(TAG_OPEN);
          if (isThinking) {
            let thinkingText = stripped;
            for (const h of THINKING_HEADERS) {
              if (thinkingText.startsWith(h)) {
                thinkingText = thinkingText.slice(h.length).trim();
                break;
              }
            }
            if (thinkingText.startsWith(TAG_OPEN)) {
              thinkingText = thinkingText.slice(TAG_OPEN.length).trim();
            }
            if (thinkingText) yield { type: 'thinking', content: thinkingText };
            state = 'thinking';
            rawBuffer = '';
          } else {
            yield { type: 'response', content: rawBuffer };
            state = 'response';
            rawBuffer = '';
          }
        }
      } else if (state === 'thinking') {
        if (rawResp.includes(TAG_CLOSE)) {
          const idx = rawResp.indexOf(TAG_CLOSE);
          const thinkingText = rawResp.slice(0, idx);
          const responseText = rawResp.slice(idx + TAG_CLOSE.length).trim();
          if (thinkingText) yield { type: 'thinking', content: thinkingText };
          if (responseText) yield { type: 'response', content: responseText };
          state = 'response';
        } else {
          yield { type: 'thinking', content: rawResp };
        }
      } else if (state === 'response') {
        yield { type: 'response', content: rawResp };
      }

      if (chunk.done) {
        if (rawBuffer && state === 'detecting') {
          yield { type: 'response', content: rawBuffer };
        }
        break;
      }
    }
  } finally {
    if (streamTimeoutId) clearTimeout(streamTimeoutId);
    if (reader) {
      try { reader.cancel(); } catch {}
    }
  }
}

// ========== 工具调用（Ollama /api/chat） ==========

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  images?: string[];
}

export interface ChatToolsOptions {
  model?: string | null;
  tools?: unknown[];
  think?: boolean;
  numPredict?: number;
  temperature?: number;
  timeout?: number;
}

/**
 * 最简单的统一流式生成：自动适配本地 Ollama 和远程 OpenRouter。
 * 输入 system + prompt，逐 token 输出 response，不涉及工具调用。
 * 用于 web search 后的第二轮回答等简单场景，避免 chatToolsStream 的复杂性。
 */
export async function* simpleStream(
  system: string,
  prompt: string,
  opts: { numPredict?: number; temperature?: number } = {},
): AsyncGenerator<{ type: 'response' | 'thinking'; content: string }> {
  beginUserRequest();
  try {
    const cfg = await currentConfig();
    const useRemote = cfg.priority === 'api';
    if (useRemote) {
      yield* _simpleStreamOpenRouter(system, prompt, opts);
    } else {
      yield* _simpleStreamLocal(system, prompt, opts);
    }
  } finally {
    endUserRequest();
  }
}

async function* _simpleStreamLocal(
  system: string,
  prompt: string,
  opts: { numPredict?: number; temperature?: number },
): AsyncGenerator<{ type: 'response' | 'thinking'; content: string }> {
  const cfg = await currentConfig();
  const payload: Record<string, unknown> = {
    model: cfg.localModel,
    prompt,
    system: system || '',
    stream: true,
    think: false,
    options: {
      num_predict: opts.numPredict ?? 8192,
      num_ctx: 4096,
      temperature: opts.temperature ?? 0.6,
    },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  let buffer = '';
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let streamTimeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    const resp = await fetch(OLLAMA_URL(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`);
    if (!resp.body) return;

    reader = resp.body.getReader();
    // 流读取超时（120秒），防止 reader.read() 永久挂起
    streamTimeoutId = setTimeout(() => {
      if (reader) {
        try { reader.cancel(); } catch {}
      }
    }, 120000);

    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            const token = String(obj.response || '');
            if (token) yield { type: 'response', content: token };
            if (obj.done) return;
          } catch {
            // skip malformed line
          }
        }
      }
    } finally {
      if (streamTimeoutId) clearTimeout(streamTimeoutId);
      if (reader) {
        try { reader.cancel(); } catch {}
      }
    }
    // flush remaining
    if (buffer.trim()) {
      try {
        const obj = JSON.parse(buffer.trim());
        const token = String(obj.response || '');
        if (token) yield { type: 'response', content: token };
      } catch { /* ignore */ }
    }
  } catch (e: any) {
    clearTimeout(timeoutId);
    if (streamTimeoutId) clearTimeout(streamTimeoutId);
    if (e?.name === 'AbortError') {
      throw new Error('Ollama 请求超时（30秒未响应）');
    }
    throw e;
  }
}

async function* _simpleStreamOpenRouter(
  system: string,
  prompt: string,
  opts: { numPredict?: number; temperature?: number },
): AsyncGenerator<{ type: 'response' | 'thinking'; content: string }> {
  const cfg = await currentConfig();
  if (!cfg.openrouterApiKey) throw new Error('未配置 OpenRouter API Key');

  const messages = [
    { role: 'system' as const, content: system || '' },
    { role: 'user' as const, content: prompt },
  ];

  const body: Record<string, unknown> = {
    model: cfg.openrouterModel,
    messages,
    stream: true,
    temperature: opts.temperature ?? 0.6,
    max_tokens: opts.numPredict ?? 8192,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  let resp: Response;
  try {
    resp = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.openrouterApiKey}`,
        'HTTP-Referer': 'https://atrium.os',
        'X-Title': 'Atrium OS',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) throw new Error(`OpenRouter HTTP ${resp.status}`);
    if (!resp.body) return;
  } catch (e: any) {
    clearTimeout(timeoutId);
    if (e?.name === 'AbortError') {
      throw new Error('OpenRouter 请求超时（30秒未响应）');
    }
    throw e;
  }

  const reader = resp!.body!.getReader();
  // 流读取超时（120秒），防止 reader.read() 永久挂起
  let streamTimeoutId3: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    try { reader.cancel(); } catch {}
  }, 120000);
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = block.split('\n').find(l => l.startsWith('data:'));
        if (!dataLine) continue;
        const dataStr = dataLine.slice(5).trim();
        if (dataStr === '[DONE]' || !dataStr) continue;
        try {
          const data = JSON.parse(dataStr);
          const delta = data.choices?.[0]?.delta || {};
          const content = String(delta.content || '');
          if (content) yield { type: 'response', content };
        } catch { /* skip */ }
      }
    }
  } finally {
    if (streamTimeoutId3) clearTimeout(streamTimeoutId3);
    try { reader.cancel(); } catch {}
  }
}

/**
 * 非流式调用本地 Ollama /api/chat，用于工具调用决策。
 *
 * 重要：Ollama 存在已知 bug —— stream=true + tools 会导致 Ollama 服务
 * 完全挂起，即使 /api/generate 也无法响应，直到服务重启。
 * 因此工具调用决策必须使用 stream=false，搜索后的回答再使用 stream=true。
 *
 * 返回 { content, toolCalls }，其中 toolCalls 为模型请求的工具调用列表。
 */
export async function chatTools(
  messages: ChatMessage[],
  opts: ChatToolsOptions = {},
): Promise<{ content: string; toolCalls: Array<{ name: string; arguments: string }> }> {
  const cfg = await currentConfig();
  const model = opts.model || cfg.localModel;
  const payload: Record<string, unknown> = {
    model,
    messages,
    stream: false,
    think: opts.think ?? false,
    options: {
      num_predict: opts.numPredict ?? 2048,
      num_ctx: 4096,
      temperature: opts.temperature ?? 0.6,
    },
  };
  if (opts.tools) payload['tools'] = opts.tools;

  const timeoutMs = opts.timeout ?? 60000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(OLLAMA_CHAT_URL(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`);
    const data = await resp.json();
    const msg = (data.message || {}) as Record<string, unknown>;
    const content = String(msg.content || '');
    const rawToolCalls = (msg.tool_calls || []) as Array<{
      function?: { name?: string; arguments?: unknown };
    }>;
    const toolCalls: Array<{ name: string; arguments: string }> = [];
    for (const tc of rawToolCalls) {
      const fn = tc.function || {};
      const name = String(fn.name || '');
      let args: string;
      if (typeof fn.arguments === 'string') {
        args = fn.arguments;
      } else if (fn.arguments && typeof fn.arguments === 'object') {
        args = JSON.stringify(fn.arguments);
      } else {
        args = '{}';
      }
      if (name) toolCalls.push({ name, arguments: args });
    }
    return { content, toolCalls };
  } catch (e: any) {
    clearTimeout(timeoutId);
    if (e?.name === 'AbortError') {
      throw new Error(`Ollama 请求超时（${timeoutMs / 1000}秒未响应）`);
    }
    throw e;
  }
}

/**
 * 流式调用本地 Ollama /api/chat，原生支持工具调用 + 思考分离。
 * 对应 Python chat_tools_stream()。
 */
export async function* chatToolsStream(
  messages: ChatMessage[],
  opts: ChatToolsOptions = {},
): AsyncGenerator<StreamEvent> {
  beginUserRequest();
  try {
    const cfg = await currentConfig();
    const useRemote = cfg.priority === 'api';
    if (useRemote) {
      yield* _chatToolsStreamOpenRouter(messages, opts);
    } else {
      yield* _chatToolsStreamInner(messages, opts);
    }
  } finally {
    endUserRequest();
  }
}

async function* _chatToolsStreamInner(
  messages: ChatMessage[],
  opts: ChatToolsOptions = {},
): AsyncGenerator<StreamEvent> {
  const cfg = await currentConfig();
  const model = opts.model || cfg.localModel;
  const payload: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    think: opts.think ?? false,
    options: {
      num_predict: opts.numPredict ?? 2048,
      num_ctx: 4096,
      temperature: opts.temperature ?? 0.6,
    },
  };
  if (opts.tools) payload['tools'] = opts.tools;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let streamTimeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    const resp = await fetch(OLLAMA_CHAT_URL(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`);
    if (!resp.body) return;

    reader = resp.body.getReader();
    // 流读取超时（120秒）：Ollama 处理工具调用时可能长时间无输出，
    // 若不加超时，reader.read() 会永久挂起，耗尽连接池，导致后续搜索全部失败
    streamTimeoutId = setTimeout(() => {
      if (reader) {
        try { reader.cancel(); } catch {}
      }
    }, 120000);

    const decoder = new TextDecoder();
    let buffer = '';

    const readLine = async (): Promise<Record<string, unknown> | null> => {
    while (true) {
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue; // 跳过空行，避免递归
        try {
          return JSON.parse(line);
        } catch {
          continue; // 跳过解析失败行，避免递归
        }
      }
      const { done, value } = await reader!.read();
      if (done) {
        if (buffer.trim()) {
          try {
            const parsed = JSON.parse(buffer);
            buffer = '';
            return parsed;
          } catch {
            buffer = '';
            return null;
          }
        }
        return null;
      }
      buffer += decoder.decode(value, { stream: true });
    }
  };

  try {
    let pendingTool: { name: string; arguments: string } | null = null;

    let chunk: Record<string, unknown> | null;
    while ((chunk = await readLine()) !== null) {
      const msg = (chunk.message || {}) as Record<string, unknown>;

      // 原生思考分离
      if (msg.thinking) {
        yield { type: 'thinking', content: String(msg.thinking) };
      }

      // 工具调用（参数可能跨 chunk 增量到达，累积；一旦出现即停止输出内容）
      const toolCalls = (msg.tool_calls || []) as Array<{
        function?: { name?: string; arguments?: unknown };
      }>;
      for (const tc of toolCalls) {
        const fn = tc.function || {};
        const name = String(fn.name || '');
        // arguments 可能是 JSON 字符串（流式增量），也可能是已解析的对象
        let args: string;
        if (typeof fn.arguments === 'string') {
          args = fn.arguments;
        } else if (fn.arguments && typeof fn.arguments === 'object') {
          args = JSON.stringify(fn.arguments);
        } else {
          args = '';
        }
        if (pendingTool && pendingTool.name === name) {
          pendingTool.arguments += args;
        } else {
          pendingTool = { name, arguments: args };
        }
      }

      // 出现工具调用后不再输出内容
      const content = String(msg.content || '');
      if (content && !pendingTool) {
        yield { type: 'response', content };
      }

      if (chunk.done) break;
    }

    if (pendingTool) {
      yield { type: 'tool_call', name: pendingTool.name, arguments: pendingTool.arguments };
    }
  } finally {
    if (streamTimeoutId) clearTimeout(streamTimeoutId);
    if (reader) {
      try { reader.cancel(); } catch {}
    }
  }
} catch (e: any) {
  clearTimeout(timeoutId);
  if (streamTimeoutId) clearTimeout(streamTimeoutId);
  if (e?.name === 'AbortError') {
    throw new Error('Ollama 请求超时（30秒未响应）');
  }
  throw e;
}
}

// ========== OpenRouter 工具调用流式 ==========

/**
 * 流式调用 OpenRouter /chat/completions（OpenAI 兼容格式），支持工具调用。
 * 解析 SSE 流，提取 content、tool_calls 等增量。
 */
async function* _chatToolsStreamOpenRouter(
  messages: ChatMessage[],
  opts: ChatToolsOptions = {},
): AsyncGenerator<StreamEvent> {
  const cfg = await currentConfig();
  const model = opts.model || cfg.openrouterModel;
  const apiKey = cfg.openrouterApiKey;
  if (!apiKey) throw new Error('未配置 OpenRouter API Key');

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    temperature: opts.temperature ?? 0.6,
    max_tokens: opts.numPredict ?? 2048,
  };
  if (opts.tools) body['tools'] = opts.tools;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  let resp: Response;
  try {
    resp = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://atrium.os',
        'X-Title': 'Atrium OS',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) throw new Error(`OpenRouter HTTP ${resp.status}`);
    if (!resp.body) return;
  } catch (e: any) {
    clearTimeout(timeoutId);
    if (e?.name === 'AbortError') {
      throw new Error('OpenRouter 请求超时（30秒未响应）');
    }
    throw e;
  }

  const reader = resp!.body!.getReader();
  // 流读取超时（120秒），防止 reader.read() 永久挂起
  let streamTimeoutId2: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    try { reader.cancel(); } catch {}
  }, 120000);
  const decoder = new TextDecoder();
  let buffer = '';

  const readEvent = async (): Promise<{ event: string; data: string } | null> => {
    while (true) {
      const idx = buffer.indexOf('\n\n');
      if (idx !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = block.split('\n').filter(l => l.trim());
        let eventName = 'data';
        let dataStr = '';
        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataStr = line.slice(5).trim();
          }
        }
        if (dataStr === '[DONE]') return null;
        if (dataStr) return { event: eventName, data: dataStr };
        continue;
      }
      const { done, value } = await reader.read();
      if (done) {
        if (buffer.trim()) {
          // fallback: try to parse remaining buffer
          const line = buffer.trim();
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6).trim();
            if (dataStr !== '[DONE]' && dataStr) return { event: 'data', data: dataStr };
          }
        }
        return null;
      }
      buffer += decoder.decode(value, { stream: true });
    }
  };

  try {
    let pendingTool: { name: string; arguments: string } | null = null;

    let ev: { event: string; data: string } | null;
    while ((ev = await readEvent()) !== null) {
      try {
        const data = JSON.parse(ev.data);
        const choice = data.choices?.[0];
        const delta = choice?.delta || {};

        // 内容增量
        const content = String(delta.content || '');
        if (content && !pendingTool) {
          yield { type: 'response', content };
        }

        // 工具调用增量（arguments 可能是 JSON 字符串（流式增量），也可能是已解析的对象）
        const toolCalls = delta.tool_calls || [];
        for (const tc of toolCalls) {
          const fn = tc.function || {};
          const name = String(fn.name || '');
          let args: string;
          if (typeof fn.arguments === 'string') {
            args = fn.arguments;
          } else if (fn.arguments && typeof fn.arguments === 'object') {
            args = JSON.stringify(fn.arguments);
          } else {
            args = '';
          }
          if (name) {
            if (pendingTool && pendingTool.name === name) {
              pendingTool.arguments += args;
            } else {
              pendingTool = { name, arguments: args };
            }
          } else if (pendingTool && args) {
            pendingTool.arguments += args;
          }
        }

        if (choice?.finish_reason) break;
      } catch {
        // 忽略解析失败的 chunk
      }
    }

    if (pendingTool) {
      yield { type: 'tool_call', name: pendingTool.name, arguments: pendingTool.arguments };
    }
  } finally {
    if (streamTimeoutId2) clearTimeout(streamTimeoutId2);
    try { reader.cancel(); } catch {}
  }
}

// ========== OpenRouter（OpenAI 兼容） ==========

/**
 * 非流式调用 OpenRouter（OpenAI 兼容接口）。
 * 对应 Python _call_openrouter 的调用约定。
 */
export async function generateOpenrouter(
  prompt: string,
  system: string,
  opts: { model?: string | null; jsonMode?: boolean; numPredict?: number } = {},
): Promise<string> {
  const cfg = await currentConfig();
  const model = opts.model || cfg.openrouterModel;
  const apiKey = cfg.openrouterApiKey;
  if (!apiKey) throw new Error('未配置 OpenRouter API Key');

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
  };
  if (opts.jsonMode) body['response_format'] = { type: 'json_object' };
  if (opts.numPredict) body['max_tokens'] = opts.numPredict;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) throw new Error(`OpenRouter HTTP ${resp.status}`);
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content || '';
  } catch (e: any) {
    clearTimeout(timeoutId);
    if (e?.name === 'AbortError') {
      throw new Error('OpenRouter 请求超时（30秒未响应）');
    }
    throw e;
  }
}

// ========== ModelClient 实现（供分析管线使用） ==========

/**
 * 统一 ModelClient：根据配置的 priority 自动路由 local / api。
 * 使用非流式调用（分析管线不需要流式）。
 */
export class DefaultModelClient implements ModelClient {
  private _cfgPromise: Promise<ModelConfig>;

  constructor() {
    this._cfgPromise = currentConfig();
  }

  async useOpenrouterGlobal(): Promise<boolean> {
    return (await this._cfgPromise).priority === 'api';
  }

  useOpenrouter(): boolean {
    // 同步接口：读取内存缓存（可能尚未加载，回退默认 local）
    return (_cfgCache?.priority ?? 'local') === 'api';
  }

  async call(prompt: string, system: string, options?: ModelCallOptions): Promise<ModelResult> {
    // 低优先级调用（后台分析/补全）：先等所有用户交互请求结束，保证用户请求优先。
    await waitForUserRequestIdle();
    const cfg = await currentConfig();
    const jsonMode = options?.jsonMode ?? false;
    const jsonSchema = options?.jsonSchema ?? undefined;
    const numPredict = options?.numPredict ?? (jsonMode || jsonSchema ? 1024 : 2048);
    const temperature = options?.temperature ?? (jsonMode || jsonSchema ? 0.1 : 0.4);
    const seed = options?.seed ?? null;
    const model = options?.model || null;

    const useRemote = cfg.priority === 'api';

    let response: string;
    let thinking: string | undefined;

    if (useRemote) {
      response = await generateOpenrouter(prompt, system, {
        model,
        jsonMode,
        numPredict,
      });
    } else {
      // 本地 Ollama：非流式调用，missing thinking（分析任务用不上）
      response = await generate(prompt, {
        model,
        system,
        numPredict,
        temperature,
        seed,
        jsonMode,
        jsonSchema,
      });
    }

    return { response, thinking };
  }
}

// 单例
let _client: DefaultModelClient | null = null;

export function getModelClient(): DefaultModelClient {
  if (!_client) _client = new DefaultModelClient();
  return _client;
}

/** 供模型配置变更后刷新内存缓存 */
export function resetModelClient(): void {
  _cfgCache = null;
  _client = null;
}