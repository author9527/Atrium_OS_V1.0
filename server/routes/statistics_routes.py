# ==========================================
# Atrium OS - 统计信息路由（情绪雷达 / 关键词词云 / 生活摘要）
# ==========================================

import json
import re
import asyncio
import threading
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from server.app import get_diary_storage, get_agent, apply_user_runtime
from server.auth import get_current_user
from server.model_service import generate as _model_generate
from server.model_service import generate_stream as _model_generate_stream
from server.logger import logger
from server.chat_utils import strip_html

router = APIRouter()

# ========== 情绪均值雷达 + 张力 ==========
# 8 基础情绪（普拉奇克），顺序固定，作为雷达图与打分向量的轴
AXES = ["喜悦", "信任", "恐惧", "惊讶", "悲伤", "厌恶", "愤怒", "期待"]

# 张力只统计 4 对正对轴（对立情绪），每对取 (A+B)/2 后求和
TENSION_PAIRS = [(0, 4), (1, 5), (2, 6), (3, 7)]


def _parse_vector(raw: str) -> Optional[List[int]]:
    """把 calendar_cache 里的 emotion_vector（JSON 字符串）解析为长度 8 的分数列表。
    缺失、为空或解析失败返回 None。"""
    if not raw:
        return None
    try:
        obj = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(obj, dict):
        return None
    vals = []
    for a in AXES:
        v = obj.get(a)
        try:
            n = int(round(float(v)))
        except (TypeError, ValueError):
            n = 0
        vals.append(max(0, min(100, n)))
    # 全 0 视为无有效打分
    if all(v == 0 for v in vals):
        return None
    return vals


def _mean_vector(vectors: List[List[int]]) -> List[float]:
    """对一组长度 8 的分数列表逐维取均值（各维度独立，不互相抵消）。"""
    if not vectors:
        return [0.0] * 8
    n = len(vectors)
    sums = [0.0] * 8
    for v in vectors:
        for i in range(8):
            sums[i] += v[i]
    return [s / n for s in sums]


def _daily_tension(vector: List[int]) -> int:
    """单日张力 = 4 对正对轴对立情绪"同时共现"强度的均方根(RMS)。

    每对用调和平均 2*P*N/(P+N) 度量"两对立情绪同时在场"的程度：
    - 某一极缺失（P=0 或 N=0）时该对贡献为 0，避免把单极强烈误判为内部冲突；
    - 两极都高时接近算术平均水平，两极失衡时大幅压缩（介于 min 与均值之间）。
    最后对四对的调和平均求均方根 sqrt(mean(h_i^2))，放大高张力对数的影响，
    避免个别强冲突被其余低冲突拉平。返回向下取整后的整数。"""
    hs: List[float] = []
    for a, b in TENSION_PAIRS:
        p, n = vector[a], vector[b]
        s = p + n
        hs.append(0.0 if s <= 0 else 2 * p * n / s)
    rms = (sum(h * h for h in hs) / len(hs)) ** 0.5
    return int(rms)  # 向下取整


@router.get("/api/statistics/emotion")
async def get_emotion_statistics(diary_storage=Depends(get_diary_storage),
                                 current_user: dict = Depends(get_current_user)):
    """情绪均值雷达 + 张力。
    - 近10天 / 第11~30天 两档，逐日 8 维打分独立取均值（不抵消）作为雷达轮廓。
    - 近3天张力：单日在 4 对正对轴上的共现强度之和，柱高超100封顶、颜色加深由前端处理。
    缺失打分向量的日记不计入均值。"""
    from datetime import datetime
    user_id = current_user["id"]
    diaries = diary_storage.get_all_diaries(user_id)
    today = datetime.now().date()

    # 以用户最新一篇日记的日期作为"当前"参照，而非服务器时钟。
    # 手机端与服务器时钟可能存在时差（手机端"今天"可能比服务器早一天），
    # 若沿用服务器 today，最新日记会被当成"未来日期"排除，导致张力缺失、雷达计数不足。
    latest = today
    for d in diaries:
        try:
            dd = datetime.strptime(d.date, "%Y-%m-%d").date()
            if dd > latest:
                latest = dd
        except (ValueError, TypeError):
            continue
    today = latest

    buckets = {"recent10": [], "recent30": []}
    for d in diaries:
        try:
            d_dt = datetime.strptime(d.date, "%Y-%m-%d").date()
        except (ValueError, TypeError):
            continue
        diff = (today - d_dt).days
        if diff < 0:
            continue
        cache = diary_storage.get_calendar_cache(d.date, user_id=user_id) or {}
        vec = _parse_vector(cache.get("emotion_vector", ""))
        if vec is None:
            continue
        if diff <= 9:
            buckets["recent10"].append(vec)
        elif diff <= 29:
            buckets["recent30"].append(vec)

    # 张力柱状图：返回最近 10 天（含今天）的槽位，前端可视窗口显示 4 根、可横向拖动看更早。
    # 某天没有日记或未产生情绪向量时 value 置为 null，前端只画日期刻度、不画柱子。
    tension = []
    for offset in range(9, -1, -1):  # 从最早到今天
        d = today - timedelta(days=offset)
        ds = d.strftime("%Y-%m-%d")
        cache = diary_storage.get_calendar_cache(ds, user_id=user_id) or {}
        vec = _parse_vector(cache.get("emotion_vector", ""))
        if vec is not None:
            tension.append({"date": ds, "value": round(_daily_tension(vec), 1)})
        else:
            tension.append({"date": ds, "value": None})

    return {
        "axes": AXES,
        "recent10": [round(x, 1) for x in _mean_vector(buckets["recent10"])],
        "recent30": [round(x, 1) for x in _mean_vector(buckets["recent30"])],
        "recent10_count": len(buckets["recent10"]),
        "recent30_count": len(buckets["recent30"]),
        "tension": tension,
        "total_diaries": len(diaries),
    }


# ========== 生活摘要（鱼骨）：LLM 输出解析 ==========
FISHBONE_PROMPT = """你是生活摘要助手。请为每篇日记生成一条简短摘要，捕捉当天最有意义的内容（如关键决定、情绪变化、有意义的事件、值得回看的生活片段）。忽略纯流水账。

## 新日记
{diary_text}

为每篇日记生成恰好一条摘要（20-40字，自然通顺的一句话，具体不抽象，如"下定决心换个新工作"、"和老同学久别重逢很激动"）。

输出 JSON 数组，每个元素含：
- date: 日记日期（YYYY-MM-DD）
- summary: 一句话摘要

只输出 JSON 数组，不要任何额外文字。"""


def _parse_fishbone_events(text: str) -> list:
    """从模型输出中解析摘要数组，支持裸数组与 {events:[...]} 两种形态。"""
    events = []
    candidates = [text]
    m = re.search(r'\[.*\]', text or "", re.DOTALL)
    if m:
        candidates.append(m.group(0))
    for cand in candidates:
        try:
            data = json.loads(cand)
            if isinstance(data, dict):
                data = data.get("events", [])
            if isinstance(data, list):
                for ev in data:
                    if isinstance(ev, dict):
                        events.append({
                            "date": str(ev.get("date", "")).strip(),
                            "summary": str(ev.get("summary", "")).strip(),
                        })
                if events:
                    break
        except (json.JSONDecodeError, TypeError, ValueError):
            continue
    return [e for e in events if e["summary"]]


# ========== LLM 辅助 ==========
def _call_ollama(prompt: str, timeout: int = 300, num_predict: int = 2048, think: bool = False,
                 user_id: str = "default") -> str:
    """调用 Ollama 生成（统一走 model_service，读该账号主模型）。"""
    return _model_generate(
        prompt, user_id=user_id, timeout=timeout,
        num_predict=num_predict, think=think,
    )


# ========== 请求模型 ==========
class OpeningRequest(BaseModel):
    chart_type: str  # "emotion" | "fishbone"
    data_text: str = ""


# ========== API 路由 ==========

@router.get("/api/statistics/fishbone")
async def get_fishbone_statistics(diary_storage=Depends(get_diary_storage),
                                  current_user: dict = Depends(get_current_user)):
    """读取已提取的全部鱼骨事件（按日期升序）。"""
    return {"events": diary_storage.get_fishbone_events(current_user["id"])}


@router.post("/api/statistics/fishbone/extract")
async def trigger_fishbone_extract(diary_storage=Depends(get_diary_storage),
                                   agent=Depends(get_agent),
                                   current_user: dict = Depends(get_current_user)):
    """触发鱼骨增量提取（后台线程），立即返回。增量游标只在成功后推进。"""
    user_id = current_user["id"]
    from server.background import submit_background
    submit_background(_extract_fishbone_incremental, diary_storage, user_id)
    return {"status": "started"}


def _extract_fishbone_incremental(diary_storage, user_id: str) -> dict:
    """增量提取核心：只处理游标之后的新日记，每篇生成一条摘要，游标只在成功后推进。"""
    last = diary_storage.get_last_processed_date(user_id)
    pending = diary_storage.get_diaries_after(user_id, last or "")
    if not pending:
        return {"processed": 0, "events_added": 0}

    added = 0
    for d in pending:
        diary_text = f"【{d.date}】\n{strip_html(d.content)}"
        prompt = FISHBONE_PROMPT.format(diary_text=diary_text)
        try:
            raw = _call_ollama(prompt, num_predict=1024, user_id=user_id)
        except Exception as e:
            logger.error(f"[鱼骨] 提取 {d.date} 失败: {e}")
            return {"processed": 0, "events_added": added}  # 游标不推进，下次重试
        items = _parse_fishbone_events(raw)
        # LLM 偶发返回空：重试一次，避免"空提取却推进游标"导致摘要永久丢失
        if not items:
            logger.warning(f"[鱼骨] {d.date} 首次提取为空，重试一次")
            try:
                raw = _call_ollama(prompt, num_predict=1024, user_id=user_id)
                items = _parse_fishbone_events(raw)
            except Exception as e:
                logger.error(f"[鱼骨] 提取 {d.date} 重试失败: {e}")
        for it in items:
            ev_date = it["date"] or d.date
            if diary_storage.add_fishbone_event(user_id, ev_date, it["summary"] or f"（{d.date} 无摘要）"):
                added += 1
        diary_storage.set_last_processed_date(user_id, d.date)
    return {"processed": len(pending), "events_added": added}


@router.post("/api/statistics/opening")
async def get_chart_opening(request: OpeningRequest,
                            current_user: dict = Depends(get_current_user)):
    """基于图表数据生成一句自动 AI 开场白。数据为空则返回空串。"""
    data_text = (request.data_text or "").strip()
    if not data_text:
        return {"opening": ""}
    prompt = _build_opening_prompt(request.chart_type, data_text)
    try:
        opening = (await asyncio.to_thread(_call_ollama, prompt, num_predict=120, user_id=current_user["id"])).strip()
    except Exception as e:
        logger.error(f"[开场白] 生成失败: {e}")
        return {"opening": ""}
    return {"opening": opening}


def _build_opening_prompt(chart_type: str, data_text: str) -> str:
    """构建开场白 prompt（与流式端点共用，保证文案一致）"""
    label = {"emotion": "情绪雷达", "keyword": "关键词词云", "fishbone": "生活摘要"}.get(chart_type, "统计")
    return (
        f"""你是共情助手，用户的好朋友。用户刚刚查看了「{label}」统计，你现在想陪他聊两句。

【怎么做】
- 像敏锐的朋友注意到某个明显变化后自然开口，主动发起一句话对话，引导用户聊聊
- 观察数据里值得注意的点（情绪起伏、反复出现的词、生活中值得留意的片段），自然地提出来
- 如果数据没有明显变化或数据很少，就输出一句轻松的观察，不硬找话题

【不要怎样】
- 不要堆砌数据，不要罗列所有指标
- 不要套话，不要"今天感觉怎么样"这种空泛开场
- 不要端分析报告的说教架势

【把握不准时】
- 数据看不出什么名堂时，就温和地共情或随口一句，不硬做深刻分析

下面是本次「{label}」统计的数据，供你参考：
{data_text}

只输出这句话本身（20-40字），不要任何前缀。"""
    )


@router.post("/api/statistics/opening/stream")
async def get_chart_opening_stream(request: OpeningRequest,
                                   current_user: dict = Depends(get_current_user)):
    """基于图表数据流式生成一句 AI 开场白（SSE），逐 token 输出，供进入对话空间后实时渲染。"""
    data_text = (request.data_text or "").strip()
    if not data_text:
        async def empty():
            yield "data: [DONE]\n\n"
        return StreamingResponse(
            empty(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
        )

    prompt = _build_opening_prompt(request.chart_type, data_text)
    user_id = current_user["id"]

    import queue as _queue
    q = _queue.Queue()

    def sync_producer():
        # 应用该账号的模型设置到运行时，保证用对模型
        try:
            apply_user_runtime(user_id)
        except Exception as e:
            logger.warning(f"[开场白] 应用模型设置失败: {e}")
        try:
            for chunk in _model_generate_stream(prompt, user_id=user_id, num_predict=120, think=False):
                if chunk.get("type") == "response":
                    data = json.dumps({"type": "response", "content": chunk.get("content", "")}, ensure_ascii=False)
                    try:
                        q.put_nowait(f"data: {data}\n\n")
                    except _queue.Full:
                        pass
        except Exception as e:
            logger.error(f"[开场白] 流式生成失败: {e}")
        q.put_nowait("data: [DONE]\n\n")

    async def gen():
        loop = asyncio.get_event_loop()
        loop.run_in_executor(None, sync_producer)
        while True:
            item = await asyncio.to_thread(q.get)
            yield item
            if item == "data: [DONE]\n\n":
                break

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )