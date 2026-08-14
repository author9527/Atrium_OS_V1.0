import React, { useState, useEffect, useRef } from 'react';
import {
  ChevronLeft, Send, Square, Sparkles, Loader2,
  BookOpen, MessageCircle, HelpCircle, CheckCircle2
} from 'lucide-react';
import { getToken, API_BASE, streamFetch } from '../../api';
import { api } from '../../api';
import { iterateSSE } from '../../../../shared/sse_parser';
import MarkdownRenderer from '../MarkdownRenderer';

// 规范化依据字段：兼容 JSON 数组字符串 / 数组 / 多行文本，统一为条目数组
const splitEvidence = (value) => {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  const s = String(value).trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) {
        const items = arr.map((v) => String(v).trim()).filter(Boolean);
        if (items.length) return items;
      }
    } catch { /* 非合法 JSON，走整段 */ }
  }
  return s.split('\n').map((x) => x.trim()).filter(Boolean);
};

// ==========================================
// AssistantBubble — 助手消息气泡（带思考过程折叠）
// ==========================================

const AssistantBubble = ({ content, thinking, isStreaming }) => {
  const [showThinking, setShowThinking] = useState(false);
  const hasThinking = thinking && thinking.trim().length > 0;
  const hasContent = content && content.trim().length > 0;

  // 流式输出中：思考过程默认展开
  useEffect(() => {
    if (isStreaming && hasThinking && !hasContent) {
      setShowThinking(true);
    }
  }, [isStreaming, hasThinking, hasContent]);

  // 当正式回复开始出现时，自动折叠思考过程
  useEffect(() => {
    if (isStreaming && hasContent) {
      setShowThinking(false);
    }
  }, [isStreaming, hasContent]);

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-xl border border-gray-200 text-gray-800 rounded-bl-md bg-white overflow-hidden">
        {/* 思考过程栏 */}
        {hasThinking && (
          <div className="border-b border-gray-100">
            <button
              onClick={() => setShowThinking(!showThinking)}
              className="w-full flex items-center justify-between px-4 py-2 text-xs text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors select-none"
            >
              <span className="flex items-center gap-1.5">
                <svg
                  className={`w-3 h-3 transition-transform duration-200 ${showThinking ? 'rotate-180' : ''}`}
                  viewBox="0 0 12 12"
                  fill="currentColor"
                >
                  <path d="M6 3 L10 8 L2 8 Z" />
                </svg>
                {showThinking ? '收起思考' : '思考过程'}
              </span>
              {isStreaming && !hasContent && (
                <span className="flex items-center gap-1">
                  <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-pulse" />
                  正在思考...
                </span>
              )}
            </button>
            {showThinking && (
              <div className="px-4 py-2.5 text-xs text-gray-500 leading-relaxed bg-gray-50 border-l-2 border-indigo-200">
                <MarkdownRenderer text={thinking} />
              </div>
            )}
          </div>
        )}
        {/* 消息正文 */}
        <div className="px-4 py-2.5 text-sm leading-relaxed">
          <MarkdownRenderer text={content} />
          {isStreaming && (
            <span className="inline-block w-1.5 h-4 bg-indigo-500 ml-0.5 animate-pulse align-middle rounded-sm" />
          )}
        </div>
      </div>
    </div>
  );
};

// ==========================================
// BranchChat — 支线深入对话视图
// 包含：顶部栏、观察/证据/追问卡片、对话记录、总结、底部输入区
// ==========================================

const BranchChat = ({
  branch,
  resultId,
  onBack,
  activeBranch,
  setActiveBranch,
}) => {
  const [chatInput, setChatInput] = useState('');
  const [isChatting, setIsChatting] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [chatMode, setChatMode] = useState('awareness'); // "awareness" | "empathy"，互动模式跟随所选 AI
  const chatEndRef = useRef(null);
  const abortRef = useRef(null);

  // 滚动到聊天底部
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [activeBranch]);

  // 停止流式输出
  const handleStopStreaming = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsStreaming(false);
    setIsChatting(false);
  };

  // 发送消息（流式 SSE + 乐观更新）
  const handleSendMessage = async () => {
    if (!chatInput.trim() || !resultId || !branch?.id || isStreaming) return;
    const msg = chatInput.trim();
    setChatInput('');
    setIsChatting(true);
    setIsStreaming(true);

    // 乐观更新：立即显示用户消息 + 空的助手占位
    setActiveBranch(prev => ({
      ...prev,
      conversation: [
        ...(prev.conversation || []),
        { role: 'user', content: msg },
        { role: 'assistant', content: '', thinking: '', _streaming: true }
      ]
    }));

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const streamUrl = `/api/insight/result/${resultId}/branch/${branch.id}/chat/stream`;
      const response = await streamFetch(streamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, mode: chatMode }),
        signal: controller.signal
      });

      let responseAcc = '';
      let thinkingAcc = '';

      for await (const chunk of iterateSSE(response)) {
        if (chunk.type === 'error') {
          responseAcc = chunk.content;
        } else if (chunk.type === 'thinking') {
          thinkingAcc += chunk.content;
        } else if (chunk.type === 'response') {
          responseAcc += chunk.content;
        }
        setActiveBranch(prev => {
          const conv = [...(prev.conversation || [])];
          const lastIdx = conv.length - 1;
          if (conv[lastIdx] && conv[lastIdx]._streaming) {
            conv[lastIdx] = { ...conv[lastIdx], content: responseAcc, thinking: thinkingAcc };
          }
          return { ...prev, conversation: conv };
        });
      }

      // 流式完成，移除 _streaming 标记
      setActiveBranch(prev => {
        const conv = [...(prev.conversation || [])];
        const lastIdx = conv.length - 1;
        if (conv[lastIdx] && conv[lastIdx]._streaming) {
          conv[lastIdx] = { ...conv[lastIdx], _streaming: false };
        }
        return { ...prev, conversation: conv };
      });
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.error('对话失败', e);
      setActiveBranch(prev => {
        const conv = [...(prev.conversation || [])];
        const lastIdx = conv.length - 1;
        if (conv[lastIdx] && conv[lastIdx]._streaming) {
          conv[lastIdx] = { ...conv[lastIdx], content: '（连接失败，请确认服务已启动）', _streaming: false };
        }
        return { ...prev, conversation: conv };
      });
    } finally {
      setIsChatting(false);
      setIsStreaming(false);
      abortRef.current = null;
    }
  };

  // 生成总结
  const handleSummarize = async () => {
    if (!resultId || !branch?.id) return;
    setIsSummarizing(true);
    try {
      const data = await api.insight.branchSummarize(resultId, branch.id);
      if (data.summary) {
        setActiveBranch(prev => ({ ...prev, summary: data.summary }));
      }
    } catch (e) {
      console.error('总结失败', e);
    } finally {
      setIsSummarizing(false);
    }
  };

  const conversation = activeBranch?.conversation || [];
  const hasConversation = conversation.length > 0;
  const hasSummary = !!activeBranch?.summary;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 顶部栏 */}
      <div className="px-6 py-3 border-b border-gray-200 bg-white flex items-center gap-3 shrink-0">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 transition-colors"
        >
          <ChevronLeft size={16} />返回总览
        </button>
        <span className="text-gray-300">|</span>
        <span className="text-sm font-medium text-gray-700">{activeBranch?.title}</span>
      </div>

      {/* 可滚动内容 */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="max-w-2xl mx-auto space-y-5">

          {/* 观察卡片 */}
          <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-2">
              <BookOpen size={15} className="text-indigo-500" />
              <span className="text-xs font-semibold text-indigo-600 uppercase tracking-wide">觉察</span>
            </div>
            <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">{activeBranch?.observation}</p>
          </div>

          {/* 证据卡片 */}
          {activeBranch?.evidence && splitEvidence(activeBranch.evidence).length > 0 && (
            <div className="bg-amber-50 rounded-xl border border-amber-200 p-4">
              <div className="flex items-center gap-2 mb-2">
                <MessageCircle size={15} className="text-amber-600" />
                <span className="text-xs font-semibold text-amber-700 uppercase tracking-wide">日记原文</span>
              </div>
              <ul className="space-y-2">
                {splitEvidence(activeBranch.evidence).map((item, idx) => (
                  <li key={idx} className="flex items-start gap-1.5">
                    <span className="text-amber-500 mt-0.5">•</span>
                    <span className="text-sm text-amber-900 leading-relaxed italic">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 追问卡片 */}
          <div className="bg-indigo-50 rounded-xl border border-indigo-200 p-4">
            <div className="flex items-center gap-2 mb-2">
              <HelpCircle size={15} className="text-indigo-600" />
              <span className="text-xs font-semibold text-indigo-700 uppercase tracking-wide">追问</span>
            </div>
            <p className="text-sm text-indigo-900 leading-relaxed">{activeBranch?.question}</p>
          </div>

          {/* 对话记录 */}
          {hasConversation && (
            <div className="space-y-3">
              <div className="text-xs text-gray-400 font-medium pt-2">探索对话</div>
              {conversation.map((msg, i) => (
                msg.role === 'user' ? (
                  <div key={i} className="flex justify-end">
                    <div className="max-w-[85%] rounded-xl px-4 py-2.5 text-sm leading-relaxed bg-indigo-600 text-white rounded-br-md whitespace-pre-wrap">
                      {msg.content}
                    </div>
                  </div>
                ) : (
                  <AssistantBubble
                    key={i}
                    content={msg.content}
                    thinking={msg.thinking || ''}
                    isStreaming={msg._streaming === true}
                  />
                )
              ))}
              <div ref={chatEndRef} />
            </div>
          )}

          {/* 总结 */}
          {hasSummary && (
            <div className="bg-green-50 rounded-xl border border-green-200 p-4">
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle2 size={15} className="text-green-600" />
                <span className="text-xs font-semibold text-green-700 uppercase tracking-wide">支线总结</span>
              </div>
              <p className="text-sm text-green-900 leading-relaxed">{activeBranch.summary}</p>
            </div>
          )}

          {/* 底部免责 */}
          <div className="pt-4 pb-2">
            <p className="text-xs text-gray-400 text-center">
              以上分析基于日记中的文字，不构成对他人真实想法的判断。
            </p>
          </div>
        </div>
      </div>

      {/* 底部输入区 */}
      <div className="px-6 py-3 border-t border-gray-200 bg-white shrink-0">
        {/* AI 模式选择：互动模式跟随所选 AI（觉察助手 / 共情助手） */}
        <div className="max-w-2xl mx-auto mb-2 flex items-center gap-1.5">
          <span className="text-xs text-gray-400 mr-1">对话AI</span>
          <button
            onClick={() => setChatMode('awareness')}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${chatMode === 'awareness' ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
          >觉察助手</button>
          <button
            onClick={() => setChatMode('empathy')}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${chatMode === 'empathy' ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
          >共情助手</button>
        </div>
        <div className="max-w-2xl mx-auto flex items-center gap-2">
          <input
            type="text"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !isStreaming) {
                e.preventDefault();
                handleSendMessage();
              }
            }}
            placeholder={chatMode === 'empathy'
              ? '和共情助手聊聊这条支线...'
              : (hasSummary ? '这条支线已总结，你可以继续聊...' : '输入你的想法，或直接说"展开聊聊"...')}
            className="flex-1 px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300 transition-all"
            disabled={isStreaming}
          />
          {isStreaming ? (
            <button
              onClick={handleStopStreaming}
              className="p-2.5 bg-red-500 hover:bg-red-400 text-white rounded-xl transition-colors"
              title="停止生成"
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              onClick={handleSendMessage}
              disabled={isChatting || !chatInput.trim()}
              className="p-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded-xl transition-colors"
            >
              <Send size={16} />
            </button>
          )}
          <button
            onClick={handleSummarize}
            disabled={isSummarizing || !hasConversation}
            className="px-3 py-2.5 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-40 text-gray-700 rounded-xl text-sm transition-colors flex items-center gap-1.5 shrink-0"
          >
            {isSummarizing ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Sparkles size={14} />
            )}
            总结
          </button>
        </div>
      </div>
    </div>
  );
};

export default BranchChat;
