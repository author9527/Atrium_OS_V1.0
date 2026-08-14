// ==========================================
// Atrium OS - 统一 API 客户端
// 提供: 请求封装、错误处理、响应状态检查、按模块分组的业务接口
// ==========================================

const TIMEOUT_MS = 30000;

// 动态获取 API 基础地址（支持内网穿透）
export const API_BASE = import.meta.env.VITE_API_BASE || '';

// ==========================================
// Token 管理（localStorage 存储）
// ==========================================

const TOKEN_KEY = 'atrium_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * 为 SSE 流式接口构建 URL（不含 token）
 * @deprecated 请改用 streamFetch，避免 token 出现在 URL 中被日志/浏览器历史捕获
 * @param {string} url - API 路径（相对于 API_BASE）
 * @returns {string} 完整的 URL
 */
export function buildStreamUrl(url) {
  return `${API_BASE}${url}`;
}

/**
 * 构建完整的流式 URL（含 API_BASE 前缀）
 * @deprecated 请改用 streamFetch
 * @param {string} path - API 路径
 * @returns {string} 完整的 SSE 流式 URL
 */
export function buildFullStreamUrl(path) {
  return `${API_BASE}${path}`;
}

/**
 * 发起流式请求（SSE/fetch streaming），自动携带 Authorization header。
 * token 通过 header 传递，避免出现在 URL query 中被访问日志、浏览器历史捕获。
 * @param {string} path - API 路径（相对于 API_BASE）
 * @param {object} options - fetch 选项
 * @returns {Promise<Response>}
 */
export function streamFetch(path, options = {}) {
  const token = getToken();
  const headers = { ...(options.headers || {}) };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return fetch(`${API_BASE}${path}`, { ...options, headers });
}

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

/**
 * 统一请求封装
 * @param {string} url - API 路径（相对于 API_BASE）
 * @param {object} options - fetch 选项
 * @returns {Promise<object>} 解析后的 JSON 响应
 */
async function request(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  // 自动添加 Authorization header
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(`${API_BASE}${url}`, {
      ...options,
      signal: options.signal || controller.signal,
      headers,
    });

    clearTimeout(timeoutId);

    // 401 未授权：清除 token 并触发重新登录事件
    if (response.status === 401 && token) {
      clearToken();
      window.dispatchEvent(new CustomEvent('auth:401'));
      throw new ApiError('登录已过期，请重新登录', 401, null);
    }

    if (!response.ok) {
      let errorData = null;
      try {
        errorData = await response.json();
      } catch {
        // 响应体非 JSON
      }
      throw new ApiError(
        errorData?.detail || `请求失败 (${response.status})`,
        response.status,
        errorData
      );
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'ApiError') throw error;
    if (error.name === 'AbortError') throw new ApiError('请求超时', 408, null);
    throw new ApiError(`网络错误: ${error.message}`, 0, null);
  }
}

// ==========================================
// 便捷方法（向后兼容保留）
// ==========================================

export const api = {
  get: (url) => request(url),
  post: (url, body) => request(url, { method: 'POST', body: JSON.stringify(body) }),
  put: (url, body) => request(url, { method: 'PUT', body: JSON.stringify(body) }),
  delete: (url) => request(url, { method: 'DELETE' }),

  // ==========================================
  // 模块：auth — 认证相关
  // ==========================================
  auth: {
    /** 登录 */
    async login(username, password) {
      const data = await request('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      if (data.token) {
        setToken(data.token);
      }
      return data;
    },

    /** 注册 */
    async register(username, password) {
      const data = await request('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      if (data.token) {
        setToken(data.token);
      }
      return data;
    },

    /** 获取当前用户信息 */
    getMe() {
      return request('/api/auth/me');
    },

    /** 退出登录（仅清除本地 token） */
    logout() {
      clearToken();
    },
  },

  // ==========================================
  // 模块：diary — 日记相关
  // ==========================================
  diary: {
    /** 获取指定日期的日记 */
    getByDate(dateStr) {
      return request(`/api/diary/date/${dateStr}`);
    },

    /** 获取指定月份的日记列表 */
    getMonth(year, month) {
      return request(`/api/diary/month/${year}/${month}`);
    },

    /** 保存日记 */
    save(payload) {
      return request('/api/diary/save', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },

    /** 更新日记情绪标签 */
    updateEmotion(date, emotion) {
      return request('/api/diary/emotion', {
        method: 'PUT',
        body: JSON.stringify({ date, emotion }),
      });
    },

    /** 触发情绪分类（轻量模型，非阻塞） */
    classifyEmotion(date, content) {
      return request('/api/diary/emotion', {
        method: 'POST',
        body: JSON.stringify({ date, content }),
      });
    },

    /** 触发日记总结（非阻塞） */
    summarize(date, content) {
      return request('/api/diary/summarize', {
        method: 'POST',
        body: JSON.stringify({ date, content }),
      });
    },
  },

  // ==========================================
  // 模块：chat — 共情助手聊天相关
  // ==========================================
  chat: {
    /** 获取指定日期的会话列表 */
    getSessions(date) {
      return request(`/api/chat/sessions?date=${encodeURIComponent(date)}`);
    },

    /** 创建新会话 */
    createSession(date, title = '新对话') {
      return request('/api/chat/sessions', {
        method: 'POST',
        body: JSON.stringify({ date, title }),
      });
    },

    /** 删除会话 */
    deleteSession(sessionId) {
      return request(`/api/chat/sessions/${sessionId}`, {
        method: 'DELETE',
      });
    },

    /** 重命名会话 */
    renameSession(sessionId, title) {
      return request(`/api/chat/sessions/${sessionId}`, {
        method: 'PUT',
        body: JSON.stringify({ title }),
      });
    },

    /** 获取会话的消息列表 */
    getMessages(sessionId) {
      return request(`/api/chat/sessions/${sessionId}/messages`);
    },

    /** 保存单条消息到会话 */
    saveMessage(sessionId, role, content, thinking = '', diaryDate = '') {
      return request(`/api/chat/sessions/${sessionId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ role, content, thinking, diary_date: diaryDate }),
      });
    },

    /** 构建流式聊天 URL（SSE） */
    streamUrl() {
      return buildFullStreamUrl('/api/chat/stream');
    },

    /** 构建流式问候语 URL（SSE，无会话） */
    greetingStreamUrl() {
      return buildFullStreamUrl('/api/chat/greeting/stream');
    },

    /** 构建会话流式问候语 URL（SSE，指定会话） */
    sessionGreetingStreamUrl(sessionId) {
      return buildFullStreamUrl(`/api/chat/sessions/${sessionId}/greeting/stream`);
    },
  },

  // ==========================================
  // 模块：insight — 觉察分析相关
  // ==========================================
  insight: {
    /** 获取最新分析结果 */
    getLatest() {
      return request('/api/insight/latest');
    },

    /** 获取觉察设置 */
    getSettings() {
      return request('/api/insight/settings');
    },

    /** 保存觉察设置 */
    saveSettings(settings) {
      return request('/api/insight/settings', {
        method: 'POST',
        body: JSON.stringify(settings),
      });
    },

    /** 获取历史分析列表 */
    getHistory() {
      return request('/api/insight/history');
    },

    /** 运行一次分析 */
    analyze(days = 30) {
      return request('/api/insight/analyze', {
        method: 'POST',
        body: JSON.stringify({ days }),
      });
    },

    /** 获取指定分析结果详情（含所有支线） */
    getResult(resultId) {
      return request(`/api/insight/result/${resultId}`);
    },

    /** 删除指定分析结果（连同所有支线及对话） */
    deleteResult(resultId) {
      return request(`/api/insight/result/${resultId}`, {
        method: 'DELETE',
      });
    },

    /** 构建支线对话流式 URL（SSE） */
    branchChatStreamUrl(resultId, branchId) {
      return buildFullStreamUrl(`/api/insight/result/${resultId}/branch/${branchId}/chat/stream`);
    },

    /** 生成支线总结 */
    branchSummarize(resultId, branchId) {
      return request(`/api/insight/result/${resultId}/branch/${branchId}/summarize`, {
        method: 'POST',
      });
    },
  },

  // ==========================================
  // 模块：settings — 系统设置相关
  // ==========================================
  settings: {
    /** 获取系统设置 */
    get() {
      return request('/api/settings');
    },

    /** 保存系统设置 */
    save(settings) {
      return request('/api/settings', {
        method: 'POST',
        body: JSON.stringify(settings),
      });
    },

    /** 获取本地模型列表 */
    getLocalModels() {
      return request('/api/settings/local-models');
    },

    /** 获取 AI 人格模板 */
    getEgoTemplates() {
      return request('/api/settings/ego-templates');
    },

    /** 获取记忆沉淀日志 */
    getConsolidationLog() {
      return request('/api/settings/consolidation-log');
    },
  },

  // ==========================================
  // 模块：profile — 用户资料相关
  // ==========================================
  profile: {
    /** 获取用户资料 */
    get() {
      return request('/api/profile');
    },

    /** 更新用户资料 */
    update(data) {
      return request('/api/profile', {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    },

    /** 修改密码 */
    changePassword(oldPassword, newPassword) {
      return request('/api/profile/password', {
        method: 'PUT',
        body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
      });
    },
  },

  // ==========================================
  // 模块：chatroom — 聊天室/NPC 对话相关
  // ==========================================
  chatroom: {
    /** 获取聊天室列表 */
    list() {
      return request('/api/chatrooms');
    },

    /** 获取聊天室详情 */
    get(chatroomId) {
      return request(`/api/chatrooms/${chatroomId}`);
    },

    /** 获取聊天室消息 */
    getMessages(chatroomId) {
      return request(`/api/chatrooms/${chatroomId}/messages`);
    },

    /** 发送消息到聊天室 */
    sendMessage(chatroomId, content) {
      return request(`/api/chatrooms/${chatroomId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      });
    },
  },

  // ==========================================
  // 模块：relationship — 人际关系相关
  // ==========================================
  relationship: {
    /** 获取人际关系列表 */
    list() {
      return request('/api/relationships');
    },

    /** 获取指定人物详情 */
    get(personId) {
      return request(`/api/relationships/${personId}`);
    },

    /** 获取人物时间线 */
    getTimeline(personId) {
      return request(`/api/relationships/${personId}/timeline`);
    },
  },

  // ==========================================
  // 模块：statistics — 统计数据相关
  // ==========================================
  statistics: {
    /** 获取日记统计 */
    diary() {
      return request('/api/statistics/diary');
    },

    /** 获取情绪趋势 */
    emotionTrend(days = 30) {
      return request(`/api/statistics/emotion-trend?days=${days}`);
    },

    /** 获取字数统计 */
    wordCount() {
      return request('/api/statistics/word-count');
    },
  },

  // ==========================================
  // 向后兼容：旧的顶层 auth 方法
  // ==========================================

  /** 登录（向后兼容） */
  async login(username, password) {
    return api.auth.login(username, password);
  },

  /** 注册（向后兼容） */
  async register(username, password) {
    return api.auth.register(username, password);
  },

  /** 获取当前用户信息（向后兼容） */
  getMe() {
    return api.auth.getMe();
  },

  /** 退出登录（向后兼容） */
  logout() {
    return api.auth.logout();
  },
};

/**
 * 安全获取 JSON（静默失败，返回 null）
 * 用于不需要错误提示的查询（如加载可选数据）
 */
export async function safeGet(url) {
  try {
    return await api.get(url);
  } catch {
    return null;
  }
}

export { ApiError };
