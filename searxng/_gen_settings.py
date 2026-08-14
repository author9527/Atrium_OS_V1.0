# ==========================================
# Atrium OS - SearXNG 配置生成器
# 生成 settings.yml，启用 JSON 输出（供后端 web_search 工具调用）
# 运行前需先 cd 到本脚本所在目录（deploy_searxng.bat 会自动处理）
# ==========================================

import secrets


def build_settings(secret: str) -> str:
    return f"""# ==========================================
# Atrium OS - SearXNG 配置（由 deploy_searxng.bat 自动生成）
# 基于默认配置，仅覆盖必要项
# ==========================================
use_default_settings: true

general:
  instance_name: "Atrium SearXNG"

search:
  # 关闭自动补全，避免不必要的对外请求
  autocomplete: ""
  # 0: 不过滤, 1: 温和, 2: 严格
  safe_search: 0
  # 启用 JSON 输出格式（后端 web_search 工具依赖 format=json）
  formats:
    - html
    - json

engines:
  # 国内可达的引擎（经实测 baidu / sogou / 360search 可用）
  - name: baidu
    engine: baidu
    shortcut: bd
    disabled: false
  - name: sogou
    engine: sogou
    shortcut: sg
    disabled: false
  - name: 360search
    engine: 360search
    shortcut: 360
    disabled: false
  - name: chinaso
    engine: chinaso
    shortcut: cs
    disabled: false
  - name: bing
    engine: bing
    shortcut: b
    disabled: false
  # 大陆网络通常无法直达的引擎，显式禁用，避免每次搜索都超时拖慢响应
  - name: google
    engine: google
    disabled: true
  - name: google images
    engine: google_images
    disabled: true
  - name: google news
    engine: google_news
    disabled: true
  - name: google videos
    engine: google_videos
    disabled: true
  - name: google scholar
    engine: google_scholar
    disabled: true
  - name: duckduckgo
    engine: duckduckgo
    disabled: true
  - name: duckduckgo definitions
    engine: duckduckgo_definitions
    disabled: true
  - name: duckduckgo weather
    engine: duckduckgo_weather
    disabled: true
  - name: brave
    engine: brave
    disabled: true
  - name: startpage
    engine: startpage
    disabled: true
  - name: wikipedia
    engine: wikipedia
    disabled: true
  - name: qwant
    engine: qwant
    disabled: true
  - name: mojeek
    engine: mojeek
    disabled: true
  - name: marginalia
    engine: marginalia
    disabled: true
  - name: yahoo
    engine: yahoo
    disabled: true
  - name: bing videos
    engine: bing_videos
    disabled: true
  - name: bing news
    engine: bing_news
    disabled: true
  - name: bing images
    engine: bing_images
    disabled: true

server:
  port: 8888
  bind_address: "127.0.0.1"
  # 随机密钥，防止实例被公开滥用
  secret_key: "{secret}"
  # 使用 GET 便于 JSON API 直接调用
  method: "GET"
  limiter: false
  image_proxy: false
  http_protocol_version: "1.0"
"""


def main():
    secret = secrets.token_hex(16)
    settings = build_settings(secret)
    # 相对路径：脚本需从 searxng 目录运行
    with open("settings.yml", "w", encoding="utf-8") as f:
        f.write(settings)
    print("已生成 settings.yml（secret_key 已随机生成）")


if __name__ == "__main__":
    main()