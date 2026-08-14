import sqlite3
import json
import os
import uuid
import time
from datetime import datetime
from typing import List, Dict, Optional, Any
from dataclasses import dataclass, asdict
from server.logger import logger


@dataclass
class DiaryEntry:
    id: int
    date: str
    content: str
    messages: List[Dict[str, str]]
    weather: str
    tags: List[str]
    created_at: str
    updated_at: str


class DiaryStorage:
    def __init__(self, db_path: str = "data/diary.db"):
        self.db_path = db_path
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self._init_tables()

    def _init_tables(self):
        cursor = self.conn.cursor()
        # 清理旧版事件中心残留的临时表（现已无代码引用，避免误删正在使用的表）
        for legacy_table in ['temp_entities_today', 'temp_entities_yesterday',
                             'temp_relations_today', 'temp_relations_yesterday',
                             'extracted_memories']:
            cursor.execute(f"DROP TABLE IF EXISTS {legacy_table}")
        # 检查旧 schema 并迁移
        cursor.execute("PRAGMA table_info(diary_entries)")
        cols = [c[1] for c in cursor.fetchall()]
        if 'id' in cols and 'date' not in cols:
            cursor.execute("DROP TABLE IF EXISTS diary_entries")
        elif 'id' in cols:
            cursor.execute("PRAGMA table_info(diary_entries)")
            for c in cursor.fetchall():
                if c[1] == 'id' and c[2].upper() == 'TEXT':
                    cursor.execute("DROP TABLE IF EXISTS diary_entries")
                    break

        # ========== users 表 ==========
        cursor.executescript('''
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL,
                current_token_jti TEXT,
                current_token_expires REAL
            );
        ''')

        # ========== users 表: 单设备登录会话列迁移 ==========
        cursor.execute("PRAGMA table_info(users)")
        u_cols = [c[1] for c in cursor.fetchall()]
        if u_cols and 'current_token_jti' not in u_cols:
            cursor.execute("ALTER TABLE users ADD COLUMN current_token_jti TEXT")
        if u_cols and 'current_token_expires' not in u_cols:
            cursor.execute("ALTER TABLE users ADD COLUMN current_token_expires REAL")

        # ========== diary_entries: 添加 user_id 列 ==========
        cursor.execute("PRAGMA table_info(diary_entries)")
        de_cols = [c[1] for c in cursor.fetchall()]
        if de_cols and 'user_id' not in de_cols:
            cursor.execute("ALTER TABLE diary_entries ADD COLUMN user_id TEXT DEFAULT 'default'")

        # ========== calendar_cache: 重建为 (date, user_id) 复合主键 ==========
        cursor.execute("PRAGMA table_info(calendar_cache)")
        cc_cols = [c[1] for c in cursor.fetchall()]
        if 'diary_id' in cc_cols and 'date' not in cc_cols:
            cursor.execute("DROP TABLE IF EXISTS calendar_cache")
            cc_cols = []

        if cc_cols and 'user_id' not in cc_cols:
            # 旧表无 user_id → 重建
            cursor.execute("ALTER TABLE calendar_cache RENAME TO calendar_cache_old")
            cursor.executescript('''
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
            ''')
            # 检查旧表是否有 summary/emotion 列
            cursor.execute("PRAGMA table_info(calendar_cache_old)")
            old_cols = [c[1] for c in cursor.fetchall()]
            has_summary = 'summary' in old_cols
            has_emotion = 'emotion' in old_cols
            if has_summary and has_emotion:
                cursor.execute('''
                    INSERT INTO calendar_cache (date, user_id, entity_count, protagonist, summary, emotion, updated_at)
                    SELECT date, 'default', entity_count, protagonist, summary, emotion, updated_at FROM calendar_cache_old
                ''')
            else:
                cursor.execute('''
                    INSERT INTO calendar_cache (date, user_id, entity_count, protagonist, summary, emotion, updated_at)
                    SELECT date, 'default', entity_count, protagonist, '', '', updated_at FROM calendar_cache_old
                ''')
            cursor.execute("DROP TABLE calendar_cache_old")
        elif not cc_cols:
            # 表不存在，直接创建
            cursor.executescript('''
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
            ''')

        # ========== chat_sessions: 添加 user_id 列 ==========
        cursor.execute("PRAGMA table_info(chat_sessions)")
        cs_cols = [c[1] for c in cursor.fetchall()]
        if cs_cols and 'user_id' not in cs_cols:
            cursor.execute("ALTER TABLE chat_sessions ADD COLUMN user_id TEXT DEFAULT 'default'")

        # ========== user_profiles: 添加 diary_count 列（档案增量更新元数据） ==========
        cursor.execute("PRAGMA table_info(user_profiles)")
        up_cols = [c[1] for c in cursor.fetchall()]
        if up_cols and 'diary_count' not in up_cols:
            cursor.execute("ALTER TABLE user_profiles ADD COLUMN diary_count INTEGER DEFAULT 0")

        # ========== 确保所有表存在 ==========
        cursor.executescript('''
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
        ''')
        self.conn.commit()

        # ========== calendar_cache: 新增 emotion_vector 列（8维情绪打分 JSON） ==========
        cursor.execute("PRAGMA table_info(calendar_cache)")
        if 'emotion_vector' not in [c[1] for c in cursor.fetchall()]:
            cursor.execute("ALTER TABLE calendar_cache ADD COLUMN emotion_vector TEXT DEFAULT ''")
            self.conn.commit()

        # ========== fishbone_events: 改为"每篇日记一条摘要"（按 date 唯一）。旧带 title 列结构为测试数据，直接重建。 ==========
        cursor.execute("PRAGMA table_info(fishbone_events)")
        if 'title' in [c[1] for c in cursor.fetchall()]:
            cursor.execute("DROP TABLE fishbone_events")
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS fishbone_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT NOT NULL,
                    date TEXT NOT NULL,
                    summary TEXT DEFAULT '',
                    processed_at TEXT NOT NULL,
                    UNIQUE(user_id, date)
                )
            """)
            self.conn.commit()

        # ========== chat_messages: 新增 search_sources 列（联网搜索引用来源 JSON） ==========
        cursor.execute("PRAGMA table_info(chat_messages)")
        if 'search_sources' not in [c[1] for c in cursor.fetchall()]:
            cursor.execute("ALTER TABLE chat_messages ADD COLUMN search_sources TEXT DEFAULT ''")
            self.conn.commit()

        # ========== chat_messages: 新增 images 列（工作台对话页用户消息附带图片 JSON） ==========
        cursor.execute("PRAGMA table_info(chat_messages)")
        if 'images' not in [c[1] for c in cursor.fetchall()]:
            cursor.execute("ALTER TABLE chat_messages ADD COLUMN images TEXT DEFAULT ''")
            self.conn.commit()

    def _row_to_diary(self, row: sqlite3.Row) -> DiaryEntry:
        return DiaryEntry(
            id=row['id'],
            date=row['date'],
            content=row['content'] or '',
            messages=json.loads(row['messages']),
            weather=row['weather'],
            tags=json.loads(row['tags']),
            created_at=row['created_at'],
            updated_at=row['updated_at']
        )

    def save_diary(self, date: str, content: str = None, messages: List[Dict] = None,
                   weather: str = '晴', tags: List[str] = None,
                   user_id: str = 'default') -> DiaryEntry:
        """以 (date, user_id) 为唯一键的 UPSERT"""
        messages = messages or []
        tags = tags or []
        now = datetime.now().isoformat()

        cursor = self.conn.cursor()

        # 检查是否已有该日期的日记
        cursor.execute('SELECT id, created_at FROM diary_entries WHERE date = ? AND user_id = ?', (date, user_id))
        existing = cursor.fetchone()

        if existing:
            # 更新现有日记
            cursor.execute('''
                UPDATE diary_entries
                SET content = ?, messages = ?, weather = ?, tags = ?, updated_at = ?
                WHERE date = ? AND user_id = ?
            ''', (content, json.dumps(messages, ensure_ascii=False), weather,
                  json.dumps(tags, ensure_ascii=False), now, date, user_id))
            self.conn.commit()

            return DiaryEntry(
                id=existing['id'],
                date=date,
                content=content or '',
                messages=messages,
                weather=weather,
                tags=tags,
                created_at=existing['created_at'],
                updated_at=now
            )
        else:
            # 创建新日记
            cursor.execute('''
                INSERT INTO diary_entries (date, content, messages, weather, tags, created_at, updated_at, user_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ''', (date, content, json.dumps(messages, ensure_ascii=False), weather,
                  json.dumps(tags, ensure_ascii=False), now, now, user_id))
            self.conn.commit()

            diary_id = cursor.lastrowid

            return DiaryEntry(
                id=diary_id,
                date=date,
                content=content or '',
                messages=messages,
                weather=weather,
                tags=tags,
                created_at=now,
                updated_at=now
            )

    def batch_import_diaries(self, entries: List[Dict[str, Any]], user_id: str = 'default',
                             overwrite: bool = True) -> Dict[str, int]:
        """批量导入日记（纯净写库，绝不触发任何分析管线）。

        仅写入 diary_entries 表，不调用实体提取/摘要/情绪/kg_mem/锚点等任何
        分析逻辑；也绝不写入 calendar_cache。以 (date, user_id) 为唯一键 UPSERT：
          - 已存在且 overwrite=True → 保留原 created_at，更新 content/weather/tags；
          - 已存在且 overwrite=False → 跳过；
          - 不存在 → 新建。
        返回 {'imported': 新增数, 'updated': 覆盖数, 'skipped': 跳过/无效数}。
        """
        entries = entries or []
        now = datetime.now().isoformat()
        imported = updated = skipped = 0
        cursor = self.conn.cursor()
        for e in entries:
            date = (e or {}).get("date")
            if not date:
                skipped += 1
                continue
            content = e.get("content") or ""
            weather = e.get("weather") or "晴"
            tags = e.get("tags") or []
            created_at = e.get("created_at") or now
            cursor.execute("SELECT id, created_at FROM diary_entries WHERE date = ? AND user_id = ?", (date, user_id))
            existing = cursor.fetchone()
            if existing:
                if not overwrite:
                    skipped += 1
                    continue
                cursor.execute(
                    "UPDATE diary_entries SET content = ?, weather = ?, tags = ?, updated_at = ? WHERE date = ? AND user_id = ?",
                    (content, weather, json.dumps(tags, ensure_ascii=False), now, date, user_id))
                updated += 1
            else:
                cursor.execute(
                    "INSERT INTO diary_entries (date, content, messages, weather, tags, created_at, updated_at, user_id) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (date, content, "[]", weather, json.dumps(tags, ensure_ascii=False), created_at, now, user_id))
                imported += 1
        self.conn.commit()
        logger.info(f"批量导入完成: 新增 {imported}, 覆盖 {updated}, 跳过 {skipped} (用户 {user_id})")
        return {"imported": imported, "updated": updated, "skipped": skipped}

    def get_diary_by_date(self, date: str, user_id: str = 'default') -> Optional[DiaryEntry]:
        cursor = self.conn.cursor()
        cursor.execute('SELECT * FROM diary_entries WHERE date = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1', (date, user_id))
        row = cursor.fetchone()
        return self._row_to_diary(row) if row else None

    def get_diaries_by_range(self, start_date: str, end_date: str, user_id: str = 'default') -> List[DiaryEntry]:
        cursor = self.conn.cursor()
        cursor.execute('''
            SELECT * FROM diary_entries
            WHERE date >= ? AND date <= ? AND user_id = ?
            ORDER BY date DESC
        ''', (start_date, end_date, user_id))
        return [self._row_to_diary(row) for row in cursor.fetchall()]

    def update_weather(self, date: str, weather: str, user_id: str = 'default') -> bool:
        """仅更新某日日记的天气字段（轻量，不触发异步管线）。
        若该日尚无日记，则创建一条仅含天气的占位记录。"""
        now = datetime.now().isoformat()
        cursor = self.conn.cursor()
        cursor.execute('SELECT id FROM diary_entries WHERE date = ? AND user_id = ?', (date, user_id))
        existing = cursor.fetchone()
        if existing:
            cursor.execute(
                'UPDATE diary_entries SET weather = ?, updated_at = ? WHERE date = ? AND user_id = ?',
                (weather, now, date, user_id))
        else:
            cursor.execute(
                'INSERT INTO diary_entries (date, content, messages, weather, tags, created_at, updated_at, user_id) '
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                (date, '', '[]', weather, '[]', now, now, user_id))
        self.conn.commit()
        return True

    # ==========================================
    # 人际关系档案 (Relationship Profiles)
    # ==========================================

    def create_relationship(self, user_id: str, person_name: str) -> dict:
        """创建人际关系档案记录"""
        import uuid
        rid = str(uuid.uuid4())
        now = datetime.now().isoformat()
        cursor = self.conn.cursor()
        cursor.execute('''
            INSERT INTO relationship_profiles (id, user_id, person_name, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
        ''', (rid, user_id, person_name, now, now))
        self.conn.commit()
        return {"id": rid, "user_id": user_id, "person_name": person_name,
                "profile_content": "", "evidence": "[]", "dimensions": "[]",
                "last_search_date": None, "created_at": now, "updated_at": now}

    def get_relationship(self, relationship_id: str) -> Optional[Dict]:
        """获取单个人际关系档案"""
        cursor = self.conn.cursor()
        cursor.execute("SELECT * FROM relationship_profiles WHERE id = ?", (relationship_id,))
        row = cursor.fetchone()
        return dict(row) if row else None

    def get_relationship_by_name(self, user_id: str, person_name: str) -> Optional[Dict]:
        """按名字查找人际关系档案"""
        cursor = self.conn.cursor()
        cursor.execute("SELECT * FROM relationship_profiles WHERE user_id = ? AND person_name = ?",
                       (user_id, person_name))
        row = cursor.fetchone()
        return dict(row) if row else None

    def list_relationships(self, user_id: str) -> list:
        """列出用户所有人际关系档案"""
        cursor = self.conn.cursor()
        cursor.execute("SELECT id, person_name, created_at, updated_at FROM relationship_profiles WHERE user_id = ? ORDER BY updated_at DESC",
                       (user_id,))
        return [dict(row) for row in cursor.fetchall()]

    def update_relationship(self, relationship_id: str, profile_content: str = None,
                            evidence: str = None, dimensions: str = None,
                            last_search_date: str = None):
        """更新人际关系档案"""
        now = datetime.now().isoformat()
        cursor = self.conn.cursor()
        fields = ["updated_at = ?"]
        params = [now]
        if profile_content is not None:
            fields.append("profile_content = ?")
            params.append(profile_content)
        if evidence is not None:
            fields.append("evidence = ?")
            params.append(evidence)
        if dimensions is not None:
            fields.append("dimensions = ?")
            params.append(dimensions)
        if last_search_date is not None:
            fields.append("last_search_date = ?")
            params.append(last_search_date)
        params.append(relationship_id)
        cursor.execute(f"UPDATE relationship_profiles SET {', '.join(fields)} WHERE id = ?", params)
        self.conn.commit()

    def delete_relationship(self, relationship_id: str):
        """删除人际关系档案"""
        cursor = self.conn.cursor()
        cursor.execute("DELETE FROM relationship_profiles WHERE id = ?", (relationship_id,))
        self.conn.commit()

    def get_recent_diaries(self, limit: int = 10, user_id: str = 'default') -> List[DiaryEntry]:
        cursor = self.conn.cursor()
        cursor.execute('SELECT * FROM diary_entries WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', (user_id, limit))
        return [self._row_to_diary(row) for row in cursor.fetchall()]

    def get_diaries_by_month(self, year: int, month: str, user_id: str = 'default') -> List[DiaryEntry]:
        cursor = self.conn.cursor()
        cursor.execute(
            "SELECT * FROM diary_entries WHERE date LIKE ? AND user_id = ? ORDER BY date",
            (f"{year}-{month.zfill(2)}-%", user_id)
        )
        return [self._row_to_diary(row) for row in cursor.fetchall()]

    def search_diaries(self, query: str, limit: int = 10, user_id: str = 'default') -> List[Dict[str, Any]]:
        cursor = self.conn.cursor()
        like_pattern = f"%{query}%"
        cursor.execute('''
            SELECT * FROM diary_entries
            WHERE (content LIKE ? OR tags LIKE ?) AND user_id = ?
            ORDER BY created_at DESC
            LIMIT ?
        ''', (like_pattern, like_pattern, user_id, limit))
        diaries = []
        for row in cursor.fetchall():
            diary = self._row_to_diary(row)
            diaries.append({
                'diary': asdict(diary),
                'score': 1.0
            })
        return diaries

    def update_calendar_cache(self, date: str, entity_count: int, protagonist: str, summary: str = "", emotion: str = "", user_id: str = 'default'):
        now = datetime.now().isoformat()
        cursor = self.conn.cursor()
        # 保留已有总结词、情绪和情绪打分，避免被异步管线覆盖
        existing = self.get_calendar_cache(date, user_id)
        existing_vector = ''
        if existing is not None:
            if not summary and existing.get('summary'):
                summary = existing['summary']
            if not emotion and existing.get('emotion'):
                emotion = existing['emotion']
            if existing.get('emotion_vector'):
                existing_vector = existing['emotion_vector']
        cursor.execute('''
            INSERT OR REPLACE INTO calendar_cache (date, user_id, entity_count, protagonist, summary, emotion, emotion_vector, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ''', (date, user_id, entity_count, protagonist, summary, emotion, existing_vector, now))
        self.conn.commit()

    def get_calendar_cache(self, date: str, user_id: str = 'default') -> Optional[Dict]:
        cursor = self.conn.cursor()
        cursor.execute('SELECT * FROM calendar_cache WHERE date = ? AND user_id = ?', (date, user_id))
        row = cursor.fetchone()
        if row:
            return {
                'entity_count': row['entity_count'],
                'protagonist': row['protagonist'],
                'summary': row['summary'] if 'summary' in row.keys() else '',
                'emotion': row['emotion'] if 'emotion' in row.keys() else '',
                'emotion_vector': row['emotion_vector'] if 'emotion_vector' in row.keys() else '',
                'updated_at': row['updated_at']
            }
        return None

    def get_stats(self) -> Dict[str, Any]:
        cursor = self.conn.cursor()
        cursor.execute('SELECT COUNT(*) as count FROM diary_entries')
        diary_count = cursor.fetchone()['count']
        cursor.execute('SELECT COUNT(*) as count FROM calendar_cache')
        cache_count = cursor.fetchone()['count']
        return {
            'total_diaries': diary_count,
            'calendar_cache_entries': cache_count,
        }

    def close(self):
        self.conn.close()

    # ==========================================
    # 会话管理 (Chat Sessions)
    # ==========================================

    def create_session(self, date: str, title: str = "新对话", user_id: str = 'default') -> dict:
        session_id = str(uuid.uuid4())
        now = datetime.now().isoformat()
        cursor = self.conn.cursor()
        cursor.execute('''
            INSERT INTO chat_sessions (id, date, title, created_at, updated_at, user_id)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (session_id, date, title, now, now, user_id))
        self.conn.commit()
        return {"id": session_id, "date": date, "title": title, "created_at": now, "updated_at": now}

    def get_sessions_by_date(self, date: str, user_id: str = 'default') -> list:
        cursor = self.conn.cursor()
        cursor.execute('SELECT * FROM chat_sessions WHERE date = ? AND user_id = ? ORDER BY updated_at DESC', (date, user_id))
        return [dict(row) for row in cursor.fetchall()]

    def get_session_by_title(self, title: str, user_id: str = 'default') -> Optional[Dict]:
        """按标题查找会话"""
        cursor = self.conn.cursor()
        cursor.execute(
            "SELECT * FROM chat_sessions WHERE title = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 1",
            (title, user_id)
        )
        row = cursor.fetchone()
        return dict(row) if row else None

    def get_session_owner(self, session_id: str) -> Optional[str]:
        """返回会话所属用户 id；会话不存在返回 None。

        用于会话归属校验（IDOR 防护）：路由层拿到 session_id 后，
        先确认它属于当前登录用户，再执行读写，避免跨用户越权。
        """
        cursor = self.conn.cursor()
        cursor.execute("SELECT user_id FROM chat_sessions WHERE id = ?", (session_id,))
        row = cursor.fetchone()
        return row["user_id"] if row else None

    def update_session(self, session_id: str, title: str = None, user_id: str = None) -> bool:
        if title is None:
            return False
        cursor = self.conn.cursor()
        if user_id is not None:
            # 归属校验：只更新属于该用户的会话，防止跨用户改名
            cursor.execute(
                "UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?",
                (title, datetime.now().isoformat(), session_id, user_id)
            )
        else:
            cursor.execute(
                "UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?",
                (title, datetime.now().isoformat(), session_id)
            )
        self.conn.commit()
        return cursor.rowcount > 0

    def delete_session(self, session_id: str, user_id: str = None) -> bool:
        cursor = self.conn.cursor()
        try:
            if user_id is not None:
                # 归属校验：只删除属于该用户的会话，防止跨用户删除
                cursor.execute(
                    "DELETE FROM chat_messages WHERE session_id IN "
                    "(SELECT id FROM chat_sessions WHERE id = ? AND user_id = ?)",
                    (session_id, user_id)
                )
                cursor.execute(
                    "DELETE FROM chat_sessions WHERE id = ? AND user_id = ?",
                    (session_id, user_id)
                )
            else:
                cursor.execute("DELETE FROM chat_messages WHERE session_id = ?", (session_id,))
                cursor.execute("DELETE FROM chat_sessions WHERE id = ?", (session_id,))
            self.conn.commit()
            return cursor.rowcount > 0
        except Exception as e:
            self.conn.rollback()
            logger.error(f"delete_session 失败: {e}")
            raise

    def add_message(self, session_id: str, role: str, content: str, thinking: str = "", diary_date: str = "", search_sources: str = "", images: str = "") -> dict:
        ts = time.time()
        cursor = self.conn.cursor()
        cursor.execute('''
            INSERT INTO chat_messages (session_id, role, content, thinking, diary_date, timestamp, search_sources, images)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ''', (session_id, role, content, thinking, diary_date, ts, search_sources, images))
        cursor.execute('UPDATE chat_sessions SET updated_at = ? WHERE id = ?', (datetime.now().isoformat(), session_id))
        self.conn.commit()
        return {"id": cursor.lastrowid, "session_id": session_id, "role": role,
                "content": content, "thinking": thinking, "diary_date": diary_date, "timestamp": ts,
                "search_sources": search_sources, "images": images}

    def get_messages(self, session_id: str, limit: int = 100) -> list:
        cursor = self.conn.cursor()
        cursor.execute(
            'SELECT * FROM chat_messages WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?',
            (session_id, limit)
        )
        rows = [dict(row) for row in cursor.fetchall()]
        # 将存储的 JSON 串解析为前端可用的 sources / images 数组
        for r in rows:
            raw = r.get("search_sources") or ""
            try:
                r["sources"] = json.loads(raw) if raw else []
            except (json.JSONDecodeError, TypeError):
                r["sources"] = []
            raw_img = r.get("images") or ""
            try:
                r["images"] = json.loads(raw_img) if raw_img else []
            except (json.JSONDecodeError, TypeError):
                r["images"] = []
        return rows

    def get_recent_messages_for_context(self, session_id: str, limit: int = 6) -> list:
        msgs = self.get_messages(session_id, limit=200)
        recent = msgs[-limit:] if len(msgs) > limit else msgs
        return [{"role": m["role"], "content": m["content"]} for m in recent]

    def set_summary(self, date: str, summary: str, user_id: str = 'default') -> bool:
        """更新某天的日历总结词"""
        cursor = self.conn.cursor()
        cursor.execute("SELECT date FROM calendar_cache WHERE date = ? AND user_id = ?", (date, user_id))
        if cursor.fetchone():
            cursor.execute("UPDATE calendar_cache SET summary = ?, updated_at = ? WHERE date = ? AND user_id = ?",
                           (summary, datetime.now().isoformat(), date, user_id))
        else:
            cursor.execute(
                "INSERT INTO calendar_cache (date, user_id, entity_count, protagonist, summary, emotion, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (date, user_id, 0, '自己', summary, '', datetime.now().isoformat()))
        self.conn.commit()
        return True

    def set_emotion(self, date: str, emotion: str, user_id: str = 'default') -> bool:
        """更新某天的主要情绪"""
        cursor = self.conn.cursor()
        cursor.execute("SELECT date FROM calendar_cache WHERE date = ? AND user_id = ?", (date, user_id))
        if cursor.fetchone():
            cursor.execute("UPDATE calendar_cache SET emotion = ?, updated_at = ? WHERE date = ? AND user_id = ?",
                           (emotion, datetime.now().isoformat(), date, user_id))
        else:
            cursor.execute(
                "INSERT INTO calendar_cache (date, user_id, entity_count, protagonist, summary, emotion, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (date, user_id, 0, '自己', '', emotion, datetime.now().isoformat()))
        self.conn.commit()
        return True

    def set_emotion_vector(self, date: str, vector: dict, user_id: str = 'default') -> bool:
        """更新某天的 8 维情绪打分（普拉奇克 8 基础情绪，各 0-100）。vector 为 {情绪词: 分数}。"""
        text = json.dumps(vector, ensure_ascii=False)
        cursor = self.conn.cursor()
        cursor.execute("SELECT date FROM calendar_cache WHERE date = ? AND user_id = ?", (date, user_id))
        if cursor.fetchone():
            cursor.execute("UPDATE calendar_cache SET emotion_vector = ?, updated_at = ? WHERE date = ? AND user_id = ?",
                           (text, datetime.now().isoformat(), date, user_id))
        else:
            cursor.execute(
                "INSERT INTO calendar_cache (date, user_id, entity_count, protagonist, summary, emotion, emotion_vector, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (date, user_id, 0, '自己', '', '', text, datetime.now().isoformat()))
        self.conn.commit()
        return True

    # ==========================================
    # 用户管理 (User Management)
    # ==========================================

    def create_user(self, username: str, password_hash: str) -> dict:
        """创建新用户"""
        user_id = str(uuid.uuid4())
        now = datetime.now().isoformat()
        cursor = self.conn.cursor()
        cursor.execute(
            "INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)",
            (user_id, username, password_hash, now)
        )
        self.conn.commit()
        return {"id": user_id, "username": username, "created_at": now}

    def get_user_by_username(self, username: str) -> Optional[Dict]:
        """按用户名查找用户"""
        cursor = self.conn.cursor()
        cursor.execute("SELECT * FROM users WHERE username = ?", (username,))
        row = cursor.fetchone()
        if row:
            return {"id": row['id'], "username": row['username'],
                    "password_hash": row['password_hash'], "created_at": row['created_at'],
                    "current_token_jti": row['current_token_jti'],
                    "current_token_expires": row['current_token_expires']}
        return None

    def get_user_by_id(self, user_id: str) -> Optional[Dict]:
        """按 ID 查找用户"""
        cursor = self.conn.cursor()
        cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
        row = cursor.fetchone()
        if row:
            return {"id": row['id'], "username": row['username'],
                    "password_hash": row['password_hash'], "created_at": row['created_at'],
                    "current_token_jti": row['current_token_jti'],
                    "current_token_expires": row['current_token_expires']}
        return None

    def set_user_current_token(self, user_id: str, jti: str, expires: float) -> None:
        """记录该用户当前唯一有效会话的 jti 与过期时间戳"""
        cursor = self.conn.cursor()
        cursor.execute(
            "UPDATE users SET current_token_jti = ?, current_token_expires = ? WHERE id = ?",
            (jti, expires, user_id)
        )
        self.conn.commit()

    def get_all_users(self) -> list:
        """获取所有用户列表（不含密码）"""
        cursor = self.conn.cursor()
        cursor.execute("SELECT id, username, created_at FROM users ORDER BY created_at")
        return [dict(row) for row in cursor.fetchall()]

    def migrate_default_user(self, new_user_id: str):
        """将 user_id='default' 的旧数据迁移到新用户 ID"""
        cursor = self.conn.cursor()
        for table in ['diary_entries', 'calendar_cache', 'chat_sessions']:
            cursor.execute(f"UPDATE {table} SET user_id = ? WHERE user_id = 'default'", (new_user_id,))
            if cursor.rowcount > 0:
                logger.info(f"  迁移 {table}: {cursor.rowcount} 条记录")
        self.conn.commit()

    # ==========================================
    # 事件鱼骨图 (Fishbone Events)
    # ==========================================

    def add_fishbone_event(self, user_id: str, date: str, summary: str) -> bool:
        """写入/覆盖某篇日记的摘要，按 (user_id, date) 唯一。返回是否影响行数。"""
        now = datetime.now().isoformat()
        cursor = self.conn.cursor()
        cursor.execute(
            "INSERT OR REPLACE INTO fishbone_events (user_id, date, summary, processed_at) VALUES (?, ?, ?, ?)",
            (user_id, date, summary, now),
        )
        self.conn.commit()
        return cursor.rowcount > 0

    def get_fishbone_events(self, user_id: str) -> list:
        """按日期升序返回用户的全部日记摘要"""
        cursor = self.conn.cursor()
        cursor.execute(
            "SELECT id, date, summary, processed_at FROM fishbone_events WHERE user_id = ? ORDER BY date ASC, id ASC",
            (user_id,),
        )
        return [dict(row) for row in cursor.fetchall()]

    def get_last_processed_date(self, user_id: str) -> Optional[str]:
        """获取鱼骨图最后一次成功处理的日记日期"""
        cursor = self.conn.cursor()
        cursor.execute("SELECT value FROM user_meta WHERE user_id = ? AND key = 'fishbone_last_date'", (user_id,))
        row = cursor.fetchone()
        return row["value"] if row else None

    def set_last_processed_date(self, user_id: str, date: str):
        """推进鱼骨图增量游标（仅在整篇日记处理成功后调用）"""
        cursor = self.conn.cursor()
        cursor.execute(
            "INSERT OR REPLACE INTO user_meta (user_id, key, value) VALUES (?, 'fishbone_last_date', ?)",
            (user_id, date),
        )
        self.conn.commit()

    def get_user_meta(self, user_id: str, key: str) -> str:
        """读取 user_meta 通用键值，不存在返回空串。"""
        cursor = self.conn.cursor()
        cursor.execute("SELECT value FROM user_meta WHERE user_id = ? AND key = ?", (user_id, key))
        row = cursor.fetchone()
        return row["value"] if row else ""

    def set_user_meta(self, user_id: str, key: str, value: str):
        """写入 user_meta 通用键值（UPSERT）。"""
        cursor = self.conn.cursor()
        cursor.execute(
            "INSERT OR REPLACE INTO user_meta (user_id, key, value) VALUES (?, ?, ?)",
            (user_id, key, value),
        )
        self.conn.commit()

    def get_diaries_after(self, user_id: str, since_date: str) -> list:
        """取 date > since_date 的日记（按日期升序），用于鱼骨增量提取"""
        cursor = self.conn.cursor()
        cursor.execute(
            "SELECT * FROM diary_entries WHERE user_id = ? AND date > ? AND content IS NOT NULL AND length(trim(content)) >= 1 ORDER BY date ASC",
            (user_id, since_date or ""),
        )
        return [self._row_to_diary(row) for row in cursor.fetchall()]

    # ==========================================
    # 用户档案 (User Profile)
    # ==========================================

    def get_user_profile(self, user_id: str) -> str:
        """获取用户档案内容"""
        cursor = self.conn.cursor()
        cursor.execute("SELECT content FROM user_profiles WHERE user_id = ?", (user_id,))
        row = cursor.fetchone()
        return row['content'] if row else ''

    def get_user_profile_diary_count(self, user_id: str) -> int:
        """获取上次生成档案时的日记基数（无档案则返回 0）"""
        cursor = self.conn.cursor()
        cursor.execute("SELECT diary_count FROM user_profiles WHERE user_id = ?", (user_id,))
        row = cursor.fetchone()
        return row['diary_count'] if row else 0

    def save_user_profile(self, user_id: str, content: str, diary_count: int = 0):
        """保存用户档案（覆盖式），同时记录生成时的日记基数"""
        now = datetime.now().isoformat()
        cursor = self.conn.cursor()
        cursor.execute('''
            INSERT INTO user_profiles (user_id, content, updated_at, diary_count)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET content = ?, updated_at = ?, diary_count = ?
        ''', (user_id, content, now, diary_count, content, now, diary_count))
        self.conn.commit()

    def get_interaction_mode(self, user_id: str, ai_key: str) -> str:
        """获取互动模式的 JSON 内容，无记录返回空串"""
        cursor = self.conn.cursor()
        cursor.execute("SELECT content FROM interaction_modes WHERE user_id = ? AND ai_key = ?", (user_id, ai_key))
        row = cursor.fetchone()
        return row['content'] if row else ''

    def save_interaction_mode(self, user_id: str, ai_key: str, content: str, diary_count: int = 0):
        """保存互动模式（UPSERT），同时记录生成时的日记基数"""
        now = datetime.now().isoformat()
        cursor = self.conn.cursor()
        cursor.execute('''
            INSERT INTO interaction_modes (user_id, ai_key, content, profile_diary_count, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id, ai_key) DO UPDATE SET content = ?, profile_diary_count = ?, updated_at = ?
        ''', (user_id, ai_key, content, diary_count, now, content, diary_count, now))
        self.conn.commit()

    def list_interaction_mode_keys(self, user_id: str) -> list:
        """列出用户全部互动模式的 ai_key 列表"""
        cursor = self.conn.cursor()
        cursor.execute("SELECT ai_key FROM interaction_modes WHERE user_id = ?", (user_id,))
        return [row['ai_key'] for row in cursor.fetchall()]

    def get_all_diaries(self, user_id: str) -> List[DiaryEntry]:
        """获取用户全部日记"""
        cursor = self.conn.cursor()
        cursor.execute('SELECT * FROM diary_entries WHERE user_id = ? ORDER BY date', (user_id,))
        return [self._row_to_diary(row) for row in cursor.fetchall()]