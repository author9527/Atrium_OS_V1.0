# ==========================================
# Atrium OS - 统一日志模块
# 收敛后端散落的 print，提供分级日志与统一格式化。
# 用法：from server.logger import logger
#       logger.info("...")  /  logger.warning("...")  /  logger.error("...")
# ==========================================

import logging
import sys
from datetime import datetime

# 模块级 logger 名称（避免重复配置）
_configured = False


def get_logger(name: str = "atrium") -> logging.Logger:
    """获取统一 logger。首次调用时配置根 logger。"""
    global _configured
    if not _configured:
        _configured = True
        _setup_root()
    return logging.getLogger(name)


def _setup_root() -> None:
    """配置根 logger：控制台输出，带时间戳与级别，中文友好。"""
    root = logging.getLogger("atrium")
    if root.handlers:
        return

    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(fmt)
    root.addHandler(handler)
    root.setLevel(logging.INFO)


# 项目统一 logger 实例
logger = get_logger("atrium")