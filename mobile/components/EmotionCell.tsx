import React from 'react';
import { TouchableOpacity, Text, StyleSheet } from 'react-native';
import { getEmotionColor } from '../shared/emotion_utils';

interface EmotionColor {
  bg: string;
  text: string;
}

// ============================================================
// 情绪轮颜色机制（基于普拉奇克情绪轮）
// 统一由 shared/emotion_utils.js 提供（与 Web 端一致）
// ============================================================

interface Props {
  day: number;
  month: number;
  year: number;
  isToday: boolean;
  emotion: string;
  summary: string;
  displayMode: 'emotion' | 'summary';
  hasDiary: boolean;
  onPress: () => void;
}

export default function EmotionCell({ day, isToday, emotion, summary, displayMode, hasDiary, onPress }: Props) {
  const color = getEmotionColor(emotion) as EmotionColor | undefined;
  const displayText = displayMode === 'emotion' ? emotion : summary;
  const isEmpty = !displayText && !hasDiary;

  return (
    <TouchableOpacity
      style={[
        styles.cell,
        isToday && styles.todayCell,
        color && displayMode === 'emotion' ? { backgroundColor: color.bg } : null,
        isToday && hasDiary && color && displayMode === 'emotion' && styles.todayEmotionShadow,
      ]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Text style={[styles.dayText, isToday && styles.todayText]}>
        {day}
      </Text>
      {!isEmpty && (
        <Text
          style={[
            styles.labelText,
            color && displayMode === 'emotion' ? { color: color.text } : null,
            displayMode === 'summary' && styles.summaryText,
          ]}
          numberOfLines={1}
        >
          {displayText || '--'}
        </Text>
      )}
      {isEmpty && isToday && (
        <Text style={styles.todayLabel}>今天</Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  cell: {
    flex: 1,
    aspectRatio: 1.1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    margin: 1,
    borderWidth: 1,
    borderColor: '#e2e8f0',   // 无日记默认浅灰边框
    backgroundColor: '#f8fafc', // 无日记浅色底，不涂彩色
  },
  todayCell: {
    backgroundColor: '#f1f5f9',
  },
  todayEmotionShadow: {
    borderWidth: 2,
    borderColor: '#1e293b',
    shadowColor: '#1e293b',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 5,
  },
  dayText: {
    fontSize: 13,
    color: '#64748b',
    fontWeight: '500',
  },
  todayText: {
    color: '#1e293b',
    fontWeight: '700',
  },
  labelText: {
    fontSize: 12,
    fontWeight: '700',
    marginTop: 2,
    maxWidth: '95%',
  },
  summaryText: {
    fontSize: 10,
    fontWeight: '500',
    color: '#6B7280',
  },
  todayLabel: {
    fontSize: 10,
    color: '#1e293b',
    fontWeight: '600',
    marginTop: 2,
  },
});