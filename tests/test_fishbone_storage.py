# -*- coding: utf-8 -*-
"""diary_storage 鱼骨事件存储验证（直接用 python 运行，无需 pytest）"""
import os, sys, tempfile
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from storage.diary_storage import DiaryStorage

def main():
    tmp = tempfile.mkdtemp()
    db = os.path.join(tmp, "test.db")
    s = DiaryStorage(db_path=db)
    uid = "u1"
    assert s.get_fishbone_events(uid) == [], "初始应为空"
    s.add_fishbone_event(uid, "2026-08-01", "决定换工作", "纠结后决定跳槽")
    s.add_fishbone_event(uid, "2026-08-01", "决定换工作", "重复应被忽略")
    s.add_fishbone_event(uid, "2026-08-03", "搬家", "搬到新城市")
    evs = s.get_fishbone_events(uid)
    assert len(evs) == 2, f"去重后应为 2 条, 实际 {len(evs)}"
    assert evs[0]["date"] == "2026-08-01"
    assert evs[1]["date"] == "2026-08-03"
    assert s.get_fishbone_events("u2") == []
    assert s.get_last_processed_date(uid) is None
    s.set_last_processed_date(uid, "2026-08-03")
    assert s.get_last_processed_date(uid) == "2026-08-03"
    s.save_diary("2026-08-01", "旧日记", user_id=uid)
    s.save_diary("2026-08-05", "新日记", user_id=uid)
    after = s.get_diaries_after(uid, "2026-08-03")
    assert len(after) == 1 and after[0].date == "2026-08-05"
    s.close()
    print("ALL FISHBONE STORAGE TESTS PASSED")

if __name__ == "__main__":
    main()