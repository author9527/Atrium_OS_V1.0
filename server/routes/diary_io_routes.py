# ==========================================
# Atrium OS - 日记数据迁移路由（导入/导出）
#
# 设计原则：
#   1. 以「自建富文本 JSON」为唯一中转（canonical），所有格式经转换器
#      映射到 canonical，再写入/读出数据库。
#   2. 导入仅调 storage.batch_import_diaries 做纯写库，绝不经过
#      diary_service.save_diary（那会触发实体提取/摘要/情绪/kg_mem/锚点等
#      异步分析管线），因此导入后不会自动触发任何数据分析。
#   3. 导出从数据库读出 canonical 条目，经转换器输出目标格式。
# ==========================================

from typing import Optional
from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel

from server.app import get_diary_storage
from server.auth import get_current_user
from server.logger import logger
from server import diary_io

router = APIRouter()

# 支持的格式（供前端渲染下拉/说明）
SUPPORTED_FORMATS = [
    {"id": fmt, "label": diary_io.format_label(fmt), "ext": diary_io.export_extension(fmt)}
    for fmt in diary_io.SUPPORTED_FORMATS
]


class DiaryImportRequest(BaseModel):
    text: str
    filename: str = ""
    source_format: Optional[str] = None   # 为空则自动检测
    overwrite: bool = True                # 已存在日期是否覆盖


class DiaryParseRequest(BaseModel):
    text: str
    filename: str = ""
    source_format: Optional[str] = None   # 为空则自动检测


@router.post("/api/diary/import/parse")
async def parse_import(current_user: dict = Depends(get_current_user), request: DiaryParseRequest = None):
    """解析导入内容为 canonical 条目，但【绝不写库】。

    供前端「导入页」使用：把用户粘贴/导入的任意格式内容解析成 canonical 条目，
    实时合并进草稿 JSON，等待「导入完成」时才一次性提交写库。
    由此保证导入过程中任何格式都能先进入草稿，且不触发任何数据分析管线。
    """
    if not request.text or not request.text.strip():
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=400, content={"success": False, "error": {"code": "EMPTY_IMPORT", "message": "导入内容为空"}})
    try:
        entries, detected = diary_io.import_to_canonical(
            request.text, request.source_format, request.filename)
    except Exception as e:
        logger.warning(f"导入解析失败: {e}")
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=400, content={"success": False, "error": {"code": "PARSE_ERROR", "message": f"无法解析导入内容: {e}"}})

    if not entries:
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=400, content={"success": False, "error": {"code": "NO_ENTRIES", "message": "导入内容中未解析到有效日记条目"}})

    logger.info(f"用户 {current_user['username']} 解析 {len(entries)} 条日记（格式 {detected}，未写库）")
    return {"success": True, "format": detected, "entries": entries}


@router.get("/api/diary/formats")
async def list_formats(current_user: dict = Depends(get_current_user)):
    """列出支持的导入/导出格式。"""
    return {"success": True, "formats": SUPPORTED_FORMATS}


@router.post("/api/diary/import")
async def import_diaries(request: DiaryImportRequest,
                         diary_storage=Depends(get_diary_storage),
                         current_user: dict = Depends(get_current_user)):
    """批量导入日记。text 为任意支持格式的文本内容，自动检测格式并转 canonical，再纯写库。

    绝不触发任何数据分析管线（无实体提取/摘要/情绪/沉淀/日历缓存）。
    """
    if not request.text or not request.text.strip():
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=400, content={"success": False, "error": {"code": "EMPTY_IMPORT", "message": "导入内容为空"}})
    try:
        entries, detected = diary_io.import_to_canonical(
            request.text, request.source_format, request.filename)
    except Exception as e:
        logger.warning(f"导入解析失败: {e}")
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=400, content={"success": False, "error": {"code": "PARSE_ERROR", "message": f"无法解析导入内容: {e}"}})

    if not entries:
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=400, content={"success": False, "error": {"code": "NO_ENTRIES", "message": "导入内容中未解析到有效日记条目"}})

    result = diary_storage.batch_import_diaries(
        entries, user_id=current_user["id"], overwrite=request.overwrite)

    logger.info(f"用户 {current_user['username']} 导入 {len(entries)} 条日记（格式 {detected}）")
    return {
        "success": True,
        "format": detected,
        "source_format": request.source_format,
        "detected_count": len(entries),
        **result,
    }


@router.get("/api/diary/export")
async def export_diaries(
    format: Optional[str] = "atrium",
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    diary_storage=Depends(get_diary_storage),
    current_user: dict = Depends(get_current_user),
):
    """把指定范围内的日记导出为指定格式。默认导出全部，输出为 canonical 富文本 JSON。"""
    if format not in diary_io._EXPORT_CONVERTERS:
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=400, content={"success": False, "error": {"code": "BAD_FORMAT", "message": f"不支持的导出格式: {format}"}})

    if start_date and end_date:
        diaries = diary_storage.get_diaries_by_range(start_date, end_date, user_id=current_user["id"])
    else:
        diaries = diary_storage.get_all_diaries(user_id=current_user["id"])

    # DiaryEntry dataclass → canonical 条目（中转格式）
    canonical_entries = [
        diary_io.make_canonical_entry(
            date=d.date,
            content=d.content,
            weather=d.weather,
            tags=d.tags,
            created_at=d.created_at,
            updated_at=d.updated_at,
        )
        for d in diaries
    ]

    text = diary_io.export_entries(canonical_entries, format)
    ext = diary_io.export_extension(format)
    filename = f"atrium_diaries.{ext}"
    return Response(
        content=text,
        media_type=_media_type(ext),
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _media_type(ext: str) -> str:
    return {
        "json": "application/json; charset=utf-8",
        "csv": "text/csv; charset=utf-8",
        "md": "text/markdown; charset=utf-8",
        "txt": "text/plain; charset=utf-8",
    }.get(ext, "text/plain; charset=utf-8")