import React, { useState, useEffect } from 'react';
import { Eye, Loader2, Settings, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../../api';
import InsightHeader from './InsightHeader';
import BranchCard from './BranchCard';
import BranchChat from './BranchChat';

// ==========================================
// InsightPage — 觉察页面主容器
// 负责：状态管理、侧边栏、视图切换（总览/支线对话/空状态/加载中）
// ==========================================

const InsightPage = () => {
  const [latestResult, setLatestResult] = useState(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [settings, setSettings] = useState({
    auto_run: true,
    frequency: 'weekly',
    schedule_day: 7,
    schedule_time: '23:00',
    analysis_days: 30
  });
  const [showSettings, setShowSettings] = useState(false);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState('');

  // 支线探索状态
  const [activeBranchId, setActiveBranchId] = useState(null);
  const [activeBranch, setActiveBranch] = useState(null);

  // 加载最新分析结果
  const loadLatest = () => {
    api.insight.getLatest()
      .then(data => {
        if (data.id) setLatestResult(data);
      })
      .catch(() => {});
  };

  useEffect(() => { loadLatest(); }, []);

  // 加载设置
  useEffect(() => {
    api.insight.getSettings()
      .then(data => setSettings(data))
      .catch(() => {});
  }, []);

  // 加载历史
  const loadHistory = () => {
    api.insight.getHistory()
      .then(data => setHistory(data.history || []))
      .catch(() => {});
  };
  useEffect(() => { loadHistory(); }, []);

  // 运行分析
  const handleAnalyze = async () => {
    setIsAnalyzing(true);
    setError('');
    setActiveBranchId(null);
    setActiveBranch(null);
    try {
      const data = await api.insight.analyze(settings.analysis_days || 30);
      if (data.success) {
        setLatestResult(data);
        loadHistory();
      } else {
        setError(data.error || '分析失败');
      }
    } catch (e) {
      setError('连接服务器失败，请确认后端已启动');
    } finally {
      setIsAnalyzing(false);
    }
  };

  // 更新设置
  const handleSaveSettings = async () => {
    try {
      await api.insight.saveSettings(settings);
      setShowSettings(false);
    } catch (e) { console.error('保存设置失败', e); }
  };

  // 进入支线
  const handleEnterBranch = (branch) => {
    setActiveBranchId(branch.id);
    setActiveBranch({ ...branch });
  };

  // 返回总览
  const handleBackToOverview = () => {
    // 刷新数据以获取最新对话状态
    if (latestResult?.id) {
      api.insight.getResult(latestResult.id)
        .then(data => {
          if (data.branches) setLatestResult(data);
        })
        .catch(() => {});
    }
    setActiveBranchId(null);
    setActiveBranch(null);
  };

  // 加载历史记录中的指定结果
  const handleLoadHistoryItem = async (h) => {
    try {
      const data = await api.insight.getResult(h.id);
      if (data.branches) {
        setLatestResult(data);
        setActiveBranchId(null);
        setActiveBranch(null);
      }
    } catch { /* 忽略 */ }
  };

  // 删除指定觉察报告
  const handleDeleteResult = async (e, h) => {
    e.stopPropagation();
    if (!window.confirm(`确定要删除「${h.date_range}」这份觉察报告吗？其下所有支线和对话将一并删除，且无法恢复。`)) return;
    try {
      await api.insight.deleteResult(h.id);
      if (latestResult?.id === h.id) setLatestResult(null);
      loadHistory();
    } catch (err) {
      setError(err.message || '删除失败');
    }
  };

  // 格式化时间
  const formatTime = (iso) => {
    try {
      const d = new Date(iso);
      return d.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch { return iso; }
  };

  const branches = latestResult?.branches || [];

  return (
    <div className="h-full flex bg-gray-50 text-gray-800">
      {/* ====== 左侧边栏 ====== */}
      <div className="w-64 bg-white border-r border-gray-200 p-4 flex flex-col shrink-0">
        <div className="mb-4">
          <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Eye size={18} className="text-indigo-500" />觉察
          </h2>
          <p className="text-xs text-gray-400 mt-1">结构化探索日记中的隐藏模式</p>
        </div>

        <button
          onClick={handleAnalyze}
          disabled={isAnalyzing}
          className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors mb-3 flex items-center justify-center gap-2"
        >
          {isAnalyzing ? (
            <><Loader2 size={14} className="animate-spin" />分析中...</>
          ) : (
            <><RefreshCw size={14} />开始分析</>
          )}
        </button>

        <button
          onClick={() => setShowSettings(!showSettings)}
          className="w-full py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-sm transition-colors mb-4 flex items-center justify-center gap-1.5"
        >
          <Settings size={14} />设置
        </button>

        {error && (
          <div className="mb-3 p-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-600">{error}</div>
        )}

        {showSettings && (
          <div className="mb-4 p-3 bg-gray-50 rounded-lg text-sm space-y-3">
            <div>
              <label className="text-xs text-gray-500 block mb-1">自动分析</label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={settings.auto_run}
                  onChange={(e) => setSettings({ ...settings, auto_run: e.target.checked })}
                  className="rounded" />
                <span className="text-gray-700">启用</span>
              </label>
            </div>

            <div>
              <label className="text-xs text-gray-500 block mb-1">分析频率</label>
              <select value={settings.frequency || 'weekly'}
                onChange={(e) => {
                  const freq = e.target.value;
                  setSettings({ ...settings, frequency: freq, schedule_day: freq === 'weekly' ? 7 : 1 });
                }}
                className="w-full bg-white border border-gray-300 rounded px-2 py-1 text-sm">
                <option value="weekly">每周</option>
                <option value="monthly">每月</option>
              </select>
            </div>

            {(settings.frequency || 'weekly') === 'weekly' ? (
              <div>
                <label className="text-xs text-gray-500 block mb-1">分析日期</label>
                <select value={settings.schedule_day || 7}
                  onChange={(e) => setSettings({ ...settings, schedule_day: parseInt(e.target.value) })}
                  className="w-full bg-white border border-gray-300 rounded px-2 py-1 text-sm">
                  {['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((label, i) => (
                    <option key={i} value={i + 1}>{label}</option>
                  ))}
                </select>
              </div>
            ) : (
              <div>
                <label className="text-xs text-gray-500 block mb-1">分析日期</label>
                <select value={settings.schedule_day || 1}
                  onChange={(e) => setSettings({ ...settings, schedule_day: parseInt(e.target.value) })}
                  className="w-full bg-white border border-gray-300 rounded px-2 py-1 text-sm">
                  {Array.from({ length: 29 }, (_, i) => i + 1).map(d => (
                    <option key={d} value={d}>{d}号</option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label className="text-xs text-gray-500 block mb-1">分析时间</label>
              <input type="time" value={settings.schedule_time || '23:00'}
                onChange={(e) => setSettings({ ...settings, schedule_time: e.target.value })}
                className="w-full bg-white border border-gray-300 rounded px-2 py-1 text-sm" />
            </div>

            <div>
              <label className="text-xs text-gray-500 block mb-1">分析天数范围</label>
              <select value={settings.analysis_days || 30}
                onChange={(e) => setSettings({ ...settings, analysis_days: parseInt(e.target.value) })}
                className="w-full bg-white border border-gray-300 rounded px-2 py-1 text-sm">
                <option value={7}>最近 7 天</option>
                <option value={14}>最近 14 天</option>
                <option value={30}>最近 30 天</option>
                <option value={60}>最近 60 天</option>
                <option value={90}>最近 90 天</option>
                <option value={180}>最近 180 天</option>
                <option value={365}>最近 1 年</option>
                <option value={700}>全部</option>
              </select>
            </div>
            <button onClick={handleSaveSettings}
              className="w-full py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs transition-colors">
              保存设置
            </button>
          </div>
        )}

        {/* 历史记录 */}
        <div className="flex-1 min-h-0">
          <div className="text-xs text-gray-500 mb-2">历史分析</div>
          <div className="overflow-y-auto flex-1 space-y-1.5">
            {history.length === 0 ? (
              <div className="text-center text-gray-400 text-xs py-4">暂无历史分析</div>
            ) : (
              history.map((h) => (
                <div key={h.id}
                  className={`w-full flex items-center rounded-lg text-xs transition-colors ${latestResult?.id === h.id ? 'bg-indigo-50 border border-indigo-200' : 'hover:bg-gray-100'}`}>
                  <button
                    onClick={() => handleLoadHistoryItem(h)}
                    className="flex-1 text-left p-2">
                    <div className="flex justify-between items-center">
                      <span className="font-medium text-gray-700">{formatTime(h.timestamp)}</span>
                      <span className="text-gray-400">{h.branch_count}条支线</span>
                    </div>
                    <div className="text-gray-400 mt-0.5">{h.date_range}</div>
                    <div className="text-gray-500 mt-0.5 truncate">{h.preview}</div>
                  </button>
                  <button
                    onClick={(e) => handleDeleteResult(e, h)}
                    title="删除此报告"
                    className="p-2 text-gray-300 hover:text-red-500 transition-colors shrink-0">
                    <Trash2 size={14} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* ====== 右侧主内容区 ====== */}
      <div className="flex-1 flex flex-col min-w-0">
        {isAnalyzing ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-400">
            <Loader2 size={36} className="animate-spin mb-4 text-indigo-400" />
            <p className="text-sm">正在分析你的日记，生成觉察支线...</p>
            <p className="text-xs mt-1">这可能需要 1-2 分钟</p>
          </div>
        ) : activeBranch ? (
          /* ====== 支线深入对话视图 ====== */
          <BranchChat
            branch={activeBranch}
            resultId={latestResult?.id}
            onBack={handleBackToOverview}
            activeBranch={activeBranch}
            setActiveBranch={setActiveBranch}
          />
        ) : branches.length > 0 ? (
          /* ====== 支线总览视图 ====== */
          <div className="flex-1 overflow-y-auto px-6 py-6">
            <div className="max-w-3xl mx-auto">
              {/* 头部信息 */}
              <InsightHeader result={latestResult} />

              <h2 className="text-lg font-bold text-gray-900 mb-1">觉察支线</h2>
              <p className="text-sm text-gray-400 mb-6">点击任意支线，进入深入探索。每条支线都可以独立聊下去，聊完可以生成总结。</p>

              {/* 支线卡片网格 */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {branches.map((branch) => (
                  <BranchCard
                    key={branch.id}
                    branch={branch}
                    onClick={handleEnterBranch}
                  />
                ))}
              </div>

              {/* 底部免责 */}
              <div className="mt-8 pt-4 border-t border-gray-200">
                <p className="text-xs text-gray-400 text-center">
                  以上分析基于日记中的文字，不构成对他人真实想法的判断。
                  这只是帮你觉察的起点，不是终点。
                </p>
              </div>
            </div>
          </div>
        ) : (
          /* ====== 空状态 ====== */
          <div className="flex flex-col items-center justify-center h-full text-gray-400">
            <Eye size={48} className="mb-4 opacity-30" />
            <p className="text-sm mb-2">还没有分析结果</p>
            <p className="text-xs">点击"开始分析"，我会从日记中提取多条觉察支线，供你选择深入探索</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default InsightPage;
