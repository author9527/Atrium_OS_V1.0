// ==========================================
// 导入草稿存储层 — localStorage 为主，IndexedDB 兜底
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

const LS_KEY = 'atrium_import_draft';
const IDB_NAME = 'atrium_import_draft';
const IDB_STORE = 'draft';
const IDB_KEY = 'current';

// 当前存储模式：local（localStorage）| idb（IndexedDB）
let storageMode = 'local';

// ---------- IndexedDB 封装（Promise 化） ----------
function openIdb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB 不可用'));
      return;
    }
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSave(json) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(json, IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbLoad() {
  const db = await openIdb();
  return new Promise((resolve) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

async function idbClear() {
  try {
    const db = await openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* 忽略残留 */ }
}

// ---------- 对外 API ----------

export function emptyDraft() {
  return { format: 'atrium-diary', version: '1.0', entries: {} };
}

/**
 * 持久化草稿。优先写 localStorage（同步、廉价），
 * 若超出配额则自动降级到 IndexedDB（异步）。
 * 返回 Promise，调用方可选择 await 以等待落盘完成。
 */
export async function persistDraft(draft) {
  const json = JSON.stringify(draft);
  try {
    localStorage.setItem(LS_KEY, json);
    storageMode = 'local';
  } catch (e) {
    storageMode = 'idb';
    try {
      await idbSave(json);
    } catch { /* 兜底：两处都失败则仅保持内存态 */ }
  }
  return storageMode;
}

/**
 * 读取草稿。优先 localStorage，其次 IndexedDB，都没有则返回空草稿。
 */
export async function loadDraft() {
  try {
    const local = localStorage.getItem(LS_KEY);
    if (local) {
      storageMode = 'local';
      return normalize(JSON.parse(local));
    }
  } catch { /* 忽略并从 IDB 读取 */ }
  try {
    const idb = await idbLoad();
    if (idb) return normalize(JSON.parse(idb));
  } catch { /* 忽略 */ }
  return emptyDraft();
}

/**
 * 清空草稿（导入完成后调用），同时清除 localStorage 与 IndexedDB。
 */
export async function clearDraft() {
  try { localStorage.removeItem(LS_KEY); } catch { /* 忽略 */ }
  await idbClear();
}

/** 当前草稿条目数 */
export function draftCount(draft) {
  return draft && draft.entries ? Object.keys(draft.entries).length : 0;
}

// 读取时规范化：保证结构完整，避免旧数据缺字段导致渲染/提交报错
function normalize(draft) {
  const d = draft && typeof draft === 'object' ? draft : {};
  const base = emptyDraft();
  const entries = {};
  const raw = d.entries && typeof d.entries === 'object' ? d.entries : {};
  Object.keys(raw).forEach((date) => {
    const e = raw[date] || {};
    if (!e.date) e.date = date;
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