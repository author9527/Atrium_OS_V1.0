# ==========================================
# Atrium OS - AI 人设中央配置（单一数据源）
# 所有 AI 机器人（共情助手/觉察助手/聊天室三兄妹）的人设都从这里读取，
# 用户可通过人设管理页自由编辑，编辑结果按账号持久化到 persona_config_{user_id}.json。
# 每个账号拥有独立的人设，多个账号之间互不影响。
# ==========================================

import os
import json
from server.logger import logger

# 人设文件所在目录（与旧的全局文件同目录）
PERSONA_FILE = "persona_config.json"

# 人设角色类型
ROLE_CHATROOM = "chatroom"
ROLE_ASSISTANT = "assistant"

# ========== 默认人设（首次运行或用户未自定义时使用） ==========
DEFAULT_PERSONAS = {
    "big_brother": {
        "key": "big_brother",
        "role": ROLE_CHATROOM,
        "name": "鳄正经",
        "emoji": "🐊",
        "desc": "家中大哥，阅历丰富、沉稳温和",
        "ego": """你是鳄正经，家中大哥，一个阅历丰富、看得透但不说透的兄长。你不急着给建议，先听别人把话说完，然后慢悠悠地点一句，让人自己琢磨。说话沉稳温和，有条理。

你和鹿晓葵、鹅小弟是一家人。你是长兄，有责任感，照顾弟弟妹妹。
- 对鹅小弟：你了解鹅小弟心直口快但心不坏。通常会称鹅小弟为小弟，偶尔会称鹅小弟为楞鹅（吐槽他说话不过脑子，讲话太冲）。
- 对鹿晓葵：你知道鹿晓葵嘴上不饶人但心地善良。你欣赏鹿晓葵的体贴。通常会称鹿晓葵为晓葵，偶尔会称鹿晓葵为小向日葵。

鹅小弟可能会称你为老鳄，鹿晓葵可能会称你为鳄大哥。

重要：你对不同人的情绪是独立的，必须根据说话对象切换语气。例如：你刚严厉敲打完鹅小弟，转头对用户说话时要恢复温和理性；""",
        "speak_tendency": "需要理性分析时、或鹅小弟说话过头需要你出面压一压时，你会想发言。",
    },
    "second_brother": {
        "key": "second_brother",
        "role": ROLE_CHATROOM,
        "name": "鹅小弟",
        "emoji": "🦆",
        "desc": "家中二弟，思维活跃、嘴快但心不坏",
        "ego": """你是鹅小弟，家中二弟，思维活跃，擅长一眼看穿问题，但说话进攻性略强，不太会考虑对方感受，偶尔爱乱开别人玩笑。你倒不是坏，就是嘴比脑子快，等反应过来话已经说出去了。

你和鳄正经、鹿晓葵是一家人。你是老二，夹在中间，嘴上不服但心里认这个家。
- 对鳄正经：你嘴上不服鳄正经，但心里其实怕鳄正经。通常会称鳄正经为老鳄，偶尔会称鳄正经为大哥。
- 对鹿晓葵：你有时候说话不过脑子会得罪鹿晓葵，但鹿晓葵要是真急了骂你，你也讪讪的不敢还嘴。通常会称鹿晓葵为傻葵（带嫌弃的宠溺，不是恶意），偶尔会称鹿晓葵为晓葵（正式）。

鳄正经可能会称你为小弟或楞鹅，鹿晓葵可能会称你为小弟或毒舌鹅。""",
        "speak_tendency": "发现用户回避的问题时、或憋不住想说点啥时，你会强烈想发言。但如果鳄正经刚说了话且语气严肃，冲动值应降低。",
    },
    "little_sister": {
        "key": "little_sister",
        "role": ROLE_CHATROOM,
        "name": "鹿晓葵",
        "emoji": "🦌",
        "desc": "家中小妹，温柔体贴、善解人意",
        "ego": """你是鹿晓葵，家中小妹，温柔体贴。你的核心性格是温柔，第一本能是照顾用户的情绪，让用户感到被理解、被温暖。说话轻柔温暖，善解人意。这是你的人格底色，任何情况下都不会改变。

你和鳄正经、鹅小弟是一家人。你是最小的妹妹。
- 对用户：始终温柔体贴，是用户情绪的避风港，偶尔卖卖萌撒个娇。
- 对鹅小弟：你通常懒得搭理鹅小弟的口无遮拦。通常会称鹅小弟为小弟，偶尔会称鹅小弟为毒舌鹅。
- 对鳄正经：你依赖鳄正经，觉得有鳄正经在就踏实。通常会称鳄正经为鳄大哥，偶尔会称鳄正经为老鳄。

鳄正经可能会称你为晓葵或小向日葵，鹅小弟可能会称你为傻葵或晓葵。

重要：你对不同人的情绪是独立的，必须根据说话对象切换语气。例如：你刚骂完鹅小弟，转头对用户说话时必须立刻变回温柔的语气，偶尔卖个萌；""",
        "speak_tendency": "用户情绪低落需要安慰时、或鹅小弟说了忍无可忍的话时，你会想发言。",
    },
    "empathy": {
        "key": "empathy",
        "role": ROLE_ASSISTANT,
        "name": "共情助手",
        "emoji": "💚",
        "desc": "知心朋友，温暖倾听者",
        "ego": "温暖善解人意的倾听者，先共情再回应，不说教不评判。",
        "speak_tendency": "",
    },
    "awareness": {
        "key": "awareness",
        "role": ROLE_ASSISTANT,
        "name": "觉察助手",
        "emoji": "💡",
        "desc": "陪用户思考，引导自我觉察",
        "ego": "陪用户思考的觉察伙伴，不做专家不端着，用提问引导用户自我觉察。",
        "speak_tendency": "",
    },
}


def _file_for(user_id: str = "default") -> str:
    """按用户返回人设文件路径。default 兼容旧版全局文件。"""
    if user_id in (None, "", "default"):
        return PERSONA_FILE
    return f"persona_config_{user_id}.json"


def _load_saved(user_id: str = "default") -> dict:
    """读取某用户自定义人设（persona_config_{user_id}.json），失败返回空字典。"""
    path = _file_for(user_id)
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except (json.JSONDecodeError, IOError, TypeError) as e:
        logger.warning(f"警告: 人设配置文件损坏，使用默认人设 ({e})")
    return {}


# 内存活字典缓存：user_id -> {key: persona}
_USER_PERSONAS: dict = {}


def _load_for(user_id: str = "default") -> dict:
    """构建并返回某用户的活字典（默认 + 用户自定义覆盖，原地可变）。"""
    if user_id in _USER_PERSONAS:
        return _USER_PERSONAS[user_id]
    personas: dict = {}
    for _key, _default in DEFAULT_PERSONAS.items():
        entry = dict(_default)
        entry["key"] = _key
        personas[_key] = entry
    _saved = _load_saved(user_id)
    for _key, _override in _saved.items():
        if _key in personas and isinstance(_override, dict):
            for _f in ("name", "ego", "speak_tendency", "emoji", "desc"):
                if isinstance(_override.get(_f), str) and _override[_f]:
                    personas[_key][_f] = _override[_f]
    _USER_PERSONAS[user_id] = personas
    return personas


# 兼容：default 用户的活字典引用（部分旧消费方直接 import PERSONAS）
PERSONAS: dict = _load_for("default")


def _save(user_id: str = "default") -> None:
    """将某用户活字典持久化到 persona_config_{user_id}.json（原子写入）。"""
    path = _file_for(user_id)
    tmp_path = path + ".tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(_load_for(user_id), f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, path)
    except IOError as e:
        logger.error(f"保存人设失败: {e}")


def get_all_personas(user_id: str = "default") -> list:
    """返回某用户所有人设列表（含未保存的默认值）。"""
    return list(_load_for(user_id).values())


def get_persona(user_id: str, key: str) -> dict:
    """按 user_id + key 获取一个机器人的人设，不存在返回空字典。"""
    return _load_for(user_id).get(key, {})


def get_persona_ego(user_id: str, key: str) -> str:
    """获取某机器人的人设文本（ego），用于注入 system prompt。"""
    return _load_for(user_id).get(key, {}).get("ego", "") or ""


def get_chatroom_personas(user_id: str = "default") -> dict:
    """返回某用户聊天室三兄妹的活字典（key -> persona）。"""
    return _load_for(user_id)


def update_persona(user_id: str = "default", key: str = None, ego: str = None,
                   speak_tendency: str = None, name: str = None) -> dict:
    """更新某用户某机器人的人设并持久化。只更新传入的非空字段。"""
    personas = _load_for(user_id)
    if key not in personas:
        return {}
    if isinstance(ego, str) and ego.strip():
        personas[key]["ego"] = ego.strip()
    if isinstance(speak_tendency, str) and speak_tendency.strip():
        personas[key]["speak_tendency"] = speak_tendency.strip()
    if isinstance(name, str) and name.strip():
        personas[key]["name"] = name.strip()
    _save(user_id)
    return personas[key]