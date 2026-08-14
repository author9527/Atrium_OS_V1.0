import React, { useState } from 'react';
import MarkdownRenderer from '../pages/MarkdownRenderer';

// ==========================================
// ChatBubble - 聊天气泡组件
// 支持：用户消息 / AI 消息 / 系统消息 三种类型
// 支持：thinking 状态（思考中动画）
// 支持：markdown 渲染
// 样式与 ChatPanel 保持一致
// ==========================================

/**
 * 格式化日记日期
 * @param {string} d - 日期字符串
 * @returns {string} 格式化后的日期
 */
const formatDiaryDate = (d) => {
  if (!d) return '';
  // 兼容 "26年07月22日" 和 "2026-07-22" 两种格式
  if (d.includes('年')) return d;
  const parts = d.split('-');
  if (parts.length !== 3) return d;
  return `${parts[0].slice(2)}年${parts[1]}月${parts[2]}日`;
};

/**
 * 格式化时间戳
 * @param {number|string} timestamp - 时间戳
 * @returns {string} 格式化后的时间
 */
const formatTime = (timestamp) => {
  if (!timestamp) return '';
  const n = Number(timestamp);
  if (!Number.isFinite(n)) return '';
  // 数据库存的是 epoch 秒（如 1786086903），new Date() 需要毫秒，这里统一换算
  const ms = n < 1e12 ? n * 1000 : n;
  return new Date(ms).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  });
};

/**
 * 思考中动画组件
 */
const ThinkingDots = () => (
  <div className="flex items-center gap-1">
    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
  </div>
);

/**
 * 聊天气泡组件
 * @param {object} props
 * @param {object} props.message - 消息对象 { role, content, thinking, timestamp, diaryDate, ... }
 * @param {'user'|'assistant'|'system'} [props.role] - 消息角色，优先使用 message.role
 * @param {string} [props.content] - 消息内容，优先使用 message.content
 * @param {string} [props.thinking] - 思考过程内容
 * @param {boolean} [props.isStreaming] - 是否流式输出中
 * @param {boolean} [props.isThinking] - 是否处于思考中状态（无内容时显示思考动画）
 * @param {string} [props.diaryDate] - 参考日记日期
 * @param {number|string} [props.timestamp] - 时间戳
 * @param {string} [props.className] - 额外的 CSS 类名
 */
const ChatBubble = ({
  message,
  role,
  content,
  thinking,
  isStreaming = false,
  isThinking = false,
  diaryDate,
  timestamp,
  className = ''
}) => {
  const [userToggled, setUserToggled] = useState(false);
  const [userShowThinking, setUserShowThinking] = useState(false);

  // 合并属性，message 对象优先
  const msgRole = role || message?.role || 'assistant';
  const msgContent = content !== undefined ? content : (message?.content || '');
  const msgThinking = thinking !== undefined ? thinking : (message?.thinking || '');
  const msgTimestamp = timestamp || message?.timestamp;
  const msgDiaryDate = diaryDate || message?.diaryDate;
  const msgSources = message?.sources || [];
  const msgImages = message?.images || []; // 用户消息附带图片（data URL 数组）

  const hasThinking = msgThinking && msgThinking.trim().length > 0;
  const hasContent = msgContent && msgContent.trim().length > 0;
  const isAssistant = msgRole === 'assistant';
  const isUser = msgRole === 'user';
  const isSystem = msgRole === 'system';

  // 流式输出中：自动控制思考过程的展开/折叠
  // - 有思考内容且还没有回复内容 → 展开（实时展示思考过程）
  // - 回复内容开始出现 → 自动折叠
  // 非流式状态（历史消息）：默认折叠，用户可手动展开
  // 用户手动点击后：切换为用户控制模式
  const showThinking = userToggled
    ? userShowThinking
    : isStreaming
      ? (hasThinking && !hasContent)
      : false;

  const toggleThinking = () => {
    setUserToggled(true);
    setUserShowThinking(!showThinking);
  };

  // 系统消息样式
  if (isSystem) {
    return (
      <div className={`flex justify-center ${className}`}>
        <div className="max-w-[80%] rounded-full bg-gray-100 text-gray-500 text-xs px-3 py-1.5 text-center">
          {msgContent}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} ${className}`}>
      <div
        className={`max-w-[85%] rounded-lg text-sm ${
          isUser
            ? 'bg-slate-800 text-white px-3 py-2'
            : 'bg-gray-100 text-gray-800'
        }`}
      >
        {/* 思考过程：默认折叠，展开按钮在气泡顶部 */}
        {isAssistant && (hasThinking || msgDiaryDate) && (
          <div className="border-b border-gray-200/60">
            <div className="flex items-center justify-between px-3 py-1.5">
              {hasThinking ? (
                <button
                  onClick={toggleThinking}
                  className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 hover:bg-gray-200/40 transition-colors rounded select-none"
                >
                  <svg
                    className={`w-3 h-3 transition-transform duration-200 ${showThinking ? 'rotate-180' : ''}`}
                    viewBox="0 0 12 12"
                    fill="currentColor"
                  >
                    <path d="M6 3 L10 8 L2 8 Z" />
                  </svg>
                  <span>{showThinking ? '收起思考' : '思考过程'}</span>
                </button>
              ) : <span />}
              {msgDiaryDate && (
                <span className="text-[10px] text-gray-400 select-none">
                  参考{formatDiaryDate(msgDiaryDate)}日记
                </span>
              )}
            </div>
            {showThinking && hasThinking && (
              <div className="px-3 py-2 text-xs text-gray-500 leading-relaxed bg-gray-200/40 border-l-2 border-gray-300 ml-3 mr-3 mb-2 rounded-sm">
                <MarkdownRenderer text={msgThinking} />
              </div>
            )}
          </div>
        )}

        {/* 消息正文 */}
        <div className="px-3 py-2">
          {/* 用户附带图片：仅用户消息渲染，展示缩略图 */}
          {isUser && msgImages.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-1.5">
              {msgImages.map((src, i) => (
                <img
                  key={i}
                  src={src}
                  alt={`用户图片${i + 1}`}
                  className="max-w-[180px] max-h-[180px] rounded-lg object-cover border border-black/10"
                />
              ))}
            </div>
          )}

          {/* 思考中动画：AI 消息、流式输出、还没有内容时显示 */}
          {isAssistant && isStreaming && isThinking && !hasContent && (
            <div className="flex items-center py-1">
              <ThinkingDots />
              <span className="ml-2 text-gray-400 text-xs">思考中...</span>
            </div>
          )}

          {/* 正常内容渲染 */}
          {(hasContent || !isStreaming) && (
            <>
              <MarkdownRenderer text={msgContent} sources={msgSources} />

              {/* 流式输出光标 */}
              {isStreaming && hasContent && (
                <span className="inline-block w-1.5 h-4 bg-indigo-500 ml-0.5 animate-pulse align-middle" />
              )}
            </>
          )}
        </div>

        {/* 时间戳 */}
        {msgTimestamp && !isStreaming && (
          <div className={`text-[10px] px-3 pb-2 ${isUser ? 'text-slate-300' : 'text-gray-400'}`}>
            {formatTime(msgTimestamp)}
          </div>
        )}
      </div>
    </div>
  );
};

export default ChatBubble;
