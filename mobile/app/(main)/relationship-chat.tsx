import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, KeyboardAvoidingView, ActivityIndicator,
  ScrollView, Alert, Modal, Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  getRelationship, extractFromChat,
  refreshRelationshipStream, Relationship, RelationshipDimension,
  RelationshipEvidence,
} from '../../local/relationships';
import { streamChatroom } from '../../local/chatroom';
import { streamChat, createSession, getSessionMessages, getSessionByTitle, saveMessage } from '../../local/chat';
import MessageBubble from '../../components/MessageBubble';
import AiSwitcherBar from '../../components/AiSwitcherBar';

interface ChatMsg {
  role: string;
  content: string;
  thinking?: string;
  sources?: { index: number; title: string; url: string }[];
}

export default function RelationshipChatScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; person_name: string; followup?: string; opening?: string }>();

  const [relationship, setRelationship] = useState<Relationship | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showProfile, setShowProfile] = useState(false);
  const [followupQuestions, setFollowupQuestions] = useState<string[]>([]);
  const [updatingProfile, setUpdatingProfile] = useState(false);
  const [refreshingFromDiary, setRefreshingFromDiary] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState('');
  const [chatMode, setChatMode] = useState<'empathy' | 'awareness' | 'chatroom'>('awareness');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [roundsSinceLastSpeech, setRoundsSinceLastSpeech] = useState(0);
  // 联网搜索状态条
  const [searchStatus, setSearchStatus] = useState<{ stage: 'searching' | 'done' | 'error' | 'skip'; query?: string; count?: number } | null>(null);
  const searchDoneTimer = useRef<any>(null);
  const flatListRef = useRef<FlatList>(null);
  const keyboardDidShowListener = useRef<any>(null);
  // 流式期间捕获的联网搜索引用来源，供回答中的 [N] 角标使用
  const pendingSourcesRef = useRef<{ index: number; title: string; url: string }[]>([]);
  // 开场白持久化防重标记：只把开场白写入会话一次，避免重复保存
  const openingPersistedRef = useRef(false);
  // 本地消息是否已初始化（避免开场白 useEffect 覆盖从会话加载的历史）
  const messagesInitRef = useRef(false);

  useEffect(() => {
    if (params.id) loadData();
  }, [params.id]);

  useEffect(() => {
    if (params.followup) {
      const questions = params.followup.split('|||').filter(Boolean);
      if (questions.length > 0) setFollowupQuestions(questions);
    }
  }, [params.followup]);

  // 开场白仅在没有历史消息时作为首条展示；历史消息由 loadSessions 统一加载
  useEffect(() => {
    if (params.opening && !messagesInitRef.current) {
      setMessages([{ role: 'insight', content: params.opening }]);
    }
  }, [params.opening]);

  // 键盘弹起时自动滚动到底部，避免最新消息和输入框被键盘挡住
  useEffect(() => {
    const handleShow = () => {
      // 延迟稍长一些，确保 KeyboardAvoidingView 布局完成后再滚动
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

  const getAiOptions = () => {
    return [
      { key: 'empathy', label: '共情助手', icon: 'heart' as const },
      { key: 'awareness', label: '觉察助手', icon: 'bulb' as const },
      { key: 'chatroom', label: '气氛组', icon: 'people' as const },
    ];
  };

  const loadData = async () => {
    try {
      setLoading(true);
      const rel = await getRelationship(params.id);
      setRelationship(rel);
      if (rel.profile_content) {
        setShowProfile(false);
      }
      await loadSessions();
    } catch (e) {
      console.error('加载关系档案失败:', e);
    } finally {
      setLoading(false);
    }
  };

  const loadSessions = async () => {
    try {
      const title = `关系-${params.id}`;
      const openingMsg = params.opening;
      const existing = await getSessionByTitle(title);
      if (existing) {
        setSessionId(existing.id);
        const msgs = await getSessionMessages(existing.id);
        if (msgs.length > 0) {
          setMessages(msgs.map(m => ({ role: m.role, content: m.content, thinking: m.thinking, sources: m.sources })));
        } else if (openingMsg && !openingPersistedRef.current) {
          // 会话为空但存在开场白：展示并持久化，避免退出重进后消失
          openingPersistedRef.current = true;
          setMessages([{ role: 'insight', content: openingMsg }]);
          saveMessage(existing.id, 'insight', openingMsg);
        }
        messagesInitRef.current = true;
      } else {
        const today = new Date().toISOString().split('T')[0];
        const session = await createSession(today, title);
        setSessionId(session.id);
        if (openingMsg) {
          openingPersistedRef.current = true;
          setMessages([{ role: 'insight', content: openingMsg }]);
          saveMessage(session.id, 'insight', openingMsg);
        }
        messagesInitRef.current = true;
      }
    } catch (e) {
      console.error('加载会话失败:', e);
    }
  };

  const buildChatroomContext = (): string => {
    if (!relationship) return '';
    let ctx = `## 当前关系分析\n你正在帮助用户分析与「${params.person_name}」的人际关系。\n`;
    ctx += `\n### 关系档案\n${relationship.profile_content || '（档案尚未生成，请通过对话了解这段关系）'}\n`;
    if (relationship.dimensions && relationship.dimensions.length > 0) {
      const dimsText = relationship.dimensions.map((d: RelationshipDimension) => `- ${d.label}：${d.description || ''}`).join('\n');
      ctx += `\n### 分析维度\n${dimsText}\n`;
    }
    if (relationship.evidence && relationship.evidence.length > 0) {
      const evidenceText = relationship.evidence
        .map((e: RelationshipEvidence) => `【${e.date}】${e.text}`)
        .join('\n');
      ctx += `\n### 相关日记证据\n${evidenceText}\n`;
    }
    if (followupQuestions.length > 0) {
      ctx += `\n### 待了解的问题\n${followupQuestions.map(q => `- ${q}`).join('\n')}\n`;
    }
    return ctx;
  };

  const buildExtraContext = (): string => {
    if (!relationship) return '';
    let ctx = `## 当前关系分析背景\n用户正在分析与「${params.person_name}」的人际关系。\n`;
    ctx += `\n### 关系档案\n${relationship.profile_content || '（档案尚未生成）'}\n`;
    if (relationship.dimensions && relationship.dimensions.length > 0) {
      const dimsText = relationship.dimensions.map((d: RelationshipDimension) => `- ${d.label}：${d.description || ''}`).join('\n');
      ctx += `\n### 分析维度\n${dimsText}\n`;
    }
    if (relationship.evidence && relationship.evidence.length > 0) {
      const evidenceText = relationship.evidence
        .map((e: RelationshipEvidence) => `【${e.date}】${e.text}`)
        .join('\n');
      ctx += `\n### 相关日记证据\n${evidenceText}\n`;
    }
    if (followupQuestions.length > 0) {
      ctx += `\n### 待了解的问题\n${followupQuestions.map(q => `- ${q}`).join('\n')}\n`;
    }
    return ctx;
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
    } else if (chatMode === 'empathy') {
      await handleEmpathySend(userMsg);
    } else {
      await handleAwarenessSend(userMsg);
    }
  };

  const handleEmpathySend = async (userMsg: string) => {
    if (!sessionId) return;
    let fullResponse = '';
    let fullThinking = '';
    pendingSourcesRef.current = [];
    setMessages((prev) => [...prev, { role: 'assistant', content: '', thinking: '' }]);

    try {
      const today = new Date().toISOString().split('T')[0];
      const extraCtx = buildExtraContext();
      for await (const chunk of streamChat(userMsg, sessionId, today, 'empathy', extraCtx, false)) {
        if (chunk.type === 'thinking') {
          fullThinking += chunk.content;
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.role === 'assistant') {
              updated[updated.length - 1] = { ...last, thinking: fullThinking };
            }
            return updated;
          });
        } else if (chunk.type === 'response') {
          fullResponse += chunk.content;
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.role === 'assistant') {
              updated[updated.length - 1] = { ...last, content: fullResponse, sources: pendingSourcesRef.current };
            }
            return updated;
          });
        } else if (chunk.type === 'replace_response') {
          fullResponse = chunk.content;
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.role === 'assistant') {
              updated[updated.length - 1] = { ...last, content: fullResponse, sources: pendingSourcesRef.current };
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
      console.error('共情助手对话失败:', e);
    } finally {
      setStreaming(false);
      // 持久化本轮对话，避免退出重进后丢失（与主对话空间一致）
      if (sessionId) {
        try {
          saveMessage(sessionId, 'user', userMsg);
          if (fullResponse.trim()) {
            saveMessage(sessionId, 'assistant', fullResponse, fullThinking, '', pendingSourcesRef.current.length > 0 ? pendingSourcesRef.current : undefined);
          }
        } catch (e) {
          console.warn('保存对话失败:', e);
        }
      }
    }
  };

  const handleAwarenessSend = async (userMsg: string) => {
    if (!sessionId) return;
    let fullResponse = '';
    let fullThinking = '';
    pendingSourcesRef.current = [];
    setMessages((prev) => [...prev, { role: 'insight', content: '', thinking: '' }]);

    try {
      const today = new Date().toISOString().split('T')[0];
      const extraCtx = buildExtraContext();
      for await (const chunk of streamChat(userMsg, sessionId, today, 'awareness', extraCtx, false)) {
        if (chunk.type === 'thinking') {
          fullThinking += chunk.content;
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.role === 'insight') {
              updated[updated.length - 1] = { ...last, thinking: fullThinking };
            }
            return updated;
          });
        } else if (chunk.type === 'response') {
          fullResponse += chunk.content;
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.role === 'insight') {
              updated[updated.length - 1] = { ...last, content: fullResponse, sources: pendingSourcesRef.current };
            }
            return updated;
          });
        } else if (chunk.type === 'replace_response') {
          fullResponse = chunk.content;
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.role === 'insight') {
              updated[updated.length - 1] = { ...last, content: fullResponse, sources: pendingSourcesRef.current };
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
      console.error('觉察助手对话失败:', e);
    } finally {
      setStreaming(false);
      // 持久化本轮对话，避免退出重进后丢失（与主对话空间一致）
      if (sessionId) {
        try {
          saveMessage(sessionId, 'user', userMsg);
          if (fullResponse.trim()) {
            saveMessage(sessionId, 'insight', fullResponse, fullThinking, '', pendingSourcesRef.current.length > 0 ? pendingSourcesRef.current : undefined);
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
    const context = buildChatroomContext();
    const today = new Date().toISOString().split('T')[0];

    try {
      for await (const chunk of streamChatroom(userMsg, history, context, roundsSinceLastSpeech, today, sessionId, false)) {
        if (chunk.type === 'speaker') {
          const speakerKey = chunk.speaker || 'assistant';
          pendingSourcesRef.current = []; // 新发言者：清空上一位的搜索来源
          setMessages((prev) => [...prev, {
            role: speakerKey,
            content: '',
            thinking: '',
          }]);
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

  const handleUpdateProfile = async () => {
    if (messages.length === 0) {
      Alert.alert('提示', '还没有对话记录，先聊几句再更新档案吧');
      return;
    }
    setUpdatingProfile(true);
    try {
      const conversation = messages.map(m => ({ role: m.role, content: m.content }));
      const result = await extractFromChat(params.id, conversation);
      setRelationship(result.relationship);
      if (result.new_facts.length > 0) {
        Alert.alert('档案已更新', `提取到 ${result.new_facts.length} 条新信息`);
      } else {
        Alert.alert('档案已更新', '暂时没捕捉到新的有价值信息');
      }
      setFollowupQuestions([]);
    } catch (e: any) {
      Alert.alert('更新失败', e.message || '请稍后重试');
    } finally {
      setUpdatingProfile(false);
    }
  };

  const handleRefreshFromDiary = async () => {
    setRefreshingFromDiary(true);
    setRefreshProgress('正在搜索日记...');
    try {
      let resultRel: any = null;
      let resultStatus = '';
      let resultFollowups: string[] = [];
      let resultOpening = '';
      let errorMsg = '';

      for await (const chunk of refreshRelationshipStream(params.id)) {
        if (chunk.type === 'progress') {
          setRefreshProgress(chunk.message || '');
        } else if (chunk.type === 'result') {
          resultRel = chunk.relationship;
          resultStatus = chunk.status || '';
          resultFollowups = chunk.followup_questions || [];
          resultOpening = chunk.opening_message || '';
        } else if (chunk.type === 'error') {
          errorMsg = chunk.message || '更新失败';
        }
      }

      if (errorMsg) {
        Alert.alert('更新失败', errorMsg);
      } else if (resultRel) {
        setRelationship(resultRel);
        if (resultFollowups.length > 0) {
          setFollowupQuestions(resultFollowups);
        } else {
          setFollowupQuestions([]);
        }
        if (resultOpening) {
          setMessages((prev) => [...prev, { role: 'insight', content: resultOpening }]);
        }
        if (resultStatus === 'no_new_evidence') {
          Alert.alert('无新内容', '没有找到新的相关日记');
        } else {
          Alert.alert('档案已更新', '已从日记中提取最新信息并更新档案');
        }
      }
    } catch (e: any) {
      Alert.alert('更新失败', e.message || '请稍后重试');
    } finally {
      setRefreshingFromDiary(false);
      setRefreshProgress('');
    }
  };

  const selectChatMode = (key: string) => {
    setChatMode(key as 'empathy' | 'awareness' | 'chatroom');
    setRoundsSinceLastSpeech(0);
  };

  const getDimensionContent = (profileContent: string, dimensionLabel: string): string => {
    if (!profileContent) return '';
    try {
      const obj = JSON.parse(profileContent);
      if (typeof obj === 'object' && obj !== null) {
        const val = obj[dimensionLabel];
        if (typeof val === 'string') return val;
        if (val != null) return String(val);
        return '';
      }
    } catch {
      // 不是 JSON，继续用正则
    }
    const pattern = new RegExp(
      `【${dimensionLabel}】([\\s\\S]*?)(?=【[^】]+】|$)`
    );
    const match = profileContent.match(pattern);
    return match ? match[1].trim() : '';
  };

  const renderMessage = ({ item, index }: { item: ChatMsg; index: number }) => {
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

  const handleBack = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(main)/relationships');
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.header}>
          <TouchableOpacity onPress={handleBack} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color="#4f46e5" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{params.person_name || '加载中'}</Text>
          <View style={{ width: 30 }} />
        </View>
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#4f46e5" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header - 固定在顶部，不随键盘移动 */}
      <View style={styles.header}>
        <TouchableOpacity onPress={handleBack} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color="#4f46e5" />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{params.person_name}</Text>
        <TouchableOpacity
          onPress={() => setShowProfile(!showProfile)}
          style={styles.profileBtn}
        >
          <Ionicons name={showProfile ? 'document-text' : 'document-text-outline'} size={22} color="#4f46e5" />
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">

        {/* Followup questions banner */}
        {followupQuestions.length > 0 && (
          <View style={styles.followupBanner}>
            <View style={styles.followupHeader}>
              <Ionicons name="help-circle" size={16} color="#f59e0b" />
              <Text style={styles.followupTitle}>待了解的问题</Text>
            </View>
            {followupQuestions.map((q, i) => (
              <Text key={i} style={styles.followupItem}>• {q}</Text>
            ))}
          </View>
        )}

        {/* Profile panel (Modal full-screen) */}
        <Modal visible={showProfile} animationType="slide" onRequestClose={() => setShowProfile(false)}>
          <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }} edges={['top']}>
            <View style={styles.header}>
              <TouchableOpacity onPress={() => setShowProfile(false)} style={styles.backBtn}>
                <Ionicons name="arrow-back" size={22} color="#4f46e5" />
              </TouchableOpacity>
              <Text style={styles.headerTitle} numberOfLines={1}>{params.person_name} 的档案</Text>
              <View style={{ width: 30 }} />
            </View>
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
              {/* Dimensions Table */}
              {relationship?.dimensions && relationship.dimensions.length > 0 ? (
                <View style={styles.dimTable}>
                  {relationship.dimensions.map((d: RelationshipDimension, i: number) => {
                    const content = getDimensionContent(relationship.profile_content, d.label);
                    return (
                      <View key={i} style={[styles.dimTableRow, i === relationship.dimensions.length - 1 && styles.dimTableRowLast]}>
                        <View style={[styles.dimTableLabel, d.fixed ? styles.dimLabelFixed : styles.dimLabelCustom]}>
                          <Text style={styles.dimTableLabelText}>{d.label}</Text>
                        </View>
                        <View style={styles.dimTableValue}>
                          <Text style={styles.dimTableValueText}>{content || '暂无信息'}</Text>
                        </View>
                      </View>
                    );
                  })}
                </View>
              ) : (
                <Text style={styles.profileText}>
                  {relationship?.profile_content || '（档案尚未生成，请通过对话补充信息后点击"更新档案"）'}
                </Text>
              )}

              {/* Evidence Timeline */}
              {relationship?.evidence && relationship.evidence.length > 0 ? (
                <View style={styles.evidenceSection}>
                  <Text style={styles.evidenceSectionTitle}>共同记忆</Text>
                  {[...relationship.evidence]
                    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
                    .map((item: RelationshipEvidence, i: number) => (
                      <View key={i} style={styles.timelineItem}>
                        <View style={styles.timelineDot} />
                        <View style={styles.timelineContent}>
                          <Text style={styles.timelineDate}>{item.date}</Text>
                          <Text style={styles.timelineText}>{item.text}</Text>
                        </View>
                      </View>
                    ))}
                </View>
              ) : null}
            </ScrollView>
          </SafeAreaView>
        </Modal>

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

        {/* Refresh progress */}
        {refreshingFromDiary && (
          <View style={styles.refreshProgress}>
            <ActivityIndicator size="small" color="#4f46e5" />
            <Text style={styles.refreshProgressText}>{refreshProgress}</Text>
          </View>
        )}

        {/* Action buttons */}
        <View style={styles.actionBar}>
          <TouchableOpacity
            style={[styles.updateBtn, updatingProfile && styles.updateBtnDisabled]}
            onPress={handleUpdateProfile}
            disabled={updatingProfile || refreshingFromDiary}
          >
            {updatingProfile ? (
              <ActivityIndicator size="small" color="#4f46e5" />
            ) : (
              <>
                <Ionicons name="chatbubbles" size={16} color="#4f46e5" />
                <Text style={styles.updateBtnText}>从对话更新</Text>
              </>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.refreshBtn, refreshingFromDiary && styles.updateBtnDisabled]}
            onPress={handleRefreshFromDiary}
            disabled={refreshingFromDiary || updatingProfile}
          >
            {refreshingFromDiary ? (
              <ActivityIndicator size="small" color="#0891b2" />
            ) : (
              <>
                <Ionicons name="book" size={16} color="#0891b2" />
                <Text style={styles.refreshBtnText}>从日记更新</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* AI mode switcher bar */}
        <AiSwitcherBar
          options={getAiOptions()}
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
            placeholder={chatMode === 'chatroom' ? '在气氛组中说点什么...' : chatMode === 'awareness' ? '和觉察伙伴聊聊这段关系...' : '和共情助手聊聊这段关系...'}
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
  headerTitle: { fontSize: 18, fontWeight: '700', color: '#1e293b', flex: 1, textAlign: 'center' },
  profileBtn: { padding: 4 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  followupBanner: {
    backgroundColor: '#fef3c7',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#fde68a',
  },
  followupHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  followupTitle: { fontSize: 13, fontWeight: '600', color: '#92400e', marginLeft: 4 },
  followupItem: { fontSize: 13, color: '#78350f', marginLeft: 8, marginBottom: 2 },
  // Dimension table
  dimTable: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    overflow: 'hidden',
    marginBottom: 16,
  },
  dimTableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  dimTableRowLast: { borderBottomWidth: 0 },
  dimTableLabel: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    justifyContent: 'center',
  },
  dimLabelFixed: { backgroundColor: '#e0e7ff' },
  dimLabelCustom: { backgroundColor: '#fef3c7' },
  dimTableLabelText: { fontSize: 13, fontWeight: '600', color: '#3730a3' },
  dimTableValue: {
    flex: 2,
    paddingVertical: 10,
    paddingHorizontal: 12,
    justifyContent: 'center',
    borderLeftWidth: 1,
    borderLeftColor: '#e2e8f0',
  },
  dimTableValueText: { fontSize: 13, color: '#475569', lineHeight: 20 },
  profileText: { fontSize: 14, color: '#475569', lineHeight: 22 },
  // Evidence timeline
  evidenceSection: { marginTop: 8 },
  evidenceSectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1e293b',
    marginBottom: 12,
  },
  timelineItem: {
    flexDirection: 'row',
    marginBottom: 16,
  },
  timelineDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#4f46e5',
    marginTop: 4,
    marginRight: 12,
  },
  timelineContent: {
    flex: 1,
    backgroundColor: '#f8fafc',
    borderRadius: 8,
    padding: 12,
  },
  timelineDate: {
    fontSize: 13,
    fontWeight: '600',
    color: '#4f46e5',
    marginBottom: 4,
  },
  timelineText: {
    fontSize: 13,
    color: '#475569',
    lineHeight: 20,
  },
  messageList: { flex: 1 },
  messageListContent: { padding: 16, paddingBottom: 32 },
  searchStatusBar: {
    flexDirection: 'row', alignItems: 'center', alignSelf: 'center',
    marginTop: 4, marginBottom: 8, paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 16, borderWidth: 1, backgroundColor: '#f8fafc', maxWidth: '90%',
  },
  searchStatusText: { fontSize: 12, marginLeft: 4 },
  streamingBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 6 },
  streamingText: { fontSize: 12, color: '#94a3b8', marginLeft: 8 },
  actionBar: {
    paddingHorizontal: 16,
    paddingVertical: 4,
    flexDirection: 'row',
    gap: 8,
  },
  updateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#eef2ff',
  },
  refreshBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#ecfeff',
  },
  updateBtnDisabled: { opacity: 0.4 },
  updateBtnText: { fontSize: 13, color: '#4f46e5', marginLeft: 6, fontWeight: '500' },
  refreshBtnText: { fontSize: 13, color: '#0891b2', marginLeft: 6, fontWeight: '500' },
  refreshProgress: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  refreshProgressText: { fontSize: 12, color: '#64748b', marginLeft: 8 },
  inputBar: {
    flexDirection: 'row', alignItems: 'flex-end',
    padding: 12, paddingBottom: 24, borderTopWidth: 1, borderTopColor: '#f1f5f9',
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
