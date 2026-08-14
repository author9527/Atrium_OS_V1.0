/**
 * entityManager.ts — 手机端智能实体管理器（TypeScript 重写）
 *
 * 逐字等价复刻 Python 版 ai/entity_manager.py：
 *  - 实体唯一化、上下文消歧、别名管理
 *  - 存储后端：CoreStorage (core_storage.db)
 */
import { CoreStorage, CoreEntity } from './db/coreStorage';

export interface ManagedEntity {
  entity_id: string;
  canonical_name: string;
  appearance_history: string[];
  disambiguation_keys: string[];
  relationship_context: Record<string, string>;
  created_at: string;
  last_mentioned: string;
  mention_count: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 生成短 UUID（对应 Python uuid.uuid4().hex[:12]）。 */
function shortUuid(): string {
  const hex = [
    Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0'),
    Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0'),
    Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0'),
    Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0'),
  ].join('');
  return hex.slice(0, 12);
}

export class EntityManager {
  private _storage: CoreStorage;
  private _entities: { entities: Record<string, ManagedEntity>; version: string };

  constructor(storage: CoreStorage | null = null) {
    this._storage = storage || new CoreStorage();
    this._entities = this._loadEntities();
  }

  private _loadEntities(): { entities: Record<string, ManagedEntity>; version: string } {
    let rows: CoreEntity[];
    try {
      rows = this._storage.getAllEntities();
    } catch {
      rows = [];
    }

    const entities: Record<string, ManagedEntity> = {};
    for (const row of rows) {
      const entityId = row.entity_id;
      // ontology_traits 中存放 EntityManager 专有字段
      const traits = (row.ontology_traits as Record<string, unknown>) || {};
      const entity: ManagedEntity = {
        entity_id: entityId,
        canonical_name: row.name || '',
        appearance_history: (traits.appearance_history as string[]) || [row.name || ''],
        disambiguation_keys: (traits.disambiguation_keys as string[]) || [],
        relationship_context: (traits.relationship_context as Record<string, string>) || {},
        created_at: row.created_at || nowIso(),
        last_mentioned: row.meta_last_interact_date || row.created_at || '',
        mention_count: (traits.mention_count as number) || 1,
      };
      entities[entityId] = entity;
    }
    return { entities, version: '1.0' };
  }

  private _persistEntity(entityId: string): void {
    const entity = this._entities.entities[entityId];
    if (!entity) return;

    // 将 EntityManager 专有字段打包进 ontology_traits
    const ontologyTraits: Record<string, unknown> = {
      appearance_history: entity.appearance_history,
      disambiguation_keys: entity.disambiguation_keys,
      relationship_context: entity.relationship_context,
      mention_count: entity.mention_count,
    };

    try {
      this._storage.upsertEntity(entityId, entity.canonical_name, entityId, 'npc', ontologyTraits);
    } catch {
      // 忽略持久化失败
    }
  }

  private _normalizeName(name: string): string {
    return (name || '').trim().toLowerCase();
  }

  // ==================== 核心功能 ====================

  /** 注册新实体；已存在同名实体则直接返回其 ID。 */
  registerEntity(name: string, initialContext: string = ''): string {
    const existing = this._findEntityByName(name);
    if (existing) return existing.entity_id;

    // 创建新实体
    const entityId = shortUuid();
    const now = nowIso();
    const entity: ManagedEntity = {
      entity_id: entityId,
      canonical_name: name,
      appearance_history: [name],
      disambiguation_keys: this._extractContextFeatures(initialContext),
      relationship_context: {},
      created_at: now,
      last_mentioned: now,
      mention_count: 1,
    };

    this._entities.entities[entityId] = entity;
    this._persistEntity(entityId);
    return entityId;
  }

  /** 添加实体提及：自动识别或创建实体，更新上下文特征和别名。 */
  addMention(name: string, context: string = '', relationToUser: string = ''): string {
    const entity = this._findEntityByName(name);

    if (entity) {
      const entityId = entity.entity_id;
      entity.last_mentioned = nowIso();
      entity.mention_count += 1;

      // 更新上下文特征
      const newFeatures = this._extractContextFeatures(context);
      entity.disambiguation_keys = Array.from(new Set(entity.disambiguation_keys.concat(newFeatures)));

      // 记录关系
      if (relationToUser) {
        entity.relationship_context['与用户的关系'] = relationToUser;
      }

      // 添加别名（如果新出现）
      if (!entity.appearance_history.includes(name)) {
        entity.appearance_history.push(name);
      }

      this._persistEntity(entityId);
      return entityId;
    }

    // 创建新实体
    return this.registerEntity(name, context);
  }

  // 矛盾特征组合（同一个实体不太可能同时拥有）
  static CONTRADICTION_PAIRS: Array<[string, string]> = [
    // 考研相关 vs 学生年龄
    ['考研/考公', '小学生'],
    ['考研/考公', '初中生'],
    ['考研/考公', '高中生'],
    ['大学生', '小学生'],
    ['大学生', '初中生'],
    // 养宠物相关 vs 小孩
    ['养宠物', '小学生'],
    ['养宠物', '初中生'],
    // 工作狂 vs 学生
    ['工作狂', '小学生'],
    ['工作狂', '初中生'],
    ['工作狂', '高中生'],
    ['工作狂', '大学生'],
    // 强迫症相关 vs 小孩
    ['强迫症', '小学生'],
    ['强迫症', '7岁'],
  ];

  /** 消歧实体。返回 { entityId, candidates, clarificationMessage }。 */
  disambiguate(name: string, context: string = ''): { entityId: string | null; candidates: ManagedEntity[]; clarificationMessage: string } {
    // 查找所有可能的实体
    const candidates = this._findCandidatesByName(name);

    if (candidates.length === 0) {
      // 没有匹配，创建新实体
      const newId = this.registerEntity(name, context);
      return { entityId: newId, candidates: [], clarificationMessage: '' };
    }

    // 提取上下文特征
    const contextFeatures = this._extractContextFeatures(context);

    // 如果有上下文特征，检查是否与现有实体矛盾
    if (contextFeatures.length > 0 && candidates.length === 1) {
      const entity = candidates[0];
      const entityFeatures = new Set(entity.disambiguation_keys || []);
      const contextSet = new Set(contextFeatures);

      // 检查是否有矛盾
      const hasContradiction = this._checkContradiction(entityFeatures, contextSet);

      if (hasContradiction) {
        // 有矛盾，返回候选列表让用户确认
        let clarification = '检测到上下文存在差异：\n';
        clarification += `【${entity.canonical_name}】已知特征: ${entityFeatures.size ? Array.from(entityFeatures).join(', ') : '无'}\n`;
        clarification += `【当前提到】的特征: ${Array.from(contextSet).join(', ')}\n`;
        clarification += '请确认你说的是不是另一个人？';
        return { entityId: null, candidates, clarificationMessage: clarification };
      }
    }

    if (candidates.length === 1) {
      // 唯一匹配
      return { entityId: candidates[0].entity_id, candidates: [], clarificationMessage: '' };
    }

    // 多个匹配，需要消歧
    const scoredCandidates = candidates.map((candidate) => ({
      candidate,
      score: this._calculateContextScore(candidate, contextFeatures),
    }));
    scoredCandidates.sort((a, b) => b.score - a.score);

    const bestMatch = scoredCandidates[0];

    if (scoredCandidates.length > 1) {
      if (bestMatch.score > scoredCandidates[1].score) {
        return { entityId: bestMatch.candidate.entity_id, candidates: [], clarificationMessage: '' };
      }
    }

    const clarification = this._generateClarificationMessage(candidates, context);
    return { entityId: null, candidates, clarificationMessage: clarification };
  }

  private _checkContradiction(entityFeatures: Set<string>, contextFeatures: Set<string>): boolean {
    for (const [feat1, feat2] of EntityManager.CONTRADICTION_PAIRS) {
      if (entityFeatures.has(feat1) && contextFeatures.has(feat2)) return true;
      if (entityFeatures.has(feat2) && contextFeatures.has(feat1)) return true;
    }

    // 检查数字年龄的矛盾
    for (const feat of contextFeatures) {
      if (feat.endsWith('岁')) {
        const age = parseInt(feat.replace('岁', ''), 10);
        if (!Number.isNaN(age) && age < 15) {
          if (entityFeatures.has('考研/考公') || entityFeatures.has('大学生')) {
            return true;
          }
        }
      }
    }

    return false;
  }

  private _findEntityByName(name: string): ManagedEntity | null {
    const normName = this._normalizeName(name);
    for (const entity of Object.values(this._entities.entities)) {
      if (this._normalizeName(entity.canonical_name) === normName) return entity;
      for (const alias of entity.appearance_history || []) {
        if (this._normalizeName(alias) === normName) return entity;
      }
    }
    return null;
  }

  private _findCandidatesByName(name: string): ManagedEntity[] {
    const normName = this._normalizeName(name);
    const candidates: ManagedEntity[] = [];
    for (const entity of Object.values(this._entities.entities)) {
      // 检查规范名
      if (this._normalizeName(entity.canonical_name) === normName) {
        candidates.push(entity);
        continue;
      }
      // 检查所有别名
      for (const alias of entity.appearance_history || []) {
        if (this._normalizeName(alias) === normName) {
          if (!candidates.includes(entity)) candidates.push(entity);
          break;
        }
      }
    }
    return candidates;
  }

  private _extractContextFeatures(text: string): string[] {
    if (!text) return [];
    const features: string[] = [];

    // 关系词
    const relationPatterns: Array<[RegExp, string]> = [
      [/(爸|父亲|老爹|爸比)/, '家人'],
      [/(妈|母亲|老妈|妈咪)/, '家人'],
      [/(哥|兄|哥哥|哥子)/, '兄弟'],
      [/(姐|姐姐|姐子)/, '姐妹'],
      [/(室[1-6]|[1-6]室)/, '室友'],
      [/(同事|同事们|同事的)/, '同事'],
      [/(客户|甲方|乙方)/, '客户'],
      [/(老板|上司|领导)/, '上司'],
      [/(男朋|女友|对象|老婆|老公)/, '恋人'],
    ];
    for (const [pattern, label] of relationPatterns) {
      if (pattern.test(text)) features.push(label);
    }

    // 行为特征
    const behaviorPatterns: Array<[RegExp, string]> = [
      [/(考研|考公|考编|备考)/, '考研/考公'],
      [/(签单|签合同|谈客户)/, '销售/商务'],
      [/(加班|996|工作忙)/, '工作狂'],
      [/(生病|住院|看医生)/, '健康问题'],
      [/(猫|狗狗|宠物)/, '养宠物'],
    ];
    for (const [pattern, label] of behaviorPatterns) {
      if (pattern.test(text)) features.push(label);
    }

    // 特质描述
    const traitPatterns: Array<[RegExp, string]> = [
      [/(强迫症|洁癖|整齐)/, '强迫症'],
      [/(路痴|迷路|不分东南西北)/, '路痴'],
      [/(内向|社恐|害羞)/, '内向'],
      [/(外向|开朗|活泼)/, '外向'],
      [/(迟到|拖延|磨蹭)/, '爱迟到'],
    ];
    for (const [pattern, label] of traitPatterns) {
      if (pattern.test(text)) features.push(label);
    }

    // 年龄特征
    const agePatterns: Array<[RegExp, string]> = [
      [/(\d+岁)/, '$1'],
      [/(小学生|小学|一年级|二年级|三年级|四年级|五年级|六年级)/, '小学生'],
      [/(初中生|初中|初一|初二|初三)/, '初中生'],
      [/(高中生|高中|高一|高二|高三)/, '高中生'],
      [/(大学生|大学|大一|大二|大三大四|研究生)/, '大学生'],
    ];
    for (const [pattern, label] of agePatterns) {
      const match = pattern.exec(text);
      if (match) {
        if (label === '$1') {
          features.push(match[1]);
        } else {
          features.push(label);
        }
      }
    }

    return Array.from(new Set(features));
  }

  private _calculateContextScore(entity: ManagedEntity, contextFeatures: string[]): number {
    if (!contextFeatures.length) {
      return entity.mention_count || 0;
    }
    const entityFeatures = new Set(entity.disambiguation_keys || []);
    const contextSet = new Set(contextFeatures);
    // 匹配的特征数
    let matched = 0;
    for (const f of entityFeatures) if (contextSet.has(f)) matched += 1;
    // 考虑提及次数作为辅助
    const mentionBoost = Math.min((entity.mention_count || 0) / 10, 1);
    return matched + mentionBoost;
  }

  private _generateClarificationMessage(candidates: ManagedEntity[], context: string): string {
    if (!candidates.length) return '';
    let msg = '我找到多个可能的匹配，请确认你说的是哪一位：\n';
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const features = (c.disambiguation_keys || []).slice(0, 3);
      const relation = (c.relationship_context || {})['与用户的关系'] || '未知关系';
      msg += `${i + 1}. **${c.canonical_name}** - ${relation}`;
      if (features.length) {
        msg += `（${features.join(', ')}）`;
      }
      msg += '\n';
    }
    return msg;
  }

  // ==================== 辅助功能 ====================

  getEntityById(entityId: string): ManagedEntity | null {
    return this._entities.entities[entityId] || null;
  }

  getAllEntities(): ManagedEntity[] {
    return Object.values(this._entities.entities);
  }

  getEntityByUuid(entityId: string): ManagedEntity | null {
    return this.getEntityById(entityId);
  }

  /** 获取实体的文件夹名（返回 entity_id）。 */
  getEntityFolderName(name: string, context: string = ''): string {
    const { entityId } = this.disambiguate(name, context);
    if (entityId) return entityId;
    // 新实体
    return this.registerEntity(name, context);
  }

  /** 检查是否需要用户确认。返回 { needsClarification, clarificationMessage }。 */
  needsClarification(name: string): { needsClarification: boolean; clarificationMessage: string } {
    const candidates = this._findCandidatesByName(name);
    if (candidates.length <= 1) {
      return { needsClarification: false, clarificationMessage: '' };
    }
    const clarification = this._generateClarificationMessage(candidates, '');
    return { needsClarification: true, clarificationMessage: clarification };
  }

  /** 用户选择后解析歧义（selectedIndex 从 1 开始）。 */
  resolveAmbiguity(name: string, selectedIndex: number): string | null {
    const candidates = this._findCandidatesByName(name);
    if (selectedIndex > 0 && selectedIndex <= candidates.length) {
      const selectedEntity = candidates[selectedIndex - 1];
      this.addMention(name, '', (selectedEntity.relationship_context || {})['与用户的关系'] || '');
      return selectedEntity.entity_id;
    }
    return null;
  }
}

// 全局单例
let _entityManager: EntityManager | null = null;

export function getEntityManager(): EntityManager {
  if (!_entityManager) {
    _entityManager = new EntityManager();
  }
  return _entityManager;
}