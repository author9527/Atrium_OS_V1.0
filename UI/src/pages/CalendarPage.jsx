import React, { useState, useEffect } from 'react';
import { Plus } from 'lucide-react';
import { API_BASE, getToken } from '../api';
import { getEmotionColor as emotionColor } from '../../../shared/emotion_utils';

const CalendarPage = ({ setSelectedDate, setActivePage }) => {
  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [showMonthPicker, setShowMonthPicker] = useState(false);
  const [showYearPicker, setShowYearPicker] = useState(false);
  const [inputYear, setInputYear] = useState(today.getFullYear().toString());
  const [inputMonth, setInputMonth] = useState((today.getMonth() + 1).toString());
  const [monthDiaries, setMonthDiaries] = useState({});
  const [emotionPicker, setEmotionPicker] = useState({ open: false, day: null, dateStr: '' });  // 情绪选择弹窗

  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth();
  const currentDate = today.getDate();

  const displayYear = viewYear;
  const displayMonth = new Date(viewYear, viewMonth, 1).toLocaleString('zh-CN', { month: 'long' });

  const getDaysInMonth = (year, month) => new Date(year, month + 1, 0).getDate();
  const getFirstDayOfMonth = (year, month) => new Date(year, month, 1).getDay();

  const daysInMonth = getDaysInMonth(viewYear, viewMonth);
  const firstDay = getFirstDayOfMonth(viewYear, viewMonth);
  const emptyCells = (firstDay + 6) % 7;
  const totalCells = emptyCells + daysInMonth;

  useEffect(() => {
    const fetchMonthDiaries = async () => {
      try {
        const monthNum = viewMonth + 1;
        const response = await fetch(`${API_BASE}/api/diary/month/${viewYear}/${monthNum}`, {
          headers: { 'Authorization': `Bearer ${getToken()}` }
        });
        const data = await response.json();
        const diariesMap = {};
        if (data.diaries) {
          data.diaries.forEach(d => {
            const day = parseInt(d.date.split('-')[2]);
            diariesMap[day] = d;
          });
        }
          setMonthDiaries(diariesMap);
      } catch (error) {
        console.error('获取月度日记失败:', error);
      }
    };
    fetchMonthDiaries();
  }, [viewYear, viewMonth]);

  const handlePrevYear = () => setViewYear(y => y - 1);
  const handlePrevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
    else setViewMonth(m => m - 1);
  };
  const handleNextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
    else setViewMonth(m => m + 1);
  };
  const handleNextYear = () => setViewYear(y => y + 1);

  const handleMonthSelect = (m) => {
    setViewMonth(m);
    setInputMonth((m + 1).toString());
    setShowMonthPicker(false);
  };

  const handleYearChange = () => {
    const y = parseInt(inputYear);
    if (y >= 1900 && y <= 2100) {
      setViewYear(y);
      setShowYearPicker(false);
    }
  };

  const handleMonthChange = () => {
    const m = parseInt(inputMonth);
    if (m >= 1 && m <= 12) {
      setViewMonth(m - 1);
      setShowMonthPicker(false);
    }
  };

  const handleDayClick = (dayNum) => {
    const monthNames = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
    const targetDate = new Date(viewYear, viewMonth, dayNum);
    setSelectedDate({
      year: viewYear,
      date: `${dayNum}日`,
      day: targetDate.toLocaleString('zh-CN', { weekday: 'long' }),
      weather: '晴',
      month: monthNames[viewMonth]
    });
    setActivePage('workspace');
  };

  const handleOpenToday = () => {
    setSelectedDate({
      year: currentYear,
      date: `${currentDate}日`,
      day: today.toLocaleString('zh-CN', { weekday: 'long' }),
      weather: '晴',
      month: today.toLocaleString('zh-CN', { month: 'long' })
    });
    setActivePage('workspace');
  };

  // 情绪候选词 = 普拉奇克 8 基本 + 8 复合 + 16 补充（与后端 classify_emotion 一致）
  const EMOTIONS = [
    '喜悦', '信任', '恐惧', '惊讶', '悲伤', '厌恶', '愤怒', '期待',
    '爱', '服从', '敬畏', '失望', '悔恨', '蔑视', '侵略', '乐观',
    '懊恼', '内疚', '焦虑', '委屈', '疲惫', '无奈', '释然', '思念',
    '满足', '兴奋', '孤独', '感激', '平静', '紧张', '烦躁', '期待感',
  ];

  // ============================================================
  // 情绪轮颜色机制（基于普拉奇克情绪轮）
  // 统一由 shared/emotion_utils.js 提供（与手机端一致）
  // ============================================================

  // 点击情绪文字 → 弹出情绪选择器
  const handleEmotionClick = (e, dayNum, dateStr) => {
    e.stopPropagation();
    setEmotionPicker({ open: true, day: dayNum, dateStr });
  };

  // 选择情绪 → 更新后端 + 本地状态
  const handleEmotionSelect = async (emotion) => {
    const { day, dateStr } = emotionPicker;
    setEmotionPicker({ open: false, day: null, dateStr: '' });
    // 乐观更新本地状态
    setMonthDiaries(prev => ({
      ...prev,
      [day]: { ...prev[day], emotion }
    }));
    try {
      await fetch(`${API_BASE}/api/diary/emotion`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
        body: JSON.stringify({ date: dateStr, emotion })
      });
    } catch (error) {
      console.error('更新情绪失败:', error);
    }
  };

  const renderDayCell = (dayNum) => {
    if (dayNum < 1) {
      return <div key={`empty-${dayNum}`} className="h-28"></div>;
    }
    if (dayNum > daysInMonth) {
      return <div key={`empty-${dayNum}`} className="h-28"></div>;
    }
    
    const diaryInfo = monthDiaries[dayNum];
    const isToday = viewYear === currentYear && viewMonth === currentMonth && dayNum === currentDate;
    const hasDiary = !!diaryInfo && diaryInfo.has_diary;
    const emotion = diaryInfo?.emotion || '';
    const monthStr = String(viewMonth + 1).padStart(2, '0');
    const dayStr = String(dayNum).padStart(2, '0');
    const dateStr = `${viewYear}-${monthStr}-${dayStr}`;
    const eColors = emotionColor(emotion) || null;

    let bgColor = '#f9fafb';
    let borderColor = '#f3f4f6';
    let hoverBg = '#f3f4f6';
    let glowStyle = {};  // 今天的框外光晕

    if (isToday) {
      if (hasDiary && eColors) {
        // 今天有日记+情绪 → 正常彩色 + 框外光晕
        bgColor = eColors.bg;
        borderColor = eColors.border;
        hoverBg = 'rgba(255,255,255,0.6)';
        glowStyle = { boxShadow: `0 0 18px 4px ${eColors.glow}, 0 0 6px 1px ${eColors.glow}` };
      } else if (hasDiary) {
        // 今天有日记无情绪 → 白色背景 + 黑色边框
        bgColor = '#ffffff';
        borderColor = '#111827';
        hoverBg = '#f3f4f6';
      } else {
        // 今天无日记 → 白色背景 + 黑色边框
        bgColor = '#ffffff';
        borderColor = '#111827';
        hoverBg = '#f3f4f6';
      }
    } else {
      if (hasDiary && eColors) {
        bgColor = eColors.bg;
        borderColor = eColors.border;
        hoverBg = 'rgba(255,255,255,0.6)';
      }
      // 无情绪或未写日记 → 保持默认灰色，不做特殊处理
    }

    return (
      <div
        key={dayNum}
        onClick={() => handleDayClick(dayNum)}
        style={{ ...glowStyle, backgroundColor: bgColor, borderColor }}
        className={`relative h-28 border-2 rounded-xl ${hoverBg} cursor-pointer transition-all duration-200 hover:shadow-md hover:scale-[1.02] group`}
      >
        {/* 顶部日期栏 */}
        <div className="absolute top-1.5 left-2 right-2 flex items-center justify-between">
          <span className={`text-xs font-semibold ${isToday ? 'text-gray-900 bg-gray-200 px-1.5 py-0.5 rounded-full' : 'text-gray-500'}`}>
            {isToday && hasDiary ? '今天' : dayNum}
          </span>
          {hasDiary && eColors && !isToday && (
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: eColors.dot }}></span>
          )}
        </div>

        {/* 情绪文字：居中大字 */}
        {hasDiary && (
          <div className="absolute inset-0 flex items-center justify-center">
            {emotion ? (
              <button
                onClick={(e) => handleEmotionClick(e, dayNum, dateStr)}
                className={`text-2xl font-black ${isToday ? 'hover:scale-105' : ''} hover:scale-110 transition-all px-3 py-1.5 rounded-xl hover:bg-white/50 cursor-pointer tracking-widest group-hover:shadow-sm`}
                style={eColors ? { color: eColors.text } : { color: '#047857' }}
                title="点击更换情绪"
              >
                {emotion}
              </button>
            ) : (
              <span className={`text-lg font-bold ${isToday ? 'text-gray-900' : 'text-gray-400'}`}>—</span>
            )}
          </div>
        )}

        {/* 今日标记（无日记时） */}
        {isToday && !hasDiary && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-lg font-bold text-gray-900">今天</span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col p-8 bg-white overflow-y-auto">
      <div className="flex justify-between items-end mb-8">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <button onClick={handlePrevYear} className="w-8 h-8 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-600 font-bold flex items-center justify-center transition-colors" title="上一年">&#171;</button>
            <button onClick={handlePrevMonth} className="w-8 h-8 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-600 font-bold flex items-center justify-center transition-colors" title="上一月">&#8249;</button>
            <div className="relative">
              <button onClick={() => { setShowYearPicker(!showYearPicker); setShowMonthPicker(false); }} className="px-3 py-2 rounded-lg hover:bg-gray-100 text-lg font-medium text-gray-800 cursor-pointer">
                {displayYear}年
              </button>
              {showYearPicker && (
                <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg p-3 z-50 w-32">
                  <input type="number" value={inputYear} onChange={(e) => setInputYear(e.target.value)} onBlur={handleYearChange} onKeyDown={(e) => e.key === 'Enter' && handleYearChange()} className="w-full px-2 py-1 border border-gray-200 rounded text-sm text-center" min="1900" max="2100" />
                </div>
              )}
            </div>
            <div className="relative">
              <button onClick={() => { setShowMonthPicker(!showMonthPicker); setShowYearPicker(false); }} className="px-3 py-2 rounded-lg hover:bg-gray-100 text-lg font-medium text-gray-800 cursor-pointer">
                {displayMonth}
              </button>
              {showMonthPicker && (
                <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg p-2 z-50 w-40 grid grid-cols-3 gap-1">
                  {['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'].map((m, i) => (
                    <button key={i} onClick={() => handleMonthSelect(i)} className={`px-2 py-1 text-xs rounded hover:bg-gray-100 ${viewMonth === i ? 'bg-slate-800 text-white' : 'text-gray-700'}`}>{m}</button>
                  ))}
                </div>
              )}
            </div>
            <button onClick={handleNextMonth} className="w-8 h-8 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-600 font-bold flex items-center justify-center transition-colors" title="下一月">&#8250;</button>
            <button onClick={handleNextYear} className="w-8 h-8 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-600 font-bold flex items-center justify-center transition-colors" title="下一年">&#187;</button>
          </div>
          <button onClick={() => { setViewYear(today.getFullYear()); setViewMonth(today.getMonth()); }} className="text-sm text-slate-600 hover:text-slate-800 hover:underline">回到今天</button>
        </div>
        <div className="flex gap-4">
          <button onClick={handleOpenToday} className="flex items-center gap-2 px-5 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-lg transition-colors shadow-md text-sm font-medium">
            <Plus size={16} />
            开启今日日记
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-4">
        {['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map(day => (
          <div key={day} className="text-center text-xs text-gray-400 font-medium mb-2">{day}</div>
        ))}
        {Array.from({ length: totalCells }, (_, i) => {
          const dayNum = i - emptyCells + 1;
          return renderDayCell(dayNum);
        })}
      </div>

      {/* 情绪选择弹窗 */}
      {emotionPicker.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={() => setEmotionPicker({ open: false, day: null, dateStr: '' })}>
          <div className="bg-white rounded-2xl shadow-xl p-5 w-72" onClick={e => e.stopPropagation()}>
            <div className="text-sm font-semibold text-gray-700 mb-3 text-center">
              {emotionPicker.dateStr} 的心情
            </div>
            <div className="grid grid-cols-3 gap-2">
              {EMOTIONS.map(e => (
                <button
                  key={e}
                  onClick={() => handleEmotionSelect(e)}
                  className="px-2 py-2 text-sm rounded-xl border border-gray-200 hover:bg-emerald-50 hover:border-emerald-300 hover:text-emerald-700 transition-colors text-gray-600"
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CalendarPage;