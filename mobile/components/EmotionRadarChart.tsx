import React, { useRef } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { WebView } from 'react-native-webview';
import { EmotionRadarData, TensionItem } from '../local/statistics';

interface Props {
  data: EmotionRadarData;
}

const MAX = 100; // 打分为 0-100，雷达刻度固定，避免小均值被放大
const COLOR_30 = '#10B981'; // 近30天 绿
const COLOR_10 = '#3B82F6'; // 近10天 蓝

// 张力柱：可视窗口一次显示 4 根，可横向拖动看更早的柱子
const VISIBLE_BARS = 4;
const SLOT = 32, barW = 16;

/** 合并均值雷达 SVG：叠加近30天(绿)与近10天(蓝)两条均值轮廓。 */
function buildRadarHtml(axes: string[], v30: number[] | null, v10: number[] | null): string {
  // 画布略大于图形，四周留足边距，避免边缘情绪标签（愤怒/恐惧）被截断
  const size = 160;
  const cx = 80, cy = 80, r = 46;
  const angleOf = (i: number) => (Math.PI * 2 * i) / axes.length - Math.PI / 2;

  const polyPoints = (v: number[]) =>
    v.map((val, i) => {
      const rr = (val / MAX) * r;
      const x = cx + rr * Math.cos(angleOf(i));
      const y = cy + rr * Math.sin(angleOf(i));
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');

  const grid = Array.from({ length: 4 }, (_, idx) => {
    const rr = (r * (idx + 1)) / 4;
    const pts = axes.map((_, i) => {
      const x = cx + rr * Math.cos(angleOf(i));
      const y = cy + rr * Math.sin(angleOf(i));
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<polygon points="${pts}" fill="none" stroke="#e2e8f0" stroke-width="1"/>`;
  }).join('');

  const spokes = axes.map((_, i) => {
    const x = cx + r * Math.cos(angleOf(i));
    const y = cy + r * Math.sin(angleOf(i));
    return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e2e8f0" stroke-width="1"/>`;
  }).join('');

  const labels = axes.map((name, i) => {
    const lr = r + 11;
    const x = cx + lr * Math.cos(angleOf(i));
    const y = cy + lr * Math.sin(angleOf(i));
    // 左右边缘轴朝内对齐，避免越界被截断
    const anchor = Math.abs(x - cx) < 8 ? 'middle' : (x > cx ? 'start' : 'end');
    return `<text x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="${anchor}" font-size="9" fill="#64748b">${name}</text>`;
  }).join('');

  const poly30 = v30 && v30.some((v) => v > 0)
    ? `<polygon points="${polyPoints(v30)}" fill="${COLOR_30}26" stroke="${COLOR_30}" stroke-width="2"/>`
    : '';
  const poly10 = v10 && v10.some((v) => v > 0)
    ? `<polygon points="${polyPoints(v10)}" fill="${COLOR_10}26" stroke="${COLOR_10}" stroke-width="2"/>`
    : '';

  return `<!DOCTYPE html><html><head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  </head><body style="margin:0;display:flex;align-items:center;justify-content:center;background:transparent;touch-action:none;overflow:hidden">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="user-select:none;-webkit-user-select:none;touch-action:none">
      ${grid}${spokes}${poly30}${poly10}${labels}
    </svg></body></html>`;
}

/** 张力柱状图 SVG：渲染全部槽位（含日期刻度），value 为 null 的槽位只画日期不画柱子。
 * 顶部标记线(100)下方留足空间，避免被 WebView 顶部裁切。 */
function buildTensionHtml(tension: TensionItem[]): string {
  // 顶部多留 14px 给刻度标记，避免 "100" 贴边被截断
  const H = 158;
  const topPad = 22, baseY = 128, topY = topPad, maxH = baseY - topY;
  const W = Math.max(SLOT, tension.length * SLOT);

  const colorFor = (v: number): string => {
    if (v <= 100) return '#F59E0B';
    if (v <= 130) return '#D97706';
    if (v <= 170) return '#B45309';
    return '#78350F';
  };

  const slots = tension.map((t, i) => {
    const dateLabel = (t?.date || '').slice(5) || '--';
    const x = i * SLOT + (SLOT - barW) / 2;
    let bar = '';
    if (t && t.value != null) {
      const v = Math.round(t.value);
      const h = Math.min(v, MAX);
      const barH = (h / MAX) * maxH;
      const y = baseY - barH;
      const color = colorFor(v);
      bar = `
        <rect x="${x}" y="${y}" width="${barW}" height="${barH}" rx="3" fill="${color}"/>
        <text x="${x + barW / 2}" y="${y - 4}" text-anchor="middle" font-size="9" font-weight="700" fill="#1f2937" font-family="sans-serif">${v}</text>`;
    }
    return `${bar}
      <text x="${x + barW / 2}" y="146" text-anchor="middle" font-size="8" fill="#64748b" font-family="sans-serif">${dateLabel}</text>`;
  }).join('');

  return `<!DOCTYPE html><html><head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <style>html,body{background:transparent}</style>
  </head><body style="margin:0;background:transparent;touch-action:none;overflow:hidden">
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="user-select:none;-webkit-user-select:none;touch-action:none">
      <line x1="0" y1="${baseY}" x2="${W}" y2="${baseY}" stroke="#e2e8f0" stroke-width="1"/>
      <line x1="0" y1="${topY}" x2="${W}" y2="${topY}" stroke="#e2e8f0" stroke-width="1" stroke-dasharray="2 3"/>
      ${slots}
    </svg></body></html>`;
}

export default function EmotionRadarChart({ data }: Props) {
  const recent30Empty = (data.recent30_count ?? 0) === 0;
  const recent10Empty = (data.recent10_count ?? 0) === 0;

  const htmlRadar = React.useMemo(
    () => buildRadarHtml(data.axes, recent30Empty ? null : data.recent30, recent10Empty ? null : data.recent10),
    [data, recent30Empty, recent10Empty],
  );
  const tension = data.tension ?? [];
  const htmlTension = React.useMemo(() => buildTensionHtml(tension), [tension]);
  // 全部槽位总宽度（横向滚动内容）
  const fullWidth = Math.max(SLOT, tension.length * SLOT);
  const scrollRef = useRef<ScrollView>(null);
  // 数据就绪后定位到最右（最新 4 根），想看更早的往右拖
  React.useEffect(() => {
    if (tension.length > VISIBLE_BARS && scrollRef.current) {
      // 等一帧确保 ScrollView 已布局
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }));
    }
  }, [tension.length, fullWidth]);

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        {/* 情绪雷达图框：标题左上，图例右上（近10天上/近30天下） */}
        <View style={styles.box}>
          <View style={styles.header}>
            <Text style={styles.title}>情绪雷达图</Text>
            <View style={styles.legend}>
              <View style={styles.legendItem}>
                <View style={[styles.dot, { backgroundColor: COLOR_10 }]} />
                <Text style={styles.legendText}>近10天</Text>
              </View>
              <View style={styles.legendItem}>
                <View style={[styles.dot, { backgroundColor: COLOR_30 }]} />
                <Text style={styles.legendText}>近30天</Text>
              </View>
            </View>
          </View>
          <WebView
            key="radar"
            originWhitelist={['*']}
            source={{ html: htmlRadar }}
            style={styles.radar}
            scrollEnabled={false}
            nestedScrollEnabled={false}
            overScrollMode="never"
            bounces={false}
            javaScriptEnabled={false}
            domStorageEnabled={false}
          />
        </View>

        {/* 情绪张力框：标题左上，可视窗口 4 根，可横向拖动 */}
        <View style={[styles.box, styles.tensionBox]}>
          <View style={styles.header}>
            <Text style={styles.title}>情绪张力</Text>
          </View>
          <View style={styles.tensionWrap}>
            <ScrollView
              ref={scrollRef}
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.tensionScroll}
              contentContainerStyle={{ width: fullWidth }}
              nestedScrollEnabled
            >
              <WebView
                key="tension"
                originWhitelist={['*']}
                source={{ html: htmlTension }}
                style={{ width: fullWidth, height: 158 }}
                scrollEnabled={false}
                nestedScrollEnabled={false}
                overScrollMode="never"
                bounces={false}
                javaScriptEnabled={false}
                domStorageEnabled={false}
              />
            </ScrollView>
            {/* "100" 刻度固定在可视区右上角，不随横向拖动移动 */}
            <Text style={styles.hundredLabel}>100</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingVertical: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    justifyContent: 'center',
    gap: 8,
  },
  box: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    padding: 8,
  },
  tensionBox: {
    width: VISIBLE_BARS * SLOT + 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  title: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1e293b',
    letterSpacing: 0.5,
  },
  legend: {
    alignItems: 'flex-end',
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 4,
  },
  legendText: {
    fontSize: 10,
    color: '#475569',
  },
  radar: {
    width: 160,
    height: 160,
    backgroundColor: 'transparent',
  },
  tensionScroll: {
    width: VISIBLE_BARS * SLOT,
    height: 158,
  },
  tensionWrap: {
    position: 'relative',
    width: VISIBLE_BARS * SLOT,
    height: 158,
  },
  hundredLabel: {
    position: 'absolute',
    top: 9,
    right: 2,
    fontSize: 8,
    color: '#94a3b8',
  },
});