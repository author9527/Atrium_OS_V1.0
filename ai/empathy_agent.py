import requests
import chromadb
import json
import os
import sys
import re
from typing import Dict
try:
    import torch
    TORCH_AVAILABLE = True
except ImportError:
    TORCH_AVAILABLE = False
import time
import threading
from datetime import datetime

# 统一日志（在 kg_mem 等可选依赖之前导入，确保异常捕获可用）
from server.logger import logger

# 人格系统提示词单一来源
from ai.prompt_core import build_empathy_system, build_awareness_system, build_greeting_system

try:
    from neo4j import GraphDatabase
    NEO4J_AVAILABLE = True
except ImportError:
    NEO4J_AVAILABLE = False
try:
    from transformers import AutoModel, AutoTokenizer
    TRANSFORMERS_AVAILABLE = True
except ImportError:
    TRANSFORMERS_AVAILABLE = False

# 注入 kg_mem 组件（可选依赖，dspy/litellm 编译困难时降级跳过）
KG_MEM_AVAILABLE = False
KGMem = None
atrium_persona_ontology = None
try:
    sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "kg_mem"))
    from kg_mem import KGMem
    from ai.ontology import atrium_persona_ontology
    KG_MEM_AVAILABLE = True
except ImportError:
    logger.warning("⚠️ kg_mem 依赖缺失（dspy/litellm），三元组提取功能将跳过。")

# 注入实体管理器
from ai.entity_manager import get_entity_manager

# 统一 NPC 存储
from unified_npc_store import UnifiedNPCStore

# 核心存储
from core_storage import CoreStorage

# 统一模型服务（模型选择读用户设置，contextvar 并发隔离）
from server.model_service import (use_openrouter as _ms_use_openrouter,
                                  local_model as _ms_local_model,
                                  openrouter_model as _ms_openrouter_model,
                                  openrouter_api_key as _ms_openrouter_api_key,
                                  chat_tools_stream as _ms_chat_tools_stream,
                                  generate as _ms_generate)

# 联网搜索工具（SearXNG function calling）
from server.web_search_tool import SEARCH_TOOL_SCHEMA, web_search as _do_web_search, format_search_results


def strip_html_for_llm(text: str) -> str:
    """剥离富文本日记中的 HTML 标签（含 <img> 及其内嵌的 base64 data URI），
    避免图片数据撑爆 LLM prompt。保留可见文本与换行。"""
    if not text:
        return ""
    # 去掉所有 HTML/XML 标签（含 <img src="data:image/..."> 的整个标签）
    text = re.sub(r'<[^>]+>', '', text)
    # 还原常见 HTML 实体，避免乱码
    text = text.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
    text = text.replace('&nbsp;', ' ').replace('&quot;', '"').replace('&#39;', "'")
    return text.strip()

# ==========================================
# Atrium OS - 层次化分层大脑 (Hierarchical Brain 2.0)
# 逻辑：快速反馈 -> 延迟沉淀 -> 分层分拣
# 支持智能实体消歧
# 数据沉淀基于 core_storage.db
# ==========================================

NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "")
OLLAMA_URL = "http://localhost:11434/api/generate"
OLLAMA_MODEL = "qwen3.6:27b"
SUMMARIZE_MODEL = "qwen3:4B"

# OpenRouter 配置
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_API_KEY = f"Bearer {os.environ.get('OPENROUTER_API_KEY', '')}"
OPENROUTER_MODEL = "nvidia/nemotron-3-super-120b-a12b:free" 

class HierarchicalVault:
    """基于 core_storage.db 的人格档案检索层"""

    def __init__(self, core_storage):
        self.cs = core_storage

    def fast_search(self, npc_name: str) -> Dict:
        """快速检索某实体的档案，返回结构化字典"""
        slug = npc_name.lower().replace(" ", "_") if npc_name else "me"
        if npc_name and npc_name in ["Me", "User", "我"]:
            slug = "me"
        entity = self.cs.get_entity_by_slug(slug)
        if not entity:
            return {"traits": {}, "relationships": []}
        return {
            "traits": entity.get("ontology_traits", {}),
            "relationships": self._get_relationships(slug)
        }

    def _get_relationships(self, entity_id: str) -> list:
        """从 relation_cache 获取关系列表"""
        try:
            rows = self.cs.conn.execute('''
                SELECT * FROM relation_cache
                WHERE entity_pair LIKE ? OR entity_pair LIKE ?
            ''', (f'{entity_id}%', f'%{entity_id}')).fetchall()
            result = []
            for r in rows:
                pair = r["entity_pair"]
                other = pair.replace(entity_id, "").replace("__", "")
                if other:
                    result.append({
                        "name": other,
                        "bond_strength": r["bond_strength"],
                        "shared_count": r["shared_event_count"]
                    })
            return result
        except Exception:
            return []

    def save_traits(self, entity_id: str, traits_data: dict):
        """保存特质到 core_storage"""
        slug = entity_id.lower().replace(" ", "_")
        if slug in ["me", "user", "我"]:
            slug = "me"
        self.cs.update_ontology_traits(slug, traits_data)

    def append_timeline(self, entity_id: str, entry: dict):
        """追加时间线条目（已弃用，事件直接存 events 表）"""
        pass

class EmpathyAgent:
    def __init__(self, use_openrouter=False):
        # 1. 初始化核心存储与组件
        self.cs = CoreStorage()
        self.vault = HierarchicalVault(self.cs)
        self._init_kg_mem()
        self.entity_manager = get_entity_manager()
        self.npc_store = UnifiedNPCStore()

        
        # 2. 初始化短期热记忆（按 user_id 隔离，防止跨用户数据泄漏）
        self._history_buffers = {}  # {user_id: {last_consolidation_ts, messages}}

        self.default_ego = "- 拒绝理中客说教，不准说'你要往好处想'这种话。\n- 永远站在对方这边，先共情再说话。\n- 说话真实自然，像朋友一样，不端着不装。"
        
        # 3. 模型配置
        self.use_openrouter = use_openrouter
        logger.info(f"🔧 模型配置: {'OpenRouter (远程)' if use_openrouter else 'Ollama (本地)'}")

    def _init_kg_mem(self):
        if not KG_MEM_AVAILABLE:
            self.kg_mem = None
            logger.warning("⚠️ kg_mem 不可用，三元组提取已跳过。")
            return
        ai_config = {"model": f"ollama/{_ms_local_model()}", "api_base": "http://localhost:11434", "temperature": 0.0}
        self.kg_mem = KGMem(atrium_persona_ontology, ai_config=ai_config, storage_path="kg_memory_brain.json")

    def _resolve_user_id(self, user_id: str = None) -> str:
        """解析热记忆归属的用户 ID。未显式传入时，从当前请求上下文读取。"""
        if not user_id:
            try:
                from server.model_service import current_user_id as _cu
                user_id = _cu()
            except Exception:
                user_id = None
        return user_id or "default"

    def _history_file_for(self, user_id: str) -> str:
        return f"short_term_history_{user_id or 'default'}.json"

    def _load_history_buffer(self, user_id: str = None):
        """按用户加载热记忆。懒加载：首次访问的 user_id 才从磁盘读取。"""
        uid = self._resolve_user_id(user_id)
        if uid in self._history_buffers:
            return self._history_buffers[uid]
        path = self._history_file_for(uid)
        data = {"last_consolidation_ts": time.time(), "messages": []}
        if os.path.exists(path):
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    loaded = json.load(f)
                if isinstance(loaded, dict) and isinstance(loaded.get("messages"), list):
                    data = loaded
            except Exception:
                pass
        self._history_buffers[uid] = data
        return data

    def _save_history_buffer(self, user_id: str = None):
        """按用户持久化热记忆。"""
        uid = self._resolve_user_id(user_id)
        data = self._history_buffers.get(uid)
        if data is not None:
            with open(self._history_file_for(uid), 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)

    def chat(self, user_input: str, user_name: str = "Me", diary_context: str = ""):
        uid = self._resolve_user_id()
        hb = self._load_history_buffer(uid)
        # --- [步骤 A: 极速反馈逻辑] ---
        
        # 1. 层次化精准检索：探测 NPC 并从 core_storage 检索档案
        npc_target = self._detect_npc(user_input)
        vault_data = self.vault.fast_search(npc_target)
        search_context = self._format_vault_context(vault_data, npc_target)
        
        # 2. 热缓存拼接
        hot_context = " | ".join([m["content"] for m in hb["messages"][-3:]])
        
        # 3. 产出最终回复 (L1-L3 内部逻辑由 _call_chain 完成)
        result = self._generate_response(user_input, search_context, hot_context, diary_context)
        
        # --- [步骤 B: 数据回填热缓存] ---
        hb["messages"].append({"ts": time.time(), "role": "user", "content": user_input})
        ai_reply = result.get("response", "") if isinstance(result, dict) else str(result)
        ai_thinking = result.get("thinking", "") if isinstance(result, dict) else ""
        if ai_reply:
            hb["messages"].append({"ts": time.time(), "role": "assistant", "content": ai_reply, "thinking": ai_thinking})
        
        # --- [步骤 C: 时间对齐与沉淀判断] ---
        last_msg_ts = time.time()
        last_cons_ts = hb.get("last_consolidation_ts", 0)
        gap = last_msg_ts - last_cons_ts
        
        if gap > 10 and len(hb["messages"]) > 1:
            logger.info(f"⏳ [后台监测] 距上次沉淀已过 {gap:.1f} 秒，满足深度更新条件。开始后台整理人格档案...")
            def consolidation_task(uid=uid, hb=hb):
                self._do_consolidation(user_id=uid)
                hb["last_consolidation_ts"] = time.time()
                self._save_history_buffer(uid)
            
            from server.background import submit_background
            submit_background(consolidation_task)
        
        self._save_history_buffer(uid)
        
        # 确保返回结构化数据
        if isinstance(result, dict):
            return result
        return {"thinking": "", "response": result}
    
    def get_chat_history(self, limit: int = 50, user_id: str = None):
        """返回最近 N 条对话历史，格式化为前端可用的消息列表"""
        hb = self._load_history_buffer(user_id)
        msgs = hb.get("messages", [])
        # 只返回有 role 字段的新格式消息（兼容旧数据）
        formatted = []
        for m in msgs[-limit:]:
            role = m.get("role")
            content = m.get("content", "")
            if role == "user":
                formatted.append({"role": "user", "content": content, "thinking": "", "timestamp": m.get("ts", 0) * 1000})
            elif role == "assistant":
                formatted.append({"role": "assistant", "content": content, "thinking": m.get("thinking", ""), "timestamp": m.get("ts", 0) * 1000, "diaryDate": m.get("diary_date", "")})
            # 跳过旧格式无 role 的消息（已由 consolidation 处理）
        return formatted
    
    def greeting(self, diary_content: str, diary_date: str = "") -> dict:
        """基于日记内容生成问候语
        Returns: {"thinking": str, "response": str}
        """
        date_str = f"日期是{diary_date}，" if diary_date else ""
        system_prompt = build_greeting_system(date_str)
        
        user_prompt = f"【今日日记】\n{strip_html_for_llm(diary_content)[:1500]}\n\n请给出问候："
        # 问候语只需 150 字以内，用小 num_predict 大幅提速
        return self._call_ollama(user_prompt, system_prompt, num_predict=200)

    def greeting_stream(self, diary_content: str, diary_date: str = "", user_id: str = None):
        """流式问候：逐 token yield {type, content}，复用 _call_ollama_stream"""
        uid = self._resolve_user_id(user_id)
        hb = self._load_history_buffer(uid)
        date_str = f"日期是{diary_date}，" if diary_date else ""
        system_prompt = build_greeting_system(date_str)

        user_prompt = f"【今日日记】\n{strip_html_for_llm(diary_content)[:1500]}\n\n请给出问候："
        # Stream output while accumulating for history save
        ai_reply = ""
        ai_thinking = ""
        for chunk in self._call_ollama_stream(user_prompt, system_prompt):
            if chunk.get("type") == "response":
                ai_reply += chunk.get("content", "")
            elif chunk.get("type") == "thinking":
                ai_thinking += chunk.get("content", "")
            yield chunk

        # Save greeting to history_buffer so it persists after refresh
        if ai_reply:
            hb["messages"].append(
                {"ts": time.time(), "role": "assistant", "content": ai_reply, "thinking": ai_thinking, "diary_date": diary_date}
            )
            self._save_history_buffer(uid)

    def _generate_response(self, user_input, long_context, short_context, diary_context=""):
        # 构建更完整的系统提示词，确保长期记忆被正确利用
        # 构建系统提示词，融合用户自定义人格设定
        from server.persona_config import get_persona_ego
        from server.model_service import current_user_id
        persona_ego = (get_persona_ego(current_user_id(), "empathy") or "").strip()
        ego_parts = [persona_ego] if persona_ego else []
        if self.default_ego and self.default_ego.strip():
            ego_parts.append(self.default_ego.strip())

        system_prompt = build_empathy_system(ego_parts)

        # 动态构建上下文区块，空值时省略整个段落
        context_blocks = []
        if diary_context:
            context_blocks.append(f"【今日日记】\n{diary_context}")
        if long_context:
            context_blocks.append(f"【长期记忆背景】\n{long_context}")
        if short_context:
            context_blocks.append(f"【近期对话脉络】\n{short_context}")

        context_section = ""
        if context_blocks:
            context_section = "\n\n" + "\n\n".join(context_blocks)

        user_prompt = f"""{context_section}
用户说：{user_input}

请回复：""".strip()

        logger.info("🔍 生成共情回复...")
        print(f"📋 日记上下文长度: {len(diary_context)} 字符")
        print(f"📋 长期记忆上下文长度: {len(long_context)} 字符")
        result = self._call_ollama(user_prompt, system_prompt)
        # 后处理：剥离回复末尾回显的用户原话
        if isinstance(result, dict) and result.get("response"):
            result["response"] = self._strip_echoed_input(result["response"], user_input)
        return result

    def _format_vault_context(self, vault_data: dict, npc_name: str = None) -> str:
        """将 vault.fast_search 返回的结构化字典转为文本上下文"""
        context_parts = []
        traits = vault_data.get("traits", {})
        if traits:
            # traits 是 dict，如 {"emotion.emotion_type": "稳定", "social_style.social_type": "自来熟"}
            trait_lines = [f"{k}: {v}" for k, v in traits.items() if v]
            if trait_lines:
                if npc_name and npc_name not in ["Me", "User", "我"]:
                    context_parts.append(f"【关于 {npc_name} 的已知特质】: " + " | ".join(trait_lines))
                else:
                    context_parts.append("【关于我的重要记忆】: " + " | ".join(trait_lines[:5]))

        relationships = vault_data.get("relationships", [])
        if relationships:
            rel_lines = [f"{r['name']}(亲密度:{r['bond_strength']:.1f})" for r in relationships[:5]]
            if npc_name:
                context_parts.append(f"【关于 {npc_name} 的关系】: " + " | ".join(rel_lines))
            else:
                context_parts.append("【已知关系】: " + " | ".join(rel_lines))

        return "\n".join(context_parts)

    def extract_entities_from_text(self, text: str) -> dict:
        """从文本中提取实体、关系和人设维度（含子属性和置信水平）"""
        system_prompt = """你是一个人设分析专家。请从文本中提取人物信息，重点关注人设维度（含子属性）。

【输出格式】（必须严格遵守JSON格式）
{
  "entities": [
    {
      "name": "人名",
      "type": "NPC",
      "traits": [
        {"dimension": "knowledge", "sub_key": "education", "content": "教育水平描述", "confidence": 0.9},
        {"dimension": "knowledge", "sub_key": "major", "content": "专业领域描述", "confidence": 0.7},
        {"dimension": "thinking_style", "sub_key": "thinking_type", "content": "理性/感性/偏执/跳跃/防御", "confidence": 0.5},
        {"dimension": "mindset_pattern", "sub_key": "mindset_type", "content": "defensive/乐观/灾难化/受害者/权威崇拜", "confidence": 0.5},
        {"dimension": "morality", "sub_key": "morality_type", "content": "耿直/撒谎/选择性诚实/自我保护/操纵", "confidence": 0.5},
        {"dimension": "emotion", "sub_key": "emotion_type", "content": "稳定/易怒/焦虑/抑郁/冷漠/戏剧化", "confidence": 0.5},
        {"dimension": "social_style", "sub_key": "social_type", "content": "自来熟/保持距离/讨好/对抗/观察者", "confidence": 0.5},
        {"dimension": "tone", "sub_key": "formality", "content": "正式度描述", "confidence": 0.5},
        {"dimension": "tone", "sub_key": "warmth", "content": "温度描述", "confidence": 0.5},
        {"dimension": "tone", "sub_key": "humor", "content": "幽默度描述", "confidence": 0.5},
        {"dimension": "tone", "sub_key": "confidence_tone", "content": "自信度描述", "confidence": 0.5},
        {"dimension": "speech_habits", "sub_key": "catchphrase", "content": "口头禅", "confidence": 0.8},
        {"dimension": "speech_habits", "sub_key": "filler_words", "content": "语气词", "confidence": 0.8},
        {"dimension": "speech_habits", "sub_key": "dialect", "content": "方言词汇", "confidence": 0.8},
        {"dimension": "body_habits", "sub_key": "nervous", "content": "紧张时的动作", "confidence": 0.8},
        {"dimension": "body_habits", "sub_key": "thinking", "content": "思考时的动作", "confidence": 0.8},
        {"dimension": "body_habits", "sub_key": "happy", "content": "开心时的动作", "confidence": 0.8},
        {"dimension": "body_habits", "sub_key": "lying", "content": "撒谎时的动作", "confidence": 0.8},
        {"dimension": "body_habits", "sub_key": "defensive", "content": "防御时的动作", "confidence": 0.8},
        {"dimension": "honesty_level", "sub_key": "honesty_type", "content": "耿直/掩饰/看心情/选择性坦诚/表演型", "confidence": 0.5},
        {"dimension": "identity", "sub_key": "basic_info", "content": "姓名、年龄、职业等基本信息", "confidence": 0.9},
        {"dimension": "identity", "sub_key": "background", "content": "背景故事", "confidence": 0.6},
        {"dimension": "relationship", "sub_key": "history", "content": "与用户的过往经历", "confidence": 0.5},
        {"dimension": "relationship", "sub_key": "trust_level", "content": "信任程度", "confidence": 0.5},
        {"dimension": "relationship", "sub_key": "power_dynamic", "content": "权力关系", "confidence": 0.5},
        {"dimension": "relationship", "sub_key": "emotional_debt", "content": "情感债务", "confidence": 0.5},
        {"dimension": "motivation", "sub_key": "want", "content": "想要得到什么", "confidence": 0.5},
        {"dimension": "motivation", "sub_key": "avoid", "content": "想要避免什么", "confidence": 0.5},
        {"dimension": "motivation", "sub_key": "fix", "content": "想要修复什么", "confidence": 0.5}
      ]
    }
  ],
  "relations": [
    {"from": "人物A", "to": "人物B", "type": "knows/meets/befriends", "relation": "关系描述", "sentiment_delta": 0.0}
  ],
  "emotions": {"happy": 0.0, "sad": 0.0, "anxious": 0.0, "excited": 0.0},
  "summary": "这段内容的简要总结（不超过50字）"
}

【抽取规则】
1. 每个人物都要提取，用户自己用"Me"表示
2. traits数组中只包含文本中能明确推断出的维度和子属性，不确定的不要填
3. 每个trait必须包含 dimension 和 sub_key 两个字段
4. confidence（置信水平）说明：
   - 1.0：文本中明确直接提到的信息
   - 0.8：文本中多次间接佐证的信息
   - 0.6：根据文本内容合理推断的信息
   - 0.4：根据少量线索推测的信息
   - 0.2：纯猜测，证据很少
5. 关系类型：knows(认识), meets(相遇), befriends(成为朋友), interacts(互动), confides(倾诉)
6. 情绪值范围0.0-1.0

【置信水平示例】
- "她是中文系大三学生" → dimension:"identity", sub_key:"basic_info", content:"中文系大三学生", confidence:1.0
- "她经常聊文学" → dimension:"knowledge", sub_key:"reading", content:"文学素养较高", confidence:0.8
- "她说话总带'呀''啦'" → dimension:"speech_habits", sub_key:"filler_words", content:"常用语气词'呀''啦'", confidence:1.0
- "她看起来有点内向" → dimension:"social_style", sub_key:"social_type", content:"偏内向", confidence:0.6
"""
        
        user_prompt = f"请分析以下内容，提取人物和人设维度（含子属性和置信水平）：\n\n{text}"
        
        try:
            response = self._call_ollama(user_prompt, system_prompt, json_mode=True)
            response_text = response["response"] if isinstance(response, dict) else response
            # 尝试解析JSON
            import json
            try:
                result = json.loads(response_text)
            except json.JSONDecodeError:
                # 兜底：正则提取
                import re
                json_match = re.search(r'\{[\s\S]*\}', response_text)
                if json_match:
                    result = json.loads(json_match.group())
                else:
                    logger.warning(f"⚠️ 无法解析实体提取结果: {response[:100]}")
                    return {'entities': [], 'relations': [], 'emotions': {}, 'summary': ''}
            
            # 校验：至少要有 entities
            if not result.get('entities'):
                result['entities'] = []
            # 校验：确保 relations 是列表
            if not isinstance(result.get('relations'), list):
                result['relations'] = []
            # 校验：确保 emotions 是字典
            if not isinstance(result.get('emotions'), dict):
                result['emotions'] = {}
            
            # 自我指代词统一归为 Me
            self_referential = {'用户', '我', '自己', '本人', 'User', 'Me'}
            for entity in result.get('entities', []):
                name = entity['name']
                if name in self_referential:
                    name = 'Me'
                
                # 保存人设维度到 core_storage（合并写入 ontology_traits）
                slug = name.lower().replace(" ", "_")
                if slug in ["me", "user", "我"]:
                    slug = "me"

                # 确保实体存在
                existing = self.cs.get_entity_by_slug(slug)
                if not existing:
                    self.cs.upsert_entity(
                        entity_id=slug, name=name, slug=slug,
                        entity_type="user" if name == "Me" else "npc"
                    )
                    existing = self.cs.get_entity_by_slug(slug)

                # 合并 traits 到 ontology_traits
                current_traits = existing.get("ontology_traits", {})
                traits_list = entity.get('traits', [])
                if traits_list and isinstance(traits_list, list):
                    for trait in traits_list:
                        if trait.get('content'):
                            dimension = trait.get('dimension', 'unknown')
                            sub_key = trait.get('sub_key', '')
                            trait_key = f"{dimension}.{sub_key}" if sub_key else dimension
                            # 只保留高置信度或新信息
                            confidence = trait.get('confidence', 0.5)
                            if confidence >= 0.5 or trait_key not in current_traits:
                                current_traits[trait_key] = trait['content']
                elif entity.get('properties'):
                    role = entity.get('properties', {}).get('role', '未知')
                    if 'identity.basic_info' not in current_traits:
                        current_traits['identity.basic_info'] = role

                self.cs.update_ontology_traits(slug, current_traits)
                
                self.entity_manager.add_mention(name, '日记中出现')
                logger.info(f"📝 记录人物: {name}")
            
            # 关系中的自我指代也统一为 Me
            for rel in result.get('relations', []):
                if rel.get('from') in self_referential:
                    rel['from'] = 'Me'
                if rel.get('to') in self_referential:
                    rel['to'] = 'Me'
            return result
        except json.JSONDecodeError:
            # 兜底：正则提取
            import re
            json_match = re.search(r'\{[\s\S]*\}', response)
            if json_match:
                try:
                    result = json.loads(json_match.group())
                    return result
                except:
                    pass
            logger.warning(f"⚠️ 无法解析实体提取结果: {response[:100]}")
            return {'entities': [], 'relations': [], 'emotions': {}, 'summary': ''}
        except Exception as e:
            logger.error(f"⚠️ 实体提取异常: {e}")
            return {'entities': [], 'relations': [], 'emotions': {}, 'summary': ''}

    def _do_consolidation(self, user_id: str = None):
        """沉淀管道：提取三元组 -> 写入 core_storage.db
        只沉淀旧消息，保留最近 50 条对话作为热缓存"""
        uid = self._resolve_user_id(user_id)
        hb = self._load_history_buffer(uid)
        msgs = hb.get("messages", [])
        if not msgs:
            return

        # 保留最近 50 条作为对话历史，只沉淀更早的消息
        KEEP = 50
        to_consolidate = msgs[:-KEEP] if len(msgs) > KEEP else []
        to_keep = msgs[-KEEP:] if len(msgs) > KEEP else msgs

        if not to_consolidate:
            logger.info("⏳ 消息不足 50 条，暂不沉淀。")
            return

        dialogue_block = "\n".join([m["content"] for m in to_consolidate])
        if not dialogue_block.strip():
            return

        extracted_facts = []

        # 1. kg_mem 提取三元组作为 extracted_facts
        if self.kg_mem:
            try:
                relations = self.kg_mem.add_unstructured(dialogue_block)
                if relations:
                    for rel in relations:
                        fact = {
                            "triple": f"{rel.entity0.name} - {rel.type.name} - {rel.entity1.name}",
                            "detail": rel.relation
                        }
                        extracted_facts.append(fact)

                        # 将三元组中的特质信息同步到实体 ontology_traits
                        self._sync_triple_to_entity(rel)

                    logger.info(f"✅ 三元组提取：获得 {len(relations)} 条知识。")
            except Exception as e:
                logger.warning(f"⚠️ 三元组提取跳过: {e}")

        # 4. 只替换为保留的消息（不清空）
        hb["messages"] = to_keep
        self._save_history_buffer(uid)
        logger.info(f"✅ 沉淀完成，保留最近 {len(to_keep)} 条对话，沉淀了 {len(to_consolidate)} 条。")

    def _sync_triple_to_entity(self, rel):
        """将三元组中的特质信息同步到 core_storage 实体的 ontology_traits"""
        e0_name = self._normalize_entity_name(rel.entity0.name)
        e1_name = self._normalize_entity_name(rel.entity1.name)
        r_type = rel.type.name

        # 维度映射
        dimension_map = {
            "has_habit": "behavior",
            "believes_in": "values",
            "sensitive_to": "mindset_pattern",
            "strives_for": "motivation",
        }

        # 确定目标实体和特质 key
        e0_type = rel.entity0.type.name if hasattr(rel.entity0.type, 'name') else str(rel.entity0.type)
        abstract_types = ["Habit", "Value", "Concept", "Emotion", "Goal", "Preference"]
        is_e0_person = e0_type in ["User", "NPC"]
        is_e1_abstract = e1_name in abstract_types or str(e1_name) in abstract_types

        target_name = None
        trait_key = None
        trait_value = None

        if e0_name in ["Me", "User", "我"] and r_type in dimension_map:
            target_name = "me"
            trait_key = f"{dimension_map[r_type]}.{r_type}"
            trait_value = f"{r_type}: {e1_name} ({rel.relation})"
        elif is_e0_person and is_e1_abstract and r_type in dimension_map:
            target_name = e0_name.lower().replace(" ", "_")
            trait_key = f"{dimension_map[r_type]}.{r_type}"
            trait_value = f"{r_type}: {e1_name} ({rel.relation})"

        if target_name and trait_key:
            existing = self.cs.get_entity_by_slug(target_name)
            if not existing:
                self.cs.upsert_entity(
                    entity_id=target_name, name=e0_name if target_name != "me" else "Me",
                    slug=target_name,
                    entity_type="user" if target_name == "me" else "npc"
                )
                existing = self.cs.get_entity_by_slug(target_name)
            traits = existing.get("ontology_traits", {})
            traits[trait_key] = trait_value
            self.cs.update_ontology_traits(target_name, traits)

    def _dispatch_to_vault(self, rel):
        """三元组分拣：将三元组作为 extracted_facts 追加到关联事件。
        如果没有关联事件，跳过（不再写 brain_arch JSON）。"""
        # 注册/更新实体信息
        e0 = self._normalize_entity_name(rel.entity0.name)
        e1 = self._normalize_entity_name(rel.entity1.name)
        r_type = rel.type.name
        e0_type = rel.entity0.type.name if hasattr(rel.entity0.type, 'name') else str(rel.entity0.type)
        e1_type = rel.entity1.type.name if hasattr(rel.entity1.type, 'name') else str(rel.entity1.type)

        is_e1_person = e1_type in ["User", "NPC"]
        if e1 not in ["Me", "User", "我"] and is_e1_person:
            self.entity_manager.add_mention(e1, rel.relation)

        # 三元组作为 fact 已在 _do_consolidation 中统一处理，此处不再重复写入

    def _normalize_entity_name(self, name: str) -> str:
        """标准化实体名：从 core_storage 已有实体中查找匹配，避免重复创建"""
        normalized = name.strip()
        slug = normalized.lower().replace(" ", "_")
        if slug in ["me", "user", "我"]:
            return "Me"
        # 从 core_storage 查找已有实体
        existing = self.cs.get_entity_by_slug(slug)
        if existing:
            return existing["name"]
        # 模糊匹配：按 name 字段查找
        all_entities = self.cs.get_all_entities()
        for ent in all_entities:
            if ent["name"].lower() == normalized.lower():
                return ent["name"]
        return normalized

    def consolidate_diary(self, diary_content: str):
        """将日记内容沉淀到 core_storage（通过 kg_mem 管道）"""
        if not diary_content or len(diary_content) <= 10:
            return 0
        # 临时放入热缓存，走统一沉淀管道
        uid = self._resolve_user_id()
        hb = self._load_history_buffer(uid)
        temp_messages = [{"ts": time.time(), "content": strip_html_for_llm(diary_content)}]
        original_messages = hb["messages"]
        hb["messages"] = temp_messages
        try:
            self._do_consolidation(user_id=uid)
            return 1
        except Exception as e:
            logger.error(f"⚠️ 日记沉淀失败: {e}")
            hb["messages"] = original_messages
        return 0

    def _detect_npc(self, text):
        """智能 NPC 检测：使用实体管理器进行消歧"""
        # 从文本中提取可能的名字
        names = self._extract_names_from_text(text)
        
        for name in names:
            entity_id, candidates, clarification = self.entity_manager.disambiguate(name, text)
            
            if entity_id:
                entity = self.entity_manager.get_entity_by_id(entity_id)
                if entity and entity["entity_id"] != "Me":
                    # print(f"🔍 智能检测到 NPC: {entity['canonical_name']} (ID: {entity_id})")
                    return entity['canonical_name']
            
            # if candidates:
                # print(f"⚠️ 检测到 {len(candidates)} 个可能的 NPC，需要消歧")
        
        return None
    
    def _extract_names_from_text(self, text):
        """从文本中提取可能的人名"""
        import re
        names = []
        
        # 常见的名字模式
        name_patterns = [
            r'和([^\s，。！？,!?]{1,4})[一起吃请]|([^\s，。！？,!?]{1,4})在|([^\s，。！？,!?]{1,4})说|([^\s，。！？,!?]{1,4})是|([^\s，。！？,!?]{1,4})的',
        ]
        
        # 特定已知名字
        known_names = ["张三", "李四", "王五", "赵六", "林林", "小林", "阿林", "老林", "小李", "老王", "小张"]
        
        for known in known_names:
            if known in text:
                names.append(known)
        
        # 使用更通用的中文名字检测
        # 找"X在..."、"和X..."、"X说..."等模式
        general_patterns = [
            r'和([^\s，。！？、,!?]{2,4})(?:一起|吃|说|在|请|约|去|看|给)',
            r'([^\s，。！？、,!?]{2,4})(?:说|在|是|请|给|叫|让)',
            r'(?:我|我们)的([^\s，。！？、,!?]{2,4})',
            r'^([^\s，。！？、,!?]{2,4})(?:今天|昨天|刚才|刚才)',
        ]
        
        for pattern in general_patterns:
            matches = re.findall(pattern, text)
            names.extend(matches)
        
        # 去重
        seen = set()
        unique_names = []
        for n in names:
            if n not in seen and len(n) >= 2:
                seen.add(n)
                unique_names.append(n)
        
        return unique_names

    # ==================== 沙盘演练相关功能 ====================

    def get_npc_list(self):
        """获取所有已解锁的 NPC 列表"""
        return self.npc_store.get_npc_list()

    def get_npc_info(self, npc_name: str):
        """获取 NPC 的详细信息"""
        info = self.npc_store.get_npc_info(npc_name)
        return {
            "name": info.get("name", npc_name),
            "traits": info.get("traits_text", []),
            "traits_structured": info.get("traits_structured", []),  # 新增：结构化人设维度
            "relationships": info.get("relationships_text", []),
            "interaction_count": info.get("interaction_count", 0)
        }

    def _call_ollama(self, prompt, system, json_mode=False, model=None, num_predict=None, temperature=None, seed=None):
        if _ms_use_openrouter():
            return self._call_openrouter(prompt, system)
        return self._call_local_ollama(prompt, system, json_mode=json_mode, model=model, num_predict=num_predict, temperature=temperature, seed=seed)
    
    def _call_local_ollama(self, prompt, system, json_mode=False, model=None, num_predict=None, temperature=None, seed=None):
        """调用本地Ollama模型，流式接收，分离 thinking 和 response
        如果模型不支持 think:True，会手动解析  thinking... response 标签
        Returns: {"thinking": str, "response": str}
        """
        payload = {"model": model or _ms_local_model(), "prompt": prompt, "system": system, "stream": True}
        if json_mode:
            payload["format"] = "json"
            payload["think"] = False
            payload["options"] = {"num_predict": 1024, "num_ctx": 8192}
        else:
            payload["think"] = False
            payload["options"] = {"num_predict": num_predict or 2048, "num_ctx": 8192}
        # 打分/分类等确定性任务显式传低温度，避免同一篇日记每次结果随机波动；
        # 不传时保持 Ollama 默认温度（聊天等生成任务保留创造性）。
        if temperature is not None:
            payload["options"]["temperature"] = temperature
        # 打分任务传固定 seed，结合低温度实现完全确定性输出；
        # 不传时走随机采样（聊天等生成任务保留多样性）。
        if seed is not None:
            payload["options"]["seed"] = seed
        max_retries = 2
        last_error = None
        for attempt in range(max_retries + 1):
            try:
                res = requests.post(OLLAMA_URL, json=payload, timeout=300, stream=True)
                thinking_parts = []
                response_parts = []
                for line in res.iter_lines(decode_unicode=True):
                    if not line:
                        continue
                    try:
                        chunk = json.loads(line)
                        if chunk.get("thinking"):
                            thinking_parts.append(chunk["thinking"])
                        if chunk.get("response"):
                            response_parts.append(chunk["response"])
                        if chunk.get("done", False):
                            break
                    except json.JSONDecodeError:
                        continue
                
                thinking_text = "".join(thinking_parts).strip()
                response_text = "".join(response_parts).strip()
                
                # 如果 thinking 为空但 response 包含  response，手动解析
                if not thinking_text and response_text and " response" in response_text:
                    parts = response_text.split(" response", 1)
                    thinking_text = parts[0].replace(" thinking", "").strip()
                    response_text = parts[1].strip() if len(parts) > 1 else ""
                    # 移除思考标题（如 "Thinking Process:" 等）
                    THINKING_HEADERS = ["Thinking Process:", "Thinking:", "思考过程:", "思考:", "Let me think", "Let's analyze"]
                    for h in THINKING_HEADERS:
                        if thinking_text.startswith(h):
                            thinking_text = thinking_text[len(h):].strip()
                            break
                
                return {
                    "thinking": thinking_text,
                    "response": response_text or "（静静地倾听）"
                }
            except (requests.ConnectionError, requests.Timeout) as e:
                last_error = e
                if attempt < max_retries:
                    logger.warning(f"Ollama 连接失败，重试 {attempt + 1}/{max_retries}...")
                    time.sleep(1)
                else:
                    logger.error(f"Ollama 调用失败（已重试{max_retries}次）: {e}")
            except Exception as e:
                last_error = e
                logger.error(f"Ollama 调用失败: {e}")
                break
        return {"thinking": "", "response": "（静静地倾听）"}
    
    def _call_openrouter(self, prompt, system, images=None):
        """调用OpenRouter API，返回结构化结果
        Returns: {"thinking": str, "response": str}
        images: 可选，裸 base64 图片列表；OpenAI 兼容格式以 content parts 传递
        """
        if images:
            # OpenAI 兼容多模态格式：content 为 parts 数组
            content_parts = [{"type": "text", "text": prompt}]
            for img_b64 in images:
                content_parts.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:image/png;base64,{img_b64}"}
                })
            user_content = content_parts
        else:
            user_content = prompt

        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user_content}
        ]
        
        payload = {
            "model": _ms_openrouter_model(),
            "messages": messages,
            "reasoning": {"enabled": True}
        }
        
        headers = {
            "Authorization": f"Bearer {_ms_openrouter_api_key()}" if _ms_openrouter_api_key() else "",
            "Content-Type": "application/json"
        }
        
        try:
            response = requests.post(OPENROUTER_URL, headers=headers, json=payload, timeout=60)
            response = response.json()
            
            if 'error' in response:
                logger.error(f"OpenRouter错误: {response['error']['message']}")
                return {"thinking": "", "response": "（静静地倾听）"}
            else:
                msg = response['choices'][0]['message']
                thinking = msg.get('reasoning', '') or ''
                content = msg.get('content', '') or '（静静地倾听）'
                return {"thinking": thinking, "response": content}
        except Exception as e:
            logger.error(f"OpenRouter调用失败: {e}")
            return {"thinking": "", "response": "（静静地倾听）"}

# ===== 流式输出方法 =====
    
    def _call_ollama_stream(self, prompt, system, think=False, num_predict=2048, images=None):
        """流式调用 Ollama，逐个 yield chunk
        
        Args:
            think: 是否启用思考模式（think: True 时 thinking 和 response 共享 num_predict 预算）
            num_predict: 总输出 token 预算（thinking + response 合计）
            images: 可选，裸 base64 图片列表，传给多模态模型进行视觉理解
        """
        if _ms_use_openrouter():
            yield from self._call_openrouter_stream(prompt, system, images=images)
        else:
            yield from self._call_local_ollama_stream(prompt, system, think=think, num_predict=num_predict, images=images)
    
    def _call_local_ollama_stream(self, prompt, system, think=False, num_predict=2048, images=None):
        """流式接收 Ollama 响应，自动分离思考和回复
        支持三种模式：
        1. Ollama 原生 think:True → thinking 字段自动分离
        2. 模型输出  thinking... response 标签 → 手动解析
        3. 模型输出 "Thinking Process:" 等标题 +  response → 手动解析
        4. 模型不使用任何思考标记 → 直接输出为回复"""
        payload = {"model": _ms_local_model(), "prompt": prompt, "system": system, "stream": True, "think": think, "options": {"num_predict": num_predict, "num_ctx": 8192}}
        if images:
            payload["images"] = list(images)  # Ollama /api/generate 支持 images 字段（裸 base64）
        # 思考标题模式（模型不用  thinking 开头但用这些标题 +  response 结尾）
        THINKING_HEADERS = ["Thinking Process:", "Thinking:", "思考过程:", "思考:", "Let me think", "Let's analyze"]
        TAG_OPEN = " thinking"
        TAG_CLOSE = " response"
        BUFFER_THRESHOLD = 50  # 缓冲区达到此长度后判断是否为思考内容

        try:
            res = requests.post(OLLAMA_URL, json=payload, timeout=300, stream=True)

            # 状态机：detecting → thinking → response
            # detecting: 缓冲前几个 chunk，判断是否为思考内容
            # thinking: 流式输出思考内容，直到遇到  response
            # response: 流式输出回复内容
            state = "detecting"
            raw_buffer = ""

            for line in res.iter_lines(decode_unicode=True):
                if not line:
                    continue
                try:
                    chunk = json.loads(line)

                    # 1. 如果 Ollama 原生分离了 thinking 字段，直接使用
                    if chunk.get("thinking"):
                        if state == "detecting":
                            state = "response"  # 原生支持 think:True，后续 response 都是回复
                        yield {"type": "thinking", "content": chunk["thinking"]}

                    raw_resp = chunk.get("response", "")
                    if not raw_resp:
                        if chunk.get("done", False):
                            # 流结束时若仍有缓冲内容（短回复未达 50 字阈值），补发为回复
                            if raw_buffer and state != "response":
                                yield {"type": "response", "content": raw_buffer}
                            break
                        continue

                    if state == "detecting":
                        raw_buffer += raw_resp
                        stripped = raw_buffer.lstrip()

                        # 检查缓冲区中是否已出现  response
                        if TAG_CLOSE in raw_buffer:
                            # 找到  response，之前是思考，之后是回复
                            parts = raw_buffer.split(TAG_CLOSE, 1)
                            thinking_text = parts[0].replace(TAG_OPEN, "").strip()
                            # 移除思考标题
                            for h in THINKING_HEADERS:
                                if thinking_text.startswith(h):
                                    thinking_text = thinking_text[len(h):].strip()
                                    break
                            response_text = parts[1].strip() if len(parts) > 1 else ""
                            if thinking_text:
                                yield {"type": "thinking", "content": thinking_text}
                            if response_text:
                                yield {"type": "response", "content": response_text}
                            state = "response"
                            raw_buffer = ""
                        elif len(raw_buffer) >= BUFFER_THRESHOLD:
                            # 缓冲区足够长，判断是否为思考内容
                            is_thinking = any(stripped.startswith(h) for h in THINKING_HEADERS) or stripped.startswith(TAG_OPEN)
                            if is_thinking:
                                # 移除标题后作为思考内容输出，切换到 thinking 状态
                                thinking_text = stripped
                                for h in THINKING_HEADERS:
                                    if thinking_text.startswith(h):
                                        thinking_text = thinking_text[len(h):].strip()
                                        break
                                if thinking_text.startswith(TAG_OPEN):
                                    thinking_text = thinking_text[len(TAG_OPEN):].strip()
                                if thinking_text:
                                    yield {"type": "thinking", "content": thinking_text}
                                state = "thinking"
                                raw_buffer = ""
                            else:
                                # 不是思考内容，直接输出为回复
                                yield {"type": "response", "content": raw_buffer}
                                state = "response"
                                raw_buffer = ""
                        # else: 继续缓冲，等待更多数据

                    elif state == "thinking":
                        # 检查当前 chunk 是否包含  response
                        if TAG_CLOSE in raw_resp:
                            parts = raw_resp.split(TAG_CLOSE, 1)
                            if parts[0]:
                                yield {"type": "thinking", "content": parts[0]}
                            if len(parts) > 1 and parts[1].strip():
                                yield {"type": "response", "content": parts[1].strip()}
                            state = "response"
                        else:
                            yield {"type": "thinking", "content": raw_resp}

                    elif state == "response":
                        yield {"type": "response", "content": raw_resp}

                    if chunk.get("done", False):
                        if raw_buffer and state == "detecting":
                            # 流结束时仍有缓冲区内容，作为回复输出
                            yield {"type": "response", "content": raw_buffer}
                        break
                except json.JSONDecodeError:
                    continue
        except Exception as e:
            logger.error(f"Ollama 流式调用失败: {e}")
            yield {"type": "response", "content": "（静静地倾听）"}

    def _call_openrouter_stream(self, prompt, system, images=None):
        """OpenRouter 流式（简化版，非流式获取后一次性 yield）"""
        result = self._call_openrouter(prompt, system, images=images)
        if result.get("thinking"):
            yield {"type": "thinking", "content": result["thinking"]}
        if result.get("response"):
            yield {"type": "response", "content": result["response"]}

    def summarize_diary(self, diary_content: str) -> str:
        """用轻量模型快速总结日记核心内容，返回 2-4 字词语（不含标点）
        使用非流式调用，追求速度无感"""
        if not diary_content or not diary_content.strip():
            return "日常"
        system = "你是日记总结助手。你的任务是用一个2-4字的词语概括日记的核心内容。只输出词语本身，不要任何解释、标点或换行。示例：拖延、学习、旅行、陪伴、加班、阅读、健身、独处、思念、释然"
        prompt = f"日记内容：\n{strip_html_for_llm(diary_content)}\n\n用2-4字概括这篇日记的核心内容："
        result = self._call_ollama(prompt, system, num_predict=32, temperature=0.1, seed=101)
        raw = result.get("response", "日常").strip()
        # 清理标点符号、空白和换行，只保留汉字/字母/数字
        import re
        cleaned = re.sub(r'[\W_]', '', raw, flags=re.UNICODE)
        chars = [c for c in cleaned if c.strip()]
        if not chars:
            return "日常"
        # 限制最多 4 个字
        return "".join(chars[:4])

    def classify_emotion(self, diary_content: str) -> str:
        """鉴定日记的主要情绪，返回固定情绪词
        以普拉奇克情绪轮为底层框架，扩展为覆盖日常日记的高频情绪词表"""
        if not diary_content or not diary_content.strip():
            return "平静"

        # 情绪词表 = 普拉奇克8种基本情绪 + 8种初级复合情绪 + 日常高频补充情绪
        # 补充的情绪是中文日记中最常出现的细腻情绪，普拉奇克原表未覆盖
        emotions = (
            "喜悦、信任、恐惧、惊讶、悲伤、厌恶、愤怒、期待、"
            "爱、服从、敬畏、失望、悔恨、蔑视、侵略、乐观、"
            "懊恼、内疚、焦虑、委屈、疲惫、无奈、释然、思念、"
            "满足、兴奋、孤独、感激、平静、紧张、烦躁、期待感"
        )
        system = f"""你是一个情绪分析专家，基于罗伯特·普拉奇克（Robert Plutchik）的情绪轮理论分析情绪。

普拉奇克情绪轮定义 8 种基本情绪（每对互为对立）：
- 喜悦 (Joy) ↔ 悲伤 (Sadness)
- 信任 (Trust) ↔ 厌恶 (Disgust)
- 恐惧 (Fear) ↔ 愤怒 (Anger)
- 惊讶 (Surprise) ↔ 期待 (Anticipation)

以及 8 种初级复合情绪（相邻基本情绪两两组合）：
爱、服从、敬畏、失望、悔恨、蔑视、侵略、乐观

注意：除普拉奇克情绪外，中文日记常出现更细腻的混合情绪，如：
- 懊恼 = 恼怒 + 懊悔（因自己失误而恼火又后悔）
- 内疚 = 因对他人造成伤害而产生自责
- 焦虑 = 对未来的不安担忧
- 委屈 = 受到误解或伤害而憋屈
- 疲惫 = 身心俱疲、消耗感
- 无奈 = 明知无力改变的无助
- 释然 = 放下后的轻松
- 思念 = 对某人某地的牵挂

情绪唤醒度判断（重要）：
- 先判断整篇日记的情绪强度。若情绪强度低、冷静理性或偏日常（如规划、反思、复盘、陈述事实、流水账、自我要求），请优先从低唤醒标签「平静、满足、疲惫、释然」中选一个最贴切的，不要给出「无奈、焦虑、烦躁、紧张」等较强情绪词。
- 只有情绪确实强烈、明显外显（明显的喜/悲/怒/恐/厌恶等）时，才从其余强情绪词中选择。
- 四个低唤醒标签的含义：平静 = 平淡无起伏；满足 = 平和知足；疲惫 = 消耗无力的倦怠；释然 = 放下后的轻松。

阅读日记内容，从以下情绪候选词中选一个最贴切的：{emotions}。
优先判断日记的主导情绪，再选最匹配的词；若为复合情绪（如既恼又悔），选能同时涵盖其核心成分的词。
只输出情绪词本身，不要任何解释、标点或换行。"""
        prompt = f"日记内容：\n{strip_html_for_llm(diary_content)}\n\n主要情绪是："
        result = self._call_ollama(prompt, system, num_predict=32, temperature=0.1, seed=202)
        # 清理输出，确保只返回有效的情绪词
        raw = result.get("response", "平静").strip()
        valid_emotions = [e.strip() for e in emotions.split("、")]
        for e in valid_emotions:
            if e in raw:
                return e
        return "平静"

    def classify_emotion_vector(self, diary_content: str) -> dict:
        """识别日记主要情绪，量化为普拉奇克 8 基础情绪强度分（各 0-100）。
        返回 {喜悦,信任,恐惧,惊讶,悲伤,厌恶,愤怒,期待}。用于雷达均值与张力计算。"""
        axes = ["喜悦", "信任", "恐惧", "惊讶", "悲伤", "厌恶", "愤怒", "期待"]
        default = {a: 0 for a in axes}
        if not diary_content or not diary_content.strip():
            return default
        pair_tips = (
            "喜悦↔悲伤、信任↔厌恶、恐惧↔愤怒、惊讶↔期待"
        )
        system = f"""你是一名情绪量化专家，基于罗伯特·普拉奇克（Robert Plutchik）的情绪轮理论，把日记的主要情绪量化为 8 个基础情绪的强度分。

8 个基础情绪（每对互为对立）：{pair_tips}

规则：
1. 只识别"当天/这篇日记的主要情绪"，而非逐句统计出现过哪些情绪。人的情绪是多变的，但通常有一个主导情绪，去识别并分解这个主导情绪。
2. 每个基础情绪给出 0-100 的强度分，遵循统一标尺：0-20 几乎无 / 21-40 轻微 / 41-60 中等 / 61-80 明显 / 81-100 强烈。主情绪的核心成分给高分（70-100），次要成分给中低分，完全无关的给 0。
3. 若主导情绪是复合情绪（如"警觉=恐惧+期待"、"焦虑=恐惧+期待+不自信"），则把它分解为相应基础情绪的组合分数。
4. 【唤醒度校准，非常重要】先判断整篇日记的情绪强度（唤醒度）：
   - 若日记是冷静、理性、结构化、低唤醒的（如规划、反思、复盘、陈述事实、分析问题、自我要求），则所有维度都应给低分（0-30）。不要因为"有思考、有要求"就高估情绪。
   - 只有真正情绪强烈、明显外显的日记（明显的喜/悲/怒/恐/厌恶等），才允许出现高分（70-100）。
   - 分数要反映"情绪的强度"，而不是"内容的重要程度"或"思考的深度"。
5. 只输出 JSON 对象，键严格为以下 8 个：{("、".join(axes))}，值为 0-100 的整数。不要任何解释、前缀或换行外的多余文字。"""

        prompt = f"日记内容：\n{strip_html_for_llm(diary_content)}\n\n请输出 8 维情绪强度分 JSON："
        try:
            result = self._call_ollama(prompt, system, num_predict=256, temperature=0.1, seed=303)
            raw = result.get("response", "").strip()
            data = self._parse_emotion_vector(raw)
            if data:
                return data
        except Exception as e:
            logger.error(f"[情绪打分] 解析失败: {e}")
        return default

    def _parse_emotion_vector(self, raw: str) -> dict:
        """从 LLM 输出解析 8 维情绪向量，兼容裸 JSON 与带 ```json 包裹两种形态。"""
        import json
        axes = ["喜悦", "信任", "恐惧", "惊讶", "悲伤", "厌恶", "愤怒", "期待"]
        text = (raw or "").strip()
        # 去掉 ```json ... ``` 包裹
        if text.startswith("```"):
            text = text.split("\n", 1)[-1]
            if text.endswith("```"):
                text = text[:-3]
        # 截取第一个 JSON 对象
        try:
            start = text.index("{")
            end = text.rindex("}")
            obj = json.loads(text[start:end + 1])
        except (ValueError, json.JSONDecodeError):
            return {}
        if not isinstance(obj, dict):
            return {}
        out = {}
        ok = False
        for a in axes:
            v = obj.get(a)
            if v is None:
                # 容错：允许键带"情绪"等修饰
                for k, val in obj.items():
                    if a in k:
                        v = val
                        break
            try:
                n = int(round(float(v)))
            except (TypeError, ValueError):
                n = 0
            n = max(0, min(100, n))
            out[a] = n
            if n > 0:
                ok = True
        return out if ok else {}

    def analyze_diary_combined(self, diary_content: str) -> dict:
        """一次调用完成日记的「摘要 + 主导情绪 + 8维情绪向量」三项分析（日历格子用）。

        合并为单一结构化 JSON 调用，相比原三次独立调用速度提升约 36%，
        且情绪分类与现有分开调用完全一致。返回 {"summary", "emotion", "emotion_vector"}，
        任一字段解析失败时回退到对应默认值，不抛异常。
        """
        axes = ["喜悦", "信任", "恐惧", "惊讶", "悲伤", "厌恶", "愤怒", "期待"]
        default = {"summary": "日常", "emotion": "平静", "emotion_vector": {a: 0 for a in axes}}
        if not diary_content or not diary_content.strip():
            return dict(default)

        emotions_candidates = (
            "喜悦、信任、恐惧、惊讶、悲伤、厌恶、愤怒、期待、"
            "爱、服从、敬畏、失望、悔恨、蔑视、侵略、乐观、"
            "懊恼、内疚、焦虑、委屈、疲惫、无奈、释然、思念、"
            "满足、兴奋、孤独、感激、平静、紧张、烦躁、期待感"
        )
        system = f"""你是日记分析助手。请基于罗伯特·普拉奇克（Robert Plutchik）的情绪轮理论，一次性完成对这篇日记的三项分析，只输出一个 JSON 对象。

JSON 字段：
1. summary: 用 2-4 字词语概括日记核心内容（如：拖延、学习、旅行、陪伴、加班、阅读、健身、独处、思念、释然）。
2. emotion: 从候选词中选一个最贴切的主导情绪词（候选词：{emotions_candidates}）。先判断整篇情绪强度，若日记冷静、理性、低唤醒（规划、反思、复盘、陈述事实、流水账、自我要求），优先从低唤醒标签「平静、满足、疲惫、释然」中选；只有情绪明显外显时才选强情绪词。
3. emotion_vector: 8 个基础情绪强度分（各 0-100 整数）。只识别当天主导情绪并分解；冷静低唤醒的日记所有维度给低分(0-30)，只有情绪明显外显才允许高分(70-100)。键严格为：{"、".join(axes)}。

只输出 JSON 对象，不要任何解释、前缀或换行。"""
        prompt = f"日记内容：\n{strip_html_for_llm(diary_content)}\n\n请输出 JSON："
        raw = ""
        try:
            result = self._call_ollama(prompt, system, num_predict=512, temperature=0.1, seed=404)
            raw = result.get("response", "").strip()
        except Exception as e:
            logger.error(f"[合并分析] 调用失败: {e}")
            return dict(default)

        # 解析 JSON 对象
        data = {}
        try:
            text = (raw or "").strip()
            if text.startswith("```"):
                text = text.split("\n", 1)[-1]
                if text.endswith("```"):
                    text = text[:-3]
            start = text.index("{")
            end = text.rindex("}")
            data = json.loads(text[start:end + 1])
        except (ValueError, json.JSONDecodeError, TypeError):
            logger.warning(f"[合并分析] 输出非 JSON，回退默认: {raw[:120]}")
            return dict(default)
        if not isinstance(data, dict):
            return dict(default)

        # summary：限 2-4 字
        summary = str(data.get("summary", "") or "").strip()
        import re as _re
        cleaned = _re.sub(r'[\W_]', '', summary, flags=_re.UNICODE)
        chars = [c for c in cleaned if c.strip()][:4]
        summary = "".join(chars) if chars else "日常"

        # emotion：从候选词中匹配
        emotion = str(data.get("emotion", "") or "").strip()
        valid_emotions = [e.strip() for e in emotions_candidates.split("、")]
        matched = next((e for e in valid_emotions if e in emotion), "")
        emotion = matched or "平静"

        # emotion_vector
        vector_raw = data.get("emotion_vector")
        if isinstance(vector_raw, dict):
            vector = self._parse_emotion_vector(json.dumps(vector_raw, ensure_ascii=False))
        else:
            vector = self._parse_emotion_vector(str(vector_raw or ""))
        vector = vector if vector else {a: 0 for a in axes}

        return {"summary": summary, "emotion": emotion, "emotion_vector": vector}

    def chat_stream(self, user_input: str, user_name: str = "Me", diary_context: str = "", diary_date: str = "", history_text: str = None, mode: str = "empathy", extra_context: str = None, interaction_mode: str = "", enable_web_search: bool = True, search_results: list = None, images: list = None):
        """流式聊天：逐个 yield chunk，前端实时渲染

        mode:
          - "empathy": 共情助手（默认），温暖倾听者
          - "awareness": 觉察助手，引导用户自我觉察
        enable_web_search: 是否启用联网搜索（AI 自主判断是否需要搜索）
        search_results: 外部传入的搜索结果（已存在时跳过联网决策）
        images: 仅工作台对话页传入的图片（裸 base64 list）。传图时走视觉路径，
                并跳过联网搜索（图片+工具搜索组合在本实现中不叠加）。
        """
        # 步骤 A: 检索（与 chat() 相同）
        npc_target = self._detect_npc(user_input)
        vault_data = self.vault.fast_search(npc_target)
        search_context = self._format_vault_context(vault_data, npc_target)
        # 使用 history_text 替代 history_buffer（如果提供了）
        # history_text 是统一格式 JSON 字符串 [{"speaker": "用户", "content": "..."}]
        # 转为可读文本格式，与聊天室保持一致
        if history_text is not None:
            try:
                _hist_list = json.loads(history_text) if isinstance(history_text, str) else history_text
                hot_context = "\n".join(
                    f"{m.get('speaker', '')}: {m.get('content', '')}"
                    for m in _hist_list if m.get('content')
                )
            except (json.JSONDecodeError, TypeError):
                hot_context = str(history_text)
        else:
            hot_context = " | ".join([m["content"] for m in self._load_history_buffer()["messages"][-3:]])

        # 构建基础 prompt（人设、上下文区块由 _build_chat_prompt 统一处理）
        system_prompt, user_prompt = self._build_chat_prompt(
            user_input, diary_context, search_context, hot_context,
            mode, extra_context, interaction_mode
        )

        # 联网搜索：单次流式决策（与 Ollama 原生一致）
        # 直接以「带工具的回答流」开始，模型在同一个流式请求里自行决定
        # 是直接回答还是调用 web_search，不再单独跑一轮非流式判断拖慢首token。
        # 不再使用强制搜索：搜索与否、用哪个关键词，全部交给模型在边输出边搜索时自决，
        # 避免把用户原话（如"再试试"）当作搜索词直接搜索。
        resolved_search = search_results
        want_search_path = (
            enable_web_search and not resolved_search and not self.use_openrouter
            and not images  # 传图时走视觉路径，跳过联网搜索
        )

        # 流式输出（同时累积 AI 回复内容）
        # 觉察助手启用 think 模式（思考+回复共享预算），共情助手 think=False 快速响应
        # 两者输出预算均放开到 8192，允许在需要时把信息讲清楚
        stream_kwargs = {"think": False, "num_predict": 8192}
        if mode == "awareness":
            stream_kwargs = {"think": True, "num_predict": 24576}

        logger.info(f"🔍 流式生成共情回复...")
        print(f"📋 日记上下文: {len(diary_context)} 字符, 长期记忆: {len(search_context)} 字符")

        ai_reply = ""
        ai_thinking = ""
        if want_search_path:
            acc = {"reply": "", "thinking": ""}
            for evt in self._stream_answer_with_search(
                system_prompt, user_prompt, user_input,
                diary_context, search_context, hot_context,
                mode, extra_context, interaction_mode,
                stream_kwargs, acc,
            ):
                yield evt
            ai_reply = acc["reply"]
            ai_thinking = acc["thinking"]
        else:
            for chunk in self._call_ollama_stream(user_prompt, system_prompt, images=images, **stream_kwargs):
                if chunk.get("type") == "response":
                    ai_reply += chunk.get("content", "")
                elif chunk.get("type") == "thinking":
                    ai_thinking += chunk.get("content", "")
                yield chunk

        # 后处理：剥离回复末尾回显的用户原话
        cleaned_reply = self._strip_echoed_input(ai_reply, user_input)
        if cleaned_reply != ai_reply:
            # 发送替换信号，让前端用清理后的内容替换整个回复
            yield {"type": "replace_response", "content": cleaned_reply}
            ai_reply = cleaned_reply

        # 步骤 B: 数据回填（流式完成后）
        uid = self._resolve_user_id()
        hb = self._load_history_buffer(uid)
        hb["messages"].append({"ts": time.time(), "role": "user", "content": user_input})
        if ai_reply:
            hb["messages"].append({"ts": time.time(), "role": "assistant", "content": ai_reply, "thinking": ai_thinking, "diary_date": diary_date})
        
        # 步骤 C: 沉淀判断
        last_cons_ts = hb.get("last_consolidation_ts", 0)
        gap = time.time() - last_cons_ts
        if gap > 10 and len(hb["messages"]) > 1:
            logger.info(f"⏳ [后台] 距上次沉淀已过 {gap:.1f} 秒，触发后台整理...")
            def consolidation_task(uid=uid, hb=hb):
                self._do_consolidation(user_id=uid)
                hb["last_consolidation_ts"] = time.time()
                self._save_history_buffer(uid)
            from server.background import submit_background
            submit_background(consolidation_task)
        
        self._save_history_buffer(uid)

    def _build_chat_prompt(self, user_input, diary_context, search_context, hot_context,
                           mode, extra_context, interaction_mode, search_results=None):
        """构建聊天用的 system_prompt 与 user_prompt（供 chat_stream 与联网决策复用）。"""
        from server.persona_config import get_persona_ego
        from server.model_service import current_user_id
        persona_key = "awareness" if mode == "awareness" else "empathy"
        persona_ego = (get_persona_ego(current_user_id(), persona_key) or "").strip()
        ego_parts = [persona_ego] if persona_ego else []
        if self.default_ego and self.default_ego.strip():
            ego_parts.append(self.default_ego.strip())

        # 人格核心单一来源：按模式取对应核心
        if mode == "awareness":
            system_prompt = build_awareness_system(ego_parts)
        else:
            system_prompt = build_empathy_system(ego_parts)

        context_blocks = []
        # 注入当前时间，避免模型不知道今天日期而给出过时或错误的时效性回答
        context_blocks.append(f"【当前时间】\n{datetime.now().strftime('%Y年%m月%d日 %H:%M')}")
        if extra_context:
            context_blocks.append(f"【额外上下文】\n{extra_context}")
        if interaction_mode:
            context_blocks.append(f"【与该用户的互动模式】\n{interaction_mode}")
        if diary_context:
            context_blocks.append(f"【今日日记】\n{diary_context}")
        if search_results:
            results_text = format_search_results(search_results, max_items=300)
            if results_text:
                context_blocks.append(f"【联网搜索结果】\n{results_text}")
        if search_context:
            context_blocks.append(f"【长期记忆背景】\n{search_context}")
        if hot_context:
            context_blocks.append(f"【近期对话脉络】\n{hot_context}")

        context_section = ""
        if context_blocks:
            context_section = "\n\n" + "\n\n".join(context_blocks)

        user_prompt = f"""{context_section}
用户说：{user_input}

请回复：""".strip()
        return system_prompt, user_prompt

    def _stream_answer_with_search(self, system_prompt, user_prompt, user_input,
                                   diary_context, search_context, hot_context,
                                   mode, extra_context, interaction_mode,
                                   stream_kwargs, acc):
        """单次流式决策 + 回答（与 Ollama 原生一致）。

        直接以「带工具的回答流」开始，模型在同一个流式请求里自行决定是直接回答
        还是调用 web_search，不再单独跑一轮非流式判断。yield 全部事件
        （search_* / response / thinking），acc 为可变 dict，回传累计的 reply/thinking。

        流程（只走单次流，不再强制搜索）：
          - 模型直接输出内容 → 即为回答，单次流完成（无搜索，首token即时）。
          - 模型调用 web_search → 流式展示搜索过程，注入结果后走正常回答流。
        """
        # 单次流式决策：带工具的回答流
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]
        tool_called = False
        for ch in _ms_chat_tools_stream(
            messages, tools=[SEARCH_TOOL_SCHEMA],
            think=stream_kwargs.get("think", False),
            num_predict=stream_kwargs.get("num_predict", 8192),
        ):
            if ch.get("type") == "tool_call" and ch.get("name") == "web_search":
                tool_called = True
                try:
                    args = json.loads(ch.get("arguments") or "{}")
                except (json.JSONDecodeError, TypeError):
                    args = {}
                query = (args.get("query") or user_input).strip()
                results, used_query, tried = self._search_with_retry(query, user_input)
                # 逐条展示搜索过程（首词 + 换词重试）
                for q in tried:
                    yield {"type": "search_query", "content": f"正在联网搜索：{q}", "query": q}
                logger.info(f"🔎 联网搜索: 尝试 {tried}，命中「{used_query}」，共 {len(results)} 条")
                yield {
                    "type": "search_done", "content": f"已找到 {len(results)} 条相关结果",
                    "query": used_query, "count": len(results), "results": results,
                }
                if results:
                    system_prompt, user_prompt = self._build_chat_prompt(
                        user_input, diary_context, search_context, hot_context,
                        mode, extra_context, interaction_mode, search_results=results
                    )
                    logger.info(f"🔎 已注入 {len(results)} 条搜索结果")
                break  # 停止带工具的第一遍，进入正常回答流
            else:
                # 直接输出内容 → 回答（单次流，无搜索，首token即时）
                if ch.get("type") == "response":
                    acc["reply"] += ch.get("content", "")
                elif ch.get("type") == "thinking":
                    acc["thinking"] += ch.get("content", "")
                yield ch

        if tool_called:
            yield from self._yield_answer_stream(system_prompt, user_prompt, stream_kwargs, acc)

    # 去掉时效/冗余修饰词，供换词重试时得到更宽松的查询
    _ALT_STRIP_RE = re.compile(r"(最新消息|最新|最近|近期|今天|今日|本周|本月|今年|当下|目前|现在|当下|热搜|热点|时事|刚刚|突发|到底|究竟|怎么回事)")

    def _search_with_retry(self, query: str, user_input: str, max_attempts: int = 4):
        """联网搜索，并在无结果时自动换词重试。

        返回 (results, 最终命中的查询词, 尝试过的查询词列表)：
          - 先直接搜模型给的查询词；
          - 若 0 条，追加启发式改写 + 模型生成的备用查询词逐条重试；
          - 全部失败则返回 (空列表, 首词, 尝试列表)，不阻断主流程。
        """
        if not query:
            query = (user_input or "").strip()
        candidates = [query]
        candidates += self._build_alt_queries(query, user_input)
        # 去重并过滤空串，保留顺序
        tried = []
        seen = set()
        for q in candidates:
            q = (q or "").strip()
            if q and q not in seen:
                seen.add(q)
                tried.append(q)
        for q in tried[: max_attempts or 1]:
            results = _do_web_search(q)
            if results:
                return results, q, tried[:tried.index(q) + 1]
        return [], tried[0], tried

    def _build_alt_queries(self, query: str, user_input: str) -> list:
        """基于原查询生成多条改写/扩展候选查询词（供无结果时重试）。

        组合两类来源：
          1. 启发式：去掉时效/空泛修饰词，得到更宽松的查询；
          2. 模型生成：让本地模型根据用户意图生成更可能命中的口语化备选词。
        """
        candidates = []
        # 1. 启发式：去掉时效词，让 SearXNG 放宽匹配
        stripped = self._ALT_STRIP_RE.sub("", query).strip()
        if stripped and stripped != query:
            candidates.append(stripped)
        # 2. 模型生成备选查询词（一次性，最多 3 条）
        try:
            prompt = (
                "你是搜索引擎查询词优化器。下面是一次搜不到结果的查询，"
                "请生成 3 个更有可能搜到信息的备选查询词。\n"
                f"用户意图（原话）：{user_input}\n"
                f"原查询词：{query}\n"
                "要求：\n"
                "- 每条独立成行，不要编号、不要引号、不要多余解释\n"
                "- 用更常见、更口语化、更宽泛一点的词替换过于生僻/过于具体的词\n"
                "- 去掉时效性修饰词（如 最新/今天/最近/热点）\n"
                "- 若原查询过于空泛（只有一两个泛动词），补出核心名词\n"
                "- 保持中文，与用户语言一致\n"
            )
            raw = _ms_generate(prompt, num_predict=140, temperature=0.4)
            for line in raw.splitlines():
                line = line.strip().strip("0123456789.、-*\"'「」()（）")
                if line and 2 <= len(line) <= 40 and line not in candidates:
                    candidates.append(line)
        except Exception as e:
            logger.warning(f"⚠️ 生成备用查询词失败: {e}")
        return candidates[:4]

    def _yield_answer_stream(self, system_prompt, user_prompt, stream_kwargs, acc):
        """正常回答流（无工具，带注入的搜索结果），并累计 reply/thinking 到 acc。"""
        for ch in self._call_ollama_stream(user_prompt, system_prompt, **stream_kwargs):
            if ch.get("type") == "response":
                acc["reply"] += ch.get("content", "")
            elif ch.get("type") == "thinking":
                acc["thinking"] += ch.get("content", "")
            yield ch

    def _strip_echoed_input(self, response: str, user_input: str) -> str:
        """剥离回复末尾回显的用户原话
        某些模型（如 uncensored 系列）会在回复末尾用 | 分隔后附上用户原话，
        或直接在末尾重复用户的话。此方法检测并清除这些回显内容。
        """
        if not response or not user_input:
            return response

        cleaned = response.strip()
        user_stripped = user_input.strip()

        # 情况1: 回复以 | 分隔，后面是用户原话
        if '|' in cleaned:
            parts = cleaned.rsplit('|', 1)
            tail = parts[-1].strip()
            # 如果 | 后面的内容与用户输入高度相似（包含或被包含）
            if tail and (tail in user_stripped or user_stripped in tail
                         or self._text_similarity(tail, user_stripped) > 0.7):
                cleaned = parts[0].strip()

        # 情况2: 回复末尾直接包含用户原话（精确匹配尾部）
        if cleaned.endswith(user_stripped):
            cleaned = cleaned[:-len(user_stripped)].strip()

        # 情况3: 回复末尾包含用户原话的变体（忽略标点差异）
        if len(user_stripped) > 5:
            # 去掉末尾标点后比较
            user_core = user_stripped.rstrip('？?！!。.，,~～')
            if user_core and cleaned.endswith(user_core):
                cleaned = cleaned[:-len(user_core)].strip()

        return cleaned

    def _text_similarity(self, text1: str, text2: str) -> float:
        """计算两段文本的相似度（基于字符重叠率）"""
        if not text1 or not text2:
            return 0.0
        set1 = set(text1)
        set2 = set(text2)
        intersection = set1 & set2
        union = set1 | set2
        return len(intersection) / len(union) if union else 0.0

if __name__ == "__main__":
    print("=======================================")
    print(" Atrium OS - 数字化大脑 2.0 (实时反馈+分层档案)")
    print("=======================================")

    # 让用户选择模型
    print("请选择运行模式:")
    print("1. 使用 OpenRouter (远程模型，需要网络)")
    print("2. 使用 Ollama (本地模型，无需网络)")

    choice = input("请输入选项 (1/2): ").strip()
    use_openrouter = choice == "1"

    agent = EmpathyAgent(use_openrouter=use_openrouter)

    # 测试对话
    user_q = "张三是一个很勤奋的人，他在华为工作。"
    print(f"\n🙋‍♂️ 用户: {user_q}")

    reply = agent.chat(user_q)
    print(f"\n🤖 Atrium:\n{reply}\n")

    # 模拟快速查询刚才存入的信息
    print("\n" + "=" * 60)
    print("🔍 测试沙盘功能")
    print("=" * 60)

    npcs = agent.get_npc_list()
    print(f"\n可用的 NPC 列表: {npcs}")

    if npcs:
        npc = npcs[0]
        info = agent.get_npc_info(npc)
        print(f"\n{npc} 的信息: {info}")
    print("(注：数据已写入 core_storage.db，可通过 vault.fast_search 检索)")