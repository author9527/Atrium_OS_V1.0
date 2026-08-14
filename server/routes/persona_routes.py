# ==========================================
# Atrium OS - AI 人设管理路由
# 查询 / 编辑所有 AI 机器人（共情助手/觉察助手/聊天室三兄妹）的人设
# ==========================================

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from server.auth import get_current_user
from server import persona_config

router = APIRouter()


class PersonaUpdateRequest(BaseModel):
    name: Optional[str] = None
    ego: Optional[str] = None
    speak_tendency: Optional[str] = None


@router.get("/api/personas")
async def list_personas(current_user: dict = Depends(get_current_user)):
    """查询所有 AI 机器人的人设（按当前账号隔离）。"""
    return {"personas": persona_config.get_all_personas(current_user["id"])}


@router.put("/api/personas/{key}")
async def update_persona(key: str,
                         request: PersonaUpdateRequest,
                         current_user: dict = Depends(get_current_user)):
    """更新某个 AI 机器人的人设并持久化（按当前账号隔离）。"""
    if key not in persona_config.PERSONAS:
        raise HTTPException(status_code=404, detail=f"未找到机器人: {key}")
    updated = persona_config.update_persona(
        current_user["id"],
        key,
        name=request.name,
        ego=request.ego,
        speak_tendency=request.speak_tendency,
    )
    return {"success": True, "persona": updated}