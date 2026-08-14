from pydantic import BaseModel, Field, create_model
from typing import List, Literal, Optional, Dict, Any, Union
from datetime import datetime

# ==========================================
# 心房 / Atrium OS - 数字化人格本体论 (Persona Ontology)
# 愿景：通过五个核心维度及其延伸，实现对"人"的完整数字化映射
# ==========================================

# ----------------- 维度 1: 核心身份 (Core Identity) -----------------
class CoreIdentity(BaseModel):
    """人的底层基石：是什么定义了'我'"""
    basic: Dict[str, Any] = Field(description="姓名、性别、种族、籍贯、年龄等基础事实")
    values: List[str] = Field(description="核心价值观：如自由、诚实、家庭、金钱至上等")
    traumas: List[str] = Field(description="核心创伤：深刻改变认知的过往事件，决定了避风港和雷区")
    long_term_goals: List[str] = Field(description="长期愿景：死前想实现的 3-5 件事")

# ----------------- 维度 2: 社会力学 (Social Dynamics) -----------------
class SocialCircle(BaseModel):
    """描述一个人身处的社会网络"""
    group_name: str = Field(description="圈子名称，如'公司'、'球友'、'家人'")
    npc_ids: List[str] = Field(description="该圈子内的核心成员")
    power_dynamic: str = Field(description="本人在该圈子中的权力位阶：如'主导'、'边缘'、'追随者'")

class Relationship(BaseModel):
    """每一根社会连线的精细度量"""
    target_name: str
    relation_type: str # 动态类型，由 AI 增补
    affinity: float = Field(description="好感度/亲密度 (-1.0 到 1.0)")
    deep_connection: str = Field(description="一段文字描述双方最深刻的纽带")

# ----------------- 维度 3: 心理防线与心智模型 (Psychology & Cognition) -----------------
class MindModel(BaseModel):
    """决定了人对信息的处理方式（你的'理中客'防御就在这里）"""
    mbti: Optional[str] = Field(description="人格类型")
    attachment_style: Optional[str] = Field(description="依恋类型：安全型、焦虑型、回避型等")
    ego_rules: List[str] = Field(description="自尊规则/雷区：如'讨厌被建议'、'渴望被崇拜'")
    cognitive_bias: List[str] = Field(description="常见的认知偏差：如'过度自卑'、'幸存者偏差'")

# ----------------- 维度 4: 生活图谱 (Lifestyle Patterns) -----------------
class Lifestyle(BaseModel):
    """刻入肌肉的日常"""
    hobbies: List[str]
    routines: Dict[str, str] = Field(description="典型的一天：如'7点起床跑步'等")
    preferences: Dict[str, Any] = Field(description="细小的偏好：饮食忌口、穿搭风格、消费层级")

# ----------------- 维度 5: 动态切片 (Temporal States) -----------------
class CurrentState(BaseModel):
    """此时此刻"""
    energy_level: int = Field(description="精力值 1-100")
    health_status: str
    primary_need: str = Field(description="当前最迫切的需要：如'渴望休息'、'想证明自己'")

# ==========================================
# 本体自动进化协议 (Evolutionary Mechanism)
# ==========================================
class FacetDiscovery(BaseModel):
    """
    当现有框架无法容纳新信息时，AI 触发此增补机制
    例如：用户提到"我是跨性别者"，若 Identity 中无此项，则提出增补。
    """
    is_new_facet: bool = Field(default=False)
    target_dimension: Literal["Identity", "Social", "Psychology", "Lifestyle", "Temporal"]
    proposed_field_name: str = Field(description="建议增加的字段名")
    suggested_type: str = Field(description="建议的数据类型")
    rationale: str = Field(description="为什么要增加这一项的原因")

# ==========================================
# 终极人格全景图 (Persona Panoramic View)
# ==========================================
class AtriumPersonaSchema(BaseModel):
    """
    Atrium OS - 数字化生命全书
    这是系统对"一个人"最完整的理解
    """
    last_updated: datetime = Field(default_factory=datetime.now)
    
    identity: CoreIdentity
    social: List[SocialCircle]
    relationships: List[Relationship]
    psychology: MindModel
    lifestyle: Lifestyle
    state: CurrentState
    
    # 自动增补区 (由 AI 动态填充未在上述静态类中定义的属性)
    extended_facets: Dict[str, Any] = Field(
        default_factory=dict, 
        description="动态增补区：存放以后 AI 自动发现的新人格侧面"
    )
    
    # 进化建议
    evolution_proposal: Optional[FacetDiscovery] = None

    def consolidate_new_facet(self, proposed_name: str, value: Any):
        """将 AI 提议的新侧面正式归档到动态增补区"""
        self.extended_facets[proposed_name] = value

# ==========================================
# 增量补丁：对接 KGMem 引擎 (Additive Only)
# ==========================================
import os
import sys

# 注入 kg_mem 组件
sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "kg_mem"))
try:
    from kg_mem import EntityType, RelationType, Ontology
except ImportError:
    class EntityType:
        def __init__(self, name, context=""): self.name = name; self.context = context
    class RelationType:
        def __init__(self, name, entity_type0, entity_type1, context=""): 
            self.name = name; self.entity_type0 = entity_type0; self.entity_type1 = entity_type1
    class Ontology:
        def __init__(self, entity_types, relation_types, query_types=[]):
            self.entity_types = entity_types; self.relation_types = relation_types

# 1. 实体映射
user_type = EntityType(name="User", context="我是谁")
npc_type = EntityType(name="NPC", context="认识的人")
value_type = EntityType(name="Value", context="核心观念")
trauma_type = EntityType(name="Trauma", context="心理阴影")
rule_type = EntityType(name="Rule", context="行为准则")
pref_type = EntityType(name="Habit", context="生活习性")

# 2. 关系映射
believes_in = RelationType(name="believes_in", entity_type0=user_type, entity_type1=value_type)
avoids_due_to = RelationType(name="avoids_due_to", entity_type0=user_type, entity_type1=trauma_type)
sensitive_to = RelationType(name="sensitive_to", entity_type0=user_type, entity_type1=rule_type)
has_habit = RelationType(name="has_habit", entity_type0=user_type, entity_type1=pref_type)
knows = RelationType(name="knows", entity_type0=user_type, entity_type1=npc_type)

atrium_persona_ontology = Ontology(
    entity_types=[user_type, npc_type, value_type, trauma_type, rule_type, pref_type],
    relation_types=[believes_in, avoids_due_to, sensitive_to, has_habit, knows],
    query_types=[] # 补全缺失的 query_types 列表，修复 Pydantic 检查
)

# ==========================================
# 日记提取 Schema (DiaryExtractionSchema)
# ==========================================
class EntityTrait(BaseModel):
    """单个特质维度"""
    dimension: str = Field(description="维度名称，如 knowledge, emotion, social_style")
    sub_key: str = Field(description="子属性键，如 education, emotion_type")
    content: str = Field(description="特质内容描述")
    confidence: float = Field(default=0.5, description="置信度 0-1")

class ExtractedEntity(BaseModel):
    """提取的实体"""
    name: str = Field(description="实体名称")
    type: str = Field(default="NPC", description="实体类型：NPC, User, Value, Habit 等")
    traits: List[EntityTrait] = Field(default_factory=list, description="特质列表")

class ExtractedRelation(BaseModel):
    """提取的关系"""
    from_entity: str = Field(alias="from", description="源实体名称")
    to_entity: str = Field(alias="to", description="目标实体名称")
    relation_type: str = Field(alias="type", description="关系类型")
    relation: str = Field(default="", description="关系描述")
    sentiment_delta: float = Field(default=0.0, description="情感变化")

    class Config:
        populate_by_name = True

class DiaryExtractionSchema(BaseModel):
    """日记提取结果 Schema"""
    entities: List[ExtractedEntity] = Field(default_factory=list, description="提取的实体列表")
    relations: List[ExtractedRelation] = Field(default_factory=list, description="提取的关系列表")
    emotions: Dict[str, float] = Field(default_factory=dict, description="情感分析结果")
    summary: str = Field(default="", description="内容摘要")
    sentiment_delta: float = Field(default=0.0, description="整体情绪变化")
    key_events: List[str] = Field(default_factory=list, description="关键事件列表")

if __name__ == "__main__":
    # 生成模式报告
    print("========== Atrium OS 数字化生命本体框架 ==========")
    import json
    # 演示该框架的深度
    print(json.dumps(AtriumPersonaSchema.model_json_schema(), indent=2, ensure_ascii=False))
    print(f"✅ 增量映射已就绪，当前图谱维度：{len(atrium_persona_ontology.entity_types)}")