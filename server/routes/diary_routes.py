# ==========================================
# Atrium OS - 日记路由
# ==========================================

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from server.app import get_diary_storage, get_diary_service, get_agent
from server.auth import get_current_user
from server.logger import logger

router = APIRouter()

# 8 基础情绪轴（与情绪打分一致）
_AXES = ["喜悦", "信任", "恐惧", "惊讶", "悲伤", "厌恶", "愤怒", "期待"]
# 低唤醒/非唤醒情绪标签：情绪强度低(最高单维 < 阈值)时，日历格子用它们替换强情绪词
_LOW_AROUSAL_LABELS = {"平静", "满足", "疲惫", "释然"}
_LOW_AROUSAL_THRESHOLD = 40


def _pick_low_arousal_label(emotion: str, vector: dict) -> str:
    """低唤醒时，从四个非唤醒标签中选一个最贴切的。
    依据打分中正性/负性/期待感的相对高低：正性高→满足，负性高→疲惫，
    期待占优→释然，否则→平静。若原标签已在四词中则保留。"""
    if emotion in _LOW_AROUSAL_LABELS:
        return emotion
    def _v(k):
        try:
            return max(0, min(100, int(round(float(vector.get(k, 0))))))
        except (TypeError, ValueError):
            return 0
    positive = _v("喜悦") + _v("信任")
    negative = _v("悲伤") + _v("厌恶")
    anticipation = _v("期待")
    if anticipation >= max(positive, negative) and anticipation > 0:
        return "释然"
    if positive > negative:
        return "满足"
    if negative > positive:
        return "疲惫"
    return "平静"


def _parse_vector(raw: str):
    import json
    if not raw:
        return None
    try:
        obj = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None
    return obj if isinstance(obj, dict) else None


def _resolve_display_emotion(emotion: str, vector_raw: str) -> str:
    """结合情绪打分校准日历情绪标签：
    若最高单维打分 < 阈值（低唤醒），则用非唤醒标签替换可能被强判的情绪词。"""
    vec = _parse_vector(vector_raw)
    if not vec:
        return emotion
    try:
        top = max(int(round(float(vec.get(a, 0)))) for a in _AXES)
    except (TypeError, ValueError):
        return emotion
    if top < _LOW_AROUSAL_THRESHOLD:
        return _pick_low_arousal_label(emotion, vec)
    return emotion


class DiarySaveRequest(BaseModel):
    date: str
    content: str = None
    messages: list = []
    weather: str = '晴'
    tags: list = []


class SummarizeRequest(BaseModel):
    date: str
    content: str


class EmotionClassifyRequest(BaseModel):
    date: str
    content: str


class EmotionUpdateRequest(BaseModel):
    date: str
    emotion: str


class WeatherUpdateRequest(BaseModel):
    date: str
    weather: str


@router.get("/api/diary/date/{date}")
async def get_diary_by_date(date: str,
                            diary_storage=Depends(get_diary_storage),
                            current_user: dict = Depends(get_current_user)):
    """根据日期获取日记"""
    diary = diary_storage.get_diary_by_date(date, user_id=current_user["id"])
    if diary:
        return {"diary": diary.__dict__}
    return {"diary": None}


@router.post("/api/diary/save")
async def save_diary(request: DiarySaveRequest,
                     diary_service=Depends(get_diary_service),
                     current_user: dict = Depends(get_current_user)):
    """保存日记条目（含权限校验）"""
    logger.info(f"保存日记: {request.date} (用户: {current_user['username']})")
    try:
        result = diary_service.save_diary(
            date_str=request.date,
            content=request.content,
            messages=request.messages,
            weather=request.weather,
            tags=request.tags,
            user_id=current_user["id"]
        )
        return result
    except PermissionError as e:
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=403, content={"error": str(e)})


@router.post("/api/diary/weather")
async def update_diary_weather(request: WeatherUpdateRequest,
                               diary_storage=Depends(get_diary_storage),
                               current_user: dict = Depends(get_current_user)):
    """轻量更新某日天气（仅修改 weather 字段，不触发异步管线）"""
    diary_storage.update_weather(request.date, request.weather, user_id=current_user["id"])
    return {"status": "ok", "date": request.date, "weather": request.weather}


@router.get("/api/diary/month/{year}/{month}")  # 获取月度日记
async def get_month_diaries(year: int, month: int,
                            diary_storage=Depends(get_diary_storage),
                            current_user: dict = Depends(get_current_user)):
    """获取某月的所有日记信息（用于日历显示，直接从缓存读取）"""
    month_str = str(month).zfill(2)
    diaries = diary_storage.get_diaries_by_month(year, month_str, user_id=current_user["id"])
    result = []
    for diary in diaries:
        cache = diary_storage.get_calendar_cache(diary.date, user_id=current_user["id"])
        if cache:
            result.append({
                "date": diary.date,
                "has_diary": True,
                "entity_count": cache['entity_count'],
                "summary": cache.get('summary', '自己'),
                "emotion": _resolve_display_emotion(cache.get('emotion', ''), cache.get('emotion_vector', ''))
            })
        else:
            result.append({
                "date": diary.date,
                "has_diary": True,
                "entity_count": 0,
                "summary": "自己",
                "emotion": ""
            })
    return {"diaries": result}


@router.post("/api/diary/summarize")
async def summarize_diary(request: SummarizeRequest,
                          agent=Depends(get_agent),
                          diary_storage=Depends(get_diary_storage),
                          current_user: dict = Depends(get_current_user)):
    """用轻量模型快速总结日记 → 2-4 字核心词，存入 calendar_cache"""
    logger.info(f"📝 总结日记: {request.date}")
    summary = agent.summarize_diary(request.content)
    diary_storage.set_summary(request.date, summary, user_id=current_user["id"])
    logger.info(f"  总结词: {summary}")
    return {"status": "ok", "summary": summary}


@router.post("/api/diary/emotion")
async def classify_emotion(request: EmotionClassifyRequest,
                           agent=Depends(get_agent),
                           diary_storage=Depends(get_diary_storage),
                           current_user: dict = Depends(get_current_user)):
    """用轻量模型快速鉴定日记主要情绪 → 存入 calendar_cache"""
    logger.info(f"🎭 情绪分类: {request.date}")
    emotion = agent.classify_emotion(request.content)
    diary_storage.set_emotion(request.date, emotion, user_id=current_user["id"])
    logger.info(f"  情绪: {emotion}")
    return {"status": "ok", "emotion": emotion}


@router.put("/api/diary/emotion")
async def update_emotion(request: EmotionUpdateRequest,
                         diary_storage=Depends(get_diary_storage),
                         current_user: dict = Depends(get_current_user)):
    """用户手动更新某天的情绪标注"""
    logger.info(f"🎭 手动更新情绪: {request.date} → {request.emotion}")
    diary_storage.set_emotion(request.date, request.emotion, user_id=current_user["id"])
    return {"status": "ok"}
