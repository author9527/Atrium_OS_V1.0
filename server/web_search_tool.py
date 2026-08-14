# ==========================================
# Atrium OS - 联网搜索工具
# 通过私有化 SearXNG 实例的 JSON API 进行搜索，供 Function Calling 使用。
# 依赖：server/model_service.chat_tools 触发模型调用，本模块负责执行真实搜索。
# 改进：
#   - 翻多页取更多结果（默认上限 300 条），按标题/URL 去重
#   - 保留来源引擎、域名、发布时间、相关性评分，供 AI 做多源交叉验证
#   - 允许 AI 对存疑信息用不同关键词再次搜索交叉验证
# ==========================================

import os
import re
from datetime import datetime, timedelta
from urllib.parse import urlparse
import requests

from server.logger import logger

# SearXNG JSON API 地址（可用环境变量覆盖，默认本机 8888 端口）
SEARXNG_BASE_URL = os.environ.get("SEARXNG_BASE_URL", "http://127.0.0.1:8888")


# 工具 schema：喂给 LLM，让 AI 自主判断是否需要联网搜索
def format_search_results(results: list, max_items: int = 300) -> str:
    """将搜索结果格式化为带来源信息的文本，供注入聊天 prompt。

    每条结果附带主域名、命中的引擎与发布时间，并附上交叉验证指引，
    帮助 AI 区分「多源一致」与「单一存疑」的信息，避免把孤立来源当真。
    """
    if not results:
        return ""
    lines = []
    for i, r in enumerate(results[:max_items], 1):
        title = (r.get("title") or "").strip()
        content = (r.get("content") or "").strip()
        domain = r.get("domain") or ""
        engines = ",".join(r.get("engines") or []) or ""
        pub = r.get("published_date") or ""
        meta_bits = []
        if domain:
            meta_bits.append(f"来源:{domain}")
        if engines:
            meta_bits.append(f"引擎:{engines}")
        if pub:
            meta_bits.append(f"发布:{pub}")
        meta = f"（{' │ '.join(meta_bits)}）" if meta_bits else ""
        lines.append(f"{i}. {title}: {content[:150]}{meta}")
    cross_check = (
        "\n\n【信息可信度判断】\n"
        "- 同一事实被多个互相独立来源（不同域名）一致提及，才可作为可靠事实引用。\n"
        "- 仅来自单一来源、或不同来源说法互相矛盾的信息，属于存疑信息，"
        "必须明确标注『这一说法未经多方证实』，并说明分歧所在，绝不能当作既定事实陈述。\n"
        "- 同一网址/域名被重复提及，不增加可信度，勿把它当作多源交叉验证。"
    )
    cite = (
        "\n\n【引用标注规则】\n"
        "- 上面每条结果前面的数字序号就是它的引用编号。\n"
        "- 在正式回答中，凡是你引用了某条来源的信息，就在该句/该处结尾紧跟一个带方括号的"
        "上标序号标注，例如：xxx[1]，xxx[2]。\n"
        "- 必须只标注你实际依据的来源；一处引用多条来源时写成 [1][2] 或 [3][4]。\n"
        "- 同一来源被多次引用时始终用同一个编号。\n"
        "- 纯情绪回应、闲聊、或未引用任何搜索结果时，不要加任何角标。"
    )
    return "\n".join(lines) + cross_check + cite


SEARCH_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": (
            "在互联网上搜索最新、实时或超出自身知识范围的信息。"
            "当用户的问题涉及时效性新闻、实时数据、具体事实核查、产品或技术的最新动态、"
            "网络热梗的来龙去脉，或你无法确定答案时，调用此工具获取真实信息。"
            "日常闲聊、情绪倾诉、基于日记的共情回应无需搜索。"
            "注意：查询词应尽量具体，在核心词后补充必要的限定词以消除歧义"
            "（例如搜网络热梗要带上出处如'某节目/某圈子'，搜人名要带上关键前缀），避免只用过于笼统的单字词。"
            "搜索会返回多个来源的结果并附带来源域名与搜索引擎；若你发现不同来源说法不一致，"
            "或关键事实仅来自单一小众来源，可再次调用本工具用不同关键词做交叉验证。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "要在互联网上搜索的关键词，必须是精简的关键词组合，用空格分隔。去掉口语化虚词（什么、那个、这个、就是）、疑问词（吗、呢、怎么）、语气词，不要用完整句子。例如：用户说"最近那个什么 AI 写代码的叫什么 Copilot" → query 应为"AI 写代码工具 Copilot"。若用户原话过于笼统，请补全必要的限定信息。",
                }
            },
            "required": ["query"],
        },
    },
}


def _extract_domain(url: str) -> str:
    """从 URL 提取主域名（去除 www. 前缀），用于判断来源多样性。"""
    try:
        host = urlparse(url).netloc.lower()
    except Exception:
        return ""
    if host.startswith("www."):
        host = host[4:]
    return host


def _normalize_title(title: str) -> str:
    """标题规范化，用于去重。"""
    if not title:
        return ""
    t = re.sub(r"[\s\-_|\u2502，。！？、；：,.!?;:()（）\[\]【】\"'“”‘’/\\]", "", title)
    return t.lower()[:60]


# 时效敏感词：命中即认为该查询需要"尽量新"的信息，用于按发布时间过滤旧结果
RECENCY_KEYWORDS = (
    "最近", "近期", "最新", "最新消息", "热点", "热搜", "新闻", "时事",
    "今天", "今日", "本周", "本月", "今年", "当下", "目前", "现在", "当下",
    "刚刚", "现场", "突发", "recent", "latest", "today", "this week",
    "this month", "breaking", "news", "update",
)


def _looks_time_sensitive(query: str) -> bool:
    """判断查询是否带有明显时效倾向（应优先返回新结果）。"""
    q = (query or "").lower()
    return any(k in q for k in RECENCY_KEYWORDS)


def _parse_pub_date(s: str):
    """把 published_date 字符串解析为 datetime；解析失败返回 None。"""
    if not s:
        return None
    text = str(s).strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d", "%Y/%m/%d"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def _filter_recent(results: list, fresh_days: int = 90) -> list:
    """时效过滤：对明显带时效倾向的查询，剔除发布时间明确且过旧的结果。

    规则保持宽松（宁可多留，不漏信息）：
      - 没有 published_date 的结果一律保留（无法判断新旧，不误杀）。
      - 发布时间明确且超过 fresh_days 的旧结果被剔除。
      - 若剔除后列表为空，则回退为全量结果，避免把可用的旧信息也丢掉。
    """
    if not results:
        return results
    cutoff = datetime.now() - timedelta(days=fresh_days)
    kept = [
        r for r in results
        if not (pub := _parse_pub_date(r.get("published_date"))) or pub >= cutoff
    ]
    return kept if kept else results


def web_search(query: str, max_results: int = 300, pages: int = 30) -> list:
    """调用 SearXNG JSON API 执行搜索，返回去重后的结果列表。

    翻 pages 页（默认最多 30 页）取更多结果，按规范化标题去重，并保留来源信息：
        {
            "title": str, "url": str, "content": str,
            "domain": str,          # 主域名
            "engines": [str, ...],  # 命中的搜索引擎
            "score": float,         # 相关性评分
            "published_date": str,  # 发布时间（可能为空）
        }
    搜索失败时返回空列表（不阻断主流程）。
    """
    if not query:
        return []
    seen = {}
    try:
        for page in range(1, pages + 1):
            params = {"q": query, "format": "json", "pageno": page}
            resp = requests.get(f"{SEARXNG_BASE_URL}/search", params=params, timeout=15)
            resp.raise_for_status()
            data = resp.json()
            results = data.get("results", []) or []
            for r in results:
                title = (r.get("title") or "").strip()
                url = (r.get("url") or "").strip()
                content = (r.get("content") or "").strip()
                if not (title or content) or not url:
                    continue
                key = _normalize_title(title) or url
                if key in seen:
                    continue
                seen[key] = {
                    "title": title,
                    "url": url,
                    "content": content,
                    "domain": _extract_domain(url),
                    "engines": r.get("engines") or [r.get("engine")] or [],
                    "score": r.get("score"),
                    "published_date": r.get("publishedDate") or "",
                }
            if len(seen) >= max_results:
                break
            if len(results) == 0:
                break
        # 按相关性评分降序，再截断到 max_results
        out = sorted(seen.values(), key=lambda x: x.get("score") or 0, reverse=True)[:max_results]
        # 时效倾向查询：剔除发布时间明确且过旧的旧闻，避免 AI 拿到过时信息
        if _looks_time_sensitive(query):
            filtered = _filter_recent(out)
            if filtered != out:
                logger.info(f"🔎 时效过滤: {query} -> {len(out)} 条中剔除旧结果，保留 {len(filtered)} 条")
            out = filtered
        logger.info(f"🔎 SearXNG 搜索结果: {query} -> {len(out)} 条")
        return out
    except Exception as e:
        logger.warning(f"⚠️ SearXNG 搜索失败（{SEARXNG_BASE_URL}）: {e}")
        return []