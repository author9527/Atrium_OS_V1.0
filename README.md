# Atrium OS — 心房

> 隐私优先的 AI 日记系统：数据全本地存储，多 Agent 对话，情绪分析，实体管理。

## 项目简介

Atrium OS 是一款以**隐私优先**为核心设计原则的 AI 日记应用。所有数据（日记、实体、情绪分析结果）均存储在手机本地 SQLite 数据库中，AI 推理通过本地 Ollama 或用户自配的 OpenRouter 完成，不依赖任何云端服务器。

系统内置三个独立人格的 AI 角色（鳄正经、鹅小弟、鹿晓葵），通过**冲动值调度系统**模拟真实群聊节奏。同时提供日记情绪分析、实体管理、觉察报告、联网搜索等能力。

## 快速开始

### 方式一：直接下载 APK 安装（推荐）

1. 前往 [Releases 页面](https://github.com/author9527/Atrium_OS_V1.0/releases) 下载最新的 `atriumos-fixed.apk`
2. 将 APK 传输到手机（微信/USB/云盘均可）
3. 在手机上点击安装（需开启"允许安装未知来源应用"）
4. 安装完成后打开 Atrium OS，进入 **设置** 页面配置 LLM 服务地址（见下方隧道教程）

### 方式二：从源码构建

```bash
cd mobile
npm install
# 构建 APK（需要 EAS 账号）
eas build --profile preview --platform android
# 或本地构建
npx expo prebuild --platform android
cd android && ./gradlew assembleRelease
```

## 连接手机到电脑上的 Ollama（Cloudflare 隧道教程）

Atrium OS 手机端需要连接 LLM 服务进行 AI 对话。如果你在电脑上运行了 Ollama，可以通过 Cloudflare 快速隧道让手机通过公网访问电脑上的 Ollama，无需公网 IP，无需路由器配置。

### 前置准备

1. **安装 Ollama**：访问 [ollama.com](https://ollama.com) 下载安装，然后拉取模型：
   ```bash
   ollama pull qwen3:8b
   ollama serve
   ```

2. **下载 cloudflared**：从 [Cloudflare 官方](https://github.com/cloudflare/cloudflared/releases/latest) 下载 `cloudflared-windows-amd64.exe`，重命名为 `cloudflared.exe`，放入项目的 `tools/` 目录下。

### 一键启动隧道

双击运行 `tools/一键启动公网隧道.bat`，脚本会自动完成以下操作：

```
[1/4] 检查 Ollama (端口 11434) ...        ← 自动启动 Ollama（如未运行）
[2/4] 检查 SearXNG (端口 8888) ...         ← 自动启动 SearXNG（如未运行）
[3/4] 启动 Cloudflare 公网隧道 ...         ← 创建两条临时公网隧道
[4/4] 完成!
```

脚本运行后，终端会输出两个公网地址：

```
Ollama URL:  https://xxxx-xxxx-xxxx.trycloudflare.com
SearXNG URL: https://yyyy-yyyy-yyyy.trycloudflare.com
```

Ollama 地址会自动复制到剪贴板。

### 在手机端配置

1. 打开 Atrium OS App
2. 进入 **设置** 页面
3. 将 Ollama URL 粘贴到 **Ollama 地址** 输入框（去掉末尾的 `/api/tags` 等路径，只保留 `https://xxxx.trycloudflare.com`）
4. 将 SearXNG URL 粘贴到 **搜索服务地址** 输入框（可选，用于联网搜索功能）
5. 返回主界面，开始对话

### 注意事项

- 每次启动隧道，公网地址都会变化，需要在 App 中更新
- 隧道依赖 Cloudflare 免费快速隧道服务，无需注册账号
- 保持隧道脚本窗口打开，关闭窗口则隧道断开
- 电脑休眠或关机后隧道失效，需重新运行脚本
- 如果仅需在局域网内使用，手机和电脑连同一 WiFi，直接填电脑局域网 IP 即可（如 `http://192.168.1.100:11434`）

## 核心特性

### 多 Agent 冲动值发言调度

三个 AI 人格各自独立评估"说话冲动"（0-100 分），通过阈值门控 + 递增防死循环 + 连续发言限制 + 角色间关系动态约束，决定每轮谁发言、说几句，模拟真实群聊的节奏感。

### LLM 统一服务层 + 优先级门控

所有 LLM 调用经过统一的 `ModelClient` 抽象层。设计了**优先级门控机制**：用户交互式请求（聊天、流式对话）优先执行，后台批量分析（历史日记补全、实体提取）在用户请求空闲时才放行，避免 Ollama 串行队列下后台任务挤占交互响应。

### 合并分析优化

日记的摘要 + 主导情绪 + 8 维情绪向量（基于普拉切克情绪轮理论）三项分析合并为一次结构化 JSON LLM 调用，相比三次独立调用速度提升约 36%。

### 智能实体管理器

从日记中提取人物/地点/事件实体，支持别名追踪、上下文消歧、矛盾特质检测。实体数据存储在独立的 `core_storage.db` 中，与日记数据分离。

### 全量加密备份

使用 scrypt 密钥派生 + AES-GCM 加密，将 SQLite 数据库和设置打包为单个 `.abk` 文件。密码不落盘，遗忘即无法解开。

### 多格式数据导入导出

支持 Day One JSON、CSV、Markdown、纯文本等格式导入，通过 canonical 中转格式统一处理。导入仅做纯写库，不触发分析管线。导入过程有草稿持久化防丢失。

### 联网搜索决策系统

独立的 LLM 调用判断用户消息是否需要联网搜索，需要时生成精简关键词，通过 SearXNG 执行搜索，结果供 AI 做多源交叉验证和引用标注。

## 技术栈

| 层 | 技术 |
|---|---|
| 移动端 | React Native + Expo Router + TypeScript |
| 本地存储 | expo-sqlite (SQLite, WAL 模式) + AsyncStorage |
| AI 推理 | Ollama (本地) / OpenRouter (云端) |
| 联网搜索 | SearXNG (私有化部署) |
| 后端服务 | Python + FastAPI + SQLite |
| 桌面端 | React + Vite + Tailwind CSS (Electron) |
| 加密 | scrypt + AES-GCM |
| 公网穿透 | Cloudflare Quick Tunnel |

## 项目结构

```
Atrium_OS_V1.0/
├── mobile/                     # 手机端核心应用 (React Native)
│   ├── app/                    # 路由与页面入口
│   ├── components/             # UI 组件 (日历、聊天、编辑器、雷达图等)
│   ├── context/                # React Context 状态管理
│   ├── core/                   # 核心业务逻辑
│   │   ├── modelService.ts     # LLM 统一服务层 + 优先级门控
│   │   ├── emotion.ts          # 情绪分析 (普拉切克 8 维向量)
│   │   ├── entityManager.ts    # 实体管理器 (别名消歧 + 矛盾检测)
│   │   ├── consolidation.ts    # 增量沉淀管线
│   │   ├── ontology.ts         # 人格本体论定义
│   │   ├── prompts.ts          # Prompt 模板
│   │   └── model.ts            # 模型配置
│   ├── local/                  # 本地直连模式实现 (api/local 接口对称)
│   │   ├── diary.ts            # 日记 CRUD + 分析管线
│   │   ├── chat.ts             # 共情对话
│   │   ├── chatroom.ts         # 聊天室冲动值调度
│   │   ├── insight.ts          # 觉察分析
│   │   ├── backup.ts           # 全量加密备份
│   │   ├── diaryIO.ts          # 数据导入导出
│   │   └── ...
│   ├── shared/                 # 共享工具 (SSE 解析、情绪工具)
│   └── utils/                  # 辅助工具 (日期处理、导入草稿)
├── ai/                         # AI 核心模块 (Python)
│   ├── empathy_agent.py        # 共情对话引擎
│   ├── entity_manager.py       # 实体提取与管理
│   ├── ontology.py             # 人格本体论 (Pydantic schema)
│   └── prompt_core.py          # 核心 Prompt
├── server/                     # 后端服务 (FastAPI)
│   ├── routes/                 # API 路由 (日记/聊天/觉察/实体等)
│   ├── app.py                  # FastAPI 应用入口
│   ├── auth.py                 # JWT 认证
│   ├── model_service.py        # 模型服务
│   ├── crypto.py               # 加密工具
│   ├── insight_scheduler.py    # 觉察定时调度
│   └── ...
├── storage/                    # 数据存储层
│   ├── diary_storage.py        # 日记存储
│   └── core_storage.py         # 实体/关系存储
├── tools/                      # 公网隧道工具
│   ├── 一键启动公网隧道.bat      # 一键启动 Ollama + SearXNG + Cloudflare 隧道
│   ├── start_ollama_tunnel.bat  # 单独启动隧道
│   └── _ollama_tunnel_helper.ps1 # 隧道辅助脚本
├── UI/                         # 桌面端前端 (React + Vite)
├── searxng/                    # SearXNG 部署脚本
├── tests/                      # 测试
├── requirements.txt            # Python 依赖
└── start_server.py             # 后端启动脚本
```

## 架构设计

### 本地优先

手机端以**本地直连模式**运行：数据存储在三个 SQLite 数据库（`diary.db`、`core_storage.db`、`insightDb`）中，AI 推理直连 Ollama/OpenRouter，不依赖后端服务器。

### 接口对称

`mobile/local/` 与 `mobile/api/` 下的每个文件保持相同的函数签名和返回结构，切换模式只需修改 import 路径，UI 层零重构。当前以本地直连模式运行，后续规划扩展电脑端服务与双端自动同步。

### 优先级门控

```
用户发消息 → beginUserRequest() → 计数器 +1
                                      ↓
后台分析任务 → waitForUserRequestIdle() → 计数器 > 0 → 挂起等待
                                      ↓
用户请求完成 → endUserRequest() → 计数器 → 0 → 唤醒所有等待者
```

## License

MIT
