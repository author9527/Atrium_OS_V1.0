#!/usr/bin/env python3
"""
Atrium OS - 智能实体管理器
负责实体唯一化、上下文消歧、别名管理
存储后端：CoreStorage (core_storage.db)
"""
import uuid
from datetime import datetime
from typing import List, Dict, Optional, Tuple
import re
from server.logger import logger

from core_storage import CoreStorage


class EntityManager:
    """
    智能实体管理器
    - 使用 UUID 确保每个实体唯一
    - 自动收集上下文特征用于消歧
    - 管理别名映射
    - 支持上下文消歧和交互式确认
    - 存储后端：CoreStorage (SQLite)
    """

    def __init__(self):
        self._storage = CoreStorage()
        self._entities = self._load_entities()

    def _load_entities(self) -> Dict:
        """从 CoreStorage 加载全部实体，转为内存字典格式"""
        try:
            rows = self._storage.get_all_entities()
        except Exception:
            rows = []

        entities: Dict[str, Dict] = {}
        for row in rows:
            entity_id = row["entity_id"]
            # ontology_traits 中存放 EntityManager 专有字段
            traits = row.get("ontology_traits") or {}
            entity = {
                "entity_id": entity_id,
                "canonical_name": row.get("name", ""),
                "appearance_history": traits.get("appearance_history", [row.get("name", "")]),
                "disambiguation_keys": traits.get("disambiguation_keys", []),
                "relationship_context": traits.get("relationship_context", {}),
                "created_at": row.get("created_at", datetime.now().isoformat()),
                "last_mentioned": row.get("meta_last_interact_date", row.get("created_at", "")),
                "mention_count": traits.get("mention_count", 1),
            }
            entities[entity_id] = entity
        return {"entities": entities, "version": "1.0"}

    def _persist_entity(self, entity_id: str):
        """将单个实体写入 CoreStorage"""
        entity = self._entities["entities"].get(entity_id)
        if not entity:
            return

        # 将 EntityManager 专有字段打包进 ontology_traits
        ontology_traits = {
            "appearance_history": entity.get("appearance_history", []),
            "disambiguation_keys": entity.get("disambiguation_keys", []),
            "relationship_context": entity.get("relationship_context", {}),
            "mention_count": entity.get("mention_count", 1),
        }

        try:
            self._storage.upsert_entity(
                entity_id=entity_id,
                name=entity["canonical_name"],
                slug=entity_id,
                ontology_traits=ontology_traits,
            )
        except Exception:
            pass

    def _normalize_name(self, name: str) -> str:
        """标准化名字：小写、去空格"""
        return name.strip().lower()

    def _generate_uuid(self) -> str:
        """生成短 UUID"""
        return uuid.uuid4().hex[:12]

    # ==================== 核心功能 ====================

    def register_entity(self, name: str, initial_context: str = "") -> str:
        """
        注册新实体
        - 如果已存在同名实体，自动合并或创建新实体
        - 返回实体的 UUID
        """
        norm_name = self._normalize_name(name)

        # 检查是否已存在该名字的实体
        existing = self._find_entity_by_name(name)
        if existing:
            return existing["entity_id"]

        # 创建新实体
        entity_id = self._generate_uuid()
        entity = {
            "entity_id": entity_id,
            "canonical_name": name,
            "appearance_history": [name],
            "disambiguation_keys": self._extract_context_features(initial_context),
            "relationship_context": {},
            "created_at": datetime.now().isoformat(),
            "last_mentioned": datetime.now().isoformat(),
            "mention_count": 1
        }

        self._entities["entities"][entity_id] = entity
        self._persist_entity(entity_id)

        logger.info(f"✅ 注册新实体: {name} (ID: {entity_id})")
        return entity_id

    def add_mention(self, name: str, context: str = "", relation_to_user: str = "") -> str:
        """
        添加实体提及
        - 自动识别或创建实体
        - 更新上下文特征和别名
        - 返回实体 ID
        """
        norm_name = self._normalize_name(name)

        # 查找现有实体
        entity = self._find_entity_by_name(name)

        if entity:
            entity_id = entity["entity_id"]
            entity["last_mentioned"] = datetime.now().isoformat()
            entity["mention_count"] += 1

            # 更新上下文特征
            new_features = self._extract_context_features(context)
            entity["disambiguation_keys"] = list(set(entity["disambiguation_keys"] + new_features))

            # 记录关系
            if relation_to_user:
                entity["relationship_context"]["与用户的关系"] = relation_to_user

            # 添加别名（如果新出现）
            if name not in entity["appearance_history"]:
                entity["appearance_history"].append(name)

            self._persist_entity(entity_id)
            return entity_id

        # 创建新实体
        return self.register_entity(name, context)

    # 矛盾特征组合（同一个实体不太可能同时拥有）
    CONTRADICTION_PAIRS = [
        # 考研相关 vs 学生年龄
        ("考研/考公", "小学生"),
        ("考研/考公", "初中生"),
        ("考研/考公", "高中生"),
        ("大学生", "小学生"),
        ("大学生", "初中生"),
        # 养宠物相关 vs 小孩
        ("养宠物", "小学生"),
        ("养宠物", "初中生"),
        # 工作狂 vs 学生
        ("工作狂", "小学生"),
        ("工作狂", "初中生"),
        ("工作狂", "高中生"),
        ("工作狂", "大学生"),
        # 强迫症相关 vs 小孩
        ("强迫症", "小学生"),
        ("强迫症", "7岁"),
    ]

    def disambiguate(self, name: str, context: str = "") -> Tuple[Optional[str], List[Dict], str]:
        """
        消歧实体
        - 如果只有一个匹配，返回该实体
        - 如果多个匹配，根据上下文消歧
        - 如果上下文特征与现有实体矛盾，询问用户确认

        返回: (entity_id, candidates, clarification_message)
        """
        norm_name = self._normalize_name(name)

        # 查找所有可能的实体
        candidates = self._find_candidates_by_name(name)

        if len(candidates) == 0:
            # 没有匹配，创建新实体
            new_id = self.register_entity(name, context)
            return new_id, [], ""

        # 提取上下文特征
        context_features = self._extract_context_features(context)

        # 如果有上下文特征，检查是否与现有实体矛盾
        if context_features and len(candidates) == 1:
            entity = candidates[0]
            entity_features = set(entity.get("disambiguation_keys", []))
            context_set = set(context_features)

            # 检查是否有矛盾
            has_contradiction = self._check_contradiction(entity_features, context_set)

            if has_contradiction:
                # 有矛盾，返回候选列表让用户确认
                clarification = f"检测到上下文存在差异：\n"
                clarification += f"【{entity['canonical_name']}】已知特征: {', '.join(entity_features) if entity_features else '无'}\n"
                clarification += f"【当前提到】的特征: {', '.join(context_set)}\n"
                clarification += f"请确认你说的是不是另一个人？"
                return None, candidates, clarification

        if len(candidates) == 1:
            # 唯一匹配
            return candidates[0]["entity_id"], [], ""

        # 多个匹配，需要消歧
        scored_candidates = []
        for candidate in candidates:
            score = self._calculate_context_score(candidate, context_features)
            scored_candidates.append((candidate, score))

        scored_candidates.sort(key=lambda x: x[1], reverse=True)

        best_match = scored_candidates[0]

        if len(scored_candidates) > 1:
            if best_match[1] > scored_candidates[1][1]:
                return best_match[0]["entity_id"], [], []

        clarification = self._generate_clarification_message(candidates, context)
        return None, candidates, clarification

    def _check_contradiction(self, entity_features: set, context_features: set) -> bool:
        """检查特征是否有矛盾"""
        for feat1, feat2 in self.CONTRADICTION_PAIRS:
            if feat1 in entity_features and feat2 in context_features:
                return True
            if feat2 in entity_features and feat1 in context_features:
                return True

        # 检查数字年龄的矛盾
        for feat in context_features:
            if feat.endswith("岁"):
                try:
                    age = int(feat.replace("岁", ""))
                    # 如果实体有考研/大学生特征，但提到的是小孩年龄
                    if age < 15:
                        if "考研/考公" in entity_features or "大学生" in entity_features:
                            return True
                except ValueError:
                    pass

        return False

    def _find_entity_by_name(self, name: str) -> Optional[Dict]:
        """通过名字查找实体（包括别名）"""
        norm_name = self._normalize_name(name)

        for entity in self._entities["entities"].values():
            if self._normalize_name(entity["canonical_name"]) == norm_name:
                return entity
            for alias in entity.get("appearance_history", []):
                if self._normalize_name(alias) == norm_name:
                    return entity

        return None

    def _find_candidates_by_name(self, name: str) -> List[Dict]:
        """查找所有名字相似的实体（用于消歧）"""
        norm_name = self._normalize_name(name)
        candidates = []

        for entity in self._entities["entities"].values():
            # 检查规范名
            if self._normalize_name(entity["canonical_name"]) == norm_name:
                candidates.append(entity)
                continue

            # 检查所有别名
            for alias in entity.get("appearance_history", []):
                if self._normalize_name(alias) == norm_name:
                    if entity not in candidates:
                        candidates.append(entity)
                    break

        return candidates

    def _extract_context_features(self, text: str) -> List[str]:
        """从文本中提取上下文特征词"""
        if not text:
            return []

        # 特征词列表
        features = []

        # 关系词
        relation_patterns = [
            (r"(爸|父亲|老爹|爸比)", "家人"),
            (r"(妈|母亲|老妈|妈咪)", "家人"),
            (r"(哥|兄|哥哥|哥子)", "兄弟"),
            (r"(姐|姐姐|姐子)", "姐妹"),
            (r"(室[1-6]|[1-6]室)", "室友"),
            (r"(同事|同事们|同事的)", "同事"),
            (r"(客户|甲方|乙方)", "客户"),
            (r"(老板|上司|领导)", "上司"),
            (r"(男朋|女友|对象|老婆|老公)", "恋人"),
        ]

        for pattern, label in relation_patterns:
            if re.search(pattern, text):
                features.append(label)

        # 行为特征
        behavior_patterns = [
            (r"(考研|考公|考编|备考)", "考研/考公"),
            (r"(签单|签合同|谈客户)", "销售/商务"),
            (r"(加班|996|工作忙)", "工作狂"),
            (r"(生病|住院|看医生)", "健康问题"),
            (r"(猫|狗狗|宠物)", "养宠物"),
        ]

        for pattern, label in behavior_patterns:
            if re.search(pattern, text):
                features.append(label)

        # 特质描述
        trait_patterns = [
            (r"(强迫症|洁癖|整齐)", "强迫症"),
            (r"(路痴|迷路|不分东南西北)", "路痴"),
            (r"(内向|社恐|害羞)", "内向"),
            (r"(外向|开朗|活泼)", "外向"),
            (r"(迟到|拖延|磨蹭)", "爱迟到"),
        ]

        for pattern, label in trait_patterns:
            if re.search(pattern, text):
                features.append(label)

        # 年龄特征
        age_patterns = [
            (r"(\d+岁)", lambda m: m.group(1)),
            (r"(小学生|小学|一年级|二年级|三年级|四年级|五年级|六年级)", "小学生"),
            (r"(初中生|初中|初一|初二|初三)", "初中生"),
            (r"(高中生|高中|高一|高二|高三)", "高中生"),
            (r"(大学生|大学|大一|大二|大三大四|研究生)", "大学生"),
        ]

        for pattern, label in age_patterns:
            match = re.search(pattern, text)
            if match:
                if callable(label):
                    features.append(label(match))
                else:
                    features.append(label)

        return list(set(features))

    def _calculate_context_score(self, entity: Dict, context_features: List[str]) -> int:
        """计算上下文匹配分数"""
        if not context_features:
            return entity.get("mention_count", 0)

        entity_features = set(entity.get("disambiguation_keys", []))
        context_set = set(context_features)

        # 匹配的特征数
        matched = len(entity_features & context_set)

        # 考虑提及次数作为辅助
        mention_boost = min(entity.get("mention_count", 0) / 10, 1)

        return matched + mention_boost

    def _generate_clarification_message(self, candidates: List[Dict], context: str) -> str:
        """生成消歧提示信息"""
        if not candidates:
            return ""

        msg = "我找到多个可能的匹配，请确认你说的是哪一位：\n"
        for i, c in enumerate(candidates, 1):
            features = c.get("disambiguation_keys", [])[:3]
            relation = c.get("relationship_context", {}).get("与用户的关系", "未知关系")
            msg += f"{i}. **{c['canonical_name']}** - {relation}"
            if features:
                msg += f"（{', '.join(features)}）"
            msg += "\n"

        return msg

    # ==================== 辅助功能 ====================

    def get_entity_by_id(self, entity_id: str) -> Optional[Dict]:
        """通过 UUID 获取实体"""
        return self._entities["entities"].get(entity_id)

    def get_all_entities(self) -> List[Dict]:
        """获取所有实体"""
        return list(self._entities["entities"].values())

    def get_entity_by_uuid(self, entity_id: str) -> Optional[Dict]:
        """通过 UUID 获取实体（兼容旧代码）"""
        return self.get_entity_by_id(entity_id)

    def get_entity_folder_name(self, name: str, context: str = "") -> str:
        """
        获取实体的文件夹名
        - 返回 entity_id（slug 格式）
        """
        entity_id, _, clarification = self.disambiguate(name, context)

        if entity_id:
            return entity_id

        # 新实体
        new_id = self.register_entity(name, context)
        return new_id

    def needs_clarification(self, name: str) -> Tuple[bool, str]:
        """
        检查是否需要用户确认
        返回: (needs_clarification, clarification_message)
        """
        candidates = self._find_candidates_by_name(name)

        if len(candidates) <= 1:
            return False, ""

        clarification = self._generate_clarification_message(candidates, "")
        return True, clarification

    def resolve_ambiguity(self, name: str, selected_index: int) -> Optional[str]:
        """
        用户选择后解析歧义
        - selected_index: 用户选择的序号（从1开始）
        """
        candidates = self._find_candidates_by_name(name)

        if 0 < selected_index <= len(candidates):
            selected_entity = candidates[selected_index - 1]
            self.add_mention(name, "", selected_entity.get("relationship_context", {}).get("与用户的关系", ""))
            return selected_entity["entity_id"]

        return None


# 全局单例
_entity_manager = None

def get_entity_manager() -> EntityManager:
    """获取全局实体管理器单例"""
    global _entity_manager
    if _entity_manager is None:
        _entity_manager = EntityManager()
    return _entity_manager


if __name__ == "__main__":
    # 测试代码
    em = EntityManager()

    # 测试注册
    print("=== 测试实体注册 ===")
    id1 = em.add_mention("林林", "大学室友，正在考研，喜欢猫", "室友")
    id2 = em.add_mention("林林", "销售，签了个大单，周末加班", "同事")

    print(f"\n=== 测试消歧 ===")
    entity_id, candidates, msg = em.disambiguate("林林", "考研")
    if entity_id:
        entity = em.get_entity_by_id(entity_id)
        print(f"匹配到: {entity['canonical_name']} (ID: {entity_id})")
        print(f"特征: {entity['disambiguation_keys']}")

    # 测试别名
    print(f"\n=== 测试别名 ===")
    em.add_mention("小林", "昨晚一起看周杰伦演唱会", "朋友")

    entity = em.get_entity_by_id(id1)
    print(f"林林的别名: {entity['appearance_history']}")