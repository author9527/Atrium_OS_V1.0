import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, KeyboardAvoidingView, ActivityIndicator, Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { streamChat, createSession, getSessionMessages, getSessionByTitle, saveMessage, ChatMessage,
} from '../../local/chat';
import { streamChatroom } from '../../local/chatroom';
import { streamOpening } from '../../local/statistics';
import { getToday } from '../../utils/date';
import MessageBubble from '../../components/MessageBubble';
import AiSwitcherBar from '../../components/AiSwitcherBar';

// 图表类型 -> 中文标题 映射
const CHART_TITLE: Record<string, string> = {
  emotion: '情绪雷达',
  fishbone: '生活摘要',
};

const AI_OPTIONS = [
  { key: 'empathy', label: '共情助手', icon: 'heart' as const },
  { key: 'awareness', label: '觉察助手', icon: 'bulb' as const },
  { key: 'chatroom', label: '气氛组', icon: 'people' as const },
];

type ChatMode = 'empathy' | 'awareness' | 'chatroom';

export default function StatsChatScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ chartType?: string; context?: string }>();

  const chartType = params.chartType || 'emotion';
  const context = params.context || undefined;
  const chartTitle = CHART_TITLE[chartType] || '图表对话';
  const sessionTitle = `统计-${chartTitle}`;
  const today = getToday().dateStr;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [chatMode, setChatMode] = useState<ChatMode>('empathy');
  const [roundsSinceLastSpeech, setRoundsSinceLastSpeech] = useState(0);
  // 联网搜索状态条
  const [searchStatus, setSearchStatus] = useState<{ stage: 'searching' | 'done' | 'error' | 'skip'; query?: string; count?: number } | null>(null);
  const searchDoneTimer = useRef<any>(null);

  const flatListRef = useRef<FlatList>(null);
  const initRef = useRef(false);
  // 流式期间捕获的联网搜索引用来源，供回答中的 [N] 角标使用
  const pendingSourcesRef = useRef<{ index: number; title: string; url: string }[]>([]);

  // 键盘弹起时自动滚动到底部，避免最新消息被输入框挡住
  useEffect(() => {
    const handleShow = () => {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 250);
    };
    const showSub = Keyboard.addListener('keyboardDidShow', handleShow);
    return () => {
      showSub.remove();
      if (searchDoneTimer.current) clearTimeout(searchDoneTimer.current);
    };
  }, []);

  // 初始化会话（只跑一次，用 ref 防重）：每天首次进入时生成新的开场白
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    (async () => {
      try {
        const existing = await getSessionByTitle(sessionTitle);
        if (existing) {
          setSessionId(existing.id);
          const msgs = await getSessionMessages(existing.id);
          if (msgs.length > 0) {
            // 已有历史：检查今天是否已经生成过开场白
            // 找最后一条助手消息，看它的 diary_date 是否是今天
            const lastAssistantMsg = [...msgs].reverse().find(m => m.role === 'assistant');
            const alreadyGreetedToday = lastAssistantMsg?.diaryDate === today;
            if (alreadyGreetedToday) {
              // 今天已经问候过：直接恢复历史
              setMessages(msgs.map((m) => ({ role: m.role, content: m.content, thinking: m.thinking, sources: m.sources })));
            } else {
              // 今天还没问候过：先生成新开场白，再展示历史
              setMessages(msgs.map((m) => ({ role: m.role, content: m.content, thinking: m.thinking, sources: m.sources })));
              streamGreeting(existing.id, msgs.length);
            }
          } else {
            // 会话存在但为空（首次进入）：流式生成开场白
            streamGreeting(existing.id, 0);
          }
        } else {
          const session = await createSession(today, sessionTitle);
          setSessionId(session.id);
          streamGreeting(session.id, 0);
        }
      } catch (e) {
        console.error('初始化图表对话失败:', e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // 进入对话空间后流式生成开场白：insertIndex 指定插入位置（0=开头，历史长度=末尾追加）
  const streamGreeting = async (sid: string, insertIndex: number = 0) => {
    // 先在指定位置占位一条空助手消息
    setMessages((prev) => {
      const next = [...prev];
      next.splice(insertIndex, 0, { role: 'assistant', content: '', thinking: '' });
      return next;
    });
    let full = '';
    try {
      for await (const chunk of streamOpening(chartType, context || '')) {
        if (chunk.type === 'response') {
          full += chunk.content;
          // 原地更新占位的那条消息
          setMessages((prev) => {
            const next = [...prev];
            if (next[insertIndex] && next[insertIndex].role === 'assistant' && !next[insertIndex].content) {
              next[insertIndex] = { ...next[insertIndex], content: full };
            }
            return next;
          });
        }
      }
    } catch (e) {
      console.error('流式生成开场白失败:', e);
    }
    // 流式结束：若为空则移除占位，否则持久化开场白
    if (!full.trim()) {
      setMessages((prev) => prev.filter((_, i) => i !== insertIndex));
    } else if (sid) {
      saveMessage(sid, 'assistant', full, '', today);
    }
  };

  const handleSend = async () => {
    if (!input.trim() || streaming || !sessionId) return;
    const userMsg = input.trim();
    setInput('');
    Keyboard.dismiss();
    const msgCountBefore = messages.length + 1; // +1 是即将加入的用户消息
    setMessages((prev) => [...prev, { role: 'user', content: userMsg }]);
    setStreaming(true);

    if (chatMode === 'chatroom') {
      await handleChatroomSend(userMsg, msgCountBefore);
      return;
    }

    const assistantRole = chatMode === 'empathy' ? 'assistant' : 'insight';
    setMessages((prev) => [...prev, { role: assistantRole, content: '', thinking: '' }]);

    let fullResponse = '';
    let fullThinking = '';
    pendingSourcesRef.current = [];

    try {
      for await (const chunk of streamChat(userMsg, sessionId, today, chatMode, context, false, 30)) {
        if (chunk.type === 'thinking') {
          fullThinking += chunk.content;
          updateLastMessage(assistantRole, { thinking: fullThinking });
        } else if (chunk.type === 'response') {
          fullResponse += chunk.content;
          updateLastMessage(assistantRole, { content: fullResponse, sources: pendingSourcesRef.current });
        } else if (chunk.type === 'replace_response') {
          fullResponse = chunk.content;
          updateLastMessage(assistantRole, { content: fullResponse, sources: pendingSourcesRef.current });
        } else if (chunk.type === 'search_query') {
          setSearchStatus({ stage: 'searching', query: chunk.query || chunk.content || '' });
        } else if (chunk.type === 'search_done') {
          setSearchStatus({ stage: 'done', query: chunk.query || '', count: chunk.count || 0 });
          if (searchDoneTimer.current) clearTimeout(searchDoneTimer.current);
          searchDoneTimer.current = setTimeout(() => setSearchStatus(null), 1800);
          // 捕获搜索结果来源，供回答中的 [N] 角标引用
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
      console.error('图表对话失败:', e);
    } finally {
      setStreaming(false);
      // 持久化本轮对话，避免退出重进后丢失（与主对话空间一致）
      if (sessionId) {
        try {
          saveMessage(sessionId, 'user', userMsg);
          if (fullResponse.trim()) {
            saveMessage(sessionId, assistantRole, fullResponse, fullThinking, '', pendingSourcesRef.current.length > 0 ? pendingSourcesRef.current : undefined);
          }
        } catch (e) {
          console.warn('保存对话失败:', e);
        }
      }
    }
  };

  // 更新最后一条助手消息（thinking / content）
  const updateLastMessage = (role: string, patch: Partial<ChatMessage>) => {
    setMessages((prev) => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (last && last.role === role) {
        updated[updated.length - 1] = { ...last, ...patch };
      }
      return updated;
    });
  };

  const handleChatroomSend = async (userMsg: string, msgCountBefore: number) => {
    const history = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      for await (const chunk of streamChatroom(userMsg, history, context || '', roundsSinceLastSpeech, today, sessionId, false)) {
        if (chunk.type === 'speaker') {
          const speakerKey = chunk.speaker || 'assistant';
          pendingSourcesRef.current = []; // 新发言者：清空上一位的搜索来源
          setMessages((prev) => [...prev, { role: speakerKey, content: '', thinking: '' }]);
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
          setMessages((prev) => {
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
          setMessages((prev) => {
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
          setMessages((prev) => [...prev, { role: 'system', content: '（大家都在思考中...）' }]);
          setRoundsSinceLastSpeech((prev) => prev + 1);
        } else if (chunk.type === 'error') {
          setMessages((prev) => [...prev, { role: 'system', content: `错误: ${chunk.content}` }]);
        }
      }
    } catch (e) {
      console.error('气氛组对话失败:', e);
    } finally {
      setStreaming(false);
      // 持久化本轮对话（气氛组有多条消息，逐条保存）
      if (sessionId) {
        try {
          setMessages((prev) => {
            const newMsgs = prev.slice(msgCountBefore - 1);
            for (const m of newMsgs) {
              if (m.role === 'system') continue;
              saveMessage(sessionId, m.role, m.content, m.thinking || '');
            }
            return prev;
          });
        } catch (e) {
          console.warn('保存对话失败:', e);
        }
      }
    }
  };

  const selectChatMode = (key: string) => {
    setChatMode(key as ChatMode);
    setRoundsSinceLastSpeech(0);
  };

  const renderMessage = ({ item, index }: { item: ChatMessage; index: number }) => {
    const isStreaming = streaming && index === messages.length - 1;
    return <MessageBubble msg={item} isStreaming={isStreaming} />;
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

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#2FBF9F" />
        </View>
      </SafeAreaView>
    );
  }

  const handleBack = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(main)');
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header - 固定在顶部，不随键盘移动 */}
      <View style={styles.header}>
        <TouchableOpacity onPress={handleBack} style={styles.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="arrow-back" size={22} color="#2FBF9F" />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{chartTitle}</Text>
        <View style={{ width: 30 }} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">

        {/* Messages */}
        <FlatList
          ref={flatListRef}
          data={messages}
          renderItem={renderMessage}
          keyExtractor={(_, i) => i.toString()}
          style={styles.messageList}
          contentContainerStyle={styles.messageListContent}
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
          ListFooterComponent={renderSearchStatus}
        />

        {streaming && (
          <View style={styles.streamingBar}>
            <ActivityIndicator size="small" color="#2FBF9F" />
            <Text style={styles.streamingText}>
              {chatMode === 'chatroom' ? '气氛组回复中...' : chatMode === 'empathy' ? '共情助手回复中...' : '觉察助手回复中...'}
            </Text>
          </View>
        )}

        {/* Input */}
        <AiSwitcherBar
          options={AI_OPTIONS}
          activeKey={chatMode}
          onSelect={selectChatMode}
          disabled={streaming}
        />
        <View style={styles.inputBar}>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder={chatMode === 'chatroom' ? '在气氛组中聊聊这组图表...' : chatMode === 'empathy' ? '和共情助手聊聊这组图表...' : '和觉察助手聊聊这组图表...'}
            placeholderTextColor="#cbd5e1"
            multiline
            maxLength={500}
          />
          <TouchableOpacity
            style={[styles.sendBtn, (!input.trim() || streaming) && styles.sendBtnDisabled]}
            onPress={handleSend}
            disabled={!input.trim() || streaming}
            activeOpacity={0.85}
          >
            <Ionicons name="send" size={20} color="#fff" />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  backBtn: { padding: 4 },
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#1e293b', flex: 1, textAlign: 'center' },
  messageList: { flex: 1 },
  messageListContent: { padding: 16, paddingBottom: 32 },
  searchStatusBar: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'center',
    marginTop: 4, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 16, borderWidth: 1, backgroundColor: '#f8fafc', maxWidth: '90%',
  },
  searchStatusText: { fontSize: 12, marginLeft: 4 },
  streamingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  streamingText: { fontSize: 12, color: '#94a3b8', marginLeft: 8 },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 12,
    paddingBottom: 24,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
  },
  input: {
    flex: 1,
    backgroundColor: '#f8fafc',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    maxHeight: 100,
    color: '#334155',
  },
  sendBtn: {
    backgroundColor: '#2FBF9F',
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 8,
    shadowColor: '#2FBF9F',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 3,
  },
  sendBtnDisabled: { opacity: 0.3, shadowOpacity: 0 },
});