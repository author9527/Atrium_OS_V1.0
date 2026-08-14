# ==========================================
# Atrium OS - 路由聚合
# ==========================================

from fastapi import APIRouter
from .auth_routes import router as auth_router
from .diary_routes import router as diary_router
from .chat_routes import router as chat_router
from .settings_routes import router as settings_router
from .insight_routes import router as insight_router
from .profile_routes import router as profile_router
from .chatroom_routes import router as chatroom_router
from .relationship_routes import router as relationship_router
from .statistics_routes import router as statistics_router
from .persona_routes import router as persona_router
from .diary_io_routes import router as diary_io_router

api_router = APIRouter()
api_router.include_router(auth_router)
api_router.include_router(diary_router)
api_router.include_router(chat_router)
api_router.include_router(settings_router)
api_router.include_router(insight_router)
api_router.include_router(profile_router)
api_router.include_router(chatroom_router)
api_router.include_router(relationship_router)
api_router.include_router(statistics_router)
api_router.include_router(persona_router)
api_router.include_router(diary_io_router)
