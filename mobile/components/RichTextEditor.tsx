import React, { useRef, useCallback, useEffect, useState, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';

interface Props {
  initialContent: string;
  onChange: (html: string) => void;
}

const TOOLBAR_HTML = `<div id="header">
  <div id="toolbar">
    <button class="btn" onmousedown="event.preventDefault(); saveSelection(); exec('undo'); logBtn('undo')" ontouchstart="saveSelection()" title="撤销">↶</button>
    <button class="btn" onmousedown="event.preventDefault(); saveSelection(); exec('redo'); logBtn('redo')" ontouchstart="saveSelection()" title="重做">↷</button>
    <div class="divider"></div>
    <button class="btn btn-bold" onmousedown="event.preventDefault(); saveSelection(); exec('bold'); logBtn('bold')" ontouchstart="saveSelection()" title="加粗">B</button>
    <button class="btn btn-italic" onmousedown="event.preventDefault(); saveSelection(); exec('italic'); logBtn('italic')" ontouchstart="saveSelection()" title="斜体">I</button>
    <div class="divider"></div>
    <div class="color-ctl" onmousedown="event.preventDefault(); saveSelection(); togglePicker('bg'); logBtn('bg')" ontouchstart="saveSelection()">
      <span class="ctl-label">背景</span>
      <div class="swatch-btn" id="bgSwatch"></div>
    </div>
    <div class="color-ctl" onmousedown="event.preventDefault(); saveSelection(); togglePicker('fg'); logBtn('fg')" ontouchstart="saveSelection()">
      <span class="ctl-label">字色</span>
      <div class="swatch-btn" id="fgSwatch"></div>
    </div>
  </div>
  <div id="picker" class="picker hidden">
    <span class="hilite-label" id="pickerLabel">背景色</span>
    <button class="swatch" id="sw0" onmousedown="event.preventDefault(); saveSelection()" ontouchstart="saveSelection()"></button>
    <button class="swatch" id="sw1" onmousedown="event.preventDefault(); saveSelection()" ontouchstart="saveSelection()"></button>
    <button class="swatch" id="sw2" onmousedown="event.preventDefault(); saveSelection()" ontouchstart="saveSelection()"></button>
    <button class="swatch" id="sw3" onmousedown="event.preventDefault(); saveSelection()" ontouchstart="saveSelection()"></button>
    <button class="swatch" id="sw4" onmousedown="event.preventDefault(); saveSelection()" ontouchstart="saveSelection()"></button>
    <button class="swatch" id="sw5" onmousedown="event.preventDefault(); saveSelection()" ontouchstart="saveSelection()"></button>
    <button class="swatch" id="sw6" onmousedown="event.preventDefault(); saveSelection()" ontouchstart="saveSelection()"></button>
    <button class="swatch" id="sw7" onmousedown="event.preventDefault(); saveSelection()" ontouchstart="saveSelection()"></button>
    <button class="swatch" id="sw8" onmousedown="event.preventDefault(); saveSelection()" ontouchstart="saveSelection()"></button>
  </div>
</div>`;

const EDITOR_SCRIPT = `<script>
  // 上报页面 JS 错误到 React Native，便于排查
  window.onerror = function(msg, src, line) {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'error', msg: String(msg), line: line }));
    } catch (e) {}
  };
  // 调试日志
  function logBtn(name) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'btn', name: name })); } catch (e) {}
  }
  // 保存 / 恢复编辑器选区（点击工具栏按钮时防止失焦丢选区）
  var savedRange = null;
  function saveSelection() {
    var sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      var range = sel.getRangeAt(0);
      // 只保存在编辑器内的选区
      var editor = document.getElementById('editor');
      if (editor.contains(range.commonAncestorContainer)) {
        savedRange = range.cloneRange();
      }
    }
  }
  function restoreSelection() {
    if (savedRange) {
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }
  }
  // 供 React Native 在外部内容变化时更新编辑器内容
  window.setContent = function(html) {
    document.getElementById('editor').innerHTML = html || '';
  };
  function exec(cmd, val) {
    restoreSelection();
    document.execCommand(cmd, false, val);
    document.getElementById('editor').focus();
    saveSelection();
    onInput();
  }
  var debounceTimer = null;
  function onInput() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function() {
      var html = document.getElementById('editor').innerHTML;
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'change', html: html }));
    }, 300);
  }
  // 编辑器失焦前保存选区，以便工具栏按钮操作时恢复
  document.addEventListener('selectionchange', function() {
    var sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      var editor = document.getElementById('editor');
      if (editor.contains(sel.anchorNode)) {
        savedRange = sel.getRangeAt(0).cloneRange();
      }
    }
  });
  var BG_COLORS = ['#fecaca','#fed7aa','#fef08a','#bbf7d0','#bfdbfe','#e9d5ff','#9ca3af','#e5e7eb','transparent'];
  var FG_COLORS = ['#ef4444','#f59e0b','#eab308','#10b981','#3b82f6','#8b5cf6','#334155','#9ca3af','#000000'];
  var pickerType = null;
  function setSwatches() {
    var bg = document.getElementById('bgSwatch');
    var fg = document.getElementById('fgSwatch');
    if (bg) bg.style.background = BG_COLORS[0];
    if (fg) fg.style.background = FG_COLORS[0];
  }
  function renderPicker(type) {
    var colors = type === 'bg' ? BG_COLORS : FG_COLORS;
    document.getElementById('pickerLabel').textContent = type === 'bg' ? '背景色' : '字色';
    for (var i = 0; i < colors.length; i++) {
      var btn = document.getElementById('sw' + i);
      if (!btn) continue;
      var color = colors[i];
      if (color === 'transparent') {
        // 无色：用斜杠图案表示清除
        btn.style.background = 'repeating-linear-gradient(45deg, #fff, #fff 4px, #ef4444 4px, #ef4444 6px)';
      } else {
        btn.style.background = color;
      }
      btn.setAttribute('data-type', type);
      btn.setAttribute('data-color', color);
      btn.onclick = function() {
        var t = this.getAttribute('data-type');
        var c = this.getAttribute('data-color');
        pickColor(t, c);
      };
    }
  }
  function togglePicker(type) {
    var picker = document.getElementById('picker');
    if (!picker) return;
    if (pickerType === type) {
      picker.classList.add('hidden');
      pickerType = null;
      return;
    }
    pickerType = type;
    renderPicker(type);
    picker.classList.remove('hidden');
  }
  function pickColor(type, color) {
    if (color === 'transparent') {
      // 清除背景色 / 字色：用 removeFormat 去掉高亮，字色恢复默认黑
      if (type === 'bg') {
        exec('hiliteColor', 'transparent');
      } else {
        exec('foreColor', '#334155');
      }
      // 主色块保持显示当前第一个默认色
      document.getElementById(type === 'bg' ? 'bgSwatch' : 'fgSwatch').style.background =
        type === 'bg' ? BG_COLORS[0] : FG_COLORS[0];
    } else {
      exec(type === 'bg' ? 'hiliteColor' : 'foreColor', color);
      document.getElementById(type === 'bg' ? 'bgSwatch' : 'fgSwatch').style.background = color;
    }
    document.getElementById('picker').classList.add('hidden');
    pickerType = null;
  }
  try { setSwatches(); } catch (e) {}
  // 上报编辑器内容已就绪（含初始内容长度），便于排查
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready', len: document.getElementById('editor').innerHTML.length }));
</script>`;

const buildEditorHtml = (contentHtml: string): string => {
  const safeContent = contentHtml || '';
  return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin: 0; font-family: -apple-system, 'Segoe UI', sans-serif; font-size: 16px; line-height: 1.6; color: #334155; background: #fff; }
  #header { position: sticky; top: 0; z-index: 100; background: #f9fafb; }
  #toolbar { display: flex; align-items: center; gap: 2px; padding: 6px 10px; border-bottom: 1px solid #e5e7eb; }
  .btn { min-width: 44px; height: 44px; border: none; border-radius: 8px; background: transparent; color: #374151; font-size: 20px; display: flex; align-items: center; justify-content: center; cursor: pointer; padding: 0 8px; -webkit-user-select: none; user-select: none; }
  .btn:active { background: #e2e8f0; }
  .btn-bold { font-weight: 800; }
  .btn-italic { font-style: italic; font-family: Georgia, serif; }
  .divider { width: 1px; height: 24px; background: #e5e7eb; margin: 0 6px; }
  .color-ctl { display: flex; flex-direction: column; align-items: center; gap: 2px; margin-left: 8px; padding: 4px 6px; border-radius: 8px; cursor: pointer; -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent; }
  .color-ctl:active { background: #e2e8f0; }
  .ctl-label { font-size: 10px; color: #94a3b8; line-height: 1; }
  .swatch-btn { width: 26px; height: 26px; border-radius: 6px; border: 1px solid rgba(0,0,0,0.18); }
  .picker { display: flex; align-items: center; gap: 4px; padding: 6px 12px; background: #fff; border-bottom: 1px solid #e5e7eb; }
  .picker.hidden { display: none; }
  .picker .swatch { width: 26px; height: 26px; border-radius: 6px; border: 1px solid rgba(0,0,0,0.12); cursor: pointer; padding: 0; -webkit-user-select: none; user-select: none; flex-shrink: 0; }
  .picker .swatch:active { transform: scale(0.9); }
  #editor { padding: 16px; min-height: 200px; outline: none; }
  #editor:empty:before { content: '今天发生了什么...'; color: #cbd5e1; pointer-events: none; }
  #editor b, #editor strong { font-weight: 700; }
  #editor i, #editor em { font-style: italic; }
</style>
</head>
<body>
${TOOLBAR_HTML}
<div id="editor" contenteditable="true" oninput="onInput()">${safeContent}</div>
${EDITOR_SCRIPT}
</body>
</html>`;
};

export default function RichTextEditor({ initialContent, onChange }: Props) {
  const webViewRef = useRef<WebView>(null);
  const isInternalChange = useRef(false);
  const lastExternalRef = useRef(initialContent);
  const [contentVersion, setContentVersion] = useState(0);

  // 将纯文本转换为基本 HTML（如果内容不包含 HTML 标签）
  const toHtml = (text: string): string => {
    if (!text) return '';
    if (/<[a-z][\s\S]*>/i.test(text)) return text;
    return text
      .split('\n')
      .filter((line, i, arr) => !(line === '' && i === arr.length - 1))
      .map(line => line.trim() ? `<p>${line}</p>` : '<p><br></p>')
      .join('');
  };

  // 仅在「外部」内容变化（如异步加载完成、切换日记）时重载 WebView
  // 用户输入触发 onChange→父组件 setContent 的回流会被 isInternalChange 拦截，避免重载丢光标
  useEffect(() => {
    if (isInternalChange.current) {
      isInternalChange.current = false;
      return;
    }
    if (initialContent === lastExternalRef.current) return;
    lastExternalRef.current = initialContent;
    setContentVersion(v => v + 1);
  }, [initialContent]);

  const handleMessage = useCallback((e: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.type === 'change' && onChange) {
        isInternalChange.current = true;
        onChange(msg.html);
      } else if (msg.type === 'error') {
        console.error('[RTE] 页面JS错误:', msg.msg, 'line', msg.line);
      } else if (msg.type === 'ready') {
        console.log(`[RTE] 编辑器就绪, 初始内容长度=${msg.len}`);
      } else if (msg.type === 'btn') {
        console.log(`[RTE] 点击按钮: ${msg.name}`);
      }
    } catch {}
  }, [onChange]);

  // source 内嵌初始内容；用 key 强制在外部内容变化时全新加载
  const sourceHtml = useMemo(
    () => buildEditorHtml(toHtml(lastExternalRef.current)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contentVersion],
  );

  return (
    <View style={styles.container}>
      <WebView
        key={contentVersion}
        ref={webViewRef}
        source={{ html: sourceHtml }}
        onMessage={handleMessage}
        style={styles.webview}
        keyboardDisplayRequiresUserAction={false}
        nestedScrollEnabled
        originWhitelist={['*']}
        scrollEnabled
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  webview: { flex: 1, backgroundColor: '#fff' },
});
