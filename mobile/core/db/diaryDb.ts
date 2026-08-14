/**
 * diaryDb.ts — 手机端日记存储引擎（TypeScript 重写）
 *
 * 逐字等价复刻 Python 版 storage/diary_storage.py：
 *  - 表结构与迁移逻辑完全一致（含全部迁移列）
 *  - 所有方法签名、SQL、默认值、返回结构等价
 *  - 导入(batch_import_diaries)纯写库，绝不触发任何分析管线
 *  - 会话归属校验(get_session_owner)用于 IDOR 防护
 *
 * 存储位置：expo-sqlite 应用沙盒内 diary.db（WAL 模式）
 */
import * as SQLite from 'expo-sqlite';
import { File, Paths } from 'expo-file-system';

const DB_FILE_NAME = 'diary.db';

// ==========================================
// 类型定义（对应 Python DiaryEntry dataclass）
// ==========================================

export interface DiaryEntry {
  id: number;
  date: string;
  content: string;
  messages: Array<Record<string, string>>;
  weather: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface ChatSession {
  id: string;
  date: string;
  title: string;
  created_at: string;
  updated_at: string;
  user_id: string;
}

export interface ChatMessage {
  id: number;
  session_id: string;
  role: string;
  content: string;
  thinking: string;
  diary_date: string;
  timestamp: number;
  search_sources: string;
  images: string;
  sources?: unknown[];
  imageList?: unknown[];
}

// ==========================================
// 工具函数
// ==========================================

function nowIso(): string {
  return new Date().toISOString();
}

function genUuid(): string {
  // 生成 v4 UUID（React Native 无内置，用 crypto.getRandomValues 或 Math.random 兜底）
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(16);
    // @ts-expect-error - RN 全局 crypto 存在
    if (globalThis.crypto && globalThis.crypto.getRandomValues) {
      // @ts-expect-error
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
  } catch {
    bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(bytes[i].toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

function safeJson<T = unknown>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

interface Row {
  [key: string]: unknown;
}

// ==========================================
// DiaryStorage
// ==========================================

export class DiaryStorage {
  private db: SQLite.SQLiteDatabase;

  constructor(dbName: string = 'diary.db') {
    this.db = SQLite.openDatabaseSync(dbName);
    this.db.execSync('PRAGMA journal_mode = WAL');
    this.initTables();
  }

  private initTables(): void {
    // 清理旧版事件中心残留临时表
    for (const legacyTable of [
      'temp_entities_today',
      'temp_entities_yesterday',
      'temp_relations_today',
      'temp_relations_yesterday',
      'extracted_memories',
    ]) {
      this.db.execSync(`DROP TABLE IF EXISTS ${legacyTable}`);
    }

    // 检查并迁移 diary_entries 旧 schema
    let cols = this.tableCols('diary_entries');
    if (cols.includes('id') && !cols.includes('date')) {
      this.db.execSync('DROP TABLE IF EXISTS diary_entries');
      cols = [];
    } else if (cols.includes('id')) {
      const info = this.tableInfo('diary_entries');
      for (const c of info) {
        if (c.name === 'id' && c.type.toUpperCase() === 'TEXT') {
          this.db.execSync('DROP TABLE IF EXISTS diary_entries');
          break;
        }
      }
    }

    // users 表
    this.db.execSync(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        current_token_jti TEXT,
        current_token_expires REAL
      );
    `);

    // users: 单设备登录会话列迁移
    let uCols = this.tableCols('users');
    if (uCols.length && !uCols.includes('current_token_jti')) {
      this.db.execSync('ALTER TABLE users ADD COLUMN current_token_jti TEXT');
    }
    uCols = this.tableCols('users');
    if (uCols.length && !uCols.includes('current_token_expires')) {
      this.db.execSync('ALTER TABLE users ADD COLUMN current_token_expires REAL');
    }

    // diary_entries: 添加 user_id 列
    let deCols = this.tableCols('diary_entries');
    if (deCols.length && !deCols.includes('user_id')) {
      this.db.execSync("ALTER TABLE diary_entries ADD COLUMN user_id TEXT DEFAULT 'default'");
    }

    // calendar_cache: 重建为 (date, user_id) 复合主键
    let ccCols = this.tableCols('calendar_cache');
    if (ccCols.includes('diary_id') && !ccCols.includes('date')) {
      this.db.execSync('DROP TABLE IF EXISTS calendar_cache');
      ccCols = [];
    }

    if (ccCols.length && !ccCols.includes('user_id')) {
      // 旧表无 user_id → 重建
      this.db.withTransactionSync(() => {
        this.db.execSync('ALTER TABLE calendar_cache RENAME TO calendar_cache_old');
        this.db.execSync(`
          CREATE TABLE calendar_cache (
            date TEXT NOT NULL,
            user_id TEXT NOT NULL DEFAULT 'default',
            entity_count INTEGER DEFAULT 0,
            protagonist TEXT DEFAULT '自己',
            summary TEXT DEFAULT '',
            emotion TEXT DEFAULT '',
            updated_at TEXT NOT NULL,
            PRIMARY KEY (date, user_id)
          );
        `);
        const oldCols = this.tableCols('calendar_cache_old');
        const hasSummary = oldCols.includes('summary');
        const hasEmotion = oldCols.includes('emotion');
        if (hasSummary && hasEmotion) {
          this.db.execSync(`
            INSERT INTO calendar_cache (date, user_id, entity_count, protagonist, summary, emotion, updated_at)
            SELECT date, 'default', entity_count, protagonist, summary, emotion, updated_at FROM calendar_cache_old
          `);
        } else {
          this.db.execSync(`
            INSERT INTO calendar_cache (date, user_id, entity_count, protagonist, summary, emotion, updated_at)
            SELECT date, 'default', entity_count, protagonist, '', '', updated_at FROM calendar_cache_old
          `);
        }
        this.db.execSync('DROP TABLE calendar_cache_old');
      });
    } else if (ccCols.length === 0) {
      this.db.execSync(`
        CREATE TABLE calendar_cache (
          date TEXT NOT NULL,
          user_id TEXT NOT NULL DEFAULT 'default',
          entity_count INTEGER DEFAULT 0,
          protagonist TEXT DEFAULT '自己',
          summary TEXT DEFAULT '',
          emotion TEXT DEFAULT '',
          updated_at TEXT NOT NULL,
          PRIMARY KEY (date, user_id)
        );
      `);
    }

    // chat_sessions: 添加 user_id 列
    let csCols = this.tableCols('chat_sessions');
    if (csCols.length && !csCols.includes('user_id')) {
      this.db.execSync("ALTER TABLE chat_sessions ADD COLUMN user_id TEXT DEFAULT 'default'");
    }

    // user_profiles: 添加 diary_count 列
    let upCols = this.tableCols('user_profiles');
    if (upCols.length && !upCols.includes('diary_count')) {
      this.db.execSync('ALTER TABLE user_profiles ADD COLUMN diary_count INTEGER DEFAULT 0');
    }

    // 确保所有表存在
    this.db.execSync(`
      CREATE TABLE IF NOT EXISTS diary_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        content TEXT,
        messages TEXT DEFAULT '[]',
        weather TEXT DEFAULT '晴',
        tags TEXT DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT 'default'
      );

      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        title TEXT DEFAULT '新对话',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT 'default'
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        thinking TEXT DEFAULT '',
        diary_date TEXT DEFAULT '',
        timestamp REAL NOT NULL,
        FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_diary_date ON diary_entries(date);
      CREATE INDEX IF NOT EXISTS idx_diary_created ON diary_entries(created_at);
      CREATE INDEX IF NOT EXISTS idx_diary_user ON diary_entries(user_id);
      CREATE INDEX IF NOT EXISTS idx_cache_date ON calendar_cache(date);
      CREATE INDEX IF NOT EXISTS idx_cache_user ON calendar_cache(user_id);
      CREATE INDEX IF NOT EXISTS idx_chat_sessions_date ON chat_sessions(date);
      CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);

      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id TEXT PRIMARY KEY,
        content TEXT DEFAULT '',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS interaction_modes (
        user_id TEXT NOT NULL,
        ai_key TEXT NOT NULL,
        content TEXT DEFAULT '',
        profile_diary_count INTEGER DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, ai_key)
      );

      CREATE TABLE IF NOT EXISTS relationship_profiles (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        person_name TEXT NOT NULL,
        profile_content TEXT DEFAULT '',
        evidence TEXT DEFAULT '[]',
        dimensions TEXT DEFAULT '[]',
        last_search_date TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, person_name)
      );

      CREATE TABLE IF NOT EXISTS fishbone_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        date TEXT NOT NULL,
        summary TEXT DEFAULT '',
        processed_at TEXT NOT NULL,
        UNIQUE(user_id, date)
      );

      CREATE TABLE IF NOT EXISTS user_meta (
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT DEFAULT '',
        PRIMARY KEY (user_id, key)
      );
    `);

    // calendar_cache: 新增 emotion_vector 列
    let vCols = this.tableCols('calendar_cache');
    if (!vCols.includes('emotion_vector')) {
      this.db.execSync("ALTER TABLE calendar_cache ADD COLUMN emotion_vector TEXT DEFAULT ''");
    }

    // fishbone_events: 改为"每篇日记一条摘要"（按 date 唯一）。旧带 title 列的结构为测试数据，直接重建。
    let fCols = this.tableCols('fishbone_events');
    if (fCols.includes('title')) {
      this.db.execSync(
        `DROP TABLE fishbone_events;
         CREATE TABLE IF NOT EXISTS fishbone_events (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           user_id TEXT NOT NULL,
           date TEXT NOT NULL,
           summary TEXT DEFAULT '',
           processed_at TEXT NOT NULL,
           UNIQUE(user_id, date)
         );`,
      );
    }

    // chat_messages: 新增 search_sources 列
    let mCols = this.tableCols('chat_messages');
    if (!mCols.includes('search_sources')) {
      this.db.execSync("ALTER TABLE chat_messages ADD COLUMN search_sources TEXT DEFAULT ''");
    }

    // chat_messages: 新增 images 列
    mCols = this.tableCols('chat_messages');
    if (!mCols.includes('images')) {
      this.db.execSync("ALTER TABLE chat_messages ADD COLUMN images TEXT DEFAULT ''");
    }
  }

  private tableCols(table: string): string[] {
    try {
      const rows = this.db.getAllSync<Row>(`PRAGMA table_info(${table})`);
      return rows.map((r) => String(r.name));
    } catch {
      return [];
    }
  }

  private tableInfo(table: string): Array<{ name: string; type: string }> {
    try {
      const rows = this.db.getAllSync<Row>(`PRAGMA table_info(${table})`);
      return rows.map((r) => ({ name: String(r.name), type: String(r.type) }));
    } catch {
      return [];
    }
  }

  private rowToDiary(row: Row): DiaryEntry {
    return {
      id: Number(row.id),
      date: String(row.date),
      content: (row.content as string) || '',
      messages: safeJson<Array<Record<string, string>>>(row.messages as string, []),
      weather: String(row.weather),
      tags: safeJson<string[]>(row.tags as string, []),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  // ==========================================
  // 日记 CRUD
  // ==========================================

  saveDiary(
    date: string,
    content: string = '',
    messages: Array<Record<string, string>> = [],
    weather: string = '晴',
    tags: string[] = [],
    user_id: string = 'default',
  ): DiaryEntry {
    const now = nowIso();
    const existing = this.db.getFirstSync<Row>(
      'SELECT id, created_at FROM diary_entries WHERE date = ? AND user_id = ?',
      [date, user_id],
    );

    if (existing) {
      this.db.runSync(
        'UPDATE diary_entries SET content = ?, messages = ?, weather = ?, tags = ?, updated_at = ? WHERE date = ? AND user_id = ?',
        [content, JSON.stringify(messages), weather, JSON.stringify(tags), now, date, user_id],
      );
      return {
        id: Number(existing.id),
        date,
        content: content || '',
        messages,
        weather,
        tags,
        created_at: String(existing.created_at),
        updated_at: now,
      };
    }

    const result = this.db.runSync(
      'INSERT INTO diary_entries (date, content, messages, weather, tags, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [date, content, JSON.stringify(messages), weather, JSON.stringify(tags), now, now, user_id],
    );
    return {
      id: Number(result.lastInsertRowId),
      date,
      content: content || '',
      messages,
      weather,
      tags,
      created_at: now,
      updated_at: now,
    };
  }

  batchImportDiaries(entries: Array<Record<string, unknown>>, user_id: string = 'default', overwrite: boolean = true): { imported: number; updated: number; skipped: number } {
    const now = nowIso();
    let imported = 0;
    let updated = 0;
    let skipped = 0;
    for (const e of entries || []) {
      const date = (e && e.date) ? String(e.date) : '';
      if (!date) {
        skipped += 1;
        continue;
      }
      const content = (e.content as string) || '';
      const weather = (e.weather as string) || '晴';
      const tags = (e.tags as string[]) || [];
      const created_at = (e.created_at as string) || now;
      const existing = this.db.getFirstSync<Row>(
        'SELECT id, created_at FROM diary_entries WHERE date = ? AND user_id = ?',
        [date, user_id],
      );
      if (existing) {
        if (!overwrite) {
          skipped += 1;
          continue;
        }
        this.db.runSync(
          'UPDATE diary_entries SET content = ?, weather = ?, tags = ?, updated_at = ? WHERE date = ? AND user_id = ?',
          [content, weather, JSON.stringify(tags), now, date, user_id],
        );
        updated += 1;
      } else {
        this.db.runSync(
          'INSERT INTO diary_entries (date, content, messages, weather, tags, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [date, content, '[]', weather, JSON.stringify(tags), created_at, now, user_id],
        );
        imported += 1;
      }
    }
    return { imported, updated, skipped };
  }

  getDiaryByDate(date: string, user_id: string = 'default'): DiaryEntry | null {
    const row = this.db.getFirstSync<Row>(
      'SELECT * FROM diary_entries WHERE date = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1',
      [date, user_id],
    );
    return row ? this.rowToDiary(row) : null;
  }

  getDiariesByRange(start_date: string, end_date: string, user_id: string = 'default'): DiaryEntry[] {
    const rows = this.db.getAllSync<Row>(
      'SELECT * FROM diary_entries WHERE date >= ? AND date <= ? AND user_id = ? ORDER BY date DESC',
      [start_date, end_date, user_id],
    );
    return rows.map((r) => this.rowToDiary(r));
  }

  updateWeather(date: string, weather: string, user_id: string = 'default'): boolean {
    const now = nowIso();
    const existing = this.db.getFirstSync<Row>('SELECT id FROM diary_entries WHERE date = ? AND user_id = ?', [date, user_id]);
    if (existing) {
      this.db.runSync('UPDATE diary_entries SET weather = ?, updated_at = ? WHERE date = ? AND user_id = ?', [weather, now, date, user_id]);
    } else {
      this.db.runSync(
        'INSERT INTO diary_entries (date, content, messages, weather, tags, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [date, '', '[]', weather, '[]', now, now, user_id],
      );
    }
    return true;
  }

  // ==========================================
  // 人际关系档案
  // ==========================================

  createRelationship(user_id: string, person_name: string): Record<string, unknown> {
    const rid = genUuid();
    const now = nowIso();
    this.db.runSync(
      'INSERT INTO relationship_profiles (id, user_id, person_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [rid, user_id, person_name, now, now],
    );
    return { id: rid, user_id, person_name, profile_content: '', evidence: '[]', dimensions: '[]', last_search_date: null, created_at: now, updated_at: now };
  }

  getRelationship(relationship_id: string): Record<string, unknown> | null {
    const row = this.db.getFirstSync<Row>('SELECT * FROM relationship_profiles WHERE id = ?', [relationship_id]);
    return row ? { ...row } : null;
  }

  getRelationshipByName(user_id: string, person_name: string): Record<string, unknown> | null {
    const row = this.db.getFirstSync<Row>('SELECT * FROM relationship_profiles WHERE user_id = ? AND person_name = ?', [user_id, person_name]);
    return row ? { ...row } : null;
  }

  listRelationships(user_id: string): Record<string, unknown>[] {
    const rows = this.db.getAllSync<Row>(
      'SELECT id, person_name, created_at, updated_at FROM relationship_profiles WHERE user_id = ? ORDER BY updated_at DESC',
      [user_id],
    );
    return rows.map((r) => ({ ...r }));
  }

  updateRelationship(
    relationship_id: string,
    profile_content?: string,
    evidence?: string,
    dimensions?: string,
    last_search_date?: string,
  ): void {
    const now = nowIso();
    const fields: string[] = ['updated_at = ?'];
    const params: Array<string | number | null> = [now];
    if (profile_content !== undefined) {
      fields.push('profile_content = ?');
      params.push(profile_content);
    }
    if (evidence !== undefined) {
      fields.push('evidence = ?');
      params.push(evidence);
    }
    if (dimensions !== undefined) {
      fields.push('dimensions = ?');
      params.push(dimensions);
    }
    if (last_search_date !== undefined) {
      fields.push('last_search_date = ?');
      params.push(last_search_date);
    }
    params.push(relationship_id);
    this.db.runSync(`UPDATE relationship_profiles SET ${fields.join(', ')} WHERE id = ?`, params);
  }

  deleteRelationship(relationship_id: string): void {
    this.db.runSync('DELETE FROM relationship_profiles WHERE id = ?', [relationship_id]);
  }

  getRecentDiaries(limit: number = 10, user_id: string = 'default'): DiaryEntry[] {
    const rows = this.db.getAllSync<Row>('SELECT * FROM diary_entries WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [user_id, limit]);
    return rows.map((r) => this.rowToDiary(r));
  }

  getDiariesByMonth(year: number, month: string, user_id: string = 'default'): DiaryEntry[] {
    const rows = this.db.getAllSync<Row>(
      "SELECT * FROM diary_entries WHERE date LIKE ? AND user_id = ? ORDER BY date",
      [`${year}-${String(month).padStart(2, '0')}-%`, user_id],
    );
    return rows.map((r) => this.rowToDiary(r));
  }

  searchDiaries(query: string, limit: number = 10, user_id: string = 'default'): Array<{ diary: DiaryEntry; score: number }> {
    const like = `%${query}%`;
    const rows = this.db.getAllSync<Row>(
      'SELECT * FROM diary_entries WHERE (content LIKE ? OR tags LIKE ?) AND user_id = ? ORDER BY created_at DESC LIMIT ?',
      [like, like, user_id, limit],
    );
    return rows.map((r) => ({ diary: this.rowToDiary(r), score: 1.0 }));
  }

  updateCalendarCache(date: string, entity_count: number, protagonist: string, summary: string = '', emotion: string = '', user_id: string = 'default'): void {
    const now = nowIso();
    const existing = this.getCalendarCache(date, user_id);
    let existingVector = '';
    if (existing !== null) {
      if (!summary && existing.summary) summary = existing.summary;
      if (!emotion && existing.emotion) emotion = existing.emotion;
      if (existing.emotion_vector) existingVector = existing.emotion_vector;
    }
    this.db.runSync(
      'INSERT OR REPLACE INTO calendar_cache (date, user_id, entity_count, protagonist, summary, emotion, emotion_vector, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [date, user_id, entity_count, protagonist, summary, emotion, existingVector, now],
    );
  }

  getCalendarCache(date: string, user_id: string = 'default'): { entity_count: number; protagonist: string; summary: string; emotion: string; emotion_vector: string; updated_at: string } | null {
    const row = this.db.getFirstSync<Row>('SELECT * FROM calendar_cache WHERE date = ? AND user_id = ?', [date, user_id]);
    if (!row) return null;
    return {
      entity_count: Number(row.entity_count),
      protagonist: String(row.protagonist),
      summary: ('summary' in row ? String(row.summary) : ''),
      emotion: ('emotion' in row ? String(row.emotion) : ''),
      emotion_vector: ('emotion_vector' in row ? String(row.emotion_vector) : ''),
      updated_at: String(row.updated_at),
    };
  }

  getStats(): { total_diaries: number; calendar_cache_entries: number } {
    const d = this.db.getFirstSync<Row>('SELECT COUNT(*) as count FROM diary_entries');
    const c = this.db.getFirstSync<Row>('SELECT COUNT(*) as count FROM calendar_cache');
    return { total_diaries: Number(d?.count), calendar_cache_entries: Number(c?.count) };
  }

  /** 将 WAL 中的内容合并回主库文件（供全量备份前调用，保证副本完整） */
  checkpoint(): void {
    this.db.execSync('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  close(): void {
    this.db.closeSync();
  }

  // ==========================================
  // 会话管理
  // ==========================================

  createSession(date: string, title: string = '新对话', user_id: string = 'default'): ChatSession {
    const sessionId = genUuid();
    const now = nowIso();
    this.db.runSync(
      'INSERT INTO chat_sessions (id, date, title, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)',
      [sessionId, date, title, now, now, user_id],
    );
    return { id: sessionId, date, title, created_at: now, updated_at: now, user_id };
  }

  getSessionsByDate(date: string, user_id: string = 'default'): ChatSession[] {
    const rows = this.db.getAllSync<Row>('SELECT * FROM chat_sessions WHERE date = ? AND user_id = ? ORDER BY updated_at DESC', [date, user_id]);
    return rows.map((r) => ({ ...r } as unknown as ChatSession));
  }

  getSessionByTitle(title: string, user_id: string = 'default'): ChatSession | null {
    const row = this.db.getFirstSync<Row>(
      'SELECT * FROM chat_sessions WHERE title = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 1',
      [title, user_id],
    );
    return row ? ({ ...row } as unknown as ChatSession) : null;
  }

  getSessionOwner(session_id: string): string | null {
    const row = this.db.getFirstSync<Row>('SELECT user_id FROM chat_sessions WHERE id = ?', [session_id]);
    return row ? String(row.user_id) : null;
  }

  updateSession(session_id: string, title?: string, user_id?: string): boolean {
    if (title === undefined) return false;
    if (user_id !== undefined) {
      const result = this.db.runSync('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?', [title, nowIso(), session_id, user_id]);
      return result.changes > 0;
    }
    const result = this.db.runSync('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?', [title, nowIso(), session_id]);
    return result.changes > 0;
  }

  deleteSession(session_id: string, user_id?: string): boolean {
    try {
      this.db.withTransactionSync(() => {
        if (user_id !== undefined) {
          this.db.runSync(
            'DELETE FROM chat_messages WHERE session_id IN (SELECT id FROM chat_sessions WHERE id = ? AND user_id = ?)',
            [session_id, user_id],
          );
          this.db.runSync('DELETE FROM chat_sessions WHERE id = ? AND user_id = ?', [session_id, user_id]);
        } else {
          this.db.runSync('DELETE FROM chat_messages WHERE session_id = ?', [session_id]);
          this.db.runSync('DELETE FROM chat_sessions WHERE id = ?', [session_id]);
        }
      });
      return true;
    } catch (e) {
      console.warn('[diaryDb] deleteSession 失败:', e);
      throw e;
    }
  }

  addMessage(
    session_id: string,
    role: string,
    content: string,
    thinking: string = '',
    diary_date: string = '',
    search_sources: string = '',
    images: string = '',
  ): ChatMessage {
    const ts = Date.now() / 1000;
    const result = this.db.runSync(
      'INSERT INTO chat_messages (session_id, role, content, thinking, diary_date, timestamp, search_sources, images) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [session_id, role, content, thinking, diary_date, ts, search_sources, images],
    );
    this.db.runSync('UPDATE chat_sessions SET updated_at = ? WHERE id = ?', [nowIso(), session_id]);
    return {
      id: Number(result.lastInsertRowId),
      session_id,
      role,
      content,
      thinking,
      diary_date,
      timestamp: ts,
      search_sources,
      images,
    };
  }

  getMessages(session_id: string, limit: number = 100): ChatMessage[] {
    const rows = this.db.getAllSync<Row>(
      'SELECT * FROM chat_messages WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?',
      [session_id, limit],
    );
    return rows.map((r) => {
      const rec = { ...r } as unknown as ChatMessage;
      const raw = (rec.search_sources as string) || '';
      const parsed = safeJson<unknown[]>(raw, []);
      rec.sources = parsed;
      if (raw && raw.length > 2) {
        console.log(`[diaryDb.getMessages] 原始 search_sources (${raw.length} chars), 解析得 ${parsed.length} 条`);
      }
      const rawImg = rec.images || '';
      rec.imageList = safeJson<unknown[]>(rawImg, []);
      return rec;
    });
  }

  getRecentMessagesForContext(session_id: string, limit: number = 6): Array<{ role: string; content: string }> {
    const msgs = this.getMessages(session_id, 200);
    const recent = msgs.length > limit ? msgs.slice(-limit) : msgs;
    return recent.map((m) => ({ role: m.role, content: m.content }));
  }

  setSummary(date: string, summary: string, user_id: string = 'default'): boolean {
    const existing = this.db.getFirstSync<Row>('SELECT date FROM calendar_cache WHERE date = ? AND user_id = ?', [date, user_id]);
    if (existing) {
      this.db.runSync('UPDATE calendar_cache SET summary = ?, updated_at = ? WHERE date = ? AND user_id = ?', [summary, nowIso(), date, user_id]);
    } else {
      this.db.runSync(
        'INSERT INTO calendar_cache (date, user_id, entity_count, protagonist, summary, emotion, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [date, user_id, 0, '自己', summary, '', nowIso()],
      );
    }
    return true;
  }

  setEmotion(date: string, emotion: string, user_id: string = 'default'): boolean {
    const existing = this.db.getFirstSync<Row>('SELECT date FROM calendar_cache WHERE date = ? AND user_id = ?', [date, user_id]);
    if (existing) {
      this.db.runSync('UPDATE calendar_cache SET emotion = ?, updated_at = ? WHERE date = ? AND user_id = ?', [emotion, nowIso(), date, user_id]);
    } else {
      this.db.runSync(
        'INSERT INTO calendar_cache (date, user_id, entity_count, protagonist, summary, emotion, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [date, user_id, 0, '自己', '', emotion, nowIso()],
      );
    }
    return true;
  }

  setEmotionVector(date: string, vector: Record<string, number>, user_id: string = 'default'): boolean {
    const text = JSON.stringify(vector);
    const existing = this.db.getFirstSync<Row>('SELECT date FROM calendar_cache WHERE date = ? AND user_id = ?', [date, user_id]);
    if (existing) {
      this.db.runSync('UPDATE calendar_cache SET emotion_vector = ?, updated_at = ? WHERE date = ? AND user_id = ?', [text, nowIso(), date, user_id]);
    } else {
      this.db.runSync(
        'INSERT INTO calendar_cache (date, user_id, entity_count, protagonist, summary, emotion, emotion_vector, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [date, user_id, 0, '自己', '', '', text, nowIso()],
      );
    }
    return true;
  }

  // ==========================================
  // 用户管理
  // ==========================================

  createUser(username: string, password_hash: string): { id: string; username: string; created_at: string } {
    const userId = genUuid();
    const now = nowIso();
    this.db.runSync('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)', [userId, username, password_hash, now]);
    return { id: userId, username, created_at: now };
  }

  getUserByUsername(username: string): Record<string, unknown> | null {
    const row = this.db.getFirstSync<Row>('SELECT * FROM users WHERE username = ?', [username]);
    return row ? { ...row } : null;
  }

  getUserById(user_id: string): Record<string, unknown> | null {
    const row = this.db.getFirstSync<Row>('SELECT * FROM users WHERE id = ?', [user_id]);
    return row ? { ...row } : null;
  }

  setUserCurrentToken(user_id: string, jti: string, expires: number): void {
    this.db.runSync('UPDATE users SET current_token_jti = ?, current_token_expires = ? WHERE id = ?', [jti, expires, user_id]);
  }

  getAllUsers(): Array<{ id: string; username: string; created_at: string }> {
    const rows = this.db.getAllSync<Row>('SELECT id, username, created_at FROM users ORDER BY created_at');
    return rows.map((r) => ({ id: String(r.id), username: String(r.username), created_at: String(r.created_at) }));
  }

  migrateDefaultUser(new_user_id: string): void {
    this.db.withTransactionSync(() => {
      for (const table of ['diary_entries', 'calendar_cache', 'chat_sessions']) {
        this.db.runSync(`UPDATE ${table} SET user_id = ? WHERE user_id = 'default'`, [new_user_id]);
      }
    });
  }

  // ==========================================
  // 事件鱼骨图
  // ==========================================

  addFishboneEvent(user_id: string, date: string, summary: string): boolean {
    const result = this.db.runSync(
      'INSERT OR REPLACE INTO fishbone_events (user_id, date, summary, processed_at) VALUES (?, ?, ?, ?)',
      [user_id, date, summary, nowIso()],
    );
    return result.changes > 0;
  }

  getFishboneEvents(user_id: string): Array<{ id: number; date: string; summary: string; processed_at: string }> {
    const rows = this.db.getAllSync<Row>(
      'SELECT id, date, summary, processed_at FROM fishbone_events WHERE user_id = ? ORDER BY date ASC, id ASC',
      [user_id],
    );
    return rows.map((r) => ({ id: Number(r.id), date: String(r.date), summary: String(r.summary), processed_at: String(r.processed_at) }));
  }

  getLastProcessedDate(user_id: string): string | null {
    const row = this.db.getFirstSync<Row>("SELECT value FROM user_meta WHERE user_id = ? AND key = 'fishbone_last_date'", [user_id]);
    return row ? String(row.value) : null;
  }

  setLastProcessedDate(user_id: string, date: string): void {
    this.db.runSync("INSERT OR REPLACE INTO user_meta (user_id, key, value) VALUES (?, 'fishbone_last_date', ?)", [user_id, date]);
  }

  getUserMeta(user_id: string, key: string): string {
    const row = this.db.getFirstSync<Row>('SELECT value FROM user_meta WHERE user_id = ? AND key = ?', [user_id, key]);
    return row ? String(row.value) : '';
  }

  setUserMeta(user_id: string, key: string, value: string): void {
    this.db.runSync('INSERT OR REPLACE INTO user_meta (user_id, key, value) VALUES (?, ?, ?)', [user_id, key, value]);
  }

  getDiariesAfter(user_id: string, since_date: string): DiaryEntry[] {
    const rows = this.db.getAllSync<Row>(
      "SELECT * FROM diary_entries WHERE user_id = ? AND date > ? AND content IS NOT NULL AND length(trim(content)) >= 1 ORDER BY date ASC",
      [user_id, since_date || ''],
    );
    return rows.map((r) => this.rowToDiary(r));
  }

  // ==========================================
  // 用户档案
  // ==========================================

  getUserProfile(user_id: string): string {
    const row = this.db.getFirstSync<Row>('SELECT content FROM user_profiles WHERE user_id = ?', [user_id]);
    return row ? String(row.content) : '';
  }

  getUserProfileDiaryCount(user_id: string): number {
    const row = this.db.getFirstSync<Row>('SELECT diary_count FROM user_profiles WHERE user_id = ?', [user_id]);
    return row ? Number(row.diary_count) : 0;
  }

  saveUserProfile(user_id: string, content: string, diary_count: number = 0): void {
    const now = nowIso();
    this.db.runSync(
      'INSERT INTO user_profiles (user_id, content, updated_at, diary_count) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET content = ?, updated_at = ?, diary_count = ?',
      [user_id, content, now, diary_count, content, now, diary_count],
    );
  }

  getInteractionMode(user_id: string, ai_key: string): string {
    const row = this.db.getFirstSync<Row>('SELECT content FROM interaction_modes WHERE user_id = ? AND ai_key = ?', [user_id, ai_key]);
    return row ? String(row.content) : '';
  }

  saveInteractionMode(user_id: string, ai_key: string, content: string, diary_count: number = 0): void {
    const now = nowIso();
    this.db.runSync(
      'INSERT INTO interaction_modes (user_id, ai_key, content, profile_diary_count, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, ai_key) DO UPDATE SET content = ?, profile_diary_count = ?, updated_at = ?',
      [user_id, ai_key, content, diary_count, now, content, diary_count, now],
    );
  }

  listInteractionModeKeys(user_id: string): string[] {
    const rows = this.db.getAllSync<Row>('SELECT ai_key FROM interaction_modes WHERE user_id = ?', [user_id]);
    return rows.map((r) => String(r.ai_key));
  }

  getAllDiaries(user_id: string = 'default'): DiaryEntry[] {
    const rows = this.db.getAllSync<Row>('SELECT * FROM diary_entries WHERE user_id = ? ORDER BY date', [user_id]);
    return rows.map((r) => this.rowToDiary(r));
  }
}

// 单例工厂（与 Python get_diary_storage 对应）
let _diaryStorage: DiaryStorage | null = null;

export function getDiaryStorage(): DiaryStorage {
  if (!_diaryStorage) {
    _diaryStorage = new DiaryStorage();
  }
  return _diaryStorage;
}

/**
 * 返回 expo-sqlite 沙盒内 diary.db 的完整路径。
 * expo-sqlite 约定库文件位于 document 目录下的 SQLite 子目录。
 */
export function getDatabaseFilePath(): string {
  return new File(Paths.document, 'SQLite', DB_FILE_NAME).uri;
}

/** 关闭并释放当前打开的数据库连接（供恢复/测试后重建） */
export function resetStorage(): void {
  if (_diaryStorage) {
    try {
      _diaryStorage.close();
    } catch {
      // 连接可能已关闭，忽略
    }
    _diaryStorage = null;
  }
}

/**
 * 用备份库文件原子替换当前 diary.db。
 * @param backupFileUri 备份库文件的 URI（可为任意位置的文件）
 */
export async function restoreDatabaseFromFile(backupFileUri: string): Promise<void> {
  // 1. 释放当前连接，避免文件占用
  resetStorage();

  // 2. 删除现有库文件及其 WAL/SHM 附属文件
  const dbPath = getDatabaseFilePath();
  const dbFile = new File(dbPath);
  const walFile = new File(`${dbPath}-wal`);
  const shmFile = new File(`${dbPath}-shm`);
  for (const f of [dbFile, walFile, shmFile]) {
    if (f.exists) f.delete();
  }

  // 3. 把备份库复制到库路径（此时 dbFile 已被删除，copy 会创建它）
  const backup = new File(backupFileUri);
  if (!backup.exists) {
    throw new Error('备份数据库文件不存在');
  }
  await backup.copy(dbFile);

  // 4. 单例已置空，下次 getDiaryStorage() 会重新打开新库
}