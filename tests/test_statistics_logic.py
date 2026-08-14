# -*- coding: utf-8 -*-
"""statistics_routes 纯逻辑验证（直接用 python 运行，无需 pytest）"""
import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from server.routes.statistics_routes import (
    AXES, TENSION_PAIRS, _parse_vector, _mean_vector, _daily_tension,
    _parse_fishbone_events,
)

def main():
    # 1. 向量解析
    assert _parse_vector("") is None, "空串应返回 None"
    assert _parse_vector("not-json") is None, "非法 JSON 应返回 None"
    vec = _parse_vector('{"喜悦":80,"信任":0,"恐惧":0,"惊讶":0,"悲伤":0,"厌恶":0,"愤怒":0,"期待":0}')
    assert vec == [80, 0, 0, 0, 0, 0, 0, 0], f"解析向量错误: {vec}"
    assert _parse_vector('{"喜悦":0,"信任":0,"恐惧":0,"惊讶":0,"悲伤":0,"厌恶":0,"愤怒":0,"期待":0}') is None, "全0应返回 None"
    # 小数与越界
    vec2 = _parse_vector('{"喜悦":"75.5","恐惧":120,"信任":-3,"惊讶":0,"悲伤":0,"厌恶":0,"愤怒":0,"期待":0}')
    assert vec2[0] == 76 and vec2[2] == 100 and vec2[1] == 0, f"容错解析错误: {vec2}"

    # 2. 均值：各维度独立取平均，不互相抵消
    v_a = [100, 0, 0, 0, 0, 0, 0, 0]
    v_b = [0, 0, 0, 0, 100, 0, 0, 0]
    m = _mean_vector([v_a, v_b])
    assert m[0] == 50.0 and m[4] == 50.0, f"独立均值错误: {m}"
    assert _mean_vector([]) == [0.0] * 8, "空列表均值应为全 0"

    # 3. 张力：只算 4 对正对轴，且只在单日共现才产生
    # 喜悦100+悲伤0（正对）→ 喜悦悲伤对 50；其余对 0 → 张力 50
    t1 = _daily_tension([100, 0, 0, 0, 0, 0, 0, 0])
    assert t1 == 50.0, f"喜悦100 张力应为50, 实际{t1}"
    # 恐惧90+期待90（相邻非正对）→ 不产生张力（恐惧-愤怒对=45, 惊讶-期待对=45）→ 张力90
    t2 = _daily_tension([0, 0, 90, 0, 0, 0, 0, 90])
    assert t2 == 90.0, f"恐惧+期待应只算两对正对, 实际{t2}"
    # 4对都满100 → 张力 400（可超100，由前端封顶加深）
    t3 = _daily_tension([100] * 8)
    assert t3 == 400.0, f"全满张力应为400, 实际{t3}"

    # 5. 摘要解析（每篇一条摘要）
    evs = _parse_fishbone_events('[{"date":"2026-08-01","summary":"下定决心换新工作"}]')
    assert len(evs) == 1 and evs[0]["summary"] == "下定决心换新工作"
    evs2 = _parse_fishbone_events('{"events":[{"date":"2026-08-02","summary":"搬到新城市"}]}')
    assert len(evs2) == 1 and evs2[0]["summary"] == "搬到新城市"
    evs3 = _parse_fishbone_events('[{"date":"2026-08-03","summary":""}]')
    assert evs3 == [], "空摘要应被过滤"

    print("ALL STATISTICS LOGIC TESTS PASSED")

if __name__ == "__main__":
    main()