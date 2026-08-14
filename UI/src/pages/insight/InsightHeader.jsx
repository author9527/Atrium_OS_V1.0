import React from 'react';
import { Clock } from 'lucide-react';

// ==========================================
// InsightHeader — 觉察结果顶部信息栏
// 显示：分析时间、日记数量、日期范围、耗时等
// ==========================================

const InsightHeader = ({ result }) => {
  if (!result) return null;

  // 格式化时间
  const formatTime = (iso) => {
    try {
      const d = new Date(iso);
      return d.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch { return iso; }
  };

  return (
    <div className="flex items-center gap-3 mb-6 text-xs text-gray-400">
      <span className="flex items-center gap-1">
        <Clock size={12} />
        {formatTime(result.timestamp)}
      </span>
      <span>{result.diary_count} 篇日记</span>
      <span>{result.date_range}</span>
      {result.elapsed_seconds && <span>耗时 {result.elapsed_seconds} 秒</span>}
    </div>
  );
};

export default InsightHeader;
