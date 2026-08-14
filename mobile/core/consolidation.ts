/**
 * consolidation.ts — 手机端沉淀管道（对应 Python EmpathyAgent 的 _do_consolidation / consolidate_diary）
 *
 * 功能：
 * 1. 从历史对话缓存的「旧消息」中提取事实三元组（通过 ModelClient 驱动的 kg_mem 管道）。
 * 2. 将三元组中的特质信息同步到 core_storage 实体的 ontology_traits。
 * 3. 保留最近 KEEP 条消息作为热缓存，只沉淀更早的消息。
 *
 * 本模块只依赖 ModelClient 抽象 + CoreStorage，不依赖任何 HTTP 层，保持纯净可测。
 */

import { CoreStorage } from './db/coreStorage';
import { ModelClient, ModelCallOptions } from './model';

/** 热缓存保留条数：与 Python 版 KEEP=50 一致 */
export const KEEP = 50;

/** 历史对话缓冲的一条消息 */
export interface HistoryMessage {
  ts: number;
  content: string;
}

/** 三元组（对应 Python kg_mem 提取的 Relation） */
export interface Triple {
  entity0: string; // 主语名
  entity0Type: string; // 主语类型：User / NPC / ...
  entity1: string; // 宾语名
  entity1Type: string; // 宾语类型
  relationType: string; // 谓词名，如 has_habit / believes_in / sensitive_to / strives_for
  relation: string; // 关系描述文本
}

/** 沉淀结果统计 */
export interface ConsolidationResult {
  consolidated: number; // 沉淀了多少条旧消息
  kept: number; // 保留了最近多少条
  facts: number; // 提取到多少条三元组
}

/** 维度映射：谓词 -> ontology_traits 一级 key（与 Python 版一致） */
const DIMENSION_MAP: Record<string, string> = {
  has_habit: 'behavior',
  believes_in: 'values',
  sensitive_to: 'mindset_pattern',
  strives_for: 'motivation',
};

/** 抽象类型列表：宾语若是这些类型之一，可视为「特质」而非具象人物 */
const ABSTRACT_TYPES = ['Habit', 'Value', 'Concept', 'Emotion', 'Goal', 'Preference'];

/**
 * ConsolidationEngine — 沉淀管道
 */
export class ConsolidationEngine {
  private _storage: CoreStorage;
  private _client: ModelClient;
  private _history: HistoryMessage[] = [];

  constructor(storage: CoreStorage, client: ModelClient) {
    this._storage = storage;
    this._client = client;
  }

  /** 设置/注入历史对话缓冲（调用方负责读写持久化） */
  setHistoryBuffer(messages: HistoryMessage[]): void {
    this._history = messages || [];
  }

  getHistoryBuffer(): HistoryMessage[] {
    return this._history;
  }

  /**
   * 沉淀管道：从历史消息中提取三元组并同步到实体。
   * 只沉淀旧消息，保留最近 KEEP 条作为热缓存。
   */
  async consolidate(): Promise<ConsolidationResult> {
    const msgs = this._history;
    if (!msgs.length) {
      return { consolidated: 0, kept: 0, facts: 0 };
    }

    const toConsolidate = msgs.length > KEEP ? msgs.slice(0, msgs.length - KEEP) : [];
    const toKeep = msgs.length > KEEP ? msgs.slice(-KEEP) : msgs;

    if (!toConsolidate.length) {
      return { consolidated: 0, kept: toKeep.length, facts: 0 };
    }

    const dialogueBlock = toConsolidate.map((m) => m.content).join('\n');
    if (!dialogueBlock.trim()) {
      this._history = toKeep;
      return { consolidated: toConsolidate.length, kept: toKeep.length, facts: 0 };
    }

    // 1. 提取三元组
    const triples = await this._extractTriples(dialogueBlock);

    // 2. 将三元组特质同步到实体
    for (const rel of triples) {
      try {
        this._syncTripleToEntity(rel);
      } catch {
        // 单条同步失败不影响整体
      }
    }

    // 3. 只保留热缓存消息
    this._history = toKeep;

    return {
      consolidated: toConsolidate.length,
      kept: toKeep.length,
      facts: triples.length,
    };
  }

  /**
   * 将单篇日记内容沉淀到 core_storage（对应 Python consolidate_diary）。
   * 内容过短（<=10 字）直接跳过。
   */
  async consolidateDiary(diaryContent: string): Promise<number> {
    if (!diaryContent || diaryContent.length <= 10) {
      return 0;
    }
    const original = this._history;
    // 临时把日记作为唯一消息，走统一沉淀管道
    this._history = [{ ts: Date.now() / 1000, content: diaryContent }];
    try {
      await this.consolidate();
      return 1;
    } catch {
      this._history = original;
      return 0;
    } finally {
      // 恢复原缓冲（若 consolidate 已替换，则保留替换结果）
      if (this._history === original) {
        // no-op
      }
    }
  }

  /**
   * 通过 LLM 提取事实三元组（对应 Python kg_mem.add_unstructured 的替代实现）。
   * 使用 ModelClient 让模型输出结构化三元组 JSON。
   */
  private async _extractTriples(dialogueBlock: string): Promise<Triple[]> {
    if (!dialogueBlock.trim()) return [];

    const system =
      '你是知识图谱实体关系抽取引擎。请从下面的对话中提取出关于用户（Me）及其身边人的事实关系三元组。\n' +
      '只输出 JSON 数组，不要输出任何其他内容。每个元素格式为：\n' +
      '{"entity0":"主语名","entity0Type":"User|NPC","entity1":"宾语名","entity1Type":"Habit|Value|Concept|Emotion|Goal|Preference|NPC|User|...","relationType":"has_habit|believes_in|sensitive_to|strives_for|related_to|...","relation":"一段自然语言描述这句话表达的关系"}。\n' +
      '只提取明确、稳定的事实（习惯、信念、敏感点、目标、特质），不要提取一次性事件或闲聊。\n' +
      '如果没有任何可提取的事实，输出空数组 []。';

    const prompt = `对话内容：\n${dialogueBlock}\n\n提取结果：`;

    const opts: ModelCallOptions = { jsonMode: true, numPredict: 1024, temperature: 0.3 };
    try {
      const result = await this._client.call(prompt, system, opts);
      const raw = (result.response || '').trim();
      const data = this._parseTriples(raw);
      return data;
    } catch {
      return [];
    }
  }

  /** 解析模型输出的三元组 JSON（容忍代码块包裹 / 前后杂文） */
  private _parseTriples(raw: string): Triple[] {
    if (!raw) return [];
    // 去掉 ```json ... ``` 包裹
    let text = raw.trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) {
      text = fence[1].trim();
    }
    // 寻找第一个 [ 到最后一个 ]
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end === -1 || end <= start) return [];
    const jsonStr = text.slice(start, end + 1);
    try {
      const arr = JSON.parse(jsonStr);
      if (!Array.isArray(arr)) return [];
      return arr
        .filter((it) => it && typeof it === 'object')
        .map((it) => ({
          entity0: String(it.entity0 || '').trim(),
          entity0Type: String(it.entity0Type || 'NPC').trim(),
          entity1: String(it.entity1 || '').trim(),
          entity1Type: String(it.entity1Type || 'Concept').trim(),
          relationType: String(it.relationType || 'related_to').trim(),
          relation: String(it.relation || '').trim(),
        }))
        .filter((t) => t.entity0 && t.entity1);
    } catch {
      return [];
    }
  }

  /**
   * 将三元组中的特质信息同步到 core_storage 实体的 ontology_traits（对应 Python _sync_triple_to_entity）。
   */
  private _syncTripleToEntity(rel: Triple): void {
    const e0Name = this._normalizeEntityName(rel.entity0);
    const e1Name = this._normalizeEntityName(rel.entity1);
    const rType = rel.relationType;

    const dimensionKey = DIMENSION_MAP[rType];
    if (!dimensionKey) return;

    const isE0Person = rel.entity0Type === 'User' || rel.entity0Type === 'NPC';
    const isE1Abstract = ABSTRACT_TYPES.includes(rel.entity1Type) || e1Name === rel.entity1Type;

    let targetName: string | null = null;
    let traitValue: string;

    if ((e0Name === 'Me' || e0Name === 'User' || e0Name === '我') && dimensionKey) {
      targetName = 'me';
      traitValue = `${rType}: ${e1Name} (${rel.relation})`;
    } else if (isE0Person && isE1Abstract && dimensionKey) {
      targetName = e0Name.toLowerCase().replace(/\s+/g, '_');
      traitValue = `${rType}: ${e1Name} (${rel.relation})`;
    } else {
      return;
    }

    if (!targetName) return;

    const traitKey = `${dimensionKey}.${rType}`;

    let existing = this._storage.getEntityBySlug(targetName);
    if (!existing) {
      this._storage.upsertEntity(
        targetName,
        targetName === 'me' ? 'Me' : e0Name,
        targetName,
        targetName === 'me' ? 'user' : 'npc',
        {},
        '',
      );
      existing = this._storage.getEntityBySlug(targetName);
    }

    if (!existing) return;

    const traits = { ...(existing.ontology_traits || {}) } as Record<string, unknown>;
    traits[traitKey] = traitValue;
    this._storage.updateOntologyTraits(targetName, traits);
  }

  /** 标准化实体名：从 core_storage 已有实体匹配，避免重复创建（对应 Python _normalize_entity_name） */
  private _normalizeEntityName(name: string): string {
    const normalized = (name || '').trim();
    if (!normalized) return normalized;
    const slug = normalized.toLowerCase().replace(/\s+/g, '_');
    if (['me', 'user', '我'].includes(slug)) {
      return 'Me';
    }
    const existing = this._storage.getEntityBySlug(slug);
    if (existing) return existing.name;
    const all = this._storage.getAllEntities();
    const matched = all.find((e) => e.name.toLowerCase() === normalized.toLowerCase());
    if (matched) return matched.name;
    return normalized;
  }
}

/** 单例访问器：统一注入 storage 与 client */
let _engine: ConsolidationEngine | null = null;

export function getConsolidationEngine(
  storage?: CoreStorage,
  client?: ModelClient,
): ConsolidationEngine {
  if (_engine && !storage && !client) {
    return _engine;
  }
  if (!storage) {
    throw new Error('ConsolidationEngine 需要注入 CoreStorage');
  }
  if (!client) {
    throw new Error('ConsolidationEngine 需要注入 ModelClient（Phase 4 modelService）');
  }
  _engine = new ConsolidationEngine(storage, client);
  return _engine;
}