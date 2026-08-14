# ==========================================
# Atrium OS - FastAPI 应用工厂
# 负责：app 创建、CORS、依赖注入、settings 加载、模块初始化
# ==========================================

import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import json

from server.logger import logger
from server import crypto
from server import errors

# ==========================================
# 设置系统（必须在 agent 初始化之前定义）
# ==========================================

SETTINGS_FILE = "atrium_settings.json"

# 设置默认值（各字段缺省时使用）
DEFAULT_SETTINGS = {
    "model_priority": "local",
    "local_model": "gemma4:12b",
    "lightweight_model": "gemma4:12b",
    "openrouter_api_key": "",
    "openrouter_model": "nvidia/nemotron-3-super-120b-a12b:free",
    "ego_template": "default",
    "ego_custom": ""
}

EGO_TEMPLATES = {
    "default": {
        "name": "默认人格",
        "description": "拒绝理中客说教，真实不做作的倾听者",
        "ego": "- 拒绝理中客说教，不准说'你要往好处想'这种话。\n- 永远站在对方这边，先共情再说话。\n- 说话真实自然，像朋友一样，不端着不装。"
    },
    "gentle": {
        "name": "温柔知心",
        "description": "像知心姐姐一样温柔体贴，善解人意",
        "ego": "- 说话轻柔温和，总是先共情再给建议。\n- 喜欢用比喻和故事来安慰人。\n- 不会直接否定对方的感受。"
    },
    "rational": {
        "name": "理性客观",
        "description": "冷静理性，帮助分析问题本质",
        "ego": "- 习惯从多个角度分析问题。\n- 说话条理清晰，逻辑严密。\n- 偶尔会指出对方思维中的盲点。"
    },
    "humorous": {
        "name": "幽默风趣",
        "description": "用幽默化解负面情绪，轻松愉快",
        "ego": "- 喜欢用幽默的方式回应。\n- 经常讲冷笑话来活跃气氛。\n- 即使面对沉重话题也会找到轻松的角度。"
    },
    "philosophical": {
        "name": "哲思深沉",
        "description": "喜欢从哲学角度思考人生",
        "ego": "- 喜欢引用哲学家的观点。\n- 经常把日常小事上升到人生哲理。\n- 说话有深度，偶尔有些玄乎。"
    },
    "custom": {
        "name": "自定义",
        "description": "自由定义 AI 助手的人格特质",
        "ego": ""
    }
}


def _settings_file(user_id: str = "default") -> str:
    """按用户返回设置文件路径。default 兼容旧版全局文件。"""
    if user_id in (None, "", "default"):
        return SETTINGS_FILE
    return f"atrium_settings_{user_id}.json"


def _load_settings(user_id: str = "default"):
    """按用户读取设置。若该用户没有专属设置文件，回退到全局默认文件（迁移旧数据）。"""
    path = _settings_file(user_id)
    if not os.path.exists(path):
        # 回退到全局默认文件，作为该用户的初始设置
        path = SETTINGS_FILE
    if os.path.exists(path):
        try:
            with open(path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, dict):
                merged = dict(DEFAULT_SETTINGS)
                merged.update(data)
                return merged
        except (json.JSONDecodeError, IOError) as e:
            logger.warning(f"设置文件损坏，使用默认配置 ({e})")
    return dict(DEFAULT_SETTINGS)


def _save_settings(settings, user_id: str = "default"):
    path = _settings_file(user_id) + ".tmp"
    try:
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(settings, f, ensure_ascii=False, indent=2)
        os.replace(path, _settings_file(user_id))  # 原子替换
    except IOError as e:
        logger.error(f"保存设置失败: {e}")


def apply_user_runtime(user_id: str = "default"):
    """把某用户的模型相关设置挂到「当前请求上下文」+ 应用人格到 agent 单例。

    模型选择已收敛到 server.model_service，通过 contextvars 挂载到请求上下文，
    并发请求各自持有独立配置，不再修改全局变量，从而消除跨用户竞态。
    """
    set_user_runtime(user_id)
    if agent is not None:
        s = _load_settings(user_id)
        if s.get("ego_template"):
            _apply_ego(agent, s["ego_template"], s.get("ego_custom", ""))


def set_user_runtime(user_id: str = "default"):
    """仅挂载模型配置到请求上下文（并发隔离）。供路由直接调用。"""
    from server import model_service
    model_service.set_user_config(user_id)


def _apply_ego(agent, template_key, custom_text):
    """根据模板 key 和自定义文本，设置 agent 的人格"""
    if template_key == "custom" and custom_text:
        agent.default_ego = custom_text
    elif template_key in EGO_TEMPLATES:
        agent.default_ego = EGO_TEMPLATES[template_key]["ego"]
    logger.info(f"人格已更新: {EGO_TEMPLATES.get(template_key, {}).get('name', template_key)}")


# ==========================================
# 创建 FastAPI 应用
# 使用 lifespan 替代已弃用的 @app.on_event("startup"/"shutdown")
# ==========================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期：启动时注册路由 + 启动觉察调度器；关闭时回收后台线程池。"""
    _register_routes()
    try:
        from server.insight_scheduler import start_scheduler
        start_scheduler(diary_storage, _load_settings, empathy_agent_module)
    except Exception as e:
        logger.error(f"觉察调度器启动失败（不影响服务）: {e}")
    logger.info("Atrium OS 启动完成")
    yield
    # 关闭：回收后台线程池与觉察调度器
    try:
        from server.background import shutdown_background
        shutdown_background()
    except Exception as e:
        logger.warning(f"后台线程池关闭异常: {e}")
    try:
        from server.insight_scheduler import stop_scheduler
        stop_scheduler()
    except Exception as e:
        logger.warning(f"觉察调度器关闭异常: {e}")
    logger.info("Atrium OS 已关闭")


app = FastAPI(title="Atrium OS API", lifespan=lifespan)

# 注册统一错误处理器（所有错误响应结构统一）
errors.register_error_handlers(app)

# 配置 CORS 跨域
# token 通过 Authorization header 传递（非 cookie），且 allow_credentials=False，
# 因此不放开任意来源。默认仅放行本机前端（localhost）与内网/内网穿透地址
# （10.x / 192.168.x / 172.16-31.x / 100.x Tailscale CGNAT），
# 手机端通过 Tailscale IP 访问时 Origin 命中内网范围即可正常跨域。
# 如需精确指定来源，可设置环境变量 ALLOWED_ORIGINS（逗号分隔的完整 Origin）。
from server.cors_config import build_cors_parameters
_cors_origins, _cors_origin_regex = build_cors_parameters()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_origin_regex=_cors_origin_regex,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ==========================================
# 健康检查端点
# ==========================================

@app.get("/api/health")
async def health_check():
    return {"status": "healthy", "service": "Atrium OS Backend"}


# ==========================================
# 单例实例（延迟初始化，由 _init_modules 完成）
# ==========================================

agent = None
diary_storage = None
core_storage = None
anchor = None
diary_service = None


# ==========================================
# 依赖注入获取函数
# ==========================================

def get_agent():
    return agent


def get_diary_storage():
    return diary_storage


def get_core_storage():
    return core_storage


def get_diary_service():
    return diary_service


# ==========================================
# 模块初始化
# ==========================================

def _ensure_default_user(diary_storage, core_storage=None):
    """确保旧数据归属。不再自动创建默认账号（方案A：首个用户自行注册）。

    若系统已有用户，把仍以 user_id='default' 存在的孤立数据迁移到第一个用户，
    避免旧数据因无归属而丢失。若系统尚无用户，则什么都不做，等待首个注册。
    """
    try:
        users = diary_storage.get_all_users()
        if not users:
            return
        migrate_legacy_data(diary_storage, core_storage, users[0]["id"])
    except Exception as e:
        logger.error(f"用户数据迁移失败: {e}")


def migrate_legacy_data(diary_storage, core_storage=None, target_user_id: str = None) -> bool:
    """把遗留的 user_id='default' 数据迁移到目标用户。

    target_user_id 为 None 时自动取第一个用户。返回是否发生了迁移。
    供首个注册用户与启动时共用，保证旧数据不因账号体系改动而丢失。
    """
    import shutil
    if target_user_id is None:
        users = diary_storage.get_all_users()
        if not users:
            return False
        target_user_id = users[0]["id"]

    migrated = False
    # 迁移日记相关孤立数据
    cursor = diary_storage.conn.cursor()
    cursor.execute("SELECT COUNT(*) as cnt FROM diary_entries WHERE user_id = 'default'")
    orphan_count = cursor.fetchone()['cnt']
    if orphan_count > 0:
        diary_storage.migrate_default_user(target_user_id)
        migrated = True

    # 迁移 core_storage 孤立数据
    cs_orphan = 0
    if core_storage:
        cs_cursor = core_storage.conn.cursor()
        cs_cursor.execute("SELECT COUNT(*) as cnt FROM entities WHERE user_id = 'default'")
        cs_orphan = cs_cursor.fetchone()['cnt']
        if cs_orphan > 0:
            core_storage.migrate_default_user(target_user_id)
            migrated = True

    # 迁移旧的觉察结果文件
    old_insight_file = os.path.join("data", "insight_results.json")
    new_insight_file = os.path.join("data", f"insight_results_{target_user_id}.json")
    if os.path.exists(old_insight_file) and not os.path.exists(new_insight_file):
        shutil.copy2(old_insight_file, new_insight_file)
        migrated = True

    if migrated:
        logger.info(f"已迁移遗留数据到用户: {target_user_id} (diary={orphan_count}, core={cs_orphan})")
    return migrated


def _init_modules():
    """初始化所有模块：AI 引擎、存储层、设置加载、增量沉淀"""
    global agent, diary_storage, core_storage, anchor, diary_service

    try:
        from ai.empathy_agent import EmpathyAgent
        import ai.empathy_agent as empathy_agent_module
        from storage.diary_storage import DiaryStorage
        from storage.core_storage import CoreStorage
        from consolidation import ConsolidationAnchor, deduplicate_traits

        logger.info("正在初始化 Atrium 引擎...")
        agent = EmpathyAgent()
        logger.info("正在初始化日记存储...")
        diary_storage = DiaryStorage()

        # 初始化增量沉淀锚点
        anchor = ConsolidationAnchor()

        # 初始化 core_storage
        core_storage = CoreStorage()
        logger.info("CoreStorage 初始化完成")

        # 初始化 diary_service
        diary_service = DiaryServiceAdapter(diary_storage, agent)

        # 启动时加载已保存的设置
        saved_settings = _load_settings()
        if saved_settings.get("model_priority") == "api":
            agent.use_openrouter = True
            logger.info("已加载设置: 使用 OpenRouter (远程)")
        if saved_settings.get("local_model"):
            empathy_agent_module.OLLAMA_MODEL = saved_settings["local_model"]
            logger.info(f"已加载设置: 主模型 = {saved_settings['local_model']}")
        if saved_settings.get("lightweight_model"):
            empathy_agent_module.SUMMARIZE_MODEL = saved_settings["lightweight_model"]
            logger.info(f"已加载设置: 轻量模型 = {saved_settings['lightweight_model']}")
        if saved_settings.get("openrouter_api_key"):
            api_key = saved_settings["openrouter_api_key"]
            # 尝试解密API密钥（如果已加密）
            try:
                api_key = crypto.decrypt(api_key)
            except Exception:
                pass  # 如果解密失败，使用原值
            os.environ["OPENROUTER_API_KEY"] = api_key
            empathy_agent_module.OPENROUTER_API_KEY = f"Bearer {api_key}"
        if saved_settings.get("openrouter_model"):
            empathy_agent_module.OPENROUTER_MODEL = saved_settings["openrouter_model"]
        if saved_settings.get("ego_template"):
            _apply_ego(agent, saved_settings["ego_template"], saved_settings.get("ego_custom", ""))

        # 启动时自动增量沉淀
        _consolidate_pending(agent, diary_storage, anchor, core_storage)

        # 创建默认用户（如果 users 表为空）
        _ensure_default_user(diary_storage, core_storage)

        return empathy_agent_module
    except Exception as e:
        logger.error(f"致命错误: 模块初始化失败 - {e}")
        import traceback
        traceback.print_exc()
        raise RuntimeError(f"Atrium OS 初始化失败: {e}") from e


def _consolidate_pending(agent, diary_storage, anchor, core_storage):
    """增量沉淀：只处理锚点之后的新数据"""
    import threading
    from consolidation import deduplicate_traits

    def _run():
        try:
            # 1. 增量沉淀日记
            last_ts = anchor.last_diary_ts
            if last_ts:
                all_diaries = diary_storage.get_recent_diaries(limit=100)
                pending = [d for d in all_diaries if d.created_at > last_ts and d.content and len(d.content) > 10]
            else:
                all_diaries = diary_storage.get_recent_diaries(limit=100)
                pending = [d for d in all_diaries if d.content and len(d.content) > 10]

            if pending:
                logger.info(f"发现 {len(pending)} 篇待沉淀的日记，开始后台处理...")
                for d in pending:
                    count = agent.consolidate_diary(d.content)
                    if count > 0:
                        logger.info(f"  {d.date}: 提取了 {count} 条关系")
                    else:
                        logger.info(f"  {d.date}: 未提取到关系")
                    anchor.update_diary_anchor(d.created_at)
                anchor.save()
            else:
                logger.info("所有日记均已沉淀，无需补处理。")

            # 2. 增量沉淀对话历史（按用户遍历，避免跨用户混淆）
            all_users = diary_storage.get_all_users()
            user_ids = [u["id"] for u in all_users] or ["default"]
            for uid in user_ids:
                hb = agent._load_history_buffer(uid)
                pending_msgs = [m for m in hb.get("messages", []) if m.get("ts", 0) > anchor.last_dialogue_ts]
                if not pending_msgs:
                    continue
                logger.info(f"发现 {len(pending_msgs)} 条待沉淀的对话消息（用户 {uid}）...")
                if agent.kg_mem:
                    dialogue_block = "\n".join([m["content"] for m in pending_msgs])
                    relations = agent.kg_mem.add_unstructured(dialogue_block)
                    if relations:
                        for rel in relations:
                            agent._dispatch_to_vault(rel)
                        logger.info(f"  对话沉淀：提取了 {len(relations)} 条关系")
                    max_ts = max(m.get("ts", 0) for m in pending_msgs)
                    anchor.update_dialogue_anchor(max_ts)
                    anchor.save()
                    hb["messages"] = [m for m in hb["messages"] if m.get("ts", 0) <= anchor.last_dialogue_ts]
                    agent._save_history_buffer(uid)
                else:
                    logger.info("  kg_mem 不可用，跳过对话沉淀。")

            # 3. 数据整合：去重 traits
            removed = deduplicate_traits()
            if removed > 0:
                logger.info(f"数据整合：共去重 {removed} 条重复特质")

            # 4. 刷新 NPC 缓存
            agent.npc_store.refresh_cache()
            logger.info(f"增量沉淀完成，NPC 列表: {agent.get_npc_list()}")
        except Exception as e:
            logger.error(f"增量沉淀失败: {e}")
            import traceback
            traceback.print_exc()

    from server.background import submit_background
    submit_background(_run)


# DiaryService 适配器（桥接原始的 diary_storage 和 agent）
class DiaryServiceAdapter:
    """日记服务适配器，提供与 DiaryService 相同的接口，但使用原始 storage 方法"""

    def __init__(self, diary_storage, agent):
        self.diary_storage = diary_storage
        self.agent = agent

    def check_edit_permission(self, target_date: str) -> bool:
        from datetime import datetime, date
        today = date.today()
        target = datetime.strptime(target_date, "%Y-%m-%d").date()
        days = (today - target).days
        return 0 <= days <= 1

    def save_diary(self, date_str: str, content: str, messages: list,
                   weather: str = "晴", tags: list = None,
                   user_id: str = 'default') -> dict:
        import threading
        from datetime import datetime

        if not self.check_edit_permission(date_str):
            raise PermissionError("日记编辑权限仅在当日和昨日开放")

        tags = tags or []
        diary = self.diary_storage.save_diary(
            date=date_str,
            content=content,
            messages=messages,
            weather=weather,
            tags=tags,
            user_id=user_id
        )

        # 异步处理管线（不阻塞保存响应）
        if content and len(content) > 10:
            def _run_pipeline():
                try:
                    # 1. 实体提取 → 日历缓存（失败不阻断后续情绪处理）
                    try:
                        from ai.entity_manager import get_entity_manager
                        em = get_entity_manager()
                        entities = em.extract_entities(content) if hasattr(em, 'extract_entities') else []
                        entity_count = len(entities)
                        protagonist = entities[0] if entities else "自己"
                        self.diary_storage.update_calendar_cache(date_str, entity_count, protagonist, user_id=user_id)
                        logger.info(f"日历缓存已更新: entity_count={entity_count}, protagonist={protagonist}")
                    except Exception as e:
                        logger.warning(f"实体提取失败（跳过，不影响情绪处理）: {e}")
                        # 仍更新日历缓存实体数占位，避免后续依赖
                        self.diary_storage.update_calendar_cache(date_str, 0, "自己", user_id=user_id)

                    # 2. 合并一次 AI 调用生成摘要、情绪分类、8维情绪向量
                    # （原为三次独立调用，合并后速度提升约 36%，情绪分类与分开调用完全一致）
                    try:
                        analysis = self.agent.analyze_diary_combined(content)
                        summary = analysis.get("summary", "日常")
                        emotion = analysis.get("emotion", "平静")
                        vector = analysis.get("emotion_vector", {})
                        self.diary_storage.set_summary(date_str, summary, user_id=user_id)
                        self.diary_storage.set_emotion(date_str, emotion, user_id=user_id)
                        self.diary_storage.set_emotion_vector(date_str, vector, user_id=user_id)
                        logger.info(f"日记分析已生成: 摘要={summary}, 情绪={emotion}, 向量={vector}")
                    except Exception as e:
                        logger.warning(f"日记分析生成失败: {e}")

                    # 3. 知识图谱沉淀
                    if self.agent.kg_mem:
                        try:
                            relations = self.agent.kg_mem.add_unstructured(content)
                            if relations:
                                for rel in relations:
                                    self.agent._dispatch_to_vault(rel)
                                logger.info(f"知识图谱更新：从日记中提取了 {len(relations)} 条关系。")
                        except Exception as e:
                            logger.warning(f"kg_mem 三元组提取失败: {e}")

                    # 3. 更新锚点
                    from consolidation import ConsolidationAnchor, deduplicate_traits
                    anchor = ConsolidationAnchor()
                    anchor.update_diary_anchor(diary.created_at)
                    anchor.save()
                    removed = deduplicate_traits()
                    if removed > 0:
                        logger.info(f"去重 {removed} 条重复特质")
                    self.agent.npc_store.refresh_cache()
                except Exception as e:
                    logger.error(f"异步管线失败: {e}")
                    import traceback
                    traceback.print_exc()

            from server.background import submit_background
            submit_background(_run_pipeline)

        return {"status": "ok", "diary_id": diary.id}


# ==========================================
# 执行模块初始化
# ==========================================

empathy_agent_module = _init_modules()


# ==========================================
# 挂载路由（延迟导入，避免循环引用）
# ==========================================

def _register_routes():
    global _routes_registered
    if _routes_registered:
        return
    from server.routes import api_router
    app.include_router(api_router)
    _routes_registered = True

_routes_registered = False