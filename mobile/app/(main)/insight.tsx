import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import InsightCard from '../../components/InsightCard';
import BranchDetailModal from '../../components/BranchDetailModal';
import { getInsightHistory, deleteInsightResult, InsightHistoryItem, InsightBranch, InsightResult, FlatBranch, normalizeEvidence } from '../../local/insight';
import BottomTabBar from '../../components/BottomTabBar';
import { useInsightContext } from '../../context/InsightContext';

const PRIMARY = '#2FBF9F';
const TEXT = '#1F2937';
const TEXT_SUB = '#8A94A6';
const BG = '#F5F7F6';

export default function InsightScreen() {
  const { generating, startGeneration, reportFocus, completionToken, lastResult, resetCompletion } = useInsightContext();
  const [history, setHistory] = useState<InsightHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 两级导航：null = 记录列表；非 null = 该记录的卡片列表
  const [selectedRecord, setSelectedRecord] = useState<InsightHistoryItem | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<FlatBranch | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getInsightHistory();
      setHistory(data || []);
    } catch (e: any) {
      setError(e.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadHistory();
    setRefreshing(false);
  };

  // 觉察页焦点变化上报给全局上下文（用于判断生成完成时用户是否在本页）
  useFocusEffect(
    useCallback(() => {
      reportFocus(true);
      return () => reportFocus(false);
    }, [reportFocus]),
  );

  /** 把 InsightResult 转成列表项（与历史刷新后的结构一致） */
  const toHistoryItem = useCallback((result: InsightResult): InsightHistoryItem => ({
    id: result.id,
    timestamp: result.timestamp,
    diary_count: result.diary_count,
    date_range: result.date_range,
    elapsed_seconds: result.elapsed_seconds,
    branch_count: (result.branches || []).length,
    preview: (result.branches || []).map((b) => b.title).join('、') || '觉察分析',
    branches: result.branches,
  }), []);

  // 后台生成完成且用户正在本页时，直接进入该报告的分点卡片展示页面
  // 消费一次后立即重置 completionToken，避免重进本页时再次触发导航
  useEffect(() => {
    if (completionToken === 0) return;
    if (lastResult && lastResult.id) {
      loadHistory();
      setSelectedRecord(toHistoryItem(lastResult));
    }
    resetCompletion();
  }, [completionToken, lastResult, loadHistory, toHistoryItem, resetCompletion]);

  // 将选中记录的 branches 转为 FlatBranch 列表
  const getBranches = (record: InsightHistoryItem): FlatBranch[] => {
    return (record.branches || []).map((branch: InsightBranch) => ({
      resultId: record.id,
      branchId: branch.id,
      title: branch.title,
      observation: branch.observation,
      evidence: normalizeEvidence(branch.evidence),
      question: branch.question,
      conversation: branch.conversation || [],
      timestamp: record.timestamp,
      diaryCount: record.diary_count,
      dateRange: record.date_range,
    }));
  };

  const formatDate = (ts: string) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  // 删除指定觉察报告（先确认，再调用接口并刷新列表）
  const handleDelete = (record: InsightHistoryItem) => {
    Alert.alert('删除觉察报告', `确定要删除「${record.date_range}」这份报告吗？\n其下所有支线和对话将一并删除，且无法恢复。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteInsightResult(record.id);
            // 若正在查看的就是被删除的记录，先退回列表
            if (selectedRecord?.id === record.id) setSelectedRecord(null);
            await loadHistory();
          } catch (e: any) {
            Alert.alert('删除失败', e?.message || '请稍后重试');
          }
        },
      },
    ]);
  };

  // ========== 第二级：选中记录的卡片列表 ==========
  if (selectedRecord) {
    const branches = getBranches(selectedRecord);
    return (
      <SafeAreaView edges={['top', 'bottom']} style={styles.container}>
        <View style={styles.subHeader}>
          <TouchableOpacity onPress={() => setSelectedRecord(null)} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color={TEXT} />
          </TouchableOpacity>
          <View style={styles.subHeaderInfo}>
            <Text style={styles.subHeaderTitle} numberOfLines={1}>{selectedRecord.date_range}</Text>
            <Text style={styles.subHeaderMeta}>
              {formatDate(selectedRecord.timestamp)} · {selectedRecord.diary_count}篇日记 · {branches.length}条觉察
            </Text>
          </View>
          <TouchableOpacity
            style={styles.deleteBtnHeader}
            onPress={() => handleDelete(selectedRecord)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="trash-outline" size={18} color="#EF4444" />
          </TouchableOpacity>
        </View>
        {branches.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.emptyText}>这段日子还没沉淀出觉察</Text>
          </View>
        ) : (
          <FlatList
            data={branches}
            renderItem={({ item }) => (
              <InsightCard branch={item} onPress={() => setSelectedBranch(item)} />
            )}
            keyExtractor={item => `${item.resultId}-${item.branchId}`}
            contentContainerStyle={styles.list}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          />
        )}
        <BranchDetailModal
          branch={selectedBranch}
          visible={!!selectedBranch}
          onClose={() => setSelectedBranch(null)}
        />
      </SafeAreaView>
    );
  }

  // ========== 第一级：觉察记录列表 ==========
  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.container}>
      {/* 顶部标题区 */}
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>觉察</Text>
          <Text style={styles.subGreeting}>看见情绪，更懂自己</Text>
        </View>
        <TouchableOpacity
          style={styles.generateBtn}
          onPress={startGeneration}
          disabled={generating}
          activeOpacity={0.7}
        >
          {generating ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Ionicons name="sparkles" size={16} color="#fff" />
          )}
          <Text style={styles.generateText}>{generating ? '生成中' : '生成报告'}</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator size="large" color={PRIMARY} style={styles.loader} />
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>加载失败: {error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={loadHistory}>
            <Text style={styles.retryText}>重试</Text>
          </TouchableOpacity>
        </View>
      ) : history.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="bulb-outline" size={64} color="#DCE4E1" />
          <Text style={styles.emptyText}>还没有觉察报告</Text>
          <Text style={styles.emptyHint}>觉察助手会在每周日自动整理你的日记</Text>
        </View>
      ) : (
        <FlatList
          data={history}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.recordCard}
              onPress={() => setSelectedRecord(item)}
              activeOpacity={0.8}
            >
              <View style={styles.indigoBar} />
              <TouchableOpacity
                style={styles.deleteBtn}
                onPress={() => handleDelete(item)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="trash-outline" size={16} color="#C2CBC7" />
              </TouchableOpacity>
              <View style={styles.recordContent}>
                <View style={styles.recordHeader}>
                  <Ionicons name="bulb" size={16} color={PRIMARY} />
                  <Text style={styles.recordDate}>{item.date_range}</Text>
                </View>
                <Text style={styles.recordPreview} numberOfLines={3}>{item.preview}</Text>
                <View style={styles.recordFooter}>
                  <Text style={styles.recordMeta}>
                    {formatDate(item.timestamp)} · {item.diary_count}篇日记 · {item.branch_count}条觉察
                  </Text>
                  <Ionicons name="chevron-forward" size={16} color="#C2CBC7" />
                </View>
              </View>
            </TouchableOpacity>
          )}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        />
      )}

      {/* 底部导航 */}
      <BottomTabBar active="insight" />
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
  greeting: {
    fontSize: 24,
    fontWeight: '700',
    color: TEXT,
  },
  subGreeting: {
    fontSize: 13,
    color: TEXT_SUB,
    marginTop: 4,
  },
  generateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: PRIMARY,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 20,
    shadowColor: PRIMARY,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 3,
  },
  generateText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
    marginLeft: 5,
  },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  list: { paddingTop: 4, paddingBottom: 100 },
  loader: { marginTop: 40 },
  emptyText: { fontSize: 16, color: '#9CA3AF', marginTop: 12, marginBottom: 4 },
  emptyHint: { fontSize: 13, color: '#C2CBC7' },
  errorText: { fontSize: 14, color: '#EF4444', textAlign: 'center', marginBottom: 12 },
  retryBtn: {
    backgroundColor: PRIMARY,
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 20,
  },
  retryText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  // 记录卡片样式
  recordCard: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderRadius: 16,
    marginHorizontal: 16,
    marginBottom: 12,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 12,
    elevation: 2,
    overflow: 'hidden',
  },
  indigoBar: {
    width: 4,
    backgroundColor: PRIMARY,
  },
  deleteBtn: {
    position: 'absolute',
    top: 12,
    right: 12,
    padding: 6,
    zIndex: 2,
  },
  deleteBtnHeader: {
    padding: 6,
    marginLeft: 8,
  },
  recordContent: {
    flex: 1,
    padding: 16,
  },
  recordHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  recordDate: {
    fontSize: 15,
    fontWeight: '700',
    color: TEXT,
    marginLeft: 6,
  },
  recordPreview: {
    fontSize: 14,
    color: '#5B6472',
    lineHeight: 21,
    marginBottom: 10,
  },
  recordFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  recordMeta: {
    fontSize: 12,
    color: '#9CA3AF',
  },
  // 子页面头部
  subHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  backBtn: {
    padding: 6,
    marginRight: 8,
  },
  subHeaderInfo: {
    flex: 1,
  },
  subHeaderTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: TEXT,
  },
  subHeaderMeta: {
    fontSize: 12,
    color: '#9CA3AF',
    marginTop: 2,
  },
});