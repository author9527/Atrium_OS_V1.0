# ==========================================
# Atrium OS - 敏感信息加密模块
# 用于 API Key 等敏感字段的加密存储与解密读取。
# 加密密钥派生自 auth 的 JWT 密钥（.jwt_secret），零外部依赖。
# ==========================================

import hashlib
import os

try:
    from cryptography.fernet import Fernet
    _HAS_CRYPTO = True
except Exception:
    _HAS_CRYPTO = False


def _derive_key() -> bytes:
    """从 JWT 密钥派生 Fernet 密钥（32 字节 urlsafe base64）。"""
    from server.auth import _get_secret_key
    secret = _get_secret_key().encode("utf-8")
    # 用 SHA-256 固定派生 32 字节，再 base64 编码成 Fernet 需要的格式
    digest = hashlib.sha256(secret).digest()
    import base64
    return base64.urlsafe_b64encode(digest)


def encrypt(plaintext: str) -> str:
    """加密明文，返回带前缀的密文；无 cryptography 时原样返回（仍做标记）。"""
    if not plaintext:
        return ""
    if not _HAS_CRYPTO:
        return f"enc:{_simple_xor(plaintext)}"
    f = Fernet(_derive_key())
    return f"enc:{f.encrypt(plaintext.encode('utf-8')).decode('utf-8')}"


def decrypt(ciphertext: str) -> str:
    """解密密文。无前缀或解密失败时原样返回（兼容旧数据）。"""
    if not ciphertext:
        return ""
    if not ciphertext.startswith("enc:"):
        return ciphertext
    body = ciphertext[4:]
    try:
        if not _HAS_CRYPTO:
            return _simple_xor(body)
        f = Fernet(_derive_key())
        return f.decrypt(body.encode('utf-8')).decode('utf-8')
    except Exception:
        # 无法解密（密钥变更等），返回空串，避免崩溃
        return ""


def _simple_xor(data: str) -> str:
    """无 cryptography 时的兜底对称加密（非安全，仅避免明文落盘）。"""
    key = _derive_key()
    return ''.join(chr(ord(c) ^ key[i % len(key)]) for i, c in enumerate(data))