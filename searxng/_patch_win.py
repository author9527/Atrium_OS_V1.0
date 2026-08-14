# ==========================================
# Atrium OS - SearXNG Windows 兼容性补丁（幂等，可重复执行）
# 由 deploy_searxng.bat 在装完依赖后调用；需从 searxng 目录运行（相对路径）
# 修复：
#   1. 缺少 searx/version_frozen.py（源码包无 git 时无法生成版本信息）
#   2. valkeydb.py 导入仅 Unix 的 pwd 模块导致 Windows 崩溃
#   3. botdetection/config.py 使用 Python3.11 才有的 tomllib（本机是 3.10）
#   4. 补装 tomli / tzdata（3.10 缺 tomllib；部分引擎需要 tzdata）
# ==========================================

import os
import subprocess
import sys

SRC = "searxng-src"
VENV = "searxng-venv"
PY = os.path.join(VENV, "Scripts", "python.exe")


def patch_version_frozen():
    path = os.path.join(SRC, "searx", "version_frozen.py")
    if os.path.exists(path):
        print("  [ok] version_frozen.py exists, skip")
        return
    content = (
        "# SPDX-License-Identifier: AGPL-3.0-or-later\n"
        "# generated for running from a source tarball without git\n"
        'VERSION_STRING = "master"\n'
        'VERSION_TAG = "master"\n'
        'DOCKER_TAG = "master"\n'
        'GIT_URL = "unknown"\n'
        'GIT_BRANCH = "master"\n'
    )
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print("  [ok] version_frozen.py created")


def patch_valkeydb():
    path = os.path.join(SRC, "searx", "valkeydb.py")
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    if "HAS_PWD" in text:
        print("  [ok] valkeydb.py already patched, skip")
        return
    old_import = "import os\nimport pwd\nimport logging\nimport warnings\n"
    new_import = (
        "import os\n"
        "import logging\n"
        "import warnings\n"
        "\n"
        "try:\n"
        "    import pwd  # Unix-only; not available on Windows\n"
        "    HAS_PWD = True\n"
        "except ImportError:\n"
        "    pwd = None\n"
        "    HAS_PWD = False\n"
        "\n"
    )
    if old_import not in text:
        print("  [warn] valkeydb.py import block not found, skip")
        return
    text = text.replace(old_import, new_import)
    old_handler = (
        "        _CLIENT = None\n"
        "        _pw = pwd.getpwuid(os.getuid())\n"
        "        logger.exception(\"[%s (%s)] can't connect valkey DB ...\", _pw.pw_name, _pw.pw_uid)\n"
    )
    new_handler = (
        "        _CLIENT = None\n"
        "        if HAS_PWD:\n"
        "            _pw = pwd.getpwuid(os.getuid())\n"
        "            logger.exception(\"[%s (%s)] can't connect valkey DB ...\", _pw.pw_name, _pw.pw_uid)\n"
        "        else:\n"
        "            logger.exception(\"can't connect valkey DB ...\")\n"
    )
    if old_handler in text:
        text = text.replace(old_handler, new_handler)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print("  [ok] valkeydb.py patched")


def patch_config_tomllib():
    path = os.path.join(SRC, "searx", "botdetection", "config.py")
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    if "except ModuleNotFoundError" in text and "tomli" in text:
        print("  [ok] config.py already patched, skip")
        return
    old = "import tomllib\n"
    new = (
        "try:\n"
        "    import tomllib  # Python 3.11+\n"
        "except ModuleNotFoundError:\n"
        "    import tomli as tomllib  # backport for Python < 3.11\n"
    )
    if old not in text:
        print("  [warn] config.py import not found, skip")
        return
    text = text.replace(old, new)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print("  [ok] config.py patched")


def pip_install(pkg):
    print(f"  install extra dep: {pkg}")
    subprocess.run([PY, "-m", "pip", "install", pkg], check=True)


def main():
    print("Applying SearXNG Windows compatibility patches ...")
    patch_version_frozen()
    patch_valkeydb()
    patch_config_tomllib()
    pip_install("tomli")
    pip_install("tzdata")
    print("Patches done.")


if __name__ == "__main__":
    main()