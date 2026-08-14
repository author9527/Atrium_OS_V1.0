// ==========================================
// 情绪工具函数
// 基于普拉奇克情绪轮，提供情绪分类、颜色映射、向量归一化等功能
// 前后端共享（前端使用）
// ==========================================

// ==========================================
// 1. 情绪词表
// ==========================================

// 普拉奇克 8 种基本情绪
export const BASIC_EMOTIONS = [
  '喜悦', '信任', '恐惧', '惊讶',
  '悲伤', '厌恶', '愤怒', '期待'
];

// 普拉奇克 8 种初级复合情绪（相邻基本情绪两两组合）
export const COMPOSITE_EMOTIONS = [
  '爱', '服从', '敬畏', '失望',
  '悔恨', '蔑视', '侵略', '乐观'
];

// 日常高频补充情绪（中文日记中常出现的细腻情绪）
export const SUPPLEMENTARY_EMOTIONS = [
  '懊恼', '内疚', '焦虑', '委屈',
  '疲惫', '无奈', '释然', '思念',
  '满足', '兴奋', '孤独', '感激',
  '平静', '紧张', '烦躁', '期待感'
];

// 完整情绪词表（与后端 classify_emotion 一致）
export const ALL_EMOTIONS = [
  ...BASIC_EMOTIONS,
  ...COMPOSITE_EMOTIONS,
  ...SUPPLEMENTARY_EMOTIONS
];

// ==========================================
// 2. 情绪轮颜色机制（基于普拉奇克情绪轮）
// 每个情绪映射到一个色相角(hue)，相邻情绪色相相近 → 颜色相近；
// 对立情绪在色相环上接近正对面。颜色由 HSL 统一生成。
// ==========================================

// 基本情绪色相角
export const BASIC_HUE = {
  '喜悦': 50,
  '期待': 30,
  '愤怒': 5,
  '厌恶': 340,
  '悲伤': 250,
  '惊讶': 200,
  '恐惧': 160,
  '信任': 110
};

// 复合情绪色相角（位于两个基本情绪之间）
export const COMPOSITE_HUE = {
  '爱': 80,        // 喜悦 + 信任
  '服从': 135,     // 信任 + 恐惧
  '敬畏': 180,     // 恐惧 + 惊讶
  '失望': 225,     // 惊讶 + 悲伤
  '悔恨': 295,     // 悲伤 + 厌恶
  '蔑视': 352,     // 厌恶 + 愤怒
  '侵略': 17,      // 愤怒 + 期待
  '乐观': 40       // 期待 + 喜悦
};

// 补充情绪色相角（与手机端一致）
export const SUPPLEMENTARY_HUE = {
  '懊恼': 350,
  '内疚': 280,
  '焦虑': 150,
  '委屈': 240,
  '疲惫': 250,
  '无奈': 220,
  '释然': 115,
  '思念': 90,
  '满足': 75,
  '兴奋': 38,
  '孤独': 235,
  '感激': 70,
  '平静': 130,
  '紧张': 165,
  '烦躁': 355,
  '期待感': 28
};

// 旧情绪词兼容映射（与手机端一致）
export const LEGACY_HUE = {
  '伤心': 250, '快乐': 50, '感动': 200, '感慨': 110, '日常': 130
};

// 合并所有情绪色相映射
export const EMOTION_HUE = {
  ...BASIC_HUE,
  ...COMPOSITE_HUE,
  ...SUPPLEMENTARY_HUE,
  ...LEGACY_HUE
};

// 低唤醒情绪（颜色更柔和，与手机端一致）
export const MUTED_EMOTIONS = new Set([
  '疲惫', '平静', '孤独', '无奈', '日常'
]);

// ==========================================
// 3. 颜色工具函数
// ==========================================

/**
 * HSL 转十六进制颜色
 * @param {number} h - 色相角 (0-360)
 * @param {number} s - 饱和度 (0-1)
 * @param {number} l - 亮度 (0-1)
 * @returns {string} 十六进制颜色，如 "#ff0000"
 */
export function hslToHex(h, s, l) {
  h = h % 360;
  if (h < 0) h += 360;

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let r, g, b;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }

  r = Math.round((r + m) * 255);
  g = Math.round((g + m) * 255);
  b = Math.round((b + m) * 255);

  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

/**
 * 十六进制颜色转 RGBA
 * @param {string} hex - 十六进制颜色，如 "#ff0000"
 * @param {number} alpha - 透明度 (0-1)
 * @returns {string} RGBA 颜色字符串
 */
export function hexToRgba(hex, alpha = 1) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * 为未知情绪生成稳定的色相（基于字符串哈希）
 * @param {string} emotion - 情绪词
 * @returns {number} 色相角 (0-360)
 */
export function hashEmotionHue(emotion) {
  let hash = 0;
  for (const ch of emotion) {
    hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  }
  return hash;
}

/**
 * 获取情绪对应的颜色对象
 * @param {string} emotion - 情绪词
 * @returns {object} 颜色对象 { bg, text, border, dot, glow }
 */
export function getEmotionColor(emotion) {
  if (!emotion) return null;

  let hue = EMOTION_HUE[emotion];
  if (hue === undefined) {
    hue = hashEmotionHue(emotion);
  }

  const muted = MUTED_EMOTIONS.has(emotion);
  const bg = hslToHex(hue, muted ? 0.32 : 0.55, muted ? 0.90 : 0.92);
  const border = hslToHex(hue, muted ? 0.45 : 0.65, muted ? 0.78 : 0.80);
  const dot = hslToHex(hue, muted ? 0.45 : 0.65, muted ? 0.55 : 0.50);
  const text = hslToHex(hue, muted ? 0.45 : 0.65, muted ? 0.34 : 0.30);

  return {
    bg,
    text,
    border,
    dot,
    glow: hexToRgba(dot, 0.5)
  };
}

// ==========================================
// 4. 情绪向量归一化
// ==========================================

/**
 * 归一化情绪向量，使各维度值在 0-1 之间
 * @param {object} vector - 情绪向量，如 { 喜悦: 80, 悲伤: 20, ... }
 * @param {number} maxValue - 最大值（默认 100）
 * @returns {object} 归一化后的情绪向量
 */
export function normalizeEmotionVector(vector, maxValue = 100) {
  const result = {};
  for (const [key, value] of Object.entries(vector)) {
    const num = Number(value) || 0;
    result[key] = Math.max(0, Math.min(1, num / maxValue));
  }
  return result;
}

/**
 * 计算情绪向量的总强度（所有维度之和）
 * @param {object} vector - 情绪向量
 * @returns {number} 总强度
 */
export function getEmotionIntensity(vector) {
  return Object.values(vector).reduce((sum, v) => sum + (Number(v) || 0), 0);
}

/**
 * 获取情绪向量中的主导情绪
 * @param {object} vector - 情绪向量
 * @returns {string} 主导情绪名称
 */
export function getDominantEmotion(vector) {
  let maxEmotion = '平静';
  let maxValue = 0;

  for (const [emotion, value] of Object.entries(vector)) {
    const num = Number(value) || 0;
    if (num > maxValue) {
      maxValue = num;
      maxEmotion = emotion;
    }
  }

  return maxEmotion;
}

/**
 * 将 8 维基础情绪向量转换为雷达图数据
 * @param {object} vector - 8 维情绪向量
 * @returns {Array<{ emotion: string, value: number }>} 雷达图数据数组
 */
export function emotionVectorToRadarData(vector) {
  return BASIC_EMOTIONS.map(emotion => ({
    emotion,
    value: Number(vector[emotion]) || 0
  }));
}

// ==========================================
// 5. 情绪分类辅助
// ==========================================

// 情绪对立关系
export const EMOTION_OPPOSITES = {
  '喜悦': '悲伤',
  '悲伤': '喜悦',
  '信任': '厌恶',
  '厌恶': '信任',
  '恐惧': '愤怒',
  '愤怒': '恐惧',
  '惊讶': '期待',
  '期待': '惊讶'
};

// 情绪唤醒度分类
export const EMOTION_AROUSAL = {
  // 高唤醒情绪
  high: new Set([
    '喜悦', '愤怒', '恐惧', '惊讶',
    '兴奋', '紧张', '烦躁', '焦虑',
    '侵略', '乐观'
  ]),
  // 中唤醒情绪
  medium: new Set([
    '期待', '厌恶', '悲伤',
    '爱', '敬畏', '失望', '悔恨',
    '蔑视', '服从', '懊恼', '内疚',
    '委屈', '思念', '孤独', '感激'
  ]),
  // 低唤醒情绪
  low: new Set([
    '信任', '平静', '满足', '疲惫',
    '释然', '无奈', '期待感'
  ])
};

/**
 * 获取情绪的唤醒度等级
 * @param {string} emotion - 情绪词
 * @returns {'high'|'medium'|'low'} 唤醒度等级
 */
export function getEmotionArousal(emotion) {
  if (EMOTION_AROUSAL.high.has(emotion)) return 'high';
  if (EMOTION_AROUSAL.low.has(emotion)) return 'low';
  return 'medium';
}

/**
 * 检查情绪是否有效（在预定义词表中）
 * @param {string} emotion - 情绪词
 * @returns {boolean} 是否有效
 */
export function isValidEmotion(emotion) {
  return ALL_EMOTIONS.includes(emotion);
}

/**
 * 清理并验证情绪词（容错：从文本中提取有效情绪）
 * @param {string} text - 可能包含情绪词的文本
 * @returns {string} 有效情绪词，默认返回"平静"
 */
export function cleanEmotionText(text) {
  if (!text || typeof text !== 'string') return '平静';
  const raw = text.trim();

  // 精确匹配
  if (ALL_EMOTIONS.includes(raw)) return raw;

  // 包含匹配（取第一个匹配的）
  for (const emotion of ALL_EMOTIONS) {
    if (raw.includes(emotion)) {
      return emotion;
    }
  }

  return '平静';
}
