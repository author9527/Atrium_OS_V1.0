/**
 * local/relationships.ts — 手机端本地人际关系档案服务（Phase 5）
 *
 * 与 api/relationships.ts 保持完全相同的函数签名与返回结构，
 * 但内部改用本地存储 + 本地 LLM 分析：
 *  - 档案 CRUD → core/db/diaryDb.ts 本地 SQLite（relationship_profiles 表）
 *  - 实体登记 → core/db/coreStorage.ts（entities 表，经 core/entityManager.ts）
 *  - 外号/证据/档案生成 → core/modelService.ts（getModelClient / generateStream）
 *    + core/prompts.ts（觉察伙伴系统提示词）
 *
 * 不再依赖电脑端 HTTP 后端。页面只需把 `../api/relationships` 改为 `../local/relationships`
 * 即可无缝切换（含流式：本文件直接逐条 yield 事件，无需 SSE）。
 */

import { getDiaryStorage, DiaryStorage } from '../core/db/diaryDb';
import { getModelClient, generateStream } from '../core/modelService';
import { getEntityManager } from '../core/entityManager';
import { buildAwarenessSystem } from '../core/prompts';
import { stripHtml } from '../core/utils/chatUtils';

// ========== 与 api/relationships.ts 一致的类型 ==========

export interface RelationshipEvidence {
  text: string;
  date: string;
}

export interface RelationshipDimension {
  key: string;
  label: string;
  fixed: boolean;
  description?: string;
}

export interface Relationship {
  id: string;
  user_id: string;
  person_name: string;
  profile_content: string;
  evidence: RelationshipEvidence[];
  dimensions: RelationshipDimension[];
  last_search_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateRelationshipResult {
  relationship: Relationship;
  status: 'complete' | 'followup_needed' | 'no_evidence' | 'already_exists';
  message?: string;
  followup_questions?: string[];
}

export interface RefreshResult {
  relationship: Relationship;
  status: 'complete' | 'followup_needed' | 'no_new_evidence';
  message?: string;
  followup_questions?: string[];
  new_evidence_count?: number;
}

export interface AliasCandidate {
  name: string;
  reason: string;
}

export interface CreateStreamChunk {
  type: 'progress' | 'result' | 'error';
  step?: string;
  message?: string;
  count?: number;
  relationship?: Relationship;
  status?: string;
  followup_questions?: string[];
  opening_message?: string;
}

export interface RefreshStreamChunk {
  type: 'progress' | 'result' | 'error';
  step?: string;
  message?: string;
  count?: number;
  relationship?: Relationship;
  status?: string;
  followup_questions?: string[];
  new_evidence_count?: number;
  opening_message?: string;
}

/** 当前本地用户（手机端单机默认） */
const USER_ID = 'default';

// ========== 固定维度定义（4个，不可更改，与后端一致） ==========
const FIXED_DIMENSIONS: RelationshipDimension[] = [
  { key: 'personality', label: '人格特质', fixed: true, description: '这个人的性格特点、价值观、思维方式' },
  { key: 'behavior', label: '行为模式', fixed: true, description: '这个人的行为习惯、应对策略、情绪反应模式' },
  { key: 'core_conflict', label: '核心矛盾', fixed: true, description: '用户与这个人之间的核心矛盾和张力' },
  { key: 'dynamics', label: '关系动态', fixed: true, description: '这段关系的发展变化、趋势和走向' },
];

/** 结构化输出系统提示词（本文件所有 LLM 分析统一使用） */
const JSON_SYSTEM =
  '你是一位人际关系分析专家。只输出合法的 JSON，不要输出任何多余文字、注释或 markdown 代码块。';

// ========== 工具函数 ==========

/** 本地日期（YYYY-MM-DD） */
function todayStr(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 安全转字符串（防止 SQLite 类型绑定错误） */
function _safeStr(val: unknown): string {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  return JSON.stringify(val);
}

/** 稳健解析 LLM 输出的 JSON：先去 markdown 围栏，再尝试整体解析，最后提取首个 {...} */
function tryParseJson<T = unknown>(text: string): T | null {
  if (!text) return null;
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(t) as T;
  } catch {
    /* 继续尝试提取片段 */
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1)) as T;
    } catch {
      /* 忽略 */
    }
  }
  return null;
}

/** 非流式 LLM 调用，返回 JSON 对象（失败返回空对象） */
async function _llmJson(prompt: string, system: string, numPredict = 1024): Promise<Record<string, any>> {
  const client = getModelClient();
  try {
    const { response } = await client.call(prompt, system, { jsonMode: true, numPredict, temperature: 0.2 });
    return (tryParseJson<Record<string, any>>(response) ?? {}) as Record<string, any>;
  } catch (e) {
    console.warn('[relationships] LLM JSON 调用失败:', e);
    return {};
  }
}

/** 非流式 LLM 调用，返回纯文本 */
async function _llmText(prompt: string, system: string, numPredict = 1024): Promise<string> {
  const client = getModelClient();
  try {
    const { response } = await client.call(prompt, system, { numPredict, temperature: 0.6 });
    return response || '';
  } catch (e) {
    console.warn('[relationships] LLM 文本调用失败:', e);
    return '';
  }
}

/** 把人物登记到 coreStorage 的 entities 表（经 entityManager） */
async function _registerEntity(name: string, context: string): Promise<void> {
  try {
    getEntityManager().addMention(name, context);
  } catch {
    /* 登记失败不阻塞主流程 */
  }
}

/** 解析证据 JSON 字段 */
function parseEvidence(rel: Record<string, unknown>): RelationshipEvidence[] {
  try {
    const arr = JSON.parse(String(rel.evidence || '[]'));
    if (Array.isArray(arr)) {
      return arr.map((e) => ({ text: String(e.text || ''), date: String(e.date || '') }));
    }
  } catch {
    /* 解析失败返回空 */
  }
  return [];
}

/** 解析维度 JSON 字段 */
function parseDimensions(rel: Record<string, unknown>): RelationshipDimension[] {
  try {
    const arr = JSON.parse(String(rel.dimensions || '[]'));
    if (Array.isArray(arr)) {
      return arr.map((d) => ({
        key: String(d.key || ''),
        label: String(d.label || ''),
        fixed: !!d.fixed,
        description: d.description != null ? String(d.description) : undefined,
      }));
    }
  } catch {
    /* 解析失败返回空 */
  }
  return [];
}

/** 把 diaryDb 返回的原始记录转为 api 层一致的 Relationship */
function toRelationship(rel: Record<string, unknown>): Relationship {
  return {
    id: String(rel.id),
    user_id: String(rel.user_id),
    person_name: String(rel.person_name),
    profile_content: String(rel.profile_content || ''),
    evidence: parseEvidence(rel),
    dimensions: parseDimensions(rel),
    last_search_date: rel.last_search_date != null ? String(rel.last_search_date) : null,
    created_at: String(rel.created_at),
    updated_at: String(rel.updated_at),
  };
}

/** 空档案（用于异常兜底） */
function emptyRelationship(): Relationship {
  return {
    id: '',
    user_id: USER_ID,
    person_name: '',
    profile_content: '',
    evidence: [],
    dimensions: [],
    last_search_date: null,
    created_at: '',
    updated_at: '',
  };
}

// ========== 日记搜索 ==========

/** 搜索包含任一名字（原名+外号）的日记，返回 [{date, content}] 列表 */
function _searchDiariesForNames(
  storage: DiaryStorage,
  names: string[],
  sinceDate?: string,
): Array<{ date: string; content: string }> {
  const diaries = sinceDate
    ? storage.getDiariesByRange(sinceDate, todayStr(), USER_ID)
    : storage.getAllDiaries(USER_ID);

  const relevant: Array<{ date: string; content: string }> = [];
  for (const d of diaries) {
    if (d.content && names.some((n) => d.content.includes(n))) {
      relevant.push({ date: d.date, content: stripHtml(d.content) });
    }
  }
  return relevant;
}

// ========== 外号分析 ==========

/** 用 LLM 全面分析日记，找出该人物可能以哪些外号/昵称出现 */
async function _analyzeAliasesLocal(storage: DiaryStorage, personName: string): Promise<AliasCandidate[]> {
  const diaries = storage.getAllDiaries(USER_ID);
  // 截取每篇日记开头，控制输入规模（分析外号不需要全文）
  const diariesText = diaries
    .filter((d) => d.content)
    .map((d) => `【${d.date}】\n${stripHtml(d.content).slice(0, 800)}`)
    .join('\n\n');
  if (!diariesText) {
    return [{ name: personName, reason: '本人姓名' }];
  }

  const prompt = `请全面阅读以下日记内容，找出「${personName}」这个人可能以哪些外号、昵称、简称或称呼出现在日记中。

要求：
1. 仔细分析日记中的人物称呼，找出所有可能指向「${personName}」的别称
2. 包括但不限于：外号、昵称、简称、姓氏+身份（如"老X"、"X哥"）、谐音、英文名等
3. 只列出有把握确实指向该人物的称呼，不要臆测
4. 如果日记里该人物只以本名出现，没有其他称呼，则只保留本名
5. 每个称呼给出判断依据（在日记中出现的上下文或理由），reason 用简短的一句话说明
6. 必须包含「${personName}」本名本身（reason 标为"本人姓名"）

日记内容：
${diariesText}

输出 JSON 格式：
{
  "aliases": [
    {"name": "称呼或昵称", "reason": "判断依据"}
  ]
}`;

  const data = await _llmJson(prompt, JSON_SYSTEM, 2048);
  const aliases = Array.isArray(data.aliases) ? data.aliases : [];
  const result: AliasCandidate[] = [];
  const seen = new Set<string>();
  for (const a of aliases) {
    const name = (a.name || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push({ name, reason: (a.reason || '').trim() });
  }
  if (!seen.has(personName)) {
    result.unshift({ name: personName, reason: '本人姓名' });
  }
  return result;
}

// ========== 证据提取 ==========

/** 分批提取与某人相关的原文片段（每批至多 10 篇） */
async function _extractEvidenceFromDiaries(
  diaries: Array<{ date: string; content: string }>,
  names: string[],
  excludeDates?: Set<string>,
): Promise<RelationshipEvidence[]> {
  if (!diaries.length) return [];

  // 过滤掉已提取过的日期
  if (excludeDates) {
    diaries = diaries.filter((d) => !excludeDates.has(d.date));
    if (!diaries.length) return [];
  }

  const namesText = names.map((n) => `「${n}」`).join('、');
  const promptTemplate = `以下是用户日记。你要找的这个人物可能以 ${namesText} 的名字出现，也可能在上下文明确的情况下用"他/她/ta"等代称指代。请通读整篇日记，找出所有与这个人相关的原文片段。

要求：
1. 结合上下文判断名字和代称是否指向同一人物，提取与其相关的完整语义片段
2. 按句子边界提取，保留每段与该人物相关的完整语义，不要机械截断
3. 合并属于同一件事的相邻片段，去掉重复或冗余内容
4. 每条证据必须忠实于原文，不要改写或总结
5. 每条证据保留来源日期（date 字段）
6. 某片段虽不含名字、但能用上下文确认是该人物（如用"他/她/ta"代称）的，也要提取
7. 如果某片段无法确认与该人物相关，可以剔除

日记内容：
{diaries_text}

输出 JSON 格式：
{
  "evidence": [
    {"text": "原文片段", "date": "2025-03-15"}
  ]
}`;

  const BATCH_SIZE = 10;
  const all: RelationshipEvidence[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < diaries.length; i += BATCH_SIZE) {
    const batch = diaries.slice(i, i + BATCH_SIZE);
    const diariesText = batch.map((d) => `【${d.date}】\n${d.content}`).join('\n\n');
    const prompt = promptTemplate.replace('{diaries_text}', diariesText);
    try {
      const data = await _llmJson(prompt, JSON_SYSTEM, 1500);
      const evidence = Array.isArray(data.evidence) ? data.evidence : [];
      for (const e of evidence) {
        const text = (e.text || '').trim();
        const date = (e.date || '').trim();
        if (!text) continue;
        const key = `${date}\u0000${text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push({ text, date });
      }
    } catch {
      // 单批失败跳过，不阻断整体
    }
  }
  return all;
}

// ========== 档案生成（含维度确定） ==========

/** 确保固定维度在列表中，AI 维度标记 fixed:false */
function normalizeDimensions(dims: unknown): RelationshipDimension[] {
  const list: RelationshipDimension[] = (Array.isArray(dims) ? dims : []).map((d) => ({
    key: String(d.key || ''),
    label: String(d.label || ''),
    fixed: !!d.fixed,
  }));
  const fixedKeys = new Set(FIXED_DIMENSIONS.map((d) => d.key));
  const existingKeys = new Set(list.map((d) => d.key));
  for (const fd of FIXED_DIMENSIONS) {
    if (!existingKeys.has(fd.key)) list.unshift({ ...fd, fixed: true });
  }
  for (const d of list) d.fixed = fixedKeys.has(d.key);
  return list;
}

/** 生成关系档案（首次确定维度；已确定则只更新档案内容） */
async function _generateRelationshipProfile(
  evidence: RelationshipEvidence[],
  personName: string,
  existingDimensions?: RelationshipDimension[],
  existingProfile?: string,
): Promise<{
  dimensions: RelationshipDimension[];
  profile: string;
  followup_needed: boolean;
  followup_questions: string[];
  opening_message: string;
}> {
  const evidenceText = evidence.length
    ? evidence.map((e) => `【${e.date}】${e.text}`).join('\n\n')
    : '（无证据片段）';

  let prompt: string;
  if (existingDimensions && existingDimensions.length) {
    // 维度已锁定，只更新档案
    const dimsText = existingDimensions.map((d) => `- ${d.label}`).join('\n');
    prompt = `你是一位人际关系分析专家。基于以下证据和已有档案，请更新关于用户与「${personName}」之间关系的档案。

## 已有维度（不可更改）
${dimsText}

## 已有档案
${existingProfile || '（暂无）'}

## 证据片段
${evidenceText}

请基于所有信息，按维度组织更新档案。每个维度用「【维度名】」作为标题，内容为总结性分析。
然后判断档案是否完整。如果某些维度信息严重不足（完全空白或只有一句话），列出需要追问的问题（最多3个）。
如果各维度信息基本充足，不需要追问。

同时，请生成一段开场白给用户：
- 如果档案有缺失字段（followup_needed=true），开场白应该是温柔引导式的追问，用关心而非质问的语气
- 如果档案完整（followup_needed=false），开场白应该是一段简短但富有洞见的话，基于档案中最突出的特点，吸引用户展开讨论
- 开场白不超过100字，口语化，像朋友聊天

输出 JSON：
{
  "profile": "必须是纯文本字符串，用【维度名】作为标题，如：\\n【人格特质】分析内容...",
  "followup_needed": true或false,
  "followup_questions": ["问题1", "问题2"],
  "opening_message": "给用户的开场白"
}

重要：profile 字段必须是纯文本字符串，不要是 JSON 对象或数组。`;
  } else {
    // 首次生成：确定维度 + 生成档案
    const fixedDimsText = FIXED_DIMENSIONS.map((d) => `- ${d.label}：${d.description}`).join('\n');
    prompt = `你是一位人际关系分析专家。基于以下从用户日记中提取的关于「${personName}」的原文片段，请完成两个任务：

## 任务1：确定分析维度

这段关系有4个固定维度：
${fixedDimsText}

除了固定维度外，请根据这段关系的特点，额外选择2-4个最适合的分析维度。选择原则：
- 维度应针对这段关系的独特性（如"权力动态"、"情感依赖"、"沟通障碍"、"信任基础"等）
- 维度名称简洁（4-8字）
- 不要与固定维度重复或重叠

## 任务2：生成档案

基于所有维度（固定+额外），生成一份关于这段关系的档案。每个维度用「【维度名】」作为标题，内容为总结性分析。

然后判断档案是否完整。如果某些维度信息严重不足（完全空白或只有一句话），列出需要追问的问题（最多3个）。
如果各维度信息基本充足，不需要追问。

同时，请生成一段开场白给用户：
- 如果档案有缺失字段（followup_needed=true），开场白应该是温柔引导式的追问，用关心而非质问的语气
- 如果档案完整（followup_needed=false），开场白应该是一段简短但富有洞见的话，基于档案中最突出的特点，吸引用户展开讨论
- 开场白不超过100字，口语化，像朋友聊天

## 证据片段
${evidenceText}

输出 JSON：
{
  "dimensions": [
    {"key": "personality", "label": "人格特质", "fixed": true},
    {"key": "behavior", "label": "行为模式", "fixed": true},
    {"key": "core_conflict", "label": "核心矛盾", "fixed": true},
    {"key": "dynamics", "label": "关系动态", "fixed": true},
    {"key": "your_key_1", "label": "你决定的维度名1", "fixed": false},
    {"key": "your_key_2", "label": "你决定的维度名2", "fixed": false}
  ],
  "profile": "必须是纯文本字符串，用【维度名】作为标题，如：\\n【人格特质】分析内容...",
  "followup_needed": true或false,
  "followup_questions": ["问题1", "问题2"],
  "opening_message": "给用户的开场白"
}

重要：profile 字段必须是纯文本字符串，不要是 JSON 对象或数组。`;
  }

  const data = await _llmJson(prompt, JSON_SYSTEM, 1024);

  // profile 安全转换：如果 LLM 返回的是 dict/list，转为【维度名】文本格式
  let profile = data.profile ?? '';
  if (typeof profile !== 'string') {
    if (profile && typeof profile === 'object') {
      const lines: string[] = [];
      for (const [k, v] of Object.entries(profile)) {
        const val = typeof v === 'string' ? v : JSON.stringify(v);
        lines.push(`【${k}】\n${val}`);
      }
      profile = lines.join('\n\n');
    } else {
      profile = JSON.stringify(profile);
    }
  }

  const dimensions = existingDimensions && existingDimensions.length
    ? existingDimensions
    : normalizeDimensions(data.dimensions);

  return {
    dimensions,
    profile: String(profile),
    followup_needed: !!data.followup_needed,
    followup_questions: Array.isArray(data.followup_questions) ? data.followup_questions.map(String) : [],
    opening_message: data.opening_message != null ? String(data.opening_message) : '',
  };
}

// ========== 从对话中提取事实 ==========

async function _extractFactsFromConversation(
  conversation: Array<{ role: string; content: string }>,
  personName: string,
  existingProfile: string,
  existingDimensions: RelationshipDimension[],
): Promise<{ dimensions: RelationshipDimension[]; profile: string; new_facts: string[] }> {
  const convText = conversation
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content || ''}`)
    .join('\n');

  if (!existingDimensions || !existingDimensions.length) {
    // 维度未确定：将对话内容作为证据来首次生成
    const evidence = [{ text: convText, date: todayStr() }];
    const result = await _generateRelationshipProfile(evidence, personName);
    return {
      dimensions: result.dimensions,
      profile: result.profile,
      new_facts: [],
    };
  }

  // 维度已确定：提取新事实并更新档案
  const dimsText = existingDimensions.map((d) => `- ${d.label}`).join('\n');
  const prompt = `请从以下用户与助手的对话记录中，提取关于「${personName}」的新的事实信息，并据此更新关系档案。

## 已有维度（不可更改）
${dimsText}

## 已有档案
${existingProfile || '（暂无）'}

## 对话记录
${convText}

要求：
1. 只提取用户主动披露的事实性信息（不是助手的分析或推测）
2. 将新信息整合到已有档案中，保持维度结构不变
3. 如果没有新的有价值信息，返回原档案

输出 JSON：
{
  "profile": "更新后的档案文本",
  "new_facts": ["新事实1", "新事实2"]
}`;

  const data = await _llmJson(prompt, JSON_SYSTEM, 1024);
  return {
    dimensions: existingDimensions,
    profile: data.profile != null ? String(data.profile) : existingProfile,
    new_facts: Array.isArray(data.new_facts) ? data.new_facts.map(String) : [],
  };
}

// ========== 非流式 API（与 api 层签名一致） ==========

/** 列出所有人际关系档案 */
export async function listRelationships(): Promise<{ id: string; person_name: string; created_at: string; updated_at: string }[]> {
  const rows = getDiaryStorage().listRelationships(USER_ID);
  return rows.map((r) => ({
    id: String(r.id),
    person_name: String(r.person_name),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  }));
}

/** 创建人际关系档案（本地实现，非流式） */
export async function createRelationship(personName: string): Promise<CreateRelationshipResult> {
  const name = (personName || '').trim();
  if (!name) {
    return { relationship: emptyRelationship(), status: 'no_evidence', message: '人名不能为空' };
  }

  const storage = getDiaryStorage();
  const existing = storage.getRelationshipByName(USER_ID, name);
  if (existing) {
    return { relationship: toRelationship(existing), status: 'already_exists', message: 'already_exists' };
  }

  const rel = storage.createRelationship(USER_ID, name);
  const rid = String(rel.id);
  const today = todayStr();

  const diaries = _searchDiariesForNames(storage, [name]);
  if (!diaries.length) {
    storage.updateRelationship(rid, undefined, undefined, undefined, today);
    return {
      relationship: toRelationship(storage.getRelationship(rid)!),
      status: 'no_evidence',
      message: `未在日记中找到关于「${name}」的内容`,
    };
  }

  const evidence = await _extractEvidenceFromDiaries(diaries, [name]);
  if (!evidence.length) {
    storage.updateRelationship(rid, undefined, undefined, undefined, today);
    return {
      relationship: toRelationship(storage.getRelationship(rid)!),
      status: 'no_evidence',
      message: `未在日记中找到关于「${name}」的有效内容`,
    };
  }

  const result = await _generateRelationshipProfile(evidence, name);
  storage.updateRelationship(
    rid,
    _safeStr(result.profile),
    JSON.stringify(evidence),
    JSON.stringify(result.dimensions),
    today,
  );
  await _registerEntity(name, evidence.map((e) => e.text).join(' '));

  return {
    relationship: toRelationship(storage.getRelationship(rid)!),
    status: result.followup_needed ? 'followup_needed' : 'complete',
    followup_questions: result.followup_questions,
  };
}

/** 获取人际关系档案详情 */
export async function getRelationship(id: string): Promise<Relationship> {
  const rel = getDiaryStorage().getRelationship(id);
  if (!rel) throw new Error('not_found');
  return toRelationship(rel);
}

/** 删除人际关系档案 */
export async function deleteRelationship(id: string): Promise<void> {
  getDiaryStorage().deleteRelationship(id);
}

/** 增量更新：搜索上次以来的新日记，更新档案 */
export async function refreshRelationship(id: string): Promise<RefreshResult> {
  const storage = getDiaryStorage();
  const rel = storage.getRelationship(id);
  if (!rel) {
    return { relationship: emptyRelationship(), status: 'no_new_evidence', message: 'not_found' };
  }

  const personName = String(rel.person_name);
  const lastSearch = rel.last_search_date != null ? String(rel.last_search_date) : undefined;
  const existingDimensions = parseDimensions(rel);
  const existingProfile = String(rel.profile_content || '');
  const existingEvidence = parseEvidence(rel);

  const diaries = _searchDiariesForNames(storage, [personName], lastSearch);
  if (!diaries.length) {
    return {
      relationship: toRelationship(rel),
      status: 'no_new_evidence',
      message: '没有找到新的相关日记',
    };
  }

  const existingDates = new Set(existingEvidence.map((e) => e.date).filter(Boolean));
  const newEvidence = await _extractEvidenceFromDiaries(diaries, [personName], existingDates);
  const allEvidence = existingEvidence.concat(newEvidence);

  const result = await _generateRelationshipProfile(
    allEvidence,
    personName,
    existingDimensions.length ? existingDimensions : undefined,
    existingProfile,
  );

  const today = todayStr();
  storage.updateRelationship(
    id,
    _safeStr(result.profile || existingProfile),
    JSON.stringify(allEvidence),
    JSON.stringify(result.dimensions.length ? result.dimensions : existingDimensions),
    today,
  );

  return {
    relationship: toRelationship(storage.getRelationship(id)!),
    status: result.followup_needed ? 'followup_needed' : 'complete',
    followup_questions: result.followup_questions,
    new_evidence_count: newEvidence.length,
  };
}

/** 分析人物可能的外号/昵称，供用户确认后再创建档案 */
export async function analyzeAliases(personName: string): Promise<AliasCandidate[]> {
  const name = (personName || '').trim();
  if (!name) return [];
  return _analyzeAliasesLocal(getDiaryStorage(), name);
}

/** 从对话记录中提取新事实，更新关系档案 */
export async function extractFromChat(
  id: string,
  conversation: { role: string; content: string }[],
): Promise<{ status: string; new_facts: string[]; relationship: Relationship }> {
  const storage = getDiaryStorage();
  const rel = storage.getRelationship(id);
  if (!rel) {
    return { status: 'error', new_facts: [], relationship: emptyRelationship() };
  }

  const existingProfile = String(rel.profile_content || '');
  const existingDimensions = parseDimensions(rel);

  const result = await _extractFactsFromConversation(
    conversation,
    String(rel.person_name),
    existingProfile,
    existingDimensions,
  );

  const newProfile = _safeStr(result.profile) || existingProfile;
  const newDims = result.dimensions && result.dimensions.length ? result.dimensions : existingDimensions;

  const updateFields: { profile_content?: string; dimensions?: string } = {};
  if (newProfile.trim() && newProfile !== existingProfile) updateFields.profile_content = newProfile;
  if (newDims && JSON.stringify(newDims) !== JSON.stringify(existingDimensions)) {
    updateFields.dimensions = JSON.stringify(newDims);
  }
  if (Object.keys(updateFields).length) {
    storage.updateRelationship(id, updateFields.profile_content, updateFields.dimensions);
  }

  return {
    status: 'ok',
    new_facts: result.new_facts || [],
    relationship: toRelationship(storage.getRelationship(id)!),
  };
}

// ========== 流式 API（本地实现，逐条 yield 事件） ==========

/** 流式创建关系档案（带进度） */
export async function* createRelationshipStream(
  personName: string,
  aliases: string[] = [],
): AsyncGenerator<CreateStreamChunk> {
  const name = (personName || '').trim();
  if (!name) {
    yield { type: 'error', message: '人名不能为空' };
    return;
  }

  const storage = getDiaryStorage();
  const names = aliases.map((a) => a.trim()).filter(Boolean);
  if (!names.includes(name)) names.unshift(name);

  yield { type: 'progress', step: 'creating', message: `正在创建「${name}」的档案...` };
  const rel = storage.createRelationship(USER_ID, name);
  const rid = String(rel.id);
  const today = todayStr();

  yield { type: 'progress', step: 'searching', message: '正在搜索所有日记...' };
  const diaries = _searchDiariesForNames(storage, names);

  if (!diaries.length) {
    storage.updateRelationship(rid, undefined, undefined, undefined, today);
    yield { type: 'progress', step: 'done', message: '未在日记中找到相关内容' };
    yield {
      type: 'result',
      relationship: toRelationship(storage.getRelationship(rid)!),
      status: 'no_evidence',
      message: `未在日记中找到关于「${name}」的内容，请通过对话补充`,
    };
    return;
  }

  yield { type: 'progress', step: 'found_diaries', message: `找到 ${diaries.length} 篇相关日记`, count: diaries.length };
  yield { type: 'progress', step: 'extracting', message: '分析日记...' };
  const evidence = await _extractEvidenceFromDiaries(diaries, names);

  if (!evidence.length) {
    storage.updateRelationship(rid, undefined, undefined, undefined, today);
    yield { type: 'progress', step: 'done', message: '未能提取到有效证据' };
    yield {
      type: 'result',
      relationship: toRelationship(storage.getRelationship(rid)!),
      status: 'no_evidence',
      message: `未提取到关于「${name}」的有效内容`,
    };
    return;
  }

  yield { type: 'progress', step: 'extracted', message: `提取到 ${evidence.length} 条相关内容`, count: evidence.length };
  yield { type: 'progress', step: 'generating', message: '正在生成关系档案（确定维度+分析）...' };
  const result = await _generateRelationshipProfile(evidence, name);

  storage.updateRelationship(
    rid,
    _safeStr(result.profile),
    JSON.stringify(evidence),
    JSON.stringify(result.dimensions),
    today,
  );
  await _registerEntity(name, evidence.map((e) => e.text).join(' '));

  yield { type: 'progress', step: 'done', message: '档案生成完成' };
  yield {
    type: 'result',
    relationship: toRelationship(storage.getRelationship(rid)!),
    status: result.followup_needed ? 'followup_needed' : 'complete',
    followup_questions: result.followup_questions,
    opening_message: result.opening_message,
  };
}

/** 流式刷新关系档案（从日记更新，带进度） */
export async function* refreshRelationshipStream(id: string): AsyncGenerator<RefreshStreamChunk> {
  const storage = getDiaryStorage();
  const rel = storage.getRelationship(id);
  if (!rel) {
    yield { type: 'error', message: 'not_found' };
    return;
  }

  const personName = String(rel.person_name);
  const lastSearch = rel.last_search_date != null ? String(rel.last_search_date) : undefined;
  const existingDimensions = parseDimensions(rel);
  const existingProfile = String(rel.profile_content || '');
  const existingEvidence = parseEvidence(rel);
  const existingDates = new Set(existingEvidence.map((e) => e.date).filter(Boolean));

  yield { type: 'progress', step: 'searching', message: '正在搜索上次以来的新日记...' };
  const diaries = _searchDiariesForNames(storage, [personName], lastSearch);

  if (!diaries.length) {
    yield { type: 'progress', step: 'done', message: '没有找到新的相关日记' };
    yield {
      type: 'result',
      relationship: toRelationship(rel),
      status: 'no_new_evidence',
      message: '没有找到新的相关日记',
    };
    return;
  }

  yield { type: 'progress', step: 'found_diaries', message: `找到 ${diaries.length} 篇新日记`, count: diaries.length };
  yield { type: 'progress', step: 'extracting', message: '分析日记...' };
  const newEvidence = await _extractEvidenceFromDiaries(diaries, [personName], existingDates);
  const allEvidence = existingEvidence.concat(newEvidence);

  yield {
    type: 'progress',
    step: 'extracted',
    message: `提取到 ${newEvidence.length} 条新内容，共 ${allEvidence.length} 条`,
    count: newEvidence.length,
  };
  yield { type: 'progress', step: 'generating', message: '正在更新关系档案...' };

  const result = await _generateRelationshipProfile(
    allEvidence,
    personName,
    existingDimensions.length ? existingDimensions : undefined,
    existingProfile,
  );

  const today = todayStr();
  storage.updateRelationship(
    id,
    _safeStr(result.profile || existingProfile),
    JSON.stringify(allEvidence),
    JSON.stringify(result.dimensions.length ? result.dimensions : existingDimensions),
    today,
  );

  yield { type: 'progress', step: 'done', message: '档案更新完成' };
  yield {
    type: 'result',
    relationship: toRelationship(storage.getRelationship(id)!),
    status: result.followup_needed ? 'followup_needed' : 'complete',
    followup_questions: result.followup_questions,
    new_evidence_count: newEvidence.length,
    opening_message: result.opening_message,
  };
}

/** 人际关系分析对话 - 流式（觉察伙伴人设注入关系档案/证据/追问） */
export async function* streamRelationshipChat(
  relationshipId: string,
  message: string,
  conversationHistory: { role: string; content: string }[],
  followupQuestions: string[],
): AsyncGenerator<{ type: string; content: string }> {
  const storage = getDiaryStorage();
  const rel = storage.getRelationship(relationshipId);
  if (!rel) {
    yield { type: 'response', content: '（连接异常）' };
    return;
  }

  const personName = String(rel.person_name);
  const profileContent = String(rel.profile_content || '');
  const evidence = parseEvidence(rel);
  const dimensions = parseDimensions(rel);
  const userProfile = storage.getUserProfile(USER_ID);

  // 构建证据日记文本（只注入有证据的日记）
  const evidenceDates = Array.from(new Set(evidence.map((e) => e.date).filter(Boolean))).sort();
  let evidenceDiariesText = '';
  if (evidenceDates.length) {
    const entries: string[] = [];
    for (const ed of evidenceDates) {
      const d = storage.getDiaryByDate(ed, USER_ID);
      if (d && d.content) {
        entries.push(`【${d.date}】\n${stripHtml(d.content)}`);
      }
    }
    evidenceDiariesText = entries.join('\n\n');
  }

  const dimsText = dimensions.length ? dimensions.map((d) => `- ${d.label}`).join('\n') : '';

  let historyText = '';
  for (const m of conversationHistory || []) {
    historyText += `${m.role === 'user' ? '用户' : '觉察伙伴'}: ${m.content || ''}\n`;
  }

  let followupText = '';
  if (followupQuestions && followupQuestions.length) {
    followupText =
      '\n## 待补充的问题\n' +
      followupQuestions.map((q) => `- ${q}`).join('\n') +
      '\n请在对话中自然地引导用户回答这些问题，不要一次性全部抛出。回答完后再进入深层觉察对话。\n';
  }

  const system = buildAwarenessSystem(null);
  const userPrompt = `## 当前关系分析
你正在帮助用户分析与「${personName}」的人际关系。

### 关系档案
${profileContent || '（档案尚未生成，请通过对话了解这段关系）'}

### 分析维度
${dimsText || '（未设定，将在对话后根据用户提供的信息确定）'}

### 用户档案
${userProfile || '（暂无）'}

### 相关日记（仅含证据日记）
${evidenceDiariesText || '（无相关日记）'}
${followupText}
### 对话历史
${historyText || '（这是对话的开始）'}

### 用户最新消息
${message}

请以觉察伙伴的身份，帮助用户深入思考这段关系：`;

  // 本地流式输出（无 SSE，直接逐条 yield）
  for await (const ev of generateStream(userPrompt, {
    system,
    think: false,
    numPredict: 8192,
    temperature: 0.6,
  })) {
    if (ev.type === 'thinking') {
      yield { type: 'thinking', content: ev.content };
    } else if (ev.type === 'response') {
      yield { type: 'response', content: ev.content };
    }
  }
}