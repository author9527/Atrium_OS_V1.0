# ==========================================
# Atrium OS - 认证模块
# 零外部依赖：用 hashlib.pbkdf2_hmac 做密码哈希，用 hmac+hashlib 做 JWT
# ==========================================

import hashlib
import hmac
import json
import base64
import os
import time
import secrets
from fastapi import HTTPException, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

# JWT 密钥（首次运行自动生成，持久化到文件）
SECRET_KEY_FILE = "data/.jwt_secret"
_secret_key = None


def _get_secret_key() -> str:
    global _secret_key
    if _secret_key:
        return _secret_key
    os.makedirs(os.path.dirname(SECRET_KEY_FILE), exist_ok=True)
    if os.path.exists(SECRET_KEY_FILE):
        with open(SECRET_KEY_FILE, "r") as f:
            _secret_key = f.read().strip()
    else:
        _secret_key = secrets.token_hex(32)
        with open(SECRET_KEY_FILE, "w") as f:
            f.write(_secret_key)
    return _secret_key


# ========== 密码哈希 ==========

def hash_password(password: str) -> str:
    """用 PBKDF2-HMAC-SHA256 哈希密码，返回 'salt:hash' 格式"""
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), 100000)
    return f"{salt}:{dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """验证密码是否匹配"""
    try:
        salt, expected_hash = stored.split(':')
        dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), 100000)
        return hmac.compare_digest(dk.hex(), expected_hash)
    except (ValueError, AttributeError):
        return False


# ========== JWT (轻量实现，不依赖外部库) ==========

def _b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('utf-8')


def _b64decode(s: str) -> bytes:
    padding = 4 - len(s) % 4
    if padding != 4:
        s += '=' * padding
    return base64.urlsafe_b64decode(s)


def create_token(user_id: str, username: str, expires_in: int = 86400 * 30) -> str:
    """创建 JWT token，默认 30 天过期。payload 含随机 jti，用于单设备会话绑定。"""
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "sub": user_id,
        "username": username,
        "jti": secrets.token_hex(16),
        "exp": int(time.time()) + expires_in,
    }
    header_b64 = _b64encode(json.dumps(header, separators=(',', ':')).encode())
    payload_b64 = _b64encode(json.dumps(payload, separators=(',', ':')).encode())
    signing_input = f"{header_b64}.{payload_b64}"
    signature = hmac.new(_get_secret_key().encode(), signing_input.encode(), hashlib.sha256).digest()
    sig_b64 = _b64encode(signature)
    return f"{signing_input}.{sig_b64}"


def verify_token(token: str) -> dict:
    """验证 JWT token，返回 payload 或抛出异常"""
    parts = token.split('.')
    if len(parts) != 3:
        raise ValueError("Invalid token format")
    header_b64, payload_b64, sig_b64 = parts
    signing_input = f"{header_b64}.{payload_b64}"
    expected_sig = hmac.new(_get_secret_key().encode(), signing_input.encode(), hashlib.sha256).digest()
    expected_sig_b64 = _b64encode(expected_sig)
    if not hmac.compare_digest(sig_b64, expected_sig_b64):
        raise ValueError("Invalid signature")
    payload = json.loads(_b64decode(payload_b64))
    if payload.get("exp", 0) < time.time():
        raise ValueError("Token expired")
    return payload


# ========== FastAPI 依赖 ==========

security = HTTPBearer(auto_error=False)


async def get_current_user(request: Request) -> dict:
    """FastAPI 依赖：从请求头提取并验证 JWT，返回 {"id": ..., "username": ...}"""
    # 只接受 Authorization: Bearer header，不接受 URL query 参数，
    # 避免 token 出现在访问日志、代理日志、浏览器历史中。
    credentials: HTTPAuthorizationCredentials = await security(request)
    token = None
    if credentials and credentials.credentials:
        token = credentials.credentials

    if not token:
        raise HTTPException(status_code=401, detail="未提供认证信息")
    
    try:
        payload = verify_token(token)
    except ValueError as e:
        raise HTTPException(status_code=401, detail=f"认证失败: {e}")

    # 单设备登录：校验该 token 的 jti 是否为该账号当前唯一有效会话
    jti = payload.get("jti")
    if not jti:
        raise HTTPException(status_code=401, detail="认证已失效，请重新登录")
    try:
        from server.app import get_diary_storage
        user = get_diary_storage().get_user_by_id(payload["sub"])
    except Exception:
        user = None
    if not user or user.get("current_token_jti") != jti:
        raise HTTPException(status_code=401, detail="账号已在其他设备登录，请重新登录")

    return {"id": payload["sub"], "username": payload["username"]}
