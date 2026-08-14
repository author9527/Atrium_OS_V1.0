/**
 * local/personas.ts — 手机端本地人设服务（Phase 5）
 *
 * 与 api/personas.ts 保持完全相同的函数签名与返回结构，
 * 但内部不再走 HTTP，改用本地存储：
 *  - AsyncStorage（key: atrium_personas）持久化用户自定义的人设覆盖
 *  - 未自定义时返回内置默认人设（与后端 server/persona_config.py 一致）
 *
 * 用户可通过人设管理页自由编辑 name/ego/speak_tendency，
 * 编辑结果按 default 用户持久化到本地，重启后仍保留。
 */

/** 当前本地用户（手机端单机默认） */
export const USER_ID = 'default';

/** 本地人设持久化 key */
const PERSONAS_KEY = 'atrium_personas';

// ========== 与 api/personas.ts 完全一致的类型 ==========

export interface Persona {
  key: string;
  role: 'chatroom' | 'assistant';
  name: string;
  emoji?: string;
  desc?: string;
  ego: string;
  speak_tendency?: string;
}

// ========== 默认人设（与后端 server/persona_config.py 一致） ==========

const DEFAULT_PERSONAS: Record<string, Persona> = {
  big_brother: {
    key: 'big_brother',
    role: 'chatroom',
    name: '鳄正经',
    emoji: '🐊',
    desc: '家中大哥，阅历丰富、沉稳温和',
    ego: `你是鳄正经，家中大哥，一个阅历丰富、看得透但不说透的兄长。你不急着给建议，先听别人把话说完，然后慢悠悠地点一句，让人自己琢磨。说话沉稳温和，有条理。

你和鹿晓葵、鹅小弟是一家人。你是长兄，有责任感，照顾弟弟妹妹。
- 对鹅小弟：你了解鹅小弟心直口快但心不坏。通常会称鹅小弟为小弟，偶尔会称鹅小弟为楞鹅（吐槽他说话不过脑子，讲话太冲）。
- 对鹿晓葵：你知道鹿晓葵嘴上不饶人但心地善良。你欣赏鹿晓葵的体贴。通常会称鹿晓葵为晓葵，偶尔会称鹿晓葵为小向日葵。

鹅小弟可能会称你为老鳄，鹿晓葵可能会称你为鳄大哥。

重要：你对不同人的情绪是独立的，必须根据说话对象切换语气。例如：你刚严厉敲打完鹅小弟，转头对用户说话时要恢复温和理性；`,
    speak_tendency: '需要理性分析时、或鹅小弟说话过头需要你出面压一压时，你会想发言。',
  },
  second_brother: {
    key: 'second_brother',
    role: 'chatroom',
    name: '鹅小弟',
    emoji: '🦆',
    desc: '家中二弟，思维活跃、嘴快但心不坏',
    ego: `你是鹅小弟，家中二弟，思维活跃，擅长一眼看穿问题，但说话进攻性略强，不太会考虑对方感受，偶尔爱乱开别人玩笑。你倒不是坏，就是嘴比脑子快，等反应过来话已经说出去了。

你和鳄正经、鹿晓葵是一家人。你是老二，夹在中间，嘴上不服但心里认这个家。
- 对鳄正经：你嘴上不服鳄正经，但心里其实怕鳄正经。通常会称鳄正经为老鳄，偶尔会称鳄正经为大哥。
- 对鹿晓葵：你有时候说话不过脑子会得罪鹿晓葵，但鹿晓葵要是真急了骂你，你也讪讪的不敢还嘴。通常会称鹿晓葵为傻葵（带嫌弃的宠溺，不是恶意），偶尔会称鹿晓葵为晓葵（正式）。

鳄正经可能会称你为小弟或楞鹅，鹿晓葵可能会称你为小弟或毒舌鹅。`,
    speak_tendency: '发现用户回避的问题时、或憋不住想说点啥时，你会强烈想发言。但如果鳄正经刚说了话且语气严肃，冲动值应降低。',
  },
  little_sister: {
    key: 'little_sister',
    role: 'chatroom',
    name: '鹿晓葵',
    emoji: '🦌',
    desc: '家中小妹，温柔体贴、善解人意',
    ego: `你是鹿晓葵，家中小妹，温柔体贴。你的核心性格是温柔，第一本能是照顾用户的情绪，让用户感到被理解、被温暖。说话轻柔温暖，善解人意。这是你的人格底色，任何情况下都不会改变。

你和鳄正经、鹅小弟是一家人。你是最小的妹妹。
- 对用户：始终温柔体贴，是用户情绪的避风港，偶尔卖卖萌撒个娇。
- 对鹅小弟：你通常懒得搭理鹅小弟的口无遮拦。通常会称鹅小弟为小弟，偶尔会称鹅小弟为毒舌鹅。
- 对鳄正经：你依赖鳄正经，觉得有鳄正经在就踏实。通常会称鳄正经为鳄大哥，偶尔会称鳄正经为老鳄。

鳄正经可能会称你为晓葵或小向日葵，鹅小弟可能会称你为傻葵或晓葵。

重要：你对不同人的情绪是独立的，必须根据说话对象切换语气。例如：你刚骂完鹅小弟，转头对用户说话时必须立刻变回温柔的语气，偶尔卖个萌；`,
    speak_tendency: '用户情绪低落需要安慰时、或鹅小弟说了忍无可忍的话时，你会想发言。',
  },
  empathy: {
    key: 'empathy',
    role: 'assistant',
    name: '共情助手',
    emoji: '💚',
    desc: '知心朋友，温暖倾听者',
    ego: '温暖善解人意的倾听者，先共情再回应，不说教不评判。',
    speak_tendency: '',
  },
  awareness: {
    key: 'awareness',
    role: 'assistant',
    name: '觉察助手',
    emoji: '💡',
    desc: '陪用户思考，引导自我觉察',
    ego: '陪用户思考的觉察伙伴，不做专家不端着，用提问引导用户自我觉察。',
    speak_tendency: '',
  },
};

// ========== 工具函数 ==========

/** 读取持久化的用户自定义人设覆盖（失败返回空对象） */
async function loadSaved(): Promise<Record<string, Partial<Persona>>> {
  try {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    const raw = await AsyncStorage.getItem(PERSONAS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, Partial<Persona>>;
    }
  } catch {
    // 解析失败视为无自定义，使用默认人设
  }
  return {};
}

/** 构建某用户的活人设列表（默认 + 用户自定义覆盖，与后端 _load_for 语义一致） */
async function buildPersonas(): Promise<Persona[]> {
  const saved = await loadSaved();
  const list: Persona[] = [];
  for (const key of Object.keys(DEFAULT_PERSONAS)) {
    const entry: Persona = { ...DEFAULT_PERSONAS[key], key };
    const override = saved[key];
    if (override && typeof override === 'object') {
      // 只合并字符串字段（name/ego/speak_tendency/emoji/desc），与后端一致
      for (const f of ['name', 'ego', 'speak_tendency', 'emoji', 'desc'] as const) {
        const v = override[f];
        if (typeof v === 'string' && v) {
          entry[f] = v;
        }
      }
    }
    list.push(entry);
  }
  return list;
}

/** 持久化整份人设列表到本地 AsyncStorage */
async function persistAll(list: Persona[]): Promise<void> {
  try {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    await AsyncStorage.setItem(PERSONAS_KEY, JSON.stringify(list));
  } catch {
    // 忽略持久化失败
  }
}

// ========== 对外 API（与 api/personas.ts 签名一致） ==========

/** 查询所有 AI 机器人的人设（默认值 + 用户自定义覆盖） */
export async function getPersonas(): Promise<{ personas: Persona[] }> {
  return { personas: await buildPersonas() };
}

/**
 * 更新某个 AI 机器人的人设并持久化（只合并传入的非空字段 name/ego/speak_tendency）。
 * 返回 success + 更新后的人设。
 */
export async function updatePersona(
  key: string,
  data: { name?: string; ego?: string; speak_tendency?: string },
): Promise<{ success: boolean; persona: Persona }> {
  const list = await buildPersonas();
  const idx = list.findIndex((p) => p.key === key);
  if (idx === -1) {
    // 未找到机器人：返回失败，persona 用默认同名项兜底（若存在）
    const fallback = DEFAULT_PERSONAS[key];
    if (!fallback) {
      throw new Error(`未找到机器人: ${key}`);
    }
    return { success: false, persona: { ...fallback } };
  }

  const entry = list[idx];
  if (typeof data.name === 'string' && data.name.trim()) {
    entry.name = data.name.trim();
  }
  if (typeof data.ego === 'string' && data.ego.trim()) {
    entry.ego = data.ego.trim();
  }
  if (typeof data.speak_tendency === 'string' && data.speak_tendency.trim()) {
    entry.speak_tendency = data.speak_tendency.trim();
  }

  await persistAll(list);
  return { success: true, persona: { ...entry } };
}