import React from 'react';
import { ChevronRight, CheckCircle2 } from 'lucide-react';

// ==========================================
// BranchCard — 单条觉察支线卡片
// 显示：标题、观察预览、证据、追问、底部状态
// ==========================================

// 规范化依据字段：统一为条目数组（兼容 JSON 数组字符串 / 数组 / 多行文本）
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

const BranchCard = ({ branch, onClick }) => {
  const hasSummary = !!branch.summary;
  const hasConversation = branch.conversation && branch.conversation.length > 0;
  const conversationRounds = hasConversation
    ? Math.floor(branch.conversation.length / 2)
    : 0;
  const evidenceItems = splitEvidence(branch.evidence);

  return (
    <div
      className="bg-white rounded-xl border border-gray-200 p-5 hover:border-indigo-300 hover:shadow-md transition-all cursor-pointer group"
      onClick={() => onClick(branch)}
    >
      {/* 标题 */}
      <div className="flex items-start justify-between mb-3">
        <h3 className="text-base font-bold text-gray-900 group-hover:text-indigo-700 transition-colors">
          {branch.title}
        </h3>
        <ChevronRight
          size={16}
          className="text-gray-300 group-hover:text-indigo-500 transition-colors shrink-0 mt-0.5"
        />
      </div>

      {/* 观察预览 */}
      <p className="text-sm text-gray-600 leading-relaxed mb-3 line-clamp-3">
        {branch.observation}
      </p>

      {/* 证据 */}
      {evidenceItems.length > 0 && (
        <div className="mb-3">
          <p className="text-xs text-amber-600 bg-amber-50 rounded-lg px-2.5 py-1.5 line-clamp-2 italic">
            {evidenceItems.join('；')}
          </p>
        </div>
      )}

      {/* 追问 */}
      <div className="mb-3">
        <p className="text-xs text-indigo-600 bg-indigo-50 rounded-lg px-2.5 py-1.5">
          {branch.question}
        </p>
      </div>

      {/* 底部状态 */}
      <div className="flex items-center justify-between pt-2 border-t border-gray-100">
        {hasSummary ? (
          <span className="text-xs text-green-600 flex items-center gap-1">
            <CheckCircle2 size={12} />已总结
          </span>
        ) : hasConversation ? (
          <span className="text-xs text-gray-400">
            {conversationRounds} 轮对话
          </span>
        ) : (
          <span className="text-xs text-gray-400">尚未探索</span>
        )}
        <span className="text-xs text-indigo-500 group-hover:text-indigo-700 font-medium transition-colors">
          展开探索 →
        </span>
      </div>
    </div>
  );
};

export default BranchCard;
