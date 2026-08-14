import React, { useState, useCallback, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, ScrollView } from 'react-native';
import { useFocusEffect } from 'expo-router';
import EmotionCell from './EmotionCell';
import { getMonthDiaries, MonthDiary } from '../local/diary';
import { formatDateStr } from '../utils/date';

const PRIMARY = '#2FBF9F';
const TEXT = '#1F2937';

interface Props {
  onDateSelect: (dateStr: string) => void;
  displayMode: 'emotion' | 'summary';
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const MONTH_NAMES = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

export default function CalendarView({ onDateSelect, displayMode }: Props) {
  const today = new Date();
  const [currentYear, setCurrentYear] = useState(today.getFullYear());
  const [currentMonth, setCurrentMonth] = useState(today.getMonth() + 1);
  const [diaries, setDiaries] = useState<MonthDiary[]>([]);
  const [showYearPicker, setShowYearPicker] = useState(false);
  const [showMonthPicker, setShowMonthPicker] = useState(false);

  // 供轮询读取最新日记列表，避免 useCallback 闭包持有过期值
  const diariesRef = useRef(diaries);
  diariesRef.current = diaries;

  const todayStr = formatDateStr(today.getFullYear(), today.getMonth() + 1, today.getDate());

  const yearRange = Array.from({ length: 21 }, (_, i) => currentYear - 10 + i);

  const loadMonth = useCallback(async (year: number, month: number) => {
    try {
      const data = await getMonthDiaries(year, month);
      setDiaries(data);
    } catch (e) {
      console.error('加载日历失败:', e);
    }
  }, []);

  // 每次页面获得焦点（含从工作台返回、首次进入）时重新加载当月日记。
  // 日记的情绪标签由后端异步管线生成，可能需数秒到数十秒，故先加载一次，
  // 再每 3 秒轮询刷新，直到当月所有有日记的格子都带上情绪标签或超时停止。
  useFocusEffect(
    useCallback(() => {
      loadMonth(currentYear, currentMonth);

      const MAX_ATTEMPTS = 20; // 最多约 60 秒
      let attempts = 0;
      const isReady = () => {
        const list = diariesRef.current;
        if (list.length === 0) return true; // 当月无日记，无需再等
        return !list.some((d) => d.has_diary && !d.emotion);
      };

      const timer = setInterval(() => {
        attempts++;
        if (attempts >= MAX_ATTEMPTS || isReady()) {
          clearInterval(timer);
          return;
        }
        loadMonth(currentYear, currentMonth);
      }, 3000);

      return () => clearInterval(timer);
    }, [currentYear, currentMonth, loadMonth]),
  );

  const prevMonth = () => {
    if (currentMonth === 1) {
      setCurrentYear(currentYear - 1);
      setCurrentMonth(12);
    } else {
      setCurrentMonth(currentMonth - 1);
    }
  };

  const nextMonth = () => {
    if (currentMonth === 12) {
      setCurrentYear(currentYear + 1);
      setCurrentMonth(1);
    } else {
      setCurrentMonth(currentMonth + 1);
    }
  };

  const prevYear = () => setCurrentYear(currentYear - 1);
  const nextYear = () => setCurrentYear(currentYear + 1);

  const goToday = () => {
    setCurrentYear(today.getFullYear());
    setCurrentMonth(today.getMonth() + 1);
  };

  const isCurrentMonth = currentYear === today.getFullYear() && currentMonth === today.getMonth() + 1;

  const daysInMonth = new Date(currentYear, currentMonth, 0).getDate();
  const firstDayOfWeek = (new Date(currentYear, currentMonth - 1, 1).getDay() + 6) % 7;

  const diaryMap = new Map<string, MonthDiary>();
  diaries.forEach((d) => diaryMap.set(d.date, d));

  const cells: React.ReactNode[] = [];
  for (let i = 0; i < firstDayOfWeek; i++) {
    cells.push(<View key={`empty-${i}`} style={styles.cell} />);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = formatDateStr(currentYear, currentMonth, day);
    const diary = diaryMap.get(dateStr);
    cells.push(
      <EmotionCell
        key={dateStr}
        day={day}
        month={currentMonth}
        year={currentYear}
        isToday={dateStr === todayStr}
        emotion={diary?.emotion || ''}
        summary={diary?.summary || ''}
        displayMode={displayMode}
        hasDiary={!!diary?.has_diary}
        onPress={() => onDateSelect(dateStr)}
      />
    );
  }
  while (cells.length % 7 !== 0) {
    cells.push(<View key={`pad-${cells.length}`} style={styles.cell} />);
  }

  const rows: React.ReactNode[][] = [];
  for (let i = 0; i < cells.length; i += 7) {
    rows.push(cells.slice(i, i + 7));
  }

  return (
    <View style={styles.container}>
      {/* 顶部导航 */}
      <View style={styles.header}>
        <View style={styles.navGroup}>
          <TouchableOpacity onPress={prevYear} style={styles.navBtn}>
            <Text style={styles.navText}>«</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={prevMonth} style={styles.navBtn}>
            <Text style={styles.navText}>‹</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.titleGroup}>
          <TouchableOpacity onPress={() => setShowYearPicker(true)} activeOpacity={0.6}>
            <Text style={styles.titleYear}>{currentYear}年</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setShowMonthPicker(true)} activeOpacity={0.6}>
            <Text style={styles.titleMonth}>{currentMonth}月</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.navGroup}>
          <TouchableOpacity onPress={nextMonth} style={styles.navBtn}>
            <Text style={styles.navText}>›</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={nextYear} style={styles.navBtn}>
            <Text style={styles.navText}>»</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* 回到今天按钮（非当前月份时显示） */}
      {!isCurrentMonth && (
        <TouchableOpacity onPress={goToday} style={styles.todayBtn}>
          <Text style={styles.todayBtnText}>回到今天</Text>
        </TouchableOpacity>
      )}

      {/* 星期行 */}
      <View style={styles.weekdayRow}>
        {WEEKDAYS.map((w) => (
          <Text key={w} style={styles.weekdayText}>{w}</Text>
        ))}
      </View>

      {/* 日期网格 */}
      {rows.map((row, i) => (
        <View key={i} style={styles.row}>
          {row}
        </View>
      ))}

      {/* 年份选择器 */}
      <Modal visible={showYearPicker} transparent animationType="fade" onRequestClose={() => setShowYearPicker(false)}>
        <TouchableOpacity style={styles.pickerOverlay} activeOpacity={1} onPress={() => setShowYearPicker(false)}>
          <View style={styles.pickerCard} onStartShouldSetResponder={() => true}>
            <Text style={styles.pickerTitle}>选择年份</Text>
            <ScrollView style={styles.pickerList} showsVerticalScrollIndicator={false}>
              {yearRange.map((year) => {
                const isActive = year === currentYear;
                return (
                  <TouchableOpacity
                    key={year}
                    style={[styles.pickerItem, isActive && styles.pickerItemActive]}
                    onPress={() => {
                      setCurrentYear(year);
                      setShowYearPicker(false);
                    }}
                  >
                    <Text style={[styles.pickerItemText, isActive && styles.pickerItemTextActive]}>
                      {year}年
                    </Text>
                    {isActive && <Text style={styles.pickerCheck}>✓</Text>}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* 月份选择器 */}
      <Modal visible={showMonthPicker} transparent animationType="fade" onRequestClose={() => setShowMonthPicker(false)}>
        <TouchableOpacity style={styles.pickerOverlay} activeOpacity={1} onPress={() => setShowMonthPicker(false)}>
          <View style={styles.pickerCard} onStartShouldSetResponder={() => true}>
            <Text style={styles.pickerTitle}>选择月份</Text>
            <View style={styles.monthGrid}>
              {MONTH_NAMES.map((name, i) => {
                const month = i + 1;
                const isActive = month === currentMonth;
                return (
                  <TouchableOpacity
                    key={month}
                    style={[styles.monthItem, isActive && styles.monthItemActive]}
                    onPress={() => {
                      setCurrentMonth(month);
                      setShowMonthPicker(false);
                    }}
                  >
                    <Text style={[styles.monthItemText, isActive && styles.monthItemTextActive]}>
                      {name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    borderRadius: 20,
    padding: 16,
    paddingBottom: 20,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 16,
    elevation: 2,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  navGroup: { flexDirection: 'row', alignItems: 'center' },
  navBtn: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: '#F2F5F4',
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 2,
  },
  navText: { fontSize: 18, color: '#6B7280', fontWeight: '400' },
  titleGroup: { flexDirection: 'row', alignItems: 'baseline' },
  titleYear: { fontSize: 18, fontWeight: '700', color: TEXT },
  titleMonth: { fontSize: 18, fontWeight: '700', color: TEXT, marginLeft: 8 },
  todayBtn: {
    alignSelf: 'flex-end',
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: '#E6F7F1',
    marginBottom: 8,
  },
  todayBtnText: { fontSize: 13, color: PRIMARY, fontWeight: '600' },
  weekdayRow: { flexDirection: 'row', marginBottom: 4 },
  weekdayText: {
    flex: 1,
    textAlign: 'center',
    fontSize: 12,
    color: '#9CA3AF',
    fontWeight: '600',
    paddingVertical: 4,
  },
  row: { flexDirection: 'row' },
  cell: { flex: 1, aspectRatio: 1.1, margin: 1 },

  // 选择器弹窗
  pickerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  pickerCard: {
    width: '72%',
    maxHeight: '60%',
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 20,
    paddingTop: 18,
  },
  pickerTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: TEXT,
    textAlign: 'center',
    marginBottom: 12,
  },
  pickerList: {
    maxHeight: 300,
  },
  pickerItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    marginBottom: 4,
  },
  pickerItemActive: {
    backgroundColor: '#E6F7F1',
  },
  pickerItemText: {
    fontSize: 17,
    color: '#6B7280',
    fontWeight: '500',
  },
  pickerItemTextActive: {
    color: PRIMARY,
    fontWeight: '700',
  },
  pickerCheck: {
    fontSize: 16,
    color: PRIMARY,
    fontWeight: '700',
  },
  monthGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  monthItem: {
    width: '33.33%',
    paddingVertical: 12,
    alignItems: 'center',
    borderRadius: 12,
  },
  monthItemActive: {
    backgroundColor: '#E6F7F1',
  },
  monthItemText: {
    fontSize: 16,
    color: '#6B7280',
    fontWeight: '500',
  },
  monthItemTextActive: {
    color: PRIMARY,
    fontWeight: '700',
  },
});