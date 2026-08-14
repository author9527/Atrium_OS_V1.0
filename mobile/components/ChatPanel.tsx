import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, Modal, KeyboardAvoidingView, ActivityIndicator,
  Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { streamChat, getSessionMessages, createSession, getSessionByTitle, saveMessage, ChatMessage } from '../local/chat';
import { streamChatroom } from '../local/chatroom';
import MessageBubble from './MessageBubble';
import AiSwitcherBar from './AiSwitcherBar';

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

const AI_OPTIONS = [
  { key: 'empathy', label: '共情助手', icon: 'heart' as const },
  { key: 'awareness', label: '觉察助手', icon: 'bulb' as const },
  { key: 'chatroom', label: '气氛组', icon: 'people' as const },
];

interface Props {
  visible: boolean;
  date: string;
  onClose: () => void;
  extraContext?: string;
}

export default function ChatPanel({ visible, date, onClose, extraContext }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [chatMode, setChatMode] = useState<'empathy' | 'awareness' | 'chatroom'>('empathy');
  const [roundsSinceLastSpeech, setRoundsSinceLastSpeech] = useState(0);
  // 联网搜索状态条
  const [searchStatus, setSearchStatus] = useState<{ stage: 'searching' | 'done' | 'error' | 'skip'; query?: string; count?: number } | null>(null);
  const searchDoneTimer = useRef<any>(null);
  const flatListRef = useRef<FlatList>(null);
  const keyboardDidShowListener = useRef<any>(null);
  // 流式期间捕获的联网搜索引用来源，供回答中的 [N] 角标使用
  const pendingSourcesRef = useRef<{ index: number; title: string; url: string }[]>([]);

  useEffect(() => {
    if (visible) {
      loadSessions();
    }
  }, [visible, date]);

  // 键盘弹起时自动滚动到底部，避免最新消息被输入框挡住
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

  const loadSessions = async () => {
    try {
      const title = `日记-${date}`;
      const existing = await getSessionByTitle(title);
      if (existing) {
        setSessionId(existing.id);
        const msgs = await getSessionMessages(existing.id);
        setMessages(msgs);
        // 注意：不再调用 startGreetingSubscription。
        // 移动端 subscribeGreeting 只是从 DB 回放最后一条消息，
        // 而 getSessionMessages 已经加载了全部消息（含 sources），
        // 再次回放会导致内容重复，且因 setMessages 异步更新，
        // startGreetingSubscription 可能读到旧状态并覆盖带 sources 的消息。
      } else {
        const session = await createSession(date, title);
        setSessionId(session.id);
        setMessages([]);
      }
    } catch (e) {
      console.error('加载会话失败:', e);
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
    // 会话可能尚未加载完成：若 sessionId 为空则先创建会话，避免消息被静默丢弃
    let sid = sessionId;
    if (!sid) {
      try {
        const title = `日记-${date}`;
        const s = await createSession(date, title);
        setSessionId(s.id);
        sid = s.id;
      } catch (e) {
        console.error('创建会话失败:', e);
        return;
      }
    }
    let fullResponse = '';
    let fullThinking = '';
    pendingSourcesRef.current = [];
    const role = mode === 'awareness' ? 'insight' : 'assistant';
    setMessages((prev) => [...prev, { role, content: '', thinking: '' }]);

    try {
      for await (const chunk of streamChat(userMsg, sid, date, mode, extraContext)) {
        if (chunk.type === 'thinking') {
          fullThinking += chunk.content;
          setMessages((prev) => {
            const updated = [...prev];
            const lastIdx = updated.length - 1;
            if (updated[lastIdx] && (updated[lastIdx].role === 'assistant' || updated[lastIdx].role === 'insight')) {
              updated[lastIdx] = { ...updated[lastIdx], thinking: fullThinking };
            }
            return updated;
          });
        } else if (chunk.type === 'response') {
          fullResponse += chunk.content;
          setMessages((prev) => {
            const updated = [...prev];
            const lastIdx = updated.length - 1;
            if (updated[lastIdx] && (updated[lastIdx].role === 'assistant' || updated[lastIdx].role === 'insight')) {
              updated[lastIdx] = { ...updated[lastIdx], content: fullResponse, sources: pendingSourcesRef.current };
            }
            return updated;
          });
        } else if (chunk.type === 'replace_response') {
          fullResponse = chunk.content;
          setMessages((prev) => {
            const updated = [...prev];
            const lastIdx = updated.length - 1;
            if (updated[lastIdx] && (updated[lastIdx].role === 'assistant' || updated[lastIdx].role === 'insight')) {
              updated[lastIdx] = { ...updated[lastIdx], content: fullResponse, sources: pendingSourcesRef.current };
            }
            return updated;
          });
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
      console.error('流式聊天失败:', e);
    } finally {
      setStreaming(false);
      // 持久化本轮对话，避免退出重进后丢失
      if (sid) {
        try {
          saveMessage(sid, 'user', userMsg);
          if (fullResponse.trim()) {
            saveMessage(sid, role, fullResponse, fullThinking, date, pendingSourcesRef.current.length > 0 ? pendingSourcesRef.current : undefined);
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
      for await (const chunk of streamChatroom(userMsg, history, '', roundsSinceLastSpeech, date, sessionId)) {
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
            const lastIdx = updated.length - 1;
            if (updated[lastIdx] && updated[lastIdx].role !== 'user') {
              updated[lastIdx] = {
                ...updated[lastIdx],
                thinking: (updated[lastIdx].thinking || '') + (chunk.content || '')
              };
            }
            return updated;
          });
        } else if (chunk.type === 'response') {
          setMessages((prev) => {
            const updated = [...prev];
            const lastIdx = updated.length - 1;
            if (updated[lastIdx] && updated[lastIdx].role !== 'user') {
              updated[lastIdx] = {
                ...updated[lastIdx],
                content: (updated[lastIdx].content || '') + (chunk.content || '')
              };
            }
            return updated;
          });
        } else if (chunk.type === 'replace_response') {
          setMessages((prev) => {
            const updated = [...prev];
            const lastIdx = updated.length - 1;
            if (updated[lastIdx] && updated[lastIdx].role !== 'user') {
              updated[lastIdx] = {
                ...updated[lastIdx],
                content: chunk.content || ''
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
      console.error('气氛组聊天失败:', e);
    } finally {
      setStreaming(false);
      // 持久化本轮对话（气氛组有多条消息，逐条保存）
      if (sessionId) {
        try {
          setMessages((prev) => {
            const newMsgs = prev.slice(msgCountBefore - 1);
            for (const m of newMsgs) {
              if (m.role === 'system') continue;
              saveMessage(sessionId, m.role, m.content, m.thinking || '', date);
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
    // 最后一条消息在流式输出时标记为 streaming
    const isStreaming = streaming && index === messages.length - 1;
    return <MessageBubble msg={item} isStreaming={isStreaming} />;
  };

  // 联网搜索状态条
  const renderSearchStatus = () => {
    if (!searchStatus) return null;
    const { stage, query, count } = searchStatus;
    let color = '#4f46e5';
    let text = '';
    let icon = undefined as string | undefined;
    if (stage === 'searching') {
      color = '#4f46e5';
      text = query ? `正在联网搜索：${query}` : '正在联网搜索...';
    } else if (stage === 'done') {
      color = '#10b981';
      text = `已找到 ${count} 条相关结果`;
    } else if (stage === 'skip') {
      color = '#94a3b8';
      text = '未找到相关结果';
      icon = 'search';
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

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <SafeAreaView style={styles.container}>
        {/* Header - 固定在顶部，不随键盘移动 */}
        <View style={styles.header}>
          <Text style={styles.title}>
            {chatMode === 'chatroom' ? 'AI气氛组' : chatMode === 'awareness' ? '觉察助手' : '共情助手'}
          </Text>
          <TouchableOpacity onPress={onClose}>
            <Ionicons name="close" size={24} color="#64748b" />
          </TouchableOpacity>
        </View>

        <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">

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
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  title: { fontSize: 16, fontWeight: '600', color: '#1e293b' },
  messageList: { flex: 1 },
  messageListContent: { padding: 16, paddingBottom: 60 },
  searchStatusBar: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'center',
    marginTop: 4, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 16, borderWidth: 1, backgroundColor: '#f8fafc', maxWidth: '90%',
  },
  searchStatusText: { fontSize: 12, marginLeft: 4 },
  streamingBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 6 },
  streamingText: { fontSize: 12, color: '#94a3b8', marginLeft: 8 },
  inputBar: {
    flexDirection: 'row', alignItems: 'flex-end',
    padding: 12, borderTopWidth: 1, borderTopColor: '#f1f5f9',
  },
  input: {
    flex: 1, backgroundColor: '#f8fafc', borderRadius: 20,
    paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, maxHeight: 100, color: '#334155',
  },
  sendBtn: {
    backgroundColor: '#4f46e5', width: 40, height: 40, borderRadius: 20,
    justifyContent: 'center', alignItems: 'center', marginLeft: 8,
  },
  sendBtnDisabled: { opacity: 0.3 },
});
