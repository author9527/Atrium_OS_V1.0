// ==========================================
// 导入页日历组件 — 基于草稿 entries 渲染
//
// 借鉴手机端主页 CalendarView 的交互（年份/月份切换、回到今天、星期表头、网格），
// 但数据源来自导入草稿 entries 而非后端月度数据：有草稿的日期格子显示「已填」标记。
// 点击日期格子调用 onDateSelect(dateStr)。
// ==========================================

import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, ScrollView } from 'react-native';
import { formatDateStr } from '../utils/date';
import type { ImportDraft } from '../utils/importDraft';

const PRIMARY = '#2FBF9F';
const TEXT = '#1F2937';

interface Props {
  draft: ImportDraft | null;
  selectedDateStr: string;
  onDateSelect: (dateStr: string) => void;
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const MONTH_NAMES = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

export default function ImportCalendar({ draft, selectedDateStr, onDateSelect }: Props) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [showYearPicker, setShowYearPicker] = useState(false);
  const [showMonthPicker, setShowMonthPicker] = useState(false);

  const todayStr = formatDateStr(today.getFullYear(), today.getMonth() + 1, today.getDate());
  const yearRange = Array.from({ length: 21 }, (_, i) => year - 10 + i);

  const prevMonth = () => {
    if (month === 1) { setYear(year - 1); setMonth(12); } else { setMonth(month - 1); }
  };
  const nextMonth = () => {
    if (month === 12) { setYear(year + 1); setMonth(1); } else { setMonth(month + 1); }
  };
  const prevYear = () => setYear(year - 1);
  const nextYear = () => setYear(year + 1);
  const goToday = () => { setYear(today.getFullYear()); setMonth(today.getMonth() + 1); };

  const isCurrentMonth = year === today.getFullYear() && month === today.getMonth() + 1;
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDayOfWeek = (new Date(year, month - 1, 1).getDay() + 6) % 7;

  const entries = draft?.entries || {};

  const cells: React.ReactNode[] = [];
  for (let i = 0; i < firstDayOfWeek; i++) {
    cells.push(<View key={`empty-${i}`} style={styles.cell} />);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = formatDateStr(year, month, day);
    const filled = !!entries[dateStr];
    const isToday = dateStr === todayStr;
    const isSelected = dateStr === selectedDateStr;
    cells.push(
      <TouchableOpacity
        key={dateStr}
        style={[
          styles.cell,
          filled && styles.cellFilled,
          isToday && styles.cellToday,
          isSelected && styles.cellSelected,
        ]}
        onPress={() => onDateSelect(dateStr)}
        activeOpacity={0.6}
      >
        <Text style={[
          styles.dayText,
          filled && styles.dayTextFilled,
          isToday && styles.dayTextToday,
          isSelected && styles.dayTextSelected,
        ]}>{day}</Text>
        <View style={styles.dotRow}>
          {filled && <View style={styles.dot} />}
        </View>
      </TouchableOpacity>
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
          <TouchableOpacity onPress={prevYear} style={styles.navBtn} activeOpacity={0.6}>
            <Text style={styles.navText}>«</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={prevMonth} style={styles.navBtn} activeOpacity={0.6}>
            <Text style={styles.navText}>‹</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.titleGroup}>
          <TouchableOpacity onPress={() => setShowYearPicker(true)} activeOpacity={0.6}>
            <Text style={styles.titleYear}>{year}年</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setShowMonthPicker(true)} activeOpacity={0.6}>
            <Text style={styles.titleMonth}>{month}月</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.navGroup}>
          <TouchableOpacity onPress={nextMonth} style={styles.navBtn} activeOpacity={0.6}>
            <Text style={styles.navText}>›</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={nextYear} style={styles.navBtn} activeOpacity={0.6}>
            <Text style={styles.navText}>»</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* 回到今天按钮 */}
      {!isCurrentMonth && (
        <TouchableOpacity onPress={goToday} style={styles.todayBtn} activeOpacity={0.7}>
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
        <View key={i} style={styles.row}>{row}</View>
      ))}

      {/* 年份选择器 */}
      <Modal visible={showYearPicker} transparent animationType="fade" onRequestClose={() => setShowYearPicker(false)}>
        <TouchableOpacity style={styles.pickerOverlay} activeOpacity={1} onPress={() => setShowYearPicker(false)}>
          <View style={styles.pickerCard} onStartShouldSetResponder={() => true}>
            <Text style={styles.pickerTitle}>选择年份</Text>
            <ScrollView style={styles.pickerList} showsVerticalScrollIndicator={false}>
              {yearRange.map((yr) => {
                const isActive = yr === year;
                return (
                  <TouchableOpacity
                    key={yr}
                    style={[styles.pickerItem, isActive && styles.pickerItemActive]}
                    onPress={() => { setYear(yr); setShowYearPicker(false); }}
                    activeOpacity={0.6}
                  >
                    <Text style={[styles.pickerItemText, isActive && styles.pickerItemTextActive]}>{yr}年</Text>
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
                const m = i + 1;
                const isActive = m === month;
                return (
                  <TouchableOpacity
                    key={m}
                    style={[styles.monthItem, isActive && styles.monthItemActive]}
                    onPress={() => { setMonth(m); setShowMonthPicker(false); }}
                    activeOpacity={0.6}
                  >
                    <Text style={[styles.monthItemText, isActive && styles.monthItemTextActive]}>{name}</Text>
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
    width: 32, height: 32, borderRadius: 10, backgroundColor: '#F2F5F4',
    alignItems: 'center', justifyContent: 'center', marginHorizontal: 2,
  },
  navText: { fontSize: 18, color: '#6B7280', fontWeight: '400' },
  titleGroup: { flexDirection: 'row', alignItems: 'baseline' },
  titleYear: { fontSize: 18, fontWeight: '700', color: TEXT },
  titleMonth: { fontSize: 18, fontWeight: '700', color: TEXT, marginLeft: 8 },
  todayBtn: {
    alignSelf: 'flex-end', paddingVertical: 5, paddingHorizontal: 12,
    borderRadius: 14, backgroundColor: '#E6F7F1', marginBottom: 8,
  },
  todayBtnText: { fontSize: 13, color: PRIMARY, fontWeight: '600' },
  weekdayRow: { flexDirection: 'row', marginBottom: 4 },
  weekdayText: {
    flex: 1, textAlign: 'center', fontSize: 12, color: '#9CA3AF',
    fontWeight: '600', paddingVertical: 4,
  },
  row: { flexDirection: 'row' },
  cell: {
    flex: 1, aspectRatio: 1.1, margin: 1, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff',
  },
  cellFilled: { backgroundColor: '#E6F7F1', borderWidth: 1, borderColor: '#A7E3D3' },
  cellToday: { borderWidth: 1.5, borderColor: '#94A3B8' },
  cellSelected: { borderWidth: 2, borderColor: PRIMARY, backgroundColor: '#D1F5EC' },
  dayText: { fontSize: 14, color: '#6B7280', fontWeight: '500' },
  dayTextFilled: { color: '#1F9B80', fontWeight: '700' },
  dayTextToday: { color: TEXT, fontWeight: '700' },
  dayTextSelected: { color: PRIMARY, fontWeight: '800' },
  dotRow: { height: 6, marginTop: 2, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: PRIMARY },

  // 选择器弹窗
  pickerOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center', alignItems: 'center',
  },
  pickerCard: {
    width: '72%', maxHeight: '60%', backgroundColor: '#fff',
    borderRadius: 20, padding: 20, paddingTop: 18,
  },
  pickerTitle: { fontSize: 17, fontWeight: '700', color: TEXT, textAlign: 'center', marginBottom: 12 },
  pickerList: { maxHeight: 300 },
  pickerItem: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 12, paddingHorizontal: 16, borderRadius: 12, marginBottom: 4,
  },
  pickerItemActive: { backgroundColor: '#E6F7F1' },
  pickerItemText: { fontSize: 17, color: '#6B7280', fontWeight: '500' },
  pickerItemTextActive: { color: PRIMARY, fontWeight: '700' },
  pickerCheck: { fontSize: 16, color: PRIMARY, fontWeight: '700' },
  monthGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  monthItem: { width: '33.33%', paddingVertical: 12, alignItems: 'center', borderRadius: 12 },
  monthItemActive: { backgroundColor: '#E6F7F1' },
  monthItemText: { fontSize: 16, color: '#6B7280', fontWeight: '500' },
  monthItemTextActive: { color: PRIMARY, fontWeight: '700' },
});