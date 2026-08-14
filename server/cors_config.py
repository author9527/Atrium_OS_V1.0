# ==========================================
# Atrium OS - CORS 白名单配置
# 默认只放行本机前端与内网/内网穿透来源，不放开任意来源。
# 可通过环境变量 ALLOWED_ORIGINS 精确指定允许的 Origin（逗号分隔）。
# ==========================================

import os
import re

# 匹配本机前端开发地址
_LOCAL_RE = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$")

# 匹配内网 / 内网穿透地址：
#   10.x             - 私有 A 类
#   192.168.x        - 私有 C 类
#   172.16-31.x      - 私有 B 类
#   100.64-127.x     - Tailscale / CGNAT 段
_NET_RE = re.compile(
    r"^https?://("
    r"10\.\d{1,3}(\.\d{1,3}){2}"
    r"|192\.168\.\d{1,3}\.\d{1,3}"
    r"|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}"
    r"|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}"
    r")(:\d+)?$"
)


def build_cors_parameters():
    """返回 (allow_origins: list, allow_origin_regex: str|None)。

    若设置了 ALLOWED_ORIGINS 环境变量（逗号分隔的完整 Origin），
    则精确放行这些来源，不做网络段匹配。
    否则放行 localhost 与内网/内网穿透网络段。
    """
    env = os.environ.get("ALLOWED_ORIGINS", "").strip()
    if env:
        origins = [o.strip() for o in env.split(",") if o.strip()]
        return origins, None

    # 默认：放行本机与内网段。用 "|" 组合两个正则，避免 Starlette 对空串的误匹配。
    return [], f"({_LOCAL_RE.pattern[1:-1]})|({_NET_RE.pattern[1:-1]})"