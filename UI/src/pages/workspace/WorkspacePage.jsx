import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import { api, getToken, streamFetch } from '../../api';
import { iterateSSE } from '../../../../shared/sse_parser';
import SidebarInfo from './SidebarInfo';
import DiaryEditor from './DiaryEditor';
import ChatSection from './ChatSection';

// 检查是否可编辑（今天或昨天）
const canEditDate = (dateStr) => {
  if (!dateStr) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  target.setHours(0, 0, 0, 0);
  const diffDays = (today - target) / (1000 * 60 * 60 * 24);
  return diffDays >= 0 && diffDays <= 1;
};

const WorkspacePage = forwardRef(({ selectedDate, setSelectedDate, isActive }, ref) => {
  const [diary, setDiary] = useState(null);
  const [diaryContent, setDiaryContent] = useState('');
  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [showWeatherPicker, setShowWeatherPicker] = useState(false);
  const [chatPanelVisible, setChatPanelVisible] = useState(false);
  const [aiGreeting, setAiGreeting] = useState(null);
  const [saveMsg, setSaveMsg] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  // 联网搜索状态条
  const [searchStatus, setSearchStatus] = useState(null);

  // 多会话状态
  const [sessions, setSessions] = useState([]);
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const [sessionListVisible, setSessionListVisible] = useState(false);

  const prevDateRef = useRef('');
  const sessionCreatedRef = useRef(false);
  const abortRef = useRef(null);
  const isDirtyRef = useRef(false);  // 脏标记：用户做了任何编辑才置 true

  // 日记内容变更回调（仅用户编辑时触发，loadDiary 直接 setDiaryContent 不经过此函数）
  const handleDiaryChange = useCallback((content) => {
    isDirtyRef.current = true;
    setDiaryContent(content);
  }, []);

  // 获取日期字符串
  const getDateStr = () => {
    const monthMap = {
      '一月': '01', '二月': '02', '三月': '03', '四月': '04',
      '五月': '05', '六月': '06', '七月': '07', '八月': '08',
      '九月': '09', '十月': '10', '十一月': '11', '十二月': '12',
      '1月': '01', '2月': '02', '3月': '03', '4月': '04',
      '5月': '05', '6月': '06', '7月': '07', '8月': '08',
      '9月': '09', '10月': '10', '11月': '11', '12月': '12'
    };
    const monthStr = monthMap[selectedDate.month] || String(parseInt(selectedDate.month) || 1).padStart(2, '0');
    const dateStr = selectedDate.date.replace('日', '').padStart(2, '0');
    return `${selectedDate.year}-${monthStr}-${dateStr}`;
  };

  const canEdit = canEditDate(getDateStr());

  // 格式化为 "YY年MM月DD日" 如 "26年07月22日"
  const diaryDateLabel = (() => {
    const ds = getDateStr(); // YYYY-MM-DD
    const [y, m, d] = ds.split('-');
    return `${y.slice(2)}年${m}月${d}日`;
  })();

  // 加载日记
  const loadDiary = async () => {
    const dateStr = getDateStr();
    setIsLoading(true);
    try {
      const data = await api.diary.getByDate(dateStr);
      if (data.diary) {
        setDiary(data.diary);
        setDiaryContent(data.diary.content || '');
      } else {
        setDiary(null);
        setDiaryContent('');
      }
      isDirtyRef.current = false;  // 加载完成，重置脏标记
    } catch (error) {
      console.error('加载日记失败:', error);
    }
    setIsLoading(false);
  };

  // 加载会话列表
  const loadSessions = async () => {
    const dateStr = getDateStr();
    try {
      const data = await api.chat.getSessions(dateStr);
      const list = data.sessions || [];
      if (list.length === 0 && !sessionCreatedRef.current) {
        sessionCreatedRef.current = true;
        // 自动创建默认会话
        const createData = await api.chat.createSession(dateStr, '默认对话');
        if (createData.session) {
          setSessions([createData.session]);
          setCurrentSessionId(createData.session.id);
          setMessages([]);
        }
      } else {
        setSessions(list);
        if (list.length > 0) {
          // 默认选中第一个会话
          const sid = currentSessionId && list.find(s => s.id === currentSessionId) ? currentSessionId : list[0].id;
          setCurrentSessionId(sid);
          // 加载该会话的消息
          loadSessionMessages(sid);
        } else {
          // 会话列表为空且未自动创建成功：兜底为无会话的空状态
          setCurrentSessionId(null);
          setMessages([]);
        }
      }
    } catch (error) {
      console.error('加载会话列表失败:', error);
    }
  };

  // 加载指定会话的消息
  const loadSessionMessages = async (sessionId) => {
    if (!sessionId) return;
    try {
      const data = await api.chat.getMessages(sessionId);
      const msgs = data.messages || [];
      if (msgs.length > 0) {
        setMessages(msgs);
      } else {
        setMessages([{ role: 'assistant', content: '今天过得怎么样？我在这里陪你。', thinking: '' }]);
      }
    } catch (error) {
      console.error('加载会话消息失败:', error);
      setMessages([{ role: 'assistant', content: '今天过得怎么样？我在这里陪你。', thinking: '' }]);
    }
  };

  // 每次切换到工作台时收起共情助手
  useEffect(() => {
    if (isActive) {
      setChatPanelVisible(false);
    }
  }, [isActive]);

  // 日期变化时重新加载（用 dateKey 字符串，确保依赖可靠触发）
  const dateKey = getDateStr();
  useEffect(() => {
    prevDateRef.current = dateKey;
    sessionCreatedRef.current = false;
    loadDiary();
    loadSessions();
    setChatPanelVisible(false);
    setSessionListVisible(false);
    setAiGreeting(null);
  }, [dateKey]);

  // 保存日记核心逻辑
  // 使用 prevDateRef 而非 getDateStr() 确定保存目标日期
  // 原因：App.jsx 的 handleDateSelect 会先 setSelectedDate（异步），
  // 再立即调用 saveDiary()，此时 getDateStr() 读取的 selectedDate 还未更新
  const saveDiary = async (silent = false) => {
    const dateStr = prevDateRef.current || getDateStr();
    if (!dateStr || !canEditDate(dateStr)) return;

    setIsSaving(true);
    setSaveMsg('');
    try {
      const payload = {
        date: dateStr,
        content: diaryContent,
        messages: messages.filter(m => !(m.role === 'assistant' && m.content === '今天还没写日记呢，想聊聊吗？')),
        weather: selectedDate.weather,
        tags: []
      };
      const data = await api.diary.save(payload);
      if (data.status === 'ok') {
        setSaveMsg('已保存');
        isDirtyRef.current = false;  // 保存成功，重置脏标记
        setTimeout(() => setSaveMsg(''), 2000);
        // 只有手动保存才触发后续流程：情绪分类 → 总结 → 问候 → 唤出助手
        if (!silent && diaryContent && diaryContent.trim()) {
          // 第 1 步：情绪分类（轻量模型，非阻塞，尽量无感）
          api.diary.classifyEmotion(dateStr, diaryContent).catch(() => {});
          // 第 2 步：快速总结（非阻塞，失败不影响后续）
          api.diary.summarize(dateStr, diaryContent).catch(() => {});
          // 第 3 步：触发问候语生成 + 唤出共情助手
          await fetchGreeting(dateStr);
        }
      } else {
        setSaveMsg('编辑权限已过期');
      }
    } catch (error) {
      console.error('保存日记失败:', error);
      setSaveMsg('保存失败');
    }
    setIsSaving(false);
  };

  // ====== 会话管理函数 ======
  const handleCreateSession = async () => {
    const dateStr = getDateStr();
    try {
      const data = await api.chat.createSession(dateStr, '新对话');
      if (data.session) {
        setSessions(prev => [data.session, ...prev]);
        setCurrentSessionId(data.session.id);
        setMessages([{ role: 'assistant', content: '今天过得怎么样？我在这里陪你。', thinking: '' }]);
      }
    } catch (error) {
      console.error('创建会话失败:', error);
    }
  };

  const handleDeleteSession = async (sessionId) => {
    try {
      await api.chat.deleteSession(sessionId);
      setSessions(prev => {
        const updated = prev.filter(s => s.id !== sessionId);
        if (currentSessionId === sessionId && updated.length > 0) {
          const newSid = updated[0].id;
          setCurrentSessionId(newSid);
          loadSessionMessages(newSid);
        }
        return updated;
      });
    } catch (error) {
      console.error('删除会话失败:', error);
    }
  };

  const handleRenameSession = async (sessionId, title) => {
    try {
      await api.chat.renameSession(sessionId, title);
      setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, title } : s));
    } catch (error) {
      console.error('重命名会话失败:', error);
    }
  };

  const handleSelectSession = (sessionId) => {
    setCurrentSessionId(sessionId);
    loadSessionMessages(sessionId);
  };

  // 流式获取 AI 问候语 — 实时逐 token 渲染
  const fetchGreeting = async (dateStr) => {
    setChatPanelVisible(true);
    // 先插入一条空的 assistant 消息，流式填充
    const greetingIdx = messages.length;
    setMessages(prev => [...prev, { role: 'assistant', content: '', thinking: '', _streaming: true, diaryDate: diaryDateLabel }]);
    setIsStreaming(true);

    try {
      const sid = currentSessionId;
      const url = sid
        ? `/api/chat/sessions/${sid}/greeting/stream`
        : '/api/chat/greeting/stream';
      const response = await streamFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateStr })
      });

      let thinkingAcc = '';
      let responseAcc = '';

      for await (const chunk of iterateSSE(response)) {
        if (chunk.type === 'thinking') {
          thinkingAcc += chunk.content;
        } else if (chunk.type === 'response') {
          responseAcc += chunk.content;
        } else if (chunk.type === 'search_query') {
          setSearchStatus({ stage: 'searching', query: chunk.query || chunk.content || '' });
        } else if (chunk.type === 'search_done') {
          setSearchStatus({ stage: 'done', query: chunk.query || '', count: chunk.count || 0 });
        } else if (chunk.type === 'search_skip') {
          setSearchStatus(null);
        } else if (chunk.type === 'search_error') {
          setSearchStatus({ stage: 'error' });
        } else if (chunk.type === 'replace_response') {
          // 后端发送的替换信号：用清理后的内容替换整个回复
          responseAcc = chunk.content;
        }
        setMessages(prev => {
          const updated = [...prev];
          const idx = updated.length - 1;
          if (updated[idx] && updated[idx]._streaming) {
            updated[idx] = { ...updated[idx], thinking: thinkingAcc, content: responseAcc };
          }
          return updated;
        });
      }

      // 流式结束，移除 _streaming 标记
      setMessages(prev => {
        const updated = [...prev];
        const idx = updated.length - 1;
        if (updated[idx] && updated[idx]._streaming) {
          updated[idx] = { ...updated[idx], _streaming: false, timestamp: Date.now() };
        }
        return updated;
      });

      // 问候语由后端自动保存到会话数据库，无需前端重复保存
    } catch (e) {
      console.error('获取问候语失败:', e);
      setMessages(prev => prev.filter((_, i) => i !== greetingIdx));
    }
    setIsStreaming(false);
  };

  // 保存单条消息到会话
  const saveMessageToSession = async (sessionId, role, content, thinking = '', diaryDate = '') => {
    try {
      await api.chat.saveMessage(sessionId, role, content, thinking, diaryDate);
    } catch (error) {
      console.error('保存消息到会话失败:', error);
    }
  };

  // 暴露给父组件：静默保存 + 脏标记检查
  useImperativeHandle(ref, () => ({
    saveDiary: () => saveDiary(true),
    hasUnsavedChanges: () => isDirtyRef.current,
  }), [diaryContent, messages, selectedDate]);

  // 手动保存按钮
  const handleManualSave = async () => {
    const dateStr = getDateStr();
    if (!canEditDate(dateStr)) {
      setSaveMsg('日记编辑权限仅在当日和次日开放');
      setTimeout(() => setSaveMsg(''), 3000);
      return;
    }
    await saveDiary(false);
  };

  // 天气切换
  const handleWeatherChange = (weather) => {
    isDirtyRef.current = true;
    setSelectedDate({ ...selectedDate, weather });
    setShowWeatherPicker(false);
  };

  // ====== 流式发送共情消息（逐 token 实时渲染） ======
  const handleChat = async (message, images = []) => {
    isDirtyRef.current = true;  // 用户发送消息视为编辑
    // 取消上一次流式请求
    if (abortRef.current) {
      abortRef.current.abort();
    }

    const userMsg = { role: 'user', content: message, images: images || [], thinking: '', timestamp: new Date().toISOString() };
    // 占位消息：初始为空，逐步填充
    const assistantPlaceholder = {
      role: 'assistant',
      content: '',
      thinking: '',
      timestamp: new Date().toISOString(),
      _streaming: true,
      diaryDate: diaryDateLabel
    };
    setMessages(prev => [...prev, userMsg, assistantPlaceholder]);
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;
    let hasError = false;

    try {
      const dateStr = getDateStr();
      const response = await streamFetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, date: dateStr, session_id: currentSessionId, images: images || [] }),
        signal: controller.signal
      });

      let thinkingAcc = '';
      let responseAcc = '';
      let sources = [];

      for await (const chunk of iterateSSE(response)) {
        if (chunk.type === 'thinking') {
          thinkingAcc += chunk.content;
        } else if (chunk.type === 'response') {
          responseAcc += chunk.content;
        } else if (chunk.type === 'search_query') {
          setSearchStatus({ stage: 'searching', query: chunk.query || chunk.content || '' });
        } else if (chunk.type === 'search_done') {
          setSearchStatus({ stage: 'done', query: chunk.query || '', count: chunk.count || 0 });
          // 捕获搜索结果来源，供回答中的 [N] 角标引用
          if (Array.isArray(chunk.results) && chunk.results.length) {
            sources = chunk.results.map((r, i) => ({ index: i + 1, title: r.title || '', url: r.url || '' }));
          }
        } else if (chunk.type === 'search_skip') {
          setSearchStatus(null);
        } else if (chunk.type === 'search_error') {
          setSearchStatus({ stage: 'error' });
        }
        // 每个 SSE 事件立即更新一次状态，不做任何批处理或延迟
        setMessages(prev => {
          const updated = [...prev];
          const lastIdx = updated.length - 1;
          if (updated[lastIdx] && updated[lastIdx]._streaming) {
            updated[lastIdx] = {
              ...updated[lastIdx],
              thinking: thinkingAcc,
              content: responseAcc,
              sources: sources
            };
          }
          return updated;
        });
      }
    } catch (error) {
      if (error.name === 'AbortError') return;
      hasError = true;
      console.error('流式聊天失败:', error);
      setMessages(prev => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        if (updated[lastIdx] && updated[lastIdx]._streaming) {
          updated[lastIdx] = {
            ...updated[lastIdx],
            content: '（连接后端失败，请确认服务已启动）',
            _streaming: false
          };
        }
        return updated;
      });
    } finally {
      // 标记流式完成
      setMessages(prev => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        if (updated[lastIdx] && updated[lastIdx]._streaming) {
          updated[lastIdx] = { ...updated[lastIdx], _streaming: false };
        }
        return updated;
      });
      setIsStreaming(false);
      abortRef.current = null;
      // 如果搜索仍在进行，清除搜索状态
      setSearchStatus(null);
      // 消息由后端流式端点自动保存到会话数据库，无需前端重复保存
    }
  };

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* 顶部栏 */}
      <SidebarInfo
        selectedDate={selectedDate}
        showWeatherPicker={showWeatherPicker}
        onToggleWeatherPicker={() => setShowWeatherPicker(!showWeatherPicker)}
        onWeatherChange={handleWeatherChange}
        saveMsg={saveMsg}
        isSaving={isSaving}
        diary={diary}
        chatPanelVisible={chatPanelVisible}
        onToggleChatPanel={(val) => setChatPanelVisible(val)}
        sessionListVisible={sessionListVisible}
        onToggleSessionList={() => setSessionListVisible(!sessionListVisible)}
      />

      {/* 主内容区 */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* 日记编辑区 */}
        <DiaryEditor
          content={diaryContent}
          editable={canEdit}
          onChange={handleDiaryChange}
          onSave={handleManualSave}
        />

        {/* 聊天区 */}
        <ChatSection
          chatPanelVisible={chatPanelVisible}
          sessionListVisible={sessionListVisible}
          sessions={sessions}
          currentSessionId={currentSessionId}
          messages={messages}
          onSendMessage={handleChat}
          onSelectSession={handleSelectSession}
          onCreateSession={handleCreateSession}
          onDeleteSession={handleDeleteSession}
          onRenameSession={handleRenameSession}
          onToggleChatPanel={(val) => setChatPanelVisible(val)}
          onToggleSessionList={() => setSessionListVisible(false)}
          aiGreeting={aiGreeting}
          searchStatus={searchStatus}
        />
      </div>

      {isLoading && !diary && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/60 z-10">
          <Loader2 size={24} className="animate-spin text-gray-400" />
        </div>
      )}
    </div>
  );
});

WorkspacePage.displayName = 'WorkspacePage';

export default WorkspacePage;
