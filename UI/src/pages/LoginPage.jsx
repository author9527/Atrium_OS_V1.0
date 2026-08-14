import React, { useState, useCallback } from 'react';
import { Loader2, AlertCircle, User, Lock, PenTool } from 'lucide-react';
import { api } from '../api';

const LoginPage = ({ onLoginSuccess }) => {
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    const trimmedUser = username.trim();
    if (!trimmedUser || !password) {
      setError('请输入用户名和密码');
      return;
    }

    // 注册模式前端校验，与后端保持一致：至少 8 位且需包含字母和数字
    if (mode === 'register') {
      if (password.length < 8) {
        setError('密码长度至少 8 个字符');
        return;
      }
      if (!/[A-Za-z]/.test(password)) {
        setError('密码需包含至少一个字母');
        return;
      }
      if (!/\d/.test(password)) {
        setError('密码需包含至少一个数字');
        return;
      }
    }

    setLoading(true);
    setError('');

    try {
      const data =
        mode === 'login'
          ? await api.login(trimmedUser, password)
          : await api.register(trimmedUser, password);

      if (data.token) {
        onLoginSuccess?.(data.user);
      } else {
        setError('服务器返回异常，请重试');
      }
    } catch (err) {
      // 409：账号已在其他设备登录，给出明确、醒目的提示
      if (err.status === 409) {
        setError('该账号已在其他设备登录。请先在原设备退出登录，再在此处重新登录。');
      } else {
        setError(err.message || (mode === 'login' ? '登录失败，请检查用户名和密码' : '注册失败，请重试'));
      }
    } finally {
      setLoading(false);
    }
  }, [mode, username, password, onLoginSuccess]);

  const switchMode = () => {
    setMode(prev => (prev === 'login' ? 'register' : 'login'));
    setError('');
  };

  return (
    <div className="relative min-h-screen w-full flex items-center justify-center bg-gradient-to-br from-indigo-50 via-white to-purple-50 px-6">
      {/* 背景装饰 */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-96 h-96 bg-indigo-100 rounded-full blur-3xl opacity-40" />
        <div className="absolute -bottom-40 -left-40 w-96 h-96 bg-purple-100 rounded-full blur-3xl opacity-40" />
      </div>

      {/* 登录卡片 */}
      <div className="relative w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-xl border border-gray-100 p-10">
          {/* Logo / 标题 */}
          <div className="flex flex-col items-center mb-8">
            <div className="w-16 h-16 bg-indigo-600 rounded-2xl flex items-center justify-center text-white shadow-lg mb-4">
              <PenTool size={32} />
            </div>
            <h1 className="text-3xl font-bold text-gray-900 tracking-tight">
              Atrium OS
            </h1>
            <p className="text-base text-gray-400 mt-2">
              {mode === 'login' ? '欢迎回来，请登录您的账户' : '创建新账户，开始您的旅程'}
            </p>
          </div>

          {/* 错误提示 */}
          {error && (
            <div className="mb-5 flex items-center gap-2 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-base">
              <AlertCircle size={18} className="shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* 表单 */}
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* 用户名 */}
            <div>
              <label className="block text-base font-medium text-gray-700 mb-2">
                用户名
              </label>
              <div className="relative">
                <User size={20} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                <input
                  type="text"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  placeholder="请输入用户名"
                  autoComplete="username"
                  className="w-full pl-12 pr-4 py-3.5 text-lg border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                  disabled={loading}
                />
              </div>
            </div>

            {/* 密码 */}
            <div>
              <label className="block text-base font-medium text-gray-700 mb-2">
                密码
              </label>
              <div className="relative">
                <Lock size={20} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="请输入密码"
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  className="w-full pl-12 pr-4 py-3.5 text-lg border border-gray-200 rounded-xl bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                  disabled={loading}
                />
              </div>
              {mode === 'register' && (
                <p className="mt-2 text-sm text-gray-400">
                  至少 8 位，需同时包含字母和数字
                </p>
              )}
            </div>

            {/* 提交按钮 */}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-4 text-lg font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-colors shadow-md flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <Loader2 size={20} className="animate-spin" />
                  {mode === 'login' ? '登录中...' : '注册中...'}
                </>
              ) : (
                mode === 'login' ? '登 录' : '注 册'
              )}
            </button>
          </form>

          {/* 模式切换 */}
          <div className="mt-6 text-center">
            <span className="text-base text-gray-500">
              {mode === 'login' ? '还没有账户？' : '已有账户？'}
            </span>
            <button
              onClick={switchMode}
              disabled={loading}
              className="ml-2 text-base font-medium text-indigo-600 hover:text-indigo-700 disabled:opacity-50 transition-colors"
            >
              {mode === 'login' ? '立即注册' : '立即登录'}
            </button>
          </div>
        </div>

        {/* 底部提示 */}
        <p className="text-center text-sm text-gray-400 mt-6">
          Atrium OS · 心之庭 · 专为内省而生的数字空间
        </p>
      </div>
    </div>
  );
};

export default LoginPage;
