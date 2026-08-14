import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { getToken, clearToken, api } from '../api';

// ==========================================
// 工具函数
// ==========================================

const getToday = () => {
  const now = new Date();
  return {
    year: now.getFullYear(),
    month: now.toLocaleString('zh-CN', { month: 'long' }),
    date: `${now.getDate()}日`,
    day: now.toLocaleString('zh-CN', { weekday: 'long' }),
    weather: '晴',
    dateStr: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  };
};

// ==========================================
// Context 定义
// ==========================================

const AppContext = createContext(null);

// ==========================================
// AppProvider — 全局状态提供者
// ==========================================

export const AppProvider = ({ children }) => {
  // ---- 认证状态 ----
  const [isAuthenticated, setIsAuthenticated] = useState(!!getToken());
  const [currentUser, setCurrentUser] = useState(null);

  // ---- 导航状态 ----
  const [activePage, setActivePage] = useState('calendar');

  // ---- 日期状态 ----
  const [selectedDate, setSelectedDate] = useState(getToday());

  // ---- 工作区 ref（用于页面切换时自动保存检查）----
  const workspaceRef = useRef(null);

  // 监听 401 事件：token 过期或无效时自动跳转到登录页
  useEffect(() => {
    const handleAuthError = () => {
      clearToken();
      setCurrentUser(null);
      setIsAuthenticated(false);
    };
    window.addEventListener('auth:401', handleAuthError);
    return () => window.removeEventListener('auth:401', handleAuthError);
  }, []);

  // ---- 认证相关操作 ----

  /** 登录成功回调 */
  const login = useCallback((user) => {
    setCurrentUser(user);
    setIsAuthenticated(true);
  }, []);

  /** 退出登录 */
  const logout = useCallback(() => {
    api.logout();
    setCurrentUser(null);
    setIsAuthenticated(false);
  }, []);

  // ---- 页面切换（带工作区保存检查）----

  const navigateTo = useCallback(async (pageId) => {
    if (activePage === 'workspace' && workspaceRef.current) {
      if (workspaceRef.current.hasUnsavedChanges()) {
        try {
          await workspaceRef.current.saveDiary();
        } catch (e) {
          console.error('页面切换时保存失败:', e);
        }
      }
    }
    setActivePage(pageId);
  }, [activePage]);

  // ---- 日期选择（从日历页点击日期 → 设置日期并切换到工作台）----

  const selectDate = useCallback((dateInfo) => {
    setSelectedDate(dateInfo);
    setActivePage('workspace');
  }, []);

  // ---- Context 值 ----
  const value = {
    // 认证
    auth: {
      isAuthenticated,
      currentUser,
      login,
      logout,
    },
    // 导航
    navigation: {
      activePage,
      setActivePage: navigateTo,
      setActivePageRaw: setActivePage,
    },
    // 日期
    date: {
      selectedDate,
      setSelectedDate,
    },
    // 工作区 ref（供 WorkspacePage 绑定）
    workspaceRef,
  };

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
};

// ==========================================
// useApp — 简化访问的 hook
// ==========================================

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};

export default AppContext;
