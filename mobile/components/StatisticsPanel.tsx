import React, { useCallback, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import EmotionRadarChart from './EmotionRadarChart';
import FishboneChart from './FishboneChart';
import {
  getEmotionRadar,
  getFishbone,
  runFishboneExtract,
  EmotionRadarData,
  FishboneEvent,
  FishboneProgress,
  packEmotionContext,
  packFishboneContext,
} from '../local/statistics';

type TabKey = 'emotion' | 'fishbone';

const PRIMARY = '#2FBF9F';
const TEXT = '#1F2937';
const SUB_TEXT = '#64748B';
const TAB_BG = '#F1F5F4';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'emotion', label: '情绪' },
  { key: 'fishbone', label: '摘要' },
];

interface CacheState {
  emotion?: EmotionRadarData;
  fishbone?: FishboneEvent[];
}

export default function StatisticsPanel() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<TabKey>('emotion');

  // 每个 Tab 独立：data 缓存、loading、error
  const [cache, setCache] = useState<CacheState>({});
  const [loading, setLoading] = useState<Record<TabKey, boolean>>({
    emotion: false,
    fishbone: false,
  });
  const [error, setError] = useState<Record<TabKey, boolean>>({
    emotion: false,
    fishbone: false,
  });

  // 摘要鱼骨生成状态
  const [fishboneGenerating, setFishboneGenerating] = useState(false);
  const [fishboneProgress, setFishboneProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });

  // 供轮询读取最新缓存，避免 useCallback 闭包持有过期值
  const cacheRef = useRef(cache);
  cacheRef.current = cache;

  const loadEmotion = useCallback(async () => {
    setLoading((p) => ({ ...p, emotion: true }));
    setError((p) => ({ ...p, emotion: false }));
    try {
      const res = await getEmotionRadar();
      setCache((p) => ({ ...p, emotion: res }));
    } catch (e: any) {
      console.error('加载情绪雷达失败:', e?.message || e);
      setError((p) => ({ ...p, emotion: true }));
    } finally {
      setLoading((p) => ({ ...p, emotion: false }));
    }
  }, []);

  const loadFishbone = useCallback(async () => {
    setLoading((p) => ({ ...p, fishbone: true }));
    setError((p) => ({ ...p, fishbone: false }));
    try {
      const res = await getFishbone();
      setCache((p) => ({ ...p, fishbone: res.events }));
    } catch (e: any) {
      console.error('加载事件失败:', e?.message || e);
      setError((p) => ({ ...p, fishbone: true }));
    } finally {
      setLoading((p) => ({ ...p, fishbone: false }));
    }
  }, []);

  // 手动生成摘要鱼骨：幂等补齐缺失日期的摘要，实时显示进度，完成后刷新图表
  const handleGenerateFishbone = useCallback(async () => {
    if (fishboneGenerating) return;
    setFishboneGenerating(true);
    setFishboneProgress({ done: 0, total: 0 });
    try {
      const res = await runFishboneExtract((p: FishboneProgress) => {
        setFishboneProgress({ done: p.done, total: p.total });
      });
      setFishboneProgress({ done: res.added, total: res.total });
      await loadFishbone();
    } catch (e: any) {
      console.error('生成摘要失败:', e?.message || e);
    } finally {
      setFishboneGenerating(false);
    }
  }, [fishboneGenerating, loadFishbone]);

  const switchTab = (key: TabKey) => {
    setActiveTab(key);
    // 首次切换到该 Tab 且无缓存时才加载
    if (cache[key] === undefined && !loading[key] && !error[key]) {
      if (key === 'emotion') loadEmotion();
      else loadFishbone();
    }
  };

  // 每次页面获得焦点（含首次进入、从工作台返回）时刷新当前 Tab 数据。
  // 情绪打分等由后端异步管线生成，可能需要数秒到数十秒，因此先加载一次，
  // 再每 3 秒轮询刷新，直到拿到有效数据或超过最大次数后自动停止。
  // 摘要鱼骨图不启用轮询：摘要由退出时增量提取触发，且可能为空，仅加载一次。
  useFocusEffect(
    useCallback(() => {
      const loadForTab = () => {
        if (activeTab === 'emotion') loadEmotion();
        else loadFishbone();
      };
      loadForTab();

      // fishbone 不做轮询
      if (activeTab === 'fishbone') return;

      const MAX_ATTEMPTS = 20; // 最多约 60 秒
      let attempts = 0;
      const isReady = () => {
        const c = cacheRef.current[activeTab];
        const e = c as EmotionRadarData | undefined;
        if (!e) return false;
        if ((e.total_diaries ?? 0) === 0) return true; // 无日记，无需再等
        // 张力固定返回 4 个槽位，需至少一个非空 value 才算真正就绪
        const tensionReady = (e.tension ?? []).some((t) => t.value != null);
        return (e.recent10_count ?? 0) + (e.recent30_count ?? 0) > 0 || tensionReady;
      };

      const timer = setInterval(() => {
        attempts++;
        if (attempts >= MAX_ATTEMPTS || isReady()) {
          clearInterval(timer);
          return;
        }
        loadForTab();
      }, 3000);

      return () => clearInterval(timer);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTab]),
  );

  const handleEnterChat = useCallback(() => {
    let context = '';
    const chartType = activeTab;
    if (activeTab === 'emotion' && cache.emotion) {
      context = packEmotionContext(cache.emotion);
    } else if (activeTab === 'fishbone' && cache.fishbone) {
      context = packFishboneContext(cache.fishbone);
    }
    router.push({ pathname: '/(main)/stats-chat', params: { chartType, context } });
  }, [activeTab, cache, router]);

  const renderError = (retry: () => void) => (
    <View style={styles.centerCol}>
      <Text style={styles.errorText}>加载失败，稍后再试试</Text>
      <TouchableOpacity style={styles.retryBtn} onPress={retry} activeOpacity={0.7}>
        <Text style={styles.retryText}>重试</Text>
      </TouchableOpacity>
    </View>
  );

  const renderContent = () => {
    if (loading[activeTab]) {
      return (
        <View style={styles.centerFill}>
          <ActivityIndicator size="large" color={PRIMARY} />
        </View>
      );
    }
    if (error[activeTab]) {
      const retry = activeTab === 'emotion' ? loadEmotion : loadFishbone;
      return renderError(retry);
    }

    if (activeTab === 'emotion') {
      const emotion = cache.emotion;
      if (!emotion) return null;
      // 双雷达横向排布：近30天(左) / 近10天(右)，无数据时组件内部显示空心雷达
      return <EmotionRadarChart data={emotion} />;
    }

    if (activeTab === 'fishbone') {
      const hasEvents = !!cache.fishbone && cache.fishbone.length > 0;
      return (
        <View>
          {hasEvents ? (
            <FishboneChart
              events={cache.fishbone!}
              onRefresh={loadFishbone}
            />
          ) : (
            <View style={styles.centerCol}>
              <Text style={styles.emptyText}>还没有摘要</Text>
              <Text style={styles.emptyHint}>点击下方按钮，为历史日记生成生活摘要</Text>
            </View>
          )}
          <TouchableOpacity
            style={[styles.genBtn, fishboneGenerating && styles.genBtnDisabled]}
            onPress={handleGenerateFishbone}
            disabled={fishboneGenerating}
            activeOpacity={0.8}
          >
            {fishboneGenerating ? (
              <View style={styles.genRow}>
                <ActivityIndicator size="small" color="#fff" />
                <Text style={styles.genBtnText}>
                  生成中 {fishboneProgress.done}/{fishboneProgress.total || '…'}
                </Text>
              </View>
            ) : (
              <Text style={styles.genBtnText}>生成摘要</Text>
            )}
          </TouchableOpacity>
        </View>
      );
    }

    return null;
  };

  return (
    <View style={styles.card}>
      {/* Tab 栏 */}
      <View style={styles.tabBar}>
        {TABS.map((tab) => {
          const active = activeTab === tab.key;
          return (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tabItem, active && styles.tabItemActive]}
              onPress={() => switchTab(tab.key)}
              activeOpacity={0.7}
            >
              <Text style={[styles.tabText, active && styles.tabTextActive]}>{tab.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* 内容区：自适应高度，不固定，避免按钮被挤出屏幕 */}
      <View style={styles.content}>
        {renderContent()}
      </View>

      {/* 进入对话空间按钮 */}
      <TouchableOpacity style={styles.chatBtn} onPress={handleEnterChat} activeOpacity={0.8}>
        <Text style={styles.chatBtnText}>进入对话空间</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: 20,
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 12,
    padding: 14,
    elevation: 2,
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: TAB_BG,
    borderRadius: 12,
    padding: 4,
    marginBottom: 12,
  },
  tabItem: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabItemActive: {
    backgroundColor: PRIMARY,
  },
  tabText: {
    fontSize: 14,
    fontWeight: '600',
    color: SUB_TEXT,
  },
  tabTextActive: {
    color: '#fff',
  },
  content: {
    // 自适应高度，内容有多少显示多少，避免固定高度把下方按钮挤出屏幕
    minHeight: 120,
    paddingVertical: 4,
  },
  centerFill: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    paddingHorizontal: 20,
  },
  centerCol: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
  },
  errorText: {
    fontSize: 14,
    color: SUB_TEXT,
    marginBottom: 12,
  },
  retryBtn: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: PRIMARY,
  },
  retryText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
  },
  emptyText: { fontSize: 15, color: '#94a3b8' },
  emptyHint: { fontSize: 12, color: '#cbd5e1', marginTop: 6 },
  genBtn: {
    marginTop: 12,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#4f46e5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  genBtnDisabled: { opacity: 0.6 },
  genBtnText: { fontSize: 15, fontWeight: '700', color: '#fff' },
  genRow: { flexDirection: 'row', alignItems: 'center' },
  chatBtn: {
    marginTop: 12,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: PRIMARY,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatBtnText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
  },
});