/**
 * chatUtils.ts — 手机端对话历史工具（TypeScript 重写）
 *
 * 逐字等价复刻 Python 版 server/chat_utils.py：
 *  - 角色到说话人名称映射（所有 AI 共享同一套说话人名称）
 *  - HTML 剥离（含 <img> 内嵌 base64，防撑爆 LLM prompt）
 *  - 统一格式 history_text 的构建与解析
 */
import { DiaryStorage } from '../db/diaryDb';

/** 返回当前 ISO 时间字符串（本地时间，兼容 Python datetime.now().isoformat()）。 */
export function nowIso(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${String(d.getMilliseconds()).padStart(3, '0')}`
  );
}

// 角色到说话人名称的映射（所有AI共享同一套说话人名称）
export const ROLE_TO_SPEAKER: Record<string, string> = {
  user: '用户',
  assistant: '共情助手',
  insight: '觉察伙伴',
  big_brother: '鳄正经',
  second_brother: '鹅小弟',
  little_sister: '鹿晓葵',
};

export const SPEAKER_TO_ROLE: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const k of Object.keys(ROLE_TO_SPEAKER)) {
    m[ROLE_TO_SPEAKER[k]] = k;
  }
  return m;
})();

/** 剥离富文本日记中的 HTML 标签（含 <img> 及其内嵌 base64 data URI），
 *  避免图片数据撑爆 LLM prompt。保留可见文本与常见实体还原。 */
export function stripHtml(text: string | null | undefined): string {
  if (!text) return '';
  let t = text;
  t = t.replace(/<[^>]+>/g, '');
  t = t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  t = t.replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return t.trim();
}

/** 从 session 加载消息，返回统一格式的 history_text (JSON 字符串)
 *
 *  格式: [{"speaker": "用户", "content": "..."}, {"speaker": "共情助手", "content": "..."}]
 *  所有AI（共情助手、觉察伙伴、聊天室三人组）共用此格式。
 */
export function buildUnifiedHistory(
  sessionId: string,
  storage: DiaryStorage,
  maxMessages: number | null = null,
): string {
  let msgs = storage.getMessages(sessionId);
  if (maxMessages && msgs.length > maxMessages) {
    msgs = msgs.slice(-maxMessages);
  }
  const history: Array<{ speaker: string; content: string }> = [];
  for (const m of msgs) {
    const role = m.role || '';
    const speaker = ROLE_TO_SPEAKER[role] || role;
    const content = m.content || '';
    if (content) {
      history.push({ speaker, content });
    }
  }
  return JSON.stringify(history);
}

/** 将内部历史列表 [{role, content}] 转为统一格式的 JSON 字符串
 *
 *  用于聊天室等需要在内存中维护历史的场景。
 */
export function buildUnifiedHistoryFromList(
  history: Array<Record<string, unknown>>,
): string {
  const unified: Array<{ speaker: string; content: string }> = [];
  for (const msg of history) {
    const role = String(msg.role || '');
    const speaker = ROLE_TO_SPEAKER[role] || role;
    const content = String(msg.content || '');
    if (content) {
      unified.push({ speaker, content });
    }
  }
  return JSON.stringify(unified);
}

/** 将统一格式的 history_text (JSON 字符串) 转为 LLM 可读的文本
 *
 *  输出格式:
 *  用户: 你好
 *  共情助手: 你好啊
 *  鳄正经: ...
 */
export function formatHistoryReadable(historyText: string): string {
  let history: Array<Record<string, unknown>>;
  try {
    history = typeof historyText === 'string' ? JSON.parse(historyText) : (historyText as unknown as Array<Record<string, unknown>>);
  } catch {
    return '（对话历史解析失败）';
  }
  if (!Array.isArray(history) || !history.length) {
    return historyText === '' ? '（这是对话的开始）' : '（对话历史解析失败）';
  }
  const lines: string[] = [];
  for (const msg of history) {
    const speaker = String(msg.speaker || '');
    const content = String(msg.content || '');
    if (content) {
      lines.push(`${speaker}: ${content}`);
    }
  }
  return lines.join('\n');
}

/** 从统一格式的 history_text 中获取最后说话者的名称
 *
 *  返回说话人名称（如 "鳄正经"），空字符串表示无历史。
 */
export function getLastSpeaker(historyText: string): string {
  let history: Array<Record<string, unknown>>;
  try {
    history = typeof historyText === 'string' ? JSON.parse(historyText) : (historyText as unknown as Array<Record<string, unknown>>);
  } catch {
    return '';
  }
  if (!Array.isArray(history) || !history.length) {
    return '';
  }
  const last = history[history.length - 1];
  return last && last.speaker ? String(last.speaker) : '';
}