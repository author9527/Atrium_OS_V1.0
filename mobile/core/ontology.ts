/**
 * ontology.ts — 手机端数字化人格本体论（Persona Ontology）（TypeScript 重写）
 *
 * 逐字等价复刻 Python 版 ai/ontology.py：
 *  - 五个核心维度（核心身份/社会力学/心理防线/生活图谱/动态切片）
 *  - 终极人格全景图 AtriumPersonaSchema
 *  - KGMem 增量补丁的实体/关系类型映射
 *  - 日记提取 Schema（DiaryExtractionSchema）
 *
 * 说明：Python 用 Pydantic 强校验；手机端用 TS interface + 运行时兜底函数保持等价行为。
 */

// ----------------- 维度 1: 核心身份 (Core Identity) -----------------
export interface CoreIdentity {
  /** 姓名、性别、种族、籍贯、年龄等基础事实 */
  basic: Record<string, unknown>;
  /** 核心价值观：如自由、诚实、家庭、金钱至上等 */
  values: string[];
  /** 核心创伤：深刻改变认知的过往事件 */
  traumas: string[];
  /** 长期愿景：死前想实现的 3-5 件事 */
  long_term_goals: string[];
}

// ----------------- 维度 2: 社会力学 (Social Dynamics) -----------------
export interface SocialCircle {
  /** 圈子名称，如'公司'、'球友'、'家人' */
  group_name: string;
  /** 该圈子内的核心成员 */
  npc_ids: string[];
  /** 本人在该圈子中的权力位阶：如'主导'、'边缘'、'追随者' */
  power_dynamic: string;
}

export interface Relationship {
  target_name: string;
  /** 动态类型，由 AI 增补 */
  relation_type: string;
  /** 好感度/亲密度 (-1.0 到 1.0) */
  affinity: number;
  /** 一段文字描述双方最深刻的纽带 */
  deep_connection: string;
}

// ----------------- 维度 3: 心理防线与心智模型 (Psychology & Cognition) -----------------
export interface MindModel {
  /** 人格类型 */
  mbti?: string | null;
  /** 依恋类型：安全型、焦虑型、回避型等 */
  attachment_style?: string | null;
  /** 自尊规则/雷区：如'讨厌被建议'、'渴望被崇拜' */
  ego_rules: string[];
  /** 常见的认知偏差：如'过度自卑'、'幸存者偏差' */
  cognitive_bias: string[];
}

// ----------------- 维度 4: 生活图谱 (Lifestyle Patterns) -----------------
export interface Lifestyle {
  hobbies: string[];
  /** 典型的一天：如'7点起床跑步'等 */
  routines: Record<string, string>;
  /** 细小的偏好：饮食忌口、穿搭风格、消费层级 */
  preferences: Record<string, unknown>;
}

// ----------------- 维度 5: 动态切片 (Temporal States) -----------------
export interface CurrentState {
  /** 精力值 1-100 */
  energy_level: number;
  health_status: string;
  /** 当前最迫切的需要：如'渴望休息'、'想证明自己' */
  primary_need: string;
}

// ==========================================
// 本体自动进化协议 (Evolutionary Mechanism)
// ==========================================
export type TargetDimension = 'Identity' | 'Social' | 'Psychology' | 'Lifestyle' | 'Temporal';

export interface FacetDiscovery {
  is_new_facet: boolean;
  target_dimension: TargetDimension;
  /** 建议增加的字段名 */
  proposed_field_name: string;
  /** 建议的数据类型 */
  suggested_type: string;
  /** 为什么要增加这一项的原因 */
  rationale: string;
}

// ==========================================
// 终极人格全景图 (Persona Panoramic View)
// ==========================================
export interface AtriumPersonaSchema {
  last_updated: string;
  identity: CoreIdentity;
  social: SocialCircle[];
  relationships: Relationship[];
  psychology: MindModel;
  lifestyle: Lifestyle;
  state: CurrentState;
  /** 动态增补区：存放以后 AI 自动发现的新人格侧面 */
  extended_facets: Record<string, unknown>;
  /** 进化建议 */
  evolution_proposal: FacetDiscovery | null;
}

/** 将 AI 提议的新侧面正式归档到动态增补区。 */
export function consolidateNewFacet(schema: AtriumPersonaSchema, proposedName: string, value: unknown): void {
  schema.extended_facets[proposedName] = value;
}

// ==========================================
// 增量补丁：对接 KGMem 引擎 (Additive Only)
// ==========================================

export class EntityType {
  name: string;
  context: string;
  constructor(name: string, context: string = '') {
    this.name = name;
    this.context = context;
  }
}

export class RelationType {
  name: string;
  entity_type0: EntityType;
  entity_type1: EntityType;
  constructor(name: string, entity0: EntityType, entity1: EntityType, context: string = '') {
    this.name = name;
    this.entity_type0 = entity0;
    this.entity_type1 = entity1;
  }
}

export class Ontology {
  entity_types: EntityType[];
  relation_types: RelationType[];
  query_types: unknown[];
  constructor(entityTypes: EntityType[], relationTypes: RelationType[], queryTypes: unknown[] = []) {
    this.entity_types = entityTypes;
    this.relation_types = relationTypes;
    this.query_types = queryTypes;
  }
}

// 1. 实体映射
export const userType = new EntityType('User', '我是谁');
export const npcType = new EntityType('NPC', '认识的人');
export const valueType = new EntityType('Value', '核心观念');
export const traumaType = new EntityType('Trauma', '心理阴影');
export const ruleType = new EntityType('Rule', '行为准则');
export const prefType = new EntityType('Habit', '生活习性');

// 2. 关系映射
export const believesIn = new RelationType('believes_in', userType, valueType);
export const avoidsDueTo = new RelationType('avoids_due_to', userType, traumaType);
export const sensitiveTo = new RelationType('sensitive_to', userType, ruleType);
export const hasHabit = new RelationType('has_habit', userType, prefType);
export const knows = new RelationType('knows', userType, npcType);

export const atriumPersonaOntology = new Ontology(
  [userType, npcType, valueType, traumaType, ruleType, prefType],
  [believesIn, avoidsDueTo, sensitiveTo, hasHabit, knows],
  [],
);

// 关系类型常量（供三元组映射与 KGMem 使用）
export const RELATION_NAMES = {
  believes_in: 'believes_in',
  avoids_due_to: 'avoids_due_to',
  sensitive_to: 'sensitive_to',
  has_habit: 'has_habit',
  knows: 'knows',
} as const;

// ==========================================
// 日记提取 Schema (DiaryExtractionSchema)
// ==========================================

export interface EntityTrait {
  /** 维度名称，如 knowledge, emotion, social_style */
  dimension: string;
  /** 子属性键，如 education, emotion_type */
  sub_key: string;
  /** 特质内容描述 */
  content: string;
  /** 置信度 0-1 */
  confidence: number;
}

export interface ExtractedEntity {
  /** 实体名称 */
  name: string;
  /** 实体类型：NPC, User, Value, Habit 等 */
  type: string;
  /** 特质列表 */
  traits: EntityTrait[];
  /** 兼容旧代码的可选属性 */
  properties?: Record<string, unknown>;
}

export interface ExtractedRelation {
  /** 源实体名称 */
  from: string;
  /** 目标实体名称 */
  to: string;
  /** 关系类型 */
  type: string;
  /** 关系描述 */
  relation: string;
  /** 情感变化 */
  sentiment_delta: number;
}

export interface DiaryExtractionSchema {
  /** 提取的实体列表 */
  entities: ExtractedEntity[];
  /** 提取的关系列表 */
  relations: ExtractedRelation[];
  /** 情感分析结果 */
  emotions: Record<string, number>;
  /** 内容摘要 */
  summary: string;
  /** 整体情绪变化 */
  sentiment_delta: number;
  /** 关键事件列表 */
  key_events: string[];
}

/** 构造一个空白的日记提取结果（对应 Python 兜底返回）。 */
export function emptyExtraction(): DiaryExtractionSchema {
  return { entities: [], relations: [], emotions: {}, summary: '', sentiment_delta: 0.0, key_events: [] };
}