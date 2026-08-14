/**
 * local/settings.ts — 手机端本地设置服务（Phase 5）
 *
 * 与 api/settings.ts 保持相同签名，内部改用：
 *  - core/modelService.ts 的本地模型配置存储 + Ollama 地址
 *  - core/utils/webSearch.ts 的 SearXNG 地址
 *  - 本地 Ollama /api/tags 查询模型列表
 */

import {
  currentConfig,
  saveModelConfig,
  refreshConfig,
  setOllamaBaseUrl,
  normalizeOllamaUrl,
  FALLBACK_LOCAL_MODEL,
  FALLBACK_OPENROUTER_MODEL,
  OPENROUTER_URL,
} from '../core/modelService';
import { setSearxngBaseUrl, getSearxngBaseUrl } from '../core/utils/webSearch';
import { getDiaryStorage } from '../core/db/diaryDb';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

/** 本地设置键（session 模式等） */
const SESSION_MODE_KEY = 'atrium_session_mode';

/**
 * 读取本地设置（含模型配置）。返回结构与后端 /api/settings 兼容。
 */
export async function getSettings(): Promise<any> {
  const cfg = await currentConfig();
  return {
    model_priority: cfg.priority,
    local_model: cfg.localModel,
    openrouter_model: cfg.openrouterModel,
    openrouter_api_key: cfg.openrouterApiKey ? '****' : '', // 脱敏
    searxng_base_url: getSearxngBaseUrl(),
    ollama_base_url: await getOllamaBaseUrl(),
  };
}

/**
 * 更新本地设置。识别 model_* 字段并持久化到本地 AsyncStorage。
 */
export async function updateSettings(settings: any): Promise<any> {
  if (settings && typeof settings === 'object') {
    const cfg = await currentConfig();
    const next: typeof cfg = {
      priority: settings.model_priority === 'api' ? 'api' : 'local',
      localModel: settings.local_model || cfg.localModel || FALLBACK_LOCAL_MODEL,
      openrouterModel: settings.openrouter_model || cfg.openrouterModel || FALLBACK_OPENROUTER_MODEL,
      openrouterApiKey: settings.openrouter_api_key || cfg.openrouterApiKey,
    };
    await saveModelConfig(next);
    await refreshConfig();
    if (settings.ollama_base_url) {
      setOllamaBaseUrl(settings.ollama_base_url);
    }
    if (settings.searxng_base_url) {
      setSearxngBaseUrl(settings.searxng_base_url);
    }
    if (settings.ollama_base_url || settings.searxng_base_url) {
      // 地址类配置也持久化
      try {
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        if (settings.ollama_base_url) {
          await AsyncStorage.setItem('atrium_ollama_base_url', settings.ollama_base_url);
        }
        if (settings.searxng_base_url) {
          await AsyncStorage.setItem('atrium_searxng_base_url', settings.searxng_base_url);
        }
      } catch {
        // 忽略持久化失败
      }
    }
  }
  return { success: true };
}

/** 查询本地 Ollama 模型列表（/api/tags） */
export async function getLocalModels(): Promise<any> {
  try {
    const baseUrl = await getOllamaBaseUrl();
    const resp = await fetch(`${baseUrl}/api/tags`, { method: 'GET' });
    if (!resp.ok) {
      return { available: false, error: `Ollama HTTP ${resp.status}`, models: [] };
    }
    const data = await resp.json();
    const models = (data.models || []).map((m: any) => ({
      name: m.name,
      family: m.details?.family || '',
      size: m.size || 0,
    }));
    return { available: true, models, error: null };
  } catch (e: any) {
    return { available: false, error: e?.message || '无法连接 Ollama', models: [] };
  }
}

/**
 * 连接测试（快速版）：用表单当前输入值向模型服务发一个最小请求，
 * 校验能否正常请求到模型服务。不修改任何已保存配置。
 *  - 本地 Ollama：GET /api/tags，仅校验服务连通 + 目标模型存在（毫秒级，不加载模型）
 *  - 远程 API：POST /chat/completions，max_tokens=1 的最小生成请求
 */
export async function testModelConnection(params: {
  modelPriority: string;
  ollamaBaseUrl: string;
  mainModel: string;
  apiModel: string;
  apiKey: string;
}): Promise<{ success: boolean; message: string }> {
  if (params.modelPriority === 'local') {
    const raw = (params.ollamaBaseUrl || '').trim();
    if (!raw) return { success: false, message: '请填写 Ollama 地址' };
    const baseUrl = normalizeOllamaUrl(raw);
    try {
      // 快速连通性检查：/api/tags 不触发模型加载，瞬时返回
      const resp = await fetch(`${baseUrl}/api/tags`, { method: 'GET' });
      if (!resp.ok) return { success: false, message: `无法连接 Ollama（HTTP ${resp.status}）` };
      const data = await resp.json();
      const names = (data?.models || []).map((m: any) => String(m?.name || ''));
      if (!params.mainModel) return { success: false, message: '请选择主模型' };
      // 校验目标模型是否在列表中（兼容 name 与 name:tag 两种形态）
      const norm = params.mainModel.split(':')[0];
      const exists = names.some((n: string) => n === params.mainModel || n.split(':')[0] === norm);
      return exists
        ? { success: true, message: '连接正常，模型可用' }
        : { success: false, message: `服务连通，但未找到模型「${params.mainModel}」，请点「刷新」确认` };
    } catch (e: any) {
      return { success: false, message: e?.message || '无法连接 Ollama' };
    }
  }

  // 远程 API（OpenAI 兼容接口，如 OpenRouter）：max_tokens=1 的最小生成
  const model = (params.apiModel || '').trim();
  const apiKey = (params.apiKey || '').trim();
  if (!model) return { success: false, message: '请填写模型名称' };
  if (!apiKey) return { success: false, message: '请填写 API Key' };
  try {
    const resp = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
    });
    if (!resp.ok) return { success: false, message: `API HTTP ${resp.status}` };
    return { success: true, message: '连接正常，API 可响应' };
  } catch (e: any) {
    return { success: false, message: e?.message || '无法连接远程 API' };
  }
}

/**
 * SearXNG 搜索服务连通性测试：向 /search 发一个最小 JSON 请求，
 * 校验能否正常返回结果。不修改任何已保存配置。
 */
export async function testWebSearchConnection(searxngBaseUrl: string): Promise<{ success: boolean; message: string }> {
  const raw = (searxngBaseUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return { success: false, message: '请填写搜索服务地址（SearXNG）' };
  try {
    const url = `${raw}/search?q=test&format=json`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
      const resp = await fetch(url, { method: 'GET', signal: controller.signal });
      if (!resp.ok) return { success: false, message: `无法连接搜索服务（HTTP ${resp.status}）` };
      const data = await resp.json();
      const count = Array.isArray(data?.results) ? data.results.length : 0;
      return count > 0
        ? { success: true, message: `搜索服务正常，返回 ${count} 条结果` }
        : { success: true, message: '搜索服务可连通，但未返回结果' };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      return { success: false, message: '搜索服务连接超时（10 秒未响应）' };
    }
    return { success: false, message: e?.message || '无法连接搜索服务' };
  }
}

/**
 * 导出全部日记为 JSON 文件，并弹出系统分享面板。
 * 生成的文件为 atrium_diaries_YYYY-MM-DD.json，包含元信息与每篇日记的完整字段。
 */
export async function exportDiaries(userId: string = 'default'): Promise<{ success: boolean; message: string; count?: number }> {
  try {
    const diaries = getDiaryStorage().getAllDiaries(userId);
    if (!diaries || !diaries.length) {
      return { success: false, message: '暂无日记可导出' };
    }
    const payload = {
      app: 'Atrium OS',
      exported_at: new Date().toISOString(),
      count: diaries.length,
      diaries: diaries.map((d) => ({
        date: d.date,
        content: d.content,
        weather: d.weather,
        tags: d.tags,
        messages: d.messages,
        created_at: d.created_at,
        updated_at: d.updated_at,
      })),
    };
    const json = JSON.stringify(payload, null, 2);
    const dateStr = new Date().toISOString().slice(0, 10);
    const fileName = `atrium_diaries_${dateStr}.json`;

    const file = new File(Paths.cache, fileName);
    if (file.exists) file.delete();
    file.create({ overwrite: true });
    file.write(json);

    if (!(await Sharing.isAvailableAsync())) {
      return { success: false, message: '当前设备不支持分享，请换用其他方式导出' };
    }
    await Sharing.shareAsync(file.uri, {
      mimeType: 'application/json',
      dialogTitle: '导出日记',
    });
    return { success: true, message: `已导出 ${diaries.length} 篇日记`, count: diaries.length };
  } catch (e: any) {
    return { success: false, message: e?.message || '导出失败' };
  }
}

/** ego 模板（本地静态模板，与后端默认一致） */
export async function getEgoTemplates(): Promise<any> {
  return {
    templates: [
      {
        key: 'warm',
        label: '温暖长辈',
        ego: '你是一个温暖、包容、爱操心的长辈，常常不自觉地关心用户的起居和健康，偶尔有点唠叨。',
      },
      {
        key: 'friend',
        label: '同龄损友',
        ego: '你是一个幽默、嘴贱但重义气的同龄朋友，喜欢开用户玩笑，但关键时刻很靠谱。',
      },
      {
        key: 'mentor',
        label: '理性导师',
        ego: '你是一个理性、冷静、逻辑清晰的导师，习惯用提问引导用户自己思考，很少直接给答案。',
      },
    ],
  };
}

/** 从持久化读取 Ollama 地址（默认本机） */
async function getOllamaBaseUrl(): Promise<string> {
  try {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    return (await AsyncStorage.getItem('atrium_ollama_base_url')) || 'http://127.0.0.1:11434';
  } catch {
    return 'http://127.0.0.1:11434';
  }
}

/** 快捷：读取 session 模式（chatroom/单聊） */
export async function getSessionMode(): Promise<string> {
  try {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    return (await AsyncStorage.getItem(SESSION_MODE_KEY)) || 'single';
  } catch {
    return 'single';
  }
}

export async function setSessionMode(mode: string): Promise<void> {
  try {
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    await AsyncStorage.setItem(SESSION_MODE_KEY, mode || 'single');
  } catch {
    // 忽略
  }
}