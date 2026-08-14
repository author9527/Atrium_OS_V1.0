import React, { useState, useRef, useEffect } from 'react';
import ChatBubble from './ChatBubble';

const ChatPanel = ({ visible, messages, onSend, onClose, onOpen, greeting, canChat, streamingMsgId, searchStatus }) => {
  const [input, setInput] = useState('');
  const [listening, setListening] = useState(false);
  const [images, setImages] = useState([]); // 待发送图片 [{dataUrl, type}]
  const recognitionRef = useRef(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);

  // 图片输入校验：仅接受 LLM 可辨识的真实图片（JPEG/PNG/GIF/WebP）。
  // 通过文件头魔数判断，而非仅看扩展名/Content-Type，避免把无法辨识的格式传给模型。
  const detectImageType = (bytes) => {
    const buf = Array.from(bytes.slice(0, 12));
    const startsWith = (arr) => arr.every((v, i) => buf[i] === v);
    if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
    if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
    if (startsWith([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
    // WebP: RIFF....WEBP
    if (startsWith([0x52, 0x49, 0x46, 0x46]) &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
    return null;
  };

  const readImageFile = (file) => new Promise((resolve) => {
    if (!file) return resolve(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const arrayBuf = reader.result;
        const bytes = new Uint8Array(arrayBuf);
        const type = detectImageType(bytes);
        if (!type) { resolve(null); return; }
        if (bytes.length > 8 * 1024 * 1024) { resolve(null); return; } // 单图 >8MB 滤除
        const blob = new Blob([arrayBuf], { type });
        const r2 = new FileReader();
        r2.onload = () => resolve({ dataUrl: r2.result, type });
        r2.onerror = () => resolve(null);
        r2.readAsDataURL(blob);
      } catch (err) { resolve(null); }
    };
    reader.onerror = () => resolve(null);
    reader.readAsArrayBuffer(file);
  });

  const addImageFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const valid = [];
    for (const f of files) {
      const img = await readImageFile(f);
      if (img) valid.push(img);
    }
    if (valid.length) {
      setImages((prev) => [...prev, ...valid]);
    } else {
      alert('仅支持插入 JPEG/PNG/GIF/WebP 图片，该文件无法识别为图片');
    }
  };

  const handleFileSelect = (e) => {
    addImageFiles(e.target.files);
    e.target.value = ''; // 允许重复选择同一文件
  };

  const handlePaste = (e) => {
    const items = e.clipboardData?.items || [];
    const imgFiles = [];
    for (const it of items) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        imgFiles.push(it.getAsFile());
      }
    }
    if (imgFiles.length) {
      addImageFiles(imgFiles);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    addImageFiles(e.dataTransfer?.files);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
  };

  const removeImage = (idx) => {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  };

  // 语音输入：浏览器原生 Web Speech API，零依赖
  const startSpeech = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      alert('当前浏览器不支持语音输入，请使用 Chrome/Edge 等 Chromium 内核浏览器');
      return;
    }
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const rec = new SR();
    rec.lang = 'zh-CN';
    rec.interimResults = false;
    rec.continuous = false;
    rec.onresult = (e) => {
      const text = e.results[0][0].transcript;
      if (text) {
        setInput((prev) => (prev ? prev + text : text));
      }
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    try {
      rec.start();
      recognitionRef.current = rec;
      setListening(true);
    } catch (err) {
      alert('无法启动语音输入，请检查麦克风权限');
    }
  };

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 面板展开时滚动到底部（延迟等动画完成）
  useEffect(() => {
    if (visible) {
      const timer = setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      }, 250);
      return () => clearTimeout(timer);
    }
  }, [visible]);

  // 面板打开时聚焦输入框
  useEffect(() => {
    if (visible && inputRef.current) {
      inputRef.current.focus();
    }
  }, [visible]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed && images.length === 0) return;
    // 携带图片（裸 base64 data URL）发送
    onSend(trimmed, images.map((img) => img.dataUrl));
    setInput('');
    setImages([]);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // 联网搜索状态条
  const renderSearchStatus = () => {
    if (!searchStatus) return null;
    const { stage, query, count } = searchStatus;
    let color = '#6366f1';
    let text = '';
    if (stage === 'searching') {
      color = '#6366f1';
      text = query ? `正在联网搜索：${query}` : '正在联网搜索...';
    } else if (stage === 'done') {
      color = '#10b981';
      text = `已找到 ${count} 条相关结果`;
    } else {
      color = '#ef4444';
      text = '联网搜索失败，已跳过';
    }
    const icon = stage === 'searching'
      ? <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
      : stage === 'done'
        ? <span className="text-sm leading-none">✓</span>
        : <span className="text-sm leading-none">!</span>;
    return (
      <div
        className="flex items-center justify-center gap-2 px-3 py-1.5 mx-auto mt-1 mb-2 rounded-full text-xs font-medium bg-gray-50"
        style={{ color, border: `1px solid ${color}`, maxWidth: '90%' }}
      >
        {icon}
        <span className="truncate">{text}</span>
      </div>
    );
  };

  return (
    <>
      {/* 面板容器 - 把手 + 面板内容，宽度统一过渡 */}
      <div
        className="h-full flex shrink-0"
        style={{
          width: visible ? '40%' : '24px',
          minWidth: visible ? '320px' : '24px',
          maxWidth: visible ? '480px' : '24px',
          transition: 'width 0.2s ease, min-width 0.2s ease, max-width 0.2s ease'
        }}
      >
        {/* 把手 - 始终显示 */}
        <button
          onClick={visible ? onClose : onOpen}
          className="w-6 h-16 self-center bg-white border border-gray-200 rounded-l-lg flex items-center justify-center hover:bg-gray-50 shadow-sm shrink-0 z-10"
          title={visible ? '收起共情助手' : '打开共情助手'}
        >
          <span className="text-gray-400 text-xs">{visible ? '▶' : '◀'}</span>
        </button>

        {/* 面板内容 */}
        <div
          className="flex-1 h-full bg-white border-l border-gray-200 shadow-lg flex flex-col overflow-hidden"
          style={{ borderLeftWidth: visible ? '1px' : '0', transition: 'border-left-width 0.2s ease' }}
        >
        {/* 面板头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50 shrink-0">
          <h3 className="text-sm font-semibold text-gray-700">共情助手</h3>
        </div>

        {/* 消息列表 */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {messages.map((msg, idx) => (
            <ChatBubble
              key={idx}
              message={msg}
              isStreaming={msg._streaming === true}
              isThinking={msg._streaming === true && !msg.content}
              diaryDate={msg.role === 'assistant' ? msg.diaryDate : null}
            />
          ))}
          {renderSearchStatus()}
          <div ref={messagesEndRef} />
        </div>

        {/* 输入区域 */}
        {canChat && (
          <div className="border-t border-gray-200 p-3 bg-gray-50 shrink-0">
            {/* 待发送图片预览 */}
            {images.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {images.map((img, idx) => (
                  <div key={idx} className="relative group">
                    <img
                      src={img.dataUrl}
                      alt={`待发送图片${idx + 1}`}
                      className="w-16 h-16 object-cover rounded-lg border border-gray-200"
                    />
                    <button
                      type="button"
                      onClick={() => removeImage(idx)}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-gray-700 text-white text-xs flex items-center justify-center hover:bg-red-500 shadow"
                      title="移除图片"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                placeholder="输入消息...（可粘贴/拖入图片）"
                rows={2}
                className="flex-1 resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400"
              />
              {/* 图片上传按钮 */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title="插入图片"
                className="w-9 h-9 rounded-lg flex items-center justify-center self-end transition-colors bg-gray-200 hover:bg-gray-300 text-gray-600"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <polyline points="21 15 16 10 5 21" />
                </svg>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                multiple
                className="hidden"
                onChange={handleFileSelect}
              />
              <button
                type="button"
                onClick={startSpeech}
                title={listening ? '停止语音输入' : '语音输入'}
                className={`w-9 h-9 rounded-lg flex items-center justify-center self-end transition-colors ${
                  listening ? 'bg-red-100 text-red-600' : 'bg-gray-200 hover:bg-gray-300 text-gray-600'
                }`}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </svg>
              </button>
              <button
                onClick={handleSend}
                disabled={!input.trim() && images.length === 0}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white rounded-lg text-sm font-medium transition-colors self-end"
              >
                发送
              </button>
            </div>
          </div>
        )}
      </div>
      </div>
    </>
  );
};

export default ChatPanel;
