/**
 * insightDb.ts — 手机端觉察报告(insight)轻量存储引擎（TypeScript）
 *
 * 与 diaryDb.ts / coreStorage.ts 同风格，使用 expo-sqlite 应用沙盒内 insight.db。
 * 表结构：
 *  - insight_results：觉察报告主表（branches 以 JSON 文本存放）
 *  - insight_settings：觉察设置（按 user_id 单行）
 *
 * 本模块只负责本地持久化，不 import 任何 HTTP api client，
 * 分析与流式对话编排放在 local/insight.ts。
 */

// 与 api/insight.ts 一致的类型（insightDb 作为存储层，类型在此定义，供 local 复用）
export interface InsightBranch {
  id: string;
  title: string;
  observation: string;
  evidence: string;
  question: string;
  conversation: { role: string; content: string }[];
  summary?: string;
  conversation_summary?: string;
  compressed_rounds?: number;
}

export interface InsightResult {
  id: string;
  timestamp: string;
  diary_count: number;
  date_range: string;
  elapsed_seconds: number;
  branches: InsightBranch[];
  diary_context?: string;
  model?: string;
}

export interface InsightHistoryItem {
  id: string;
  timestamp: string;
  diary_count: number;
  date_range: string;
  elapsed_seconds: number;
  branch_count: number;
  preview: string;
  branches?: InsightBranch[];
}

export interface InsightSettings {
  auto_run: boolean;
  frequency: string;       // "weekly" | "monthly"
  schedule_day: number;    // 每周 1-7, 每月 1-29
  schedule_time: string;
  last_run: string | null;
  analysis_days: number;
}

// 默认设置（与后端 DEFAULT_INSIGHT_SETTINGS 一致）
export const DEFAULT_INSIGHT_SETTINGS: InsightSettings = {
  auto_run: true,
  frequency: 'weekly',
  schedule_day: 7,
  schedule_time: '23:00',
  last_run: null,
  analysis_days: 30,
};

// 报告最多保留条数（与后端 results[:50] 一致）
const MAX_RESULTS = 50;

interface Row {
  [key: string]: unknown;
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeJson<T = unknown>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class InsightStorage {
  private db: import('expo-sqlite').SQLiteDatabase;

  constructor(dbName: string = 'insight.db') {
    // 运行时 require，避免顶层静态 import 在非 RN 环境报错
    const SQLite = require('expo-sqlite');
    this.db = SQLite.openDatabaseSync(dbName);
    this.db.execSync('PRAGMA journal_mode = WAL');
    this.initTables();
  }

  private initTables(): void {
    this.db.execSync(`
      CREATE TABLE IF NOT EXISTS insight_results (
        id             TEXT PRIMARY KEY,
        timestamp      TEXT NOT NULL,
        diary_count    INTEGER NOT NULL DEFAULT 0,
        date_range     TEXT NOT NULL DEFAULT '',
        elapsed_seconds REAL NOT NULL DEFAULT 0,
        branches       TEXT NOT NULL DEFAULT '[]',
        diary_context  TEXT DEFAULT '',
        model          TEXT DEFAULT '',
        user_id        TEXT NOT NULL DEFAULT 'default',
        created_at     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_insight_user ON insight_results(user_id);
      CREATE INDEX IF NOT EXISTS idx_insight_user_time ON insight_results(user_id, timestamp);

      CREATE TABLE IF NOT EXISTS insight_settings (
        user_id  TEXT PRIMARY KEY,
        settings TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );
    `);
  }

  // ========== 工具：行 → 对象 ==========

  private rowToResult(row: Row): InsightResult {
    return {
      id: String(row.id),
      timestamp: String(row.timestamp),
      diary_count: Number(row.diary_count),
      date_range: String(row.date_range),
      elapsed_seconds: Number(row.elapsed_seconds),
      branches: safeJson<InsightBranch[]>(row.branches as string, []),
      diary_context: row.diary_context != null ? String(row.diary_context) : undefined,
      model: row.model != null ? String(row.model) : undefined,
    };
  }

  // ========== 报告 CRUD ==========

  /** 保存一条新报告（插入顶部，仅保留最近 MAX_RESULTS 条） */
  saveInsight(result: InsightResult, user_id: string = 'default'): void {
    const now = nowIso();
    this.db.runSync(
      `INSERT OR REPLACE INTO insight_results
        (id, timestamp, diary_count, date_range, elapsed_seconds, branches,
         diary_context, model, user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        result.id,
        result.timestamp,
        result.diary_count,
        result.date_range,
        result.elapsed_seconds,
        JSON.stringify(result.branches || []),
        result.diary_context || '',
        result.model || '',
        user_id,
        now,
      ],
    );
    // 裁剪超出条数：仅保留该用户最近 MAX_RESULTS 条
    const rows = this.db.getAllSync<Row>(
      'SELECT id FROM insight_results WHERE user_id = ? ORDER BY timestamp DESC LIMIT -1 OFFSET ?',
      [user_id, MAX_RESULTS],
    );
    for (const r of rows) {
      this.db.runSync('DELETE FROM insight_results WHERE id = ? AND user_id = ?', [String(r.id), user_id]);
    }
  }

  /** 最近一次报告（无则返回 null） */
  getLatestInsight(user_id: string = 'default'): InsightResult | null {
    const row = this.db.getFirstSync<Row>(
      'SELECT * FROM insight_results WHERE user_id = ? ORDER BY timestamp DESC LIMIT 1',
      [user_id],
    );
    return row ? this.rowToResult(row) : null;
  }

  /** 历史列表（含每条报告的完整 branches，供前端直接渲染） */
  getInsightHistory(user_id: string = 'default'): InsightHistoryItem[] {
    const rows = this.db.getAllSync<Row>(
      'SELECT * FROM insight_results WHERE user_id = ? ORDER BY timestamp DESC',
      [user_id],
    );
    return rows.map((r): InsightHistoryItem => {
      const branches = safeJson<InsightBranch[]>(r.branches as string, []);
      const branchCount = branches.length;
      const preview = branchCount > 0 ? (branches[0].title || '') : '';
      return {
        id: String(r.id),
        timestamp: String(r.timestamp),
        diary_count: Number(r.diary_count),
        date_range: String(r.date_range),
        elapsed_seconds: Number(r.elapsed_seconds),
        branch_count: branchCount,
        preview,
        branches,
      };
    });
  }

  /** 按 id 取报告详情 */
  getInsightResult(id: string, user_id: string = 'default'): InsightResult | null {
    const row = this.db.getFirstSync<Row>(
      'SELECT * FROM insight_results WHERE id = ? AND user_id = ?',
      [id, user_id],
    );
    return row ? this.rowToResult(row) : null;
  }

  /** 删除指定报告（连同其所有支线及对话） */
  deleteInsightResult(id: string, user_id: string = 'default'): boolean {
    const result = this.db.runSync(
      'DELETE FROM insight_results WHERE id = ? AND user_id = ?',
      [id, user_id],
    );
    return result.changes > 0;
  }

  /** 更新某条报告的整体内容（用于保存支线对话/总结后回写） */
  updateInsightResult(id: string, result: InsightResult, user_id: string = 'default'): void {
    this.db.runSync(
      `UPDATE insight_results SET branches = ?, diary_context = ?, model = ? WHERE id = ? AND user_id = ?`,
      [
        JSON.stringify(result.branches || []),
        result.diary_context || '',
        result.model || '',
        id,
        user_id,
      ],
    );
  }

  // ========== 设置 ==========

  getInsightSettings(user_id: string = 'default'): InsightSettings {
    const row = this.db.getFirstSync<Row>(
      'SELECT settings FROM insight_settings WHERE user_id = ?',
      [user_id],
    );
    const parsed = safeJson<Partial<InsightSettings>>(
      row ? (row.settings as string) : null,
      {},
    );
    // 补齐默认值
    return {
      ...DEFAULT_INSIGHT_SETTINGS,
      ...parsed,
      last_run: parsed.last_run ?? null,
    } as InsightSettings;
  }

  updateInsightSettings(settings: Partial<InsightSettings>, user_id: string = 'default'): InsightSettings {
    const current = this.getInsightSettings(user_id);
    const next: InsightSettings = { ...current, ...settings };
    this.db.runSync(
      `INSERT OR REPLACE INTO insight_settings (user_id, settings, updated_at) VALUES (?, ?, ?)`,
      [user_id, JSON.stringify(next), nowIso()],
    );
    return next;
  }
}

// 单例工厂（与 getDiaryStorage / getCoreStorage 一致）
let _insightStorage: InsightStorage | null = null;

export function getInsightStorage(): InsightStorage {
  if (!_insightStorage) {
    _insightStorage = new InsightStorage();
  }
  return _insightStorage;
}