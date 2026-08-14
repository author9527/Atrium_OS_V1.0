import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  ArrowLeft, ArrowRight, CalendarDays, Loader2, CheckCircle2,
  ChevronLeft, ChevronRight, Upload, Trash2, FileText,
} from 'lucide-react';
import { API_BASE, getToken } from '../../api';
import DiaryEditor from '../workspace/DiaryEditor';
import {
  emptyDraft, loadDraft, persistDraft, clearDraft, draftCount,
} from '../../utils/importDraft';

// ==========================================
// 导入页 — 历史日记导入（草稿 JSON 生成器）
//
// 页面上半部分：日历（复用主页日历的日期切换交互，去掉情绪/摘要/档案/AI 人设），
//   点击日期格子 → 右侧编辑器粘贴当天日记，改动实时写入草稿 JSON（不保存、不总结）。
// 页面下半部分：快捷导入入口，从各日记软件导出的文件解析后合并进同一份草稿。
// 底部「导入完成」：把整份草稿以 canonical JSON 提交给后端，纯写库、不触发分析。
// ==========================================

const pad = (n) => String(n).padStart(2, '0');
const toDateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const MONTH_CN = ['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];
const WEEKDAYS = ['周一','周二','周三','周四','周五','周六','周日'];

// 各格式的展示名与文件后缀（用于「从 xxx 导入」按钮）
const FORMAT_META = {
  atrium: { name: 'Atrium', accept: '.json', desc: 'Atrium 富文本 JSON' },
  dayone: { name: 'Day One', accept: '.json', desc: 'Day One 导出' },
  csv: { name: 'CSV', accept: '.csv', desc: 'CSV / 电子表格' },
  markdown: { name: 'Markdown', accept: '.md,.markdown', desc: 'Markdown 文件' },
  text: { name: '纯文本', accept: '.txt,.md,.text', desc: '纯文本日记' },
};

const ImportPage = ({ onClose }) => {
  const today = new Date();
  const todayStr = toDateStr(today);

  // ---- 日历状态 ----
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [showYearPicker, setShowYearPicker] = useState(false);
  const [showMonthPicker, setShowMonthPicker] = useState(false);
  const [inputYear, setInputYear] = useState(today.getFullYear().toString());
  const [inputMonth, setInputMonth] = useState(String(today.getMonth() + 1));

  // ---- 草稿与编辑状态 ----
  const [draft, setDraft] = useState(null);
  const [selectedDateStr, setSelectedDateStr] = useState(todayStr);
  const [editorContent, setEditorContent] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);

  // ---- 快捷导入 / 提交状态 ----
  const [ioFormats, setIoFormats] = useState([]);
  const [parseMsg, setParseMsg] = useState('');
  const [parsing, setParsing] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [committing, setCommitting] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');

  const draftRef = useRef(emptyDraft());
  const fileInputRefs = useRef({});
  const flashTimerRef = useRef(null);

  // ---- 日历派生值 ----
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const emptyCells = (new Date(viewYear, viewMonth, 1).getDay() + 6) % 7;
  const totalCells = emptyCells + daysInMonth;
  const displayYear = viewYear;
  const displayMonth = MONTH_CN[viewMonth];

  // ---- 初始化：加载草稿 + 格式列表 ----
  useEffect(() => {
    (async () => {
      const d = await loadDraft();
      draftRef.current = d;
      setDraft(d);
      const entry = d.entries[todayStr];
      setEditorContent(entry?.content || '');
    })();
    fetch(`${API_BASE}/api/diary/formats`, { headers: { 'Authorization': `Bearer ${getToken()}` } })
      .then((r) => r.json())
      .then((d) => d.success && setIoFormats(d.formats || []))
      .catch(() => {});
  }, []);

  // draft 变化时同步 ref，方便在回调里读取最新值
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // 页面卸载前做一次兜底保存，防止半途退出丢数据
  useEffect(() => {
    const handler = () => {
      if (draftRef.current) persistDraft(draftRef.current);
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const flashSaved = useCallback(() => {
    setSavedFlash(true);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setSavedFlash(false), 1500);
  }, []);

  // ---- 选择日期：切换右侧编辑器内容 ----
  const selectDate = useCallback((dateStr) => {
    setSelectedDateStr(dateStr);
    const entry = draftRef.current?.entries?.[dateStr];
    setEditorContent(entry?.content || '');
  }, []);

  // ---- 编辑器改动：实时写入草稿并持久化 ----
  const handleEditorChange = useCallback((content) => {
    setEditorContent(content);
    const d = draftRef.current || emptyDraft();
    const entries = { ...d.entries };
    const isEmpty = !content || content === '<p></p>' || content.trim() === '';
    const sel = selectedDateStr;
    if (isEmpty) {
      delete entries[sel];
    } else {
      const now = new Date().toISOString();
      const existing = entries[sel];
      entries[sel] = {
        date: sel,
        content,
        weather: existing?.weather || '晴',
        tags: existing?.tags || [],
        created_at: existing?.created_at || now,
        updated_at: now,
      };
    }
    const next = { ...d, entries };
    setDraft(next);
    draftRef.current = next;
    persistDraft(next); // localStorage 同步写，近乎实时
    flashSaved();
  }, [selectedDateStr, flashSaved]);

  // ---- 日期切换按钮（前/后一天）----
  const shiftDay = useCallback((offset) => {
    const [y, m, day] = selectedDateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, day + offset);
    setViewYear(dt.getFullYear());
    setViewMonth(dt.getMonth());
    selectDate(toDateStr(dt));
  }, [selectedDateStr, selectDate]);

  // ---- 日历年份/月份切换 ----
  const handleYearChange = () => {
    const y = parseInt(inputYear);
    if (y >= 1900 && y <= 2100) { setViewYear(y); setShowYearPicker(false); }
  };
  const handleMonthChange = () => {
    const m = parseInt(inputMonth);
    if (m >= 1 && m <= 12) { setViewMonth(m - 1); setShowMonthPicker(false); }
  };
  const handlePrevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear((y) => y - 1); } else setViewMonth((m) => m - 1);
  };
  const handleNextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear((y) => y + 1); } else setViewMonth((m) => m + 1);
  };

  // ---- 合并解析结果进草稿 ----
  const mergeEntries = useCallback((entries) => {
    const d = draftRef.current || emptyDraft();
    const cur = { ...d.entries };
    let added = 0, updated = 0;
    for (const e of entries || []) {
      if (!e || !e.date) continue;
      cur[e.date] = { ...e };
      added++;
      if (e.date in d.entries) { updated++; added--; }
    }
    const next = { ...d, entries: cur };
    setDraft(next);
    draftRef.current = next;
    persistDraft(next);
    return { added, updated };
  }, []);

  // ---- 快捷导入：从软件文件导入 ----
  const handleSoftwareFile = async (fmt, e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setParsing(true);
    setParseMsg('');
    try {
      const text = await file.text();
      const res = await fetch(`${API_BASE}/api/diary/import/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
        body: JSON.stringify({ text, filename: file.name, source_format: fmt.id }),
      });
      const data = await res.json();
      if (data.success) {
        const { added, updated } = mergeEntries(data.entries);
        setParseMsg(`✅ 已解析 ${data.entries.length} 篇（${fmt.label}）：新增 ${added} 篇、覆盖 ${updated} 篇，已写入草稿`);
      } else {
        setParseMsg(`❌ ${data.error?.message || '解析失败'}`);
      }
    } catch (err) {
      setParseMsg(`❌ ${err.message}`);
    }
    setParsing(false);
  };

  // ---- 粘贴文本导入 ----
  const handlePasteParse = async () => {
    if (!pasteText || !pasteText.trim()) { setParseMsg('请先粘贴要导入的内容'); return; }
    setParsing(true);
    setParseMsg('');
    try {
      const res = await fetch(`${API_BASE}/api/diary/import/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
        body: JSON.stringify({ text: pasteText, source_format: null }),
      });
      const data = await res.json();
      if (data.success) {
        const { added, updated } = mergeEntries(data.entries);
        setParseMsg(`✅ 已解析 ${data.entries.length} 篇（${data.format}）：新增 ${added} 篇、覆盖 ${updated} 篇，已写入草稿`);
        setPasteText('');
      } else {
        setParseMsg(`❌ ${data.error?.message || '解析失败'}`);
      }
    } catch (err) {
      setParseMsg(`❌ ${err.message}`);
    }
    setParsing(false);
  };

  // ---- 导入完成：提交草稿到后端并退出 ----
  const handleCommit = async () => {
    const d = draftRef.current || emptyDraft();
    const entries = d.entries ? Object.values(d.entries) : [];
    if (!entries.length) { setCommitMsg('草稿为空，请先在日历中选择日期粘贴日记，或从日记软件导入'); return; }
    setCommitting(true);
    setCommitMsg('');
    try {
      const text = JSON.stringify({ format: 'atrium-diary', version: '1.0', entries });
      const res = await fetch(`${API_BASE}/api/diary/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
        body: JSON.stringify({ text, source_format: 'atrium', overwrite: true }),
      });
      const data = await res.json();
      if (data.success) {
        await clearDraft();
        setDraft(emptyDraft());
        draftRef.current = emptyDraft();
        setCommitMsg(`✅ 导入完成：新增 ${data.imported} 条、覆盖 ${data.updated} 条、跳过 ${data.skipped} 条，未触发任何数据分析`);
        setTimeout(() => onClose && onClose(), 1200);
      } else {
        setCommitMsg(`❌ ${data.error?.message || '导入失败'}`);
      }
    } catch (err) {
      setCommitMsg(`❌ ${err.message}`);
    }
    setCommitting(false);
  };

  const handleClearDraft = async () => {
    if (!draftCount(draftRef.current)) return;
    if (!window.confirm('确定清空当前所有草稿吗？此操作不可撤销。')) return;
    await clearDraft();
    setDraft(emptyDraft());
    draftRef.current = emptyDraft();
    setEditorContent('');
    setParseMsg('');
    setCommitMsg('');
  };

  // ---- 日历格子渲染 ----
  const renderDayCell = useCallback((dayNum) => {
    if (dayNum < 1 || dayNum > daysInMonth) {
      return <div key={`empty-${dayNum}`} className="h-16 md:h-20 border border-transparent"></div>;
    }
    const dateStr = `${viewYear}-${pad(viewMonth + 1)}-${pad(dayNum)}`;
    const filled = !!draftRef.current?.entries?.[dateStr];
    const isToday = dateStr === todayStr;
    const isSelected = dateStr === selectedDateStr;

    let cellCls = 'bg-white border border-gray-200 hover:border-emerald-300 hover:shadow-sm';
    if (filled) cellCls = 'bg-emerald-50 border border-emerald-300 hover:bg-emerald-100';
    if (isToday) cellCls = 'bg-white border border-slate-800 shadow-sm';
    if (isSelected) cellCls = 'bg-emerald-100 border-2 border-emerald-500 shadow-sm';

    return (
      <button
        key={dayNum}
        onClick={() => selectDate(dateStr)}
        className={`relative h-16 md:h-20 rounded-lg flex flex-col items-center justify-center gap-1 transition-all hover:scale-[1.02] active:scale-95 ${cellCls}`}
      >
        <span className={`text-sm font-semibold ${isToday ? 'text-slate-900' : filled ? 'text-emerald-700' : 'text-gray-500'}`}>
          {dayNum}
        </span>
        {filled && (
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
        )}
        {isSelected && (
          <span className="absolute top-1 right-1">
            <CheckCircle2 size={12} className="text-emerald-600" />
          </span>
        )}
      </button>
    );
  }, [daysInMonth, viewYear, viewMonth, selectedDateStr, todayStr, selectDate]);

  const count = draftCount(draft);

  if (!draft) {
    return (
      <div className="h-full flex items-center justify-center bg-gray-50">
        <Loader2 size={24} className="animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* 顶部栏 */}
      <div className="h-14 bg-white border-b border-gray-200 flex items-center justify-between px-6 shrink-0 shadow-sm">
        <div className="flex items-center gap-3">
          <button onClick={onClose} className="w-9 h-9 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-600 flex items-center justify-center transition-colors" title="返回">
            <ArrowLeft size={18} />
          </button>
          <div className="flex items-center gap-2">
            <Upload size={18} className="text-emerald-600" />
            <h2 className="text-lg font-medium text-gray-800">导入历史日记</h2>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-xs px-2 py-1 rounded-full ${savedFlash ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-400'}`}>
            {savedFlash ? '草稿已自动保存' : '草稿实时自动保存'}
          </span>
          <span className="text-xs text-gray-400">已收录 {count} 篇</span>
          <button onClick={handleClearDraft}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-500 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors">
            <Trash2 size={14} /> 清空草稿
          </button>
        </div>
      </div>

      {/* 主体：左日历 + 右编辑器 */}
      <div className="flex-1 min-h-0 flex">
        {/* 日历区 */}
        <div className="w-[420px] shrink-0 border-r border-gray-200 bg-white flex flex-col">
          {/* 日期切换（复用主页日历交互） */}
          <div className="px-4 pt-4 pb-2 flex flex-wrap items-center gap-1.5">
            <button onClick={() => setViewYear((y) => y - 1)} className="w-7 h-7 rounded-md bg-gray-100 hover:bg-gray-200 text-gray-600 font-bold flex items-center justify-center" title="上一年">&#171;</button>
            <button onClick={handlePrevMonth} className="w-7 h-7 rounded-md bg-gray-100 hover:bg-gray-200 text-gray-600 font-bold flex items-center justify-center" title="上一月">&#8249;</button>
            <div className="relative">
              <button onClick={() => { setShowYearPicker(!showYearPicker); setShowMonthPicker(false); setInputYear(String(viewYear)); }}
                className="px-2 py-1 rounded-md hover:bg-gray-100 text-base font-medium text-gray-800">{displayYear}年</button>
              {showYearPicker && (
                <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg p-2 z-50 w-28">
                  <input type="number" value={inputYear} onChange={(e) => setInputYear(e.target.value)} onBlur={handleYearChange} onKeyDown={(e) => e.key === 'Enter' && handleYearChange()}
                    className="w-full px-2 py-1 border border-gray-200 rounded text-sm text-center" min="1900" max="2100" />
                </div>
              )}
            </div>
            <div className="relative">
              <button onClick={() => { setShowMonthPicker(!showMonthPicker); setShowYearPicker(false); setInputMonth(String(viewMonth + 1)); }}
                className="px-2 py-1 rounded-md hover:bg-gray-100 text-base font-medium text-gray-800">{displayMonth}</button>
              {showMonthPicker && (
                <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg p-2 z-50 w-40 grid grid-cols-3 gap-1">
                  {MONTH_CN.map((m, i) => (
                    <button key={i} onClick={() => { setViewMonth(i); setShowMonthPicker(false); }}
                      className={`px-2 py-1 text-xs rounded hover:bg-gray-100 ${viewMonth === i ? 'bg-slate-800 text-white' : 'text-gray-700'}`}>{m}</button>
                  ))}
                </div>
              )}
            </div>
            <button onClick={handleNextMonth} className="w-7 h-7 rounded-md bg-gray-100 hover:bg-gray-200 text-gray-600 font-bold flex items-center justify-center" title="下一月">&#8250;</button>
            <button onClick={() => setViewYear((y) => y + 1)} className="w-7 h-7 rounded-md bg-gray-100 hover:bg-gray-200 text-gray-600 font-bold flex items-center justify-center" title="下一年">&#187;</button>
            <button onClick={() => { setViewYear(today.getFullYear()); setViewMonth(today.getMonth()); }} className="text-xs text-slate-600 hover:text-slate-800 hover:underline ml-1">回到今天</button>
          </div>

          {/* 周几表头 */}
          <div className="px-4 grid grid-cols-7 gap-1.5">
            {WEEKDAYS.map((d) => <div key={d} className="text-center text-xs text-gray-400 font-medium py-1">{d}</div>)}
          </div>

          {/* 日期格子 */}
          <div className="px-4 grid grid-cols-7 gap-1.5 flex-1 content-start overflow-y-auto">
            {Array.from({ length: totalCells }, (_, i) => renderDayCell(i - emptyCells + 1))}
          </div>

          {/* 前/后一天 */}
          <div className="px-4 py-3 border-t border-gray-100 flex items-center gap-2">
            <button onClick={() => shiftDay(-1)} className="flex items-center gap-1 px-3 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-sm font-medium transition-colors">
              <ChevronLeft size={16} /> 前一天
            </button>
            <div className="flex-1 text-center text-sm font-medium text-gray-700">
              {selectedDateStr.replace(/-/g, ' / ')}
            </div>
            <button onClick={() => shiftDay(1)} className="flex items-center gap-1 px-3 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-sm font-medium transition-colors">
              后一天 <ChevronRight size={16} />
            </button>
          </div>
        </div>

        {/* 编辑器区 */}
        <div className="flex-1 min-w-0 flex flex-col bg-white">
          <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between bg-white shrink-0">
            <div className="flex items-center gap-2">
              <CalendarDays size={16} className="text-emerald-600" />
              <span className="text-sm font-medium text-gray-800">{selectedDateStr} 的日记</span>
            </div>
            <span className="text-xs text-gray-400">在此粘贴该日期的日记，改动即时写入草稿</span>
          </div>
          <div className="flex-1 min-h-0 flex flex-col">
            <DiaryEditor
              content={editorContent}
              editable
              onChange={handleEditorChange}
              onSave={flashSaved}
              hideSave
            />
          </div>
        </div>
      </div>

      {/* 下半部分：快捷导入 + 导入完成 */}
      <div className="shrink-0 bg-white border-t border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
            <FileText size={16} className="text-blue-500" />
            快捷导入
          </h3>
          {parseMsg && <span className="text-xs text-gray-600 break-all max-w-[55%]">{parseMsg}</span>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {ioFormats.map((fmt) => {
            const meta = FORMAT_META[fmt.id] || { name: fmt.label, accept: `.${fmt.ext}`, desc: fmt.label };
            return (
              <span key={fmt.id} className="inline-flex">
                <button onClick={() => fileInputRefs.current[fmt.id]?.click()} disabled={parsing}
                  className="flex items-center gap-2 px-4 py-2 bg-gray-50 hover:bg-emerald-50 hover:text-emerald-700 text-gray-700 border border-gray-200 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                  title={meta.desc}>
                  <Upload size={14} />
                  从 {meta.name} 导入
                </button>
                <input
                  ref={(el) => { fileInputRefs.current[fmt.id] = el; }}
                  type="file"
                  className="hidden"
                  accept={(FORMAT_META[fmt.id] || {}).accept || `*`}
                  onChange={(e) => handleSoftwareFile(fmt, e)}
                  key={`file-${fmt.id}`}
                />
              </span>
            );
          })}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} rows="2"
            placeholder="或直接粘贴 Day One JSON / CSV / Markdown / 纯文本内容，自动识别格式..."
            className="flex-1 min-w-[260px] px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-500 font-mono resize-none" />
          <button onClick={handlePasteParse} disabled={parsing}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg transition-colors text-sm font-medium">
            {parsing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            解析并加入草稿
          </button>
        </div>

        <div className="mt-4 pt-3 border-t border-gray-100 flex items-center justify-between">
          <span className="text-xs text-gray-400">导入完成后不会触发任何数据分析，可放心提交。</span>
          <div className="flex items-center gap-3">
            {commitMsg && <span className="text-xs text-gray-600 break-all max-w-[50%]">{commitMsg}</span>}
            <button onClick={handleCommit} disabled={committing}
              className="flex items-center gap-2 px-6 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg transition-colors text-sm font-semibold shadow-md">
              {committing ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
              {committing ? '导入中...' : '导入完成'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ImportPage;