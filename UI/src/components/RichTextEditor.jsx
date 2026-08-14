import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TextStyle } from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import Image from '@tiptap/extension-image';

const TOOLBAR_BTN = 'w-8 h-8 flex items-center justify-center rounded hover:bg-gray-200 text-gray-700 transition-colors';

// 图片最大尺寸（超过则等比压缩，避免 base64 撑爆日记数据库）
const MAX_IMG_DIM = 1280;

// 麦克风图标
const MicIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="23" />
    <line x1="8" y1="23" x2="16" y2="23" />
  </svg>
);

// Undo/Redo SVG 图标
const UndoIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
  </svg>
);
const RedoIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10" />
  </svg>
);

const RichTextEditor = ({ content, editable, onChange, onSave, hideSave = false }) => {
  const [activeFormats, setActiveFormats] = useState({
    bold: false,
    italic: false,
    underline: false,
    color: '#000000',
  });
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef(null);
  const imgInputRef = useRef(null);

  // 图片输入：仅接受 LLM/视觉可辨识的真实图片（JPEG/PNG/GIF/WebP），
  // 通过文件头魔数判断，避免把无法辨识的格式嵌入日记。插入前用 canvas 等比
  // 压缩到 MAX_IMG_DIM，以 data URL 形式内嵌进富文本 HTML，随日记内容一起持久化。
  const detectImageType = (bytes) => {
    const buf = Array.from(bytes.slice(0, 12));
    const startsWith = (arr) => arr.every((v, i) => buf[i] === v);
    if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
    if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
    if (startsWith([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
    if (startsWith([0x52, 0x49, 0x46, 0x46]) &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
    return null;
  };

  const resizeImage = (blob, mime) => new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, MAX_IMG_DIM / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (mime === 'image/png' || mime === 'image/gif') {
          ctx.clearRect(0, 0, w, h);
        } else {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, w, h);
        }
        ctx.drawImage(img, 0, 0, w, h);
        // 透明图保留 PNG，其余转 JPEG 压缩
        const outType = (mime === 'image/png' || mime === 'image/gif') ? 'image/png' : 'image/jpeg';
        resolve(canvas.toDataURL(outType, 0.85));
      } catch (err) {
        resolve(null);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });

  const processImageFile = (file) => new Promise((resolve) => {
    if (!file) return resolve(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const arrayBuf = reader.result;
        const bytes = new Uint8Array(arrayBuf);
        const mime = detectImageType(bytes);
        if (!mime) { resolve(null); return; }
        if (bytes.length > 8 * 1024 * 1024) { resolve(null); return; }
        const blob = new Blob([arrayBuf], { type: mime });
        resizeImage(blob, mime).then(resolve);
      } catch (err) { resolve(null); }
    };
    reader.onerror = () => resolve(null);
    reader.readAsArrayBuffer(file);
  });

  const insertImages = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length || !editor) return;
    let added = 0;
    for (const f of files) {
      const dataUrl = await processImageFile(f);
      if (dataUrl) {
        editor.chain().focus().setImage({ src: dataUrl, alt: '日记图片' }).run();
        added++;
      }
    }
    if (!added) {
      alert('仅支持插入 JPEG/PNG/GIF/WebP 图片，该文件无法识别为图片');
    }
  };

  const handleImageSelect = (e) => {
    insertImages(e.target.files);
    e.target.value = '';
  };

  const handlePaste = (view, event) => {
    const items = event.clipboardData?.items || [];
    const files = [];
    for (const it of items) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        files.push(it.getAsFile());
      }
    }
    if (files.length) {
      insertImages(files);
      return true; // 拦截默认粘贴
    }
    return false;
  };

  const handleDrop = (view, event, slice) => {
    const files = event.dataTransfer?.files;
    if (files && files.length) {
      insertImages(files);
      return true;
    }
    return false;
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        history: { depth: 50 },
      }),
      TextStyle,
      Color,
      Image.configure({
        inline: false,
        allowBase64: true, // 允许 data URL 图片，便于随日记 HTML 持久化
      }),
    ],
    content: content || '',
    editable: editable,
    editorProps: {
      handlePaste,
      handleDrop,
    },
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
    onSelectionUpdate: ({ editor }) => {
      syncToolbar(editor);
    },
    onTransaction: ({ editor }) => {
      syncToolbar(editor);
    },
  });

  // 语音输入：使用浏览器原生 Web Speech API，零依赖
  const startSpeech = useCallback(() => {
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
      if (editor && text) {
        editor.chain().focus().insertContent(text).run();
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
  }, [listening, editor]);

  // 外部 content 变化时同步
  // 空字符串和 <p></p> 在 Tiptap 中语义等价，做规范化比较避免死循环
  useEffect(() => {
    if (editor && content !== undefined) {
      const currentHtml = editor.getHTML();
      const normalizedContent = content || '<p></p>';
      if (currentHtml !== normalizedContent) {
        editor.commands.setContent(content || '');
      }
    }
  }, [content, editor]);

  // editable 变化时同步
  useEffect(() => {
    if (editor) {
      editor.setEditable(editable);
    }
  }, [editable, editor]);

  const syncToolbar = useCallback((ed) => {
    if (!ed) return;
    setActiveFormats({
      bold: ed.isActive('bold'),
      italic: ed.isActive('italic'),
      underline: ed.isActive('underline'),
      color: ed.getAttributes('textStyle').color || '#000000',
    });
  }, []);

  // Ctrl+S 保存
  useEffect(() => {
    if (!editable) return;
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        onSave && onSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editable, onSave]);

  if (!editor) return null;

  return (
    <div className="flex flex-col h-full bg-white">
      {editable && (
        <div className="flex items-center gap-1 px-3 py-2 border-b border-gray-200 bg-gray-50 shrink-0">
          <button
            onClick={() => editor.chain().focus().undo().run()}
            disabled={!editor.can().undo()}
            className={`${TOOLBAR_BTN} ${!editor.can().undo() ? 'opacity-30 cursor-default' : 'cursor-pointer'}`}
            title="撤销 (Ctrl+Z)"
          >
            <UndoIcon />
          </button>
          <button
            onClick={() => editor.chain().focus().redo().run()}
            disabled={!editor.can().redo()}
            className={`${TOOLBAR_BTN} ${!editor.can().redo() ? 'opacity-30 cursor-default' : 'cursor-pointer'}`}
            title="重做 (Ctrl+Shift+Z)"
          >
            <RedoIcon />
          </button>
          <span className="w-px h-5 bg-gray-300 mx-1" />
          <button
            onClick={() => editor.chain().focus().toggleBold().run()}
            className={`${TOOLBAR_BTN} font-bold ${activeFormats.bold ? 'bg-gray-200 text-blue-600' : ''}`}
            title="加粗 (Ctrl+B)"
          >
            B
          </button>
          <button
            onClick={() => editor.chain().focus().toggleItalic().run()}
            className={`${TOOLBAR_BTN} italic ${activeFormats.italic ? 'bg-gray-200 text-blue-600' : ''}`}
            title="斜体 (Ctrl+I)"
          >
            I
          </button>
          <button
            onClick={() => editor.chain().focus().toggleUnderline().run()}
            className={`${TOOLBAR_BTN} underline ${activeFormats.underline ? 'bg-gray-200 text-blue-600' : ''}`}
            title="下划线 (Ctrl+U)"
          >
            U
          </button>
          <span className="w-px h-5 bg-gray-300 mx-1" />
          <button
            onClick={startSpeech}
            className={`${TOOLBAR_BTN} ${listening ? 'bg-red-100 text-red-600' : ''}`}
            title={listening ? '停止语音输入' : '语音输入'}
          >
            <MicIcon />
          </button>
          <button
            onClick={() => imgInputRef.current?.click()}
            className={TOOLBAR_BTN}
            title="插入图片（粘贴或拖拽亦可）"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
          </button>
          <input
            ref={imgInputRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            multiple
            className="hidden"
            onChange={handleImageSelect}
          />
          <span className="w-px h-5 bg-gray-300 mx-1" />
          <div className="relative" title="文字颜色">
            <input
              type="color"
              value={activeFormats.color}
              onChange={(e) => editor.chain().focus().setColor(e.target.value).run()}
              className="w-6 h-6 rounded cursor-pointer border-0 p-0"
            />
          </div>
          <span className="w-px h-5 bg-gray-300 mx-1" />
          {!hideSave && (
            <button
              onClick={onSave}
              className="px-3 py-1 bg-slate-800 hover:bg-slate-900 text-white rounded text-sm font-medium transition-colors"
              title="保存 (Ctrl+S)"
            >
              保存
            </button>
          )}
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        <EditorContent editor={editor} className="h-full" />
      </div>
      {!editable && (
        <div className="px-4 py-3 bg-amber-50 border-t border-amber-200 text-amber-700 text-sm text-center shrink-0">
          日记编辑权限仅在当日和次日开放
        </div>
      )}
      <style>{`
        .tiptap {
          padding: 1rem;
          min-height: 200px;
          font-size: 15px;
          line-height: 1.8;
          color: #1f2937;
          outline: none;
        }
        .tiptap p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          float: left;
          color: #9CA3AF;
          pointer-events: none;
          height: 0;
        }
        .tiptap:focus {
          outline: none;
        }
        .tiptap img {
          max-width: 100%;
          height: auto;
          border-radius: 6px;
          margin: 0.5rem 0;
        }
      `}</style>
    </div>
  );
};

export default RichTextEditor;