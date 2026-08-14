/**
 * local/chat.ts — 手机端本地会话与共情聊天服务（Phase 5）
 *
 * 与 api/chat.ts 保持完全相同的函数签名与事件类型，
 * 但内部改用 core 层：
 *  - 会话 CRUD → core/db/diaryDb.ts 本地 SQLite
 *  - 流式聊天 → core/modelService.ts（generateStream / chatToolsStream）
 *    + core/prompts.ts（共情系统提示词）+ core/utils/chatUtils.ts（历史构建）
 *    + core/utils/webSearch.ts（联网搜索）
 *
 * 页面只需把 `../api/chat` 改为 `../local/chat` 即可无缝切换。
 */

import { getDiaryStorage } from '../core/db/diaryDb';
import { generate, generateStream, ChatMessage as ModelChatMessage } from '../core/modelService';
import { buildEmpathySystem, buildAwarenessSystem, buildGreetingSystem } from '../core/prompts';
import { buildUnifiedHistory } from '../core/utils/chatUtils';
import { trySearch, SearchContext } from '../core/utils/searchHelper';

// 与 api/chat.ts 一致的类型
export interface ChatMessage {
  role: string;
  content: string;
  thinking?: string;
  diaryDate?: string;
  timestamp?: number;
  sources?: { index: number; title: string; url: string }[];
}

export interface ChatSession {
  id: string;
  title: string;
  date: string;
  created_at: string;
}

export interface StreamChunk {
  type: string;
  content: string;
  query?: string;
  count?: number;
  speaker?: string;
  speaker_name?: string;
  results?: { title: string; url: string; content?: string }[];
}

const USER_ID = 'default';

/** 获取某日期的会话列表 */
export function getSessions(date: string): ChatSession[] {
  const sessions = getDiaryStorage().getSessionsByDate(date, USER_ID);
  return sessions.map((s) => ({
    id: s.id,
    title: s.title,
    date: s.date,
    created_at: s.created_at,
  }));
}

/** 创建会话 */
export function createSession(date: string, title: string): ChatSession {
  const s = getDiaryStorage().createSession(date, title, USER_ID);
  return { id: s.id, title: s.title, date: s.date, created_at: s.created_at };
}

/** 获取会话消息 */
export function getSessionMessages(sessionId: string): ChatMessage[] {
  const msgs = getDiaryStorage().getMessages(sessionId);
  return msgs.map((m) => {
    const sources = (m.sources as { index: number; title: string; url: string }[]) || undefined;
    if (sources && sources.length > 0) {
      console.log(`[getSessionMessages] 加载到 ${sources.length} 条引用来源:`, sources.map(s => `[${s.index}] ${s.title}`).join(', '));
    }
    return {
      role: m.role,
      content: m.content,
      thinking: m.thinking || undefined,
      diaryDate: m.diary_date || undefined,
      timestamp: m.timestamp ? Number(m.timestamp) : undefined,
      sources,
    };
  });
}

/** 保存一条消息 */
export function saveMessage(sessionId: string, role: string, content: string, thinking = '', diaryDate = '', sources?: { index: number; title: string; url: string }[]) {
  const sourcesJson = sources ? JSON.stringify(sources) : '';
  if (sources && sources.length > 0) {
    console.log(`[saveMessage] 保存 ${sources.length} 条引用来源:`, sources.map(s => `[${s.index}] ${s.title}`).join(', '));
  }
  getDiaryStorage().addMessage(sessionId, role, content, thinking, diaryDate, sourcesJson);
  return { success: true };
}

/** 按标题查找会话 */
export function getSessionByTitle(title: string): ChatSession | null {
  const s = getDiaryStorage().getSessionByTitle(title, USER_ID);
  if (!s) return null;
  return { id: s.id, title: s.title, date: s.date, created_at: s.created_at };
}

/**
 * 流式聊天编排器（本地实现）
 *
 * 与 api/chat.ts 的 streamChat 相同的事件结构：
 *  - { type: 'thinking', content }        思考过程
 *  - { type: 'response', content }        回复内容 token
 *  - { type: 'search_query', query }      正在联网搜索
 *  - { type: 'search_done', count }       搜索完成
 *  - { type: 'search_skip' }              本次无需搜索
 *  - { type: 'search_error' }             搜索失败
 *
 * mode: 'empathy' | 'awareness' | 'chatroom'（共情/觉察走本编排，聊天室另有 streamChatroom）
 */
export async function* streamChat(
  message: string,
  sessionId: string | null,
  date: string,
  mode: string = 'empathy',
  extraContext?: string,
  injectDiary: boolean = true,
  historyLimit?: number,
): AsyncGenerator<StreamChunk> {
  const storage = getDiaryStorage();

  // 1. 构建系统提示词（共情/觉察模式使用不同身份）
  const system = mode === 'awareness' ? buildAwarenessSystem(null) : buildEmpathySystem(null);

  // 2. 构建统一历史（仅共情/觉察模式注入历史）
  let historyText = '';
  if (mode === 'empathy' || mode === 'awareness') {
    if (sessionId) {
      historyText = buildUnifiedHistory(sessionId, storage, historyLimit ?? null);
    }
  }

  // 3. 注入当天日记（仅 injectDiary 场景）
  let diaryBlock = '';
  if (injectDiary && date) {
    const diary = storage.getDiaryByDate(date, USER_ID);
    if (diary && diary.content) {
      diaryBlock = `\n\n【当天日记】\n${stripHtmlSafe(diary.content)}`;
    }
  }

  // 4. 额外上下文
  const extra = extraContext ? `\n\n【额外上下文】\n${extraContext}` : '';

  // 5. 组装用户 prompt
  const fullPrompt = message + diaryBlock + extra;

  // 6. 注入当前时间（时效性）
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const systemWithTime = `${system}\n\n【当前时间】${dateStr}`;

  // 7. 组装 messages（含历史）
  const messages = buildChatMessages(systemWithTime, historyText, fullPrompt);

  // 8. 公共搜索方法：判断是否需要联网搜索，如需要则执行搜索
  //    所有 AI（共情/觉察/气氛组）共用此逻辑
  const searchCtx: SearchContext = { searched: false, searchResults: [], searchBlock: '' };
  for await (const ev of trySearch(messages, systemWithTime, message, searchCtx)) {
    if (ev.type === 'search_query') {
      yield { type: 'search_query', query: ev.query, content: '' };
    } else if (ev.type === 'search_done') {
      yield { type: 'search_done', count: ev.count, content: '', results: ev.results };
    } else if (ev.type === 'search_skip') {
      yield { type: 'search_skip', content: '' };
    } else if (ev.type === 'search_error') {
      yield { type: 'search_error', content: ev.content };
    }
  }

  // 9. 生成回复（统一用 generateStream，保持 AI 人格和上下文完整）
  //    有搜索结果 → 在原始 prompt 后追加搜索结果（不替换、不丢失上下文）
  //    无搜索结果 → 直接用原始 prompt
  //    觉察助手 think=true，共情助手 think=false
  const finalPrompt = searchCtx.searched
    ? `${fullPrompt}\n\n【联网搜索结果】\n${searchCtx.searchBlock}\n\n请结合以上搜索结果回答用户的问题（引用时用[序号]标注）。`
    : fullPrompt;

  try {
    for await (const ev of generateStream(finalPrompt, {
      system: systemWithTime,
      think: mode === 'awareness',  // 觉察助手 think=true
      numPredict: mode === 'awareness' ? 24576 : 8192,  // think 时需要更多预算（思考+回复共用）
      temperature: 0.6,
    })) {
      if (ev.type === 'thinking') {
        yield { type: 'thinking', content: ev.content };
      } else if (ev.type === 'response') {
        yield { type: 'response', content: ev.content };
      }
    }
  } catch (e) {
    console.error('[streamChat] generateStream 失败:', e);
    yield { type: 'response', content: '抱歉，连接模型服务时出现错误，请检查网络连接或模型服务是否正常运行。' };
  }
}

/** 构建聊天室置顶系统消息 + 历史 + 当前消息 */
function buildChatMessages(
  system: string,
  historyText: string,
  userPrompt: string,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  messages.push({ role: 'system', content: system });

  // 解析统一历史 JSON（[{"speaker":"用户","content":"..."}, ...]）为 messages
  if (historyText) {
    try {
      const history = JSON.parse(historyText);
      if (Array.isArray(history)) {
        for (const h of history) {
          const speaker = h.speaker || '';
          const content = h.content || '';
          if (!content) continue;
          if (speaker === '用户') {
            messages.push({ role: 'user', content });
          } else {
            messages.push({ role: 'assistant', content });
          }
        }
      }
    } catch {
      // 历史解析失败则忽略
    }
  }

  messages.push({ role: 'user', content: userPrompt });
  return messages;
}
function stripHtmlSafe(text: string): string {
  if (!text) return '';
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .trim();
}

/** 生成问候（本地实现，非流式） */
export async function generateGreeting(date: string, sessionId: string): Promise<{ reply: string; thinking: string }> {
  const storage = getDiaryStorage();
  const diary = storage.getDiaryByDate(date, USER_ID);
  const diaryContent = diary ? stripHtmlSafe(diary.content) : '';
  const system = buildGreetingSystem();
  const prompt = `用户今天写了一篇日记：\n${diaryContent}\n\n请以朋友的身份回应几句。`;
  const reply = await generate(prompt, { system, numPredict: 2048, temperature: 0.6, highPriority: true });
  return { reply, thinking: '' };
}

/** 触发问候（本地：直接生成并写入会话） */
export async function triggerGreeting(date: string, sessionId: string) {
  const { reply, thinking } = await generateGreeting(date, sessionId);
  if (reply) {
    getDiaryStorage().addMessage(sessionId, 'assistant', reply, thinking, date);
  }
  return { success: true };
}

/** 订阅问候（本地实现：直接返回已生成内容；移动端不依赖 SSE 长连接） */
export async function* subscribeGreeting(sessionId: string): AsyncGenerator<{ type: string; content: string }> {
  const msgs = getDiaryStorage().getMessages(sessionId);
  const last = msgs[msgs.length - 1];
  if (last && last.role === 'assistant') {
    yield { type: 'response', content: last.content };
  }
  yield { type: 'done', content: '' };
}