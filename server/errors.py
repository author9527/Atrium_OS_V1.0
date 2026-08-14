# ==========================================
# Atrium OS - 统一错误响应结构
# 所有路由的错误响应统一为：
#   {"success": false, "error": {"code": "...", "message": "..."}}
# 成功响应统一为：
#   {"success": true, "data": ...} （或保留原有业务字段）
# ==========================================

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


def ok(data=None, **extra):
    """构造统一成功响应体。"""
    resp = {"success": True}
    if data is not None:
        resp["data"] = data
    resp.update(extra)
    return resp


def fail(code: str = "BAD_REQUEST", message: str = "请求失败", status: int = 400):
    """构造统一错误响应体（可作为返回值或 FastAPI JSONResponse）。"""
    body = {"success": False, "error": {"code": code, "message": message}}
    return JSONResponse(status_code=status, content=body)


def register_error_handlers(app: FastAPI) -> None:
    """为 FastAPI 应用注册全局异常处理器，统一错误输出结构。"""
    from fastapi.exceptions import RequestValidationError
    from starlette.exceptions import HTTPException as StarletteHTTPException

    @app.exception_handler(StarletteHTTPException)
    async def http_exception_handler(request: Request, exc: StarletteHTTPException):
        # 认证类错误沿用 401/403，业务错误用 400
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "success": False,
                "error": {
                    "code": _code_for_status(exc.status_code),
                    "message": str(exc.detail),
                },
            },
        )

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(request: Request, exc: RequestValidationError):
        # 序列化前把 ctx 里的异常对象（如 ValueError）转成可打印字符串，
        # 避免 JSON 序列化失败导致二次崩溃。
        try:
            raw_errors = exc.errors()
        except Exception:
            raw_errors = [{"msg": str(exc)}]
        details = [_safe_error(e) for e in raw_errors]
        return JSONResponse(
            status_code=422,
            content={
                "success": False,
                "error": {
                    "code": "VALIDATION_ERROR",
                    "message": "请求参数校验失败",
                    "details": details,
                },
            },
        )

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        import traceback
        from server.logger import logger
        logger.error("未处理异常: %s\n%s", exc, traceback.format_exc())
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "error": {
                    "code": "INTERNAL_ERROR",
                    "message": "服务器内部错误",
                },
            },
        )


def _code_for_status(status: int) -> str:
    if status == 401:
        return "UNAUTHORIZED"
    if status == 403:
        return "FORBIDDEN"
    if status == 404:
        return "NOT_FOUND"
    if status == 409:
        return "CONFLICT"
    return "BAD_REQUEST"


def _safe_error(e: dict) -> dict:
    """把 Pydantic 校验错误项转为可 JSON 序列化的字典。

    校验错误的 ctx 里可能携带异常对象（如 ValueError），直接序列化会抛 TypeError，
    这里把异常对象转成字符串，其余字段递归安全化。
    """
    out = {}
    for k, v in e.items():
        if isinstance(v, dict):
            out[k] = _safe_error(v)
        elif isinstance(v, (list, tuple)):
            out[k] = [_safe_error(i) if isinstance(i, dict) else str(i) for i in v]
        elif isinstance(v, Exception):
            out[k] = f"{v.__class__.__name__}: {str(v)}"
        else:
            out[k] = v
    return out