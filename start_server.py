#!/usr/bin/env python3
"""
Atrium OS V1.0 — 后端服务启动入口
用法: python start_server.py
"""

import sys
import os
import logging

# 添加当前目录到 Python 路径
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# 配置基础日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(name)s] %(levelname)s: %(message)s',
    datefmt='%H:%M:%S'
)

if __name__ == "__main__":
    print("=" * 40)
    print("  Atrium OS V1.0 — 个人记忆操作系统")
    print("=" * 40)
    print(f"  工作目录: {os.getcwd()}")
    print(f"  Python: {sys.version}")

    # 导入并运行 server.app
    from server.app import app, _register_routes

    # 注册路由（延迟导入，避免循环引用）
    _register_routes()

    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")