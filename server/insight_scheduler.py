# ==========================================
# Atrium OS - 觉察助手后台调度器
# 支持每周/每月定时自动执行觉察分析（支线模式）
# 多用户：遍历所有用户，按各自设置独立调度
# ==========================================

import threading
import time
import requests
import atexit
from datetime import datetime
from server.logger import logger

# 全局退出事件
_shutdown_event = threading.Event()


def stop_scheduler():
    """优雅关闭调度器"""
    _shutdown_event.set()
    logger.info("[觉察调度器] 收到退出信号，正在关闭...")


# 注册退出时自动关闭
atexit.register(stop_scheduler)


def start_scheduler(diary_storage, load_settings, empathy_agent_module):
    """启动觉察助手后台调度器（daemon 线程，不阻塞主进程）"""

    def _should_run_today(settings, now):
        """判断今天是否应该触发分析"""
        frequency = settings.get("frequency", "weekly")
        schedule_day = settings.get("schedule_day", 7)  # 默认周日
        schedule_time = settings.get("schedule_time", "23:00")

        try:
            target_h, target_m = map(int, schedule_time.split(":"))
        except ValueError:
            return False

        # 时间不匹配则跳过
        if now.hour != target_h or now.minute != target_m:
            return False

        # 今天是否已运行过
        last_run = settings.get("last_run")
        if last_run:
            try:
                last_run_dt = datetime.fromisoformat(last_run)
                if last_run_dt.date() == now.date():
                    return False
            except (ValueError, TypeError):
                pass

        # 频率匹配
        if frequency == "monthly":
            if now.day != schedule_day:
                return False
        else:
            if now.isoweekday() != schedule_day:
                return False

        return True

    def _scheduler_loop():
        logger.info(f"[觉察调度器] 已启动，等待调度时间...")
        while not _shutdown_event.is_set():
            try:
                from server.routes.insight_routes import (
                    _load_insight_settings, _save_insight_data,
                    BRANCH_DISCOVERY_PROMPT, BRANCH_SCHEMA, _parse_branches,
                    _get_filtered_diaries, _diaries_to_text
                )

                now = datetime.now()

                # 遍历所有用户，逐个检查调度
                all_users = diary_storage.get_all_users()
                for user in all_users:
                    user_id = user["id"]
                    username = user.get("username", user_id)

                    settings, results = _load_insight_settings(user_id)

                    if not settings.get("auto_run", True):
                        continue

                    if _should_run_today(settings, now):
                        freq = settings.get("frequency", "weekly")
                        freq_label = f"每周{'一二三四五六日'[settings.get('schedule_day', 7) - 1]}" if freq != "monthly" else f"每月{settings.get('schedule_day', 1)}号"
                        logger.info(f"[觉察调度器] 开始执行分析 ({freq_label} {now.strftime('%Y-%m-%d %H:%M:%S')}) 用户: {username}")
                        try:
                            _run_branch_analysis(
                                diary_storage, load_settings,
                                empathy_agent_module,
                                settings, results,
                                BRANCH_DISCOVERY_PROMPT, BRANCH_SCHEMA,
                                _parse_branches,
                                _get_filtered_diaries, _diaries_to_text,
                                _save_insight_data,
                                user_id
                            )
                        except Exception as e:
                            logger.error(f"[觉察调度器] 分析执行失败 (用户: {username}): {e}")
                            import traceback
                            traceback.print_exc()

                _shutdown_event.wait(60)

            except Exception as e:
                logger.error(f"[觉察调度器] 循环异常: {e}")
                _shutdown_event.wait(60)

        logger.info("[觉察调度器] 已关闭")

    t = threading.Thread(target=_scheduler_loop, daemon=True)
    t.start()
    return t


def _run_branch_analysis(diary_storage, load_settings, empathy_agent_module,
                          settings, results, prompt, schema, parse_branches,
                          get_filtered, to_text, save_fn, user_id='default'):
    """执行一次完整的支线觉察分析"""

    days = settings.get("analysis_days", 30)
    filtered = get_filtered(diary_storage, days, user_id)

    if len(filtered) < 2:
        logger.info(f"[觉察调度器] 日记数量不足 ({len(filtered)} 篇)，跳过分析")
        return

    diary_text = to_text(filtered)

    settings_data = load_settings(user_id)
    model = settings_data.get("local_model", empathy_agent_module.OLLAMA_MODEL)

    payload = {
        "model": model,
        "prompt": prompt + diary_text,
        "stream": False,
        "format": schema,
        "options": {"temperature": 0.4, "num_predict": 4096, "num_ctx": 8192}
    }

    t0 = time.time()
    try:
        resp = requests.post("http://localhost:11434/api/generate", json=payload, timeout=300)
        resp.raise_for_status()
        raw = resp.json().get("response", "分析生成失败")
        elapsed = time.time() - t0
    except requests.exceptions.ConnectionError:
        logger.error("[觉察调度器] 无法连接 Ollama，跳过本次分析")
        return
    except Exception as e:
        logger.error(f"[觉察调度器] Ollama 调用失败: {e}")
        return

    branches = parse_branches(raw)
    if not branches:
        branches = [{
            "id": "1", "title": "觉察发现", "observation": raw.strip(),
            "evidence": "", "question": "你想从哪个角度深入聊聊？", "conversation": [],
        }]

    new_result = {
        "id": datetime.now().strftime("%Y%m%d%H%M%S"),
        "timestamp": datetime.now().isoformat(),
        "diary_count": len(filtered),
        "date_range": f"{filtered[0].date} 至 {filtered[-1].date}",
        "branches": branches,
        "diary_context": diary_text,
        "elapsed_seconds": round(elapsed, 1),
        "model": model,
    }

    results.insert(0, new_result)
    results = results[:50]

    settings["last_run"] = datetime.now().isoformat()
    save_fn(settings, results, user_id)

    logger.info(f"[觉察调度器] 支线分析完成: {len(filtered)} 篇日记, {len(branches)} 条支线, 耗时 {elapsed:.1f} 秒")
