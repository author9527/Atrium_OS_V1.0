# ==========================================
# Atrium OS - 用户档案路由
# 功能：生成/获取用户心理档案（人格特质+行为模式+核心矛盾）
# 更新策略：增量融合 + 结构化 JSON
#   触发时机：每次保存日记后检查，距上次生成新增 ≥ PROFILE_INTERVAL 篇则更新
#   生成方式：旧档案 + 本次新增日记 → LLM 融合更新 → 输出完整新档案 JSON
# ==========================================

from fastapi import APIRouter, Depends
from server.app import get_diary_storage, get_agent
from server.auth import get_current_user
from server.logger import logger
from server.chat_utils import strip_html
import json
import os
import threading

router = APIRouter()

INSIGHT_DIR = "data"
# 每新增多少篇日记触发一次档案更新
PROFILE_INTERVAL = 5

# 档案的固定维度结构（供前端解析与各 AI 注入）
PROFILE_DIMENSIONS = [
    "personality_traits",    # 人格特质
    "behavior_patterns",     # 行为模式
    "core_conflicts",        # 核心矛盾
    "relationship_dynamics", # 关系动态
    "supplementary",         # 补充维度（LLM 自主决定）
]

# ========== AI 注册表（互动模式生成用） ==========
# 注意：这里只提供"人设描述"作为参数，生成模板本身不写死任何 AI 名字。
# 未来新增 AI 角色只需在此登记一条即可。

ROLE_TYPE_CHATROOM = "chatroom"
ROLE_TYPE_ASSISTANT = "assistant"


def _load_insight_text(user_id: str) -> str:
    """读取用户觉察报告，拼成纯文本"""
    insight_file = os.path.join(INSIGHT_DIR, f"insight_results_{user_id}.json")
    if not os.path.exists(insight_file):
        return ""
    try:
        with open(insight_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        results = data.get("results", [])
        texts = []
        for r in results:
            main_text = r.get("raw_text") or r.get("text") or r.get("summary") or ""
            if main_text:
                texts.append(main_text)
            for branch in r.get("branches", []):
                branch_text = branch.get("insight") or branch.get("text") or ""
                if branch_text:
                    texts.append(branch_text)
        return "\n\n".join(texts)
    except Exception:
        return ""


def _get_ai_persona(user_id: str, ai_key: str) -> dict:
    """根据账号 + AI 注册表 key 返回该 AI 的人设信息。

    返回 {name, ego, speak_tendency, role_type}。
    - 聊天室角色（big_brother/second_brother/little_sister）：运行时从该账号中央配置导入
    - 助手角色（empathy/awareness）：从该账号中央配置 import
    - 其他：返回空 ego，作为通用助手角色
    """
    from server.persona_config import get_persona
    persona = get_persona(user_id, ai_key)
    role_type = persona.get("role", ROLE_TYPE_ASSISTANT)
    return {
        "name": persona.get("name", "") or "",
        "ego": persona.get("ego", "") or "",
        "speak_tendency": persona.get("speak_tendency", "") or "",
        "role_type": role_type,
    }


def _build_interaction_mode_prompt(profile: str, persona: dict) -> tuple:
    """基于用户心理档案 + 一个 AI 角色性格，设计互动模式手册。

    profile: 用户心理档案文本
    persona: _get_ai_persona 返回的人设信息 dict
    返回 (system, user_prompt)。
    """
    system = """你是一位互动模式设计师。你的任务是基于一份用户心理档案与一个 AI 角色的性格，为该 AI 设计一本"互动模式手册"，让它在与用户相处时活起来、有温度、不机械。

【设计原则】
- 严格贴合给定的用户心理档案与该 AI 的性格设定，不要套用通用模板
- 让 AI"活起来"：有状态切换，有冲突与张力，但绝不越界、不伤害用户
- 冲突/点破是为了用户好，是关系的自然起伏，而非机械套路
- 每条内容要具体、可执行，避免空泛口号

【输出格式】必须只输出一个合法 JSON 对象，结构固定如下（不要任何解释、开场白或多余文本）：
{
  "user_understanding": ["对用户核心特质的理解，数组，每条一句话"],
  "register": "与该用户相处时的基调/开场方式，字符串",
  "emotional_triggers": ["该用户的情绪触发点，以及应如何承接，数组"],
  "conflict_mode": ["用户自我矛盾或状态不佳时，AI 如何表达冲突/张力，数组"],
  "boundary": ["AI 互动的边界与底线，数组"]
}"""

    role_hint = (
        "该AI是气氛组中的家人角色，可以存在家人间的怼、怕、温柔、抢话等冲突。"
        if persona.get("role_type") == ROLE_TYPE_CHATROOM
        else "该AI是陪伴/觉察助手。它的'冲突/状态切换'不是抱怨，而是在用户自我矛盾时温和地点破、表达作为伙伴的担心，而不是一味顺着用户。"
    )

    user_prompt = f"【用户心理档案】\n{profile}\n\n【该AI性格设定】\n{persona['ego']}"

    speak_tendency = persona.get("speak_tendency", "")
    if speak_tendency:
        user_prompt += f"\n\n【该AI说话风格】\n{speak_tendency}"

    user_prompt += f"\n\n【角色类型】\n{role_hint}"

    return system, user_prompt


def _build_profile_prompt(old_profile: str, new_diaries_text: str, insight_text: str) -> tuple:
    """构建用户档案生成提示词（增量融合 + 结构化 JSON）

    old_profile: 旧档案（首次生成时为空字符串）
    new_diaries_text: 本次新增的日记文本
    insight_text: 觉察报告文本
    返回 (system, user_prompt)。
    """
    system = """你是一位深度心理分析专家。你的任务是维护一份关于用户的成长档案。

【核心原则】
- 基于「旧档案」与「新增日记/觉察报告」，融合更新，而非从零重写
- 保留仍然成立的旧洞察；更新已经变化的部分；移除不再符合的描述；补充新发现的模式
- 提炼深层模式，不罗列事实；用简洁但深刻的语言
- 单个、孤立的生活事件（如一次购物失误、一次情绪爆发）只作为情境背景，不要当作稳定的人格特质反复强调；重点提炼跨事件反复出现的稳定行为模式与深层心理结构

【输出格式】必须输出一个合法 JSON 对象，结构固定如下：
{
  "basic_info": {
    "name": "姓名（从日记中提取，无法确定则填空串）",
    "nickname": "外号/昵称（从日记中提取，无法确定则填空串）",
    "identity": "主要身份/社会身份/职业（从日记中提取，无法确定则填空串）",
    "age": "年龄（从日记中提取，无法确定则填空串）",
    "gender": "性别（从日记中提取，无法确定则填空串）",
    "birthday": "生日（从日记中提取，无法确定则填空串）",
    "address": "住址/所在地（从日记中提取，无法确定则填空串）",
    "relationship_status": "感情状态（单身/恋爱/已婚等，从日记中提取，无法确定则填空串）",
    "hometown": "家乡（从日记中提取，无法确定则填空串）",
    "education": "教育背景/学历（从日记中提取，无法确定则填空串）",
    "hobbies": "兴趣爱好（从日记中提取，无法确定则填空串）"
  },
  "personality_traits": ["人格特质，每条一句话"],
  "behavior_patterns": ["行为模式，可含触发情境与应对策略"],
  "core_conflicts": ["核心矛盾，内心深处的冲突与纠结"],
  "relationship_dynamics": ["关系动态，与重要他人的互动模式"],
  "supplementary": ["补充维度，自主判断需要补充的其他重要信息"]
}
要求：
- basic_info 中的每个字段从日记中提取，无法确定的信息就填空串，不要编造
- 每个数组至少 2 条，最多 6 条
- 只输出 JSON 本身，不要任何解释、开场白或多余文本
- 若旧档案为空（首次生成），则完全基于新增日记提炼"""

    if old_profile:
        old_section = f"""══════════════════════════════════════════
【旧档案】(JSON)
══════════════════════════════════════════
{old_profile}

"""
    else:
        old_section = "（首次生成，无旧档案）\n\n"

    user_prompt = f"""{old_section}
══════════════════════════════════════════
【本次新增日记】(按日期排列)
══════════════════════════════════════════
{new_diaries_text}

══════════════════════════════════════════
【觉察报告】
══════════════════════════════════════════
{insight_text if insight_text else "（暂无觉察报告）"}

请基于以上内容，融合更新用户档案，输出完整新档案 JSON。"""

    return system, user_prompt


def _extract_profile_json(raw: str) -> str:
    """从 LLM 输出中提取合法 JSON，若失败则返回原始文本（前端可降级展示）"""
    if not raw:
        return ""
    text = raw.strip()
    # 去掉可能的 ```json 代码块包裹
    if text.startswith("```"):
        lines = text.split("\n")
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    # 尝试解析 JSON，若不合法则返回原文本
    try:
        json.loads(text)
        return text
    except Exception:
        return raw.strip()


def _save_basic_info_from_profile(diary_storage, user_id: str, profile_json: str):
    """从档案 JSON 中提取 basic_info，保存到 user_meta（仅填充空白字段，不覆盖已有值）"""
    try:
        data = json.loads(profile_json)
        basic_info = data.get("basic_info", {})
        if not isinstance(basic_info, dict) or not basic_info:
            return
        # 读取当前已保存的基础信息，仅填充空白字段
        current_raw = diary_storage.get_user_meta(user_id, "basic_info")
        current = {}
        if current_raw:
            try:
                current = json.loads(current_raw)
            except Exception:
                current = {}
        if not isinstance(current, dict):
            current = {}
        changed = False
        for field in ("name", "nickname", "identity", "age", "gender", "birthday", "address", "relationship_status", "hometown", "education", "hobbies"):
            val = (basic_info.get(field) or "").strip()
            if val and not (current.get(field) or "").strip():
                current[field] = val
                changed = True
        if changed:
            diary_storage.set_user_meta(user_id, "basic_info", json.dumps(current, ensure_ascii=False))
            logger.info(f"✅ 基础信息已自动填充 (user={user_id})")
    except Exception as e:
        logger.warning(f"⚠️ 基础信息提取失败: {e}")


def generate_user_profile(diary_storage, agent, user_id: str) -> str:
    """生成/更新用户档案（增量融合，覆盖旧档案），返回新档案 JSON 文本"""
    # 1. 获取全部日记，按日期排序
    diaries = diary_storage.get_all_diaries(user_id)
    valid = [d for d in diaries if d.content and len(d.content) > 10]
    total_count = len(valid)
    if total_count == 0:
        return ""

    # 2. 区分旧档案与新增日记
    old_profile = diary_storage.get_user_profile(user_id)
    last_count = diary_storage.get_user_profile_diary_count(user_id)

    # 增量：取上次生成计数之后的新增日记
    new_diaries = valid[last_count:] if last_count > 0 else valid

    # 首次生成需至少满 PROFILE_INTERVAL 篇；增量则至少新增 1 篇
    if not old_profile and total_count < PROFILE_INTERVAL:
        return ""
    if not new_diaries:
        return old_profile

    new_diaries_text = "\n\n".join(
        f"【{d.date}】\n{strip_html(d.content)}" for d in new_diaries
    )
    # 截断，避免超长
    if len(new_diaries_text) > 6000:
        new_diaries_text = new_diaries_text[-6000:]

    # 3. 获取觉察报告
    insight_text = _load_insight_text(user_id)

    # 4. 调用 LLM 生成档案
    system, prompt = _build_profile_prompt(old_profile, new_diaries_text, insight_text)
    raw = agent._call_ollama(prompt, system, json_mode=True)
    if isinstance(raw, dict):
        profile = raw.get("response", "")
    else:
        profile = str(raw)

    profile_json = _extract_profile_json(profile)

    # 5. 保存到数据库，记录本次日记基数
    if profile_json.strip():
        # 从档案中剥离 basic_info（不存入 user_profiles 的心理分析 JSON）
        # 但保留完整的 profile_json 以便前端展示 basic_info 字段
        diary_storage.save_user_profile(user_id, profile_json.strip(), total_count)
        # 同步提取 basic_info 到 user_meta（仅填充空白字段）
        _save_basic_info_from_profile(diary_storage, user_id, profile_json.strip())
        logger.info(f"✅ 用户档案已更新 (user={user_id}, total={total_count}, new={len(new_diaries)}, {len(profile_json)} chars)")

    return profile_json.strip()


# 内存缓存：{(user_id, ai_key): content}，重新生成时更新
_interaction_mode_cache = {}


def _persona_fingerprint(user_id: str, ai_key: str) -> str:
    """计算某 AI 人设的稳定指纹（name + ego + speak_tendency）。

    用于判断"人设是否真的被修改"：只要这三个源字段完全没变，指纹就相同，
    互动手册无需作废；只要任一字段内容变化，指纹就不同，认定人设已变更。
    仅浏览人设页面不会改变这些字段，因此不会误触发作废。
    """
    from server.persona_config import get_persona
    persona = get_persona(user_id, ai_key) or {}
    parts = [
        persona.get("name", "") or "",
        persona.get("ego", "") or "",
        persona.get("speak_tendency", "") or "",
    ]
    return "::".join(parts)


def _interaction_meta_key(ai_key: str) -> str:
    """互动手册对应的指纹存储键（user_meta）。"""
    return f"interaction_persona_fp::{ai_key}"


def _is_interaction_stale(diary_storage, user_id: str, ai_key: str,
                          content: str) -> bool:
    """判断某人设的互动手册是否因人设变更而过期。

    逻辑：把"生成/读取手册时寄存器记录的人设指纹"与"当前人设指纹"对比。
    - 手册内容为空 → 视为无手册，不算过期；
    - 没有历史指纹记录（首次生成前的旧数据）→ 记录当前指纹，不算过期；
    - 指纹一致 → 人设未变，手册仍有效；
    - 指纹不同 → 人设确实被修改过，手册作废（返回 True）。
    """
    if not content.strip():
        return False
    meta_key = _interaction_meta_key(ai_key)
    stored_fp = diary_storage.get_user_meta(user_id, meta_key)
    current_fp = _persona_fingerprint(user_id, ai_key)
    if not stored_fp:
        # 首次记录指纹（兼容历史未记录指纹的手册）
        diary_storage.set_user_meta(user_id, meta_key, current_fp)
        return False
    if stored_fp != current_fp:
        # 人设确有变更：作废手册并更新指纹，下次对话懒加载重新生成
        diary_storage.set_user_meta(user_id, meta_key, current_fp)
        return True
    return False


def generate_interaction_mode(diary_storage, agent, user_id: str, ai_key: str) -> str:
    """为指定 AI 生成互动模式手册（覆盖保存），返回 JSON 文本；失败返回空串"""
    profile = diary_storage.get_user_profile(user_id)
    if not profile.strip():
        return ""
    persona = _get_ai_persona(user_id, ai_key)
    if not persona["ego"]:
        return ""
    valid_count = len([d for d in diary_storage.get_all_diaries(user_id)
                       if d.content and len(d.content) > 10])
    system, prompt = _build_interaction_mode_prompt(profile, persona)
    raw = agent._call_ollama(prompt, system, json_mode=True)
    if isinstance(raw, dict):
        content = raw.get("response", "")
    else:
        content = str(raw)
    content = _extract_profile_json(content)
    if content.strip():
        diary_storage.save_interaction_mode(user_id, ai_key, content.strip(), valid_count)
        # 记录生成手册时的人设指纹，供后续判断人设是否变更
        diary_storage.set_user_meta(user_id, _interaction_meta_key(ai_key), _persona_fingerprint(user_id, ai_key))
        _interaction_mode_cache[(user_id, ai_key)] = content.strip()
        logger.info(f"✅ 互动模式已生成 (user={user_id}, ai={ai_key}, {len(content)} chars)")
        return content.strip()
    return ""


def get_interaction_mode(diary_storage, user_id: str, ai_key: str) -> str:
    """读取某 AI 的互动模式手册（带内存缓存）。

    读取时惰性作废：若检测到人设已被修改，则返回空串（视为无手册），
    由 ensure_interaction_mode 在下次对话时懒加载重新生成。
    """
    cache_key = (user_id, ai_key)
    if cache_key in _interaction_mode_cache:
        content = _interaction_mode_cache[cache_key]
        return "" if _is_interaction_stale(diary_storage, user_id, ai_key, content) else content
    content = diary_storage.get_interaction_mode(user_id, ai_key)
    if _is_interaction_stale(diary_storage, user_id, ai_key, content):
        content = ""
    _interaction_mode_cache[cache_key] = content
    return content


def regenerate_all_interaction_modes(diary_storage, agent, user_id: str):
    """为用户全部 5 个 AI 批量生成互动模式（同步）"""
    for ai_key in ("big_brother", "second_brother", "little_sister", "empathy", "awareness"):
        try:
            generate_interaction_mode(diary_storage, agent, user_id, ai_key)
        except Exception as e:
            logger.warning(f"⚠️ 互动模式生成失败 ({ai_key}): {e}")


def regenerate_interaction_modes_async(diary_storage, agent, user_id: str):
    """异步批量刷新互动模式（不阻塞请求）"""
    from server.background import submit_background
    submit_background(regenerate_all_interaction_modes, diary_storage, agent, user_id)


def maybe_regenerate_profile(diary_storage, agent, user_id: str):
    """保存日记后调用：判断是否满足更新条件，满足则后台异步更新"""
    valid_count = len([d for d in diary_storage.get_all_diaries(user_id)
                       if d.content and len(d.content) > 10])
    if valid_count == 0:
        return
    old_profile = diary_storage.get_user_profile(user_id)
    last_count = diary_storage.get_user_profile_diary_count(user_id)
    # 无档案：满 PROFILE_INTERVAL 篇才首次生成；有档案：新增 ≥ PROFILE_INTERVAL 篇才更新
    should_update = (not old_profile and valid_count >= PROFILE_INTERVAL) or \
                    (old_profile and valid_count - last_count >= PROFILE_INTERVAL)
    if should_update:
        regenerate_profile_async(diary_storage, agent, user_id)


def regenerate_profile_async(diary_storage, agent, user_id: str):
    """异步触发用户档案更新（后台线程，不阻塞请求）"""
    from server.background import submit_background

    def _run():
        try:
            new_profile = generate_user_profile(diary_storage, agent, user_id)
            if new_profile.strip():
                # 档案更新成功后，同步刷新 5 个 AI 的互动模式
                regenerate_all_interaction_modes(diary_storage, agent, user_id)
        except Exception as e:
            logger.error(f"⚠️ 用户档案更新失败: {e}")
    submit_background(_run)


# ==========================================
# 路由
# ==========================================

@router.get("/api/profile")
async def get_profile(diary_storage=Depends(get_diary_storage),
                      current_user: dict = Depends(get_current_user)):
    """获取当前用户的档案（JSON 文本 + 维度结构）"""
    content = diary_storage.get_user_profile(current_user["id"])
    return {
        "content": content,
        "has_profile": bool(content.strip()),
        "dimensions": PROFILE_DIMENSIONS,
    }


@router.post("/api/profile/regenerate")
async def regenerate_profile(diary_storage=Depends(get_diary_storage),
                             agent=Depends(get_agent),
                             current_user: dict = Depends(get_current_user)):
    """手动触发用户档案重新生成（强制全量重建）"""
    diaries = diary_storage.get_all_diaries(current_user["id"])
    # 手动触发时重置基数，强制全量重建
    diary_storage.save_user_profile(current_user["id"], "", 0)
    content = generate_user_profile(diary_storage, agent, current_user["id"])
    if not content:
        return {"content": "", "message": "日记数据不足，无法生成档案"}
    return {"content": content, "message": "档案已更新"}


@router.post("/api/profile/update")
async def update_profile(diary_storage=Depends(get_diary_storage),
                         agent=Depends(get_agent),
                         current_user: dict = Depends(get_current_user)):
    """增量更新用户档案 + 刷新全部 AI 互动模式。

    与 regenerate 的区别：不重置日记基数，直接用「旧档案 + 新增日记」融合更新，
    并在内部同步更新日记标记（user_profiles.diary_count），保证下次更新能准确
    定位「上次生成之后新增的日记」。
    """
    user_id = current_user["id"]
    # 增量融合更新，内部会 save_user_profile 记录 total_count 作为新的日记标记
    content = generate_user_profile(diary_storage, agent, user_id)
    if not content:
        return {"content": "", "message": "日记数据不足，无法更新档案"}
    # 档案更新成功后，后台异步刷新全部 5 个 AI 的互动模式，避免阻塞请求
    regenerate_interaction_modes_async(diary_storage, agent, user_id)
    return {"content": content, "message": "档案已更新，互动模式正在后台刷新"}


@router.get("/api/profile/basic-info")
async def get_basic_info(diary_storage=Depends(get_diary_storage),
                         current_user: dict = Depends(get_current_user)):
    """获取用户基础信息"""
    raw = diary_storage.get_user_meta(current_user["id"], "basic_info")
    try:
        data = json.loads(raw) if raw else {}
    except Exception:
        data = {}
    return {
        "name": data.get("name", ""),
        "nickname": data.get("nickname", ""),
        "identity": data.get("identity", ""),
        "age": data.get("age", ""),
        "gender": data.get("gender", ""),
        "birthday": data.get("birthday", ""),
        "address": data.get("address", ""),
        "relationship_status": data.get("relationship_status", ""),
        "hometown": data.get("hometown", ""),
        "education": data.get("education", ""),
        "hobbies": data.get("hobbies", ""),
    }


@router.put("/api/profile/basic-info")
async def save_basic_info(body: dict,
                          diary_storage=Depends(get_diary_storage),
                          current_user: dict = Depends(get_current_user)):
    """保存用户手动编辑的基础信息"""
    data = {
        "name": (body.get("name") or "").strip(),
        "nickname": (body.get("nickname") or "").strip(),
        "identity": (body.get("identity") or "").strip(),
        "age": (body.get("age") or "").strip(),
        "gender": (body.get("gender") or "").strip(),
        "birthday": (body.get("birthday") or "").strip(),
        "address": (body.get("address") or "").strip(),
        "relationship_status": (body.get("relationship_status") or "").strip(),
        "hometown": (body.get("hometown") or "").strip(),
        "education": (body.get("education") or "").strip(),
        "hobbies": (body.get("hobbies") or "").strip(),
    }
    diary_storage.set_user_meta(current_user["id"], "basic_info", json.dumps(data, ensure_ascii=False))
    logger.info(f"✅ 基础信息已手动保存 (user={current_user['id']})")
    return {"status": "ok"}