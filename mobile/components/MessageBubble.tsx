import React, { useState, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Modal, ScrollView, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Markdown from 'react-native-markdown-display';
import { Clipboard } from 'react-native';

export interface ChatMessageBase {
  role: string;
  content: string;
  thinking?: string;
  sources?: { index: number; title: string; url: string }[];
}

// 匹配 [1]、[12] 形式的角标标记
const CITE_RE = /\[(\d+)\]/g;

interface Props {
  msg: ChatMessageBase;
  isStreaming?: boolean;
}

const PERSONA_COLORS: Record<string, string> = {
  big_brother: '#3b82f6',
  second_brother: '#ef4444',
  little_sister: '#ec4899',
  assistant: '#6366f1',
  insight: '#f59e0b',
  empathy: '#6366f1',
  awareness: '#f59e0b',
  system: '#94a3b8',
};

const SPEAKER_LABELS: Record<string, string> = {
  big_brother: '鳄正经',
  second_brother: '鹅小弟',
  little_sister: '鹿晓葵',
  assistant: '共情助手',
  insight: '觉察助手',
  empathy: '共情助手',
  awareness: '觉察助手',
  system: '',
};

// 所有非用户、非系统的 AI 回复都使用 markdown 渲染
// 包括：共情助手(assistant)、觉察助手(insight)、气氛组三个人设
const MARKDOWN_ROLES = new Set(['assistant', 'insight', 'big_brother', 'second_brother', 'little_sister']);

export default function MessageBubble({ msg, isStreaming = false }: Props) {
  const [userToggled, setUserToggled] = useState(false);
  const [userShowThinking, setUserShowThinking] = useState(false);
  const [openSource, setOpenSource] = useState<number | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const isUser = msg.role === 'user';
  const speakerLabel = SPEAKER_LABELS[msg.role] || '';
  const speakerColor = PERSONA_COLORS[msg.role] || '#64748b';
  const hasThinking = !!(msg.thinking && msg.thinking.trim().length > 0);
  const hasContent = !!(msg.content && msg.content.trim().length > 0);
  const useMarkdown = MARKDOWN_ROLES.has(msg.role);
  const sources = msg.sources || [];
  // 开发调试日志：验证 sources 完整链路（DB→chat.ts→页面→MessageBubble）
  if (sources.length > 0 && !isUser) {
    console.log(`[MessageBubble] 收到 ${sources.length} 条引用来源:`, sources.map(s => `[${s.index}] ${s.title}`).join(', '));
  }

  // 流式输出中：自动控制思考过程展开/折叠
  // - 有思考内容且无回复内容 → 展开（实时展示思考）
  // - 回复内容开始出现 → 自动折叠
  // 用户手动点击后：切换为用户控制
  const showThinking = userToggled
    ? userShowThinking
    : isStreaming
      ? (hasThinking && !hasContent)
      : false;

  const toggleThinking = () => {
    setUserToggled(true);
    setUserShowThinking(!showThinking);
  };

  // 复制来源链接到剪贴板
  const copySourceUrl = (index: number, url: string) => {
    try {
      Clipboard.setString(url);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 1500);
    } catch (e) {
      // 复制失败静默处理
    }
  };

  // markdown 样式：根据气泡类型（用户/助手）调整文字颜色
  const markdownStyle = useMemo(() => {
    const baseColor = isUser ? '#ffffff' : '#334155';
    return {
      body: { color: baseColor, fontSize: 15, lineHeight: 22 },
      paragraph: { marginTop: 0, marginBottom: 8 },
      heading1: { fontSize: 20, fontWeight: '700', color: baseColor, marginTop: 8, marginBottom: 6 },
      heading2: { fontSize: 18, fontWeight: '700', color: baseColor, marginTop: 8, marginBottom: 6 },
      heading3: { fontSize: 16, fontWeight: '600', color: baseColor, marginTop: 6, marginBottom: 4 },
      strong: { fontWeight: '700' },
      em: { fontStyle: 'italic' },
      code_inline: {
        backgroundColor: isUser ? 'rgba(255,255,255,0.2)' : '#f1f5f9',
        borderRadius: 4,
        paddingHorizontal: 4,
        paddingVertical: 2,
        fontFamily: 'monospace',
        fontSize: 13,
        color: isUser ? '#fff' : '#dc2626',
      },
      code_block: {
        backgroundColor: isUser ? 'rgba(255,255,255,0.15)' : '#1e293b',
        borderRadius: 8,
        padding: 12,
        marginTop: 6,
        marginBottom: 6,
        fontFamily: 'monospace',
        fontSize: 13,
        color: isUser ? '#fff' : '#e2e8f0',
      },
      blockquote: {
        borderLeftWidth: 3,
        borderLeftColor: isUser ? 'rgba(255,255,255,0.5)' : '#c7d2fe',
        paddingLeft: 10,
        marginTop: 4,
        marginBottom: 4,
        color: isUser ? 'rgba(255,255,255,0.9)' : '#64748b',
        fontStyle: 'italic',
      },
      bullet_list: { marginTop: 4, marginBottom: 4 },
      ordered_list: { marginTop: 4, marginBottom: 4 },
      list_item: { marginTop: 2, marginBottom: 2 },
      hr: { backgroundColor: isUser ? 'rgba(255,255,255,0.3)' : '#e2e8f0', height: 1, marginTop: 8, marginBottom: 8 },
      link: { color: isUser ? '#bfdbfe' : '#4f46e5', textDecorationLine: 'underline' },
    } as const;
  }, [isUser]);

  // 覆盖 markdown 的 text 规则，把回答中的 [N] 角标渲染成可点击上标
  const citeRules = useMemo(() => {
    if (!sources.length) return undefined;
    const citeColor = isUser ? '#c7d2fe' : '#4f46e5';
    return {
      text: (node: any, children: any[], parent: any, styles: any, inherited: any) => {
        const content = String(node.content || '');
        const parts = content.split(CITE_RE);
        const nodes: any[] = [];
        for (let i = 0; i < parts.length; i++) {
          if (i % 2 === 1) {
            const num = Number(parts[i]);
            if (sources.find((s) => Number(s.index) === num)) {
              nodes.push(
                <Text
                  key={`cite-${num}-${i}`}
                  onPress={() => setOpenSource(num)}
                  style={{ color: citeColor, fontWeight: '700', fontSize: 11, lineHeight: 20 }}
                >
                  [{num}]
                </Text>
              );
              continue;
            }
          }
          if (parts[i]) nodes.push(parts[i]);
        }
        return <Text key={node.key} style={[styles.text, inherited]}>{nodes}</Text>;
      },
    };
  }, [sources, isUser]);

  // 思考过程的 markdown 样式：灰色、小字
  const thinkingMarkdownStyle = useMemo(() => ({
    body: { color: '#94a3b8', fontSize: 12, lineHeight: 18 },
    paragraph: { marginTop: 0, marginBottom: 6 },
    heading1: { fontSize: 14, fontWeight: '700', color: '#64748b', marginTop: 4, marginBottom: 3 },
    heading2: { fontSize: 13, fontWeight: '700', color: '#64748b', marginTop: 4, marginBottom: 3 },
    heading3: { fontSize: 12, fontWeight: '600', color: '#64748b', marginTop: 3, marginBottom: 2 },
    strong: { fontWeight: '700', color: '#64748b' },
    em: { fontStyle: 'italic' },
    code_inline: {
      backgroundColor: '#f1f5f9',
      borderRadius: 3,
      paddingHorizontal: 3,
      paddingVertical: 1,
      fontFamily: 'monospace',
      fontSize: 11,
      color: '#dc2626',
    },
    code_block: {
      backgroundColor: '#f8fafc',
      borderRadius: 6,
      padding: 8,
      marginTop: 4,
      marginBottom: 4,
      fontFamily: 'monospace',
      fontSize: 11,
      color: '#64748b',
    },
    blockquote: {
      borderLeftWidth: 2,
      borderLeftColor: '#e2e8f0',
      paddingLeft: 8,
      marginTop: 3,
      marginBottom: 3,
      color: '#94a3b8',
      fontStyle: 'italic',
    },
    bullet_list: { marginTop: 3, marginBottom: 3 },
    ordered_list: { marginTop: 3, marginBottom: 3 },
    list_item: { marginTop: 1, marginBottom: 1 },
    hr: { backgroundColor: '#e2e8f0', height: 1, marginTop: 6, marginBottom: 6 },
    link: { color: '#6366f1', textDecorationLine: 'underline' },
  }) as const, []);

  // 渲染内容：markdown 或纯文本
  const renderContent = () => {
    if (!hasContent) {
      if (isStreaming && !hasThinking) {
        return <ActivityIndicator size="small" color={isUser ? '#fff' : '#94a3b8'} style={{ marginTop: 4 }} />;
      }
      return null;
    }

    if (useMarkdown) {
      return (
        <View style={isUser ? styles.userMarkdownWrap : styles.assistantMarkdownWrap}>
          <Markdown style={markdownStyle} rules={citeRules}>{msg.content}</Markdown>
          {isStreaming && <Text style={[styles.cursor, { color: isUser ? '#fff' : '#6366f1' }]}>▎</Text>}
        </View>
      );
    }

    return (
      <Text style={[styles.msgText, isUser ? styles.userText : styles.assistantText]}>
        {msg.content}
        {isStreaming && <Text style={[styles.cursor, { color: isUser ? '#fff' : '#6366f1' }]}>▎</Text>}
      </Text>
    );
  };

  if (msg.role === 'system') {
    return (
      <View style={styles.systemMsg}>
        <Text style={styles.systemText}>{msg.content}</Text>
      </View>
    );
  }

  return (
    <>
      <View style={[styles.msgBubble, isUser ? styles.userBubble : styles.assistantBubble]}>
        {!isUser && speakerLabel ? (
          <Text style={[styles.speakerLabel, { color: speakerColor }]}>{speakerLabel}</Text>
        ) : null}

        {!isUser && hasThinking ? (
          <TouchableOpacity onPress={toggleThinking} style={styles.thinkingToggle}>
            <Ionicons
              name={showThinking ? 'chevron-down' : 'chevron-forward'}
              size={14}
              color="#94a3b8"
            />
            <Text style={styles.thinkingLabel}>
              {showThinking ? '收起思考' : '思考过程'}
            </Text>
          </TouchableOpacity>
        ) : null}

        {!isUser && showThinking && hasThinking ? (
          <View style={styles.thinkingContainer}>
            <Markdown style={thinkingMarkdownStyle}>{msg.thinking}</Markdown>
          </View>
        ) : null}

        {renderContent()}
      </View>

      {/* 引用来源弹窗 */}
      <Modal
        visible={openSource !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setOpenSource(null)}
      >
        <TouchableOpacity
          activeOpacity={1}
          style={styles.modalOverlay}
          onPress={() => setOpenSource(null)}
        >
          <TouchableOpacity
            activeOpacity={1}
            style={styles.modalCard}
            onPress={() => {}}
          >
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>引用来源</Text>
              <TouchableOpacity onPress={() => setOpenSource(null)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close" size={20} color="#9ca3af" />
              </TouchableOpacity>
            </View>
            <ScrollView>
              {sources
                .filter((s) => openSource === null || Number(s.index) === openSource)
                .map((s) => (
                  <View key={`src-${s.index}`} style={styles.sourceRow}>
                    <TouchableOpacity
                      style={styles.sourceMain}
                      onPress={() => Linking.openURL(s.url).catch(() => {})}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.sourceIndex}>[{s.index}]</Text>
                      <Text style={styles.sourceTitle} numberOfLines={2}>{s.title || s.url}</Text>
                    </TouchableOpacity>
                    <View style={styles.sourceActions}>
                      <TouchableOpacity
                        style={[styles.sourceActionBtn, copiedIndex === s.index && styles.sourceActionBtnDone]}
                        onPress={() => copySourceUrl(s.index, s.url)}
                        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                      >
                        <Ionicons
                          name={copiedIndex === s.index ? 'checkmark' : 'copy-outline'}
                          size={15}
                          color={copiedIndex === s.index ? '#10b981' : '#4f46e5'}
                        />
                        <Text style={[styles.sourceActionText, copiedIndex === s.index && styles.sourceActionTextDone]}>
                          {copiedIndex === s.index ? '已复制' : '复制'}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.sourceActionBtn}
                        onPress={() => Linking.openURL(s.url).catch(() => {})}
                        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                      >
                        <Ionicons name="open-outline" size={15} color="#4f46e5" />
                        <Text style={styles.sourceActionText}>打开</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ))}
            </ScrollView>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  msgBubble: {
    maxWidth: '80%',
    padding: 12,
    borderRadius: 12,
    marginBottom: 8,
  },
  userBubble: {
    alignSelf: 'flex-end',
    backgroundColor: '#4f46e5',
  },
  assistantBubble: {
    alignSelf: 'flex-start',
    backgroundColor: '#f1f5f9',
  },
  speakerLabel: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 4,
  },
  msgText: { fontSize: 15, lineHeight: 22 },
  userText: { color: '#fff' },
  assistantText: { color: '#334155' },
  cursor: { fontSize: 14 },
  userMarkdownWrap: {
    // 用户气泡内 markdown 容器
  },
  assistantMarkdownWrap: {
    // 助手气泡内 markdown 容器
  },
  thinkingToggle: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  thinkingLabel: { fontSize: 12, color: '#94a3b8', marginLeft: 4 },
  thinkingContainer: {
    marginBottom: 8,
    paddingLeft: 8,
    borderLeftWidth: 2,
    borderLeftColor: '#e2e8f0',
  },
  systemMsg: {
    alignSelf: 'center',
    padding: 8,
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    marginBottom: 8,
  },
  systemText: { fontSize: 13, color: '#94a3b8' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCard: {
    width: '100%',
    maxWidth: 480,
    backgroundColor: '#fff',
    borderRadius: 12,
    overflow: 'hidden',
    maxHeight: '60%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  modalTitle: { fontSize: 15, fontWeight: '700', color: '#1f2937' },
  sourceRow: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  sourceMain: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  sourceActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 16,
    marginTop: 6,
  },
  sourceActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  sourceActionBtnDone: {
    opacity: 0.8,
  },
  sourceActionText: { fontSize: 12, color: '#4f46e5' },
  sourceActionTextDone: { color: '#10b981' },
  sourceIndex: { fontWeight: '700', color: '#4f46e5', marginRight: 8 },
  sourceTitle: { flex: 1, fontSize: 14, color: '#1f2937' },
});
