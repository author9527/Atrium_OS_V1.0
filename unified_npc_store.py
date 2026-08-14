"""
Atrium OS 统一 NPC 数据存储

数据来源：core_storage.db (CoreStorage)
通过 CoreStorage 的 entities 表查询所有 NPC 实体，
ontology_traits 字段存储结构化人设维度，
entity_summary 字段存储实体摘要。
"""

import re
from typing import List, Dict, Optional
from core_storage import CoreStorage


class UnifiedNPCStore:
    """统一 NPC 数据存储 — 基于 CoreStorage"""

    # 需要跳过的实体名（自我指代 / 泛指代词）
    _SKIP_NAMES = frozenset({
        '用户', '我', '自己', '本人', 'User', 'Me',
        'user', 'me',
    })

    def __init__(self, root_dir: str = '.', db_path: str = None):
        self.root_dir = root_dir
        self._storage = CoreStorage(db_path=db_path)
        self._cache: Dict[str, dict] = {}
        self._load_cache()

    # ------------------------------------------------------------------
    # 内部方法
    # ------------------------------------------------------------------

    def _load_cache(self):
        """从 CoreStorage 加载 NPC 缓存"""
        self._cache = {}
        entities = self._storage.get_all_entities()
        for ent in entities:
            name: str = ent.get("name", "")
            if not name or name in self._SKIP_NAMES:
                continue
            # 解析 ontology_traits → traits / traits_text / traits_structured
            ontology = ent.get("ontology_traits") or {}
            traits_raw = ontology.get("traits", [])
            # traits_raw 可能是 list[dict] 或 list[str]
            traits: list = []
            if isinstance(traits_raw, list):
                traits = traits_raw

            traits_text = self._build_traits_text(traits)
            traits_structured = self._build_traits_structured(traits)

            # 从 relation_cache 统计 interaction_count（共享事件数）
            entity_id = ent.get("entity_id", "")
            interaction_count = self._count_interactions(entity_id)

            self._cache[name] = {
                'name': name,
                'entity_id': entity_id,
                'slug': ent.get("slug", ""),
                'traits': traits,
                'relationships': [],
                'interaction_count': interaction_count,
                'traits_text': traits_text,
                'traits_structured': traits_structured,
                'relationships_text': [],
                'entity_summary': ent.get("entity_summary", ""),
            }

    @staticmethod
    def _build_traits_text(traits: list) -> List[str]:
        """取最近 5 条特质，本地化关键词"""
        mapping = {
            'has_habit': '习惯',
            'believes_in': '相信',
            'sensitive_to': '在意',
            'strives_for': '追求',
            'knows': '认识',
        }

        def localize(content: str) -> str:
            for en, zh in mapping.items():
                content = content.replace(en + ':', zh + '：')
                content = content.replace(en + ' ', zh + ' ')
            return content

        result: List[str] = []
        for t in traits[-5:]:
            if isinstance(t, dict):
                result.append(localize(t.get("content", "")))
            elif isinstance(t, str):
                result.append(localize(t))
        return result

    @staticmethod
    def _build_traits_structured(traits: list) -> list:
        """解析结构化人设维度"""
        structured: list = []
        for t in traits:
            if not isinstance(t, dict):
                continue
            trait_item: dict = {
                "content": t.get("content", ""),
                "confidence": t.get("confidence", 0.5),
            }
            # 解析 type 字段（如 "emotion.emotion_type"）
            trait_type = t.get("type", "")
            if trait_type and "." in trait_type:
                parts = trait_type.split(".")
                trait_item["dimension"] = parts[0]
                trait_item["sub_key"] = parts[1] if len(parts) > 1 else ""
            else:
                # 尝试从 content 解析
                content = t.get("content", "")
                if ":" in content or "\uff1a" in content:
                    m = re.match(r"([a-zA-Z_]+\.[a-zA-Z_]+)[\uff1a:]\s*(.+)", content)
                    if m:
                        type_part = m.group(1)
                        trait_item["dimension"] = type_part.split(".")[0]
                        trait_item["sub_key"] = (
                            type_part.split(".")[1] if "." in type_part else ""
                        )
                        trait_item["content"] = m.group(2)
            structured.append(trait_item)
        return structured

    def _count_interactions(self, entity_id: str) -> int:
        """统计该实体的互动次数（事件中心已废弃，entities 表不再派生事件，返回 0）"""
        return 0

    # ------------------------------------------------------------------
    # 公开接口（保持契约不变，供 empathy_agent.py 调用）
    # ------------------------------------------------------------------

    def get_npc_list(self) -> List[str]:
        """获取所有 NPC 名称列表"""
        return list(self._cache.keys())

    def get_npc_info(self, npc_name: str) -> Dict:
        """获取 NPC 详细信息"""
        cached = self._cache.get(npc_name)
        if cached:
            return cached
        # 缓存未命中 → 尝试通过 slug 实时查询
        slug = npc_name  # slug 通常是 name 的小写/规范化形式
        ent = self._storage.get_entity_by_slug(slug)
        if ent:
            return self._entity_to_info(ent)
        return {
            "name": npc_name,
            "traits": [],
            "relationships": [],
            "interaction_count": 0,
            "traits_text": [],
            "traits_structured": [],
            "relationships_text": [],
        }

    def get_npc_summary(self) -> Dict:
        """获取所有 NPC 概览"""
        npcs: list = []
        for name, info in self._cache.items():
            npcs.append({
                "name": name,
                "interaction_count": info["interaction_count"],
                "traits": info["traits_text"],
            })
        return {
            "npc_count": len(npcs),
            "npcs": npcs,
            "total_interactions": sum(n["interaction_count"] for n in npcs),
        }

    def refresh_cache(self):
        """刷新缓存（从 core_storage 重新加载）"""
        self._load_cache()

    # ------------------------------------------------------------------
    # 辅助
    # ------------------------------------------------------------------

    def _entity_to_info(self, ent: dict) -> dict:
        """将 CoreStorage 实体记录转为 get_npc_info 返回格式"""
        ontology = ent.get("ontology_traits") or {}
        traits = ontology.get("traits", [])
        if isinstance(traits, list):
            pass
        else:
            traits = []
        entity_id = ent.get("entity_id", "")
        return {
            "name": ent.get("name", ""),
            "entity_id": entity_id,
            "slug": ent.get("slug", ""),
            "traits": traits,
            "relationships": [],
            "interaction_count": self._count_interactions(entity_id),
            "traits_text": self._build_traits_text(traits),
            "traits_structured": self._build_traits_structured(traits),
            "relationships_text": [],
            "entity_summary": ent.get("entity_summary", ""),
        }


if __name__ == "__main__":
    store = UnifiedNPCStore()
    print("=== 统一 NPC 存储测试 ===")
    print(f"NPC列表: {store.get_npc_list()}")
    print()
    summary = store.get_npc_summary()
    print(f"NPC总数: {summary['npc_count']}")
    print(f"总互动次数: {summary['total_interactions']}")
    print()
    for npc in summary["npcs"]:
        print(f"{npc['name']}: {npc['interaction_count']}次互动")
        if npc["traits"]:
            print(f"  特质: {npc['traits'][:2]}")
