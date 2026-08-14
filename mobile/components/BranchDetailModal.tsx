import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Modal, FlatList, KeyboardAvoidingView, Platform,
  ActivityIndicator, Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { FlatBranch } from '../local/insight';
import { streamChat, createSession, getSessionMessages, getSessionByTitle, saveMessage } from '../local/chat';
import { streamChatroom } from '../local/chatroom';
import MessageBubble from './MessageBubble';
import AiSwitcherBar from './AiSwitcherBar';

interface Props {
  branch: FlatBranch | null;
  visible: boolean;
  onClose: () => void;
}

interface DisplayMessage {
  role: string;
  content: string;
  thinking?: string;
  sources?: { index: number; title: string; url: string }[];
}

const AI_OPTIONS = [
  { key: 'empathy', label: '共情助手', icon: 'heart' as const },
  { key: 'awareness', label: '觉察助手', icon: 'bulb' as const },
  { key: 'chatroom', label: '气氛组', icon: 'people' as const },
];

export default function BranchDetailModal({ branch, visible, onClose }: Props) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [showInfo, setShowInfo] = useState(true);
  const [chatMode, setChatMode] = useState<'awareness' | 'empathy' | 'chatroom'>('awareness');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [roundsSinceLastSpeech, setRoundsSinceLastSpeech] = useState(0);
  const flatListRef = useRef<FlatList>(null);
  const keyboardDidShowListener = useRef<any>(null);
  const pendingSourcesRef = useRef<{ index: number; title: string; url: string }[]>([]);
  // 联网搜索状态条
  const [searchStatus, setSearchStatus] = useState<{ stage: 'searching' | 'done' | 'error' | 'skip'; query?: string; count?: number } | null>(null);
  const searchDoneTimer = useRef<any>(null);

  useEffect(() => {
    if (visible && branch) {
      setChatMode('awareness');
      setSessionId(null);
      setInput('');
      setShowInfo(true);
      const title = `觉察-${branch.resultId}-${branch.branchId}`;
      const session = getSessionByTitle(title);
      if (session) {
        setSessionId(session.id);
        const msgs = getSessionMessages(session.id);
        setMessages(msgs.map(m => ({ role: m.role, content: m.content, thinking: m.thinking, sources: m.sources })));
      } else {
        setMessages((branch.conversation || []).map(m => ({ role: m.role, content: m.content })));
      }
    }
  }, [visible, branch]);

  // 键盘弹起时自动滚动到底部
  useEffect(() => {
    if (!visible) return;
    keyboardDidShowListener.current = Keyboard.addListener('keyboardDidShow', () => {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    });
    return () => {
      keyboardDidShowListener.current?.remove();
      if (searchDoneTimer.current) clearTimeout(searchDoneTimer.current);
    };
  }, [visible]);

  const ensureSession = async () => {
    if (sessionId) return sessionId;
    if (!branch) return null;
    try {
      const title = `觉察-${branch.resultId}-${branch.branchId}`;
      const existing = await getSessionByTitle(title);
      if (existing) {
        setSessionId(existing.id);
        return existing.id;
      }
      const today = new Date().toISOString().split('T')[0];
      const session = await createSession(today, title);
      setSessionId(session.id);
      if (branch.conversation && branch.conversation.length > 0) {
        for (const msg of branch.conversation) {
          const role = msg.role === 'user' ? 'user' : 'insight';
          await saveMessage(session.id, role, msg.content);
        }
      }
      return session.id;
    } catch (e) {
      console.error('创建会话失败:', e);
      return null;
    }
  };

  const handleModeSwitch = async (newMode: 'awareness' | 'empathy' | 'chatroom') => {
    if (newMode === chatMode) return;
    setChatMode(newMode);
    setRoundsSinceLastSpeech(0);

    const sid = await ensureSession();
    if (sid) {
      try {
        const msgs = await getSessionMessages(sid);
        if (msgs.length > 0) {
          setMessages(msgs.map(m => ({ role: m.role, content: m.content, thinking: m.thinking, sources: m.sources })));
        }
      } catch {
        setMessages([]);
      }
    }
  };

  const selectChatMode = (key: string) => handleModeSwitch(key as 'awareness' | 'empathy' | 'chatroom');

  const buildExtraContext = (): string => {
    if (!branch) return '';
    let ctx = '## 当前觉察支线\n';
    ctx += `标题: ${branch.title}\n`;
    ctx += `观察: ${branch.observation}\n`;
    if (branch.evidence && branch.evidence.length) ctx += `依据: ${branch.evidence.join('；')}\n`;
    if (branch.question) ctx += `思考: ${branch.question}\n`;
    return ctx;
  };

  const buildChatroomContext = (): string => {
    return buildExtraContext();
  };

  const handleSend = async () => {
    if (!input.trim() || streaming || !branch) return;
    const userMsg = input.trim();
    setInput('');
    Keyboard.dismiss();
    setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    setStreaming(true);

    if (chatMode === 'chatroom') {
      await handleChatroomSend(userMsg);
    } else if (chatMode === 'empathy') {
      await handleEmpathySend(userMsg);
    } else {
      await handleAwarenessSend(userMsg);
    }
  };

  const handleAwarenessSend = async (userMsg: string) => {
    const sid = await ensureSession();
    if (!sid) { setStreaming(false); return; }
    let fullResponse = '';
    let fullThinking = '';
    pendingSourcesRef.current = [];
    setMessages(prev => [...prev, { role: 'insight', content: '', thinking: '' }]);

    try {
      const today = new Date().toISOString().split('T')[0];
      const extraCtx = buildExtraContext();
      for await (const chunk of streamChat(userMsg, sid, today, 'awareness', extraCtx, false)) {
        if (chunk.type === 'thinking') {
          fullThinking += chunk.content;
          setMessages(prev => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.role === 'insight') {
              updated[updated.length - 1] = { ...last, thinking: fullThinking };
            }
            return updated;
          });
        } else if (chunk.type === 'response') {
          fullResponse += chunk.content;
          setMessages(prev => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.role === 'insight') {
              updated[updated.length - 1] = { ...last, content: fullResponse, sources: pendingSourcesRef.current };
            }
            return updated;
          });
        } else if (chunk.type === 'replace_response') {
          fullResponse = chunk.content;
          setMessages(prev => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.role === 'insight') {
              updated[updated.length - 1] = { ...last, content: fullResponse };
            }
            return updated;
          });
        } else if (chunk.type === 'search_query') {
          setSearchStatus({ stage: 'searching', query: chunk.query || chunk.content || '' });
        } else if (chunk.type === 'search_done') {
          setSearchStatus({ stage: 'done', query: chunk.query || '', count: chunk.count || 0 });
          if (searchDoneTimer.current) clearTimeout(searchDoneTimer.current);
          searchDoneTimer.current = setTimeout(() => setSearchStatus(null), 1800);
          if (Array.isArray(chunk.results) && chunk.results.length) {
            pendingSourcesRef.current = chunk.results.map((r: any, i: number) => ({
              index: i + 1,
              title: r.title || '',
              url: r.url || '',
            }));
          }
        } else if (chunk.type === 'search_skip') {
          setSearchStatus({ stage: 'skip' });
          if (searchDoneTimer.current) clearTimeout(searchDoneTimer.current);
          searchDoneTimer.current = setTimeout(() => setSearchStatus(null), 2500);
        } else if (chunk.type === 'search_error') {
          setSearchStatus({ stage: 'error', query: chunk.content || '搜索失败' });
          if (searchDoneTimer.current) clearTimeout(searchDoneTimer.current);
          searchDoneTimer.current = setTimeout(() => setSearchStatus(null), 4000);
        }
      }
    } catch (e) {
      console.error('觉察助手对话失败:', e);
    } finally {
      setStreaming(false);
      if (sid) {
        try {
          saveMessage(sid, 'user', userMsg);
          if (fullResponse.trim()) {
            saveMessage(sid, 'insight', fullResponse, fullThinking, '', pendingSourcesRef.current.length > 0 ? pendingSourcesRef.current : undefined);
          }
        } catch (e) {
          console.warn('保存对话失败:', e);
        }
      }
    }
  };

  const handleEmpathySend = async (userMsg: string) => {
    const sid = await ensureSession();
    if (!sid) { setStreaming(false); return; }
    let fullResponse = '';
    let fullThinking = '';
    pendingSourcesRef.current = [];
    setMessages(prev => [...prev, { role: 'assistant', content: '', thinking: '' }]);

    try {
      const today = new Date().toISOString().split('T')[0];
      const extraCtx = buildExtraContext();
      for await (const chunk of streamChat(userMsg, sid, today, 'empathy', extraCtx, false)) {
        if (chunk.type === 'thinking') {
          fullThinking += chunk.content;
          setMessages(prev => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.role === 'assistant') {
              updated[updated.length - 1] = { ...last, thinking: fullThinking };
            }
            return updated;
          });
        } else if (chunk.type === 'response') {
          fullResponse += chunk.content;
          setMessages(prev => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.role === 'assistant') {
              updated[updated.length - 1] = { ...last, content: fullResponse, sources: pendingSourcesRef.current };
            }
            return updated;
          });
        } else if (chunk.type === 'replace_response') {
          fullResponse = chunk.content;
          setMessages(prev => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.role === 'assistant') {
              updated[updated.length - 1] = { ...last, content: fullResponse };
            }
            return updated;
          });
        } else if (chunk.type === 'search_query') {
          setSearchStatus({ stage: 'searching', query: chunk.query || chunk.content || '' });
        } else if (chunk.type === 'search_done') {
          setSearchStatus({ stage: 'done', query: chunk.query || '', count: chunk.count || 0 });
          if (searchDoneTimer.current) clearTimeout(searchDoneTimer.current);
          searchDoneTimer.current = setTimeout(() => setSearchStatus(null), 1800);
          if (Array.isArray(chunk.results) && chunk.results.length) {
            pendingSourcesRef.current = chunk.results.map((r: any, i: number) => ({
              index: i + 1,
              title: r.title || '',
              url: r.url || '',
            }));
          }
        } else if (chunk.type === 'search_skip') {
          setSearchStatus({ stage: 'skip' });
          if (searchDoneTimer.current) clearTimeout(searchDoneTimer.current);
          searchDoneTimer.current = setTimeout(() => setSearchStatus(null), 2500);
        } else if (chunk.type === 'search_error') {
          setSearchStatus({ stage: 'error', query: chunk.content || '搜索失败' });
          if (searchDoneTimer.current) clearTimeout(searchDoneTimer.current);
          searchDoneTimer.current = setTimeout(() => setSearchStatus(null), 4000);
        }
      }
    } catch (e) {
      console.error('共情助手对话失败:', e);
    } finally {
      setStreaming(false);
      if (sid) {
        try {
          saveMessage(sid, 'user', userMsg);
          if (fullResponse.trim()) {
            saveMessage(sid, 'assistant', fullResponse, fullThinking, '', pendingSourcesRef.current.length > 0 ? pendingSourcesRef.current : undefined);
          }
        } catch (e) {
          console.warn('保存对话失败:', e);
        }
      }
    }
  };

  const handleChatroomSend = async (userMsg: string) => {
    const sid = await ensureSession();
    if (!sid) { setStreaming(false); return; }
    const history = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role, content: m.content }));
    const context = buildChatroomContext();
    const today = new Date().toISOString().split('T')[0];

    try {
      for await (const chunk of streamChatroom(userMsg, history, context, roundsSinceLastSpeech, today, sid, false)) {
        if (chunk.type === 'speaker') {
          const speakerKey = chunk.speaker || 'assistant';
          pendingSourcesRef.current = [];
          setMessages(prev => [...prev, { role: speakerKey, content: '', thinking: '' }]);
          setRoundsSinceLastSpeech(0);
        } else if (chunk.type === 'search_query') {
          setSearchStatus({ stage: 'searching', query: chunk.query || '' });
        } else if (chunk.type === 'search_done') {
          setSearchStatus({ stage: 'done', query: chunk.query || '', count: chunk.count || 0 });
          if (searchDoneTimer.current) clearTimeout(searchDoneTimer.current);
          searchDoneTimer.current = setTimeout(() => setSearchStatus(null), 1800);
          if (Array.isArray(chunk.results) && chunk.results.length) {
            pendingSourcesRef.current = chunk.results.map((r: any, i: number) => ({
              index: i + 1, title: r.title || '', url: r.url || '',
            }));
          }
        } else if (chunk.type === 'search_skip') {
          setSearchStatus({ stage: 'skip' });
          if (searchDoneTimer.current) clearTimeout(searchDoneTimer.current);
          searchDoneTimer.current = setTimeout(() => setSearchStatus(null), 2500);
        } else if (chunk.type === 'search_error') {
          setSearchStatus({ stage: 'error', query: chunk.content || '搜索失败' });
          if (searchDoneTimer.current) clearTimeout(searchDoneTimer.current);
          searchDoneTimer.current = setTimeout(() => setSearchStatus(null), 4000);
        } else if (chunk.type === 'thinking') {
          setMessages(prev => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.role !== 'user') {
              updated[updated.length - 1] = {
                ...last,
                thinking: (last.thinking || '') + (chunk.content || ''),
              };
            }
            return updated;
          });
        } else if (chunk.type === 'response') {
          setMessages(prev => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.role !== 'user') {
              updated[updated.length - 1] = {
                ...last,
                content: (last.content || '') + (chunk.content || ''),
              };
            }
            return updated;
          });
        } else if (chunk.type === 'silence') {
          setMessages(prev => [...prev, { role: 'system', content: '（大家都在思考中...）' }]);
          setRoundsSinceLastSpeech(prev => prev + 1);
        } else if (chunk.type === 'error') {
          setMessages(prev => [...prev, { role: 'system', content: `错误: ${chunk.content}` }]);
        }
      }
    } catch (e) {
      console.error('气氛组对话失败:', e);
    } finally {
      setStreaming(false);
    }
  };

  // 联网搜索状态条
  const renderSearchStatus = () => {
    if (!searchStatus) return null;
    const { stage, query, count } = searchStatus;
    let color = '#4f46e5';
    let text = '';
    if (stage === 'searching') {
      color = '#4f46e5';
      text = query ? `正在联网搜索：${query}` : '正在联网搜索...';
    } else if (stage === 'done') {
      color = '#10b981';
      text = `已找到 ${count} 条相关结果`;
    } else if (stage === 'skip') {
      color = '#94a3b8';
      text = '未找到相关结果';
    } else {
      color = '#ef4444';
      text = query ? `${query}` : '联网搜索失败，已跳过';
    }
    return (
      <View style={[styles.searchStatusBar, { borderColor: color }]}>
        {stage === 'searching' ? (
          <ActivityIndicator size="small" color={color} style={{ marginRight: 6 }} />
        ) : stage === 'skip' ? (
          <Ionicons name="search" size={14} color={color} />
        ) : (
          <Ionicons name={stage === 'done' ? 'checkmark-circle' : 'alert-circle'} size={14} color={color} />
        )}
        <Text style={[styles.searchStatusText, { color }]} numberOfLines={1}>{text}</Text>
      </View>
    );
  };

  const renderMessage = ({ item, index }: { item: DisplayMessage; index: number }) => {
    const isStreaming = streaming && index === messages.length - 1;
    return <MessageBubble msg={item} isStreaming={isStreaming} />;
  };

  const renderBranchInfo = () => {
    if (!branch) return null;
    return (
      <View style={styles.infoSection}>
        <TouchableOpacity
          onPress={() => setShowInfo(!showInfo)}
          style={[styles.infoToggle, !showInfo && { marginBottom: 0 }]}
        >
          <Text style={styles.infoToggleText}>支线详情</Text>
          <Ionicons name={showInfo ? 'chevron-up' : 'chevron-down'} size={16} color="#94a3b8" />
        </TouchableOpacity>
        {showInfo && (
          <View>
            <View style={styles.observationBlock}>
              <Text style={styles.observationLabel}>观察</Text>
              <Text style={styles.observationText}>{branch.observation}</Text>
            </View>
            {branch.evidence && branch.evidence.length ? (
              <View style={styles.evidenceBlock}>
                <Text style={styles.evidenceLabel}>依据</Text>
                {branch.evidence.map((item, idx) => (
                  <View key={idx} style={styles.evidenceItem}>
                    <Text style={styles.evidenceBullet}>•</Text>
                    <Text style={styles.evidenceText}>{item}</Text>
                  </View>
                ))}
              </View>
            ) : null}
            {branch.question ? (
              <View style={styles.questionBlock}>
                <Text style={styles.questionLabel}>思考</Text>
                <Text style={styles.questionText}>{branch.question}</Text>
              </View>
            ) : null}
          </View>
        )}
      </View>
    );
  };

  const renderEmpty = () => {
    if (messages.length === 0) {
      const hint = chatMode === 'chatroom'
        ? '在气氛组中聊聊这个发现...'
        : chatMode === 'empathy'
        ? '和共情助手聊聊这个发现...'
        : '点击输入框，开始和觉察伙伴聊聊这个发现';
      return (
        <View style={styles.emptyChat}>
          <Text style={styles.emptyChatText}>{hint}</Text>
        </View>
      );
    }
    return null;
  };

  return (
    <Modal visible={visible} animationType="none" presentationStyle="pageSheet">
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <SafeAreaView edges={['top']} style={styles.container}>
          {/* 顶部标题栏 */}
          <View style={styles.header}>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close" size={24} color="#64748b" />
            </TouchableOpacity>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {branch?.title || '觉察详情'} · {chatMode === 'chatroom' ? '气氛组' : chatMode === 'empathy' ? '共情' : '觉察'}
            </Text>
            <View style={{ width: 24 }} />
          </View>

          {/* 消息列表 + 支线详情（作为 ListHeader） */}
          <FlatList
            ref={flatListRef}
            data={messages}
            renderItem={renderMessage}
            keyExtractor={(_, i) => i.toString()}
            ListHeaderComponent={renderBranchInfo}
            ListEmptyComponent={renderEmpty}
            ListFooterComponent={renderSearchStatus}
            style={styles.messageList}
            contentContainerStyle={styles.messageListContent}
            onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
          />

          {/* 流式回复指示器 */}
          {streaming && (
            <View style={styles.streamingBar}>
              <ActivityIndicator size="small" color="#6366f1" />
              <Text style={styles.streamingText}>
                {chatMode === 'chatroom' ? '气氛组回复中...' : chatMode === 'empathy' ? '共情助手回复中...' : '觉察助手回复中...'}
              </Text>
            </View>
          )}

          {/* 模式切换 */}
          <AiSwitcherBar
            options={AI_OPTIONS}
            activeKey={chatMode}
            onSelect={selectChatMode}
            disabled={streaming}
          />

          {/* 输入栏 */}
          <View style={styles.inputBar}>
            <TextInput
              style={styles.input}
              value={input}
              onChangeText={setInput}
              placeholder={chatMode === 'chatroom' ? '在气氛组中说点什么...' : chatMode === 'empathy' ? '和共情助手聊聊...' : '和觉察伙伴聊聊这个发现...'}
              placeholderTextColor="#cbd5e1"
              multiline
              maxLength={500}
            />
            <TouchableOpacity
              style={[styles.sendBtn, (!input.trim() || streaming) && styles.sendBtnDisabled]}
              onPress={handleSend}
              disabled={!input.trim() || streaming}
            >
              <Ionicons name="send" size={20} color="#fff" />
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
    backgroundColor: '#fff',
  },
  headerTitle: { fontSize: 16, fontWeight: '600', color: '#111827', flex: 1, marginHorizontal: 12 },
  messageList: { flex: 1 },
  messageListContent: { padding: 16, paddingBottom: 40 },

  // 支线详情区域
  infoSection: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#f1f5f9',
  },
  infoToggle: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  infoToggleText: { fontSize: 14, fontWeight: '600', color: '#111827' },

  // 观察区域：白色背景 + indigo 边框
  observationBlock: {
    marginBottom: 12,
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: '#c7d2fe',
  },
  observationLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#4f46e5',
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  observationText: { fontSize: 14, color: '#4b5563', lineHeight: 22 },

  // 依据区域：amber 配色
  evidenceBlock: {
    marginBottom: 12,
    backgroundColor: '#fffbeb',
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  evidenceLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#78350f',
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  evidenceItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: 6,
  },
  evidenceBullet: {
    fontSize: 14,
    lineHeight: 22,
    color: '#d97706',
    marginRight: 6,
  },
  evidenceText: { fontSize: 14, color: '#78350f', lineHeight: 22, flex: 1 },

  // 思考/追问区域：indigo 配色
  questionBlock: {
    marginBottom: 12,
    backgroundColor: '#eef2ff',
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: '#c7d2fe',
  },
  questionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#312e81',
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  questionText: { fontSize: 14, color: '#312e81', lineHeight: 22 },

  // 空对话提示
  emptyChat: { paddingVertical: 40, alignItems: 'center' },
  emptyChatText: { fontSize: 14, color: '#94a3b8' },

  // 系统消息
  systemMsg: {
    alignSelf: 'center', padding: 8, borderRadius: 8,
    backgroundColor: '#f8fafc', marginBottom: 8,
  },
  systemText: { fontSize: 13, color: '#94a3b8' },

  // 流式回复指示
  streamingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  streamingText: { fontSize: 12, color: '#94a3b8', marginLeft: 8 },

  // 联网搜索状态条
  searchStatusBar: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'center',
    marginTop: 4, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 16, borderWidth: 1, backgroundColor: '#f8fafc', maxWidth: '90%',
  },
  searchStatusText: { fontSize: 12, marginLeft: 4 },

  // 输入栏
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
    backgroundColor: '#fff',
  },
  input: {
    flex: 1,
    backgroundColor: '#f9fafb',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    maxHeight: 100,
    color: '#334155',
  },
  sendBtn: {
    backgroundColor: '#4f46e5',
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 8,
  },
  sendBtnDisabled: { opacity: 0.3 },
});
