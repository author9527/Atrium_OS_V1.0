import json
import re

# 角色到说话人名称的映射（所有AI共享同一套说话人名称）
ROLE_TO_SPEAKER = {
    "user": "用户",
    "assistant": "共情助手",
    "insight": "觉察伙伴",
    "big_brother": "鳄正经",
    "second_brother": "鹅小弟",
    "little_sister": "鹿晓葵",
}

SPEAKER_TO_ROLE = {v: k for k, v in ROLE_TO_SPEAKER.items()}


def strip_html(text: str) -> str:
    """剥离富文本日记中的 HTML 标签（含 <img> 及其内嵌 base64 data URI），
    避免图片数据撑爆 LLM prompt。保留可见文本与常见实体还原。"""
    if not text:
        return ""
    text = re.sub(r'<[^>]+>', '', text)
    text = text.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
    text = text.replace('&nbsp;', ' ').replace('&quot;', '"').replace('&#39;', "'")
    return text.strip()


def build_unified_history(session_id: str, diary_storage, max_messages: int = None) -> str:
    """从 session 加载消息，返回统一格式的 history_text (JSON 字符串)
    
    格式: [{"speaker": "用户", "content": "..."}, {"speaker": "共情助手", "content": "..."}]
    所有AI（共情助手、觉察伙伴、聊天室三人组）共用此格式。
    """
    msgs = diary_storage.get_messages(session_id)
    if max_messages and len(msgs) > max_messages:
        msgs = msgs[-max_messages:]
    history = []
    for m in msgs:
        role = m.get("role", "")
        speaker = ROLE_TO_SPEAKER.get(role, role)
        content = m.get("content", "")
        if content:
            history.append({"speaker": speaker, "content": content})
    return json.dumps(history, ensure_ascii=False)


def build_unified_history_from_list(history: list) -> str:
    """将内部历史列表 [{"role": "user", "content": "..."}] 转为统一格式的 JSON 字符串
    
    用于聊天室等需要在内存中维护历史的场景。
    """
    unified = []
    for msg in history:
        role = msg.get("role", "")
        speaker = ROLE_TO_SPEAKER.get(role, role)
        content = msg.get("content", "")
        if content:
            unified.append({"speaker": speaker, "content": content})
    return json.dumps(unified, ensure_ascii=False)


def format_history_readable(history_text: str) -> str:
    """将统一格式的 history_text (JSON 字符串) 转为 LLM 可读的文本
    
    输出格式:
    用户: 你好
    共情助手: 你好啊
    鳄正经: ...
    """
    try:
        history = json.loads(history_text) if isinstance(history_text, str) else history_text
    except (json.JSONDecodeError, TypeError):
        return "（对话历史解析失败）"
    if not history:
        return "（这是对话的开始）"
    lines = []
    for msg in history:
        speaker = msg.get("speaker", "")
        content = msg.get("content", "")
        if content:
            lines.append(f"{speaker}: {content}")
    return "\n".join(lines)


def get_last_speaker(history_text: str) -> str:
    """从统一格式的 history_text 中获取最后说话者的名称
    
    返回说话人名称（如 "鳄正经"），空字符串表示无历史。
    """
    try:
        history = json.loads(history_text) if isinstance(history_text, str) else history_text
    except (json.JSONDecodeError, TypeError):
        return ""
    if not history:
        return ""
    return history[-1].get("speaker", "")
