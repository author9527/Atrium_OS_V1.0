import React from 'react';
import { CloudRain, Loader2 } from 'lucide-react';

// ==========================================
// SidebarInfo — 工作台顶部信息栏
// 显示：日期、天气选择、保存状态、共情助手开关、对话列表开关
// ==========================================

const WEATHER_OPTIONS = ['晴', '多云', '阴', '小雨', '雷阵雨', '雪'];

const SidebarInfo = ({
  selectedDate,
  showWeatherPicker,
  onToggleWeatherPicker,
  onWeatherChange,
  saveMsg,
  isSaving,
  diary,
  chatPanelVisible,
  onToggleChatPanel,
  sessionListVisible,
  onToggleSessionList,
}) => {
  return (
    <div className="h-14 bg-white border-b border-gray-200 flex items-center justify-between px-6 shrink-0 shadow-sm">
      {/* 左侧：日期 + 天气 */}
      <div className="flex items-center gap-4 text-sm text-gray-500">
        <span className="font-medium text-gray-700">
          {selectedDate.year}年{selectedDate.month}{selectedDate.date} {selectedDate.day}
        </span>
        <div className="w-px h-4 bg-gray-300" />
        <div className="relative">
          <button
            onClick={onToggleWeatherPicker}
            className="flex items-center gap-1 hover:text-gray-800 transition-colors"
          >
            <CloudRain size={16} />
            <span>{selectedDate.weather}</span>
          </button>
          {showWeatherPicker && (
            <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg p-2 z-50 flex gap-2">
              {WEATHER_OPTIONS.map(w => (
                <button
                  key={w}
                  onClick={() => onWeatherChange(w)}
                  className={`px-3 py-1 text-sm rounded hover:bg-gray-100 ${
                    selectedDate.weather === w ? 'bg-slate-800 text-white' : 'text-gray-700'
                  }`}
                >{w}</button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 右侧：保存状态 + 助手开关 */}
      <div className="flex items-center gap-3">
        {saveMsg && (
          <span className={`text-xs px-2 py-1 rounded ${
            saveMsg === '已保存' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
          }`}>
            {saveMsg}
          </span>
        )}
        <span className="text-xs text-gray-400 bg-gray-100 px-2 py-1 rounded-md flex items-center gap-1">
          <span className={`w-2 h-2 rounded-full ${isSaving ? 'bg-yellow-500 animate-pulse' : 'bg-emerald-500'}`} />
          {isSaving ? '保存中...' : diary ? '已保存' : '新日记'}
        </span>
        <button
          onClick={onToggleChatPanel}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            chatPanelVisible
              ? 'bg-indigo-100 text-indigo-700'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          {chatPanelVisible ? '收起助手' : '共情助手'}
        </button>
        {chatPanelVisible && (
          <button
            onClick={onToggleSessionList}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              sessionListVisible
                ? 'bg-indigo-100 text-indigo-700'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {sessionListVisible ? '隐藏对话' : '对话列表'}
          </button>
        )}
      </div>
    </div>
  );
};

export default SidebarInfo;
