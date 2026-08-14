# ==========================================
# Atrium OS - 认证路由（注册/登录/用户信息）
# ==========================================

import re
import time
from collections import defaultdict, deque
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, field_validator
from server.auth import hash_password, verify_password, create_token, verify_token, get_current_user
from server.app import get_diary_storage, get_core_storage, migrate_legacy_data
from server.logger import logger

router = APIRouter()


# ==========================================
# 登录/注册速率限制（防暴力破解与账号枚举）
# 基于"IP + 用户名"维度的内存滑动窗口限流。
# 说明：本项目为单进程 Uvicorn 部署（本地/内网），内存字典足够；
# 若未来水平扩容为多进程，需迁移到 Redis 等共享存储。
# ==========================================
_LIMIT_WINDOW_SECONDS = 60      # 窗口：60 秒
_LOGIN_MAX_FAILURES = 5         # 窗口内最多允许 5 次登录失败
_REGISTER_MAX_PER_IP = 5        # 窗口内同 IP 最多注册 5 次（防枚举/滥用）

# key -> deque[失败/尝试时间戳]，deque 按时间升序
_LOGIN_FAILURES: dict[str, deque] = defaultdict(deque)
_REGISTER_ATTEMPTS: dict[str, deque] = defaultdict(deque)


def _client_ip(raw_request: Request) -> str:
    """取客户端 IP：优先信任 X-Forwarded-For（穿透代理场景），回退 socket 地址。"""
    fwd = raw_request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    if raw_request.client:
        return raw_request.client.host
    return "unknown"


def _prune(dq: deque) -> None:
    """移除窗口期外的旧时间戳，保持 deque 升序。"""
    cutoff = time.time() - _LIMIT_WINDOW_SECONDS
    while dq and dq[0] < cutoff:
        dq.popleft()


def _cooldown_seconds(dq: deque) -> float:
    """返回距离窗口内最早记录的剩余冷却秒数（<=0 表示可放行）。"""
    if not dq:
        return 0.0
    return _LIMIT_WINDOW_SECONDS - (time.time() - dq[0])


def _record_login_failure(ip: str, username: str) -> None:
    key = f"{ip}:{username}"
    dq = _LOGIN_FAILURES[key]
    _prune(dq)
    dq.append(time.time())


def _clear_login_failures(ip: str, username: str) -> None:
    _LOGIN_FAILURES.pop(f"{ip}:{username}", None)


def _check_login_rate(ip: str, username: str) -> Optional[float]:
    """登录前检查是否触发限流；返回冷却秒数（未触发返回 None）。"""
    dq = _LOGIN_FAILURES[f"{ip}:{username}"]
    _prune(dq)
    wait = _cooldown_seconds(dq)
    if len(dq) >= _LOGIN_MAX_FAILURES and wait > 0:
        return wait
    return None


def _check_register_rate(ip: str) -> Optional[float]:
    """注册前检查同 IP 是否触发频率限制；返回冷却秒数（未触发返回 None）。"""
    dq = _REGISTER_ATTEMPTS[ip]
    _prune(dq)
    wait = _cooldown_seconds(dq)
    if len(dq) >= _REGISTER_MAX_PER_IP and wait > 0:
        return wait
    return None


def _record_register_attempt(ip: str) -> None:
    dq = _REGISTER_ATTEMPTS[ip]
    _prune(dq)
    dq.append(time.time())


def _issue_session(user: dict, diary_storage, expires_in: int = 86400 * 30) -> str:
    """签发唯一会话 token。若该账号已有有效会话（未过期），则拒绝新登录，保持旧设备在线。"""
    import time
    now = time.time()
    exp = user.get("current_token_expires")
    if exp is not None and exp > now:
        raise HTTPException(status_code=409, detail="账号已在其他设备登录，请先在该设备退出")
    token = create_token(user["id"], user["username"], expires_in)
    payload = verify_token(token)
    diary_storage.set_user_current_token(user["id"], payload["jti"], payload["exp"])
    return token


class RegisterRequest(BaseModel):
    username: str
    password: str

    @field_validator('username')
    @classmethod
    def username_valid(cls, v):
        v = v.strip()
        if len(v) < 2 or len(v) > 20:
            raise ValueError('用户名长度需在 2-20 个字符之间')
        return v

    @field_validator('password')
    @classmethod
    def password_valid(cls, v):
        # 安全最佳实践（OWASP）：最小长度 8，上限 64（支持长密码/密码短语），
        # 并要求同时包含字母与数字，避免纯数字/纯字母被字典或暴力攻击轻易命中。
        if len(v) < 8:
            raise ValueError('密码长度至少 8 个字符')
        if len(v) > 64:
            raise ValueError('密码长度不能超过 64 个字符')
        if not re.search(r'[A-Za-z]', v):
            raise ValueError('密码需包含至少一个字母')
        if not re.search(r'\d', v):
            raise ValueError('密码需包含至少一个数字')
        return v


class LoginRequest(BaseModel):
    username: str
    password: str


@router.post("/api/auth/register")
async def register(request: RegisterRequest, raw_request: Request,
                   diary_storage=Depends(get_diary_storage)):
    """注册新用户。首个注册用户自动承接 user_id='default' 的旧数据迁移。"""
    # 同 IP 注册频率限制（防批量注册 / 账号枚举滥用）
    ip = _client_ip(raw_request)
    register_wait = _check_register_rate(ip)
    if register_wait is not None:
        raise HTTPException(status_code=429,
                            detail=f"注册过于频繁，请 {int(register_wait)} 秒后重试")
    _record_register_attempt(ip)

    # 检查用户名是否已存在
    existing = diary_storage.get_user_by_username(request.username)
    if existing:
        raise HTTPException(status_code=409, detail="用户名已存在")

    # 判断是否为系统首个用户（注册前无任何用户）
    is_first = not diary_storage.get_all_users()

    # 创建用户
    password_hash = hash_password(request.password)
    user = diary_storage.create_user(request.username, password_hash)

    # 首个用户自动承接旧数据迁移，避免旧数据无归属而丢失
    if is_first:
        try:
            migrate_legacy_data(diary_storage, get_core_storage(), user["id"])
        except Exception as e:
            logger.warning(f"[注册] 旧数据迁移失败（不影响注册）: {e}")

    # 签发唯一会话 token（新用户无既有会话，正常占用）
    token = _issue_session(user, diary_storage)

    return {
        "token": token,
        "user": {"id": user["id"], "username": user["username"]}
    }


@router.post("/api/auth/login")
async def login(request: LoginRequest, raw_request: Request,
                diary_storage=Depends(get_diary_storage)):
    """用户登录（含失败限流，防暴力破解）"""
    ip = _client_ip(raw_request)

    # 登录前检查：若该 IP+用户名在窗口内已失败达到阈值，直接拒绝
    login_wait = _check_login_rate(ip, request.username)
    if login_wait is not None:
        raise HTTPException(status_code=429,
                            detail=f"尝试过于频繁，请 {int(login_wait)} 秒后重试")

    user = diary_storage.get_user_by_username(request.username)
    if not user:
        _record_login_failure(ip, request.username)
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    if not verify_password(request.password, user["password_hash"]):
        _record_login_failure(ip, request.username)
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    # 登录成功：清除该 IP+用户名 的失败记录，避免成功后仍被旧失败计数卡住
    _clear_login_failures(ip, request.username)

    # 签发唯一会话 token；若已有有效会话则拒绝新登录（409）
    token = _issue_session(user, diary_storage)

    return {
        "token": token,
        "user": {"id": user["id"], "username": user["username"]}
    }


@router.get("/api/auth/me")
async def get_me(current_user: dict = Depends(get_current_user)):
    """获取当前用户信息"""
    return {"id": current_user["id"], "username": current_user["username"]}


@router.get("/api/auth/users")
async def list_users(current_user: dict = Depends(get_current_user),
                     diary_storage=Depends(get_diary_storage)):
    """获取所有用户列表（仅用于显示在线用户数等）"""
    users = diary_storage.get_all_users()
    return {"users": users}
