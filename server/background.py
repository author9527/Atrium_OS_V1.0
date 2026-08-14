# ==========================================
# Atrium OS - 后台任务线程池
# 用有界 ThreadPoolExecutor 替代散落的 threading.Thread 直启，
# 限制并发后台任务数量，避免高并发下无限创建线程导致资源耗尽。
# ==========================================

import os
from concurrent.futures import ThreadPoolExecutor
from server.logger import logger

# 默认最大并发后台任务数（可经环境变量 BACKEND_MAX_WORKERS 覆盖）
_DEFAULT_MAX_WORKERS = int(os.environ.get("BACKEND_MAX_WORKERS", "4"))

_pool: ThreadPoolExecutor | None = None


def _get_pool() -> ThreadPoolExecutor:
    global _pool
    if _pool is None:
        _pool = ThreadPoolExecutor(
            max_workers=_DEFAULT_MAX_WORKERS,
            thread_name_prefix="atrium-bg",
        )
    return _pool


def submit_background(fn, *args, **kwargs):
    """把后台任务提交到有界线程池执行。

    返回 concurrent.futures.Future。任务异常会被静默记录（不抛出到调用方），
    与原先 daemon 线程 try/except 的行为保持一致。
    """
    def _safe(fn=fn, args=args, kwargs=kwargs):
        try:
            return fn(*args, **kwargs)
        except Exception as e:
            logger.error(f"后台任务执行失败 ({getattr(fn, '__name__', fn)}): {e}")
            import traceback
            traceback.print_exc()
    try:
        return _get_pool().submit(_safe)
    except Exception as e:
        logger.error(f"提交后台任务失败: {e}")
        return None


def shutdown_background():
    """应用关闭时调用，等待正在执行的任务完成。"""
    global _pool
    if _pool is not None:
        _pool.shutdown(wait=True)
        _pool = None