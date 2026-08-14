/**
 * local/insight.ts — 手机端本地觉察服务（Phase 5）
 *
 * 与 api/insight.ts 保持完全相同的类型、函数签名与返回结构，
 * 但内部改用：
 *  - 本地持久化 → core/db/insightDb.ts（expo-sqlite：insight.db）
 *  - 本地 LLM   → core/modelService.ts（generate / generateStream）
 *                + core/prompts.ts（觉察人格系统提示词 buildAwarenessSystem）
 *                + core/db/diaryDb.ts（读取近期本地日记）
 *
 * 页面只需把 `../api/insight` 改为 `../local/insight` 即可无缝切换。
 * 纯本地实现，不 import 任何 HTTP api client。
 */

import { getInsightStorage, InsightBranch, InsightResult, InsightHistoryItem } from '../core/db/insightDb';
import { getDiaryStorage } from '../core/db/diaryDb';
import { getModelClient, generate, generateStream } from '../core/modelService';
import { buildAwarenessSystem } from '../core/prompts';

// ==========================================
// 类型（与 api/insight.ts 完全一致）
// ==========================================

// 与 api/insight.ts 完全一致的类型，直接再导出（页面可无缝引用）
export { InsightBranch, InsightResult, InsightHistoryItem };

/** 展平后的单条支线（用于列表展示和详情对话） */
export interface FlatBranch {
  resultId: string;
  branchId: string;
  title: string;
  observation: string;
  evidence: string[];
  question: string;
  conversation: { role: string; content: string }[];
  timestamp: string;
  diaryCount: number;
  dateRange: string;
}

// ==========================================
// 常量
// ==========================================

/** 当前本地用户（手机端单机默认） */
const USER_ID = 'default';

/** 结构化支线分析 Prompt（与后端 BRANCH_DISCOVERY_PROMPT 一致） */
const BRANCH_DISCOVERY_PROMPT = `你是一个温和的觉察伙伴，正在帮助用户回顾他最近的日记。你不是专家，不是导师，你只是陪用户一起思考的人。

## 任务
从日记中找出值得探索的"觉察支线"（必须输出 4-6 个，至少 4 个，这是硬性要求）——每条支线是一个独立的观察角度，用户可以选择感兴趣的去深入。

## 支线设计原则
- 每条支线应该是独立的观察角度，不要重复
- 观察要具体，不要泛泛而谈（比如不要只说"你压力很大"，要说"你这周三次提到'睡不着'，但每次睡不着的原因都不同"）
- 追问要让人想"聊下去"，而不是"答完就结束"
- 不要假装知道别人在想什么。你只在日记中看到了用户的视角。
- 不要说"你应该做X"。你只是在陪用户思考。

## 字段要求
- title: 用一句话概括这个观察（6-12字，要具体不要抽象）
- observation: 你从日记中注意到了什么？像朋友聊天一样说出来。引用原文中的具体语句作为证据。语气温和、不评判。
- evidence: 摘录日记中支撑这个观察的 1-2 句原文，标注日期。
- question: 基于这个观察，提一个用户可能没问过自己的问题。不是反问，是真诚的好奇。

## 日记

`;

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

/** 规范化依据字段：兼容模型返回的数组 / JSON 数组字符串 / 多行文本，统一为条目数组 */
export function normalizeEvidence(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  const s = String(value).trim();
  if (!s) return [];
  // 模型偶发把依据输出成 JSON 数组字符串（如 '["2026-08-07: ...","2026-08-07: ..."]'）
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) {
        const items = arr.map((v) => String(v).trim()).filter(Boolean);
        if (items.length) return items;
      }
    } catch {
      // 非合法 JSON，退回整段处理
    }
  }
  // 普通文本：按行拆成多条，每条独立
  return s.split('\n').map((x) => x.trim()).filter(Boolean);
}

/** 把依据条目数组序列化为单个字符串存储（InsightBranch.evidence 为 string，兼容后端 schema） */
function serializeEvidence(items: string[]): string {
  return items.length ? JSON.stringify(items) : '';
}

/** 从依据数组中提取所有引用的日期（如 '2025-03-15'）并去重 */
function extractDatesFromEvidence(evidence: string[]): string[] {
  if (!evidence || !evidence.length) return [];
  const text = evidence.join('\n');
  const matches = text.match(/\d{4}-\d{2}-\d{2}/g) || [];
  return Array.from(new Set(matches));
}

/** 从完整日记上下文中，只保留指定日期对应的条目 */
function filterDiaryByDates(diaryContext: string, dates: string[]): string {
  if (!dates.length || !diaryContext) return diaryContext;
  // 按【日期】分割
  const entries = diaryContext.split(/(?=【\d{4}-\d{2}-\d{2}】)/);
  const filtered: string[] = [];
  for (const entry of entries) {
    const entryDates = entry.match(/【(\d{4}-\d{2}-\d{2})】/g) || [];
    const hit = entryDates.some((d) => dates.indexOf(d.replace(/【|】/g, '')) !== -1);
    if (hit) filtered.push(entry.trim());
  }
  return filtered.length ? filtered.join('\n\n') : diaryContext;
}

/** 日记列表拼接为文本（与后端 _diaries_to_text 一致） */
function diariesToText(diaries: { date: string; content: string }[]): string {
  let text = '';
  for (const d of diaries) {
    text += `【${d.date}】\n${stripHtmlSafe(d.content)}\n\n`;
  }
  return text;
}

/** 从文本中截取第一个平衡的 JSON 对象/数组（自动跳过前后杂音、字符串内括号） */
function extractJsonBlock(text: string): string | null {
  const startIdx = text.search(/[[{]/);
  if (startIdx === -1) return null;
  const open = text[startIdx];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = startIdx; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

/** 去掉 markdown 代码块围栏（```json ... ```） */
function stripFences(text: string): string {
  return (text || '').replace(/```(?:json)?/gi, '').trim();
}

/** 生成若干个待尝试 JSON 解析的候选字符串（由宽松到严格） */
function jsonCandidates(raw: string): string[] {
  const list: string[] = [];
  const t = (raw || '').trim();
  if (t) list.push(t);
  const noFence = stripFences(t);
  if (noFence && noFence !== t) list.push(noFence);
  const block = extractJsonBlock(noFence || t);
  if (block && block !== t && block !== noFence) list.push(block);
  return list;
}

/** 从解析出的 JSON 中提取支线数组（兼容 branches 包裹 / 顶层数组 / data·result·items 包裹 / 单个支线对象） */
function extractBranchList(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.branches)) return obj.branches as Array<Record<string, unknown>>;
    for (const k of ['data', 'result', 'items']) {
      if (Array.isArray(obj[k])) return obj[k] as Array<Record<string, unknown>>;
    }
    // 单个对象本身可能就是一条支线（含 observation/title）
    if (typeof obj.observation === 'string' || typeof obj['观察'] === 'string') {
      return [obj];
    }
  }
  return [];
}

/** 取对象中首个非空字段值（兼容中英文键名） */
function firstOf(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return '';
}

/** 从模型 JSON 输出中解析支线（多级降级：JSON → 提取片段 → 正则/逐行解析） */
function parseBranches(raw: string): InsightBranch[] {
  const branches: InsightBranch[] = [];
  for (const cand of jsonCandidates(raw)) {
    let data: unknown;
    try {
      data = JSON.parse(cand);
    } catch {
      continue;
    }
    const list = extractBranchList(data);
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (!b || typeof b !== 'object') continue;
      const observation = firstOf(b, ['observation', '观察']);
      if (!observation) continue;
      branches.push({
        id: String(i + 1),
        title: firstOf(b, ['title', '标题']) || `支线 ${i + 1}`,
        observation,
        evidence: serializeEvidence(normalizeEvidence(firstOf(b, ['evidence', '证据']))),
        question: firstOf(b, ['question', '追问']),
        conversation: [],
      });
    }
    if (branches.length) break;
  }

  // 仍为空 → 降级到逐行解析（兼容 [支线] 标记 / 中文字段段落）
  if (!branches.length) {
    branches.push(...parseBranchesLegacy(raw));
  }

  return branches;
}

/** 正则/逐行降级解析器（兼容模型直接输出中文段落的场景） */
function parseBranchesLegacy(text: string): InsightBranch[] {
  const branches: InsightBranch[] = [];
  let blocks: string[] = [];
  const fenceRe = /\[支线\]([\s\S]*?)\[\/支线\]/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) blocks.push(m[1]);
  if (!blocks.length) {
    blocks = text.split(/\n?\[支线\]\n?/).map((p) => p.trim()).filter(Boolean);
  }
  const fieldMap: Record<string, string> = { '标题': 'title', '观察': 'observation', '证据': 'evidence', '追问': 'question' };
  for (let i = 0; i < blocks.length; i++) {
    const acc: Record<string, string> = {};
    let cur: string | null = null;
    for (const rawLine of blocks[i].split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const fm = /^(标题|观察|证据|追问)[：:]\s*(.*)$/.exec(line);
      if (fm) {
        cur = fieldMap[fm[1]];
        acc[cur] = fm[2].trim();
      } else if (cur) {
        acc[cur] += '\n' + line;
      }
    }
    if (acc['observation']) {
      branches.push({
        id: String(i + 1),
        title: acc['title'] || `支线 ${i + 1}`,
        observation: acc['observation'].trim(),
        evidence: serializeEvidence(normalizeEvidence(acc['evidence'])),
        question: acc['question'] || '',
        conversation: [],
      });
    }
  }
  return branches;
}

/**
 * 获取近期日记（指定天数内不足以 2 篇时回退到全部日记）。
 * 与后端 run_insight_analysis 的筛选逻辑一致。
 */
function getFilteredDiaries(days: number): { date: string; content: string }[] {
  const storage = getDiaryStorage();
  const limit = Math.max(days * 2, 60);
  const recent = storage.getRecentDiaries(limit, USER_ID);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  let filtered = recent.filter((d) => {
    if (!d.content || stripHtmlSafe(d.content).length < 5) return false;
    return d.date >= cutoffStr;
  });
  filtered.sort((a, b) => (a.date < b.date ? -1 : 1));

  // 天窗内不足 2 篇 → 回退到全部日记
  if (filtered.length < 2) {
    const all = storage.getAllDiaries(USER_ID);
    filtered = all.filter((d) => d.content && stripHtmlSafe(d.content).length >= 5);
    filtered.sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  return filtered.map((d) => ({ date: d.date, content: d.content }));
}

// ==========================================
// API 兼容函数（与 api/insight.ts 完全一致）
// ==========================================

/** 获取最近一次觉察报告（无则返回空结构） */
export async function getLatestInsight(): Promise<InsightResult> {
  const storage = getInsightStorage();
  const result = storage.getLatestInsight(USER_ID);
  if (!result) {
    return { id: '', timestamp: '', diary_count: 0, date_range: '', elapsed_seconds: 0, branches: [] };
  }
  return result;
}

/** 获取历史觉察报告（含完整支线，前端直接渲染） */
export async function getInsightHistory(): Promise<InsightHistoryItem[]> {
  return getInsightStorage().getInsightHistory(USER_ID);
}

/**
 * 调用底层模型生成觉察报告原始输出。
 * retry=true 时用更严格的提示约束（强制英文键、严格 JSON、无 markdown 代码块），并降低温度。
 */
async function callBranchModel(diaryContext: string, retry = false): Promise<string> {
  const prompt = retry
    ? BRANCH_DISCOVERY_PROMPT + diaryContext +
      '\n\n【重要】只输出一个 JSON 对象，其中包含 branches 数组。必须输出至少 4 条支线。字段名必须且只能用英文：title、observation、evidence、question。每条的 evidence 用字符串数组。不要输出 markdown 代码块，不要输出任何解释文字。'
    : BRANCH_DISCOVERY_PROMPT + diaryContext;
  const temperature = retry ? 0.3 : 0.4;
  try {
    const client = getModelClient();
    // jsonMode 走结构化输出（Ollama format=json / OpenRouter response_format）
    const res = await client.call(prompt, '', {
      jsonMode: true,
      numPredict: 8192,
      temperature,
    });
    return res.response || '';
  } catch {
    // 模型客户端失败时回退到 generate
    return await generate(prompt, {
      jsonMode: true,
      numPredict: 8192,
      temperature,
    }).catch(() => '');
  }
}

/**
 * 手动触发觉察分析（生成新的觉察报告）。
 * 用本地 LLM 结合近期本地日记生成 branches（title/observation/evidence/question）。
 */
export async function runInsightAnalysis(days?: number): Promise<InsightResult> {
  const storage = getInsightStorage();
  // 默认天数取自本地设置
  const settings = storage.getInsightSettings(USER_ID);
  const effectiveDays = days && days > 0 ? days : settings.analysis_days || 30;

  const filtered = getFilteredDiaries(effectiveDays);
  const diaryContext = diariesToText(filtered);

  // 日记不足时返回空报告（与后端一致：不生成有意义分析）
  if (filtered.length < 2) {
    const empty: InsightResult = {
      id: '',
      timestamp: new Date().toISOString(),
      diary_count: filtered.length,
      date_range: filtered.length ? `${filtered[0].date} 至 ${filtered[filtered.length - 1].date}` : '无',
      elapsed_seconds: 0,
      branches: [],
    };
    return empty;
  }

  const t0 = Date.now();
  // 首次生成
  let raw = await callBranchModel(diaryContext);
  let branches = parseBranches(raw);

  // 解析出的支线不足 3 条且模型确实返回了内容（非网络失败）→ 重试一次，用更严格的提示引导
  if (branches.length < 3 && raw && raw.trim()) {
    raw = await callBranchModel(diaryContext, true);
    branches = parseBranches(raw);
  }
  const elapsed = Math.round((Date.now() - t0) / 100) / 10;

  // 便于排查：区分网络失败与模型输出不规范
  if (!branches.length) {
    if (!raw || !raw.trim()) {
      console.error('[觉察报告] 生成失败：模型返回为空（疑似网络/连接异常）');
    } else {
      console.error('[觉察报告] 解析失败：模型输出无法提取支线。原始输出=', raw.slice(0, 500));
    }
  }

  // 解析失败 → 降级为单条纯文本支线
  if (!branches.length) {
    branches = [
      {
        id: '1',
        title: '觉察发现',
        observation: raw.trim() || '（本次未能生成支线，请尝试再分析一次）',
        evidence: '',
        question: '你想从哪个角度深入聊聊？',
        conversation: [],
      },
    ];
  }

  const id = nowStampId();
  const timestamp = new Date().toISOString();
  const dateRange = `${filtered[0].date} 至 ${filtered[filtered.length - 1].date}`;

  const result: InsightResult = {
    id,
    timestamp,
    diary_count: filtered.length,
    date_range: dateRange,
    elapsed_seconds: elapsed,
    branches,
    diary_context: diaryContext,
  };

  storage.saveInsight(result, USER_ID);
  // 记录最近运行时间
  storage.updateInsightSettings({ last_run: timestamp }, USER_ID);

  return result;
}

/** 获取指定报告详情（含所有支线） */
export async function getInsightResult(id: string): Promise<InsightResult> {
  const result = getInsightStorage().getInsightResult(id, USER_ID);
  if (!result) {
    throw new Error('未找到该分析记录');
  }
  return result;
}

/** 删除指定觉察报告（连同其所有支线及对话） */
export async function deleteInsightResult(id: string): Promise<{ success: boolean }> {
  const ok = getInsightStorage().deleteInsightResult(id, USER_ID);
  return { success: ok };
}

/** 获取觉察设置 */
export async function getInsightSettings(): Promise<any> {
  return getInsightStorage().getInsightSettings(USER_ID);
}

/** 更新觉察设置 */
export async function updateInsightSettings(settings: any): Promise<any> {
  const next = getInsightStorage().updateInsightSettings(settings || {}, USER_ID);
  return { success: true, settings: next };
}

/**
 * 与指定支线的觉察伙伴流式对话（本地实现）。
 * 与 api/insight.ts 的 streamBranchChat 相同的事件结构：
 *  - { type: 'thinking', content }  思考过程（觉察助手 think=True）
 *  - { type: 'response', content }  回复内容 token
 *  - { type: 'error', content }     出错提示
 */
export async function* streamBranchChat(
  resultId: string,
  branchId: string,
  message: string,
): AsyncGenerator<{ type: string; content: string }> {
  const storage = getInsightStorage();
  const result = storage.getInsightResult(resultId, USER_ID);
  if (!result) {
    yield { type: 'error', content: '未找到该分析记录' };
    return;
  }
  const branch = result.branches.find((b) => b.id === branchId);
  if (!branch) {
    yield { type: 'error', content: '未找到该支线' };
    return;
  }

  // 构建觉察系统提示词 + 支线上下文 prompt
  const system = buildAwarenessSystem(null);
  const diaryContext = result.diary_context || '';
  const relevantDates = extractDatesFromEvidence(normalizeEvidence(branch.evidence));
  const filteredDiary = filterDiaryByDates(diaryContext, relevantDates);
  const userPrompt = buildBranchPrompt(branch, filteredDiary, message);

  // 拼接当前时间（时效性）
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const systemWithTime = `${system}\n\n【当前时间】${dateStr}`;

  let fullResponse = '';
  try {
    for await (const ev of generateStream(userPrompt, {
      system: systemWithTime,
      think: true, // 觉察助手保留思考过程
      numPredict: 2048,
      temperature: 0.7,
    })) {
      if (ev.type === 'thinking') {
        yield { type: 'thinking', content: ev.content };
      } else if (ev.type === 'response') {
        yield { type: 'response', content: ev.content };
        fullResponse += ev.content;
      }
    }
  } catch {
    yield { type: 'error', content: '对话失败，请重试' };
  }

  // 保存对话记录并回写
  branch.conversation.push({ role: 'user', content: message });
  branch.conversation.push({ role: 'assistant', content: fullResponse });
  storage.updateInsightResult(resultId, result, USER_ID);
}

/** 为指定支线生成最终总结（本地实现，非 API 必需，供本地配套使用） */
export async function summarizeBranch(resultId: string, branchId: string): Promise<{ summary: string }> {
  const storage = getInsightStorage();
  const result = storage.getInsightResult(resultId, USER_ID);
  if (!result) throw new Error('未找到该分析记录');
  const branch = result.branches.find((b) => b.id === branchId);
  if (!branch) throw new Error('未找到该支线');

  const conversations = branch.conversation || [];
  if (!conversations.length) {
    return { summary: `这条支线还没有展开对话。\n\n核心观察：${branch.observation || ''}\n\n追问：${branch.question || ''}` };
  }

  let chatText = '';
  for (const msg of conversations) {
    const role = msg.role === 'user' ? '用户' : '觉察伙伴';
    chatText += `${role}: ${msg.content}\n`;
  }

  const summaryPrompt = `你是一个温和的觉察伙伴。以下是用户在一条觉察支线中的完整对话。

支线主题: ${branch.title || ''}
初始观察: ${branch.observation || ''}

## 对话记录
${chatText}

请为这条支线写一个最终总结（2-3句话），包含：
1. 用户在这条支线中收获的核心觉察
2. 一个温和的收尾——不是结论，而是邀请用户在未来继续留意

像朋友聊天结束时那样自然，不要像在写报告。`;

  const summary = await generate(summaryPrompt, { numPredict: 500, temperature: 0.6 }).catch(() => '');
  if (summary) {
    branch.summary = summary;
    storage.updateInsightResult(resultId, result, USER_ID);
  }
  return { summary };
}

// ==========================================
// 内部辅助
// ==========================================

/** 生成报告 id（YYYYMMDDHHmmss，与后端一致） */
function nowStampId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 构建支线对话 prompt：头部(标题/观察/追问) + 相关日记 + 对话历史 + 用户最新回复 */
function buildBranchPrompt(
  branch: InsightBranch,
  diaryContext: string,
  userMessage: string,
): string {
  const header = `## 当前支线
标题: ${branch.title || ''}
核心观察: ${branch.observation || ''}
初始追问: ${branch.question || ''}

## 相关日记
${diaryContext}
`;

  const conversation = branch.conversation || [];
  let chatHistory = '';
  for (const msg of conversation) {
    const role = msg.role === 'user' ? '用户' : '觉察伙伴';
    chatHistory += `${role}: ${msg.content}\n`;
  }
  if (!chatHistory) chatHistory = '（这是对话的开始）';

  const userSection = `\n## 用户的最新回复\n${userMessage}`;
  return header + chatHistory + userSection;
}