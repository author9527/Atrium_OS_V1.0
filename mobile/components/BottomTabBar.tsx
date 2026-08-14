import React from 'react';
import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import type { ComponentProps } from 'react';
import { useRouter, Href } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useInsightContext } from '../context/InsightContext';

export type TabKey = 'calendar' | 'insight' | 'relationships' | 'settings';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

const PRIMARY = '#2FBF9F';
const TEXT_MUTED = '#9CA3AF';

const TABS: { key: TabKey; label: string; active: IoniconName; inactive: IoniconName }[] = [
  { key: 'calendar', label: '主页', active: 'calendar', inactive: 'calendar-outline' },
  { key: 'insight', label: '觉察', active: 'bulb', inactive: 'bulb-outline' },
  { key: 'relationships', label: '关系', active: 'people', inactive: 'people-outline' },
  { key: 'settings', label: '设置', active: 'settings', inactive: 'settings-outline' },
];

const ROUTES: Record<TabKey, Href> = {
  calendar: '/(main)',
  insight: '/(main)/insight',
  relationships: '/(main)/relationships',
  settings: '/(main)/settings',
};

interface Props {
  active: TabKey;
}

export default function BottomTabBar({ active }: Props) {
  const router = useRouter();
  const { notification, clearNotification } = useInsightContext();

  const navigate = (key: TabKey) => {
    if (key === active) return;
    // 用户点击觉察按钮：红点消失
    if (key === 'insight') clearNotification();
    // 使用 replace 切换 tab，避免导航栈无限增长
    router.replace(ROUTES[key]);
  };

  return (
    <View style={styles.bar}>
      {TABS.map((tab) => {
        const isActive = tab.key === active;
        return (
          <TouchableOpacity
            key={tab.key}
            style={styles.item}
            onPress={() => navigate(tab.key)}
            activeOpacity={0.6}
          >
            <View style={[styles.iconWrap, isActive && styles.iconWrapActive]}>
              <Ionicons
                name={isActive ? tab.active : tab.inactive}
                size={20}
                color={isActive ? PRIMARY : TEXT_MUTED}
              />
              {/* 觉察图标左上角红点：后台生成完成且用户不在觉察页时显示 */}
              {tab.key === 'insight' && notification && <View style={styles.dot} />}
            </View>
            <Text style={[styles.label, isActive && styles.labelActive]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#EFF2F1',
    paddingTop: 8,
    paddingBottom: 6,
    paddingHorizontal: 8,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrap: {
    width: 40,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrapActive: {
    backgroundColor: '#E6F7F1',
  },
  dot: {
    position: 'absolute',
    top: -1,
    left: 2,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#EF4444',
    borderWidth: 1.5,
    borderColor: '#FFFFFF',
  },
  label: {
    fontSize: 11,
    color: TEXT_MUTED,
    marginTop: 3,
    fontWeight: '500',
  },
  labelActive: {
    color: PRIMARY,
    fontWeight: '700',
  },
});