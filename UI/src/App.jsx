import React from 'react';
import { CalendarDays, PenTool, Eye, Settings, LogOut } from 'lucide-react';
import CalendarPage from './pages/CalendarPage';
import WorkspacePage from './pages/workspace/WorkspacePage';
import InsightPage from './pages/insight/InsightPage';
import SettingsPage from './pages/SettingsPage';
import ImportPage from './pages/import/ImportPage';
import LoginPage from './pages/LoginPage';
import { useApp } from './store/AppContext';

const App = () => {
  const { auth, navigation, date, workspaceRef } = useApp();
  const { isAuthenticated, currentUser, login, logout } = auth;
  const { activePage, setActivePage, setActivePageRaw } = navigation;
  const { selectedDate, setSelectedDate } = date;

  // 未登录时显示登录页
  if (!isAuthenticated) {
    return <LoginPage onLoginSuccess={login} />;
  }

  const navItems = [
    { id: 'calendar', icon: <CalendarDays size={20} />, label: '日历' },
    { id: 'workspace', icon: <PenTool size={20} />, label: '工作台' },
    { id: 'insight', icon: <Eye size={20} />, label: '觉察' }
  ];

  return (
    <div className="flex w-full h-screen bg-white font-sans overflow-hidden text-gray-800">
      {/* 侧边栏 */}
      <div className="w-20 shrink-0 bg-slate-50 border-r border-gray-200 flex flex-col items-center py-6 shadow-sm z-20">
        <div className="w-10 h-10 bg-slate-800 rounded-xl flex items-center justify-center text-white mb-10 shadow-md">
          <span className="font-bold font-serif text-xl">A</span>
        </div>
        <nav className="flex flex-col gap-4 w-full px-3">
          {navItems.map(item => (
            <button
              key={item.id}
              onClick={() => setActivePage(item.id)}
              className={`w-full aspect-square rounded-xl flex flex-col items-center justify-center gap-1 transition-all ${
                activePage === item.id
                  ? 'bg-white text-slate-800 shadow-sm border border-gray-200'
                  : 'text-gray-400 hover:text-slate-600 hover:bg-gray-100/50'
              }`}
              title={item.label}
            >
              {item.icon}
              <span className="text-[10px] font-medium scale-90">{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="mt-auto flex flex-col items-center gap-3">
          {currentUser && (
            <div className="px-2 text-center" title={`当前用户: ${currentUser.username}`}>
              <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 text-xs font-semibold mx-auto">
                {currentUser.username?.charAt(0).toUpperCase()}
              </div>
            </div>
          )}
          <button
            onClick={() => setActivePage('settings')}
            className={`w-12 h-12 rounded-xl flex items-center justify-center transition-colors ${
              activePage === 'settings'
                ? 'text-slate-800 bg-white shadow-sm border border-gray-200'
                : 'text-gray-400 hover:text-slate-600 hover:bg-gray-100'
            }`}
          >
            <Settings size={20} />
          </button>
          <button
            onClick={logout}
            className="w-12 h-12 rounded-xl flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
            title="退出登录"
          >
            <LogOut size={20} />
          </button>
        </div>
      </div>

      {/* 页面容器：所有页面始终挂载，通过 display:none 切换 */}
      <div className="flex-1 min-w-0 relative bg-white">
        {/* 日历页 */}
        <div style={{ display: activePage === 'calendar' ? 'block' : 'none', height: '100%' }}>
          <CalendarPage
            setSelectedDate={setSelectedDate}
            setActivePage={setActivePageRaw}
          />
        </div>
        {/* 工作台 */}
        <div style={{ display: activePage === 'workspace' ? 'block' : 'none', height: '100%' }}>
          <WorkspacePage
            ref={workspaceRef}
            selectedDate={selectedDate}
            setSelectedDate={setSelectedDate}
            isActive={activePage === 'workspace'}
          />
        </div>
        {/* 觉察 */}
        <div style={{ display: activePage === 'insight' ? 'block' : 'none', height: '100%' }}>
          <InsightPage />
        </div>
        {/* 设置 */}
        <div style={{ display: activePage === 'settings' ? 'block' : 'none', height: '100%' }}>
          <SettingsPage onOpenImport={() => setActivePageRaw('import')} />
        </div>
        {/* 导入页 */}
        <div style={{ display: activePage === 'import' ? 'block' : 'none', height: '100%' }}>
          <ImportPage onClose={() => setActivePageRaw('calendar')} />
        </div>
      </div>
    </div>
  );
};

export default App;
