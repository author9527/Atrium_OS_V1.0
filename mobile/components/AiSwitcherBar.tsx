import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

export interface AiOption {
  key: string;
  label: string;
  icon: IoniconName;
  color?: string;
}

interface Props {
  options: AiOption[];
  activeKey: string;
  onSelect: (key: string) => void;
  disabled?: boolean;
}

const DEFAULT_COLOR = '#2FBF9F';

export default function AiSwitcherBar({ options, activeKey, onSelect, disabled = false }: Props) {
  return (
    <View style={styles.wrap}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.content}
      >
        {options.map((opt) => {
          const active = opt.key === activeKey;
          const color = opt.color || DEFAULT_COLOR;
          return (
            <TouchableOpacity
              key={opt.key}
              style={[styles.chip, active && { backgroundColor: color, borderColor: color }]}
              onPress={() => onSelect(opt.key)}
              disabled={disabled}
              activeOpacity={0.7}
            >
              <Ionicons name={opt.icon} size={15} color={active ? '#fff' : color} />
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
    backgroundColor: '#fff',
  },
  content: {
    gap: 8,
    paddingRight: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  chipText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#475569',
    marginLeft: 5,
  },
  chipTextActive: {
    color: '#fff',
  },
});