# ==========================================
# Atrium OS - 统一模型服务（单一数据源）
# 收敛原先散落在 insight/statistics/relationship/chatroom/empathy_agent 的
# 多份 _call_ollama 与硬编码模型名。
#
# 核心设计：
# 1. 某用户的模型设置通过 contextvars 挂到「当前请求上下文」，并发请求互不干扰，
#    从而消除旧 apply_user_runtime 修改全局变量的跨用户竞态。
# 2. 所有非流式/流式 Ollama 调用统一走 generate / generate_stream，
#    model 缺省时自动读取该账号设置页的主模型。
# ==========================================

import contextvars
import json
import requests
from typing import Iterator, Optional

from server import crypto
from server.logger import logger

# 回退模型（设置缺失时的兜底，与旧版默认一致）
FALLBACK_LOCAL_MODEL = "qwen3.6:27b"
FALLBACK_OPENROUTER_MODEL = "nvidia/nemotron-3-super-120b-a12b:free"

OLLAMA_URL = "http://localhost:11434/api/generate"
OLLAMA_CHAT_URL = "http://localhost:11434/api/chat"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

# 当前请求的模型配置上下文（None 表示未挂载，按 default 用户解析）
_config_ctx: contextvars.ContextVar = contextvars.ContextVar("model_config", default=None)

# 当前请求的用户 id 上下文（与 _config_ctx 一起挂载，供按用户取人设等使用）
_user_id_ctx: contextvars.ContextVar = contextvars.ContextVar("model_user_id", default=None)


def current_user_id(user_id: Optional[str] = None) -> str:
    """返回当前请求上下文中生效的用户 id。优先用上下文（已挂载时），否则按传入/user_id 解析。"""
    uid = _user_id_ctx.get()
    if uid is None:
        uid = user_id or "default"
    return uid


# ========== 配置解析 ==========

def resolve_config(user_id: str = "default") -> dict:
    """读取某用户的模型设置，返回统一配置结构。"""
    from server.app import _load_settings
    s = _load_settings(user_id)
    return {
        "priority": s.get("model_priority", "local"),
        "local_model": s.get("local_model") or FALLBACK_LOCAL_MODEL,
        "openrouter_model": s.get("openrouter_model") or FALLBACK_OPENROUTER_MODEL,
        "openrouter_api_key": crypto.decrypt(s.get("openrouter_api_key", "")),
    }


def set_user_config(user_id: str) -> None:
    """在请求上下文挂载当前用户的模型配置（替代全局 apply_user_runtime 的竞态写法）。"""
    _config_ctx.set(resolve_config(user_id))
    _user_id_ctx.set(user_id)


def current_config(user_id: Optional[str] = None) -> dict:
    """返回当前生效的模型配置。优先用上下文（已挂载时），否则按 user_id 解析。"""
    cfg = _config_ctx.get()
    if cfg is None:
        cfg = resolve_config(user_id or "default")
    return cfg


def use_openrouter(user_id: Optional[str] = None) -> bool:
    return current_config(user_id).get("priority") == "api"


def local_model(user_id: Optional[str] = None) -> str:
    return current_config(user_id).get("local_model") or FALLBACK_LOCAL_MODEL


def openrouter_model(user_id: Optional[str] = None) -> str:
    return current_config(user_id).get("openrouter_model") or FALLBACK_OPENROUTER_MODEL


def openrouter_api_key(user_id: Optional[str] = None) -> str:
    return current_config(user_id).get("openrouter_api_key", "")


# ========== 非流式调用 ==========

def generate(prompt: str, *, user_id: Optional[str] = None, model: Optional[str] = None,
             timeout: int = 300, num_predict: int = 2048, system: Optional[str] = None,
             fmt=None, think: bool = False, temperature: float = 0.4,
             seed: Optional[int] = None) -> str:
    """非流式调用本地 Ollama，返回纯文本。model 缺省时读取该账号主模型。"""
    model = model or local_model(user_id)
    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "think": think,
        "options": {"temperature": temperature, "num_predict": num_predict, "num_ctx": 8192},
    }
    if system:
        payload["system"] = system
    if fmt:
        payload["format"] = fmt
    if seed is not None:
        payload["options"]["seed"] = seed
    resp = requests.post(OLLAMA_URL, json=payload, timeout=timeout)
    resp.raise_for_status()
    return resp.json().get("response", "")


# ========== 流式调用 ==========

def generate_stream(prompt: str, *, user_id: Optional[str] = None, model: Optional[str] = None,
                    system: str = "", think: bool = False, num_predict: int = 2048,
                    temperature: float = 0.6, fmt=None) -> Iterator[dict]:
    """流式调用本地 Ollama，逐 chunk 生成，自动分离 thinking/response。

    yield {"type": "thinking"|"response", "content": str}
    think=False（默认）时，模型输出全部作为 response 输出。
    think=True 时，优先用 Ollama 原生的 thinking 字段，否则手动解析
    「thinking... response」标签。
    """
    model = model or local_model(user_id)
    payload = {
        "model": model,
        "prompt": prompt,
        "system": system,
        "stream": True,
        "think": think,
        "options": {"num_predict": num_predict, "num_ctx": 8192, "temperature": temperature},
    }
    if fmt:
        payload["format"] = fmt

    resp = requests.post(OLLAMA_URL, json=payload, timeout=300, stream=True)
    resp.raise_for_status()

    # think=False：直接逐 token 输出 response
    if not think:
        for line in resp.iter_lines(decode_unicode=True):
            if not line:
                continue
            try:
                chunk = json.loads(line)
            except json.JSONDecodeError:
                continue
            token = chunk.get("response", "")
            if token:
                yield {"type": "response", "content": token}
            if chunk.get("done", False):
                break
        return

    # think=True：状态机 detecting → thinking → response（兼容 Ollama 原生 thinking 与标签解析）
    TAG_OPEN = " thinking"
    TAG_CLOSE = " response"
    THINKING_HEADERS = ["Thinking Process:", "Thinking:", "思考过程:", "思考:", "Let me think", "Let's analyze"]
    BUFFER_THRESHOLD = 50
    state = "detecting"
    raw_buffer = ""

    for line in resp.iter_lines(decode_unicode=True):
        if not line:
            continue
        try:
            chunk = json.loads(line)
        except json.JSONDecodeError:
            continue

        # 1. Ollama 原生分离的 thinking 字段
        if chunk.get("thinking"):
            if state == "detecting":
                state = "response"
            yield {"type": "thinking", "content": chunk["thinking"]}

        raw_resp = chunk.get("response", "")
        if not raw_resp:
            if chunk.get("done", False):
                break
            continue

        if state == "detecting":
            raw_buffer += raw_resp
            stripped = raw_buffer.lstrip()
            if TAG_CLOSE in raw_buffer:
                parts = raw_buffer.split(TAG_CLOSE, 1)
                thinking_text = parts[0].replace(TAG_OPEN, "").strip()
                for h in THINKING_HEADERS:
                    if thinking_text.startswith(h):
                        thinking_text = thinking_text[len(h):].strip()
                        break
                response_text = parts[1].strip() if len(parts) > 1 else ""
                if thinking_text:
                    yield {"type": "thinking", "content": thinking_text}
                if response_text:
                    yield {"type": "response", "content": response_text}
                state = "response"
                raw_buffer = ""
            elif len(raw_buffer) >= BUFFER_THRESHOLD:
                is_thinking = any(stripped.startswith(h) for h in THINKING_HEADERS) or stripped.startswith(TAG_OPEN)
                if is_thinking:
                    thinking_text = stripped
                    for h in THINKING_HEADERS:
                        if thinking_text.startswith(h):
                            thinking_text = thinking_text[len(h):].strip()
                            break
                    if thinking_text.startswith(TAG_OPEN):
                        thinking_text = thinking_text[len(TAG_OPEN):].strip()
                    if thinking_text:
                        yield {"type": "thinking", "content": thinking_text}
                    state = "thinking"
                    raw_buffer = ""
                else:
                    yield {"type": "response", "content": raw_buffer}
                    state = "response"
                    raw_buffer = ""
        elif state == "thinking":
            if TAG_CLOSE in raw_resp:
                parts = raw_resp.split(TAG_CLOSE, 1)
                if parts[0]:
                    yield {"type": "thinking", "content": parts[0]}
                if len(parts) > 1 and parts[1].strip():
                    yield {"type": "response", "content": parts[1].strip()}
                state = "response"
            else:
                yield {"type": "thinking", "content": raw_resp}
        elif state == "response":
            yield {"type": "response", "content": raw_resp}

        if chunk.get("done", False):
            if raw_buffer and state == "detecting":
                yield {"type": "response", "content": raw_buffer}
            break


# ========== 工具调用（function calling）==========

def chat_tools(messages, *, user_id: Optional[str] = None, model: Optional[str] = None,
               tools: Optional[list] = None, num_predict: int = 512,
               temperature: float = 0.4, timeout: int = 120) -> dict:
    """调用本地 Ollama /api/chat，原生支持工具调用（function calling）。

    返回完整响应 dict，调用方需读取 message.tool_calls 判断模型是否请求调用工具。
    仅支持本地 Ollama（OpenRouter 走 OpenAI 兼容接口，暂不在这里处理）。
    """
    model = model or local_model(user_id)
    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
        "options": {"num_predict": num_predict, "num_ctx": 8192, "temperature": temperature},
    }
    if tools:
        payload["tools"] = tools
    resp = requests.post(OLLAMA_CHAT_URL, json=payload, timeout=timeout)
    resp.raise_for_status()
    return resp.json()


def chat_tools_stream(messages, *, user_id: Optional[str] = None, model: Optional[str] = None,
                      tools: Optional[list] = None, think: bool = False,
                      num_predict: int = 2048, temperature: float = 0.6,
                      timeout: int = 300):
    """流式调用本地 Ollama /api/chat，原生支持工具调用 + 思考分离。

    与 generate_stream 不同，这里走 /api/chat（支持 tools），从而让模型在
    同一个流式请求里自行决定是直接回答还是调用工具（即"单次流式决策"）。

    yield 类型：
      - {"type":"response","content":str}   # 回复内容 token
      - {"type":"thinking","content":str}   # 思考内容（think=True 且模型原生分离）
      - {"type":"tool_call","name":str,"arguments":str}  # 模型请求调用工具（出现即停止输出内容）
    """
    model = model or local_model(user_id)
    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "think": think,
        "options": {"num_predict": num_predict, "num_ctx": 8192, "temperature": temperature},
    }
    if tools:
        payload["tools"] = tools
    resp = requests.post(OLLAMA_CHAT_URL, json=payload, timeout=timeout, stream=True)
    resp.raise_for_status()

    pending_tool = None
    for line in resp.iter_lines(decode_unicode=True):
        if not line:
            continue
        try:
            chunk = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg = chunk.get("message", {}) or {}

        # 原生思考分离
        if msg.get("thinking"):
            yield {"type": "thinking", "content": msg["thinking"]}

        # 工具调用（参数可能跨 chunk 增量到达，累积；一旦出现即停止输出内容）
        for tc in msg.get("tool_calls") or []:
            fn = tc.get("function", {}) if isinstance(tc, dict) else {}
            name = fn.get("name", "")
            args = fn.get("arguments", "")
            if pending_tool and pending_tool["name"] == name:
                pending_tool["arguments"] += args
            else:
                pending_tool = {"name": name, "arguments": args}

        # 出现工具调用后不再输出内容，避免把工具调用后的多余文本当回答
        content = msg.get("content", "")
        if content and not pending_tool:
            yield {"type": "response", "content": content}

        if chunk.get("done", False):
            break

    if pending_tool:
        yield {"type": "tool_call", "name": pending_tool["name"], "arguments": pending_tool["arguments"]}