/**
 * local/diary.ts — 手机端本地日记服务（Phase 5）
 *
 * 与 api/diary.ts 保持完全相同的函数签名与返回结构，
 * 但内部改用 core/db/diaryDb.ts 本地存储 + core/emotion.ts 本地分析，
 * 不再依赖电脑端 HTTP 后端。
 *
 * 页面只需把 `../api/diary` 改为 `../local/diary` 即可无缝切换。
 */

import { getDiaryStorage, DiaryEntry } from '../core/db/diaryDb';
import { analyzeDiaryCombined as _analyzeDiaryCombined } from '../core/emotion';
import { getModelClient } from '../core/modelService';
import { stripHtml } from '../core/utils/chatUtils';

// 与 api/diary.ts 一致的类型
export interface MonthDiary {
  date: string;
  has_diary: boolean;
  entity_count: number;
  summary: string;
  emotion: string;
}

export interface DiaryDetail {
  diary: {
    id: number;
    date: string;
    content: string;
    weather: string;
    tags: string[];
    created_at: string;
  } | null;
}

/** 当前本地用户（手机端单机默认） */
const USER_ID = 'default';

/** 获取某年某月的日记列表（与后端 /api/diary/month/{y}/{m} 返回结构一致） */
export function getMonthDiaries(year: number, month: number): MonthDiary[] {
  const storage = getDiaryStorage();
  const monthStr = String(month).padStart(2, '0');
  const prefix = `${year}-${monthStr}`;
  const diaries = storage.getDiariesByMonth(year, monthStr, USER_ID);

  const map = new Map<string, MonthDiary>();
  for (const d of diaries) {
    const cache = storage.getCalendarCache(d.date, USER_ID);
    map.set(d.date, {
      date: d.date,
      has_diary: true,
      entity_count: cache?.entity_count ?? 0,
      summary: cache?.summary ?? '',
      emotion: cache?.emotion ?? '',
    });
  }

  // 补齐该月所有日期（保持与后端一致：无日记也为 false 条目）
  const result: MonthDiary[] = [];
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${prefix}-${String(day).padStart(2, '0')}`;
    if (map.has(date)) {
      result.push(map.get(date)!);
    } else {
      result.push({ date, has_diary: false, entity_count: 0, summary: '', emotion: '' });
    }
  }
  return result;
}

/** 获取某天日记（与后端 /api/diary/date/{date} 返回结构一致） */
export function getDiaryByDate(date: string): DiaryDetail {
  const storage = getDiaryStorage();
  const d = storage.getDiaryByDate(date, USER_ID);
  if (!d) return { diary: null };
  return {
    diary: {
      id: d.id,
      date: d.date,
      content: d.content,
      weather: d.weather,
      tags: d.tags,
      created_at: d.created_at,
    },
  };
}

/** 保存日记（纯本地写库，不触发任何分析管线） */
export function saveDiary(
  date: string,
  content: string,
  messages: any[] = [],
  weather = '晴',
  tags: string[] = [],
) {
  const storage = getDiaryStorage();
  storage.saveDiary(date, content, messages, weather, tags, USER_ID);
  return { success: true };
}

/** 本地合并分析：一次 AI 调用完成摘要 + 主导情绪 + 8维情绪向量，一次性写入 calendar_cache */
export async function analyzeDiaryCombined(date: string, content: string): Promise<{
  summary: string;
  emotion: string;
  vector: Record<string, number>;
}> {
  const client = getModelClient();
  const analysis = await _analyzeDiaryCombined(client, content || '');
  const storage = getDiaryStorage();
  if (analysis.summary) storage.setSummary(date, analysis.summary, USER_ID);
  if (analysis.emotion) storage.setEmotion(date, analysis.emotion, USER_ID);
  if (analysis.emotion_vector && Object.keys(analysis.emotion_vector).length) {
    storage.setEmotionVector(date, analysis.emotion_vector, USER_ID);
  }
  return {
    summary: analysis.summary,
    emotion: analysis.emotion,
    vector: analysis.emotion_vector,
  };
}

export interface BackfillProgress {
  total: number;
  done: number;
  date: string;
}

/**
 * 后台补齐历史日记的「摘要 + 主导情绪 + 8维情绪向量」。
 *
 * 扫描所有内容非空、但 calendar_cache 缺失 summary 或 emotion 的日记，
 * 逐篇调用 analyzeDiaryCombined（每篇一次 AI 调用），幂等——已生成的不重复处理，
 * 可随时中断隔断续跑。单篇失败不影响其余，继续处理下一篇。
 */
export async function backfillDiaryAnalysis(
  onProgress?: (p: BackfillProgress) => void,
): Promise<{ total: number; analyzed: number }> {
  const storage = getDiaryStorage();
  const diaries = storage.getAllDiaries(USER_ID);
  const pending: DiaryEntry[] = diaries.filter((d) => {
    if (!d.content || !d.content.trim()) return false;
    const cache = storage.getCalendarCache(d.date, USER_ID);
    return !cache || !cache.summary || !cache.emotion;
  });

  let analyzed = 0;
  for (const d of pending) {
    try {
      await analyzeDiaryCombined(d.date, d.content);
      analyzed += 1;
      onProgress?.({ total: pending.length, done: analyzed, date: d.date });
    } catch {
      // 单篇失败继续，最后总量仍按 pending 计算
    }
  }
  return { total: pending.length, analyzed };
}

/** 更新情绪（写本地 calendar_cache） */
export function updateEmotion(date: string, emotion: string) {
  getDiaryStorage().setEmotion(date, emotion, USER_ID);
  return { success: true };
}

/** 更新天气（写本地 diary_entries） */
export function updateWeather(date: string, weather: string) {
  getDiaryStorage().updateWeather(date, weather, USER_ID);
  return { success: true };
}

/** 供日志/调试使用：返回纯文本内容（剥离 HTML，防撑爆） */
export function diaryPlainText(date: string): string {
  const d = getDiaryStorage().getDiaryByDate(date, USER_ID);
  return d ? stripHtml(d.content) : '';
}