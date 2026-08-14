# ==========================================
# Atrium OS - 觉察助手路由（支线探索模式）
# ==========================================

import json
import os
import re
import time
import asyncio
import requests
from datetime import datetime
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional, List

# ========== 模型配置 ==========
# 觉察分析统一使用主模型（随设置页 local_model 变化），num_predict 按各调用点现有设计
# INSIGHT_MODEL 置为 None：_call_ollama 会在 model=None 时自动读取主模型
INSIGHT_MODEL = None

from server.app import get_diary_storage, _load_settings
from server.auth import get_current_user
from server import model_service
from server.model_service import generate as _model_generate
from server.logger import logger
from server.chat_utils import strip_html
from ai.prompt_core import build_awareness_system

router = APIRouter()

# ========== 支线对话辅助函数 ==========

def _extract_dates_from_evidence(evidence: str) -> List[str]:
    """从 evidence 文本中提取所有引用的日期（如 '2025-03-15'）"""
    import re
    # 匹配 evidence 中的日期引用：2025-03-15 或 2025-03-15 等
    dates = re.findall(r'(\d{4}-\d{2}-\d{2})', evidence)
    return list(set(dates))  # 去重

def _filter_diary_by_dates(diary_context: str, dates: List[str]) -> str:
    """从 diary_context 中只保留指定日期的日记条目"""
    if not dates or not diary_context:
        return diary_context
    
    # 按 【日期】 分割日记
    entries = re.split(r'(?=【\d{4}-\d{2}-\d{2}】)', diary_context)
    filtered = []
    for entry in entries:
        entry_dates = re.findall(r'【(\d{4}-\d{2}-\d{2})】', entry)
        if any(d in dates for d in entry_dates):
            filtered.append(entry.strip())
    
    return "\n\n".join(filtered) if filtered else diary_context

def _build_prompt(branch: dict, diary_context: str, user_message: str,
                  persona_ego: str = "", interaction_mode: str = "") -> tuple:
    """构建对话 prompt，使用压缩摘要 + 近期对话。返回 (system_prompt, user_prompt)。

    persona_ego / interaction_mode：由调用方按所选 AI 注入，使互动模式跟随 AI 而非空间。
    """
    # 觉察人格核心单一来源
    ego_parts = [persona_ego] if persona_ego else []
    system_prompt = build_awareness_system(ego_parts)

    header = f"""## 当前支线
标题: {branch.get('title', '')}
核心观察: {branch.get('observation', '')}
初始追问: {branch.get('question', '')}

## 相关日记
{diary_context}
"""
    if interaction_mode:
        header += f"\n## 与该用户的互动模式\n{interaction_mode}\n"

    conversation = branch.get("conversation", [])
    compressed_rounds = branch.get("compressed_rounds", 0)
    summary = branch.get("conversation_summary", "")

    # 如果有压缩摘要，用摘要替代已压缩的消息
    if summary and compressed_rounds > 0:
        compressed_messages = compressed_rounds * 2
        recent = conversation[compressed_messages:]  # 未压缩的近期消息
        recent_text = ""
        for msg in recent:
            role_label = "用户" if msg["role"] == "user" else "觉察伙伴"
            recent_text += f"{role_label}: {msg['content']}\n"

        chat_history = f"""## 早期对话摘要
{summary}

## 近期对话
{recent_text if recent_text else '（这是对话的开始）'}"""
    else:
        # 无需压缩，使用完整历史
        full = ""
        for msg in conversation:
            role_label = "用户" if msg["role"] == "user" else "觉察伙伴"
            full += f"{role_label}: {msg['content']}\n"
        chat_history = full if full else "（这是对话的开始）"

    user_section = f"\n## 用户的最新回复\n{user_message}"
    user_prompt = header + chat_history + user_section
    return system_prompt, user_prompt


def _compress_conversation(messages: list, branch_title: str, user_id: str = "default") -> str:
    """将一段对话压缩为结构化摘要"""
    text = ""
    for msg in messages:
        role = "用户" if msg["role"] == "user" else "觉察伙伴"
        text += f"{role}: {msg['content']}\n"

    prompt = f"""请将以下关于「{branch_title}」的对话记录压缩为 200-300 字的结构化摘要，保留核心信息：

1. 用户表达的关键观点和情绪变化
2. 觉察伙伴提出的重要洞察和引导方向
3. 对话的推进脉络（从哪个话题过渡到哪个话题）

对话记录：
{text}

请直接输出摘要，不要加任何前缀说明："""

    try:
        summary = _call_ollama(prompt, timeout=120, model=INSIGHT_MODEL, num_predict=500, think=False, user_id=user_id)
        return summary.strip()
    except Exception as e:
        logger.error(f"[觉察] 压缩对话失败: {e}")
        return ""


def _maybe_compress(results: list, result_id: str, branch_id: str, user_id: str = "default"):
    """检查是否需要压缩对话（每 20 轮触发一次累计压缩）
    
    压缩规则：
    - 聊到 40 轮 → 压缩前 20 轮为摘要
    - 聊到 60 轮 → 压缩前 40 轮为摘要（替换旧摘要）
    - 聊到 80 轮 → 压缩前 60 轮为摘要
    - 以此类推，始终保持最近 20 轮完整、更早的对话用摘要替代
    """
    for r in results:
        if r["id"] != result_id:
            continue
        for b in r.get("branches", []):
            if b["id"] != branch_id:
                continue
            conversation = b.get("conversation", [])
            total_rounds = len(conversation) // 2

            threshold = 40
            while threshold <= total_rounds:
                # 跳过已压缩的阈值
                if b.get("compressed_rounds", 0) >= threshold - 20:
                    threshold += 20
                    continue

                compress_rounds = threshold - 20
                compress_messages = conversation[:compress_rounds * 2]

                if not compress_messages:
                    threshold += 20
                    continue

                logger.info(f"[觉察] 压缩前 {compress_rounds} 轮对话...")
                summary = _compress_conversation(compress_messages, b.get("title", ""), user_id)
                if summary:
                    b["conversation_summary"] = summary
                    b["compressed_rounds"] = compress_rounds
                    logger.info(f"[觉察] 压缩完成，摘要 {len(summary)} 字，已压缩 {compress_rounds} 轮")
                threshold += 20
            return
    return

INSIGHT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "data")

def _get_branch_chat_persona(diary_storage, user_id: str, mode: str) -> tuple:
    """按所选 AI 解析人设 ego 与互动模式，使互动模式跟随 AI 而非空间。返回 (persona_ego, interaction_mode)。"""
    from server.persona_config import get_persona_ego
    from server.routes.profile_routes import get_interaction_mode
    persona_key = "awareness" if mode == "awareness" else "empathy"
    persona_ego = (get_persona_ego(user_id, persona_key) or "").strip()
    interaction_mode = ""
    try:
        interaction_mode = get_interaction_mode(diary_storage, user_id, persona_key)
    except Exception as e:
        logger.warning(f"[觉察支线] 获取互动模式失败 ({persona_key}): {e}")
    return persona_ego, interaction_mode


def _get_insight_file(user_id: str) -> str:
    """获取用户专属的觉察结果文件路径"""
    return os.path.join(INSIGHT_DIR, f"insight_results_{user_id}.json")

DEFAULT_INSIGHT_SETTINGS = {
    "auto_run": True,
    "frequency": "weekly",       # "weekly" 或 "monthly"
    "schedule_day": 7,            # 每周: 1=周一 ~ 7=周日; 每月: 1~29 号
    "schedule_time": "23:00",
    "last_run": None,
    "analysis_days": 30,
}

# ==========================================
# 结构化支线分析 Prompt
# ==========================================

BRANCH_DISCOVERY_PROMPT = """你是一个温和的觉察伙伴，正在帮助用户回顾他最近的日记。你不是专家，不是导师，你只是陪用户一起思考的人。

## 任务
从日记中找出值得探索的"觉察支线"（必须输出 4-6 个，至少 4 个，这是硬性要求）——每条支线是一个独立的观察角度，用户可以选择感兴趣的去深入。

## 支线设计原则
- 每条支线应该是独立的观察角度，不要重复
- 观察要具体，不要泛泛而谈（比如不要只说"你压力很大"，要说"你这周三次提到'睡不着'，但每次睡不着的原因都不同"）
- 追问要让人想"聊下去"，而不是"答完就结束"
- 不要假装知道别人在想什么。你只在日记中看到了用户的视角。
- 不要说"你应该做X"。你只是在陪用户思考。

## 字段要求
- title: 用一句话概括这个观察（6-12字，要具体不要抽象）
- observation: 你从日记中注意到了什么？像朋友聊天一样说出来。引用原文中的具体语句作为证据。语气温和、不评判。
- evidence: 摘录日记中支撑这个观察的 1-2 句原文，标注日期。
- question: 基于这个观察，提一个用户可能没问过自己的问题。不是反问，是真诚的好奇。

## 日记

"""

BRANCH_SCHEMA = {
    "type": "object",
    "properties": {
        "branches": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "一句话概括观察（6-12字）"},
                    "observation": {"type": "string", "description": "从日记中注意到的内容"},
                    "evidence": {"type": "string", "description": "摘录日记原文并标注日期"},
                    "question": {"type": "string", "description": "一个引发思考的问题"}
                },
                "required": ["title", "observation", "evidence", "question"]
            },
            "minItems": 1,
            "maxItems": 8
        }
    },
    "required": ["branches"]
}


def _parse_branches(text: str) -> list:
    """从模型 JSON 输出中解析支线，失败时降级到旧版正则解析"""
    branches = []

    # 优先尝试 JSON 解析
    try:
        data = json.loads(text)
        raw_branches = data.get("branches", []) if isinstance(data, dict) else []
        for i, b in enumerate(raw_branches):
            if not isinstance(b, dict):
                continue
            branch = {
                "id": str(i + 1),
                "title": b.get("title", "") or f"支线 {i+1}",
                "observation": b.get("observation", ""),
                "evidence": b.get("evidence", ""),
                "question": b.get("question", ""),
                "conversation": [],
            }
            if branch["observation"]:
                branches.append(branch)
    except (json.JSONDecodeError, TypeError, ValueError):
        pass

    # JSON 解析失败 → 降级到旧版正则解析
    if not branches:
        branches = _parse_branches_legacy(text)

    return branches


def _parse_branches_legacy(text: str) -> list:
    """旧版正则解析器（降级备用）"""
    branches = []
    pattern = re.compile(r'\[支线\](.*?)\[/支线\]', re.DOTALL)
    matches = pattern.findall(text)
    if not matches:
        parts = re.split(r'\n?\[支线\]\n?', text)
        matches = [p.strip() for p in parts if p.strip()]
    for i, block in enumerate(matches):
        branch = {"id": str(i + 1)}
        for field in ["标题", "观察", "证据", "追问"]:
            m = re.search(rf'{field}[：:]\s*(.*?)(?=\n(?:标题|观察|证据|追问)[：:]|\Z)', block, re.DOTALL)
            if m:
                branch[field] = m.group(1).strip()
        if branch.get("观察"):
            branch["title"] = branch.pop("标题", f"支线 {i+1}")
            branch["observation"] = branch.pop("观察", "")
            branch["evidence"] = branch.pop("证据", "")
            branch["question"] = branch.pop("追问", "")
            branch["conversation"] = []
            branches.append(branch)
    return branches


def _load_insight_settings(user_id: str = 'default'):
    insight_file = _get_insight_file(user_id)
    try:
        if os.path.exists(insight_file):
            with open(insight_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                settings = data.get("settings", {})
                for k, v in DEFAULT_INSIGHT_SETTINGS.items():
                    if k not in settings:
                        settings[k] = v
                return settings, data.get("results", [])
    except Exception:
        pass
    return DEFAULT_INSIGHT_SETTINGS.copy(), []


def _save_insight_data(settings, results, user_id: str = 'default'):
    insight_file = _get_insight_file(user_id)
    os.makedirs(os.path.dirname(insight_file), exist_ok=True)
    with open(insight_file, "w", encoding="utf-8") as f:
        json.dump({"settings": settings, "results": results}, f, ensure_ascii=False, indent=2)


def _call_ollama(prompt: str, timeout: int = 300, model: str = None, num_predict: int = 4096, system: str = None, fmt=None,
                 user_id: str = "default", temperature: float = 0.4) -> str:
    """调用本地 Ollama 生成回复（统一走 model_service，model 缺省读账号主模型）。"""
    return _model_generate(
        prompt, user_id=user_id, model=model, timeout=timeout,
        num_predict=num_predict, system=system, fmt=fmt, temperature=temperature,
    )


def _get_filtered_diaries(diary_storage, days: int, user_id: str = 'default'):
    """获取过滤后的日记列表"""
    from datetime import date, timedelta
    diaries = diary_storage.get_recent_diaries(limit=max(days * 2, 60), user_id=user_id)
    cutoff = date.today() - timedelta(days=days)
    filtered = []
    for d in diaries:
        if not d.content or len(d.content) < 5:
            continue
        try:
            d_date = datetime.strptime(d.date, "%Y-%m-%d").date()
            if d_date >= cutoff:
                filtered.append(d)
        except ValueError:
            continue
    filtered.sort(key=lambda d: d.date)
    return filtered


def _diaries_to_text(diaries) -> str:
    """日记列表拼接为文本"""
    text = ""
    for d in diaries:
        text += f"【{d.date}】\n{strip_html(d.content)}\n\n"
    return text


# ==========================================
# 请求模型
# ==========================================

class InsightSettingsRequest(BaseModel):
    auto_run: Optional[bool] = None
    frequency: Optional[str] = None      # "weekly" | "monthly"
    schedule_day: Optional[int] = None   # 每周 1-7, 每月 1-29
    schedule_time: Optional[str] = None
    analysis_days: Optional[int] = None


class AnalyzeRequest(BaseModel):
    days: int = 30


class BranchChatRequest(BaseModel):
    message: str
    mode: str = "awareness"  # "awareness" | "empathy"，决定使用哪个 AI 的人设与互动模式


# ==========================================
# API 路由
# ==========================================

@router.get("/api/insight/settings")
async def get_insight_settings(current_user: dict = Depends(get_current_user)):
    settings, _ = _load_insight_settings(current_user["id"])
    return settings


@router.post("/api/insight/settings")
async def update_insight_settings(request: InsightSettingsRequest,
                                  current_user: dict = Depends(get_current_user)):
    settings, results = _load_insight_settings(current_user["id"])
    if request.auto_run is not None:
        settings["auto_run"] = request.auto_run
    if request.frequency is not None:
        settings["frequency"] = request.frequency
    if request.schedule_day is not None:
        settings["schedule_day"] = request.schedule_day
    if request.schedule_time is not None:
        settings["schedule_time"] = request.schedule_time
    if request.analysis_days is not None:
        settings["analysis_days"] = request.analysis_days
    _save_insight_data(settings, results, current_user["id"])
    return {"success": True, "settings": settings}


@router.post("/api/insight/analyze")
async def run_insight_analysis(request: AnalyzeRequest = None,
                                diary_storage=Depends(get_diary_storage),
                                current_user: dict = Depends(get_current_user)):
    """运行觉察分析，输出结构化支线"""
    if request is None:
        request = AnalyzeRequest()

    user_id = current_user["id"]
    settings, results = _load_insight_settings(user_id)
    days = request.days or settings.get("analysis_days", 30)

    filtered = _get_filtered_diaries(diary_storage, days, user_id)

    # 指定天数内日记不足时，回退到全部日记，保证能生成分析
    if len(filtered) < 2:
        all_diaries = diary_storage.get_all_diaries(user_id)
        filtered = [d for d in all_diaries if d.content and len(d.content) >= 5]
        filtered.sort(key=lambda d: d.date)

    if len(filtered) < 2:
        return {
            "success": True,
            "analysis": "最近日记数量不足（至少需要 2 篇），暂时无法生成有意义的分析。",
            "diary_count": len(filtered),
            "date_range": f"{filtered[0].date} 至 {filtered[-1].date}" if filtered else "无",
            "timestamp": datetime.now().isoformat(),
            "branches": [],
        }

    diary_text = _diaries_to_text(filtered)

    t0 = time.time()
    try:
        raw = await asyncio.to_thread(_call_ollama, BRANCH_DISCOVERY_PROMPT + diary_text, model=INSIGHT_MODEL, num_predict=8192, fmt=BRANCH_SCHEMA, user_id=user_id)
        elapsed = time.time() - t0
    except requests.exceptions.ConnectionError:
        return {"success": False, "error": "无法连接到 Ollama，请确认 Ollama 已启动", "diary_count": len(filtered)}
    except Exception as e:
        return {"success": False, "error": f"分析失败: {str(e)}", "diary_count": len(filtered)}

    # 解析支线
    branches = _parse_branches(raw)

    # 支线不足 3 条 → 用更严格提示重试一次，避免"只生成一条"
    if len(branches) < 3 and raw and raw.strip():
        retry_prompt = (BRANCH_DISCOVERY_PROMPT + diary_text +
                        '\n\n【重要】只输出一个 JSON 对象，其中包含 branches 数组。必须输出至少 4 条支线。'
                        '字段名必须且只能用英文：title、observation、evidence、question。'
                        '不要输出 markdown 代码块，不要输出任何解释文字。')
        try:
            raw = await asyncio.to_thread(_call_ollama, retry_prompt, model=INSIGHT_MODEL, num_predict=8192,
                                          fmt=BRANCH_SCHEMA, user_id=user_id, temperature=0.3)
            branches = _parse_branches(raw)
        except requests.exceptions.ConnectionError:
            pass
        except Exception as e:
            logger.warning(f"[觉察] 重试生成支线失败: {e}")

    # 如果解析失败，降级为纯文本
    if not branches:
        branches = [{
            "id": "1",
            "title": "觉察发现",
            "observation": raw.strip(),
            "evidence": "",
            "question": "你想从哪个角度深入聊聊？",
            "conversation": [],
        }]

    analysis_model = model_service.local_model(user_id)

    new_result = {
        "id": datetime.now().strftime("%Y%m%d%H%M%S"),
        "timestamp": datetime.now().isoformat(),
        "diary_count": len(filtered),
        "date_range": f"{filtered[0].date} 至 {filtered[-1].date}",
        "branches": branches,
        "diary_context": diary_text,  # 保存日记原文，供支线对话使用
        "elapsed_seconds": round(elapsed, 1),
        "model": analysis_model,
    }

    results.insert(0, new_result)
    results = results[:50]

    settings["last_run"] = datetime.now().isoformat()
    _save_insight_data(settings, results, user_id)

    return {
        "success": True,
        "id": new_result["id"],
        "diary_count": len(filtered),
        "date_range": new_result["date_range"],
        "elapsed_seconds": round(elapsed, 1),
        "timestamp": new_result["timestamp"],
        "branches": branches,
        "diary_context": diary_text,
    }


@router.post("/api/insight/result/{result_id}/branch/{branch_id}/chat")
async def chat_in_branch(result_id: str, branch_id: str, request: BranchChatRequest,
                         diary_storage=Depends(get_diary_storage),
                         current_user: dict = Depends(get_current_user)):
    """在指定支线中进行深入对话"""
    _, results = _load_insight_settings(current_user["id"])

    # 找到分析结果
    result = None
    for r in results:
        if r["id"] == result_id:
            result = r
            break
    if not result:
        return {"error": "未找到该分析记录"}

    # 找到支线
    branch = None
    for b in result.get("branches", []):
        if b["id"] == branch_id:
            branch = b
            break
    if not branch:
        return {"error": "未找到该支线"}

    # 按所选 AI 注入人设与互动模式（互动模式跟随 AI 而非空间）
    persona_ego, interaction_mode = _get_branch_chat_persona(diary_storage, current_user["id"], request.mode)

    # 筛选相关日记 + 构建 prompt（自动处理对话历史截断）
    evidence = branch.get("evidence", "")
    relevant_dates = _extract_dates_from_evidence(evidence)
    full_diary = result.get("diary_context", "")
    filtered_diary = _filter_diary_by_dates(full_diary, relevant_dates)
    system_prompt, user_prompt = _build_prompt(branch, filtered_diary, request.message, persona_ego, interaction_mode)

    try:
        reply = await asyncio.to_thread(_call_ollama, user_prompt, timeout=300, model=INSIGHT_MODEL, system=system_prompt, user_id=current_user["id"])
    except Exception as e:
        return {"error": f"对话失败: {str(e)}"}

    # 保存对话记录
    branch.setdefault("conversation", [])
    branch["conversation"].append({"role": "user", "content": request.message})
    branch["conversation"].append({"role": "assistant", "content": reply})

    # 检查是否需要压缩早期对话（40轮→压前20轮，60轮→压前40轮，以此类推）
    _maybe_compress(results, result_id, branch_id, current_user["id"])

    # 持久化
    settings, _ = _load_insight_settings(current_user["id"])
    _save_insight_data(settings, results, current_user["id"])

    return {"reply": reply, "conversation": branch["conversation"]}


@router.post("/api/insight/result/{result_id}/branch/{branch_id}/chat/stream")
async def chat_in_branch_stream(result_id: str, branch_id: str, request: BranchChatRequest,
                                diary_storage=Depends(get_diary_storage),
                                current_user: dict = Depends(get_current_user)):
    """在指定支线中进行流式对话（SSE）"""
    _, results = _load_insight_settings(current_user["id"])

    # 找到分析结果
    result = None
    for r in results:
        if r["id"] == result_id:
            result = r
            break
    if not result:
        async def err():
            yield f"data: {json.dumps({'type': 'error', 'content': '未找到该分析记录'}, ensure_ascii=False)}\n\n"
        return StreamingResponse(err(), media_type="text/event-stream")

    # 找到支线
    branch = None
    for b in result.get("branches", []):
        if b["id"] == branch_id:
            branch = b
            break
    if not branch:
        async def err():
            yield f"data: {json.dumps({'type': 'error', 'content': '未找到该支线'}, ensure_ascii=False)}\n\n"
        return StreamingResponse(err(), media_type="text/event-stream")

    # 按所选 AI 注入人设与互动模式（互动模式跟随 AI 而非空间）
    persona_ego, interaction_mode = _get_branch_chat_persona(diary_storage, current_user["id"], request.mode)

    # 筛选相关日记 + 构建 prompt（自动处理对话历史截断）
    evidence = branch.get("evidence", "")
    relevant_dates = _extract_dates_from_evidence(evidence)
    full_diary = result.get("diary_context", "")
    filtered_diary = _filter_diary_by_dates(full_diary, relevant_dates)
    system_prompt, user_prompt = _build_prompt(branch, filtered_diary, request.message, persona_ego, interaction_mode)

    queue = asyncio.Queue()

    def sync_producer():
        """在线程池中调用 Ollama 流式 API（统一走 model_service），每拿到一个 token 放入队列。
        共情助手 think=False 快速响应，觉察助手 think=True 保留思考过程。"""
        full_response = ""
        full_thinking = ""
        try:
            for chunk in model_service.generate_stream(
                user_prompt, user_id=current_user["id"], system=system_prompt,
                think=(request.mode != "empathy"), num_predict=2048, temperature=0.7,
            ):
                kind = chunk.get("type")
                content = chunk.get("content", "")
                if kind == "thinking":
                    full_thinking += content
                elif kind == "response":
                    full_response += content
                data = json.dumps({"type": kind, "content": content}, ensure_ascii=False)
                try:
                    queue.put_nowait(f"data: {data}\n\n")
                except asyncio.QueueFull:
                    pass
        except Exception as e:
            logger.error(f"[洞察流式] Ollama 调用异常: {e}")
            try:
                queue.put_nowait(f"data: {json.dumps({'type': 'error', 'content': str(e)}, ensure_ascii=False)}\n\n")
            except asyncio.QueueFull:
                pass
        finally:
            # 先发 [DONE]，让前端立即结束流式展示
            try:
                queue.put_nowait("data: [DONE]\n\n")
            except asyncio.QueueFull:
                pass
            # 保存对话记录 + 早期对话压缩
            try:
                branch.setdefault("conversation", [])
                branch["conversation"].append({"role": "user", "content": request.message})
                branch["conversation"].append({"role": "assistant", "content": full_response})
                # 检查是否需要压缩早期对话（40轮→压前20轮，60轮→压前40轮，以此类推）
                _maybe_compress(results, result_id, branch_id, current_user["id"])
                settings, _ = _load_insight_settings(current_user["id"])
                _save_insight_data(settings, results, current_user["id"])
            except Exception as e:
                logger.error(f"[洞察流式] 保存对话失败: {e}")

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


@router.post("/api/insight/result/{result_id}/branch/{branch_id}/summarize")
async def summarize_branch(result_id: str, branch_id: str,
                           current_user: dict = Depends(get_current_user)):
    """为指定支线生成最终总结"""
    _, results = _load_insight_settings(current_user["id"])

    result = None
    for r in results:
        if r["id"] == result_id:
            result = r
            break
    if not result:
        return {"error": "未找到该分析记录"}

    branch = None
    for b in result.get("branches", []):
        if b["id"] == branch_id:
            branch = b
            break
    if not branch:
        return {"error": "未找到该支线"}

    conversations = branch.get("conversation", [])
    if not conversations:
        return {"summary": f"这条支线还没有展开对话。\n\n核心观察：{branch.get('observation', '')}\n\n追问：{branch.get('question', '')}"}

    chat_text = ""
    for msg in conversations:
        role = "用户" if msg["role"] == "user" else "觉察伙伴"
        chat_text += f"{role}: {msg['content']}\n"

    summary_prompt = f"""你是一个温和的觉察伙伴。以下是用户在一条觉察支线中的完整对话。

支线主题: {branch.get('title', '')}
初始观察: {branch.get('observation', '')}

## 对话记录
{chat_text}

请为这条支线写一个最终总结（2-3句话），包含：
1. 用户在这条支线中收获的核心觉察
2. 一个温和的收尾——不是结论，而是邀请用户在未来继续留意

像朋友聊天结束时那样自然，不要像在写报告。"""

    try:
        summary = await asyncio.to_thread(_call_ollama, summary_prompt, timeout=120, model=INSIGHT_MODEL, user_id=current_user["id"])
    except Exception as e:
        return {"error": f"总结生成失败: {str(e)}"}

    # 保存总结
    branch["summary"] = summary
    settings, _ = _load_insight_settings(current_user["id"])
    _save_insight_data(settings, results, current_user["id"])

    return {"summary": summary}


@router.get("/api/insight/result/{result_id}")
async def get_analysis_result(result_id: str,
                             current_user: dict = Depends(get_current_user)):
    """获取指定分析结果详情（含所有支线）"""
    _, results = _load_insight_settings(current_user["id"])
    for r in results:
        if r["id"] == result_id:
            return r
    return {"error": "未找到该分析记录"}


@router.delete("/api/insight/result/{result_id}")
async def delete_insight_result(result_id: str,
                                current_user: dict = Depends(get_current_user)):
    """删除指定觉察分析记录（连同其所有支线及对话）"""
    settings, results = _load_insight_settings(current_user["id"])
    new_results = [r for r in results if r["id"] != result_id]
    if len(new_results) == len(results):
        return {"success": False, "error": "未找到该分析记录"}
    _save_insight_data(settings, new_results, current_user["id"])
    logger.info(f"[觉察] 删除记录 {result_id}（用户 {current_user['id']}）")
    return {"success": True}


@router.get("/api/insight/latest")
async def get_latest_analysis(current_user: dict = Depends(get_current_user)):
    """获取最近一次分析结果"""
    _, results = _load_insight_settings(current_user["id"])
    if results:
        return results[0]
    return {"id": None, "branches": [], "diary_count": 0}


@router.get("/api/insight/history")
async def get_analysis_history(current_user: dict = Depends(get_current_user)):
    """获取历史分析记录（含完整分支数据，前端直接渲染无需二次请求）"""
    _, results = _load_insight_settings(current_user["id"])
    summaries = []
    for r in results:
        branches = r.get("branches", [])
        branch_count = len(branches)
        preview = ""
        if branch_count > 0:
            preview = branches[0].get("title", "")
        summaries.append({
            "id": r["id"],
            "timestamp": r["timestamp"],
            "diary_count": r["diary_count"],
            "date_range": r["date_range"],
            "elapsed_seconds": r.get("elapsed_seconds", 0),
            "branch_count": branch_count,
            "preview": preview,
            "branches": branches,
        })
    return {"history": summaries}