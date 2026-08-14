import React, { useRef, useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { FishboneEvent } from '../local/statistics';

interface Props {
  events: FishboneEvent[];
  onRefresh: () => void;
}

export default function FishboneChart({ events, onRefresh }: Props) {
  const scrollRef = useRef<ScrollView>(null);

  // 默认展示最近的（最右侧）；数据更新后也自动定位到最新
  useEffect(() => {
    if (events.length > 0 && scrollRef.current) {
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }));
    }
  }, [events.length]);

  if (events.length === 0) {
    return (
      <View style={styles.emptyWrap}>
        <Text style={styles.empty}>还没有摘要</Text>
        <Text style={styles.emptyHint}>点击按钮为历史日记生成生活摘要</Text>
      </View>
    );
  }
  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.scroll}
    >
      {events.map((e, i) => (
        <View key={`${e.id}-${i}`} style={styles.item}>
          <View style={styles.dot} />
          <View style={styles.card}>
            <Text style={styles.date}>{e.date}</Text>
            <Text style={styles.title}>{e.summary}</Text>
          </View>
          {i < events.length - 1 && <View style={styles.line} />}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { alignItems: 'center', paddingVertical: 16, paddingHorizontal: 12 },
  item: { flexDirection: 'row', alignItems: 'center' },
  dot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#4f46e5', marginRight: 8 },
  card: { backgroundColor: '#eef2ff', borderRadius: 12, padding: 12, width: 170, marginRight: -4 },
  date: { fontSize: 12, color: '#4f46e5', fontWeight: '600', marginBottom: 4 },
  title: { fontSize: 14, fontWeight: '700', color: '#1e293b', marginBottom: 4 },
  summary: { fontSize: 12, color: '#475569', lineHeight: 18 },
  line: { width: 24, height: 2, backgroundColor: '#e2e8f0', marginHorizontal: 4 },
  emptyWrap: { alignItems: 'center', justifyContent: 'center', padding: 32 },
  empty: { fontSize: 15, color: '#94a3b8' },
  emptyHint: { fontSize: 12, color: '#cbd5e1', marginTop: 6 },
});