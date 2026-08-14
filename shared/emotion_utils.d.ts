// ==========================================
// shared/emotion_utils.js 的类型声明（供移动端 TypeScript 使用）
// 与 emotion_utils.js 的导出保持一致
// ==========================================

export const BASIC_EMOTIONS: string[];
export const COMPOSITE_EMOTIONS: string[];
export const SUPPLEMENTARY_EMOTIONS: string[];
export const ALL_EMOTIONS: string[];

export const BASIC_HUE: Record<string, number>;
export const COMPOSITE_HUE: Record<string, number>;
export const SUPPLEMENTARY_HUE: Record<string, number>;
export const LEGACY_HUE: Record<string, number>;
export const EMOTION_HUE: Record<string, number>;
export const MUTED_EMOTIONS: Set<string>;

export function hslToHex(h: number, s: number, l: number): string;
export function hexToRgba(hex: string, alpha?: number): string;
export function hashEmotionHue(emotion: string): number;

export interface EmotionColor {
  bg: string;
  text: string;
  border: string;
  dot: string;
  glow: string;
}

export function getEmotionColor(emotion: string): EmotionColor | null;

export function normalizeEmotionVector(vector: Record<string, number>, maxValue?: number): Record<string, number>;
export function getEmotionIntensity(vector: Record<string, number>): number;
export function getDominantEmotion(vector: Record<string, number>): string;
export function emotionVectorToRadarData(vector: Record<string, number>): Array<{ emotion: string; value: number }>;

export const EMOTION_OPPOSITES: Record<string, string>;
export const EMOTION_AROUSAL: {
  high: Set<string>;
  medium: Set<string>;
  low: Set<string>;
};
export function getEmotionArousal(emotion: string): 'high' | 'medium' | 'low';
export function isValidEmotion(emotion: string): boolean;
export function cleanEmotionText(text: string): string;