# ==========================================
# Atrium OS - SearXNG 源码下载与解压（纯标准库，无 git / powershell 依赖）
# 需在 searxng 目录下运行（相对路径），由 deploy_searxng.bat 调用
# 下载策略：先直连 GitHub，失败后回退到 ghfast.top 镜像（国内网络更稳）
# ==========================================

import os
import sys
import tarfile
import time
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

# 候选下载源（按顺序尝试）
GITHUB_URL = "https://github.com/searxng/searxng/archive/refs/heads/master.tar.gz"
MIRROR_URL = "https://ghfast.top/" + GITHUB_URL
URLS = [GITHUB_URL, MIRROR_URL]

TARBALL = "searxng-master.tar.gz"
SRC = "searxng-src"


def download(tarball_path):
    """逐个候选源尝试下载，任一成功即返回。"""
    last_err = None
    for i, url in enumerate(URLS):
        print(f"  trying source {i + 1}/{len(URLS)}: {url}")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r, open(tarball_path, "wb") as f:
                while True:
                    chunk = r.read(65536)
                    if not chunk:
                        break
                    f.write(chunk)
            print("  downloaded OK")
            return True
        except Exception as e:
            last_err = e
            print(f"  failed: {type(e).__name__}: {e}")
    print("ERROR: all download sources failed", file=sys.stderr)
    if last_err:
        print(f"  last error: {last_err}", file=sys.stderr)
    return False


def main():
    if os.path.isdir(SRC):
        print("source already exists, skip download/extract")
        return

    if not os.path.exists(TARBALL):
        print("downloading SearXNG source tarball ...")
        if not download(TARBALL):
            sys.exit(1)

    print("extracting ...")
    with tarfile.open(TARBALL, "r:gz") as t:
        t.extractall(".")

    # tar 解压出的顶层目录形如 searxng-master，重命名为 searxng-src
    # WinError 5 可能是杀软/索引器短暂占锁，重试几次
    renamed = False
    for name in os.listdir("."):
        if name.startswith("searxng-") and os.path.isdir(name) and name != SRC:
            if os.path.isdir(SRC):
                print("ERROR: searxng-src already exists", file=sys.stderr)
                sys.exit(1)
            for attempt in range(1, 6):
                try:
                    os.rename(name, SRC)
                    renamed = True
                    break
                except PermissionError:
                    print(f"  rename locked, retry {attempt}/5 ...")
                    time.sleep(2)
            break

    if not renamed:
        print("ERROR: could not rename extracted source dir", file=sys.stderr)
        sys.exit(1)

    print("source ready at " + SRC)


if __name__ == "__main__":
    main()