# ==========================================
# Atrium OS - 日记数据导入导出（中转格式 + 转换器）
#
# 设计原则：
#   1. 自建「富文本 JSON」作为唯一事实来源（canonical 格式），
#      以 HTML 承载富文本（与前端 Tiptap 编辑器产物一致），
#      完整保留排版、图片、标签、天气、时间等元数据。
#   2. 其余格式（Day One JSON / CSV / Markdown / 纯文本）一律通过
#      转换器映射到 canonical 格式，实现「多格式输入 → 中转 → 多格式输出」。
#   3. 导入仅写库，绝不触发任何数据分析管线（实体提取/摘要/情绪/沉淀）。
# ==========================================

import json
import re
from datetime import datetime
from html.parser import HTMLParser
from typing import List, Dict, Any, Optional, Tuple

from server.logger import logger

# must be a plain string, not JSON object
CANONICAL_FORMAT = "atrium-diary"
CANONICAL_VERSION = "1.0"

# 支持的导入/导出格式（route 与前端共用）
SUPPORTED_FORMATS = ["atrium", "dayone", "csv", "markdown", "text"]

# 常见天气词映射（Day One 用英文/中文天气词 → 本项目默认中文天气词）
_WEATHER_MAP = {
    "sunny": "晴", "clear": "晴", "晴": "晴",
    "cloudy": "多云", "partly cloudy": "多云", "多云": "多云",
    "rain": "雨", "rainy": "雨", "雨": "雨",
    "snow": "雪", "snowy": "雪", "雪": "雪",
    "windy": "风", "风": "风",
    "fog": "雾", "foggy": "雾", "雾": "雾",
    "storm": "雷雨", "thunderstorm": "雷雨", "雷雨": "雷雨",
    "hot": "热", "cold": "冷", "overcast": "阴", "阴": "阴",
}


# ==========================================
# 富文本转换工具（HTML ↔ 纯文本 / Markdown）
# ==========================================

class _TextExtractor(HTMLParser):
    """从 HTML 中提取纯文本，保留块级换行。"""
    def __init__(self):
        super().__init__()
        self.parts = []
        self._block_tags = {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "tr", "ul", "ol"}
        self._skip = {"script", "style"}

    def handle_starttag(self, tag, attrs):
        if tag in self._skip:
            return
        if tag in self._block_tags:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self._skip:
            return
        if tag in self._block_tags:
            self.parts.append("\n")

    def handle_data(self, data):
        self.parts.append(data)

    def text(self) -> str:
        raw = "".join(self.parts)
        # 压缩连续空行，保留单换行
        lines = [l.rstrip() for l in raw.split("\n")]
        out = []
        prev_blank = False
        for line in lines:
            if not line.strip():
                if not prev_blank:
                    out.append("")
                prev_blank = True
            else:
                out.append(line)
                prev_blank = False
        return "\n".join(out).strip()


def html_to_text(html: str) -> str:
    """富文本 HTML → 纯文本（保留段落结构）。"""
    if not html:
        return ""
    parser = _TextExtractor()
    try:
        parser.feed(html)
    except Exception:
        return html
    return parser.text()


_HEADING_RE = re.compile(r"^#{1,6}\s+(.*)$")
_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
_ITAL_RE = re.compile(r"(?<!\*)\*([^*\n]+)\*(?!\*)")
_INLINE_CODE_RE = re.compile(r"`([^`\n]+)`")
_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
_IMG_RE = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")
_LIST_RE = re.compile(r"^[-*+]\s+(.*)$")
_ORDERED_LIST_RE = re.compile(r"^\d+\.\s+(.*)$")
_CODE_FENCE_RE = re.compile(r"```(\w*)\n?(.*?)```", re.DOTALL)


def markdown_to_html(md: str) -> str:
    """轻量 Markdown → HTML（覆盖日记常用语法：标题/加粗/斜体/代码/链接/图片/列表/引用）。"""
    if not md:
        return ""
    import html as htmllib
    # 代码块优先处理
    def _replace_fence(m):
        lang = m.group(1) or ""
        code = htmllib.escape(m.group(2))
        cls = f' class="language-{lang}"' if lang else ""
        return f"<pre><code{cls}>{code}</code></pre>"
    md = _CODE_FENCE_RE.sub(_replace_fence, md)

    out_lines = []
    in_list = False
    list_type = None
    for raw in md.split("\n"):
        line = raw.rstrip()
        heading = _HEADING_RE.match(line)
        if heading:
            if in_list:
                out_lines.append(f"</{list_type}>")
                in_list = False
            level = len(_HEADING_RE.match(line).group(0).split(" ")[0])
            out_lines.append(f"<h{level}>{_inline_md(heading.group(1))}</h{level}>")
            continue
        if line.strip() == "---":
            if in_list:
                out_lines.append(f"</{list_type}>")
                in_list = False
            out_lines.append("<hr>")
            continue
        if line.strip().startswith(">"):
            if in_list:
                out_lines.append(f"</{list_type}>")
                in_list = False
            out_lines.append(f"<blockquote>{_inline_md(line.strip()[1:].strip())}</blockquote>")
            continue
        list_match = _LIST_RE.match(line)
        ordered_match = _ORDERED_LIST_RE.match(line) if not list_match else None
        if list_match:
            t = "ul"
            item = list_match.group(1)
        elif ordered_match:
            t = "ol"
            item = ordered_match.group(1)
        else:
            if in_list:
                out_lines.append(f"</{list_type}>")
                in_list = False
            if line.strip():
                out_lines.append(f"<p>{_inline_md(line.strip())}</p>")
            else:
                out_lines.append("")
            continue
        if not in_list:
            in_list = True
            list_type = t
            out_lines.append(f"<{t}>")
        out_lines.append(f"<li>{_inline_md(item)}</li>")
    if in_list:
        out_lines.append(f"</{list_type}>")
    return "\n".join(out_lines)


def _inline_md(text: str) -> str:
    """行内 Markdown → HTML（图片/链接/代码/加粗/斜体）。"""
    import html as htmllib
    def _img(m):
        alt, src = m.group(1), m.group(2)
        return f'<img src="{src}" alt="{alt}">'
    text = _IMG_RE.sub(_img, text)
    def _link(m):
        label, url = m.group(1), m.group(2)
        return f'<a href="{url}">{_inline_md(label)}</a>'
    text = _LINK_RE.sub(_link, text)
    def _code(m):
        return f"<code>{htmllib.escape(m.group(1))}</code>"
    text = _INLINE_CODE_RE.sub(_code, text)
    text = _BOLD_RE.sub(r"<strong>\1</strong>", text)
    text = _ITAL_RE.sub(r"<em>\1</em>", text)
    return text


def html_to_markdown(html: str) -> str:
    """富文本 HTML → Markdown（保留标题/加粗/斜体/列表/链接/图片/代码块）。"""
    if not html:
        return ""
    # 简单标记替换（覆盖本项目 Tiptap 常用输出）
    md = html
    md = re.sub(r"<h([1-6])>(.*?)</h\1>", lambda m: "#" * int(m.group(1)) + " " + _tags_to_md(m.group(2)) + "\n", md, flags=re.DOTALL)
    md = re.sub(r"<strong>(.*?)</strong>", r"**\1**", md, flags=re.DOTALL)
    md = re.sub(r"<b>(.*?)</b>", r"**\1**", md, flags=re.DOTALL)
    md = re.sub(r"<em>(.*?)</em>", r"*\1*", md, flags=re.DOTALL)
    md = re.sub(r"<i>(.*?)</i>", r"*\1*", md, flags=re.DOTALL)
    md = re.sub(r"<code>(.*?)</code>", r"`\1`", md, flags=re.DOTALL)
    md = re.sub(r"<a href=\"([^\"]*)\">(.*?)</a>", r"[\2](\1)", md, flags=re.DOTALL)
    md = re.sub(r"<img[^>]*src=\"([^\"]*)\"[^>]*>", r"![](\1)", md)
    md = re.sub(r"<blockquote>(.*?)</blockquote>", lambda m: "> " + _tags_to_md(m.group(1)).replace("\n", "\n> "), md, flags=re.DOTALL)
    md = re.sub(r"<li>(.*?)</li>", lambda m: "- " + _tags_to_md(m.group(1)), md, flags=re.DOTALL)
    md = re.sub(r"<pre><code[^>]*>(.*?)</code></pre>", lambda m: "```\n" + _tags_to_md(m.group(1)) + "\n```", md, flags=re.DOTALL)
    md = re.sub(r"<p>(.*?)</p>", lambda m: _tags_to_md(m.group(1)) + "\n\n", md, flags=re.DOTALL)
    md = re.sub(r"<br\s*/?>", "\n", md)
    md = re.sub(r"<[^>]+>", "", md)  # 兜底剥离剩余标签
    # 清理多余空行
    md = re.sub(r"\n{3,}", "\n\n", md)
    return md.strip()


def _tags_to_md(text: str) -> str:
    """对一段文本做行内标签 → Markdown 的轻量替换（供 html_to_markdown 复用）。"""
    text = re.sub(r"<strong>(.*?)</strong>", r"**\1**", text)
    text = re.sub(r"<em>(.*?)</em>", r"*\1*", text)
    text = re.sub(r"<code>(.*?)</code>", r"`\1`", text)
    text = re.sub(r"<[^>]+>", "", text)
    return text


# ==========================================
# 自建富文本 JSON（canonical）格式
# ==========================================

def make_canonical_entry(date: str, content: str, weather: str = "晴",
                         tags: List[str] = None, created_at: str = None,
                         updated_at: str = None) -> Dict[str, Any]:
    """构造一条 canonical 日记条目。content 为富文本 HTML。"""
    now = datetime.now().isoformat()
    return {
        "date": date,
        "content": content or "",
        "weather": weather or "晴",
        "tags": tags or [],
        "created_at": created_at or now,
        "updated_at": updated_at or now,
    }


def build_canonical(entries: List[Dict[str, Any]]) -> Dict[str, Any]:
    """把条目列表包装为 canonical 文档（含格式标记与版本）。"""
    return {
        "format": CANONICAL_FORMAT,
        "version": CANONICAL_VERSION,
        "exported_at": datetime.now().isoformat(),
        "count": len(entries),
        "entries": entries,
    }


# ==========================================
# 格式检测
# ==========================================

def detect_format(text: str, filename: str = "") -> str:
    """根据文件内容与文件名推断导入格式。返回 SUPPORTED_FORMATS 之一。"""
    name = (filename or "").lower()
    if name.endswith(".json"):
        # JSON：进一步区分 atrium 与 dayone
        return "atrium" if _looks_like_atrium(text) else "dayone"
    if name.endswith(".csv"):
        return "csv"
    if name.endswith(".md") or name.endswith(".markdown"):
        return "markdown"
    if name.endswith(".txt"):
        return "text"
    # 无扩展名 → 按内容嗅探
    stripped = text.lstrip()
    if stripped.startswith("{"):
        return "atrium" if _looks_like_atrium(text) else "dayone"
    if stripped.startswith("["):
        return "dayone"
    if "," in text[:500] and "\n" in text:
        first_line = text.split("\n", 1)[0].strip().lower()
        if first_line.startswith(("date", "日期")) or re.search(r",", first_line):
            return "csv"
    if stripped.startswith("---") or stripped.startswith("# ") or "##" in text[:400]:
        return "markdown"
    return "text"


def _looks_like_atrium(text: str) -> bool:
    try:
        obj = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return False
    if isinstance(obj, dict) and obj.get("format") == CANONICAL_FORMAT:
        return True
    if isinstance(obj, dict) and "entries" in obj and isinstance(obj["entries"], list):
        # 可能是 atrium 或自定义 entries，继续按 atrium 处理
        return True
    return False


# ==========================================
# 各格式 → canonical（导入）
# ==========================================

def _norm_date(value: Any) -> Optional[str]:
    """把各种日期表示（ISO 字符串/时间戳/毫秒时间戳）归一为 YYYY-MM-DD。"""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        # 秒或毫秒时间戳
        v = float(value)
        if v > 1e12:
            v = v / 1000.0
        try:
            return datetime.fromtimestamp(v).strftime("%Y-%m-%d")
        except Exception:
            return None
    s = str(value).strip()
    m = re.match(r"(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if m:
        return f"{int(m.group(1)):04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    m = re.match(r"(\d{4})[/.](\d{1,2})[/.](\d{1,2})", s)
    if m:
        return f"{int(m.group(1)):04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    return None


def _norm_weather(value: Any) -> str:
    if not value:
        return "晴"
    key = str(value).strip().lower()
    return _WEATHER_MAP.get(key, str(value).strip())


def _norm_tags(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(t) for t in value if str(t).strip()]
    if isinstance(value, str):
        # 支持逗号/空格/中英文顿号分隔
        parts = re.split(r"[,，、\s;；]+", value.strip())
        return [p for p in parts if p]
    return []


def convert_atrium_to_canonical(text: str) -> List[Dict[str, Any]]:
    """自建 JSON → canonical（基本为透传，做字段归一与兜底）。"""
    obj = json.loads(text)
    raw_entries = obj.get("entries") if isinstance(obj, dict) else obj
    if isinstance(raw_entries, dict):
        raw_entries = [raw_entries]
    if not isinstance(raw_entries, list):
        raise ValueError("atrium JSON 中缺少 entries 数组")
    entries = []
    for raw in raw_entries:
        if not isinstance(raw, dict):
            continue
        date = _norm_date(raw.get("date") or raw.get("creationDate"))
        if not date:
            continue
        content = raw.get("content") or raw.get("text") or ""
        # 确保 content 是富文本 HTML（若为纯文本则包一层 p）
        if content and not re.search(r"<[a-zA-Z/]", content):
            content = f"<p>{content}</p>"
        entries.append(make_canonical_entry(
            date=date,
            content=content,
            weather=_norm_weather(raw.get("weather")),
            tags=_norm_tags(raw.get("tags")),
            created_at=raw.get("created_at") or raw.get("creationDate"),
            updated_at=raw.get("updated_at") or raw.get("modifiedDate"),
        ))
    return entries


def convert_dayone_to_canonical(text: str) -> List[Dict[str, Any]]:
    """Day One JSON → canonical。Day One 导出为 JSON 数组，或含 entries 键的对象。"""
    obj = json.loads(text)
    raw_entries = obj.get("entries") if isinstance(obj, dict) else obj
    if isinstance(raw_entries, dict):
        raw_entries = [raw_entries]
    if not isinstance(raw_entries, list):
        raise ValueError("Day One JSON 中缺少 entries 数组")
    entries = []
    for raw in raw_entries:
        if not isinstance(raw, dict):
            continue
        date = _norm_date(raw.get("creationDate") or raw.get("modifiedDate") or raw.get("date"))
        if not date:
            continue
        # Day One 富文本优先用 richContent（HTML），否则用 text（纯文本/Markdown）
        content = raw.get("richContent") or raw.get("richText") or raw.get("text") or ""
        if content and not re.search(r"<[a-zA-Z/]", content):
            content = f"<p>{content}</p>"
        entries.append(make_canonical_entry(
            date=date,
            content=content,
            weather=_norm_weather(raw.get("weather")),
            tags=_norm_tags(raw.get("tags")),
            created_at=raw.get("creationDate") or raw.get("date"),
            updated_at=raw.get("modifiedDate") or raw.get("date"),
        ))
    return entries


def convert_csv_to_canonical(text: str) -> List[Dict[str, Any]]:
    """CSV → canonical。期望表头含 date/日期、content/内容/正文、weather/天气、tags/标签。"""
    import csv as csvlib
    import io
    reader = csvlib.DictReader(io.StringIO(text))
    if reader.fieldnames is None:
        raise ValueError("CSV 缺少表头")
    # 字段名归一（英文/中文）
    def _pick(row, *keys):
        for k in keys:
            if k in row and row.get(k) is not None and str(row[k]).strip():
                return row[k]
        return None
    entries = []
    for row in reader:
        date = _norm_date(_pick(row, "date", "Date", "日期", "creationDate", "day"))
        if not date:
            continue
        content = _pick(row, "content", "Content", "内容", "正文", "text", "note", "entry")
        tags = _pick(row, "tags", "Tags", "标签", "tag")
        weather = _pick(row, "weather", "Weather", "天气")
        entries.append(make_canonical_entry(
            date=date,
            content=f"<p>{content}</p>" if content else "",
            weather=_norm_weather(weather),
            tags=_norm_tags(tags),
        ))
    return entries


def convert_markdown_to_canonical(text: str) -> List[Dict[str, Any]]:
    """Markdown → canonical。支持两类：
      1) 单篇：YAML frontmatter（date/weather/tags）+ 正文
      2) 多篇：以 --- 分隔的多个 frontmatter 块。
    """
    entries = []
    # 按 frontmatter 块切分：---\n yaml \n---\n body
    blocks = re.split(r"(?m)^---\s*$", text)
    # blocks 结构: [前导, yaml, body, yaml, body, ...]
    i = 1
    while i + 1 < len(blocks):
        meta = _parse_frontmatter(blocks[i])
        body = blocks[i + 1].strip() if i + 1 < len(blocks) else ""
        date = meta.get("date")
        if not date:
            i += 2
            continue
        entries.append(make_canonical_entry(
            date=date,
            content=markdown_to_html(body),
            weather=_norm_weather(meta.get("weather")),
            tags=_norm_tags(meta.get("tags")),
        ))
        i += 2
    # 无 frontmatter → 尝试从首行 # 标题或 filename 推断日期
    if not entries:
        date = _norm_date(text.split("\n", 1)[0].strip().lstrip("#").strip())
        if date:
            body = "\n".join(text.split("\n")[1:]).strip()
            entries.append(make_canonical_entry(date=date, content=markdown_to_html(body)))
    return entries


def _parse_frontmatter(yaml_text: str) -> Dict[str, Any]:
    """极简 YAML frontmatter 解析（key: value 形式）。"""
    meta = {}
    for line in yaml_text.split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip().lower()] = v.strip().strip("'\"")
    return meta


def convert_text_to_canonical(text: str, filename: str = "") -> List[Dict[str, Any]]:
    """纯文本 → canonical。日期来源：首行 date:/日期: 标记，或文件名，否则用今天。"""
    date = None
    first_line = text.split("\n", 1)[0].strip()
    m = re.match(r"^(?:date|日期)\s*[:：]\s*(.+)$", first_line, re.IGNORECASE)
    if m:
        date = _norm_date(m.group(1))
        body = "\n".join(text.split("\n")[1:]).strip()
    else:
        date = _norm_date(_extract_date_from_filename(filename))
        body = text.strip()
    if not date:
        date = datetime.now().strftime("%Y-%m-%d")
    return [make_canonical_entry(date=date, content=f"<p>{body}</p>" if body else "")]


def _extract_date_from_filename(filename: str) -> str:
    m = re.search(r"(\d{4})[-/.]?(\d{1,2})[-/.]?(\d{1,2})", filename or "")
    if m:
        return f"{int(m.group(1)):04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    return ""


# 导入分派表
_IMPORT_CONVERTERS = {
    "atrium": convert_atrium_to_canonical,
    "dayone": convert_dayone_to_canonical,
    "csv": convert_csv_to_canonical,
    "markdown": convert_markdown_to_canonical,
    "text": convert_text_to_canonical,
}


def import_to_canonical(text: str, source_format: str = None, filename: str = "") -> Tuple[List[Dict[str, Any]], str]:
    """统一导入入口：任意支持的格式 → canonical 条目列表。
    返回 (entries, detected_format)。source_format 为空时自动检测。"""
    fmt = source_format or detect_format(text, filename)
    if fmt not in _IMPORT_CONVERTERS:
        raise ValueError(f"不支持的导入格式: {fmt}")
    converter = _IMPORT_CONVERTERS[fmt]
    if fmt == "text":
        entries = converter(text, filename)
    else:
        entries = converter(text)
    return entries, fmt


# ==========================================
# canonical → 各格式（导出）
# ==========================================

def export_atrium(entries: List[Dict[str, Any]]) -> str:
    return json.dumps(build_canonical(entries), ensure_ascii=False, indent=2)


def export_dayone(entries: List[Dict[str, Any]]) -> str:
    """canonical → Day One JSON（数组）。保留富文本为 richContent，纯文本为 text。"""
    out = []
    for e in entries:
        content = e.get("content") or ""
        plain = html_to_text(content)
        item = {
            "creationDate": e.get("created_at") or f"{e['date']}T09:00:00",
            "text": plain,
            "tags": e.get("tags") or [],
            "weather": e.get("weather") or "晴",
        }
        if content and re.search(r"<[a-zA-Z/]", content):
            item["richContent"] = content
        out.append(item)
    return json.dumps(out, ensure_ascii=False, indent=2)


def export_csv(entries: List[Dict[str, Any]]) -> str:
    import csv as csvlib
    import io
    buf = io.StringIO()
    writer = csvlib.writer(buf)
    writer.writerow(["date", "weather", "tags", "content"])
    for e in entries:
        plain = html_to_text(e.get("content") or "")
        writer.writerow([
            e.get("date", ""),
            e.get("weather", ""),
            "|".join(e.get("tags") or []),
            plain,
        ])
    return buf.getvalue()


def export_markdown(entries: List[Dict[str, Any]]) -> str:
    """canonical → Markdown（每篇一个 frontmatter 块，--- 分隔）。"""
    parts = []
    for e in entries:
        meta = []
        meta.append(f"date: {e.get('date', '')}")
        meta.append(f"weather: {e.get('weather', '')}")
        if e.get("tags"):
            meta.append(f"tags: {','.join(e.get('tags'))}")
        body = html_to_markdown(e.get("content") or "")
        parts.append("---\n" + "\n".join(meta) + "\n---\n\n" + body)
    return "\n\n---\n\n".join(parts)


def export_text(entries: List[Dict[str, Any]]) -> str:
    blocks = []
    for e in entries:
        blocks.append(f"date: {e.get('date', '')}\n\n{html_to_text(e.get('content') or '')}")
    return "\n\n---\n\n".join(blocks)


_EXPORT_CONVERTERS = {
    "atrium": export_atrium,
    "dayone": export_dayone,
    "csv": export_csv,
    "markdown": export_markdown,
    "text": export_text,
}

_EXPORT_EXT = {
    "atrium": "json",
    "dayone": "json",
    "csv": "csv",
    "markdown": "md",
    "text": "txt",
}


def export_entries(entries: List[Dict[str, Any]], target_format: str) -> str:
    """统一导出入口：canonical 条目列表 → 目标格式文本。"""
    if target_format not in _EXPORT_CONVERTERS:
        raise ValueError(f"不支持的导出格式: {target_format}")
    return _EXPORT_CONVERTERS[target_format](entries)


def export_extension(target_format: str) -> str:
    return _EXPORT_EXT.get(target_format, "txt")


def format_label(fmt: str) -> str:
    labels = {
        "atrium": "Atrium 富文本 JSON",
        "dayone": "Day One JSON",
        "csv": "CSV",
        "markdown": "Markdown",
        "text": "纯文本",
    }
    return labels.get(fmt, fmt)