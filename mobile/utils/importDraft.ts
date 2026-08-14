// ==========================================
// 手机端导入草稿存储层 — AsyncStorage
//
// 导入页的一切操作（日历粘贴、快捷导入文件）都实时写入这份草稿 JSON，
// 防止用户做到一半意外退出导致数据丢失。草稿结构对齐后端 canonical 格式：
//   {
//     format: 'atrium-diary',
//     version: '1.0',
//     entries: { 'YYYY-MM-DD': { date, content, weather, tags, created_at, updated_at } }
//   }
// entries 用「日期字符串」作键，天然支持日历格子标记与同日期覆盖语义。
// ==========================================

import AsyncStorage from '@react-native-async-storage/async-storage';

const LS_KEY = 'atrium_import_draft';

export interface ImportEntry {
  date: string;
  content: string;
  weather: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface ImportDraft {
  format: string;
  version: string;
  entries: Record<string, ImportEntry>;
}

export function emptyDraft(): ImportDraft {
  return { format: 'atrium-diary', version: '1.0', entries: {} };
}

/** 持久化草稿（AsyncStorage 异步写盘）。返回 Promise，调用方可 await 等待落盘。 */
export async function persistDraft(draft: ImportDraft): Promise<void> {
  try {
    await AsyncStorage.setItem(LS_KEY, JSON.stringify(draft));
  } catch (e) {
    console.warn('[importDraft] 草稿持久化失败:', e);
  }
}

/** 读取草稿；没有则返回空草稿。 */
export async function loadDraft(): Promise<ImportDraft> {
  try {
    const local = await AsyncStorage.getItem(LS_KEY);
    if (local) return normalize(JSON.parse(local));
  } catch (e) {
    console.warn('[importDraft] 读取草稿失败:', e);
  }
  return emptyDraft();
}

/** 清空草稿（导入完成后调用）。 */
export async function clearDraft(): Promise<void> {
  try {
    await AsyncStorage.removeItem(LS_KEY);
  } catch (e) {
    console.warn('[importDraft] 清空草稿失败:', e);
  }
}

/** 当前草稿条目数 */
export function draftCount(draft: ImportDraft | null): number {
  return draft && draft.entries ? Object.keys(draft.entries).length : 0;
}

// 读取时规范化：保证结构完整，避免旧数据缺字段导致渲染/提交报错
function normalize(draft: any): ImportDraft {
  const d = draft && typeof draft === 'object' ? draft : {};
  const base = emptyDraft();
  const entries: Record<string, ImportEntry> = {};
  const raw = d.entries && typeof d.entries === 'object' ? d.entries : {};
  Object.keys(raw).forEach((date) => {
    const e = raw[date] || {};
    entries[date] = {
      date,
      content: e.content || '',
      weather: e.weather || '晴',
      tags: Array.isArray(e.tags) ? e.tags : [],
      created_at: e.created_at || new Date().toISOString(),
      updated_at: e.updated_at || new Date().toISOString(),
    };
  });
  return { ...base, ...d, entries };
}