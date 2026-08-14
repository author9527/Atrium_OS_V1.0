# ==========================================
# Atrium OS - 多人 AI 聊天室路由
# 三个硬编码人设（大哥/二弟/小妹），基于冲动值机制决定谁发言
# ==========================================

import json
import re
import asyncio
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from server.app import get_diary_storage
from server.auth import get_current_user
from server import model_service
from server.persona_config import PERSONAS, get_chatroom_personas  # 聊天室三兄妹人设（按账号隔离）
from server.routes.profile_routes import get_interaction_mode
from server.chat_utils import (
    build_unified_history_from_list,
    format_history_readable, get_last_speaker,
    ROLE_TO_SPEAKER, SPEAKER_TO_ROLE, strip_html,
)
from server.web_search_tool import SEARCH_TOOL_SCHEMA, web_search as _do_web_search
from server.logger import logger
from ai.prompt_core import CHATROOM_REPLY_CORE, IMPULSE_SCALE

router = APIRouter()


# ========== 人设配置 ==========
# 聊天室三兄妹（鳄正经/鹅小弟/鹿晓葵）的人设集中定义于 server/persona_config.py，
# 用户可通过人设管理页编辑，此处直接读取中央配置 PERSONAS（活字典，即时生效）。

# 基础冲动值阈值：超过此值才有资格发言
BASE_IMPULSE_THRESHOLD = 50

# 每轮阈值递增量，防止 AI 无休止对话（上限95封顶）
THRESHOLD_ESCALATION = 9

# 同一人设连续发言的最大次数
MAX_CONSECUTIVE_SPEECH = 2

# 聊天室只允许三兄妹发言（鳄正经/鹅小弟/鹿晓葵），
# 排除共情助手(empathy)和觉察伙伴(awareness)，避免它们被冲动值评估选中后顶替三兄妹。
CHATROOM_PERSONA_KEYS = ("big_brother", "second_brother", "little_sister")


# ========== 请求模型 ==========

class ChatHistoryItem(BaseModel):
    role: str
    content: str


class ChatroomRequest(BaseModel):
    message: str
    conversation_history: List[ChatHistoryItem] = []  # 保留兼容，但优先使用 session
    context: str = ""
    rounds_since_last_speech: int = 0
    date: Optional[str] = None
    session_id: Optional[str] = None
    inject_diary: bool = True  # 是否注入指定日期日记（关系/觉察页等传 false）


# ========== 模型配置辅助函数 ==========

def _get_lightweight_model(user_id: str = "default") -> str:
    """获取轻量模型名称（用于冲动值判定）
    使用回复模型，ollama 常驻同一个模型时体验更顺畅
    """
    return model_service.local_model(user_id)


def _get_main_model(user_id: str = "default") -> str:
    """获取主模型名称（用于生成回复）"""
    return model_service.local_model(user_id)


# ========== Ollama 调用（非流式，用于冲动值判定） ==========

def _call_ollama_impulse(prompt: str, model: str, timeout: int = 60,
                         num_predict: int = 16, temperature: float = 0.3) -> str:
    """调用 Ollama 非流式生成（统一走 model_service，轻量调用用于冲动值判定）"""
    return model_service.generate(
        prompt, model=model, timeout=timeout,
        num_predict=num_predict, temperature=temperature,
    )


# ========== 冲动值判定 ==========

def _parse_impulse_value(text: str) -> tuple:
    """从模型输出中解析冲动值和是否需要纠正

    优先 JSON 格式：{"impulse": 75, "correct": false}
    兼容旧格式：75|correct 或 75|normal 或 75

    返回 (impulse_value, wants_correct)
    """
    text = text.strip()
    # 优先尝试 JSON 格式
    try:
        # 提取 JSON 对象（可能被包裹在 markdown 代码块或其他文本中）
        json_match = re.search(r'\{[^{}]*"impulse"[^{}]*\}', text)
        if json_match:
            data = json.loads(json_match.group())
            val = max(0, min(100, int(data.get("impulse", 0))))
            wants_correct = bool(data.get("correct", False))
            return val, wants_correct
    except (json.JSONDecodeError, ValueError, TypeError):
        pass
    # 兼容旧格式：number|flag
    if '|' in text:
        parts = text.split('|', 1)
        match = re.search(r'\d+', parts[0])
        if match:
            val = max(0, min(100, int(match.group())))
            flag_text = parts[1].lower().strip()
            wants_correct = any(kw in flag_text for kw in ['correct', '纠正', 'flaw', '漏洞', '错误'])
            return val, wants_correct
    # 兼容旧格式：只有数字
    match = re.search(r'\d+', text)
    if match:
        return max(0, min(100, int(match.group()))), False
    return 0, False


def _get_impulse(persona_key: str,
                 history_text: str, context: str, interaction_mode: str = "",
                 personas: dict = None) -> int:
    """调用模型获取指定人设的冲动值（0-100）

    prompt 注入：人设、上下文、完整对话记录、评估规则
    history_text: 统一格式 JSON 字符串 [{"speaker": "用户", "content": "..."}]
    personas: 当前账号的人设字典（默认用全局 default）
    """
    personas = personas if personas is not None else PERSONAS
    persona = personas[persona_key]
    ego_with_mode = persona["ego"]
    if interaction_mode:
        ego_with_mode += f"\n\n## 与用户的互动模式\n{interaction_mode}"
    readable_history = format_history_readable(history_text)

    # 判断最近一条消息是否来自当前人设
    last_speaker_name = get_last_speaker(history_text)
    last_speaker_role = SPEAKER_TO_ROLE.get(last_speaker_name, "")
    is_my_last = last_speaker_role == persona_key

    # 评估规则：根据上一条消息的说话者，动态生成
    if is_my_last:
        rules_section = f"""你刚说完话。判断是否需要纠正自己：
- 刚才的发言有漏洞/逻辑错误/不符合人设 → "correct"填true
- 没有问题 → "correct"填false, "impulse"建议填10-30（刚说完话不需要再说）"""
    else:
        rules_section = f"""{last_speaker_name or '用户'}刚说完话。{persona['speak_tendency']}
判断你是否有回应欲望：有 → 较高"impulse"值；没有 → 较低值。"correct"填false。"""

    # 上下文区块
    context_section = context if context else "（无额外上下文）"

    # 冲动值评分标尺（单一来源 ai/prompt_core.py），注入该人设的说话倾向
    impulse_scale = IMPULSE_SCALE.format(speak_tendency=(persona.get("speak_tendency") or ""))

    prompt = f"""## 你的人设
{ego_with_mode}

## 上下文
{context_section}

## 对话记录
{readable_history}

## 评估
{rules_section}

{impulse_scale}

只输出JSON，不要其他内容：
{{"impulse": 0-100, "correct": true/false}}"""

    try:
        model = _get_lightweight_model()
        raw = _call_ollama_impulse(
            prompt=prompt,
            model=model,
            timeout=60,
            num_predict=32,
            temperature=0.3
        )
        raw_impulse, wants_correct = _parse_impulse_value(raw)

        # 程序化应用冲动值调节规则
        if is_my_last:
            if wants_correct:
                final_impulse = min(100, raw_impulse + 10)
                logger.info(f"[气氛组] {persona['name']} 冲动值: {raw_impulse} +10(纠正) = {final_impulse} (原始: {raw.strip()})")
            else:
                final_impulse = max(0, raw_impulse - 20)
                logger.info(f"[气氛组] {persona['name']} 冲动值: {raw_impulse} -20(刚说完) = {final_impulse} (原始: {raw.strip()})")
        else:
            final_impulse = raw_impulse
            logger.info(f"[气氛组] {persona['name']} 冲动值: {final_impulse} (原始: {raw.strip()})")

        return final_impulse
    except Exception as e:
        logger.error(f"[气氛组] {persona['name']} 冲动值判定失败: {e}")
        return 0


def _determine_speaker(impulse_values: dict, threshold: int = None,
                       rounds_since_last_speech: int = 0,
                       allow_fallback: bool = True,
                       last_speaker: str = None,
                       consecutive_count: int = 0,
                       personas: dict = None) -> Optional[str]:
    """根据冲动值决定谁发言

    规则：
    1. 冲动值最高且超过阈值的人设发言
    2. 同一人设连续发言不超过 MAX_CONSECUTIVE_SPEECH 次
    3. 如果都低于阈值，无人发言
    4. 如果 allow_fallback=True 且连续 MAX_SILENCE_ROUNDS 轮无人发言，小妹自动兜底发言

    返回人设 key（如 "big_brother"），或 None 表示无人发言
    """
    personas = personas if personas is not None else PERSONAS
    effective_threshold = threshold if threshold is not None else BASE_IMPULSE_THRESHOLD

    # 按冲动值从高到低排序
    sorted_personas = sorted(impulse_values.items(), key=lambda x: x[1], reverse=True)

    for persona_key, val in sorted_personas:
        # 检查连续发言限制
        if persona_key == last_speaker and consecutive_count >= MAX_CONSECUTIVE_SPEECH:
            logger.info(f"[气氛组] {personas[persona_key]['name']} 已连续发言 {consecutive_count} 次，跳过")
            continue

        if val >= effective_threshold:
            logger.info(f"[气氛组] 发言者: {personas[persona_key]['name']} (冲动值 {val} >= {effective_threshold})")
            return persona_key

    # 所有人都低于阈值或被跳过
    if allow_fallback:
        logger.info("[气氛组] 无人发言，小妹兜底")
        return "little_sister"

    logger.info(f"[气氛组] 无人发言 (阈值: {effective_threshold}, 已沉默 {rounds_since_last_speech} 轮)")
    return None


# ========== 主回复 Prompt 构建 ==========

def _build_reply_prompt(persona_key: str, user_message: str,
                        history_text: str, context: str, interaction_mode: str = "",
                        personas: dict = None, search_results: list = None) -> tuple:
    """构建主回复的 (system_prompt, user_prompt)

    user_message 可能为空（AI 之间对话轮次），此时根据对话上下文自然回应。
    history_text: 统一格式 JSON 字符串 [{"speaker": "用户", "content": "..."}]
    personas: 当前账号的人设字典（默认用全局 default）
    search_results: 联网搜索结果列表（已存在时注入 prompt）
    """
    personas = personas if personas is not None else PERSONAS
    persona = personas[persona_key]
    readable_history = format_history_readable(history_text)

    interaction_section = ""
    if interaction_mode:
        interaction_section = "\n\n## 与用户的互动模式\n" + interaction_mode

    # 聊天室人格核心单一来源（ai/prompt_core.py），只注入用户自定义 ego 与互动模式
    system_prompt = CHATROOM_REPLY_CORE.format(
        ego=persona["ego"],
        interaction_section=interaction_section,
    )

    # 识别上一条消息的说话者，用于关系动态提醒
    last_speaker_name = get_last_speaker(history_text)
    last_speaker_key = SPEAKER_TO_ROLE.get(last_speaker_name, "")

    relationship_hint = ""
    if last_speaker_key and last_speaker_key != "user" and last_speaker_key != persona_key:
        if persona_key == "little_sister" and last_speaker_key == "second_brother":
            relationship_hint = "\n（鹅小弟刚说完，你倾向于反驳鹅小弟，鹅小弟要是说了过分的话你可以怼鹅小弟，但如果觉得鹅小弟说得有道理你也不会强行反驳鹅小弟，鹅小弟说得有道理的部分也可以接过来用，并给予鹅小弟一定肯定。如果鹅小弟太过分，比如侮辱用户，你会突然爆发，怼鹅小弟。但你的锋芒只对鹅小弟，绝不会泄漏到对用户的态度中，比如骂完鹅小弟后对用户说的第一句话，必须用最温柔的语气开头。你骂鹅小弟是因为你了解鹅小弟，知道鹅小弟不会真跟你翻脸。）"
        elif persona_key == "little_sister" and last_speaker_key == "big_brother":
            relationship_hint = "\n（鳄正经刚说完，你依赖鳄正经，觉得有鳄正经在就踏实。鳄正经说话时你会安静听，偶尔补充两句。你不会跟鳄正经顶嘴）"
        elif persona_key == "second_brother" and last_speaker_key == "big_brother":
            relationship_hint = "\n（鳄正经刚说完，你嘴上不服鳄正经，但心里其实怕鳄正经。鳄正经一旦语气沉下来，你就下意识收敛，嘴硬两句就不吭声了。你不会当面跟鳄正经硬刚。如果鳄正经拿事实反驳你，你虽然嘴上说「切」，但心里会默默认错。）"
        elif persona_key == "second_brother" and last_speaker_key == "little_sister":
            relationship_hint = "\n（鹿晓葵刚说完，你有时候说话不过脑子会得罪鹿晓葵，但鹿晓葵要是真急了骂你，你也讪讪的不敢还嘴——毕竟鹿晓葵是妹妹，你不好意思跟鹿晓葵真吵。）"
        elif persona_key == "big_brother" and last_speaker_key == "second_brother":
            relationship_hint = "\n（鹅小弟刚说完，你了解鹅小弟心直口快但心不坏。当鹅小弟说话太过分时，你会带点无奈地敲打鹅小弟一句，语气不重但让鹅小弟不敢吭声。你不会经常管鹅小弟，只在必要时出面。）"
        elif persona_key == "big_brother" and last_speaker_key == "little_sister":
            relationship_hint = "\n（鹿晓葵刚说完，你知道鹿晓葵嘴上不饶人但心地善良。你欣赏鹿晓葵的体贴，偶尔会温和地帮鹿晓葵圆场。）"

    # 用户消息触发行（代替旧版独立的"用户最新消息"区块）
    if user_message:
        trigger_section = f"用户刚才说：{user_message}"
    else:
        trigger_section = "（AI之间对话轮次，根据上面的对话自然接话）"

    # 联网搜索结果注入（仅在有结果时）
    search_section = ""
    if search_results:
        results_text = "\n".join(
            f"{i}. {r.get('title', '')}: {r.get('content', '')}（{r.get('url', '')}）"
            for i, r in enumerate(search_results[:5], 1)
        )
        if results_text:
            search_section = (
                "\n\n【联网搜索结果（如与话题相关可引用，不相关则忽略）】\n"
                + results_text
                + "\n\n【引用标注规则】上面每条结果前面的数字序号就是引用编号。"
                "若你引用了某条来源的信息，在该句结尾紧跟带方括号的上标序号标注，例如 xxx[1]；"
                "同一来源多次引用用同一编号；未引用任何搜索结果时不要加角标。"
            )

    user_prompt = f"""## 用户档案与上下文
{context if context else '（无额外上下文）'}

## 气氛组对话记录
{readable_history}

{trigger_section}{relationship_hint}{search_section}

请以「{persona['name']}」的身份回复："""

    return system_prompt, user_prompt


# ========== 联网搜索：追问意图识别 ==========

def _is_followup_request(text: str) -> bool:
    """判断用户消息是否为追问详情/展开/更新的明确意图（此时应强制联网搜索）。"""
    if not text:
        return False
    keywords = (
        "详细", "具体", "展开", "继续", "介绍一下", "介绍", "更多",
        "最新", "更新", "细说", "说说", "究竟", "到底", "怎么回事",
        "后续", "详情", "深入", "展开说说", "结果如何", "进展",
    )
    return any(k in text for k in keywords)


# 去掉时效/冗余修饰词，供换词重试时得到更宽松的查询
_ALT_STRIP_RE = re.compile(r"(最新消息|最新|最近|近期|今天|今日|本周|本月|今年|当下|目前|现在|当下|热搜|热点|时事|刚刚|突发|到底|究竟|怎么回事)")


def _build_alt_queries(query: str, user_input: str) -> list:
    """基于原查询生成多条改写/扩展候选查询词（供无结果时重试）。

    组合两类来源：
      1. 启发式：去掉时效/空泛修饰词，得到更宽松的查询；
      2. 模型生成：让本地模型根据用户意图生成更可能命中的口语化备选词。
    """
    candidates = []
    stripped = _ALT_STRIP_RE.sub("", query or "").strip()
    if stripped and stripped != query:
        candidates.append(stripped)
    try:
        prompt = (
            "你是搜索引擎查询词优化器。下面是一次搜不到结果的查询，"
            "请生成 3 个更有可能搜到信息的备选查询词。\n"
            f"用户意图（原话）：{user_input}\n"
            f"原查询词：{query}\n"
            "要求：\n"
            "- 每条独立成行，不要编号、不要引号、不要多余解释\n"
            "- 用更常见、更口语化、更宽泛一点的词替换过于生僻/过于具体的词\n"
            "- 去掉时效性修饰词（如 最新/今天/最近/热点）\n"
            "- 若原查询过于空泛（只有一两个泛动词），补出核心名词\n"
            "- 保持中文，与用户语言一致\n"
        )
        raw = model_service.generate(prompt, num_predict=140, temperature=0.4)
        for line in raw.splitlines():
            line = line.strip().strip("0123456789.、-*\"'「」()（）")
            if line and 2 <= len(line) <= 40 and line not in candidates:
                candidates.append(line)
    except Exception as e:
        logger.warning(f"⚠️ [气氛组] 生成备用查询词失败: {e}")
    return candidates[:4]


def _search_with_retry(query: str, user_input: str, max_attempts: int = 4):
    """联网搜索，并在无结果时自动换词重试。

    返回 (results, 最终命中的查询词, 尝试过的查询词列表)：
      - 先直接搜模型给的查询词；若 0 条，追加改写 + 模型生成的备用查询词逐条重试；
      - 全部失败则返回 (空列表, 首词, 尝试列表)，不阻断主流程。
    """
    if not query:
        query = (user_input or "").strip()
    candidates = [query] + _build_alt_queries(query, user_input)
    tried, seen = [], set()
    for q in candidates:
        q = (q or "").strip()
        if q and q not in seen:
            seen.add(q)
            tried.append(q)
    for q in tried[: max_attempts or 1]:
        results = _do_web_search(q)
        if results:
            return results, q, tried[:tried.index(q) + 1]
    return [], tried[0], tried



# ========== API 路由 ==========

@router.get("/api/chatroom/personas")
async def get_personas(current_user: dict = Depends(get_current_user)):
    """获取聊天室人设列表（按当前账号隔离）

    只返回三兄妹（鳄正经/鹅小弟/鹿晓葵），与发言筛选 CHATROOM_PERSONA_KEYS 保持一致，
    排除共情助手/觉察伙伴，避免前端把助手角色误当成聊天室成员。
    """
    personas = get_chatroom_personas(current_user["id"])
    return {
        "personas": {
            key: {"name": info["name"]}
            for key, info in personas.items()
            if key in CHATROOM_PERSONA_KEYS
        }
    }


@router.post("/api/chatroom/chat")
async def chatroom_chat(request: ChatroomRequest,
                        current_user: dict = Depends(get_current_user),
                        diary_storage=Depends(get_diary_storage)):
    """多人 AI 聊天室 - SSE 流式端点（支持 AI 之间连续对话）

    流程：
    1. 用户消息加入历史，并行获取3个人设冲动值
    2. 冲动值最高且超过阈值的人设发言，流式输出思考+回复
    3. 该人设说完后，再次评估所有人设冲动值（阈值递增）
    4. 如果仍有人超过阈值，继续发言（AI 互相对话）
    5. 直到无人超过阈值或达到最大轮数，结束 SSE 流

    SSE 事件格式：
    - {"type": "speaker", "speaker": "...", "speaker_name": "...", "impulse_values": {...}}
    - {"type": "thinking", "content": "..."}
    - {"type": "response", "content": "..."}
    - {"type": "silence", "impulse_values": {...}}
    - {"type": "round_end", "round": N, "next_threshold": T}
    - {"type": "error", "content": "..."}
    - 结束标记: [DONE]
    """
    logger.info(f"[气氛组] 用户 {current_user['username']} 发送消息: {request.message[:50]}...")
    # 挂载该账号的模型配置到请求上下文（contextvar 并发隔离）
    model_service.set_user_config(current_user["id"])

    # 获取日记内容并注入到上下文中
    full_context = request.context or ""
    if request.date and request.inject_diary:
        diary = diary_storage.get_diary_by_date(request.date, user_id=current_user["id"])
        if diary and diary.content:
            diary_block = f"【今日日记】\n{strip_html(diary.content)}"
            full_context = (full_context + "\n\n" + diary_block).strip() if full_context else diary_block

    # 优先从 session 加载历史，如果没有 session 则用前端传入的 conversation_history
    # 内部 history 使用 {"role": "...", "content": "..."} 格式（兼容数据库存储）
    # history_text 使用统一 JSON 格式 [{"speaker": "...", "content": "..."}]（所有AI共享）
    if request.session_id:
        # 会话归属校验：确认该会话属于当前用户，防止跨用户读取/写入他人会话
        owner = diary_storage.get_session_owner(request.session_id)
        if owner is None or owner != current_user["id"]:
            raise HTTPException(status_code=404, detail="会话不存在")
        session_msgs = diary_storage.get_messages(request.session_id)
        history = [
            {"role": m.get("role", ""), "content": m.get("content", "")}
            for m in session_msgs
            if m.get("content")
        ]
    else:
        history = [
            item.model_dump() if hasattr(item, "model_dump") else dict(item)
            for item in request.conversation_history
        ]
    history.append({"role": "user", "content": request.message})
    # 构建统一格式 history_text（所有AI prompt 共用此格式）
    history_text = build_unified_history_from_list(history)
    # 记录本轮开始前的历史长度，后续保存时只保存新增的 AI 回复
    initial_history_len = len(history)

    main_model = _get_main_model()
    queue = asyncio.Queue()
    # 当前账号的人设（按账号隔离）
    personas = get_chatroom_personas(current_user["id"])
    # 聊天室只保留三兄妹，排除共情助手/觉察伙伴，防止它们被冲动值评估选中后顶替发言
    personas = {k: v for k, v in personas.items() if k in CHATROOM_PERSONA_KEYS}

    def _mode_for(speaker_key: str) -> str:
        return get_interaction_mode(diary_storage, current_user["id"], speaker_key)

    def _evaluate_impulses(htext: str) -> dict:
        """并行获取3个人设的冲动值"""
        impulse_values = {}
        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = {
                executor.submit(
                    _get_impulse, pk, htext, full_context, _mode_for(pk), personas
                ): pk
                for pk in personas
            }
            for future in as_completed(futures):
                pk = futures[future]
                try:
                    impulse_values[pk] = future.result()
                except Exception as e:
                    logger.error(f"[气氛组] {pk} 冲动值获取异常: {e}")
                    impulse_values[pk] = 0
        return impulse_values

    def _emit_event(payload: dict):
        """向 SSE 队列发送一个事件（队列满时静默丢弃，不阻塞主流程）"""
        data = json.dumps(payload, ensure_ascii=False)
        try:
            queue.put_nowait(f"data: {data}\n\n")
        except asyncio.QueueFull:
            pass

    def _stream_one_response(speaker_key: str, user_msg: str, htext: str):
        """单次流式决策 + 回复（与共情助手一致）。

        直接以「带工具的回答流」开始，模型在同一个流式请求里自行决定是直接回答
        还是调用 web_search，不再先单独跑一轮非流式决策拖慢首 token（输出与决策同时做）。
        返回 (full_response, full_thinking)。
        """
        system_prompt, user_prompt = _build_reply_prompt(
            speaker_key, user_msg, htext, full_context, _mode_for(speaker_key), personas
        )
        # 追问/展开场景：在 prompt 末尾诱导联网搜索（单次流式决策里模型会据此调用工具）
        if user_msg and _is_followup_request(user_msg):
            user_prompt = (
                user_prompt
                + "\n\n（用户在追问/请求展开详情，若问题涉及需要最新或更具体的信息，"
                  "请调用 web_search 工具联网搜索后再回答；搜索词应结合上文把用户零碎的话补全成具体查询词，"
                  "不要逐字搜索用户原话，也不要因缺少资料而敷衍。）"
            )

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]
        full_response = ""
        full_thinking = ""
        tool_called = False
        search_sources = []

        try:
            # 单次流式决策：带工具的回答流，输出与决策同时进行
            for ch in model_service.chat_tools_stream(
                messages, model=main_model, tools=[SEARCH_TOOL_SCHEMA],
                think=False, num_predict=2048, temperature=0.6,
            ):
                if ch.get("type") == "tool_call" and ch.get("name") == "web_search":
                    tool_called = True
                    try:
                        args = json.loads(ch.get("arguments") or "{}")
                    except (json.JSONDecodeError, TypeError):
                        args = {}
                    query = (args.get("query") or user_msg or "").strip()
                    results, used_query, tried = _search_with_retry(query, user_msg or "")
                    for q in tried:
                        _emit_event({"type": "search_query", "content": f"正在联网搜索：{q}", "query": q})
                    logger.info(f"🔎 [气氛组] 联网搜索: 尝试 {tried}，命中「{used_query}」，共 {len(results)} 条")
                    _emit_event({"type": "search_done", "content": f"已找到 {len(results)} 条相关结果", "query": used_query, "count": len(results), "results": results})
                    search_sources = [
                        {"index": i + 1, "title": r.get("title", ""), "url": r.get("url", "")}
                        for i, r in enumerate(results)
                    ]
                    if results:
                        system_prompt, user_prompt = _build_reply_prompt(
                            speaker_key, user_msg, htext, full_context,
                            _mode_for(speaker_key), personas, search_results=results
                        )
                        logger.info(f"🔎 [气氛组] 已注入 {len(results)} 条搜索结果")
                    break  # 停止带工具的第一遍，进入正常回答流
                elif ch.get("type") == "response":
                    full_response += ch.get("content", "")
                    _emit_event({"type": "response", "content": ch.get("content", "")})
                elif ch.get("type") == "thinking":
                    full_thinking += ch.get("content", "")
        except Exception as e:
            logger.error(f"[气氛组] 流式生成异常: {e}")
            _emit_event({"type": "error", "content": str(e)})

        # 模型调用了 web_search：注入结果后走正常回答流
        if tool_called:
            try:
                for chunk in model_service.generate_stream(
                    user_prompt, model=main_model, system=system_prompt,
                    think=False, num_predict=2048, temperature=0.6,
                ):
                    token = chunk.get("content", "")
                    if token:
                        full_response += token
                        _emit_event({"type": "response", "content": token})
            except Exception as e:
                logger.error(f"[气氛组] 流式生成异常: {e}")
                _emit_event({"type": "error", "content": str(e)})

        return full_response, full_thinking, search_sources

    def sync_producer():
        """连续对话主循环：在线程池中运行"""
        threshold = BASE_IMPULSE_THRESHOLD
        total_rounds = 0
        last_speaker = None
        consecutive_count = 0
        round_sources = []  # 每轮 AI 发言的搜索引用来源，与 history 新增条目一一对应
        # 声明使用外部变量，避免局部变量未赋值错误
        nonlocal history_text

        while True:
            # 第一步：评估冲动值
            impulse_values = _evaluate_impulses(history_text)

            # 连续发言惩罚已注释掉，由 LLM 自行判断
            # if last_speaker and last_speaker in impulse_values:
            #     penalty = CONSECUTIVE_PENALTY * consecutive_count
            #     original_val = impulse_values[last_speaker]
            #     impulse_values[last_speaker] = max(0, original_val - penalty)
            #     if penalty > 0:
            #         print(f"[气氛组] {PERSONAS[last_speaker]['name']} 连续发言惩罚: {original_val} - {penalty} = {impulse_values[last_speaker]}")

            logger.info(f"[气氛组] 第{total_rounds + 1}轮冲动值汇总: {impulse_values} (阈值: {threshold})")

            # 第二步：决定谁说话
            # 第一轮允许小妹兜底，后续轮不允许（无人想说话就结束）
            allow_fallback = (total_rounds == 0)
            speaker = _determine_speaker(
                impulse_values, threshold,
                rounds_since_last_speech=request.rounds_since_last_speech if total_rounds == 0 else 0,
                allow_fallback=allow_fallback,
                last_speaker=last_speaker,
                consecutive_count=consecutive_count,
                personas=personas
            )

            # 第三步：无人发言
            if speaker is None:
                if total_rounds == 0:
                    # 第一轮就无人发言，发送 silence
                    data = json.dumps(
                        {"type": "silence", "impulse_values": impulse_values},
                        ensure_ascii=False
                    )
                    try:
                        queue.put_nowait(f"data: {data}\n\n")
                    except asyncio.QueueFull:
                        pass
                else:
                    # 后续轮无人发言，正常结束对话
                    logger.info(f"[气氛组] 第{total_rounds + 1}轮无人发言，对话自然结束")
                break

            # 第四步：发送说话者标记
            speaker_data = json.dumps(
                {
                    "type": "speaker",
                    "speaker": speaker,
                    "speaker_name": personas[speaker]["name"],
                    "impulse_values": impulse_values,
                    "round": total_rounds + 1
                },
                ensure_ascii=False
            )
            try:
                queue.put_nowait(f"data: {speaker_data}\n\n")
            except asyncio.QueueFull:
                pass

            # 第五步：流式生成回复
            logger.info(f"[气氛组] 第{total_rounds + 1}轮: {personas[speaker]['name']} 开始发言...")
            user_msg_for_reply = request.message if total_rounds == 0 else ""
            full_response, full_thinking, search_sources = _stream_one_response(
                speaker, user_msg_for_reply, history_text
            )
            round_sources.append(search_sources)

            # 第六步：将回复加入历史（即使为空也记录，防止AI看不到自己发言）
            if not full_response:
                full_response = "（沉默）"
            history.append({"role": speaker, "content": full_response})
            # 重建统一格式 history_text（包含最新发言）
            history_text = build_unified_history_from_list(history)

            # 第七步：更新连续发言计数
            if speaker == last_speaker:
                consecutive_count += 1
            else:
                last_speaker = speaker
                consecutive_count = 1

            # 第八步：发送轮次结束标记
            round_end_data = json.dumps(
                {
                    "type": "round_end",
                    "round": total_rounds + 1,
                    "speaker": speaker,
                    "next_threshold": threshold + THRESHOLD_ESCALATION
                },
                ensure_ascii=False
            )
            try:
                queue.put_nowait(f"data: {round_end_data}\n\n")
            except asyncio.QueueFull:
                pass

            # 第九步：递增阈值（上限95封顶），进入下一轮
            threshold = min(95, threshold + THRESHOLD_ESCALATION)
            total_rounds += 1
            logger.info(f"[气氛组] 第{total_rounds}轮完成，阈值升至 {threshold}")

        logger.info(f"[气氛组] 对话结束，共 {total_rounds} 轮")

        # 保存消息到会话数据库（只保存本轮新增的消息，避免重复）
        if request.session_id:
            try:
                diary_date_label = ""
                if request.date:
                    parts = request.date.split("-")
                    if len(parts) == 3:
                        diary_date_label = f"{parts[0][2:]}年{parts[1]}月{parts[2]}日"
                diary_storage.add_message(request.session_id, "user", request.message, "", diary_date_label)
                for i in range(initial_history_len, len(history)):
                    msg = history[i]
                    if msg.get("content"):
                        src_idx = i - initial_history_len
                        srcs = round_sources[src_idx] if src_idx < len(round_sources) else []
                        diary_storage.add_message(
                            request.session_id, msg["role"], msg["content"], "",
                            diary_date_label, search_sources=json.dumps(srcs, ensure_ascii=False),
                        )
                new_count = len(history) - initial_history_len
                logger.info(f"✅ 气氛组消息已保存到会话 {request.session_id[:8]}... (新增 {new_count} 条)")
            except Exception as e:
                logger.error(f"⚠️ 保存气氛组消息到会话失败: {e}")

        try:
            queue.put_nowait("data: [DONE]\n\n")
        except asyncio.QueueFull:
            pass

    async def generate():
        # 启动连续对话主循环（在线程池中运行）
        loop = asyncio.get_event_loop()
        loop.run_in_executor(None, sync_producer)
        # 从队列中取出数据并 yield
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
