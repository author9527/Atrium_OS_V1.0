/**
 * searchHelper.ts — 公共联网搜索方法，供所有 AI（共情/觉察/气氛组）复用
 *
 * 设计要点：
 * 1. 使用 LLM 判断是否需要搜索（兼容 Ollama 和 OpenRouter）
 *    —— 通过 getModelClient().call() 统一调用，自动适配本地/远程模式
 * 2. 仅负责"判断是否搜索 + 执行搜索"，不负责生成回复
 *    —— 调用方根据 ctx.searched 决定后续如何生成回复
 * 3. 气氛组仅在回复阶段调用此方法，冲动值判断阶段不调用
 *
 * 修复历史：
 *   旧方案用 generate() 做 LLM 搜索决策，存在三个问题：
 *   a) generate() 只走 Ollama /api/generate，OpenRouter 模式下完全不可用
 *   b) num_predict:64 太小，Qwen3 等模型生成 <think> 标签后 token 耗尽
 *   c) 模型输出格式不保证严格匹配正则，静默跳过搜索
 *   修复方案：
 *   a) 改用 getModelClient().call()，自动适配 Ollama / OpenRouter
 *   b) numPredict 提升到 256，jsonMode 强制 JSON 输出
 *   c) jsonMode 保证输出为合法 JSON，正则提取再 parse，双重保障
 */

import { getModelClient } from '../modelService';
import { webSearch, formatSearchResults } from './webSearch';

// 搜索上下文：调用方创建，trySearch 填充结果
export interface SearchContext {
  searched: boolean;
  searchResults: { index: number; title: string; url: string }[];
  searchBlock: string;
}

// 搜索事件类型（与各页面的 StreamChunk 兼容）
export type SearchEvent =
  | { type: 'search_query'; query: string }
  | { type: 'search_done'; count: number; results: { title: string; url: string; content?: string }[] }
  | { type: 'search_skip' }
  | { type: 'search_error'; content: string };

// ==========================================
// 搜索决策系统提示词（中性，不含 AI 人格）
// ==========================================

const SEARCH_DECISION_SYSTEM = `你是一个搜索决策助手。你的任务是判断用户的消息是否需要联网搜索。

需要搜索的情况：
- 事实核查：用户询问某个说法是否属实、辟谣
- 时事新闻：用户询问最新、最近发生的事件或新闻
- 用户明确或隐含地要求联网搜索信息（如"帮我查""搜一下"）
- 涉及时效性内容：最新版本、当前价格行情、最新政策法规
- 人物/机构动态：宣布、声明、就任、辞职等

不需要搜索的情况：
- 用户倾诉情绪、分享感受、讨论人际关系
- 用户讨论个人成长、内心感受、日记内容
- 基于常识即可回答的通用知识
- 闲聊、问候、日常对话

query 必须是精简的关键词组合，用空格分隔：
- 去掉口语化虚词（什么、那个、这个、就是）、疑问词（吗、呢、怎么、为什么）、语气词
- 不要用完整句子，用关键词组合
- 例如：用户说"最近那个什么 AI 写代码的叫什么 Copilot 还是 Cursor" → query: "AI 写代码工具 Copilot Cursor"
- 例如：用户说"帮我查一下今天北京的天气怎么样" → query: "北京 天气 今天"

只输出JSON，不要其他内容：
{"need_search": true, "query": "精简关键词"}
或
{"need_search": false}`;

// ==========================================
// LLM 搜索决策
// ==========================================

/**
 * 从对话消息中提取最近几条作为上下文（最多 6 条，控制 token 用量）。
 */
function buildRecentContext(
  messages: unknown[],
  userMessage: string,
): string {
  interface MsgLike { role?: string; content?: string }
  const msgs = (messages || []) as MsgLike[];
  // 取最后 6 条（不含系统消息），拼成可读上下文
  const recent = msgs
    .filter(m => m.role && m.role !== 'system' && m.content)
    .slice(-6);
  if (recent.length === 0) {
    return `用户消息：${userMessage}`;
  }
  const lines = recent.map(m => {
    const speaker = m.role === 'user' ? '用户' : 'AI';
    return `${speaker}：${m.content}`;
  });
  return `最近对话：\n${lines.join('\n')}\n\n用户最新消息：${userMessage}`;
}

/**
 * 调用 LLM 判断是否需要联网搜索。
 * 返回 { needSearch, query }。
 */
async function decideSearch(
  messages: unknown[],
  userMessage: string,
): Promise<{ needSearch: boolean; query: string }> {
  const contextText = buildRecentContext(messages, userMessage);

  const client = getModelClient();
  const result = await client.call(
    contextText,
    SEARCH_DECISION_SYSTEM,
    {
      jsonMode: true,
      numPredict: 256,
      temperature: 0.1,
    },
  );

  const raw = result.response || '';
  // 双重保障：先尝试直接 parse，失败则正则提取 JSON 块
  let data: { need_search?: boolean; query?: string } | null = null;
  try {
    data = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*?"need_search"[\s\S]*?\}/);
    if (match) {
      try {
        data = JSON.parse(match[0]);
      } catch {
        // 仍然失败，放弃
      }
    }
  }

  if (!data) {
    return { needSearch: false, query: '' };
  }

  return {
    needSearch: Boolean(data.need_search),
    query: String(data.query || '').trim(),
  };
}

// ==========================================
// 公共搜索方法
// ==========================================

/**
 * 公共搜索方法：用 LLM 判断是否需要搜索，如需要则执行搜索。
 *
 * 调用方式：
 *   const ctx: SearchContext = { searched: false, searchResults: [], searchBlock: '' };
 *   for await (const ev of trySearch(messages, system, userMessage, ctx)) {
 *     // 转发 ev 给上层
 *   }
 *   if (ctx.searched) { // 用 ctx.searchBlock 注入回复 }
 *
 * 判断方式：LLM 决策（通过 getModelClient().call()，兼容 Ollama 和 OpenRouter）
 */
export async function* trySearch(
  messages: unknown[],
  _systemPrompt: string,
  userMessage: string,
  ctx: SearchContext,
): AsyncGenerator<SearchEvent> {
  ctx.searched = false;
  ctx.searchResults = [];
  ctx.searchBlock = '';

  if (!userMessage || userMessage.trim().length < 2) return;

  // LLM 搜索决策
  let needSearch = false;
  let query = '';
  try {
    const decision = await decideSearch(messages, userMessage);
    needSearch = decision.needSearch;
    query = decision.query;
  } catch (e) {
    console.warn('[trySearch] LLM搜索决策失败，跳过搜索:', e);
    return; // LLM 调用失败，安全跳过
  }

  if (!needSearch) return;
  // query 为空时回退到用户消息前 80 字
  if (!query) query = userMessage.trim().slice(0, 80);

  console.log(`[trySearch] LLM决定搜索: "${query}"`);
  yield* executeSearch(query, ctx);
}

/** 执行搜索并填充 ctx */
async function* executeSearch(
  query: string,
  ctx: SearchContext,
): AsyncGenerator<SearchEvent> {
  yield { type: 'search_query', query };
  try {
    const results = await webSearch(query);
    if (results.length > 0) {
      ctx.searched = true;
      ctx.searchResults = results.map((r, i) => ({
        index: i + 1,
        title: String(r.title || ''),
        url: String(r.url || ''),
      }));
      ctx.searchBlock = formatSearchResults(results);
      yield {
        type: 'search_done',
        count: results.length,
        results: results as { title: string; url: string; content?: string }[],
      };
    } else {
      console.log(`[executeSearch] 搜索"${query}"返回空结果，触发 search_skip`);
      yield { type: 'search_skip' };
    }
  } catch (e) {
    yield { type: 'search_error', content: String((e as any)?.message || '搜索失败') };
  }
}
