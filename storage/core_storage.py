"""
core_storage.py — Atrium OS 核心存储引擎
两张核心表：entities（实体/人格档案）/ relation_cache（关系缓存）
"""
import sqlite3
import json
import os
from datetime import datetime
from typing import List, Dict, Optional, Any


class CoreStorage:
    """Atrium OS 核心存储引擎 — 实体 + 关系缓存模型"""

    DEFAULT_DB_PATH = os.path.join("data", "core_storage.db")

    def __init__(self, db_path: str = None):
        self.db_path = db_path or self.DEFAULT_DB_PATH
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self._init_tables()

    def _init_tables(self):
        """初始化三张核心表"""
        cursor = self.conn.cursor()

        # 1. entities — 实体人物表（时间轴本体 + 静态人格）
        cursor.execute('''
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
            )
        ''')
        # 迁移：为旧表添加 user_id 列（如不存在）
        self._ensure_column(cursor, 'entities', 'user_id', "TEXT NOT NULL DEFAULT 'default'")
        # 复合唯一索引 (slug, user_id) —— 旧表的 slug UNIQUE 约束保留，额外加此索引实现多用户隔离
        cursor.execute('''
            CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_slug_user
            ON entities(slug, user_id)
        ''')

        # 2. relation_cache — 关系派生缓存表
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS relation_cache (
                entity_pair   TEXT,
                user_id       TEXT NOT NULL DEFAULT 'default',
                shared_event_count  INTEGER NOT NULL DEFAULT 0,
                bond_strength      REAL NOT NULL DEFAULT 0.0,
                intersection_stats TEXT DEFAULT '{}',
                last_updated        TEXT NOT NULL,
                PRIMARY KEY (entity_pair, user_id)
            )
        ''')
        # 迁移：为旧表添加 user_id 列（如不存在）
        self._ensure_column(cursor, 'relation_cache', 'user_id', "TEXT NOT NULL DEFAULT 'default'")
        # 复合唯一索引 (entity_pair, user_id) —— 旧表 entity_pair PRIMARY KEY 保留，额外加此索引
        cursor.execute('''
            CREATE UNIQUE INDEX IF NOT EXISTS idx_relation_cache_pair_user
            ON relation_cache(entity_pair, user_id)
        ''')

        # 索引
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_entities_slug ON entities(slug)')
        # 多用户隔离索引
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_entities_user ON entities(user_id)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_relation_cache_user ON relation_cache(user_id)')

        self.conn.commit()

    def _ensure_column(self, cursor, table: str, column: str, definition: str):
        """确保表中存在指定列，不存在则添加（用于旧表迁移）"""
        cursor.execute(f"PRAGMA table_info({table})")
        columns = [row[1] for row in cursor.fetchall()]
        if column not in columns:
            cursor.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

    def close(self):
        self.conn.close()

    # --- Entity CRUD ---

    def upsert_entity(self, entity_id: str, name: str, slug: str,
                      entity_type: str = "npc",
                      ontology_traits: dict = None,
                      entity_summary: str = "",
                      user_id: str = 'default') -> None:
        """创建或更新实体"""
        now = datetime.now().isoformat()
        existing = self.get_entity(entity_id, user_id)
        cursor = self.conn.cursor()

        if existing:
            first_appear = existing["meta_first_appear_date"]
            cursor.execute('''
                UPDATE entities SET
                    name=?, ontology_traits=?, entity_summary=?,
                    meta_last_interact_date=?, updated_at=?
                WHERE entity_id=? AND user_id=?
            ''', (name,
                  json.dumps(ontology_traits or {}, ensure_ascii=False),
                  entity_summary, now, now, entity_id, user_id))
        else:
            cursor.execute('''
                INSERT INTO entities
                    (entity_id, name, slug, entity_type, ontology_traits,
                     entity_summary, meta_first_appear_date, meta_last_interact_date,
                     created_at, updated_at, user_id)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ''', (entity_id, name, slug, entity_type,
                  json.dumps(ontology_traits or {}, ensure_ascii=False),
                  entity_summary, now, now, now, now, user_id))

        self.conn.commit()

    def get_entity(self, entity_id: str, user_id: str = 'default') -> Optional[Dict]:
        cursor = self.conn.cursor()
        cursor.execute('SELECT * FROM entities WHERE entity_id=? AND user_id=?', (entity_id, user_id))
        row = cursor.fetchone()
        if not row:
            return None
        d = dict(row)
        d["ontology_traits"] = json.loads(d["ontology_traits"])
        return d

    def get_entity_by_slug(self, slug: str, user_id: str = 'default') -> Optional[Dict]:
        cursor = self.conn.cursor()
        cursor.execute('SELECT * FROM entities WHERE slug=? AND user_id=?', (slug, user_id))
        row = cursor.fetchone()
        if not row:
            return None
        d = dict(row)
        d["ontology_traits"] = json.loads(d["ontology_traits"])
        return d

    def get_all_entities(self, user_id: str = 'default') -> List[Dict]:
        cursor = self.conn.cursor()
        cursor.execute('SELECT * FROM entities WHERE user_id=? ORDER BY meta_last_interact_date DESC', (user_id,))
        rows = cursor.fetchall()
        result = []
        for row in rows:
            d = dict(row)
            d["ontology_traits"] = json.loads(d["ontology_traits"])
            result.append(d)
        return result

    def update_ontology_traits(self, entity_id: str, traits: dict, user_id: str = 'default') -> None:
        """更新实体的本体论特质"""
        cursor = self.conn.cursor()
        cursor.execute('''
            UPDATE entities SET ontology_traits=?, updated_at=?
            WHERE entity_id=? AND user_id=?
        ''', (json.dumps(traits, ensure_ascii=False),
              datetime.now().isoformat(), entity_id, user_id))
        self.conn.commit()

    def update_entity_summary(self, entity_id: str, summary: str, user_id: str = 'default') -> None:
        """更新实体摘要"""
        cursor = self.conn.cursor()
        cursor.execute('''
            UPDATE entities SET entity_summary=?, updated_at=?
            WHERE entity_id=? AND user_id=?
        ''', (summary, datetime.now().isoformat(), entity_id, user_id))
        self.conn.commit()

    # --- Relation Cache ---

    def get_relation(self, entity_a: str, entity_b: str, user_id: str = 'default') -> Optional[Dict]:
        pair = "__".join(sorted([entity_a, entity_b]))
        cursor = self.conn.cursor()
        cursor.execute('SELECT * FROM relation_cache WHERE entity_pair=? AND user_id=?', (pair, user_id))
        row = cursor.fetchone()
        if not row:
            return None
        d = dict(row)
        d["intersection_stats"] = json.loads(d["intersection_stats"])
        return d

    def get_all_relations(self, user_id: str = 'default') -> List[Dict]:
        cursor = self.conn.cursor()
        cursor.execute('SELECT * FROM relation_cache WHERE user_id=? AND shared_event_count > 0', (user_id,))
        rows = cursor.fetchall()
        result = []
        for row in rows:
            d = dict(row)
            d["intersection_stats"] = json.loads(d["intersection_stats"])
            result.append(d)
        return result

    def _refresh_relation_cache_for_participants(self, participants: List[str], user_id: str = 'default') -> None:
        """为给定参与者列表的两两组合刷新关系缓存（事件中心已废弃，保留空实现避免调用方崩溃）"""
        return

    def rebuild_all_caches(self, user_id: str = 'default') -> None:
        """一键重建所有关系缓存（事件中心已废弃，重置为空）"""
        cursor = self.conn.cursor()
        cursor.execute('DELETE FROM relation_cache WHERE user_id=?', (user_id,))
        self.conn.commit()

    # --- Statistics ---

    def get_stats(self, user_id: str = 'default') -> Dict:
        cursor = self.conn.cursor()
        entity_count = cursor.execute("SELECT COUNT(*) FROM entities WHERE user_id=?", (user_id,)).fetchone()[0]
        relation_count = cursor.execute(
            "SELECT COUNT(*) FROM relation_cache WHERE user_id=? AND shared_event_count > 0", (user_id,)).fetchone()[0]
        return {
            "entities": entity_count,
            "relations": relation_count
        }

    # --- 用户迁移 ---

    def migrate_default_user(self, new_user_id: str):
        """将 user_id='default' 的旧数据迁移到新用户"""
        cursor = self.conn.cursor()
        for table in ['entities', 'relation_cache']:
            cursor.execute(f"UPDATE {table} SET user_id = ? WHERE user_id = 'default'", (new_user_id,))
        self.conn.commit()