import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, KeyboardAvoidingView, ActivityIndicator, Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import {
  streamChat, getSessionByTitle, createSession, getSessionMessages, saveMessage, ChatMessage,
} from '../../local/chat';
import { streamChatroom } from '../../local/chatroom';
import { getToday } from '../../utils/date';
import MessageBubble from '../../components/MessageBubble';
import AiSwitcherBar from '../../components/AiSwitcherBar';

const AI_OPTIONS = [
  { key: 'empathy', label: '共情助手', icon: 'heart' as const },
  { key: 'awareness', label: '觉察助手', icon: 'bulb' as const },
  { key: 'chatroom', label: '气氛组', icon: 'people' as const },
];

export default function ChatScreen() {
  const router = useRouter();
  const today = getToday().dateStr;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [chatMode, setChatMode] = useState<'empathy' | 'awareness' | 'chatroom'>('empathy');
  const [roundsSinceLastSpeech, setRoundsSinceLastSpeech] = useState(0);
  // 联网搜索状态条：{stage, query, count}，搜索过程中在对话窗口实时展示
  const [searchStatus, setSearchStatus] = useState<{ stage: 'searching' | 'done' | 'error' | 'skip'; query?: string; count?: number } | null>(null);
  const searchDoneTimer = useRef<any>(null);
  const flatListRef = useRef<FlatList>(null);
  const keyboardDidShowListener = useRef<any>(null);

  // —— 流式渲染节流 ——
  // 移动端若每个 token 都触发 setMessages + markdown 全量重解析，
  // 长回复会让 UI 越来越卡、看起来像"输出到一半卡住"。
  // 这里把 token 累积到 ref，每 THROTTLE_MS 才刷新一次界面。
  const pendingContentRef = useRef('');
  const pendingThinkingRef = useRef('');
  const pendingSourcesRef = useRef<{ index: number; title: string; url: string }[]>([]);
  const lastFlushRef = useRef(0);
  const flushTimerRef = useRef<any>(null);

  useEffect(() => {
    initChat();
  }, []);

  // 键盘弹起时自动滚动到底部，避免最新消息被输入框挡住
  useEffect(() => {
    keyboardDidShowListener.current = Keyboard.addListener('keyboardDidShow', () => {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    });
    return () => {
      keyboardDidShowListener.current?.remove();
      if (searchDoneTimer.current) clearTimeout(searchDoneTimer.current);
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    };
  }, []);

  // —— 流式渲染节流：把累积的 token 一次性写入界面 ——
  const THROTTLE_MS = 80;
  const flushStream = () => {
    flushTimerRef.current = null;
    const content = pendingContentRef.current;
    const thinking = pendingThinkingRef.current;
    const sources = pendingSourcesRef.current;
    setMessages((prev) => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (last && last.role !== 'user') {
        last.content = content;
        last.thinking = thinking;
        last.sources = sources;
      }
      return updated;
    });
    lastFlushRef.current = Date.now();
  };
  const scheduleFlush = () => {
    if (flushTimerRef.current) return;
    const wait = Math.max(0, THROTTLE_MS - (Date.now() - lastFlushRef.current));
    flushTimerRef.current = setTimeout(flushStream, wait);
  };
  const forceFlush = () => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    flushStream();
  };

  const SESSION_TITLE = '共情对话';

  const initChat = async () => {
    try {
      // 使用固定标题跨日期查找会话，避免跨天丢失历史
      const existing = await getSessionByTitle(SESSION_TITLE);
      if (existing) {
        setSessionId(existing.id);
        const msgs = await getSessionMessages(existing.id);
        setMessages(msgs);
        console.log(`[chat.tsx] 加载已有会话 ${existing.id}，${msgs.length} 条消息`);
      } else {
        const session = await createSession(today, SESSION_TITLE);
        setSessionId(session.id);
        setMessages([]);
        console.log(`[chat.tsx] 创建新会话 ${session.id}`);
      }
    } catch (e) {
      console.error('初始化聊天失败:', e);
    }
  };

  const handleSend = async () => {
    if (!input.trim() || streaming) return;
    const userMsg = input.trim();
    setInput('');
    Keyboard.dismiss();
    const msgCountBefore = messages.length + 1; // +1 是即将加入的用户消息
    setMessages((prev) => [...prev, { role: 'user', content: userMsg }]);

    setStreaming(true);
    if (chatMode === 'chatroom') {
      await handleChatroomSend(userMsg, msgCountBefore);
    } else {
      await handleEmpathySend(userMsg, chatMode);
    }
  };

  const handleEmpathySend = async (userMsg: string, mode: 'empathy' | 'awareness' = 'empathy') => {
    let fullResponse = '';
    let fullThinking = '';
    pendingContentRef.current = '';
    pendingThinkingRef.current = '';
    pendingSourcesRef.current = [];
    setMessages((prev) => [...prev, { role: mode === 'awareness' ? 'insight' : 'assistant', content: '', thinking: '' }]);

    try {
      for await (const chunk of streamChat(userMsg, sessionId, today, mode)) {
        if (chunk.type === 'thinking') {
          fullThinking += chunk.content;
          pendingThinkingRef.current = fullThinking;
          scheduleFlush();
        } else if (chunk.type === 'response') {
          fullResponse += chunk.content;
          pendingContentRef.current = fullResponse;
          scheduleFlush();
        } else if (chunk.type === 'replace_response') {
          fullResponse = chunk.content;
          pendingContentRef.current = fullResponse;
          scheduleFlush();
        } else if (chunk.type === 'search_query') {
          forceFlush(); // 确保搜索前已渲染已输出的内容
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
          // 立即刷新 UI，确保 sources 在搜索完成后立即可见，不依赖下一个 response token
          forceFlush();
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
      console.error('对话失败:', e);
    } finally {
      forceFlush(); // 结束前强制刷新，确保最终内容完整显示
      setStreaming(false);
      // 持久化本轮对话，避免退出重进后丢失（与统计/关系对话空间一致）
      if (sessionId) {
        try {
          saveMessage(sessionId, 'user', userMsg);
          if (fullResponse.trim()) {
            saveMessage(
              sessionId,
              mode === 'awareness' ? 'insight' : 'assistant',
              fullResponse,
              fullThinking,
              '',
              pendingSourcesRef.current.length > 0 ? pendingSourcesRef.current : undefined,
            );
          }
        } catch (e) {
          console.warn('保存对话失败:', e);
        }
      }
    }
  };

  const handleChatroomSend = async (userMsg: string, msgCountBefore: number) => {
    const history = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role, content: m.content }));

    try {
      for await (const chunk of streamChatroom(userMsg, history, '', roundsSinceLastSpeech, today, sessionId)) {
        if (chunk.type === 'speaker') {
          const speakerName = chunk.speaker_name || 'AI';
          const speakerKey = chunk.speaker || 'assistant';
          forceFlush(); // 先提交上一位 AI 已输出的内容，再开新气泡
          pendingContentRef.current = '';
          pendingThinkingRef.current = '';
          pendingSourcesRef.current = [];
          setMessages((prev) => [...prev, {
            role: speakerKey,
            content: '',
            thinking: '',
          }]);
          setRoundsSinceLastSpeech(0);
        } else if (chunk.type === 'search_query') {
          forceFlush();
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
          forceFlush();
        } else if (chunk.type === 'search_skip') {
          setSearchStatus({ stage: 'skip' });
          if (searchDoneTimer.current) clearTimeout(searchDoneTimer.current);
          searchDoneTimer.current = setTimeout(() => setSearchStatus(null), 2500);
        } else if (chunk.type === 'search_error') {
          setSearchStatus({ stage: 'error', query: chunk.content || '搜索失败' });
          if (searchDoneTimer.current) clearTimeout(searchDoneTimer.current);
          searchDoneTimer.current = setTimeout(() => setSearchStatus(null), 4000);
        } else if (chunk.type === 'thinking') {
          pendingThinkingRef.current = (pendingThinkingRef.current || '') + (chunk.content || '');
          scheduleFlush();
        } else if (chunk.type === 'response') {
          pendingContentRef.current = (pendingContentRef.current || '') + (chunk.content || '');
          scheduleFlush();
        } else if (chunk.type === 'silence') {
          forceFlush();
          setMessages((prev) => [...prev, { role: 'system', content: '（大家都在思考中...）' }]);
          setRoundsSinceLastSpeech((prev) => prev + 1);
        } else if (chunk.type === 'error') {
          forceFlush();
          setMessages((prev) => [...prev, { role: 'system', content: `错误: ${chunk.content}` }]);
        }
      }
    } catch (e) {
      console.error('气氛组聊天失败:', e);
    } finally {
      forceFlush();
      setStreaming(false);
      // 持久化本轮对话（气氛组有多条消息，逐条保存）
      if (sessionId) {
        try {
          // 使用最新的 messages 状态来保存本轮新增的消息
          setMessages((prev) => {
            const newMsgs = prev.slice(msgCountBefore - 1); // 包含用户消息
            for (const m of newMsgs) {
              if (m.role === 'system') continue; // 跳过系统提示
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
    setChatMode(key as 'empathy' | 'awareness' | 'chatroom');
    setRoundsSinceLastSpeech(0);
  };

  const renderMessage = ({ item, index }: { item: ChatMessage; index: number }) => {
    const isStreaming = streaming && index === messages.length - 1;
    return <MessageBubble msg={item} isStreaming={isStreaming} />;
  };

  // 联网搜索状态条：显示在消息列表底部、输入框上方
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
        <TouchableOpacity onPress={handleBack} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color="#4f46e5" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>
          {chatMode === 'chatroom' ? 'AI气氛组' : chatMode === 'awareness' ? '觉察助手' : '共情助手'}
        </Text>
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
            <ActivityIndicator size="small" color="#64748b" />
            <Text style={styles.streamingText}>
              {chatMode === 'chatroom' ? '气氛组回复中...' : chatMode === 'awareness' ? '觉察助手回复中...' : '共情助手回复中...'}
            </Text>
          </View>
        )}

        {/* Mode toggle */}
        <AiSwitcherBar
          options={AI_OPTIONS}
          activeKey={chatMode}
          onSelect={selectChatMode}
          disabled={streaming}
        />

        {/* Input */}
        <View style={styles.inputBar}>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder={chatMode === 'chatroom' ? '在气氛组中说点什么...' : chatMode === 'awareness' ? '和觉察助手聊聊...' : '和共情助手聊聊...'}
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
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
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
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#1e293b' },
  messageList: { flex: 1 },
  messageListContent: { padding: 16 },
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
  thinkingToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  thinkingLabel: { fontSize: 12, color: '#94a3b8', marginLeft: 4 },
  thinkingText: {
    fontSize: 12,
    color: '#94a3b8',
    fontStyle: 'italic',
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
  searchStatusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    marginTop: 4,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    backgroundColor: '#f8fafc',
    maxWidth: '90%',
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
