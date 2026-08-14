/**
 * local/profile.ts — 手机端本地用户画像服务（本地化改造）
 *
 * 与 api/profile.ts 保持完全相同的函数签名与返回结构，
 * 但内部改用：
 *  - 本地持久化 → core/db/diaryDb.ts 的 user_profiles 表（getUserProfile /
 *    getUserProfileDiaryCount / saveUserProfile，与后端 user_profiles 表逐字等价）
 *  - 本地 LLM   → core/modelService.ts（getModelClient / generate）
 *  - 近期日记   → core/db/diaryDb.ts（getAllDiaries）
 *  - 觉察报告   → core/db/insightDb.ts（getInsightHistory）
 *
 * 画像结构与后端 profile_routes.py 完全一致：
 * 固定五维 JSON（personality_traits / behavior_patterns / core_conflicts /
 * relationship_dynamics / supplementary），每维 2-6 条，增量融合更新。
 *
 * 页面只需把 `../api/profile` 改为 `../local/profile` 即可无缝切换。
 * 纯本地实现，不 import 任何 HTTP api client。
 */

import { getDiaryStorage } from '../core/db/diaryDb';
import { getModelClient, generate, generateStream } from '../core/modelService';
import { stripHtml } from '../core/utils/chatUtils';

// ==========================================
// 常量（与后端 profile_routes.py 一致）
// ==========================================

/** 当前本地用户（手机端单机默认） */
const USER_ID = 'default';

/** 每新增多少篇日记触发一次画像更新 */
const PROFILE_INTERVAL = 5;

/** 画像的固定维度结构（供前端解析与各 AI 注入） */
export const PROFILE_DIMENSIONS = [
  'personality_traits',
  'behavior_patterns',
  'core_conflicts',
  'relationship_dynamics',
  'supplementary',
];

// ==========================================
// 工具函数
// ==========================================

/** 从 LLM 输出中提取合法 JSON，若失败则返回原始文本（前端可降级展示） */
function extractProfileJson(raw: string): string {
  if (!raw) return '';
  let text = raw.trim();
  // 去掉可能的 ```json 代码块包裹
  if (text.startsWith('```')) {
    const lines = text.split('\n');
    if (lines && lines[0].startsWith('```')) lines.shift();
    if (lines && lines[lines.length - 1].trim() === '```') lines.pop();
    text = lines.join('\n').trim();
  }
  // 尝试直接解析 JSON
  try {
    JSON.parse(text);
    return text;
  } catch {
    // 直接解析失败：尝试在文本中搜索 JSON 对象（模型可能输出了多余的前缀文本）
    const start = text.indexOf('{');
    if (start !== -1) {
      // 从第一个 { 开始，尝试逐段截取，找到能合法解析的最长 JSON
      let depth = 0;
      let jsonEnd = -1;
      for (let i = start; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') {
          depth--;
          if (depth === 0) {
            jsonEnd = i + 1;
            break;
          }
        }
      }
      if (jsonEnd !== -1) {
        const candidate = text.slice(start, jsonEnd);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          // 截取到的 JSON 仍不合法，返回原始文本
        }
      }
    }
    // 完全无法解析，返回原始文本（非空，前端可降级展示或提示）
    return raw.trim();
  }
}

/**
 * 读取本地觉察报告文本（与后端 _load_insight_text 思路一致：
 * 汇总最近一次觉察结果的各支线观察，拼成纯文本）。
 */
function loadInsightText(): string {
  try {
    const { getInsightStorage } = require('../core/db/insightDb') as typeof import('../core/db/insightDb');
    const latest = getInsightStorage().getLatestInsight(USER_ID);
    if (!latest) return '';
    const texts: string[] = [];
    for (const b of latest.branches || []) {
      const t = b.observation || b.title || '';
      if (t) texts.push(t);
    }
    return texts.join('\n\n');
  } catch {
    return '';
  }
}

/**
 * 构建用户画像生成提示词（增量融合 + 结构化 JSON，与后端 _build_profile_prompt 一致）。
 */
function buildProfilePrompt(
  oldProfile: string,
  newDiariesText: string,
  insightText: string,
): { system: string; prompt: string } {
  const system = `你是一位深度心理分析专家。你的任务是维护一份关于用户的成长档案。

【核心原则】
- 基于「旧档案」与「新增日记/觉察报告」，融合更新，而非从零重写
- 保留仍然成立的旧洞察；更新已经变化的部分；移除不再符合的描述；补充新发现的模式
- 提炼深层模式，不罗列事实；用简洁但深刻的语言
- 单个、孤立的生活事件（如一次购物失误、一次情绪爆发）只作为情境背景，不要当作稳定的人格特质反复强调；重点提炼跨事件反复出现的稳定行为模式与深层心理结构

【输出格式】必须输出一个合法 JSON 对象，结构固定如下：
{
  "basic_info": {
    "name": "姓名（从日记中提取，无法确定则填空串）",
    "nickname": "外号/昵称（从日记中提取，无法确定则填空串）",
    "identity": "主要身份/社会身份/职业（从日记中提取，无法确定则填空串）",
    "age": "年龄（从日记中提取，无法确定则填空串）",
    "gender": "性别（从日记中提取，无法确定则填空串）",
    "birthday": "生日（从日记中提取，无法确定则填空串）",
    "address": "住址/所在地（从日记中提取，无法确定则填空串）",
    "relationship_status": "感情状态（单身/恋爱/已婚等，从日记中提取，无法确定则填空串）",
    "hometown": "家乡（从日记中提取，无法确定则填空串）",
    "education": "教育背景/学历（从日记中提取，无法确定则填空串）",
    "hobbies": "兴趣爱好（从日记中提取，无法确定则填空串）"
  },
  "personality_traits": ["人格特质，每条一句话"],
  "behavior_patterns": ["行为模式，可含触发情境与应对策略"],
  "core_conflicts": ["核心矛盾，内心深处的冲突与纠结"],
  "relationship_dynamics": ["关系动态，与重要他人的互动模式"],
  "supplementary": ["补充维度，自主判断需要补充的其他重要信息"]
}
要求：
- basic_info 中的每个字段从日记中提取，无法确定的信息就填空串，不要编造
- 每个数组至少 2 条，最多 6 条
- 只输出 JSON 本身，不要任何解释、开场白或多余文本
- 若旧档案为空（首次生成），则完全基于新增日记提炼`;

  const oldSection = oldProfile
    ? `══════════════════════════════════════════
【旧档案】(JSON)
══════════════════════════════════════════
${oldProfile}

`
    : '（首次生成，无旧档案）\n\n';

  const prompt = `${oldSection}
══════════════════════════════════════════
【本次新增日记】(按日期排列)
══════════════════════════════════════════
${newDiariesText}

══════════════════════════════════════════
【觉察报告】
══════════════════════════════════════════
${insightText ? insightText : '（暂无觉察报告）'}

请基于以上内容，融合更新用户档案，输出完整新档案 JSON。`;

  return { system, prompt };
}

// ==========================================
// API 兼容函数（与 api/profile.ts 结构一致）
// ==========================================

/** 读取本地用户画像（与后端 GET /api/profile 返回结构一致） */
export async function getProfile(): Promise<{ content: string; has_profile: boolean }> {
  const storage = getDiaryStorage();
  const content = storage.getUserProfile(USER_ID);
  return {
    content,
    has_profile: Boolean(content.trim()),
  };
}

/**
 * 用本地 LLM 结合近期日记重新生成/更新用户画像（增量融合，覆盖旧档案）。
 * 与后端 POST /api/profile/update 逻辑一致：取上次生成计数之后的新增日记，
 * 与旧档案融合生成完整新档案 JSON，写入本地 user_profiles 并记录本次日记基数。
 */
export async function updateProfile(): Promise<{ content: string; message: string }> {
  const storage = getDiaryStorage();

  // 1. 获取全部日记，按日期排序，过滤有效内容（与后端一致：长度 > 10）
  const diaries = storage.getAllDiaries(USER_ID);
  const valid = diaries.filter((d) => d.content && stripHtml(d.content).length > 10);
  const totalCount = valid.length;
  if (totalCount === 0) {
    return { content: '', message: '日记数据不足，无法生成档案' };
  }

  // 2. 区分旧画像与新增日记
  const oldProfile = storage.getUserProfile(USER_ID);
  const lastCount = storage.getUserProfileDiaryCount(USER_ID);
  // 增量：取上次生成计数之后的新增日记
  const newDiaries = lastCount > 0 ? valid.slice(lastCount) : valid;

  // 首次生成需至少满 PROFILE_INTERVAL 篇；增量则至少新增 1 篇
  if (!oldProfile && totalCount < PROFILE_INTERVAL) {
    return { content: '', message: '日记数据不足，无法生成档案' };
  }
  if (!newDiaries.length) {
    return { content: oldProfile, message: '档案已更新' };
  }

  // 3. 拼接新增日记文本（【日期】前缀，剥离 HTML，截断避免超长）
  let newDiariesText = newDiaries
    .map((d) => `【${d.date}】\n${stripHtml(d.content)}`)
    .join('\n\n');
  if (newDiariesText.length > 6000) {
    newDiariesText = newDiariesText.slice(-6000);
  }

  // 4. 获取觉察报告
  const insightText = loadInsightText();

  // 5. 调用本地 LLM 生成画像（jsonMode 结构化输出）
  const { system, prompt } = buildProfilePrompt(oldProfile, newDiariesText, insightText);
  let raw = '';
  try {
    const client = getModelClient();
    const res = await client.call(prompt, system, {
      jsonMode: true,
      numPredict: 4096,
      temperature: 0.4,
    });
    raw = res.response || '';
  } catch {
    // 模型客户端失败时回退到 generate
    raw = await generate(prompt, {
      system,
      jsonMode: true,
      numPredict: 4096,
      temperature: 0.4,
    }).catch(() => '');
  }

  const content = extractProfileJson(raw);

  // 6. 保存到本地 user_profiles，记录本次日记基数
  if (content) {
    storage.saveUserProfile(USER_ID, content, totalCount);
    // 同步提取 basic_info 到 user_meta（仅填充空白字段，不覆盖用户手动编辑）
    saveBasicInfoFromProfile(content);
    return { content, message: '档案已更新' };
  }

  // LLM 输出解析失败：保留旧画像（若有），否则提示失败
  if (oldProfile.trim()) {
    return { content: oldProfile, message: '档案生成失败，已保留上次档案' };
  }
  return { content: '', message: '档案生成失败，请稍后重试' };
}

// ==========================================
// 基础信息（Basic Info）
// ==========================================

// ==========================================
// 结构化输出（Structured Outputs）— JSON Schema
// ==========================================

/** 用户档案 JSON Schema，用于 Ollama 约束解码（Constrained Decoding） */
export const PROFILE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    basic_info: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        nickname: { type: 'string' },
        identity: { type: 'string' },
        age: { type: 'string' },
        gender: { type: 'string' },
        birthday: { type: 'string' },
        address: { type: 'string' },
        relationship_status: { type: 'string' },
        hometown: { type: 'string' },
        education: { type: 'string' },
        hobbies: { type: 'string' },
      },
      required: ['name', 'nickname', 'identity', 'age', 'gender', 'birthday',
        'address', 'relationship_status', 'hometown', 'education', 'hobbies'],
    },
    personality_traits: {
      type: 'array',
      items: { type: 'string' },
      minItems: 2,
      maxItems: 6,
    },
    behavior_patterns: {
      type: 'array',
      items: { type: 'string' },
      minItems: 2,
      maxItems: 6,
    },
    core_conflicts: {
      type: 'array',
      items: { type: 'string' },
      minItems: 2,
      maxItems: 6,
    },
    relationship_dynamics: {
      type: 'array',
      items: { type: 'string' },
      minItems: 2,
      maxItems: 6,
    },
    supplementary: {
      type: 'array',
      items: { type: 'string' },
      minItems: 2,
      maxItems: 6,
    },
  },
  required: ['basic_info', 'personality_traits', 'behavior_patterns',
    'core_conflicts', 'relationship_dynamics', 'supplementary'],
};

// ==========================================
// 流式档案更新（Structured Outputs + 逐字段填充）
// ==========================================

/** 流式档案更新事件类型 */
export type ProfileStreamEvent =
  | { type: 'basic_info_field'; key: keyof BasicInfo; value: string }
  | { type: 'dimension_item'; key: string; items: string[] }
  | { type: 'progress'; text: string }
  | { type: 'done'; content: string; message: string }
  | { type: 'error'; message: string };

/**
 * 流式档案更新：使用结构化输出（JSON Schema 约束解码）+ 流式响应，
 * 逐字段产出 ProfileStreamEvent，前端可实时展示字段填充过程。
 *
 * 底层原理：
 * 1. 向 Ollama 发送 `format: <JSON Schema>`，启用约束解码，保证输出符合 Schema
 * 2. 流式接收 token，增量解析部分 JSON，每当检测到新字段填充完成即 yield
 */
export async function* updateProfileStream(): AsyncGenerator<ProfileStreamEvent> {
  const storage = getDiaryStorage();

  // 1. 获取全部日记
  const diaries = storage.getAllDiaries(USER_ID);
  const valid = diaries.filter((d) => d.content && stripHtml(d.content).length > 10);
  const totalCount = valid.length;
  if (totalCount === 0) {
    yield { type: 'error', message: '日记数据不足，无法生成档案' };
    return;
  }

  // 2. 区分旧画像与新增日记
  const oldProfile = storage.getUserProfile(USER_ID);
  const lastCount = storage.getUserProfileDiaryCount(USER_ID);
  const newDiaries = lastCount > 0 ? valid.slice(lastCount) : valid;

  if (!oldProfile && totalCount < PROFILE_INTERVAL) {
    yield { type: 'error', message: '日记数据不足，无法生成档案' };
    return;
  }
  if (!newDiaries.length) {
    yield { type: 'done', content: oldProfile, message: '档案已是最新' };
    return;
  }

  // 3. 拼接新增日记文本
  let newDiariesText = newDiaries
    .map((d) => `【${d.date}】\n${stripHtml(d.content)}`)
    .join('\n\n');
  if (newDiariesText.length > 6000) {
    newDiariesText = newDiariesText.slice(-6000);
  }

  // 4. 获取觉察报告
  const insightText = loadInsightText();

  // 5. 构建提示词
  const { system, prompt } = buildProfilePrompt(oldProfile, newDiariesText, insightText);

  yield { type: 'progress', text: 'AI 正在分析日记...' };

  // 6. 流式调用 LLM，使用 JSON Schema 约束解码
  let accumulated = '';
  let prevBasicInfo: Record<string, string> = {};
  let prevDims: Record<string, string[]> = {};

  try {
    const stream = generateStream(prompt, {
      system,
      jsonSchema: PROFILE_JSON_SCHEMA,
      numPredict: 4096,
      temperature: 0.4,
      think: false,
    });

    for await (const event of stream) {
      if (event.type === 'response') {
        accumulated += event.content;

        // 用正则从部分 JSON 文本中直接提取已闭合的 basic_info 字段，
        // 不依赖 JSON.parse（流式过程中 JSON 结构尚未闭合，parse 会失败）
        const newFields = extractCompletedBasicInfoFields(accumulated, prevBasicInfo);
        if (newFields) {
          for (const [key, value] of Object.entries(newFields)) {
            prevBasicInfo[key] = value;
            yield { type: 'basic_info_field', key: key as keyof BasicInfo, value };
          }
        }

        // 同样用正则提取维度数组中已完成的条目
        for (const dim of PROFILE_DIMENSIONS) {
          const items = extractCompletedArrayItems(accumulated, dim);
          const prev = prevDims[dim] || [];
          if (items.length > prev.length) {
            prevDims[dim] = items;
            yield { type: 'dimension_item', key: dim, items };
          }
        }
      }
    }
  } catch (e: any) {
    yield { type: 'error', message: e?.message || '模型调用失败' };
    return;
  }

  // 7. 解析完整 JSON，保存并返回
  const content = extractProfileJson(accumulated);
  if (content) {
    storage.saveUserProfile(USER_ID, content, totalCount);
    saveBasicInfoFromProfile(content);
    yield { type: 'done', content, message: '档案已更新' };
  } else {
    // 回退：保存原始文本
    if (accumulated.trim()) {
      storage.saveUserProfile(USER_ID, accumulated.trim(), totalCount);
      yield { type: 'done', content: accumulated.trim(), message: '档案已更新（原始文本）' };
    } else {
      yield { type: 'error', message: '模型未返回有效内容' };
    }
  }
}

/**
 * 从部分 JSON 文本中提取已完成的 basic_info 字段。
 * 使用正则匹配 "field": "value" 模式，value 必须完整闭合（含尾部引号）。
 * 不依赖 JSON.parse，因此流式过程中即使 JSON 结构尚未闭合也能检测到已完成的字段。
 */
function extractCompletedBasicInfoFields(
  text: string,
  prevFields: Record<string, string>,
): Record<string, string> | null {
  const result: Record<string, string> = {};
  let hasNew = false;
  for (const field of BASIC_INFO_FIELDS) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 匹配 "field": "value" 且 value 是完整 JSON 字符串（含转义符处理）
    const re = new RegExp(`"${escaped}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
    const m = text.match(re);
    if (m) {
      const val = m[1];
      if (val && val !== (prevFields[field] || '')) {
        result[field] = val;
        hasNew = true;
      }
    }
  }
  return hasNew ? result : null;
}

/**
 * 从部分 JSON 文本中提取指定维度的已完成的数组条目。
 * 可以处理不完整的数组（尚未输出闭合 ]），匹配从 [ 开始的所有已闭合字符串条目。
 */
function extractCompletedArrayItems(text: string, dim: string): string[] {
  const escaped = dim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 匹配 "dim": [ ... ] 或 "dim": [ ... (未闭合)，提取数组内容
  const re = new RegExp(`"${escaped}"\\s*:\\s*\\[((?:[^\\[\\]]|\\[.*?\\])*?)(?:\\]|$)`, 's');
  const m = text.match(re);
  if (!m) return [];
  const arrayContent = m[1];
  // 提取所有已完成的字符串条目
  const itemRe = /"((?:[^"\\\\]|\\\\.)*)"/g;
  const items: string[] = [];
  let im: RegExpExecArray | null;
  while ((im = itemRe.exec(arrayContent)) !== null) {
    items.push(im[1]);
  }
  return items;
}

/** 基础信息字段列表 */
const BASIC_INFO_FIELDS = ['name', 'nickname', 'identity', 'age', 'gender', 'birthday', 'address', 'relationship_status', 'hometown', 'education', 'hobbies'] as const;

export type BasicInfoField = (typeof BASIC_INFO_FIELDS)[number];

export interface BasicInfo {
  name: string;
  nickname: string;
  identity: string;
  age: string;
  gender: string;
  birthday: string;
  address: string;
  relationship_status: string;
  hometown: string;
  education: string;
  hobbies: string;
}

/** 从档案 JSON 中提取 basic_info，保存到 user_meta（仅填充空白字段，不覆盖已有值） */
function saveBasicInfoFromProfile(profileJson: string): void {
  try {
    const data = JSON.parse(profileJson);
    const basicInfo = data?.basic_info;
    if (!basicInfo || typeof basicInfo !== 'object') return;

    const storage = getDiaryStorage();
    const currentRaw = storage.getUserMeta(USER_ID, 'basic_info');
    let current: Record<string, string> = {};
    if (currentRaw) {
      try { current = JSON.parse(currentRaw); } catch { current = {}; }
    }
    if (typeof current !== 'object') current = {};

    let changed = false;
    for (const field of BASIC_INFO_FIELDS) {
      const val = (basicInfo[field] || '').trim();
      if (val && !(current[field] || '').trim()) {
        current[field] = val;
        changed = true;
      }
    }
    if (changed) {
      storage.setUserMeta(USER_ID, 'basic_info', JSON.stringify(current));
    }
  } catch {
    // 静默失败，不阻塞主流程
  }
}

/** 获取用户基础信息（从 user_meta 读取） */
export function getBasicInfo(): BasicInfo {
  const storage = getDiaryStorage();
  const raw = storage.getUserMeta(USER_ID, 'basic_info');
  try {
    const data = raw ? JSON.parse(raw) : {};
    return {
      name: (data.name || '').trim(),
      nickname: (data.nickname || '').trim(),
      identity: (data.identity || '').trim(),
      age: (data.age || '').trim(),
      gender: (data.gender || '').trim(),
      birthday: (data.birthday || '').trim(),
      address: (data.address || '').trim(),
      relationship_status: (data.relationship_status || '').trim(),
      hometown: (data.hometown || '').trim(),
      education: (data.education || '').trim(),
      hobbies: (data.hobbies || '').trim(),
    };
  } catch {
    return { name: '', nickname: '', identity: '', age: '', gender: '', birthday: '', address: '', relationship_status: '', hometown: '', education: '', hobbies: '' };
  }
}

/** 保存用户手动编辑的基础信息（覆盖式写入 user_meta） */
export function saveBasicInfo(info: BasicInfo): void {
  const storage = getDiaryStorage();
  const data: Record<string, string> = {};
  for (const field of BASIC_INFO_FIELDS) {
    data[field] = (info[field] || '').trim();
  }
  storage.setUserMeta(USER_ID, 'basic_info', JSON.stringify(data));
}