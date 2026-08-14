import React, { useState, useEffect } from 'react';
import { Settings, Save, Cpu, Key, Heart, ScrollText, Sparkles, Check, Globe, RefreshCw, Loader2, Upload, Download, Database, CalendarPlus } from 'lucide-react';
import { API_BASE, getToken } from '../api';

const SettingsPage = ({ onOpenImport }) => {
  const [settings, setSettings] = useState(null);
  const [localModels, setLocalModels] = useState(null);
  const [templates, setTemplates] = useState(null);
  const [consolidationLog, setConsolidationLog] = useState(null);
  const [activeTab, setActiveTab] = useState('model');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [ioFormats, setIoFormats] = useState([]);
  const [importText, setImportText] = useState('');
  const [importFile, setImportFile] = useState(null);
  const [importFormat, setImportFormat] = useState('');
  const [overwrite, setOverwrite] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState('');
  const [exportFormat, setExportFormat] = useState('atrium');

  useEffect(() => {
    fetch(`${API_BASE}/api/settings`, { headers: { 'Authorization': `Bearer ${getToken()}` } }).then(r => r.json()).then(setSettings);
    fetch(`${API_BASE}/api/settings/local-models`, { headers: { 'Authorization': `Bearer ${getToken()}` } }).then(r => r.json()).then(setLocalModels);
    fetch(`${API_BASE}/api/settings/ego-templates`, { headers: { 'Authorization': `Bearer ${getToken()}` } }).then(r => r.json()).then(setTemplates);
    fetch(`${API_BASE}/api/settings/consolidation-log`, { headers: { 'Authorization': `Bearer ${getToken()}` } }).then(r => r.json()).then(setConsolidationLog);
    fetch(`${API_BASE}/api/diary/formats`, { headers: { 'Authorization': `Bearer ${getToken()}` } }).then(r => r.json()).then(d => d.success && setIoFormats(d.formats || []));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg('');
    try {
      const res = await fetch(`${API_BASE}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
        body: JSON.stringify(settings)
      });
      const data = await res.json();
      if (data.success) {
        setSaveMsg('✅ 设置已保存');
        setTimeout(() => setSaveMsg(''), 3000);
      }
    } catch (e) {
      setSaveMsg('❌ 保存失败');
    }
    setSaving(false);
  };

  const refreshModels = () => {
    fetch(`${API_BASE}/api/settings/local-models`, { headers: { 'Authorization': `Bearer ${getToken()}` } }).then(r => r.json()).then(setLocalModels);
  };

  const refreshLog = () => {
    fetch(`${API_BASE}/api/settings/consolidation-log`, { headers: { 'Authorization': `Bearer ${getToken()}` } }).then(r => r.json()).then(setConsolidationLog);
  };

  const handleFileChange = (e) => {
    const f = e.target.files?.[0];
    setImportFile(f);
    setImportMsg('');
  };

  const handleImport = async (e) => {
    e.preventDefault();
    setImportMsg('');
    let text = importText;
    let filename = '';
    if (importFile) {
      const content = await importFile.text();
      text = content;
      filename = importFile.name;
    }
    if (!text || !text.trim()) {
      setImportMsg('❌ 请粘贴内容或选择文件');
      return;
    }
    setImporting(true);
    try {
      const res = await fetch(`${API_BASE}/api/diary/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
        body: JSON.stringify({ text, filename, source_format: importFormat || null, overwrite })
      });
      const data = await res.json();
      if (data.success) {
        const fmt = ioFormats.find(f => f.id === data.format);
        setImportMsg(`✅ 导入完成：新增 ${data.imported} 条，覆盖 ${data.updated} 条，跳过 ${data.skipped} 条（检测格式：${fmt ? fmt.label : data.format}）。导入仅写入日记，未触发任何数据分析。`);
      } else {
        setImportMsg(`❌ ${data.error?.message || '导入失败'}`);
      }
    } catch (err) {
      setImportMsg('❌ 导入出错：' + err.message);
    }
    setImporting(false);
  };

  const handleExport = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/diary/export?format=${exportFormat}`, {
        headers: { 'Authorization': `Bearer ${getToken()}` }
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setImportMsg(`❌ 导出失败：${d.error?.message || res.status}`);
        return;
      }
      const blob = await res.blob();
      const fmt = ioFormats.find(f => f.id === exportFormat);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `atrium_diaries.${fmt ? fmt.ext : 'json'}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setImportMsg('❌ 导出出错：' + err.message);
    }
  };

  const updateField = (key, value) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  if (!settings || !templates) {
    return <div className="h-full flex items-center justify-center bg-gray-50"><Loader2 size={24} className="animate-spin text-gray-400" /></div>;
  }

  const tabs = [
    { id: 'model', label: '模型配置', icon: <Cpu size={16} /> },
    { id: 'api', label: 'API Key', icon: <Key size={16} /> },
    { id: 'ego', label: 'AI 人格', icon: <Heart size={16} /> },
    { id: 'migrate', label: '数据迁移', icon: <Database size={16} /> },
    { id: 'log', label: '沉淀日志', icon: <ScrollText size={16} /> }
  ];

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {/* Header */}
      <div className="h-14 bg-white border-b border-gray-200 flex items-center justify-between px-6 shrink-0 shadow-sm">
        <div className="flex items-center gap-3">
          <Settings size={20} className="text-gray-600" />
          <h2 className="text-lg font-medium text-gray-800">系统设置</h2>
        </div>
        <div className="flex items-center gap-3">
          {saveMsg && <span className="text-sm text-emerald-600">{saveMsg}</span>}
          {onOpenImport && (
            <button onClick={onOpenImport} className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition-colors text-sm font-medium">
              <CalendarPlus size={14} />
              导入日记
            </button>
          )}
          <button onClick={handleSave} disabled={saving} className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-900 disabled:opacity-50 text-white rounded-lg transition-colors text-sm font-medium">
            <Save size={14} />
            {saving ? '保存中...' : '保存设置'}
          </button>
        </div>
      </div>

      {/* Tab Nav */}
      <div className="flex border-b border-gray-200 bg-white px-6">
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.id ? 'border-slate-800 text-slate-800' : 'border-transparent text-gray-400 hover:text-gray-600'
            }`}>
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {/* 模型配置 Tab */}
        {activeTab === 'model' && (
          <div className="max-w-2xl space-y-6">
            {/* 调用优先级 */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h3 className="text-sm font-semibold text-gray-800 mb-4 flex items-center gap-2">
                <Sparkles size={16} className="text-amber-500" />
                模型调用优先级
              </h3>
              <p className="text-xs text-gray-400 mb-4">选择 AI 助手优先使用的模型来源</p>
              <div className="flex gap-3">
                <button onClick={() => updateField('model_priority', 'local')}
                  className={`flex-1 p-4 rounded-xl border-2 transition-all text-left ${
                    settings.model_priority === 'local' ? 'border-emerald-500 bg-emerald-50' : 'border-gray-200 hover:border-gray-300'
                  }`}>
                  <div className="flex items-center gap-2 mb-1">
                    <Cpu size={18} className={settings.model_priority === 'local' ? 'text-emerald-600' : 'text-gray-400'} />
                    <span className="font-medium text-sm">本地模型 (Ollama)</span>
                    {settings.model_priority === 'local' && <Check size={16} className="text-emerald-500 ml-auto" />}
                  </div>
                  <p className="text-xs text-gray-400">离线可用，响应速度快，无需 API 费用</p>
                </button>
                <button onClick={() => updateField('model_priority', 'api')}
                  className={`flex-1 p-4 rounded-xl border-2 transition-all text-left ${
                    settings.model_priority === 'api' ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
                  }`}>
                  <div className="flex items-center gap-2 mb-1">
                    <Globe size={18} className={settings.model_priority === 'api' ? 'text-blue-600' : 'text-gray-400'} />
                    <span className="font-medium text-sm">远程 API</span>
                    {settings.model_priority === 'api' && <Check size={16} className="text-blue-500 ml-auto" />}
                  </div>
                  <p className="text-xs text-gray-400">需要网络，模型能力更强</p>
                </button>
              </div>
            </div>

            {/* 本地模型选择 */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                  <Cpu size={16} className="text-emerald-500" />
                  本地模型
                </h3>
                <button onClick={refreshModels} className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1">
                  <RefreshCw size={12} /> 刷新
                </button>
              </div>
              {localModels === null ? (
                <div className="text-sm text-gray-400 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> 检测中...</div>
              ) : !localModels.available ? (
                <div className="text-sm text-red-400 bg-red-50 rounded-lg p-3">{localModels.error}</div>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {localModels.models.map(model => (
                    <button key={model.name} onClick={() => updateField('local_model', model.name)}
                      className={`w-full flex items-center justify-between p-3 rounded-lg border transition-all text-left ${
                        settings.local_model === model.name ? 'border-emerald-500 bg-emerald-50' : 'border-gray-100 hover:border-gray-200'
                      }`}>
                      <div>
                        <div className="text-sm font-medium text-gray-700">{model.name}</div>
                        <div className="text-xs text-gray-400">{model.family} · {model.size} GB</div>
                      </div>
                      {settings.local_model === model.name && <Check size={16} className="text-emerald-500" />}
                    </button>
                  ))}
                  {localModels.models.length === 0 && <div className="text-sm text-gray-400 text-center py-4">未检测到已下载的模型</div>}
                </div>
              )}
            </div>
          </div>
        )}

        {/* API Key Tab */}
        {activeTab === 'api' && (
          <div className="max-w-2xl space-y-6">
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h3 className="text-sm font-semibold text-gray-800 mb-4 flex items-center gap-2">
                <Globe size={16} className="text-blue-500" />
                OpenRouter API Key
              </h3>
              <p className="text-xs text-gray-400 mb-4">
                用于调用远程大模型。可在 <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" className="text-blue-500 underline">openrouter.ai/keys</a> 获取。
              </p>
              <input type="password" value={settings.openrouter_api_key || ''} onChange={e => updateField('openrouter_api_key', e.target.value)}
                placeholder="sk-or-v1-..." className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-500 font-mono" />
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h3 className="text-sm font-semibold text-gray-800 mb-4">远程模型选择</h3>
              <input type="text" value={settings.openrouter_model || ''} onChange={e => updateField('openrouter_model', e.target.value)}
                placeholder="nvidia/nemotron-3-super-120b-a12b:free" className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-500 font-mono" />
              <p className="text-xs text-gray-400 mt-2">可在 <a href="https://openrouter.ai/models" target="_blank" rel="noopener noreferrer" className="text-blue-500 underline">openrouter.ai/models</a> 查看可用模型</p>
            </div>
          </div>
        )}

        {/* AI 人格 Tab */}
        {activeTab === 'ego' && (
          <div className="max-w-2xl space-y-6">
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h3 className="text-sm font-semibold text-gray-800 mb-4 flex items-center gap-2">
                <Heart size={16} className="text-pink-500" />
                人格预设模板
              </h3>
              <p className="text-xs text-gray-400 mb-4">选择一个预设模板来定义 AI 共情助手的性格</p>
              <div className="grid grid-cols-2 gap-3">
                {Object.entries(templates.templates).map(([key, tpl]) => (
                  <button key={key} onClick={() => updateField('ego_template', key)}
                    className={`p-4 rounded-xl border-2 transition-all text-left ${
                      settings.ego_template === key ? 'border-pink-400 bg-pink-50' : 'border-gray-100 hover:border-gray-200'
                    }`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-medium text-sm">{tpl.name}</span>
                      {settings.ego_template === key && <Check size={14} className="text-pink-500" />}
                    </div>
                    <p className="text-xs text-gray-400">{tpl.description}</p>
                  </button>
                ))}
              </div>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h3 className="text-sm font-semibold text-gray-800 mb-4">
                {settings.ego_template === 'custom' ? '自定义人格描述' : '当前人格设定'}
              </h3>
              {settings.ego_template !== 'custom' && (
                <div className="mb-4 p-3 bg-gray-50 rounded-lg text-xs text-gray-500 whitespace-pre-line">
                  {templates.templates[settings.ego_template]?.ego || ''}
                </div>
              )}
              <textarea value={settings.ego_custom || ''} onChange={e => updateField('ego_custom', e.target.value)}
                placeholder={settings.ego_template === 'custom' ? '输入自定义人格描述，每行一条特质...\n例如：\n- 说话温柔，善解人意\n- 喜欢用比喻安慰人' : '留空则使用预设模板的人格设定'}
                rows="6" className="w-full px-4 py-3 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-pink-500 resize-none" />
              {settings.ego_template === 'custom' && (
                <p className="text-xs text-gray-400 mt-2">每行一条人格特质，以 "- " 开头</p>
              )}
            </div>
          </div>
        )}

        {/* 数据迁移 Tab */}
        {activeTab === 'migrate' && (
          <div className="max-w-2xl space-y-6">
            {/* 可视化导入引导 */}
            {onOpenImport && (
              <div className="bg-white rounded-xl border border-emerald-200 p-6">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-800 mb-1 flex items-center gap-2">
                      <CalendarPlus size={16} className="text-emerald-500" />
                      可视化导入历史日记
                    </h3>
                    <p className="text-xs text-gray-400">
                      在日历上逐日粘贴，或从 Day One / CSV / Markdown 等文件一键导入。草稿实时自动保存，可随时中断，点击「导入完成」一次性写入。
                    </p>
                  </div>
                  <button onClick={onOpenImport}
                    className="shrink-0 flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition-colors text-sm font-medium">
                    <CalendarPlus size={14} />
                    进入导入页
                  </button>
                </div>
              </div>
            )}

            {/* 导入 */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h3 className="text-sm font-semibold text-gray-800 mb-1 flex items-center gap-2">
                <Upload size={16} className="text-emerald-500" />
                导入历史日记
              </h3>
              <p className="text-xs text-gray-400 mb-4">
                支持 Atrium 富文本 JSON、Day One JSON、CSV、Markdown、纯文本。格式自动检测，也可手动指定。导入仅写入日记，<span className="text-emerald-600 font-medium">不会触发任何数据分析</span>。
              </p>

              <form onSubmit={handleImport} className="space-y-4">
                <div>
                  <label className="text-xs font-medium text-gray-500 mb-1 block">粘贴内容</label>
                  <textarea value={importText} onChange={e => setImportText(e.target.value)} rows="5"
                    placeholder="在此粘贴要导入的日记内容（JSON / CSV / Markdown / 纯文本）..."
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-emerald-500 font-mono resize-none" />
                </div>

                <div className="flex items-center gap-3">
                  <span className="text-xs font-medium text-gray-500">或选择文件</span>
                  <input type="file" onChange={handleFileChange}
                    accept=".json,.csv,.md,.markdown,.txt"
                    className="text-xs text-gray-500 file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:bg-gray-100 file:text-xs file:font-medium file:text-gray-700 hover:file:bg-gray-200" />
                  {importFile && <span className="text-xs text-gray-500 truncate max-w-[180px]">{importFile.name}</span>}
                </div>

                <div className="flex flex-wrap items-center gap-4">
                  <div>
                    <label className="text-xs text-gray-500 mr-2">格式</label>
                    <select value={importFormat} onChange={e => setImportFormat(e.target.value)}
                      className="px-2 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-emerald-500">
                      <option value="">自动检测</option>
                      {ioFormats.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
                    </select>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-gray-500 cursor-pointer">
                    <input type="checkbox" checked={overwrite} onChange={e => setOverwrite(e.target.checked)} className="accent-emerald-500" />
                    覆盖已有日期的日记
                  </label>
                </div>

                <div className="flex items-center gap-3">
                  <button type="submit" disabled={importing}
                    className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg transition-colors text-sm font-medium">
                    {importing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                    {importing ? '导入中...' : '开始导入'}
                  </button>
                  {importMsg && <span className="text-xs text-gray-600 break-all">{importMsg}</span>}
                </div>
              </form>
            </div>

            {/* 导出 */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h3 className="text-sm font-semibold text-gray-800 mb-1 flex items-center gap-2">
                <Download size={16} className="text-blue-500" />
                导出全部日记
              </h3>
              <p className="text-xs text-gray-400 mb-4">将全部日记导出为所选格式，便于备份或迁移到其他软件。</p>
              <div className="flex items-center gap-3">
                <select value={exportFormat} onChange={e => setExportFormat(e.target.value)}
                  className="px-2 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-500">
                  {ioFormats.map(f => <option key={f.id} value={f.id}>{f.label} (.{f.ext})</option>)}
                </select>
                <button onClick={handleExport}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors text-sm font-medium">
                  <Download size={14} />
                  导出
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 沉淀日志 Tab */}
        {activeTab === 'log' && (
          <div className="max-w-2xl space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                <ScrollText size={16} className="text-indigo-500" />
                记忆沉淀日志
              </h3>
              <button onClick={refreshLog} className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1">
                <RefreshCw size={12} /> 刷新
              </button>
            </div>

            {consolidationLog && (
              <>
                {/* 锚点信息 */}
                <div className="bg-white rounded-xl border border-gray-200 p-6">
                  <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">沉淀锚点</h4>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-xs text-gray-400">上次日记沉淀时间</div>
                      <div className="text-sm font-medium text-gray-700 mt-1">{consolidationLog.anchor.last_diary_ts || '—'}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-400">上次对话沉淀时间</div>
                      <div className="text-sm font-medium text-gray-700 mt-1">{consolidationLog.anchor.last_dialogue_ts ? new Date(consolidationLog.anchor.last_dialogue_ts * 1000).toLocaleString('zh-CN') : '—'}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-400">已沉淀日记数</div>
                      <div className="text-sm font-medium text-gray-700 mt-1">{consolidationLog.anchor.total_diaries_consolidated || 0}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-400">上次沉淀完成</div>
                      <div className="text-sm font-medium text-gray-700 mt-1">{consolidationLog.anchor.last_consolidation_at ? new Date(consolidationLog.anchor.last_consolidation_at).toLocaleString('zh-CN') : '—'}</div>
                    </div>
                  </div>
                </div>

                {/* NPC 数据统计 */}
                <div className="bg-white rounded-xl border border-gray-200 p-6">
                  <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">NPC 数据统计</h4>
                  {consolidationLog.npc_stats.length === 0 ? (
                    <div className="text-sm text-gray-400 text-center py-4">暂无 NPC 数据</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-gray-100">
                            <th className="text-left py-2 text-xs font-medium text-gray-400">人物</th>
                            <th className="text-right py-2 text-xs font-medium text-gray-400">特质数</th>
                            <th className="text-right py-2 text-xs font-medium text-gray-400">关系数</th>
                          </tr>
                        </thead>
                        <tbody>
                          {consolidationLog.npc_stats.map(npc => (
                            <tr key={npc.name} className="border-b border-gray-50">
                              <td className="py-2 font-medium text-gray-700">{npc.name}</td>
                              <td className="py-2 text-right text-gray-500">{npc.traits_count}</td>
                              <td className="py-2 text-right text-gray-500">{npc.relationships_count}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default SettingsPage;