import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { FlatBranch } from '../local/insight';

interface Props {
  branch: FlatBranch;
  onPress: () => void;
}

export default function InsightCard({ branch, onPress }: Props) {
  const date = new Date(branch.timestamp);
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.8}>
      <View style={styles.indigoBar} />
      <View style={styles.cardContent}>
        <Text style={styles.title} numberOfLines={2}>{branch.title}</Text>
        <Text style={styles.observation} numberOfLines={3}>{branch.observation}</Text>
        {branch.question ? (
          <View style={styles.questionPreview}>
            <Ionicons name="help-circle" size={13} color="#4f46e5" />
            <Text style={styles.questionText} numberOfLines={2}>{branch.question}</Text>
          </View>
        ) : null}
        <View style={styles.footer}>
          <View style={styles.metaRow}>
            <Ionicons name="bulb" size={14} color="#6366f1" />
            <Text style={styles.meta}>{dateStr} · {branch.diaryCount}篇日记</Text>
          </View>
          <Text style={styles.exploreHint}>展开探索 →</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderRadius: 12,
    marginHorizontal: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#f1f5f9',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
    overflow: 'hidden',
  },
  indigoBar: {
    width: 4,
    backgroundColor: '#6366f1',
  },
  cardContent: {
    flex: 1,
    padding: 16,
  },
  title: { fontSize: 15, fontWeight: 'bold', color: '#111827', lineHeight: 22, marginBottom: 6 },
  observation: { fontSize: 14, color: '#4b5563', lineHeight: 22, marginBottom: 10 },
  questionPreview: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#eef2ff',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 10,
  },
  questionText: { fontSize: 13, color: '#312e81', marginLeft: 4, flex: 1, lineHeight: 18 },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  metaRow: { flexDirection: 'row', alignItems: 'center' },
  meta: { fontSize: 12, color: '#94a3b8', marginLeft: 4 },
  exploreHint: { fontSize: 12, color: '#6366f1', fontWeight: '600' },
});
