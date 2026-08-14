# ==========================================
# Atrium OS - 设置路由
# ==========================================

from fastapi import APIRouter, Depends
from pydantic import BaseModel
import os

from server.app import (get_agent, get_core_storage,
                         _load_settings, _save_settings, _apply_ego,
                         apply_user_runtime,
                         EGO_TEMPLATES, empathy_agent_module)
from server.auth import get_current_user
from server import crypto
from server.logger import logger

router = APIRouter()


class SettingsUpdateRequest(BaseModel):
    model_priority: str = None
    local_model: str = None
    lightweight_model: str = None
    openrouter_api_key: str = None
    openrouter_model: str = None
    ego_template: str = None
    ego_custom: str = None


@router.get("/api/settings")
async def get_settings(current_user: dict = Depends(get_current_user)):
    """获取当前账号的设置（API Key 不回显明文，仅返回是否已配置）"""
    settings = dict(_load_settings(current_user["id"]))
    # 敏感字段脱敏：不回显 API Key 明文
    settings["openrouter_api_key"] = "****" if settings.get("openrouter_api_key") else ""
    settings["has_openrouter_api_key"] = bool(settings.get("openrouter_api_key"))
    return settings


@router.post("/api/settings")
async def update_settings(request: SettingsUpdateRequest,
                          agent=Depends(get_agent),
                          current_user: dict = Depends(get_current_user)):
    """更新当前账号的设置"""
    user_id = current_user["id"]
    settings = _load_settings(user_id)
    if request.model_priority is not None:
        settings["model_priority"] = request.model_priority
        agent.use_openrouter = (request.model_priority == "api")
        logger.info(f"模型优先级已切换为: {'OpenRouter (远程)' if agent.use_openrouter else 'Ollama (本地)'}")
    if request.local_model is not None:
        settings["local_model"] = request.local_model
        empathy_agent_module.OLLAMA_MODEL = request.local_model
        logger.info(f"主模型已切换为: {request.local_model}")
    if request.lightweight_model is not None:
        settings["lightweight_model"] = request.lightweight_model
        empathy_agent_module.SUMMARIZE_MODEL = request.lightweight_model
        logger.info(f"轻量模型已切换为: {request.lightweight_model}")
    if request.openrouter_api_key is not None:
        # 加密存储，且回显时脱敏
        settings["openrouter_api_key"] = crypto.encrypt(request.openrouter_api_key)
        os.environ["OPENROUTER_API_KEY"] = request.openrouter_api_key
        empathy_agent_module.OPENROUTER_API_KEY = f"Bearer {request.openrouter_api_key}"
        logger.info("OpenRouter API Key 已更新（加密存储）")
    if request.openrouter_model is not None:
        settings["openrouter_model"] = request.openrouter_model
        empathy_agent_module.OPENROUTER_MODEL = request.openrouter_model
    if request.ego_template is not None:
        settings["ego_template"] = request.ego_template
        _apply_ego(agent, request.ego_template, settings.get("ego_custom", ""))
    if request.ego_custom is not None:
        settings["ego_custom"] = request.ego_custom
        _apply_ego(agent, settings.get("ego_template", "default"), request.ego_custom)
    _save_settings(settings, user_id)
    # 返回脱敏后的设置
    resp = dict(settings)
    resp["openrouter_api_key"] = "****" if resp.get("openrouter_api_key") else ""
    resp["has_openrouter_api_key"] = bool(settings.get("openrouter_api_key"))
    return {"success": True, "settings": resp}


@router.get("/api/settings/local-models")
async def get_local_models(current_user: dict = Depends(get_current_user)):
    """获取本地 Ollama 已下载的模型列表"""
    import requests
    try:
        res = requests.get("http://localhost:11434/api/tags", timeout=5)
        if res.status_code == 200:
            models = res.json().get("models", [])
            return {
                "available": True,
                "models": [
                    {
                        "name": m.get("name", ""),
                        "size": round(m.get("size", 0) / 1e9, 2),
                        "modified": m.get("modified_at", ""),
                        "family": m.get("details", {}).get("family", "unknown")
                    }
                    for m in models
                ]
            }
        return {"available": False, "models": [], "error": f"Ollama 返回状态码 {res.status_code}"}
    except requests.exceptions.ConnectionError:
        return {"available": False, "models": [], "error": "无法连接到 Ollama，请确认 Ollama 已启动"}
    except Exception as e:
        return {"available": False, "models": [], "error": str(e)}


@router.get("/api/settings/ego-templates")
async def get_ego_templates(current_user: dict = Depends(get_current_user)):
    """获取人格预设模板列表"""
    return {"templates": EGO_TEMPLATES}


@router.get("/api/settings/consolidation-log")
async def get_consolidation_log(core_storage=Depends(get_core_storage),
                                current_user: dict = Depends(get_current_user)):
    """获取沉淀日志（从 core_storage 获取统计）"""
    from consolidation import ConsolidationAnchor
    anchor = ConsolidationAnchor()
    log = anchor.get_status()

    npc_stats = []
    all_entities = core_storage.get_all_entities(user_id=current_user["id"])
    for entity in all_entities:
        if entity.get("entity_type") == "me":
            continue
        traits = entity.get("ontology_traits", [])
        if isinstance(traits, dict):
            traits = traits.get("traits", [])
        npc_stats.append({
            "name": entity.get("name", entity.get("slug", "")),
            "traits_count": len(traits) if isinstance(traits, list) else 0,
            "relationships_count": 0
        })

    return {
        "anchor": log,
        "npc_stats": npc_stats
    }