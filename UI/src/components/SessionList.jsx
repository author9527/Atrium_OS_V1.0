import React, { useState, useRef, useEffect } from 'react';
import { MessageSquarePlus, Trash2, Check, Pencil, X } from 'lucide-react';

const SessionList = ({ visible, sessions, currentSessionId, onSelect, onCreate, onDelete, onRename, onToggle }) => {
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const editInputRef = useRef(null);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const handleStartRename = (session, e) => {
    e.stopPropagation();
    setEditingId(session.id);
    setEditTitle(session.title);
  };

  const handleConfirmRename = () => {
    if (editTitle.trim() && editingId) {
      onRename(editingId, editTitle.trim());
    }
    setEditingId(null);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      handleConfirmRename();
    } else if (e.key === 'Escape') {
      setEditingId(null);
    }
  };

  const handleDelete = (sessionId, e) => {
    e.stopPropagation();
    if (sessions.length <= 1) return;
    onDelete(sessionId);
  };

  return (
    <div
      className="h-full flex shrink-0"
      style={{
        width: visible ? '200px' : '0px',
        minWidth: visible ? '180px' : '0px',
        transition: 'width 0.2s ease, min-width 0.2s ease'
      }}
    >
      <div className="flex-1 h-full bg-white border-r border-gray-200 shadow-sm flex flex-col overflow-hidden">
        {/* 头部 */}
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-gray-200 bg-gray-50 shrink-0">
          <span className="text-xs font-semibold text-gray-600">对话列表</span>
          <div className="flex items-center gap-1">
            <button
              onClick={onCreate}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-200 text-gray-500 transition-colors"
              title="新建对话"
            >
              <MessageSquarePlus size={14} />
            </button>
            <button
              onClick={onToggle}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-200 text-gray-400 transition-colors"
              title="折叠列表"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                <path d="M8 2 L3 6 L8 10" />
              </svg>
            </button>
          </div>
        </div>

        {/* 会话列表 */}
        <div className="flex-1 overflow-y-auto py-1">
          {sessions.map((s) => (
            <div
              key={s.id}
              onClick={() => onSelect(s.id)}
              className={`group flex items-center px-3 py-2 cursor-pointer transition-colors border-l-2 ${
                s.id === currentSessionId
                  ? 'bg-indigo-50 border-l-indigo-500 text-indigo-700'
                  : 'border-l-transparent hover:bg-gray-50 text-gray-700'
              }`}
            >
              {editingId === s.id ? (
                <div className="flex items-center gap-1 flex-1 min-w-0" onClick={e => e.stopPropagation()}>
                  <input
                    ref={editInputRef}
                    value={editTitle}
                    onChange={e => setEditTitle(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onBlur={handleConfirmRename}
                    className="flex-1 min-w-0 px-1 py-0.5 text-xs border border-indigo-300 rounded outline-none focus:ring-1 focus:ring-indigo-400"
                  />
                  <button onClick={handleConfirmRename} className="text-emerald-500 hover:text-emerald-600 shrink-0">
                    <Check size={12} />
                  </button>
                  <button onClick={() => setEditingId(null)} className="text-gray-400 hover:text-gray-600 shrink-0">
                    <X size={12} />
                  </button>
                </div>
              ) : (
                <>
                  <span className="text-xs truncate flex-1">{s.title}</span>
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button
                      onClick={(e) => handleStartRename(s, e)}
                      className="p-0.5 hover:bg-gray-200 rounded text-gray-400 hover:text-gray-600"
                      title="重命名"
                    >
                      <Pencil size={10} />
                    </button>
                    {sessions.length > 1 && (
                      <button
                        onClick={(e) => handleDelete(s.id, e)}
                        className="p-0.5 hover:bg-red-100 rounded text-gray-400 hover:text-red-500"
                        title="删除"
                      >
                        <Trash2 size={10} />
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default SessionList;