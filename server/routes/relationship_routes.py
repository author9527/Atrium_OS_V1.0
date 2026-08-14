# ==========================================
# Atrium OS - 人际关系档案路由
# 功能：管理人际关系档案，含日记搜索、证据截取、档案生成、增量更新、对话
# 维度设计：4固定维度 + 2-4 AI决定维度（一旦确定不再改变）
# ==========================================

import json
import re
import asyncio
from datetime import datetime, date
from typing import List, Optional, Dict
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from server.app import get_diary_storage, get_agent
from server.auth import get_current_user
from server.model_service import generate as _model_generate
from server.model_service import chat_tools as _ms_chat_tools
from server.web_search_tool import SEARCH_TOOL_SCHEMA, web_search as _do_web_search, format_search_results
from server.logger import logger
from server.chat_utils import strip_html
from ai.prompt_core import build_awareness_system

router = APIRouter()

# ========== 人名有效性校验 ==========
# 防止用户输入"我"、"你"这类代词，导致搜索命中所有日记、候选爆炸、OOM 崩溃
PRONOUNS = {
    "我", "你", "他", "她", "它", "您", "咱", "俺",
    "我们", "你们", "他们", "咱们", "俺们", "它们", "她们",
    "我自己", "你自己", "他/她", "自己", "别人",
}


def _validate_person_name(name: str) -> Optional[str]:
    """校验人名。返回错误信息，None 表示合法。"""
    stripped = (name or "").strip().rstrip("。！？!?；;，,、 ")
    if not stripped:
        return "人名不能为空"
    # 去掉标点后判断是否为纯代词
    core = re.sub(r"[\s，。！？、；：,.!?;:（）()「」『』\"'“”‘’\-]", "", stripped)
    if core in PRONOUNS:
        return f"「{stripped}」不是有效的人名，请填写对方的真实名字或称呼"
    # 单字且是常见虚词/指代词，也拒绝
    if len(core) == 1 and core in "这那哪好是啥吗呢吧的了着的个":
        return f"「{stripped}」不是有效的人名，请填写对方的真实名字或称呼"
    return None


# ========== 固定维度定义（4个，不可更改） ==========

FIXED_DIMENSIONS = [
    {"key": "personality", "label": "人格特质", "description": "这个人的性格特点、价值观、思维方式"},
    {"key": "behavior", "label": "行为模式", "description": "这个人的行为习惯、应对策略、情绪反应模式"},
    {"key": "core_conflict", "label": "核心矛盾", "description": "用户与这个人之间的核心矛盾和张力"},
    {"key": "dynamics", "label": "关系动态", "description": "这段关系的发展变化、趋势和走向"},
]

# ========== JSON Schema 约束（用于 Ollama format 字段） ==========
# 注意：本地 thinking 模型（如 gemma4:12b）在 format="json" 时可能返回
# {"action": "thought", "content": ""} 而非任务要求的 JSON，必须使用 JSON Schema
# 严格约束输出结构，才能稳定得到正确的 JSON。

EVIDENCE_SCHEMA = {
    "type": "object",
    "properties": {
        "evidence": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "date": {"type": "string"}
                },
                "required": ["text", "date"],
                "additionalProperties": False
            }
        }
    },
    "required": ["evidence"],
    "additionalProperties": False
}

ALIASES_SCHEMA = {
    "type": "object",
    "properties": {
        "aliases": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "reason": {"type": "string"}
                },
                "required": ["name", "reason"],
                "additionalProperties": False
            }
        }
    },
    "required": ["aliases"],
    "additionalProperties": False
}

PROFILE_UPDATE_SCHEMA = {
    "type": "object",
    "properties": {
        "profile": {"type": "string"},
        "followup_needed": {"type": "boolean"},
        "followup_questions": {
            "type": "array",
            "items": {"type": "string"}
        },
        "opening_message": {"type": "string"}
    },
    "required": ["profile", "followup_needed", "followup_questions", "opening_message"],
    "additionalProperties": False
}

PROFILE_CREATE_SCHEMA = {
    "type": "object",
    "properties": {
        "dimensions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "key": {"type": "string"},
                    "label": {"type": "string"},
                    "fixed": {"type": "boolean"}
                },
                "required": ["key", "label", "fixed"],
                "additionalProperties": False
            }
        },
        "profile": {"type": "string"},
        "followup_needed": {"type": "boolean"},
        "followup_questions": {
            "type": "array",
            "items": {"type": "string"}
        },
        "opening_message": {"type": "string"}
    },
    "required": ["dimensions", "profile", "followup_needed", "followup_questions", "opening_message"],
    "additionalProperties": False
}

CONVERSATION_SCHEMA = {
    "type": "object",
    "properties": {
        "profile": {"type": "string"},
        "new_facts": {
            "type": "array",
            "items": {"type": "string"}
        }
    },
    "required": ["profile", "new_facts"],
    "additionalProperties": False
}


# ========== Ollama 调用 ==========

def _call_ollama(prompt: str, timeout: int = 300, model: str = None,
                 num_predict: int = 4096, system: str = None, fmt=None,
                 user_id: str = "default") -> str:
    """调用本地 Ollama 生成回复（统一走 model_service，model 缺省读账号主模型）。"""
    return _model_generate(
        prompt, user_id=user_id, model=model, timeout=timeout,
        num_predict=num_predict, system=system, fmt=fmt,
    )


# ========== 日记搜索 ==========

def _search_diaries_for_names(diary_storage, user_id: str, names: List[str],
                              since_date: str = None) -> List[dict]:
    """搜索包含任一名字（原名+外号）的日记，返回 [{date, content}] 列表"""
    if since_date:
        today = date.today().isoformat()
        diaries = diary_storage.get_diaries_by_range(since_date, today, user_id)
    else:
        diaries = diary_storage.get_all_diaries(user_id)

    relevant = []
    for d in diaries:
        if d.content and any(n in d.content for n in names):
            relevant.append({"date": d.date, "content": strip_html(d.content)})
    return relevant


def _analyze_aliases(diary_storage, user_id: str, person_name: str) -> List[dict]:
    """用大模型全面分析日记，找出该人物可能以哪些外号/昵称出现

    返回 [{"name": "外号", "reason": "判断依据"}]，默认包含原名（reason 标记为"本人姓名"）。
    """
    diaries = diary_storage.get_all_diaries(user_id)
    # 截取每篇日记开头，控制输入规模（分析外号不需要全文）
    diaries_text = "\n\n".join(
        f"【{d.date}】\n{strip_html(d.content)[:800]}" for d in diaries if d.content
    )
    if not diaries_text:
        return [{"name": person_name, "reason": "本人姓名"}]

    prompt = f"""请全面阅读以下日记内容，找出「{person_name}」这个人可能以哪些外号、昵称、简称或称呼出现在日记中。

要求：
1. 仔细分析日记中的人物称呼，找出所有可能指向「{person_name}」的别称
2. 包括但不限于：外号、昵称、简称、姓氏+身份（如"老X"、"X哥"）、谐音、英文名等
3. 只列出有把握确实指向该人物的称呼，不要臆测
4. 如果日记里该人物只以本名出现，没有其他称呼，则只保留本名
5. 每个称呼给出判断依据（在日记中出现的上下文或理由），reason 用简短的一句话说明
6. 必须包含「{person_name}」本名本身（reason 标为"本人姓名"）

日记内容：
{diaries_text}

输出 JSON 格式：
{{
  "aliases": [
    {{"name": "称呼或昵称", "reason": "判断依据"}}
  ]
}}"""

    try:
        raw = _call_ollama(prompt, timeout=400, fmt=ALIASES_SCHEMA,
                           num_predict=2048, user_id=user_id)
        data = json.loads(raw)
        aliases = data.get("aliases", [])
        # 清洗：去空、去重、确保原名在列
        result = []
        seen = set()
        for a in aliases:
            name = (a.get("name") or "").strip()
            if not name or name in seen:
                continue
            seen.add(name)
            result.append({"name": name, "reason": (a.get("reason") or "").strip()})
        if person_name not in seen:
            result.insert(0, {"name": person_name, "reason": "本人姓名"})
        return result
    except Exception as e:
        logger.warning(f"[关系档案] 外号分析失败，回退仅本名: {e}")
        return [{"name": person_name, "reason": "本人姓名"}]


# ========== 证据提取 ==========

def _extract_evidence_from_diaries(diaries: List[dict], names: List[str],
                                   exclude_dates: set = None,
                                   user_id: str = "default") -> List[dict]:
    """分批提取与某人相关的原文片段

    names 为确认后的名字集合（原名+外号/昵称）。名称检索已负责把日记按名字
    粗筛成整篇片段，本函数只负责将剩余日记分批（每批至多 BATCH_SIZE=10 篇）
    交给大模型提取。大模型通读整篇日记，能结合上下文识别"他/她/ta"等代称，
    从而避免只按名字截句而遗漏仅以代称出现的段落。

    exclude_dates: 已存在证据的日期集合，这些日期的日记直接跳过（不重复提取）。

    返回 [{"text": "原文片段", "date": "2025-03-15"}]
    """
    if not diaries:
        return []

    # 过滤掉已提取过的日期
    if exclude_dates:
        diaries = [d for d in diaries if d["date"] not in exclude_dates]
        if not diaries:
            return []

    names_text = "、".join(f"「{n}」" for n in names)

    prompt_template = """以下是用户日记。你要找的这个人物可能以 {names_text} 的名字出现，也可能在上下文明确的情况下用"他/她/ta"等代称指代。请通读整篇日记，找出所有与这个人相关的原文片段。

要求：
1. 结合上下文判断名字和代称是否指向同一人物，提取与其相关的完整语义片段
2. 按句子边界提取，保留每段与该人物相关的完整语义，不要机械截断
3. 合并属于同一件事的相邻片段，去掉重复或冗余内容
4. 每条证据必须忠实于原文，不要改写或总结
5. 每条证据保留来源日期（date 字段）
6. 某片段虽不含名字、但能用上下文确认是该人物（如用"他/她/ta"代称）的，也要提取
7. 如果某片段无法确认与该人物相关，可以剔除

日记内容：
{diaries_text}

输出 JSON 格式：
{{
  "evidence": [
    {{"text": "原文片段", "date": "2025-03-15"}}
  ]
}}"""

    BATCH_SIZE = 10
    all_evidence = []
    seen = set()

    for i in range(0, len(diaries), BATCH_SIZE):
        batch = diaries[i:i + BATCH_SIZE]
        diaries_text = "\n\n".join(
            f"【{d['date']}】\n{d['content']}" for d in batch
        )
        prompt = prompt_template.format(names_text=names_text, diaries_text=diaries_text)
        try:
            raw = _call_ollama(prompt, timeout=400, fmt=EVIDENCE_SCHEMA,
                           num_predict=1500, user_id=user_id)
            data = json.loads(raw)
            evidence = data.get("evidence", [])
            for e in evidence:
                text = (e.get("text") or "").strip()
                date_s = e.get("date", "")
                if not text:
                    continue
                key = (date_s, text)
                if key in seen:
                    continue
                seen.add(key)
                all_evidence.append({"text": text, "date": date_s})
        except Exception as e:
            logger.error(f"[关系档案] 第{i // BATCH_SIZE + 1}批提取失败: {e}")

    return all_evidence


# ========== 档案生成（含维度确定） ==========

def _generate_relationship_profile(evidence: List[dict], person_name: str,
                                    existing_dimensions: List[dict] = None,
                                    existing_profile: str = "",
                                    user_id: str = "default") -> dict:
    """生成关系档案

    - existing_dimensions 为空：首次生成，确定维度 + 生成档案
    - existing_dimensions 不为空：维度已锁定，只更新档案内容

    返回:
    {
        "dimensions": [...],       # 维度列表（首次生成时包含AI维度）
        "profile": "...",          # 档案文本
        "followup_needed": bool,   # 是否需要追问
        "followup_questions": [...] # 追问问题列表
    }
    """
    evidence_text = "\n\n".join(
        f"【{e['date']}】{e['text']}" for e in evidence
    ) if evidence else "（无证据片段）"

    fixed_dims_text = "\n".join(
        f"- {d['label']}：{d['description']}" for d in FIXED_DIMENSIONS
    )

    if existing_dimensions:
        # ========== 维度已锁定，只更新档案 ==========
        dims_text = "\n".join(f"- {d['label']}" for d in existing_dimensions)

        prompt = f"""你是一位人际关系分析专家。基于以下证据和已有档案，请更新关于用户与「{person_name}」之间关系的档案。

## 已有维度（不可更改）
{dims_text}

## 已有档案
{existing_profile or "（暂无）"}

## 证据片段
{evidence_text}

请基于所有信息，按维度组织更新档案。每个维度用「【维度名】」作为标题，内容为总结性分析。
然后判断档案是否完整。如果某些维度信息严重不足（完全空白或只有一句话），列出需要追问的问题（最多3个）。
如果各维度信息基本充足，不需要追问。

同时，请生成一段开场白给用户：
- 如果档案有缺失字段（followup_needed=true），开场白应该是温柔引导式的追问，用关心而非质问的语气
- 如果档案完整（followup_needed=false），开场白应该是一段简短但富有洞见的话，基于档案中最突出的特点，吸引用户展开讨论
- 开场白不超过100字，口语化，像朋友聊天

输出 JSON：
{{
  "profile": "必须是纯文本字符串，用【维度名】作为标题，如：\\n【人格特质】分析内容...\\n【行为模式】分析内容...",
  "followup_needed": true或false,
  "followup_questions": ["问题1", "问题2"],
  "opening_message": "给用户的开场白"
}}

重要：profile 字段必须是纯文本字符串，不要是 JSON 对象或数组。"""
    else:
        # ========== 首次生成：确定维度 + 生成档案 ==========
        prompt = f"""你是一位人际关系分析专家。基于以下从用户日记中提取的关于「{person_name}」的原文片段，请完成两个任务：

## 任务1：确定分析维度

这段关系有4个固定维度：
{fixed_dims_text}

除了固定维度外，请根据这段关系的特点，额外选择2-4个最适合的分析维度。选择原则：
- 维度应针对这段关系的独特性（如"权力动态"、"情感依赖"、"沟通障碍"、"信任基础"等）
- 维度名称简洁（4-8字）
- 不要与固定维度重复或重叠

## 任务2：生成档案

基于所有维度（固定+额外），生成一份关于这段关系的档案。每个维度用「【维度名】」作为标题，内容为总结性分析。

然后判断档案是否完整。如果某些维度信息严重不足（完全空白或只有一句话），列出需要追问的问题（最多3个）。
如果各维度信息基本充足，不需要追问。

同时，请生成一段开场白给用户：
- 如果档案有缺失字段（followup_needed=true），开场白应该是温柔引导式的追问，用关心而非质问的语气
- 如果档案完整（followup_needed=false），开场白应该是一段简短但富有洞见的话，基于档案中最突出的特点，吸引用户展开讨论
- 开场白不超过100字，口语化，像朋友聊天

## 证据片段
{evidence_text}

输出 JSON：
{{
  "dimensions": [
    {{"key": "personality", "label": "人格特质", "fixed": true}},
    {{"key": "behavior", "label": "行为模式", "fixed": true}},
    {{"key": "core_conflict", "label": "核心矛盾", "fixed": true}},
    {{"key": "dynamics", "label": "关系动态", "fixed": true}},
    {{"key": "your_key_1", "label": "你决定的维度名1", "fixed": false}},
    {{"key": "your_key_2", "label": "你决定的维度名2", "fixed": false}}
  ],
  "profile": "必须是纯文本字符串，用【维度名】作为标题，如：\\n【人格特质】分析内容...\\n【行为模式】分析内容...",
  "followup_needed": true或false,
  "followup_questions": ["问题1", "问题2"],
  "opening_message": "给用户的开场白"
}}

重要：profile 字段必须是纯文本字符串，不要是 JSON 对象或数组。"""

    try:
        # 首次生成用 PROFILE_CREATE_SCHEMA（含 dimensions），更新用 PROFILE_UPDATE_SCHEMA
        schema = PROFILE_UPDATE_SCHEMA if existing_dimensions else PROFILE_CREATE_SCHEMA
        raw = _call_ollama(prompt, timeout=300, fmt=schema, num_predict=1024, user_id=user_id)
        result = json.loads(raw)

        # 安全转换：如果 LLM 返回的 profile 是 dict/list，转为【维度名】文本格式
        profile = result.get("profile", "")
        if isinstance(profile, dict):
            lines = []
            for k, v in profile.items():
                val = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
                lines.append(f"【{k}】\n{val}")
            result["profile"] = "\n\n".join(lines)
        elif not isinstance(profile, str):
            result["profile"] = json.dumps(profile, ensure_ascii=False)

        # 首次生成时，确保固定维度在列表中
        if not existing_dimensions:
            dims = result.get("dimensions", [])
            # 确保固定维度存在
            fixed_keys = {d["key"] for d in FIXED_DIMENSIONS}
            existing_keys = {d.get("key") for d in dims}
            for fd in FIXED_DIMENSIONS:
                if fd["key"] not in existing_keys:
                    dims.insert(0, {**fd, "fixed": True})
            # 确保 AI 维度有 fixed: false
            for d in dims:
                if d.get("key") not in fixed_keys:
                    d["fixed"] = False
                else:
                    d["fixed"] = True
            result["dimensions"] = dims

        return result
    except Exception as e:
        logger.error(f"[关系档案] 生成失败: {e}")
        return {
            "dimensions": existing_dimensions or [
                {**d, "fixed": True} for d in FIXED_DIMENSIONS
            ],
            "profile": existing_profile,
            "followup_needed": False,
            "followup_questions": []
        }


# ========== 从对话中提取事实 ==========

def _extract_facts_from_conversation(conversation: List[dict], person_name: str,
                                      existing_profile: str,
                                      existing_dimensions: List[dict] = None,
                                      user_id: str = "default") -> dict:
    """从对话记录中提取新的事实信息，更新关系档案

    - 如果 existing_dimensions 为空：将对话内容作为证据，首次确定维度+生成档案
    - 如果 existing_dimensions 不为空：只更新档案内容

    返回:
    {
        "dimensions": [...],
        "profile": "...",
        "new_facts": [...]
    }
    """
    conv_text = "\n".join(
        f"{'用户' if m.get('role') == 'user' else '助手'}: {m.get('content', '')}"
        for m in conversation
    )

    if not existing_dimensions:
        # 维度未确定：将对话内容作为证据来首次生成
        evidence = [{"text": conv_text, "date": datetime.now().strftime("%Y-%m-%d")}]
        result = _generate_relationship_profile(evidence, person_name, user_id=user_id)
        return {
            "dimensions": result.get("dimensions", []),
            "profile": result.get("profile", ""),
            "new_facts": []
        }

    # 维度已确定：提取新事实并更新档案
    dims_text = "\n".join(f"- {d['label']}" for d in existing_dimensions)

    prompt = f"""请从以下用户与助手的对话记录中，提取关于「{person_name}」的新的事实信息，并据此更新关系档案。

## 已有维度（不可更改）
{dims_text}

## 已有档案
{existing_profile or "（暂无）"}

## 对话记录
{conv_text}

要求：
1. 只提取用户主动披露的事实性信息（不是助手的分析或推测）
2. 将新信息整合到已有档案中，保持维度结构不变
3. 如果没有新的有价值信息，返回原档案

输出 JSON：
{{
  "profile": "更新后的档案文本",
  "new_facts": ["新事实1", "新事实2"]
}}"""

    try:
        raw = _call_ollama(prompt, timeout=300, fmt=CONVERSATION_SCHEMA, user_id=user_id)
        result = json.loads(raw)
        result.setdefault("dimensions", existing_dimensions)
        return result
    except Exception as e:
        logger.error(f"[关系档案] 对话事实提取失败: {e}")
        return {
            "dimensions": existing_dimensions,
            "profile": existing_profile,
            "new_facts": []
        }


# ========== 请求模型 ==========

class CreateRelationshipRequest(BaseModel):
    person_name: str
    aliases: List[str] = []  # 用户确认后的名字集合（含原名+外号），空则只用原名


class AnalyzeAliasesRequest(BaseModel):
    person_name: str


class UpdateProfileFromChatRequest(BaseModel):
    conversation: List[dict]


class RelationshipChatRequest(BaseModel):
    message: str
    conversation_history: List[dict] = []
    followup_questions: List[str] = []


# ========== 辅助：安全类型转换 ==========

def _safe_str(val) -> str:
    """确保值为字符串，防止 SQLite 类型绑定错误"""
    if val is None:
        return ""
    if isinstance(val, str):
        return val
    return json.dumps(val, ensure_ascii=False)


# ========== API 路由 ==========

@router.get("/api/relationships")
async def list_relationships(diary_storage=Depends(get_diary_storage),
                              current_user: dict = Depends(get_current_user)):
    """列出用户所有人际关系档案"""
    relationships = diary_storage.list_relationships(current_user["id"])
    return {"relationships": relationships}


@router.post("/api/relationships")
async def create_relationship(request: CreateRelationshipRequest,
                               diary_storage=Depends(get_diary_storage),
                               agent=Depends(get_agent),
                               current_user: dict = Depends(get_current_user)):
    """创建人际关系档案（兼容旧接口，非流式）"""
    person_name = request.person_name.strip()
    if not person_name:
        return {"error": "人名不能为空"}

    existing = diary_storage.get_relationship_by_name(current_user["id"], person_name)
    if existing:
        return {"error": "already_exists", "relationship": existing}

    rel = diary_storage.create_relationship(current_user["id"], person_name)
    today = date.today().isoformat()

    diari = _search_diaries_for_names(diary_storage, current_user["id"], [person_name])
    if not diari:
        diary_storage.update_relationship(rel["id"], last_search_date=today)
        return {"relationship": diary_storage.get_relationship(rel["id"]),
                "status": "no_evidence",
                "message": f"未在日记中找到关于「{person_name}」的内容"}

    evidence = _extract_evidence_from_diaries(diari, [person_name], user_id=current_user["id"])
    if not evidence:
        diary_storage.update_relationship(rel["id"], last_search_date=today)
        return {"relationship": diary_storage.get_relationship(rel["id"]),
                "status": "no_evidence",
                "message": f"未在日记中找到关于「{person_name}」的有效内容"}

    result = _generate_relationship_profile(evidence, person_name, user_id=current_user["id"])
    diary_storage.update_relationship(
        rel["id"],
        profile_content=_safe_str(result.get("profile", "")),
        evidence=json.dumps(evidence, ensure_ascii=False),
        dimensions=json.dumps(result.get("dimensions", []), ensure_ascii=False),
        last_search_date=today
    )

    updated = diary_storage.get_relationship(rel["id"])
    updated["evidence"] = json.loads(updated.get("evidence", "[]"))
    updated["dimensions"] = json.loads(updated.get("dimensions", "[]"))
    return {"relationship": updated,
            "status": "followup_needed" if result.get("followup_needed") else "complete",
            "followup_questions": result.get("followup_questions", [])}


@router.post("/api/relationships/aliases/analyze")
async def analyze_relationship_aliases(request: AnalyzeAliasesRequest,
                                        diary_storage=Depends(get_diary_storage),
                                        current_user: dict = Depends(get_current_user)):
    """分析人物可能的外号/昵称，供用户确认后再创建档案

    返回 {"aliases": [{"name": "...", "reason": "..."}]}
    """
    person_name = request.person_name.strip()
    if not person_name:
        return {"error": "人名不能为空"}

    # 校验：拒绝"我"、"你"等代词，防止日记搜索命中所有内容导致崩溃
    valid_err = _validate_person_name(person_name)
    if valid_err:
        return {"error": valid_err}

    aliases = await asyncio.to_thread(_analyze_aliases, diary_storage, current_user["id"], person_name)
    return {"aliases": aliases}


@router.post("/api/relationships/create/stream")
async def create_relationship_stream(request: CreateRelationshipRequest,
                                      diary_storage=Depends(get_diary_storage),
                                      agent=Depends(get_agent),
                                      current_user: dict = Depends(get_current_user)):
    """创建人际关系档案 - SSE 流式端点，实时发送进度

    SSE 事件格式：
    - {"type": "progress", "step": "searching", "message": "正在搜索日记..."}
    - {"type": "progress", "step": "found_diaries", "message": "找到 X 篇相关日记", "count": N}
    - {"type": "progress", "step": "extracting", "message": "正在提取证据..."}
    - {"type": "progress", "step": "extracted", "message": "提取到 X 条证据", "count": N}
    - {"type": "progress", "step": "generating", "message": "正在生成关系档案..."}
    - {"type": "progress", "step": "done", "message": "档案生成完成"}
    - {"type": "result", "relationship": {...}, "status": "...", "followup_questions": [...]}
    - {"type": "error", "message": "..."}
    - 结束标记: [DONE]
    """
    person_name = request.person_name.strip()
    if not person_name:
        async def err_stream():
            yield f"data: {json.dumps({'type': 'error', 'message': '人名不能为空'}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(err_stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"})

    # 校验：拒绝"我"、"你"等代词，防止日记搜索命中所有内容导致崩溃
    valid_err = _validate_person_name(person_name)
    if valid_err:
        async def err_stream():
            yield f"data: {json.dumps({'type': 'error', 'message': valid_err}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(err_stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"})

    existing = diary_storage.get_relationship_by_name(current_user["id"], person_name)
    if existing:
        async def exists_stream():
            yield f"data: {json.dumps({'type': 'error', 'message': 'already_exists'}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(exists_stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"})

    queue = asyncio.Queue()

    def sync_producer():
        try:
            # 确认后的名字集合（含原名+外号），空则只使用原名
            names = [n.strip() for n in request.aliases if n.strip()]
            if person_name not in names:
                names.insert(0, person_name)

            # 步骤1：创建记录
            queue.put_nowait(f"data: {json.dumps({'type': 'progress', 'step': 'creating', 'message': f'正在创建「{person_name}」的档案...'}, ensure_ascii=False)}\n\n")
            rel = diary_storage.create_relationship(current_user["id"], person_name)
            today = date.today().isoformat()

            # 步骤2：搜索日记（按确认后的名字集合）
            queue.put_nowait(f"data: {json.dumps({'type': 'progress', 'step': 'searching', 'message': '正在搜索所有日记...'}, ensure_ascii=False)}\n\n")
            diaries = _search_diaries_for_names(diary_storage, current_user["id"], names)

            if not diaries:
                diary_storage.update_relationship(rel["id"], last_search_date=today)
                queue.put_nowait(f"data: {json.dumps({'type': 'progress', 'step': 'done', 'message': '未在日记中找到相关内容'}, ensure_ascii=False)}\n\n")
                updated = diary_storage.get_relationship(rel["id"])
                updated["evidence"] = json.loads(updated.get("evidence", "[]"))
                updated["dimensions"] = json.loads(updated.get("dimensions", "[]"))
                queue.put_nowait(f"data: {json.dumps({'type': 'result', 'relationship': updated, 'status': 'no_evidence', 'message': f'未在日记中找到关于「{person_name}」的内容，请通过对话补充'}, ensure_ascii=False)}\n\n")
                return

            queue.put_nowait(f"data: {json.dumps({'type': 'progress', 'step': 'found_diaries', 'message': f'找到 {len(diaries)} 篇相关日记', 'count': len(diaries)}, ensure_ascii=False)}\n\n")

            # 步骤3：提取证据（按确认后的名字集合）
            queue.put_nowait(f"data: {json.dumps({'type': 'progress', 'step': 'extracting', 'message': '分析日记...'}, ensure_ascii=False)}\n\n")
            evidence = _extract_evidence_from_diaries(diaries, names, user_id=current_user["id"])

            if not evidence:
                diary_storage.update_relationship(rel["id"], last_search_date=today)
                queue.put_nowait(f"data: {json.dumps({'type': 'progress', 'step': 'done', 'message': '未能提取到有效证据'}, ensure_ascii=False)}\n\n")
                updated = diary_storage.get_relationship(rel["id"])
                updated["evidence"] = json.loads(updated.get("evidence", "[]"))
                updated["dimensions"] = json.loads(updated.get("dimensions", "[]"))
                queue.put_nowait(f"data: {json.dumps({'type': 'result', 'relationship': updated, 'status': 'no_evidence', 'message': f'未提取到关于「{person_name}」的有效内容'}, ensure_ascii=False)}\n\n")
                return

            queue.put_nowait(f"data: {json.dumps({'type': 'progress', 'step': 'extracted', 'message': f'提取到 {len(evidence)} 条相关内容', 'count': len(evidence)}, ensure_ascii=False)}\n\n")

            # 步骤4：生成档案
            queue.put_nowait(f"data: {json.dumps({'type': 'progress', 'step': 'generating', 'message': '正在生成关系档案（确定维度+分析）...'}, ensure_ascii=False)}\n\n")
            result = _generate_relationship_profile(evidence, person_name, user_id=current_user["id"])

            # 保存（使用 _safe_str 防止类型错误）
            diary_storage.update_relationship(
                rel["id"],
                profile_content=_safe_str(result.get("profile", "")),
                evidence=json.dumps(evidence, ensure_ascii=False),
                dimensions=json.dumps(result.get("dimensions", []), ensure_ascii=False),
                last_search_date=today
            )

            queue.put_nowait(f"data: {json.dumps({'type': 'progress', 'step': 'done', 'message': '档案生成完成'}, ensure_ascii=False)}\n\n")

            updated = diary_storage.get_relationship(rel["id"])
            updated["evidence"] = json.loads(updated.get("evidence", "[]"))
            updated["dimensions"] = json.loads(updated.get("dimensions", "[]"))
            queue.put_nowait(f"data: {json.dumps({'type': 'result', 'relationship': updated, 'status': 'followup_needed' if result.get('followup_needed') else 'complete', 'followup_questions': result.get('followup_questions', []), 'opening_message': _safe_str(result.get('opening_message', ''))}, ensure_ascii=False)}\n\n")

        except Exception as e:
            logger.error(f"[关系档案] 创建流式异常: {e}")
            import traceback
            traceback.print_exc()
            try:
                queue.put_nowait(f"data: {json.dumps({'type': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n")
            except asyncio.QueueFull:
                pass
        finally:
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
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"}
    )


@router.get("/api/relationships/{relationship_id}")
async def get_relationship(relationship_id: str,
                           diary_storage=Depends(get_diary_storage),
                           current_user: dict = Depends(get_current_user)):
    """获取人际关系档案详情"""
    rel = diary_storage.get_relationship(relationship_id)
    if not rel:
        return {"error": "not_found"}

    if rel["user_id"] != current_user["id"]:
        return {"error": "forbidden"}

    # 解析 JSON 字段
    rel["evidence"] = json.loads(rel.get("evidence", "[]"))
    rel["dimensions"] = json.loads(rel.get("dimensions", "[]"))

    return {"relationship": rel}


@router.delete("/api/relationships/{relationship_id}")
async def delete_relationship(relationship_id: str,
                               diary_storage=Depends(get_diary_storage),
                               current_user: dict = Depends(get_current_user)):
    """删除人际关系档案"""
    rel = diary_storage.get_relationship(relationship_id)
    if not rel:
        return {"error": "not_found"}
    if rel["user_id"] != current_user["id"]:
        return {"error": "forbidden"}

    diary_storage.delete_relationship(relationship_id)
    return {"status": "ok"}


@router.post("/api/relationships/{relationship_id}/refresh")
async def refresh_relationship(relationship_id: str,
                                diary_storage=Depends(get_diary_storage),
                                agent=Depends(get_agent),
                                current_user: dict = Depends(get_current_user)):
    """增量更新：搜索上次以来的新日记，更新档案

    维度一旦确定不再改变，只更新档案内容和证据
    """
    rel = diary_storage.get_relationship(relationship_id)
    if not rel:
        return {"error": "not_found"}
    if rel["user_id"] != current_user["id"]:
        return {"error": "forbidden"}

    person_name = rel["person_name"]
    last_search = rel.get("last_search_date")
    existing_dimensions = json.loads(rel.get("dimensions", "[]"))
    existing_profile = rel.get("profile_content", "")
    existing_evidence = json.loads(rel.get("evidence", "[]"))

    # 搜索新日记
    diaries = _search_diaries_for_names(diary_storage, current_user["id"],
                                         [person_name], since_date=last_search)

    if not diaries:
        return {
            "relationship": rel,
            "status": "no_new_evidence",
            "message": "没有找到新的相关日记"
        }

    # 提取新证据（跳过已存在证据的日期，避免重复提取）
    existing_dates = {e.get("date") for e in existing_evidence if e.get("date")}
    new_evidence = await asyncio.to_thread(_extract_evidence_from_diaries, diaries, [person_name],
                                           exclude_dates=existing_dates)
    all_evidence = existing_evidence + new_evidence

    # 更新档案（维度不变）
    result = await asyncio.to_thread(
        _generate_relationship_profile,
        all_evidence, person_name,
        existing_dimensions=existing_dimensions if existing_dimensions else None,
        existing_profile=existing_profile
    )

    today = date.today().isoformat()
    diary_storage.update_relationship(
        relationship_id,
        profile_content=_safe_str(result.get("profile", existing_profile)),
        evidence=json.dumps(all_evidence, ensure_ascii=False),
        dimensions=json.dumps(result.get("dimensions", existing_dimensions), ensure_ascii=False),
        last_search_date=today
    )

    updated = diary_storage.get_relationship(relationship_id)
    updated["evidence"] = json.loads(updated.get("evidence", "[]"))
    updated["dimensions"] = json.loads(updated.get("dimensions", "[]"))

    return {
        "relationship": updated,
        "status": "followup_needed" if result.get("followup_needed") else "complete",
        "followup_questions": result.get("followup_questions", []),
        "new_evidence_count": len(new_evidence)
    }


@router.post("/api/relationships/{relationship_id}/refresh/stream")
async def refresh_relationship_stream(relationship_id: str,
                                       diary_storage=Depends(get_diary_storage),
                                       agent=Depends(get_agent),
                                       current_user: dict = Depends(get_current_user)):
    """增量更新 - SSE 流式端点，实时发送进度

    搜索上次以来的新日记，更新档案。维度一旦确定不再改变。
    """
    rel = diary_storage.get_relationship(relationship_id)
    if not rel:
        async def err():
            yield f"data: {json.dumps({'type': 'error', 'message': 'not_found'}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(err(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"})
    if rel["user_id"] != current_user["id"]:
        async def err():
            yield f"data: {json.dumps({'type': 'error', 'message': 'forbidden'}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(err(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"})

    person_name = rel["person_name"]
    last_search = rel.get("last_search_date")
    existing_dimensions = json.loads(rel.get("dimensions", "[]"))
    existing_profile = rel.get("profile_content", "")
    existing_evidence = json.loads(rel.get("evidence", "[]"))
    existing_dates = {e.get("date") for e in existing_evidence if e.get("date")}

    queue = asyncio.Queue()

    def sync_producer():
        try:
            queue.put_nowait(f"data: {json.dumps({'type': 'progress', 'step': 'searching', 'message': f'正在搜索上次以来的新日记...'}, ensure_ascii=False)}\n\n")

            diaries = _search_diaries_for_names(diary_storage, current_user["id"],
                                                  [person_name], since_date=last_search)

            if not diaries:
                queue.put_nowait(f"data: {json.dumps({'type': 'progress', 'step': 'done', 'message': '没有找到新的相关日记'}, ensure_ascii=False)}\n\n")
                queue.put_nowait(f"data: {json.dumps({'type': 'result', 'relationship': rel, 'status': 'no_new_evidence', 'message': '没有找到新的相关日记'}, ensure_ascii=False)}\n\n")
                return

            queue.put_nowait(f"data: {json.dumps({'type': 'progress', 'step': 'found_diaries', 'message': f'找到 {len(diaries)} 篇新日记', 'count': len(diaries)}, ensure_ascii=False)}\n\n")
            queue.put_nowait(f"data: {json.dumps({'type': 'progress', 'step': 'extracting', 'message': '分析日记...'}, ensure_ascii=False)}\n\n")

            new_evidence = _extract_evidence_from_diaries(diaries, [person_name],
                                                          exclude_dates=existing_dates,
                                                          user_id=current_user["id"])
            all_evidence = existing_evidence + new_evidence

            queue.put_nowait(f"data: {json.dumps({'type': 'progress', 'step': 'extracted', 'message': f'提取到 {len(new_evidence)} 条新内容，共 {len(all_evidence)} 条', 'count': len(new_evidence)}, ensure_ascii=False)}\n\n")
            queue.put_nowait(f"data: {json.dumps({'type': 'progress', 'step': 'generating', 'message': '正在更新关系档案...'}, ensure_ascii=False)}\n\n")

            result = _generate_relationship_profile(
                all_evidence, person_name,
                existing_dimensions=existing_dimensions if existing_dimensions else None,
                existing_profile=existing_profile,
                user_id=current_user["id"]
            )

            today = date.today().isoformat()
            diary_storage.update_relationship(
                relationship_id,
                profile_content=_safe_str(result.get("profile", existing_profile)),
                evidence=json.dumps(all_evidence, ensure_ascii=False),
                dimensions=json.dumps(result.get("dimensions", existing_dimensions), ensure_ascii=False),
                last_search_date=today
            )

            queue.put_nowait(f"data: {json.dumps({'type': 'progress', 'step': 'done', 'message': '档案更新完成'}, ensure_ascii=False)}\n\n")

            updated = diary_storage.get_relationship(relationship_id)
            updated["evidence"] = json.loads(updated.get("evidence", "[]"))
            updated["dimensions"] = json.loads(updated.get("dimensions", "[]"))
            queue.put_nowait(f"data: {json.dumps({'type': 'result', 'relationship': updated, 'status': 'followup_needed' if result.get('followup_needed') else 'complete', 'followup_questions': result.get('followup_questions', []), 'new_evidence_count': len(new_evidence), 'opening_message': _safe_str(result.get('opening_message', ''))}, ensure_ascii=False)}\n\n")

        except Exception as e:
            logger.error(f"[关系档案] 刷新流式异常: {e}")
            import traceback
            traceback.print_exc()
            try:
                queue.put_nowait(f"data: {json.dumps({'type': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n")
            except asyncio.QueueFull:
                pass
        finally:
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
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"}
    )


@router.post("/api/relationships/{relationship_id}/extract-from-chat")
async def extract_from_chat(relationship_id: str, request: UpdateProfileFromChatRequest,
                             diary_storage=Depends(get_diary_storage),
                             agent=Depends(get_agent),
                             current_user: dict = Depends(get_current_user)):
    """从对话记录中提取新事实，更新关系档案

    - 如果维度尚未确定（首次无证据时创建的关系）：将对话作为证据，首次确定维度+生成档案
    - 如果维度已确定：只更新档案内容
    """
    rel = diary_storage.get_relationship(relationship_id)
    if not rel:
        return {"error": "not_found"}
    if rel["user_id"] != current_user["id"]:
        return {"error": "forbidden"}

    existing_profile = rel.get("profile_content", "")
    existing_dimensions = json.loads(rel.get("dimensions", "[]"))

    result = await asyncio.to_thread(
        _extract_facts_from_conversation,
        request.conversation, rel["person_name"],
        existing_profile, existing_dimensions if existing_dimensions else None,
        current_user["id"]
    )

    new_profile = _safe_str(result.get("profile", existing_profile))
    new_dimensions = result.get("dimensions", existing_dimensions)

    # 更新数据库
    update_fields = {}
    if new_profile.strip() and new_profile != existing_profile:
        update_fields["profile_content"] = new_profile
    if new_dimensions and new_dimensions != existing_dimensions:
        update_fields["dimensions"] = json.dumps(new_dimensions, ensure_ascii=False)

    if update_fields:
        diary_storage.update_relationship(relationship_id, **update_fields)

    updated = diary_storage.get_relationship(relationship_id)
    updated["evidence"] = json.loads(updated.get("evidence", "[]"))
    updated["dimensions"] = json.loads(updated.get("dimensions", "[]"))

    return {
        "status": "ok",
        "new_facts": result.get("new_facts", []),
        "relationship": updated
    }


def _relationship_decide_search(system_prompt: str, user_prompt: str, user_message: str) -> list:
    """阶段一：带 tools 调用 /api/chat，让觉察伙伴自主判断是否需要联网搜索。

    返回搜索结果列表；若无需搜索或决策失败返回 None（不阻断主流程）。
    """
    try:
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]
        resp = _ms_chat_tools(messages, tools=[SEARCH_TOOL_SCHEMA], num_predict=512)
        msg = resp.get("message", {}) or {}
        for tc in msg.get("tool_calls") or []:
            fn = tc.get("function", {}) if isinstance(tc, dict) else {}
            if fn.get("name") == "web_search":
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except (json.JSONDecodeError, TypeError):
                    args = {}
                query = (args.get("query") or user_message).strip()
                if query:
                    logger.info(f"🔎 [关系对话] 觉察伙伴自主决定联网搜索: {query}")
                    return _do_web_search(query)
        return None
    except Exception as e:
        logger.warning(f"⚠️ [关系对话] 联网搜索决策失败（跳过搜索）: {e}")
        return None


@router.post("/api/relationships/{relationship_id}/chat/stream")
async def relationship_chat_stream(relationship_id: str, request: RelationshipChatRequest,
                                    diary_storage=Depends(get_diary_storage),
                                    agent=Depends(get_agent),
                                    current_user: dict = Depends(get_current_user)):
    """人际关系分析对话 - SSE 流式输出

    使用觉察助手人设，注入：
    - 关系档案
    - 用户档案
    - 提供原文证据的日记（非全部日记）
    - 待补充的追问问题（如有）
    """
    rel = diary_storage.get_relationship(relationship_id)
    if not rel:
        return {"error": "not_found"}
    if rel["user_id"] != current_user["id"]:
        return {"error": "forbidden"}

    person_name = rel["person_name"]
    profile_content = rel.get("profile_content", "")
    evidence = json.loads(rel.get("evidence", "[]"))
    dimensions = json.loads(rel.get("dimensions", "[]"))

    # 获取用户档案
    user_profile = diary_storage.get_user_profile(current_user["id"])

    # 构建证据日记文本（只注入有证据的日记）
    evidence_dates = set(e["date"] for e in evidence if e.get("date"))
    evidence_diaries_text = ""
    if evidence_dates:
        diary_entries = []
        for ed in sorted(evidence_dates):
            d = diary_storage.get_diary_by_date(ed, user_id=current_user["id"])
            if d and d.content:
                diary_entries.append(f"【{d.date}】\n{strip_html(d.content)}")
        evidence_diaries_text = "\n\n".join(diary_entries)

    # 构建维度文本
    dims_text = "\n".join(f"- {d['label']}" for d in dimensions) if dimensions else ""

    # 构建对话历史
    history_text = ""
    for msg in request.conversation_history:
        role = "用户" if msg.get("role") == "user" else "觉察伙伴"
        history_text += f"{role}: {msg.get('content', '')}\n"

    # 追问问题（如有）
    followup_text = ""
    if request.followup_questions:
        followup_text = "\n## 待补充的问题\n"
        followup_text += "\n".join(f"- {q}" for q in request.followup_questions)
        followup_text += "\n请在对话中自然地引导用户回答这些问题，不要一次性全部抛出。回答完后再进入深层觉察对话。\n"

    # 觉察助手 system prompt（人格核心单一来源；关系上下文注入 user_prompt）
    from server.persona_config import get_persona_ego
    awareness_ego = (get_persona_ego(current_user["id"], "awareness") or "").strip()
    ego_parts = [awareness_ego] if awareness_ego else []
    system_prompt = build_awareness_system(ego_parts)

    user_prompt = f"""## 当前关系分析
你正在帮助用户分析与「{person_name}」的人际关系。

### 关系档案
{profile_content or "（档案尚未生成，请通过对话了解这段关系）"}

### 分析维度
{dims_text or "（未设定，将在对话后根据用户提供的信息确定）"}

### 用户档案
{user_profile or "（暂无）"}

### 相关日记（仅含证据日记）
{evidence_diaries_text or "（无相关日记）"}
{followup_text}
### 对话历史
{history_text or "（这是对话的开始）"}

### 用户最新消息
{request.message}

请以觉察伙伴的身份，帮助用户深入思考这段关系："""

    logger.info(f"[关系对话] user={current_user['username']} person={person_name} msg={request.message[:50]}...")

    # SSE 流式输出
    queue = asyncio.Queue()

    def sync_producer():
        try:
            # 联网搜索：让觉察伙伴自主判断是否需要联网搜索，需要则注入结果
            search_results = _relationship_decide_search(system_prompt, user_prompt, request.message)
            if search_results:
                results_text = format_search_results(search_results, max_items=300)
                user_prompt = (
                    user_prompt
                    + f"\n\n【联网搜索结果（仅用其中的可靠事实回答，存疑信息如实标注，与话题无关则忽略）】\n{results_text}"
                )
                logger.info(f"🔎 [关系对话] 已注入 {len(search_results)} 条联网搜索结果")

            for chunk in agent._call_ollama_stream(user_prompt, system_prompt):
                data = json.dumps(chunk, ensure_ascii=False)
                try:
                    queue.put_nowait(f"data: {data}\n\n")
                except asyncio.QueueFull:
                    pass
        except Exception as e:
            logger.error(f"[关系对话] 流式输出异常: {e}")
            try:
                queue.put_nowait(
                    f"data: {json.dumps({'type': 'response', 'content': '（连接异常）'}, ensure_ascii=False)}\n\n"
                )
            except asyncio.QueueFull:
                pass
        finally:
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
