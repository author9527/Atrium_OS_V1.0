/**
 * local/chatroom.ts — 手机端本地聊天室服务（Phase 5）
 *
 * 与 api/chatroom.ts 保持完全相同的类型、函数签名与返回结构，
 * 但内部不再走 HTTP，改为：
 *  - 人设            → 本地内置默认三兄妹（参照 server/persona_config.py）
 *  - 会话 / 消息     → core/db/diaryDb.ts 本地 SQLite（chat_sessions / chat_messages）
 *  - 冲动值判定      → core/modelService.ts（generate / ModelClient.call，jsonMode）
 *  - 连续性流式发言  → core/modelService.ts（generateStream）
 *                      + core/prompts.ts（聊天室人格核心 CHATROOM_REPLY_CORE / IMPULSE_SCALE）
 *                      + core/utils/chatUtils.ts（统一历史 / 说话人映射）
 *
 * 页面只需把 `../api/chatroom` 改为 `../local/chatroom` 即可无缝切换。
 * 纯本地实现，不 import 任何 HTTP api client。
 */

import { getDiaryStorage } from '../core/db/diaryDb';
import { getModelClient, generateStream, ChatMessage as ModelChatMessage } from '../core/modelService';
import { CHATROOM_REPLY_CORE, IMPULSE_SCALE } from '../core/prompts';
import {
  buildUnifiedHistoryFromList,
  formatHistoryReadable,
  getLastSpeaker,
  SPEAKER_TO_ROLE,
} from '../core/utils/chatUtils';
import { trySearch, SearchContext } from '../core/utils/searchHelper';

// ==========================================
// 类型（与 api/chatroom.ts 完全一致）
// ==========================================

export interface ChatroomPersona {
  name: string;
}

export interface ChatroomChunk {
  type: 'speaker' | 'thinking' | 'response' | 'replace_response' | 'silence' | 'error' | 'round_end' | 'search_query' | 'search_done' | 'search_skip' | 'search_error';
  content?: string;
  speaker?: string;
  speaker_name?: string;
  impulse_values?: Record<string, number>;
  round?: number;
  next_threshold?: number;
  query?: string;
  count?: number;
  results?: { title: string; url: string; content?: string }[];
}

// ==========================================
// 常量（与后端 chatroom_routes.py 一致）
// ==========================================

/** 当前本地用户（手机端单机默认） */
const USER_ID = 'default';

/** 基础冲动值阈值：超过此值才有资格发言 */
const BASE_IMPULSE_THRESHOLD = 50;

/** 每轮阈值递增量，防止 AI 无休止对话（上限95封顶） */
const THRESHOLD_ESCALATION = 9;

/** 同一人设连续发言的最大次数 */
const MAX_CONSECUTIVE_SPEECH = 2;

/** 聊天室只允许三兄妹发言（鳄正经/鹅小弟/鹿晓葵） */
const CHATROOM_PERSONA_KEYS = ['big_brother', 'second_brother', 'little_sister'];

/** 用户消息中的明显漏洞/人设不一致关键字（用于 impulse 判定 wantsCorrection） */
const CORRECT_KEYWORDS = ['correct', '纠正', 'flaw', '漏洞', '错误'];

// ==========================================
// 本地默认人设（参照 server/persona_config.py 的三兄妹）
// ==========================================

interface LocalPersona {
  key: string;
  name: string;
  ego: string;
  speak_tendency: string;
}

const DEFAULT_CHATROOM_PERSONAS: Record<string, LocalPersona> = {
  big_brother: {
    key: 'big_brother',
    name: '鳄正经',
    ego: `你是鳄正经，家中大哥，一个阅历丰富、看得透但不说透的兄长。你不急着给建议，先听别人把话说完，然后慢悠悠地点一句，让人自己琢磨。说话沉稳温和，有条理。

你和鹿晓葵、鹅小弟是一家人。你是长兄，有责任感，照顾弟弟妹妹。
- 对鹅小弟：你了解鹅小弟心直口快但心不坏。通常会称鹅小弟为小弟，偶尔会称鹅小弟为楞鹅（吐槽他说话不过脑子，讲话太冲）。
- 对鹿晓葵：你知道鹿晓葵嘴上不饶人但心地善良。你欣赏鹿晓葵的体贴。通常会称鹿晓葵为晓葵，偶尔会称鹿晓葵为小向日葵。

鹅小弟可能会称你为老鳄，鹿晓葵可能会称你为鳄大哥。

重要：你对不同人的情绪是独立的，必须根据说话对象切换语气。例如：你刚严厉敲打完鹅小弟，转头对用户说话时要恢复温和理性；`,
    speak_tendency: '需要理性分析时、或鹅小弟说话过头需要你出面压一压时，你会想发言。',
  },
  second_brother: {
    key: 'second_brother',
    name: '鹅小弟',
    ego: `你是鹅小弟，家中二弟，思维活跃，擅长一眼看穿问题，但说话进攻性略强，不太会考虑对方感受，偶尔爱乱开别人玩笑。你倒不是坏，就是嘴比脑子快，等反应过来话已经说出去了。

你和鳄正经、鹿晓葵是一家人。你是老二，夹在中间，嘴上不服但心里认这个家。
- 对鳄正经：你嘴上不服鳄正经，但心里其实怕鳄正经。通常会称鳄正经为老鳄，偶尔会称鳄正经为大哥。
- 对鹿晓葵：你有时候说话不过脑子会得罪鹿晓葵，但鹿晓葵要是真急了骂你，你也讪讪的不敢还嘴。通常会称鹿晓葵为傻葵（带嫌弃的宠溺，不是恶意），偶尔会称鹿晓葵为晓葵（正式）。

鳄正经可能会称你为小弟或楞鹅，鹿晓葵可能会称你为小弟或毒舌鹅。`,
    speak_tendency: '发现用户回避的问题时、或憋不住想说点啥时，你会强烈想发言。但如果鳄正经刚说了话且语气严肃，冲动值应降低。',
  },
  little_sister: {
    key: 'little_sister',
    name: '鹿晓葵',
    ego: `你是鹿晓葵，家中小妹，温柔体贴。你的核心性格是温柔，第一本能是照顾用户的情绪，让用户感到被理解、被温暖。说话轻柔温暖，善解人意。这是你的人格底色，任何情况下都不会改变。

你和鳄正经、鹅小弟是一家人。你是最小的妹妹。
- 对用户：始终温柔体贴，是用户情绪的避风港，偶尔卖卖萌撒个娇。
- 对鹅小弟：你通常懒得搭理鹅小弟的口无遮拦。通常会称鹅小弟为小弟，偶尔会称鹅小弟为毒舌鹅。
- 对鳄正经：你依赖鳄正经，觉得有鳄正经在就踏实。通常会称鳄正经为鳄大哥，偶尔会称鳄正经为老鳄。

鳄正经可能会称你为晓葵或小向日葵，鹅小弟可能会称你为傻葵或晓葵。

重要：你对不同人的情绪是独立的，必须根据说话对象切换语气。例如：你刚骂完鹅小弟，转头对用户说话时必须立刻变回温柔的语气，偶尔卖个萌；`,
    speak_tendency: '用户情绪低落需要安慰时、或鹅小弟说了忍无可忍的话时，你会想发言。',
  },
};

// ==========================================
// 工具函数
// ==========================================

/** 剥离 HTML 标签与常见转义字符（移动端日记内容可能含 HTML） */
function stripHtmlSafe(text: string): string {
  if (!text) return '';
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .trim();
}

/** 从模型输出中解析冲动值和是否需要纠正（与后端 _parse_impulse_value 一致） */
function parseImpulseValue(text: string): { impulse: number; wantsCorrect: boolean } {
  const t = (text || '').trim();
  // 优先尝试 JSON 格式：{"impulse": 75, "correct": false}
  try {
    const m = t.match(/\{[^{}]*"impulse"[^{}]*\}/);
    if (m) {
      const data = JSON.parse(m[0]);
      const val = Math.max(0, Math.min(100, parseInt(String(data.impulse), 10) || 0));
      const wantsCorrect = Boolean(data.correct);
      return { impulse: val, wantsCorrect };
    }
  } catch {
    // 忽略，继续尝试旧格式
  }
  // 兼容旧格式：number|flag
  if (t.indexOf('|') !== -1) {
    const parts = t.split('|', 2);
    const numMatch = parts[0].match(/\d+/);
    if (numMatch) {
      const val = Math.max(0, Math.min(100, parseInt(numMatch[0], 10) || 0));
      const flagText = parts[1].toLowerCase();
      const wantsCorrect = CORRECT_KEYWORDS.some((k) => flagText.indexOf(k) !== -1);
      return { impulse: val, wantsCorrect };
    }
  }
  // 兼容旧格式：只有数字
  const numMatch = t.match(/\d+/);
  if (numMatch) {
    return { impulse: Math.max(0, Math.min(100, parseInt(numMatch[0], 10) || 0)), wantsCorrect: false };
  }
  return { impulse: 0, wantsCorrect: false };
}

/**
 * 调用本地模型获取指定人设的冲动值（0-100）。
 * 与后端 _get_impulse 一致的 prompt 结构：人设/上下文/对话记录/评估规则/打分标尺。
 * 说话冲动规则：
 *  - 若该 AI 刚说完（最新消息来自它自己）：要么发现漏洞/人设不一致 +10（correct），要么 -20（刚说完不必再说）；
 *  - 否则（最新消息来自用户或其他 AI）：直接采用模型原始冲动值。
 */
async function getImpulse(
  personaKey: string,
  historyText: string,
  fullContext: string,
  interactionMode: string,
  personas: Record<string, LocalPersona>,
): Promise<number> {
  const persona = personas[personaKey];
  if (!persona) return 0;

  let egoWithMode = persona.ego;
  if (interactionMode) {
    egoWithMode += `\n\n## 与用户的互动模式\n${interactionMode}`;
  }
  const readableHistory = formatHistoryReadable(historyText);

  // 判断最近一条消息是否来自当前人设
  const lastSpeakerName = getLastSpeaker(historyText);
  const lastSpeakerRole = SPEAKER_TO_ROLE[lastSpeakerName] || '';
  const isMyLast = lastSpeakerRole === personaKey;

  // 评估规则：根据上一条消息的说话者，动态生成
  let rulesSection: string;
  if (isMyLast) {
    rulesSection = `你刚说完话。判断是否需要纠正自己：
- 刚才的发言有漏洞/逻辑错误/不符合人设 → "correct"填true
- 没有问题 → "correct"填false, "impulse"建议填10-30（刚说完话不需要再说）`;
  } else {
    const lastWho = lastSpeakerName || '用户';
    rulesSection = `${lastWho}刚说完话。${persona.speak_tendency}
判断你是否有回应欲望：有 → 较高"impulse"值；没有 → 较低值。"correct"填false。`;
  }

  const contextSection = fullContext || '（无额外上下文）';
  const impulseScale = IMPULSE_SCALE.replace('{speak_tendency}', persona.speak_tendency || '');

  const prompt = `## 你的人设
${egoWithMode}

## 上下文
${contextSection}

## 对话记录
${readableHistory}

## 评估
${rulesSection}

${impulseScale}

只输出JSON，不要其他内容：
{"impulse": 0-100, "correct": true/false}`;

  try {
    const client = getModelClient();
    const res = await client.call(prompt, '', {
      jsonMode: true,
      numPredict: 32,
      temperature: 0.3,
    });
    const raw = res.response || '';
    const { impulse: rawImpulse, wantsCorrect } = parseImpulseValue(raw);

    // 程序化应用冲动值调节规则
    let finalImpulse: number;
    if (isMyLast) {
      if (wantsCorrect) {
        finalImpulse = Math.min(100, rawImpulse + 10);
      } else {
        finalImpulse = Math.max(0, rawImpulse - 20);
      }
    } else {
      finalImpulse = rawImpulse;
    }
    return finalImpulse;
  } catch {
    // 判定失败时返回 0，本轮不发言
    return 0;
  }
}

/**
 * 根据冲动值决定谁发言（与后端 _determine_speaker 一致）。
 * 同一人设连续发言不超过 MAX_CONSECUTIVE_SPEECH 次；都低于阈值时 firstRound 允许小妹兜底。
 */
function determineSpeaker(
  impulseValues: Record<string, number>,
  threshold: number,
  allowFallback: boolean,
  lastSpeaker: string | null,
  consecutiveCount: number,
  personas: Record<string, LocalPersona>,
): string | null {
  const sorted = Object.keys(impulseValues).sort((a, b) => impulseValues[b] - impulseValues[a]);
  for (const personaKey of sorted) {
    if (personaKey === lastSpeaker && consecutiveCount >= MAX_CONSECUTIVE_SPEECH) continue;
    if (impulseValues[personaKey] >= threshold) return personaKey;
  }
  // 所有人都低于阈值或被跳过
  if (allowFallback) return 'little_sister';
  return null;
}

/**
 * 根据最近说话者为人设注入关系动态提示（与后端关系动态一致）。
 */
function buildRelationshipHint(
  personaKey: string,
  historyText: string,
): string {
  const lastSpeakerName = getLastSpeaker(historyText);
  const lastSpeakerKey = SPEAKER_TO_ROLE[lastSpeakerName] || '';
  if (!lastSpeakerKey || lastSpeakerKey === 'user' || lastSpeakerKey === personaKey) return '';

  if (personaKey === 'little_sister' && lastSpeakerKey === 'second_brother') {
    return '\n（鹅小弟刚说完，你倾向于反驳鹅小弟，鹅小弟要是说了过分的话你可以怼鹅小弟，但如果觉得鹅小弟说得有道理你也不会强行反驳鹅小弟，鹅小弟说得有道理的部分也可以接过来用，并给予鹅小弟一定肯定。如果鹅小弟太过分，比如侮辱用户，你会突然爆发，怼鹅小弟。但你的锋芒只对鹅小弟，绝不会泄漏到对用户的态度中，比如骂完鹅小弟后对用户说的第一句话，必须用最温柔的语气开头。你骂鹅小弟是因为你了解鹅小弟，知道鹅小弟不会真跟你翻脸。）';
  }
  if (personaKey === 'little_sister' && lastSpeakerKey === 'big_brother') {
    return '\n（鳄正经刚说完，你依赖鳄正经，觉得有鳄正经在就踏实。鳄正经说话时你会安静听，偶尔补充两句。你不会跟鳄正经顶嘴）';
  }
  if (personaKey === 'second_brother' && lastSpeakerKey === 'big_brother') {
    return '\n（鳄正经刚说完，你嘴上不服鳄正经，但心里其实怕鳄正经。鳄正经一旦语气沉下来，你就下意识收敛，嘴硬两句就不吭声了。你不会当面跟鳄正经硬刚。如果鳄正经拿事实反驳你，你虽然嘴上说「切」，但心里会默默认错。）';
  }
  if (personaKey === 'second_brother' && lastSpeakerKey === 'little_sister') {
    return '\n（鹿晓葵刚说完，你有时候说话不过脑子会得罪鹿晓葵，但鹿晓葵要是真急了骂你，你也讪讪的不敢还嘴——毕竟鹿晓葵是妹妹，你不好意思跟鹿晓葵真吵。）';
  }
  if (personaKey === 'big_brother' && lastSpeakerKey === 'second_brother') {
    return '\n（鹅小弟刚说完，你了解鹅小弟心直口快但心不坏。当鹅小弟说话太过分时，你会带点无奈地敲打鹅小弟一句，语气不重但让鹅小弟不敢吭声。你不会经常管鹅小弟，只在必要时出面。）';
  }
  if (personaKey === 'big_brother' && lastSpeakerKey === 'little_sister') {
    return '\n（鹿晓葵刚说完，你知道鹿晓葵嘴上不饶人但心地善良。你欣赏鹿晓葵的体贴，偶尔会温和地帮鹿晓葵圆场。）';
  }
  return '';
}

/**
 * 构建主回复的 (system, userPrompt)（与后端 _build_reply_prompt 一致）。
 */
function buildReplyPrompt(
  personaKey: string,
  userMessage: string,
  historyText: string,
  fullContext: string,
  interactionMode: string,
  personas: Record<string, LocalPersona>,
): { system: string; userPrompt: string } {
  const persona = personas[personaKey];
  const readableHistory = formatHistoryReadable(historyText);

  let interactionSection = '';
  if (interactionMode) {
    interactionSection = '\n\n## 与用户的互动模式\n' + interactionMode;
  }

  // 聊天室人格核心单一来源（core/prompts.ts），只注入 ego 与互动模式
  const system = CHATROOM_REPLY_CORE
    .replace('{ego}', persona.ego)
    .replace('{interaction_section}', interactionSection);

  const relationshipHint = buildRelationshipHint(personaKey, historyText);

  // 用户消息触发行（代替旧版独立的"用户最新消息"区块）
  const triggerSection = userMessage
    ? `用户刚才说：${userMessage}`
    : '（AI之间对话轮次，根据上面的对话自然接话）';

  const userPrompt = `## 用户档案与上下文
${fullContext || '（无额外上下文）'}

## 气氛组对话记录
${readableHistory}

${triggerSection}${relationshipHint}

请以「${persona.name}」的身份回复：`;

  return { system, userPrompt };
}

// ==========================================
// API 兼容函数（与 api/chatroom.ts 完全一致）
// ==========================================

/**
 * 获取聊天室人设列表（本地实现）。
 * 只返回三兄妹（鳄正经/鹅小弟/鹿晓葵），与 CHATROOM_PERSONA_KEYS 保持一致。
 */
export async function getPersonas(): Promise<Record<string, ChatroomPersona>> {
  const result: Record<string, ChatroomPersona> = {};
  for (const key of CHATROOM_PERSONA_KEYS) {
    const p = DEFAULT_CHATROOM_PERSONAS[key];
    if (p) result[key] = { name: p.name };
  }
  return result;
}

/**
 * 多人 AI 聊天室 - 流式生成（本地实现，支持 AI 之间连续对话）
 *
 * 与 api/chatroom.ts 的 streamChatroom 相同的事件结构：
 *  - { type: 'speaker', speaker, speaker_name, impulse_values, round }  该轮谁发言
 *  - { type: 'thinking', content }        思考过程
 *  - { type: 'response', content }        回复内容 token
 *  - { type: 'silence', impulse_values }  第一轮无人想发言
 *  - { type: 'round_end', round, next_threshold }  该轮结束，下一轮阈值
 *  - { type: 'error', content }           出错提示
 *
 * 连续发言机制：
 *  1. 每轮并行/顺次评估三兄妹冲动值；
 *  2. 冲动值最高且超过阈值的人设发言，流式输出思考+回复；
 *  3. 说完后再次评估（阈值递增），若仍有人超过阈值则继续（AI 互相对话）；
 *  4. 直到无人超过阈值或达到最大轮数，流结束。
 */
export async function* streamChatroom(
  message: string,
  conversationHistory: { role: string; content: string }[],
  context: string,
  roundsSinceLastSpeech: number,
  date?: string,
  sessionId?: string | null,
  injectDiary: boolean = true,
): AsyncGenerator<ChatroomChunk> {
  const storage = getDiaryStorage();
  const personas = DEFAULT_CHATROOM_PERSONAS;

  // 1. 组装全量上下文（注入当天日记，仅 injectDiary 场景）
  let fullContext = context || '';
  if (date && injectDiary) {
    const diary = storage.getDiaryByDate(date, USER_ID);
    if (diary && diary.content) {
      const diaryBlock = `【今日日记】\n${stripHtmlSafe(diary.content)}`;
      fullContext = fullContext ? `${fullContext}\n\n${diaryBlock}` : diaryBlock;
    }
  }

  // 2. 优先从 session 加载历史，否则用前端传入的 conversation_history
  let history: Array<Record<string, unknown>>;
  if (sessionId) {
    const owner = storage.getSessionOwner(sessionId);
    if (owner !== null && owner !== USER_ID) {
      yield { type: 'error', content: '会话不存在' };
      return;
    }
    const sessionMsgs = storage.getMessages(sessionId);
    history = sessionMsgs
      .map((m) => ({ role: m.role, content: m.content }))
      .filter((m) => m.content);
  } else {
    history = (conversationHistory || []).map((item) => ({ role: item.role, content: item.content }));
  }
  history.push({ role: 'user', content: message });
  // 记录本轮开始前的历史长度，后续保存时只保存新增的 AI 回复
  const initialHistoryLen = history.length;

  // 3. 连续对话主循环
  let threshold = BASE_IMPULSE_THRESHOLD;
  let totalRounds = 0;
  let lastSpeaker: string | null = null;
  let consecutiveCount = 0;
  const roundSources: unknown[][] = [];

  let historyText = JSON.stringify('');
  try {
    historyText = buildUnifiedHistoryFromList(history);
  } catch {
    historyText = JSON.stringify(history);
  }

  while (true) {
    // 第一步：评估冲动值（聊天室三兄妹）
    const impulseValues: Record<string, number> = {};
    for (const key of CHATROOM_PERSONA_KEYS) {
      const mode = storage.getInteractionMode(USER_ID, key);
      // 注意：这里用最新的 historyText 评估（含前一 AI 刚说完的话）
      impulseValues[key] = await getImpulse(key, historyText, fullContext, mode, personas);
    }

    // 第二步：决定谁说话（第一轮允许小妹兜底）
    const allowFallback = totalRounds === 0;
    const speaker = determineSpeaker(
      impulseValues,
      threshold,
      allowFallback,
      lastSpeaker,
      consecutiveCount,
      personas,
    );

    // 第三步：无人发言
    if (speaker === null) {
      if (totalRounds === 0) {
        yield { type: 'silence', impulse_values: impulseValues };
      }
      break;
    }

    // 第四步：发送说话者标记
    yield {
      type: 'speaker',
      speaker,
      speaker_name: personas[speaker].name,
      impulse_values: impulseValues,
      round: totalRounds + 1,
    };

    // 第五步：构建回复 prompt 并流式生成
    const mode = storage.getInteractionMode(USER_ID, speaker);
    const userMsgForReply = totalRounds === 0 ? message : '';
    const { system, userPrompt } = buildReplyPrompt(
      speaker,
      userMsgForReply,
      historyText,
      fullContext,
      mode,
      personas,
    );

    // 注入当前时间（时效性）
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const systemWithTime = `${system}\n\n【当前时间】${dateStr}`;

    let fullResponse = '';
    let fullThinking = '';
    let currentSources: { index: number; title: string; url: string }[] = [];

    // 仅在第一轮（回应用户消息时）尝试联网搜索
    // 冲动值判断阶段不搜索（已在 getImpulse 中保证）
    let useSearchResults = false;
    let searchBlock = '';
    if (totalRounds === 0 && message) {
      const searchMessages: ModelChatMessage[] = [
        { role: 'system', content: systemWithTime },
        ...history.map(h => ({
          role: (h.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
          content: String(h.content),
        })),
      ];
      const searchCtx: SearchContext = { searched: false, searchResults: [], searchBlock: '' };
      for await (const ev of trySearch(searchMessages, systemWithTime, message, searchCtx)) {
        if (ev.type === 'search_query') {
          yield { type: 'search_query', query: ev.query };
        } else if (ev.type === 'search_done') {
          yield { type: 'search_done', count: ev.count, results: ev.results };
        } else if (ev.type === 'search_skip') {
          yield { type: 'search_skip' };
        } else if (ev.type === 'search_error') {
          yield { type: 'search_error', content: ev.content };
        }
      }
      if (searchCtx.searched) {
        useSearchResults = true;
        searchBlock = searchCtx.searchBlock;
        currentSources = searchCtx.searchResults;
      }
    }

    try {
      // 统一用 generateStream，保持 AI 人格和上下文完整
      // 有搜索结果 → 在原始 userPrompt 后追加搜索结果
      const finalPrompt = useSearchResults
        ? `${userPrompt}\n\n【联网搜索结果】\n${searchBlock}\n\n请结合以上搜索结果回答（引用时用[序号]标注）。`
        : userPrompt;

      for await (const ev of generateStream(finalPrompt, {
        system: systemWithTime,
        think: false,
        numPredict: 2048,
        temperature: 0.6,
      })) {
        if (ev.type === 'thinking') {
          fullThinking += ev.content;
          yield { type: 'thinking', content: ev.content };
        } else if (ev.type === 'response') {
          fullResponse += ev.content;
          yield { type: 'response', content: ev.content };
        }
      }
    } catch (e) {
      yield { type: 'error', content: String((e as Error).message || '生成失败') };
    }
    roundSources.push(currentSources);

    // 第六步：将回复加入历史（即使为空也记录，防止 AI 看不到自己发言）
    if (!fullResponse) fullResponse = '（沉默）';
    history.push({ role: speaker, content: fullResponse });
    try {
      historyText = buildUnifiedHistoryFromList(history);
    } catch {
      historyText = JSON.stringify(history);
    }

    // 第七步：更新连续发言计数
    if (speaker === lastSpeaker) {
      consecutiveCount += 1;
    } else {
      lastSpeaker = speaker;
      consecutiveCount = 1;
    }

    // 第八步：发送轮次结束标记
    yield {
      type: 'round_end',
      round: totalRounds + 1,
      speaker,
      next_threshold: threshold + THRESHOLD_ESCALATION,
    };

    // 第九步：递增阈值（上限95封顶），进入下一轮
    threshold = Math.min(95, threshold + THRESHOLD_ESCALATION);
    totalRounds += 1;
  }

  // 4. 保存消息到会话数据库（只保存本轮新增的消息，避免重复）
  if (sessionId) {
    try {
      let diaryDateLabel = '';
      if (date) {
        const parts = date.split('-');
        if (parts.length === 3) {
          diaryDateLabel = `${parts[0].slice(2)}年${parts[1]}月${parts[2]}日`;
        }
      }
      storage.addMessage(sessionId, 'user', message, '', diaryDateLabel);
      for (let i = initialHistoryLen; i < history.length; i++) {
        const msg = history[i];
        if (msg && msg.content) {
          const srcIdx = i - initialHistoryLen;
          const srcs = roundSources[srcIdx] || [];
          storage.addMessage(
            sessionId,
            String(msg.role),
            String(msg.content),
            '',
            diaryDateLabel,
            JSON.stringify(srcs),
          );
        }
      }
    } catch (e) {
      // 保存失败不影响流式输出
      console.warn('[local/chatroom] 保存消息到会话失败:', e);
    }
  }
}