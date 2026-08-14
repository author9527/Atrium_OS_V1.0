"""
Atrium OS 增量沉淀系统

设计原则：
1. 加性沉淀：只处理上次沉淀之后的新数据
2. 时间锚点：data/consolidation_anchor.json 记录上次沉淀的时间戳
3. 数据整合：沉淀完成后对 entities 表的 ontology_traits 做去重
"""

import os
import json
import time
import threading
from datetime import datetime
from typing import List, Optional, Tuple

from core_storage import CoreStorage
from server.logger import logger


class ConsolidationAnchor:
    """沉淀时间锚点管理器

    锚点数据存储在 data/consolidation_anchor.json 中，
    保持接口契约不变，兼容 atrium_server.py 的调用方式。
    """

    def __init__(self, root_dir: str = "brain_arch"):
        # root_dir 保留参数签名以兼容现有调用，但锚点文件改存到 data/ 目录
        self.root_dir = root_dir
        self.anchor_file = os.path.join("data", "consolidation_anchor.json")
        self._data = self._load()

    def _load(self) -> dict:
        if os.path.exists(self.anchor_file):
            try:
                with open(self.anchor_file, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception:
                pass
        return {
            "last_diary_ts": "",       # 上次沉淀的最迟日记 created_at
            "last_dialogue_ts": 0.0,   # 上次沉淀的最迟对话 timestamp
            "last_consolidation_at": "",  # 上次沉淀完成时间
            "total_diaries_consolidated": 0,
            "total_dialogues_consolidated": 0
        }

    def save(self):
        os.makedirs(os.path.dirname(self.anchor_file), exist_ok=True)
        self._data["last_consolidation_at"] = datetime.now().isoformat()
        with open(self.anchor_file, 'w', encoding='utf-8') as f:
            json.dump(self._data, f, ensure_ascii=False, indent=2)

    @property
    def last_diary_ts(self) -> str:
        return self._data.get("last_diary_ts", "")

    @property
    def last_dialogue_ts(self) -> float:
        return self._data.get("last_dialogue_ts", 0.0)

    def update_diary_anchor(self, ts: str):
        """更新日记沉淀锚点（取最大值）"""
        if ts > self._data["last_diary_ts"]:
            self._data["last_diary_ts"] = ts
            self._data["total_diaries_consolidated"] = self._data.get("total_diaries_consolidated", 0) + 1

    def update_dialogue_anchor(self, ts: float):
        """更新对话沉淀锚点（取最大值）"""
        if ts > self._data["last_dialogue_ts"]:
            self._data["last_dialogue_ts"] = ts
            self._data["total_dialogues_consolidated"] = self._data.get("total_dialogues_consolidated", 0) + 1

    def reset(self):
        """重置锚点（用于全量重新沉淀）"""
        self._data = {
            "last_diary_ts": "",
            "last_dialogue_ts": 0.0,
            "last_consolidation_at": "",
            "total_diaries_consolidated": 0,
            "total_dialogues_consolidated": 0
        }
        self.save()

    def get_status(self) -> dict:
        return dict(self._data)


def deduplicate_traits(root_dir: str = "brain_arch"):
    """对 core_storage.db 中所有 NPC 实体的 ontology_traits 做去重整合

    去重规则：按 trait key 去重，相同 key 只保留 confidence 最高的条目。
    去重结果直接写回 entities 表。
    """
    db = CoreStorage()
    try:
        entities = db.get_all_entities()
        total_removed = 0

        for entity in entities:
            # 跳过非 NPC 实体
            if entity.get("entity_type", "npc") != "npc":
                continue

            traits = entity.get("ontology_traits", {})
            if not traits:
                continue

            # ontology_traits 结构示例: {"性格": [{"content": "温柔", "confidence": 0.9}, ...], ...}
            deduped_traits = {}
            entity_removed = 0

            for category, trait_list in traits.items():
                if not isinstance(trait_list, list):
                    deduped_traits[category] = trait_list
                    continue

                # 按 content 去重，保留 confidence 最高的
                seen = {}
                for t in trait_list:
                    if not isinstance(t, dict):
                        continue
                    content = t.get('content', '')
                    if not content:
                        continue
                    confidence = t.get('confidence', 0)
                    if content not in seen or confidence > seen[content].get('confidence', 0):
                        seen[content] = t

                original_count = len(trait_list)
                deduped_list = list(seen.values())
                removed = original_count - len(deduped_list)
                entity_removed += removed
                deduped_traits[category] = deduped_list

            total_removed += entity_removed

            if entity_removed > 0:
                db.update_ontology_traits(entity["entity_id"], deduped_traits)
                npc_name = entity.get("name", entity.get("slug", entity["entity_id"]))
                logger.info(f"  🧹 {npc_name}: 去重 {entity_removed} 条")

        return total_removed
    finally:
        db.close()
