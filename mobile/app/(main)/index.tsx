import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import CalendarView from '../../components/CalendarView';
import StatisticsPanel from '../../components/StatisticsPanel';
import BottomTabBar from '../../components/BottomTabBar';
import ProfileModal from '../../components/ProfileModal';

const PRIMARY = '#2FBF9F';
const TEXT = '#1F2937';
const BG = '#F5F7F6';

export default function CalendarScreen() {
  const router = useRouter();
  const [displayMode, setDisplayMode] = useState<'emotion' | 'summary'>('emotion');
  const [profileVisible, setProfileVisible] = useState(false);

  const now = new Date();
  const monthDay = `${now.getMonth() + 1}月${now.getDate()}日`;

  const handleDateSelect = (dateStr: string) => {
    router.push({ pathname: '/(main)/workspace', params: { date: dateStr } });
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      {/* 顶部：数字月日 + 天气 + 切换按钮 */}
      <View style={styles.header}>
        <View style={styles.dateRow}>
          <Text style={styles.monthDayText}>{monthDay}</Text>
          <TouchableOpacity
            style={styles.modeToggle}
            onPress={() => setDisplayMode(m => m === 'emotion' ? 'summary' : 'emotion')}
            activeOpacity={0.7}
          >
            <Text style={styles.modeToggleText}>
              {displayMode === 'emotion' ? '情绪' : '摘要'}
            </Text>
          </TouchableOpacity>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity
            style={styles.robotEntry}
            onPress={() => router.push('/(main)/personas')}
            activeOpacity={0.7}
          >
            <Ionicons name="hardware-chip-outline" size={22} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.profileEntry}
            onPress={() => setProfileVisible(true)}
            activeOpacity={0.7}
          >
            <Ionicons name="person-outline" size={22} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>

      {/* 可滚动主体：主页日历 + 统计面板，避免内容过高把底部按钮/Tab 挤出屏幕 */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <CalendarView onDateSelect={handleDateSelect} displayMode={displayMode} />
        <StatisticsPanel />
      </ScrollView>

      {/* 底部导航 */}
      <BottomTabBar active="calendar" />

      {/* 用户档案模态框 */}
      <ProfileModal visible={profileVisible} onClose={() => setProfileVisible(false)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 22,
    paddingTop: 18,
    paddingBottom: 14,
  },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 16 },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  monthDayText: {
    fontSize: 28,
    fontWeight: '700',
    color: TEXT,
  },
  modeToggle: {
    marginLeft: 8,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 14,
    backgroundColor: '#E6F7F1',
    borderWidth: 1,
    borderColor: PRIMARY,
  },
  modeToggleText: {
    fontSize: 13,
    color: PRIMARY,
    fontWeight: '600',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  robotEntry: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#6366F1',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
    shadowColor: '#6366F1',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  profileEntry: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: PRIMARY,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: PRIMARY,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
});