# ==========================================
# Atrium OS - 聊天路由
# ==========================================

import json
import asyncio
import base64
import re
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from server.app import get_agent, get_diary_storage, apply_user_runtime
from server.auth import get_current_user
from server.chat_utils import build_unified_history
from server.logger import logger

router = APIRouter()


# ==========================================
# 图片输入校验（仅工作台对话页支持传图）
# 通过文件头魔数确认是 LLM 可辨识的真实图片（JPEG/PNG/GIF/WebP），
# 其它格式（SVG、HEIC、BMP 等）或损坏的 base64 一律滤除，避免把
# 大模型无法辨识的格式或恶意内容传给视觉模型。
# ==========================================
_IMG_MAGIC = [
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"RIFF", "image/webp"),  # 需进一步校验 WEBP 标记
]
_WEBP_FOOT = b"WEBP"


def _strip_data_uri(data) -> str:
    """解析 data URI 或裸 base64，返回裸 base64 字符串。非字符串输入返回空串。"""
    if not isinstance(data, str):
        return ""
    s = data.strip()
    m = re.match(r"^data:([^;]+);base64,(.+)$", s, re.S)
    if m:
        return m.group(2).strip()
    # 去掉可能的空白，直接当作裸 base64
    return s


def _detect_image_mime(raw: bytes):
    """根据魔数识别图片格式，返回 MIME；无法识别返回 None。"""
    for magic, mime in _IMG_MAGIC:
        if raw.startswith(magic):
            if mime == "image/webp":
                # WebP 结构：'RIFF' + 大小(4字节) + 'WEBP'
                if len(raw) >= 12 and raw[8:12] == _WEBP_FOOT:
                    return mime
                return None
            return mime
    return None


def filter_valid_images(images) -> List[str]:
    """过滤输入，仅保留真实可辨识的图片，统一转成裸 base64 供 Ollama 使用。

    入参支持：list[str]（data URI 或裸 base64）。非图片/损坏数据自动剔除。
    返回空列表表示无有效图片（此时走纯文本路径）。
    """
    if not images:
        return []
    if not isinstance(images, list):
        return []
    valid = []
    for item in images:
        b64 = _strip_data_uri(item)
        if not b64:
            continue
        try:
            raw = base64.b64decode(b64, validate=True)
        except (ValueError, base64.binascii.Error):
            continue
        if not raw:
            continue
        if _detect_image_mime(raw) is None:
            continue
        # 长度保护：单图过大（>8MB）会撑爆上下文，直接滤除
        if len(raw) > 8 * 1024 * 1024:
            continue
        valid.append(b64)
    return valid


class ChatRequest(BaseModel):
    message: str
    user_name: str = "Me"
    date: Optional[str] = None
    session_id: Optional[str] = None
    mode: str = "empathy"  # "empathy" | "awareness"
    extra_context: Optional[str] = None  # 外部页面注入的额外上下文（如关系档案）
    inject_diary: bool = True  # 是否注入指定日期的日记作为上下文（关系/觉察页等非日记场景传 false）
    history_limit: Optional[int] = None  # 图表对话空间传入 30：只喂最近 N 条
    enable_web_search: bool = True  # 是否启用联网搜索（AI 自主判断是否需要搜索）
    images: Optional[List[str]] = None  # 仅工作台对话页传入的图片（base64），其余页面不传此字段

class GreetingRequest(BaseModel):
    date: str
    session_id: Optional[str] = None

class TriggerGreetingRequest(BaseModel):
    date: str
    session_id: str

class CreateSessionRequest(BaseModel):
    date: str
    title: str = "新对话"

class UpdateSessionRequest(BaseModel):
    title: str = None


# ==========================================
# 后台流式问候
# 保存日记后触发，问候在后台逐 token 生成并记录到内存流，
# 用户进入聊天页时通过订阅接口实时看到流式输出。
# ==========================================

# session_id -> {"messages": [{type, content}], "done": bool}
ACTIVE_GREETINGS = {}


def _require_session_access(diary_storage, session_id: str, user_id: str) -> None:
    """会话归属校验：确认 session_id 属于当前登录用户，否则按 404 拒绝。

    基于安全最佳实践（IDOR 防护）：按 session_id 定位资源的操作，
    必须先校验该资源属于当前用户，避免跨用户越权读取/写入/删除。
    返回 404 而非 403，避免向攻击者确认"会话存在但无权"。
    """
    if not session_id:
        return
    owner = diary_storage.get_session_owner(session_id)
    if owner is None or owner != user_id:
        raise HTTPException(status_code=404, detail="会话不存在")


def _start_greeting_background(date: str, session_id: str, agent, diary_storage, user_id: str):
    """后台线程生成问候：逐 token 写入内存流，完成后一次性写入会话库"""
    from server.background import submit_background

    existing = ACTIVE_GREETINGS.get(session_id)
    if existing and not existing["done"]:
        return existing  # 已有进行中的流，复用

    record = {"messages": [], "done": False}
    ACTIVE_GREETINGS[session_id] = record

    def _run():
        try:
            # 应用该账号的模型设置到运行时，保证问候语用对模型
            apply_user_runtime(user_id)
            diary = diary_storage.get_diary_by_date(date, user_id=user_id)
            if not diary or not diary.content:
                return
            ai_reply = ""
            ai_thinking = ""
            for chunk in agent.greeting_stream(diary.content, date):
                if chunk.get("type") == "response":
                    content = chunk.get("content", "")
                    ai_reply += content
                    record["messages"].append({"type": "response", "content": content})
                elif chunk.get("type") == "thinking":
                    content = chunk.get("content", "")
                    ai_thinking += content
                    record["messages"].append({"type": "thinking", "content": content})
            # 完成后写入会话库
            if ai_reply:
                diary_date_label = ""
                if date:
                    parts = date.split("-")
                    if len(parts) == 3:
                        diary_date_label = f"{parts[0][2:]}年{parts[1]}月{parts[2]}日"
                diary_storage.add_message(session_id, "assistant", ai_reply, ai_thinking, diary_date_label)
                logger.info(f"✅ 问候语已保存到会话 {session_id[:8]}...")
            # 问候完成后触发用户档案更新
            from .profile_routes import regenerate_profile_async
            regenerate_profile_async(diary_storage, agent, user_id)
        except Exception as e:
            logger.error(f"后台问候生成失败: {e}")
        finally:
            record["done"] = True

    submit_background(_run)
    return record


@router.post("/api/chat/greeting/async")
async def trigger_greeting(request: TriggerGreetingRequest,
                           agent=Depends(get_agent),
                           diary_storage=Depends(get_diary_storage),
                           current_user: dict = Depends(get_current_user)):
    """触发后台流式问候生成，立即返回（不阻塞保存流程）"""
    _start_greeting_background(request.date, request.session_id, agent, diary_storage, current_user["id"])
    return {"started": True}


@router.get("/api/chat/greeting/subscribe")
async def subscribe_greeting(session_id: str,
                             diary_storage=Depends(get_diary_storage),
                             current_user: dict = Depends(get_current_user)):
    """SSE 订阅进行中的问候流：从当前已生成位置开始，实时推送后续 token"""
    import asyncio

    # 认证 + 归属校验：确认该会话属于当前用户，防止未授权监听他人问候流
    _require_session_access(diary_storage, session_id, current_user["id"])

    record = ACTIVE_GREETINGS.get(session_id)

    async def gen():
        # 无进行中的问候流，或问候流已全部生成并写入会话库（前端已能从数据库读取）
        # 此时直接结束，避免把已保存的问候语从头重放一遍导致重复
        if not record or record["done"]:
            yield "data: [DONE]\n\n"
            return
        sent = 0
        while True:
            msgs = record["messages"]
            while sent < len(msgs):
                m = msgs[sent]
                sent += 1
                yield f"data: {json.dumps({'type': m['type'], 'content': m['content']}, ensure_ascii=False)}\n\n"
            if record["done"]:
                break
            # 心跳，保持连接存活
            yield "data: {}\n\n"
            await asyncio.sleep(0.3)
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )


@router.post("/api/chat")
async def chat_endpoint(request: ChatRequest,
                        agent=Depends(get_agent),
                        diary_storage=Depends(get_diary_storage),
                        current_user: dict = Depends(get_current_user)):
    """核心聊天接口（非流式，兼容旧版）"""
    logger.info(f"收到前端请求: {request.message}")
    # 应用当前账号的模型设置到运行时
    apply_user_runtime(current_user["id"])

    diary_context = ""
    if request.date and request.inject_diary:
        diary = diary_storage.get_diary_by_date(request.date, user_id=current_user["id"])
        if diary and diary.content:
            # 工作台聊天页：单篇日记，直接把含图片的原始 HTML 一并送入上下文，
            # 让模型能看到日记中的图片（无需担心文件量）
            diary_context = diary.content

    result = await asyncio.to_thread(agent.chat, request.message, request.user_name, diary_context)

    if isinstance(result, dict):
        reply_text = result.get("response", "")
        thinking = result.get("thinking", "")
    else:
        reply_text = str(result)
        thinking = ""

    return {"reply": reply_text, "thinking": thinking}


@router.post("/api/chat/stream")
async def chat_stream_endpoint(request: ChatRequest,
                               agent=Depends(get_agent),
                               diary_storage=Depends(get_diary_storage),
                               current_user: dict = Depends(get_current_user)):
    """流式聊天接口 (SSE)：逐 token 输出，实时渲染"""
    import asyncio
    # 应用当前账号的模型设置到运行时
    apply_user_runtime(current_user["id"])

    diary_context = ""
    if request.date and request.inject_diary:
        diary = diary_storage.get_diary_by_date(request.date, user_id=current_user["id"])
        if diary and diary.content:
            # 工作台聊天页：单篇日记，直接把含图片的原始 HTML 一并送入上下文
            diary_context = diary.content

    # 会话上下文：统一格式 history_text
    session_context = None
    if request.session_id:
        _require_session_access(diary_storage, request.session_id, current_user["id"])
        session_context = build_unified_history(request.session_id, diary_storage, max_messages=request.history_limit)

    # 图片输入：仅工作台对话页支持。魔数校验过滤掉非真实图片/损坏数据，
    # 其余页面不传 images 字段，天然走纯文本路径。
    valid_images = filter_valid_images(request.images)
    if valid_images:
        logger.info(f"🖼️ 收到 {len(valid_images)} 张有效图片（已过滤无效图片）")

    # 获取互动模式（在 sync_producer 定义前计算，供闭包访问）
    interaction_mode = ""
    try:
        from server.routes.profile_routes import get_interaction_mode
        im_key = "empathy" if request.mode == "empathy" else "awareness"
        interaction_mode = get_interaction_mode(diary_storage, current_user["id"], im_key)
    except Exception as e:
        logger.warning(f"⚠️ 获取互动模式失败: {e}")

    logger.info(f"📡 流式聊天: {request.message[:50]}...  session={request.session_id}  user={current_user['username']}")

    queue = asyncio.Queue()

    def sync_producer():
        """在线程池中运行同步 generator，每拿到一个 chunk 立即放入队列"""
        ai_reply = ""
        ai_thinking = ""
        search_sources = []
        try:
            for chunk in agent.chat_stream(
                request.message, request.user_name, diary_context,
                diary_date=request.date or "",
                history_text=session_context,
                mode=request.mode,
                extra_context=request.extra_context,
                interaction_mode=interaction_mode,
                enable_web_search=request.enable_web_search,
                images=valid_images if valid_images else None
            ):
                if chunk.get("type") == "response":
                    ai_reply += chunk.get("content", "")
                elif chunk.get("type") == "thinking":
                    ai_thinking += chunk.get("content", "")
                elif chunk.get("type") == "replace_response":
                    ai_reply = chunk.get("content", "")
                elif chunk.get("type") == "search_done":
                    # 捕获搜索结果来源，供角标引用
                    results = chunk.get("results") or []
                    if results:
                        search_sources = [
                            {"index": i + 1, "title": r.get("title", ""), "url": r.get("url", "")}
                            for i, r in enumerate(results)
                        ]
                data = json.dumps(chunk, ensure_ascii=False)
                try:
                    queue.put_nowait(f"data: {data}\n\n")
                except asyncio.QueueFull:
                    pass
        except Exception as e:
            logger.error(f"流式输出异常: {e}")
            try:
                queue.put_nowait(f"data: {json.dumps({'type': 'response', 'content': '（连接异常）'}, ensure_ascii=False)}\n\n")
            except asyncio.QueueFull:
                pass
        finally:
            # 流式完成后自动保存消息到会话数据库
            if request.session_id and ai_reply:
                try:
                    diary_date_label = ""
                    if request.date:
                        parts = request.date.split("-")
                        if len(parts) == 3:
                            diary_date_label = f"{parts[0][2:]}年{parts[1]}月{parts[2]}日"
                    # 觉察助手模式保存为 insight 角色，共情助手保存为 assistant
                    assistant_role = "insight" if request.mode == "awareness" else "assistant"
                    # 用户消息附带图片（仅工作台对话页），持久化到会话库，刷新后仍可显示
                    diary_storage.add_message(
                        request.session_id, "user", request.message, "", diary_date_label,
                        images=json.dumps(valid_images, ensure_ascii=False) if valid_images else "",
                    )
                    diary_storage.add_message(
                        request.session_id, assistant_role, ai_reply, ai_thinking, diary_date_label,
                        search_sources=json.dumps(search_sources, ensure_ascii=False),
                    )
                    logger.info(f"✅ 消息已保存到会话 {request.session_id[:8]}... (mode={request.mode})")
                except Exception as e:
                    logger.error(f"⚠️ 保存消息到会话失败: {e}")
            try:
                queue.put_nowait("data: [DONE]\n\n")
            except asyncio.QueueFull:
                pass

    async def generate():
        loop = asyncio.get_event_loop()
        loop.run_in_executor(None, sync_producer)
        while True:
            item = await queue.get()
            yield item
            if item == "data: [DONE]\n\n":
                break

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )


@router.post("/api/chat/greeting")
async def greeting_endpoint(request: GreetingRequest,
                            agent=Depends(get_agent),
                            diary_storage=Depends(get_diary_storage),
                            current_user: dict = Depends(get_current_user)):
    """保存日记后，生成问候语（非流式，兼容旧版）"""
    apply_user_runtime(current_user["id"])
    diary = diary_storage.get_diary_by_date(request.date, user_id=current_user["id"])
    if not diary or not diary.content:
        return {"reply": "今天还没写日记呢，想聊聊吗？", "thinking": ""}

    result = await asyncio.to_thread(agent.greeting, diary.content, request.date)

    if isinstance(result, dict):
        reply = result.get("response", "")
        thinking = result.get("thinking", "")
    else:
        reply = str(result)
        thinking = ""

    # 如果有 session_id，将问候语保存到会话
    if request.session_id and reply:
        try:
            diary_date_label = ""
            if request.date:
                parts = request.date.split("-")
                if len(parts) == 3:
                    diary_date_label = f"{parts[0][2:]}年{parts[1]}月{parts[2]}日"
            diary_storage.add_message(request.session_id, "assistant", reply, thinking, diary_date_label)
            logger.info(f"✅ 问候语已保存到会话 {request.session_id[:8]}...")
        except Exception as e:
            logger.error(f"⚠️ 保存问候语到会话失败: {e}")

    return {"reply": reply, "thinking": thinking}


@router.post("/api/chat/greeting/stream")
async def greeting_stream_endpoint(request: GreetingRequest,
                                   agent=Depends(get_agent),
                                   diary_storage=Depends(get_diary_storage),
                                   current_user: dict = Depends(get_current_user)):
    """流式问候接口 (SSE)：逐 token 输出"""
    import asyncio
    apply_user_runtime(current_user["id"])

    diary = diary_storage.get_diary_by_date(request.date, user_id=current_user["id"])
    if not diary or not diary.content:
        async def empty():
            yield f"data: {json.dumps({'type': 'response', 'content': '今天还没写日记呢，想聊聊吗？'}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(empty(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"})

    logger.info(f"📡 流式问候: diary={len(diary.content)} chars")

    queue = asyncio.Queue()

    def sync_producer():
        ai_reply = ""
        ai_thinking = ""
        try:
            for chunk in agent.greeting_stream(diary.content, request.date):
                if chunk.get("type") == "response":
                    ai_reply += chunk.get("content", "")
                elif chunk.get("type") == "thinking":
                    ai_thinking += chunk.get("content", "")
                data = json.dumps(chunk, ensure_ascii=False)
                try:
                    queue.put_nowait(f"data: {data}\n\n")
                except asyncio.QueueFull:
                    pass
        except Exception as e:
            logger.error(f"流式问候异常: {e}")
            try:
                queue.put_nowait(f"data: {json.dumps({'type': 'response', 'content': '（连接异常）'}, ensure_ascii=False)}\n\n")
            except asyncio.QueueFull:
                pass
        finally:
            # 保存问候语到会话数据库
            if request.session_id and ai_reply:
                try:
                    diary_date_label = ""
                    if request.date:
                        parts = request.date.split("-")
                        if len(parts) == 3:
                            diary_date_label = f"{parts[0][2:]}年{parts[1]}月{parts[2]}日"
                    diary_storage.add_message(request.session_id, "assistant", ai_reply, ai_thinking, diary_date_label)
                    logger.info(f"✅ 问候语已保存到会话 {request.session_id[:8]}...")
                except Exception as e:
                    logger.error(f"⚠️ 保存问候语到会话失败: {e}")
            try:
                queue.put_nowait("data: [DONE]\n\n")
            except asyncio.QueueFull:
                pass
            # 问候完成后异步触发用户档案更新
            from .profile_routes import regenerate_profile_async
            regenerate_profile_async(diary_storage, agent, current_user["id"])

    async def generate():
        loop = asyncio.get_event_loop()
        loop.run_in_executor(None, sync_producer)
        while True:
            item = await queue.get()
            yield item
            if item == "data: [DONE]\n\n":
                break

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"}
    )


# ==========================================
# 联网搜索诊断接口（验证 SearXNG 是否可用）
# ==========================================

class WebSearchRequest(BaseModel):
    query: str


@router.post("/api/chat/web/search")
async def web_search_endpoint(request: WebSearchRequest,
                              current_user: dict = Depends(get_current_user)):
    """直接调用 SearXNG 搜索，返回结果（用于验证部署与排障）"""
    from server.web_search_tool import web_search, SEARXNG_BASE_URL
    results = web_search(request.query, max_results=5)
    return {"success": bool(results), "searxng_base_url": SEARXNG_BASE_URL, "results": results}


@router.get("/api/chat/history")
async def chat_history_endpoint(agent=Depends(get_agent),
                                diary_storage=Depends(get_diary_storage),
                                current_user: dict = Depends(get_current_user)):
    """获取最近对话历史（兼容旧接口，返回默认会话或最新会话的消息）"""
    history = agent.get_chat_history(limit=50)
    return {"messages": history}


# ==========================================
# 会话管理 API
# ==========================================

@router.get("/api/chat/sessions")
async def list_sessions(date: str = None,
                        diary_storage=Depends(get_diary_storage),
                        current_user: dict = Depends(get_current_user)):
    """获取指定日期的所有会话"""
    if not date:
        return {"sessions": []}
    sessions = diary_storage.get_sessions_by_date(date, user_id=current_user["id"])
    return {"sessions": sessions}


@router.get("/api/chat/sessions/by-title")
async def get_session_by_title_endpoint(title: str,
                                        diary_storage=Depends(get_diary_storage),
                                        current_user: dict = Depends(get_current_user)):
    """按标题查找会话"""
    session = diary_storage.get_session_by_title(title, user_id=current_user["id"])
    return {"session": session}


@router.post("/api/chat/sessions")
async def create_session(request: CreateSessionRequest,
                         diary_storage=Depends(get_diary_storage),
                         current_user: dict = Depends(get_current_user)):
    """创建新会话"""
    session = diary_storage.create_session(request.date, request.title, user_id=current_user["id"])
    return {"session": session}


@router.put("/api/chat/sessions/{session_id}")
async def update_session(session_id: str, request: UpdateSessionRequest,
                         diary_storage=Depends(get_diary_storage),
                         current_user: dict = Depends(get_current_user)):
    """更新会话标题"""
    _require_session_access(diary_storage, session_id, current_user["id"])
    ok = diary_storage.update_session(session_id, request.title)
    return {"status": "ok" if ok else "not_found"}


@router.delete("/api/chat/sessions/{session_id}")
async def delete_session(session_id: str,
                         diary_storage=Depends(get_diary_storage),
                         current_user: dict = Depends(get_current_user)):
    """删除会话"""
    _require_session_access(diary_storage, session_id, current_user["id"])
    ok = diary_storage.delete_session(session_id)
    return {"status": "ok" if ok else "not_found"}


@router.get("/api/chat/sessions/{session_id}/messages")
async def get_session_messages(session_id: str,
                               diary_storage=Depends(get_diary_storage),
                               current_user: dict = Depends(get_current_user)):
    """获取会话消息"""
    _require_session_access(diary_storage, session_id, current_user["id"])
    messages = diary_storage.get_messages(session_id)
    # 格式化消息，兼容前端格式
    formatted = []
    for m in messages:
        formatted.append({
            "role": m["role"],
            "content": m["content"],
            "thinking": m.get("thinking", ""),
            "diaryDate": m.get("diary_date", ""),
            "timestamp": m.get("timestamp", 0) * 1000,
            "sources": m.get("sources", []),
            "images": m.get("images", []),
        })
    return {"messages": formatted}


class SaveMessageRequest(BaseModel):
    role: str
    content: str
    thinking: str = ""
    diary_date: str = ""


@router.post("/api/chat/sessions/{session_id}/messages")
async def save_session_message(session_id: str, request: SaveMessageRequest,
                               diary_storage=Depends(get_diary_storage),
                               current_user: dict = Depends(get_current_user)):
    """保存消息到会话"""
    _require_session_access(diary_storage, session_id, current_user["id"])
    msg = diary_storage.add_message(session_id, request.role, request.content, request.thinking, request.diary_date)
    return {"status": "ok", "message": msg}


@router.post("/api/chat/sessions/{session_id}/greeting/stream")
async def session_greeting_stream(session_id: str, request: GreetingRequest,
                                   agent=Depends(get_agent),
                                   diary_storage=Depends(get_diary_storage),
                                   current_user: dict = Depends(get_current_user)):
    """流式问候：保存日记后，为指定会话生成问候语"""
    import asyncio
    apply_user_runtime(current_user["id"])
    _require_session_access(diary_storage, session_id, current_user["id"])

    diary = diary_storage.get_diary_by_date(request.date, user_id=current_user["id"])
    if not diary or not diary.content:
        async def empty():
            yield f"data: {json.dumps({'type': 'response', 'content': '今天还没写日记呢，想聊聊吗？'}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(empty(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"})

    logger.info(f"📡 流式问候 (session={session_id}): diary={len(diary.content)} chars")

    queue = asyncio.Queue()

    def sync_producer():
        ai_reply = ""
        ai_thinking = ""
        try:
            for chunk in agent.greeting_stream(diary.content, request.date):
                if chunk.get("type") == "response":
                    ai_reply += chunk.get("content", "")
                elif chunk.get("type") == "thinking":
                    ai_thinking += chunk.get("content", "")
                data = json.dumps(chunk, ensure_ascii=False)
                try:
                    queue.put_nowait(f"data: {data}\n\n")
                except asyncio.QueueFull:
                    pass
        except Exception as e:
            logger.error(f"流式问候异常: {e}")
            try:
                queue.put_nowait(f"data: {json.dumps({'type': 'response', 'content': '（连接异常）'}, ensure_ascii=False)}\n\n")
            except asyncio.QueueFull:
                pass
        finally:
            # 保存问候语到会话数据库
            if ai_reply:
                try:
                    diary_date_label = ""
                    if request.date:
                        parts = request.date.split("-")
                        if len(parts) == 3:
                            diary_date_label = f"{parts[0][2:]}年{parts[1]}月{parts[2]}日"
                    diary_storage.add_message(session_id, "assistant", ai_reply, ai_thinking, diary_date_label)
                    logger.info(f"✅ 问候语已保存到会话 {session_id[:8]}...")
                except Exception as e:
                    logger.error(f"⚠️ 保存问候语到会话失败: {e}")
            try:
                queue.put_nowait("data: [DONE]\n\n")
            except asyncio.QueueFull:
                pass
            # 问候完成后异步触发用户档案更新
            from .profile_routes import regenerate_profile_async
            regenerate_profile_async(diary_storage, agent, current_user["id"])

    async def generate():
        loop = asyncio.get_event_loop()
        loop.run_in_executor(None, sync_producer)
        while True:
            item = await queue.get()
            yield item
            if item == "data: [DONE]\n\n":
                break

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"}
    )
