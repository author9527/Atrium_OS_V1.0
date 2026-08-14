/**
 * local/statistics.ts — 手机端本地统计服务（Phase 5）
 *
 * 与 api/statistics.ts 保持完全相同的函数签名与返回结构，
 * 但内部不再走 HTTP，改为 core/db/diaryDb.ts 本地 SQLite + 本地计算：
 *  - 情绪均值雷达 / 张力  → 直接读 calendar_cache 的 emotion_vector 本地统计
 *  - 生活摘要(鱼骨)      → 本地 fishbone_events 表 + 本地 LLM 增量提取
 *  - 开场白              → 本地 LLM 生成（非流式/流式）
 *
 * 页面只需把 `../api/statistics` 改为 `../local/statistics` 即可无缝切换。
 */

import { getDiaryStorage } from '../core/db/diaryDb';
import { generate, generateStream } from '../core/modelService';
import { stripHtml } from '../core/utils/chatUtils';

// 与 api/statistics.ts 一致的类型
export interface TensionItem {
  date: string;
  /** 无日记/无情绪向量时为 null，前端只显示日期刻度 */
  value: number | null;
}

export interface EmotionRadarData {
  /** 8 个基础情绪轴，顺序固定 */
  axes: string[];
  /** 近10天均值向量（各维度独立取均值，0-100） */
  recent10: number[];
  /** 第11~30天均值向量 */
  recent30: number[];
  /** 参与均值的有效日记数 */
  recent10_count: number;
  recent30_count: number;
  /** 近3天张力：单日 4 对正对轴 (A+B)/2 之和，可超 100 */
  tension: TensionItem[];
  total_diaries: number;
}

export interface FishboneEvent {
  id: number;
  date: string;
  summary: string;
}

/** 当前本地用户（手机端单机默认） */
const USER_ID = 'default';

// ========== 情绪均值雷达 + 张力（与后端 statistics_routes.py 一致） ==========
// 8 基础情绪（普拉奇克），顺序固定，作为雷达图与打分向量的轴
const AXES = ['喜悦', '信任', '恐惧', '惊讶', '悲伤', '厌恶', '愤怒', '期待'];

// 张力只统计 4 对正对轴（对立情绪），每对用调和平均 2*P*N/(P+N) 度量共现强度
const TENSION_PAIRS: Array<[number, number]> = [
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

/** 把 calendar_cache 里的 emotion_vector（JSON 字符串）解析为长度 8 的分数列表。
 * 缺失、为空或解析失败返回 null。全 0 视为无有效打分。 */
function parseVector(raw: string): number[] | null {
  if (!raw) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  const vals = AXES.map((a) => {
    let v: unknown = o[a];
    if (v === null || v === undefined) {
      // 容错：允许键带"情绪"等修饰
      for (const k of Object.keys(o)) {
        if (k.includes(a)) {
          v = o[k];
          break;
        }
      }
    }
    let n = Math.round(Number(v));
    if (Number.isNaN(n)) n = 0;
    return Math.max(0, Math.min(100, n));
  });
  if (vals.every((v) => v === 0)) return null;
  return vals;
}

/** 对一组长度 8 的分数列表逐维取均值（各维度独立，不互相抵消）。 */
function meanVector(vectors: number[][]): number[] {
  if (!vectors.length) return [0, 0, 0, 0, 0, 0, 0, 0];
  const n = vectors.length;
  const sums = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const v of vectors) {
    for (let i = 0; i < 8; i++) sums[i] += v[i];
  }
  return sums.map((s) => s / n);
}

/** 单日张力 = 4 对正对轴对立情绪"同时共现"强度的均方根(RMS)。
 * 每对用调和平均 2*P*N/(P+N) 度量，某一极缺失时该对贡献为 0；
 * 最后对四对求均方根。返回向下取整后的整数。 */
function dailyTension(vector: number[]): number {
  let sum = 0;
  for (const [a, b] of TENSION_PAIRS) {
    const p = vector[a];
    const n = vector[b];
    const s = p + n;
    const h = s <= 0 ? 0 : (2 * p * n) / s;
    sum += h * h;
  }
  return Math.floor(Math.sqrt(sum / TENSION_PAIRS.length));
}

/** 以用户最新一篇日记的日期作为"当前"参照（手机端与服务器时钟可能存在时差，
 * 沿用最新日记避免最新日记被当"未来"排除）。无日记时回退到今天。 */
function referenceToday(): string {
  const storage = getDiaryStorage();
  const diaries = storage.getAllDiaries(USER_ID);
  let latest = '';
  for (const d of diaries) {
    if (d.date > latest) latest = d.date;
  }
  if (latest) return latest;
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** 近10天 / 第11~30天逐日 8 维打分独立取均值的雷达 + 近3天张力。 */
export async function getEmotionRadar(): Promise<EmotionRadarData> {
  const storage = getDiaryStorage();
  const diaries = storage.getAllDiaries(USER_ID);
  const todayStr = referenceToday();
  const today = new Date(todayStr + 'T00:00:00');

  const buckets: { recent10: number[][]; recent30: number[][] } = {
    recent10: [],
    recent30: [],
  };
  for (const d of diaries) {
    const dDate = new Date(d.date + 'T00:00:00');
    if (Number.isNaN(dDate.getTime())) continue;
    const diff = Math.floor((today.getTime() - dDate.getTime()) / 86400000);
    if (diff < 0) continue;
    const cache = storage.getCalendarCache(d.date, USER_ID);
    const vec = parseVector(cache ? cache.emotion_vector : '');
    if (!vec) continue;
    if (diff <= 9) buckets.recent10.push(vec);
    else if (diff <= 29) buckets.recent30.push(vec);
  }

  // 空态规则：近10天 <2 篇 或 近30天 <3 篇 视为空雷达（返回全 0，前端画空心轮廓）
  const recent10 = buckets.recent10.length < 2 ? [0, 0, 0, 0, 0, 0, 0, 0] : meanVector(buckets.recent10);
  const recent30 = buckets.recent30.length < 3 ? [0, 0, 0, 0, 0, 0, 0, 0] : meanVector(buckets.recent30);

  // 张力柱状图：返回最近 10 天（含今天）的槽位，某天无向量时 value 置为 null
  const tension: TensionItem[] = [];
  for (let offset = 9; offset >= 0; offset--) {
    const d = new Date(today.getTime() - offset * 86400000);
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const cache = storage.getCalendarCache(ds, USER_ID);
    const vec = parseVector(cache ? cache.emotion_vector : '');
    tension.push(vec ? { date: ds, value: dailyTension(vec) } : { date: ds, value: null });
  }

  const round1 = (v: number) => Math.round(v * 10) / 10;

  return {
    axes: AXES,
    recent10: recent10.map(round1),
    recent30: recent30.map(round1),
    recent10_count: buckets.recent10.length,
    recent30_count: buckets.recent30.length,
    tension,
    total_diaries: diaries.length,
  };
}

// ========== 生活摘要（鱼骨）：本地 fishbone_events 表 + 本地 LLM 提取 ==========
export async function getFishbone(): Promise<{ events: FishboneEvent[] }> {
  const storage = getDiaryStorage();
  const events = storage
    .getFishboneEvents(USER_ID)
    .map((e) => ({ id: e.id, date: e.date, summary: e.summary }));
  return { events };
}

const FISHBONE_PROMPT = `你是生活摘要助手。请为每篇日记生成一条简短摘要，捕捉当天最有意义的内容（如关键决定、情绪变化、有意义的事件、值得回看的生活片段）。忽略纯流水账。

## 新日记
{diary_text}

为每篇日记生成恰好一条摘要（20-40字，自然通顺的一句话，具体不抽象，如"下定决心换个新工作"、"和老同学久别重逢很激动"）。

输出 JSON 数组，每个元素含：
- date: 日记日期（YYYY-MM-DD）
- summary: 一句话摘要

只输出 JSON 数组，不要任何额外文字。`;

/** 把模型返回的日期统一成 YYYY-MM-DD；无法识别时返回空串（由调用方回退到日记日期）。 */
function normalizeDate(s: string): string {
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec((s || '').trim());
  if (!m) return '';
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

/**
 * 从模型输出中解析摘要数组。兼容多种形态：
 *   - 裸数组：[...]
 *   - 裸单个对象：{"date":..., "summary":...}
 *   - 包裹对象：{"events": [...]} / {"events": {...}}
 * 只保留 summary 非空的条目。
 */
function parseFishboneEvents(text: string): Array<{ date: string; summary: string }> {
  const events: Array<{ date: string; summary: string }> = [];
  const candidates: string[] = [text || ''];
  const m = /\[.*\]/s.exec(text || '');
  if (m) candidates.push(m[0]);
  for (const cand of candidates) {
    try {
      let data = JSON.parse(cand.trim());
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        // {events: 数组} 或 {events: 单个对象}
        if ((data as Record<string, unknown>).events !== undefined) {
          data = (data as Record<string, unknown>).events;
        }
        // 仍是单个对象 → 收进数组
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          data = [data];
        }
      }
      if (Array.isArray(data)) {
        const parsed: Array<{ date: string; summary: string }> = [];
        for (const ev of data) {
          if (ev && typeof ev === 'object') {
            const summary = String((ev as Record<string, unknown>).summary || '').trim();
            if (summary) {
              parsed.push({ date: String((ev as Record<string, unknown>).date || '').trim(), summary });
            }
          }
        }
        if (parsed.length) {
          events.push(...parsed);
          break;
        }
      }
    } catch {
      // 解析失败尝试下一个候选
    }
  }
  return events;
}

export interface FishboneProgress {
  total: number;
  done: number;
  date: string;
}

/**
 * 手动触发鱼骨摘要提取（界面「生成摘要」按钮用）。
 * 返回本次新增的事件数和待处理日记数，支持逐篇进度回调。
 * 幂等：已生成摘要的日期会跳过，可随时中断续跑。
 */
export async function runFishboneExtract(
  onProgress?: (p: FishboneProgress) => void,
): Promise<{ added: number; total: number }> {
  return extractFishboneIncremental(onProgress);
}

/** 触发鱼骨增量提取（App 进入后台时调用，fire-and-forget）。内部走本地 LLM。 */
export async function triggerFishboneExtract(): Promise<void> {
  try {
    await extractFishboneIncremental();
  } catch (e) {
    console.error('触发鱼骨提取失败:', e);
  }
}

/**
 * 摘要提取核心：按"缺失日期"幂等补齐，已生成摘要的日记直接跳过。
 * 每篇生成一条摘要，单篇失败不中断其余。返回 {added, total}。
 */
async function extractFishboneIncremental(
  onProgress?: (p: FishboneProgress) => void,
): Promise<{ added: number; total: number }> {
  const storage = getDiaryStorage();
  const all = storage.getAllDiaries(USER_ID);
  const existing = new Set(storage.getFishboneEvents(USER_ID).map((e) => e.date));
  const pending = all.filter((d) => d.content && d.content.trim() && !existing.has(d.date));
  const total = pending.length;

  let added = 0;
  let processed = 0;
  for (const d of pending) {
    const diaryText = `【${d.date}】\n${stripHtml(d.content)}`;
    const prompt = FISHBONE_PROMPT.replace('{diary_text}', diaryText);
    let raw = '';
    try {
      raw = await generate(prompt, { numPredict: 1024, temperature: 0.2, jsonMode: true });
    } catch (e) {
      console.error(`[鱼骨] 提取 ${d.date} 失败:`, e);
      processed += 1;
      onProgress?.({ total, done: processed, date: d.date });
      continue; // 单篇失败不中断，下一篇继续
    }
    let items = parseFishboneEvents(raw);
    // LLM 偶发返回空：重试一次，避免"空提取却推进游标"导致摘要永久丢失
    if (!items.length) {
      try {
        raw = await generate(prompt, { numPredict: 1024, temperature: 0.2, jsonMode: true });
        items = parseFishboneEvents(raw);
      } catch (e) {
        console.error(`[鱼骨] 提取 ${d.date} 重试失败:`, e);
      }
    }
    // 重试后仍无摘要：记录占位事件，避免该日期永远"待处理"反复提示
    if (!items.length) {
      if (storage.addFishboneEvent(USER_ID, d.date, `（${d.date} 未生成摘要）`)) {
        added += 1;
      }
    }
    for (const it of items) {
      // 模型返回的日期归一化；无法识别时回退到日记日期，防止存到错误日期导致永远缺失
      const evDate = normalizeDate(it.date) || d.date;
      if (storage.addFishboneEvent(USER_ID, evDate, it.summary || `（${d.date} 未生成摘要）`)) {
        added += 1;
      }
    }
    storage.setLastProcessedDate(USER_ID, d.date);
    processed += 1;
    onProgress?.({ total, done: processed, date: d.date });
  }
  return { added, total };
}

// ========== 开场白：本地 LLM 生成 ==========
type OpeningChartType = 'emotion' | 'fishbone';

/** 构建开场白 prompt（与后端共用，保证文案一致）。 */
function buildOpeningPrompt(chartType: string, dataText: string): string {
  const label = ({ emotion: '情绪雷达', fishbone: '生活摘要' } as Record<string, string>)[chartType] || '统计';
  return `你是共情助手，用户的好朋友。用户刚刚查看了「${label}」统计，你现在想陪他聊两句。

【怎么做】
- 像敏锐的朋友注意到某个明显变化后自然开口，主动发起一句话对话，引导用户聊聊
- 观察数据里值得注意的点（情绪起伏、反复出现的词、生活中值得留意的片段），自然地提出来
- 如果数据没有明显变化或数据很少，就输出一句轻松的观察，不硬找话题

【不要怎样】
- 不要堆砌数据，不要罗列所有指标
- 不要套话，不要"今天感觉怎么样"这种空泛开场
- 不要端分析报告的说教架势

【把握不准时】
- 数据看不出什么名堂时，就温和地共情或随口一句，不硬做深刻分析

下面是本次「${label}」统计的数据，供你参考：
${dataText}

只输出这句话本身（20-40字），不要任何前缀。`;
}

/** 基于图表数据生成一句自动 AI 开场白。数据为空则返回空串。 */
export async function getOpening(chartType: string, dataText: string): Promise<string> {
  const text = (dataText || '').trim();
  if (!text) return '';
  const prompt = buildOpeningPrompt(chartType, text);
  try {
    const opening = await generate(prompt, { numPredict: 120, temperature: 0.6 });
    return (opening || '').trim();
  } catch (e) {
    console.error('生成开场白失败:', e);
    return '';
  }
}

/** 流式生成开场白：进入对话空间后逐 token 实时渲染问候。 */
export async function* streamOpening(
  chartType: string,
  dataText: string,
): AsyncGenerator<{ type: string; content: string }> {
  const text = (dataText || '').trim();
  if (!text) {
    yield { type: 'done', content: '' };
    return;
  }
  const prompt = buildOpeningPrompt(chartType, text);
  try {
    for await (const ev of generateStream(prompt, { numPredict: 120, temperature: 0.6 })) {
      if (ev.type === 'response') {
        yield { type: 'response', content: ev.content };
      }
    }
  } catch (e) {
    console.error('流式生成开场白失败:', e);
  }
  yield { type: 'done', content: '' };
}

// ========== 打包成对话上下文（与 api/statistics.ts 逐字一致） ==========
/** 把情绪均值雷达 + 张力打包成对话上下文文本（供 extraContext 注入） */
export function packEmotionContext(data: EmotionRadarData): string {
  const fmtVec = (axes: string[], v: number[]) =>
    axes.map((a, i) => `${a}${Math.round(v[i] ?? 0)}`).filter((s) => {
      const n = Number(s.replace(/[^\d]/g, ''));
      return n > 0;
    }).join(',') || '（无）';
  const fmtTension = (t: TensionItem[]) =>
    t.length === 0
      ? '（无数据）'
      : t
          .map((x) => (x.value == null ? `${x.date}（无数据）` : `${x.date} 张力(${Math.round(x.value)})`))
          .join('，');
  return (
    `## 情绪均值雷达\n近10天均值：${fmtVec(data.axes, data.recent10)}\n` +
    `第11~30天均值：${fmtVec(data.axes, data.recent30)}\n` +
    `## 情绪张力（近3天，单日正对轴共现强度）\n${fmtTension(data.tension)}`
  );
}

export function packFishboneContext(events: FishboneEvent[]): string {
  if (events.length === 0) return '## 生活摘要\n（暂无摘要）';
  return `## 近期生活摘要\n${events.map((e) => `【${e.date}】${e.summary}`).join('\n')}`;
}