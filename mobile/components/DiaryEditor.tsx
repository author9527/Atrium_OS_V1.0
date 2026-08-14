import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, ScrollView } from 'react-native';
import { getDiaryByDate, saveDiary, analyzeDiaryCombined, updateWeather } from '../local/diary';
import { getSessionByTitle, createSession, triggerGreeting, getSessionMessages } from '../local/chat';
import RichTextEditor from './RichTextEditor';
import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';

type IconName = ComponentProps<typeof Ionicons>['name'];

// 天气选项：图标名 + 标签
const WEATHER_OPTIONS: { icon: IconName; label: string }[] = [
  { icon: 'sunny', label: '晴' },
  { icon: 'partly-sunny', label: '多云' },
  { icon: 'cloud', label: '阴' },
  { icon: 'rainy', label: '小雨' },
  { icon: 'rainy', label: '中雨' },
  { icon: 'thunderstorm', label: '雷阵雨' },
  { icon: 'snow', label: '雪' },
  { icon: 'cloudy-night', label: '雾' },
  { icon: 'leaf', label: '风' },
];

const WEATHER_ICON: Record<string, IconName> = {
  '晴': 'sunny', '多云': 'partly-sunny', '阴': 'cloud', '小雨': 'rainy',
  '中雨': 'rainy', '大雨': 'rainy', '雷阵雨': 'thunderstorm', '雪': 'snow',
  '雾': 'cloudy-night', '风': 'leaf',
};

interface Props {
  date: string;
  onSaved?: () => void;
  onChatGreeting?: () => void;
}

const formatDate = (dateStr: string) => {
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    return `${parts[0]}年${parts[1]}月${parts[2]}日`;
  }
  return dateStr;
};

// 日记编辑权限：仅今天和昨天可编辑（允许零点后补记昨天）
const isEditable = (dateStr: string): boolean => {
  const target = new Date(dateStr + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today.getTime() - target.getTime()) / 86400000);
  return diffDays >= 0 && diffDays <= 1;
};

export default function DiaryEditor({ date, onSaved, onChatGreeting }: Props) {
  const [content, setContent] = useState('');
  const [weather, setWeather] = useState('晴');
  const [weatherPickerOpen, setWeatherPickerOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showToast, setShowToast] = useState(false);

  useEffect(() => {
    loadDiary();
  }, [date]);

  const loadDiary = async () => {
    try {
      setLoading(true);
      setWeatherPickerOpen(false);
      const data = await getDiaryByDate(date);
      const loaded = data.diary?.content || '';
      setWeather(data.diary?.weather || '晴');
      setContent(loaded);
    } catch (e: any) {
      console.error('[DiaryEditor] 加载日记失败:', e.message || e);
    } finally {
      setLoading(false);
    }
  };

  const handleWeatherSelect = async (label: string, value: string) => {
    if (!isEditable(date)) {
      Alert.alert('无法修改', '天气修改权限仅在当日和昨日开放');
      return;
    }
    setWeather(label);
    setWeatherPickerOpen(false);
    try {
      await updateWeather(date, label);
    } catch (e: any) {
      Alert.alert('天气保存失败', e.message || '未知错误');
    }
  };

  const handleSave = async () => {
    if (!isEditable(date)) {
      Alert.alert('无法编辑', '只能编辑今天和昨天的日记，请换一个可编辑的日期');
      return;
    }
    try {
      setSaving(true);
      await saveDiary(date, content);

      let hasGreeting = false;
      if (content.length > 10) {
        // 一次 AI 调用完成摘要 + 主导情绪 + 8维情绪向量（供日历摘要/情绪标签/雷达张力图使用）
        await analyzeDiaryCombined(date, content);

        // 检查该日记对应的聊天空间
        const sessionTitle = `日记-${date}`;
        const existingSession = await getSessionByTitle(sessionTitle);
        let sessionId: string | null = null;
        let shouldGreet = false;

        if (!existingSession) {
          // 尚未创建聊天空间，创建并生成问候
          const newSession = await createSession(date, sessionTitle);
          sessionId = newSession.id;
          shouldGreet = true;
        } else {
          sessionId = existingSession.id;
          // 检查是否有对话记录
          const messages = await getSessionMessages(sessionId);
          if (messages.length === 0) {
            shouldGreet = true;
          }
        }

        if (shouldGreet && sessionId) {
          // 后台触发共情助手流式生成问候，不阻塞保存流程
          triggerGreeting(date, sessionId).catch(() => {});
          hasGreeting = true;
        }
      }

      onSaved?.();
      if (hasGreeting) {
        onChatGreeting?.();
      }
      setShowToast(true);
      setTimeout(() => setShowToast(false), 2000);
    } catch (e: any) {
      Alert.alert('保存失败', e.message || '未知错误');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#64748b" />
      </View>
    );
  }

  const editable = isEditable(date);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.dateRow}>
          <Text style={styles.dateLabel}>{formatDate(date)}</Text>
          <TouchableOpacity
            style={styles.weatherBadge}
            onPress={() => setWeatherPickerOpen(o => !o)}
            activeOpacity={0.7}
          >
            <Ionicons name={WEATHER_ICON[weather] || 'sunny'} size={15} color="#D97706" />
            <Text style={styles.weatherText}>{weather}</Text>
            <Ionicons name="chevron-down" size={12} color="#D97706" />
          </TouchableOpacity>
        </View>
        <TouchableOpacity
          style={[styles.saveBtn, (!editable || saving) && styles.saveBtnDisabled]}
          onPress={handleSave}
          disabled={!editable || saving}
        >
          <Text style={styles.saveBtnText}>
            {saving ? '保存中...' : editable ? '保存' : '不可编辑'}
          </Text>
        </TouchableOpacity>
      </View>
      {weatherPickerOpen && (
        <View style={styles.weatherPicker}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.weatherPickerContent}
          >
            {WEATHER_OPTIONS.map(opt => {
              const selected = opt.label === weather;
              return (
                <TouchableOpacity
                  key={opt.label}
                  style={[styles.weatherOption, selected && styles.weatherOptionSelected]}
                  onPress={() => handleWeatherSelect(opt.label, opt.label)}
                  activeOpacity={0.7}
                >
                  <Ionicons name={opt.icon} size={16} color={selected ? '#fff' : '#D97706'} />
                  <Text style={[styles.weatherOptionText, selected && styles.weatherOptionTextSelected]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}
      {!editable && (
        <View style={styles.lockBanner}>
          <Text style={styles.lockBannerText}>只能编辑今天和昨天的日记，这篇仅供查看</Text>
        </View>
      )}
      <View style={styles.editorWrapper}>
        <RichTextEditor
          key={date}
          initialContent={content}
          onChange={setContent}
        />
      </View>
      {showToast && (
        <View style={styles.toast}>
          <Text style={styles.toastText}>已保存</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  dateLabel: { fontSize: 16, fontWeight: '600', color: '#374151' },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  weatherBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFF7ED',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    marginLeft: 10,
  },
  weatherText: {
    fontSize: 13,
    color: '#D97706',
    fontWeight: '600',
    marginLeft: 4,
    marginRight: 2,
  },
  weatherPicker: {
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    backgroundColor: '#FFFBEB',
    paddingVertical: 8,
  },
  weatherPickerContent: {
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  weatherOption: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#FDE68A',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    marginRight: 8,
  },
  weatherOptionSelected: {
    backgroundColor: '#F59E0B',
    borderColor: '#F59E0B',
  },
  weatherOptionText: {
    fontSize: 13,
    color: '#D97706',
    fontWeight: '600',
    marginLeft: 4,
  },
  weatherOptionTextSelected: {
    color: '#fff',
  },
  saveBtn: {
    backgroundColor: '#1e293b',
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 8,
  },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  lockBanner: {
    backgroundColor: '#fef3c7',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  lockBannerText: { fontSize: 12, color: '#92400e' },
  editorWrapper: {
    flex: 1,
    margin: 16,
    marginTop: 12,
    backgroundColor: '#fff',
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 60,
  },
  toast: {
    position: 'absolute',
    bottom: 80,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  toastText: {
    backgroundColor: '#10b981',
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
    overflow: 'hidden',
  },
});
