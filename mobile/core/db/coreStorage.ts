/**
 * coreStorage.ts — 手机端核心存储引擎（TypeScript 重写）
 *
 * 逐字等价复刻 Python 版 storage/core_storage.py：
 *  - 两张核心表：entities（实体/人格档案）/ relation_cache（关系缓存）
 *  - 表结构与迁移逻辑（含 user_id 多用户隔离）完全一致
 *  - 所有方法签名、SQL、默认值、返回结构等价
 *  - 事件中心已废弃，_refresh_relation_cache 保留空实现避免调用方崩溃
 *
 * 存储位置：expo-sqlite 应用沙盒内 core_storage.db（WAL 模式）
 */
import * as SQLite from 'expo-sqlite';

// ==========================================
// 类型定义（对应 Python CoreStorage 返回 dict）
// ==========================================

export interface CoreEntity {
  entity_id: string;
  name: string;
  slug: string;
  entity_type: string;
  ontology_traits: Record<string, unknown>;
  entity_summary: string;
  meta_first_appear_date: string | null;
  meta_last_interact_date: string | null;
  created_at: string;
  updated_at: string;
  user_id: string;
}

export interface RelationCache {
  entity_pair: string;
  user_id: string;
  shared_event_count: number;
  bond_strength: number;
  intersection_stats: Record<string, unknown>;
  last_updated: string;
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
// CoreStorage
// ==========================================

export class CoreStorage {
  private db: SQLite.SQLiteDatabase;

  constructor(dbName: string = 'core_storage.db') {
    this.db = SQLite.openDatabaseSync(dbName);
    this.db.execSync('PRAGMA journal_mode = WAL');
    this.db.execSync('PRAGMA foreign_keys = ON');
    this.initTables();
  }

  private initTables(): void {
    // 1. entities — 实体人物表（时间轴本体 + 静态人格）
    this.db.execSync(`
      CREATE TABLE IF NOT EXISTS entities (
        entity_id    TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        slug         TEXT NOT NULL UNIQUE,
        entity_type  TEXT NOT NULL DEFAULT 'npc',
        ontology_traits TEXT DEFAULT '{}',
        entity_summary  TEXT DEFAULT '',
        meta_first_appear_date TEXT,
        meta_last_interact_date TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        user_id      TEXT NOT NULL DEFAULT 'default'
      );
    `);
    // 迁移：为旧表添加 user_id 列（如不存在）
    this.ensureColumn('entities', 'user_id', "TEXT NOT NULL DEFAULT 'default'");
    // 复合唯一索引 (slug, user_id) —— 旧表的 slug UNIQUE 约束保留，额外加此索引实现多用户隔离
    this.db.execSync(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_slug_user
      ON entities(slug, user_id);
    `);

    // 2. relation_cache — 关系派生缓存表
    this.db.execSync(`
      CREATE TABLE IF NOT EXISTS relation_cache (
        entity_pair   TEXT,
        user_id       TEXT NOT NULL DEFAULT 'default',
        shared_event_count  INTEGER NOT NULL DEFAULT 0,
        bond_strength      REAL NOT NULL DEFAULT 0.0,
        intersection_stats TEXT DEFAULT '{}',
        last_updated        TEXT NOT NULL,
        PRIMARY KEY (entity_pair, user_id)
      );
    `);
    // 迁移：为旧表添加 user_id 列（如不存在）
    this.ensureColumn('relation_cache', 'user_id', "TEXT NOT NULL DEFAULT 'default'");
    // 复合唯一索引 (entity_pair, user_id) —— 旧表 entity_pair PRIMARY KEY 保留，额外加此索引
    this.db.execSync(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_relation_cache_pair_user
      ON relation_cache(entity_pair, user_id);
    `);

    // 索引
    this.db.execSync('CREATE INDEX IF NOT EXISTS idx_entities_slug ON entities(slug)');
    // 多用户隔离索引
    this.db.execSync('CREATE INDEX IF NOT EXISTS idx_entities_user ON entities(user_id)');
    this.db.execSync('CREATE INDEX IF NOT EXISTS idx_relation_cache_user ON relation_cache(user_id)');
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const cols = this.tableCols(table);
    if (!cols.includes(column)) {
      this.db.execSync(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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

  private rowToEntity(row: Row): CoreEntity {
    return {
      entity_id: String(row.entity_id),
      name: String(row.name),
      slug: String(row.slug),
      entity_type: String(row.entity_type) || 'npc',
      ontology_traits: safeJson<Record<string, unknown>>(row.ontology_traits as string, {}),
      entity_summary: String(row.entity_summary || ''),
      meta_first_appear_date: row.meta_first_appear_date != null ? String(row.meta_first_appear_date) : null,
      meta_last_interact_date: row.meta_last_interact_date != null ? String(row.meta_last_interact_date) : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      user_id: String(row.user_id),
    };
  }

  private rowToRelation(row: Row): RelationCache {
    return {
      entity_pair: String(row.entity_pair),
      user_id: String(row.user_id),
      shared_event_count: Number(row.shared_event_count),
      bond_strength: Number(row.bond_strength),
      intersection_stats: safeJson<Record<string, unknown>>(row.intersection_stats as string, {}),
      last_updated: String(row.last_updated),
    };
  }

  close(): void {
    this.db.closeSync();
  }

  // --- Entity CRUD ---

  upsertEntity(
    entity_id: string,
    name: string,
    slug: string,
    entity_type: string = 'npc',
    ontology_traits: Record<string, unknown> | null = null,
    entity_summary: string = '',
    user_id: string = 'default',
  ): void {
    const now = nowIso();
    const existing = this.getEntity(entity_id, user_id);

    if (existing) {
      this.db.runSync(
        `UPDATE entities SET
            name=?, ontology_traits=?, entity_summary=?,
            meta_last_interact_date=?, updated_at=?
        WHERE entity_id=? AND user_id=?`,
        [name, JSON.stringify(ontology_traits || {}), entity_summary, now, now, entity_id, user_id],
      );
    } else {
      this.db.runSync(
        `INSERT INTO entities
            (entity_id, name, slug, entity_type, ontology_traits,
             entity_summary, meta_first_appear_date, meta_last_interact_date,
             created_at, updated_at, user_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          entity_id,
          name,
          slug,
          entity_type,
          JSON.stringify(ontology_traits || {}),
          entity_summary,
          now,
          now,
          now,
          now,
          user_id,
        ],
      );
    }
  }

  getEntity(entity_id: string, user_id: string = 'default'): CoreEntity | null {
    const row = this.db.getFirstSync<Row>(
      'SELECT * FROM entities WHERE entity_id=? AND user_id=?',
      [entity_id, user_id],
    );
    return row ? this.rowToEntity(row) : null;
  }

  getEntityBySlug(slug: string, user_id: string = 'default'): CoreEntity | null {
    const row = this.db.getFirstSync<Row>(
      'SELECT * FROM entities WHERE slug=? AND user_id=?',
      [slug, user_id],
    );
    return row ? this.rowToEntity(row) : null;
  }

  getAllEntities(user_id: string = 'default'): CoreEntity[] {
    const rows = this.db.getAllSync<Row>(
      'SELECT * FROM entities WHERE user_id=? ORDER BY meta_last_interact_date DESC',
      [user_id],
    );
    return rows.map((r) => this.rowToEntity(r));
  }

  updateOntologyTraits(entity_id: string, traits: Record<string, unknown>, user_id: string = 'default'): void {
    this.db.runSync(
      'UPDATE entities SET ontology_traits=?, updated_at=? WHERE entity_id=? AND user_id=?',
      [JSON.stringify(traits), nowIso(), entity_id, user_id],
    );
  }

  updateEntitySummary(entity_id: string, summary: string, user_id: string = 'default'): void {
    this.db.runSync(
      'UPDATE entities SET entity_summary=?, updated_at=? WHERE entity_id=? AND user_id=?',
      [summary, nowIso(), entity_id, user_id],
    );
  }

  // --- Relation Cache ---

  getRelation(entity_a: string, entity_b: string, user_id: string = 'default'): RelationCache | null {
    const pair = [entity_a, entity_b].sort().join('__');
    const row = this.db.getFirstSync<Row>(
      'SELECT * FROM relation_cache WHERE entity_pair=? AND user_id=?',
      [pair, user_id],
    );
    return row ? this.rowToRelation(row) : null;
  }

  getAllRelations(user_id: string = 'default'): RelationCache[] {
    const rows = this.db.getAllSync<Row>(
      'SELECT * FROM relation_cache WHERE user_id=? AND shared_event_count > 0',
      [user_id],
    );
    return rows.map((r) => this.rowToRelation(r));
  }

  refreshRelationCacheForParticipants(participants: string[], user_id: string = 'default'): void {
    // 事件中心已废弃，保留空实现避免调用方崩溃
    return;
  }

  rebuildAllCaches(user_id: string = 'default'): void {
    this.db.runSync('DELETE FROM relation_cache WHERE user_id=?', [user_id]);
  }

  // --- Statistics ---

  getStats(user_id: string = 'default'): { entities: number; relations: number } {
    const e = this.db.getFirstSync<Row>('SELECT COUNT(*) as c FROM entities WHERE user_id=?', [user_id]);
    const r = this.db.getFirstSync<Row>(
      'SELECT COUNT(*) as c FROM relation_cache WHERE user_id=? AND shared_event_count > 0',
      [user_id],
    );
    return { entities: Number(e?.c), relations: Number(r?.c) };
  }

  // --- 用户迁移 ---

  migrateDefaultUser(new_user_id: string): void {
    this.db.withTransactionSync(() => {
      for (const table of ['entities', 'relation_cache']) {
        this.db.runSync(`UPDATE ${table} SET user_id = ? WHERE user_id = 'default'`, [new_user_id]);
      }
    });
  }
}

// 单例工厂（与 Python 全局 CoreStorage 实例对应）
let _coreStorage: CoreStorage | null = null;

export function getCoreStorage(): CoreStorage {
  if (!_coreStorage) {
    _coreStorage = new CoreStorage();
  }
  return _coreStorage;
}