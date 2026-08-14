/**
 * model.ts — 手机端模型服务抽象接口（接口定义）
 *
 * 对应 Python 版 EmpathyAgent._call_ollama / _call_openrouter 的调用约定。
 * Phase 4 的 modelService 将实现本接口（本地 Ollama 直连 + 远程 OpenAI 兼容 + 流式状态机）。
 * 分析管线（emotion/consolidation）只依赖此抽象，保持逻辑纯净可测。
 */

/** 单次非流式模型调用的返回（对应 Python _call_ollama 的 dict 结构）。 */
export interface ModelResult {
  response: string;
  thinking?: string;
}

/** 模型调用参数（对应 Python _call_ollama 的具名参数）。 */
export interface ModelCallOptions {
  /** 强制 JSON 输出模式 */
  jsonMode?: boolean;
  /** JSON Schema 对象，用于约束解码（Structured Outputs） */
  jsonSchema?: Record<string, unknown>;
  /** 指定模型名（覆盖用户默认设置） */
  model?: string | null;
  /** 最大生成长度 */
  numPredict?: number | null;
  /** 采样温度 */
  temperature?: number | null;
  /** 随机种子（保证可复现） */
  seed?: number | null;
  /** 附带图片（裸 base64 列表） */
  images?: string[];
}

/** 模型服务抽象：分析管线通过它发起调用。 */
export interface ModelClient {
  /** 非流式调用：等待完整结果返回。 */
  call(prompt: string, system: string, options?: ModelCallOptions): Promise<ModelResult>;

  /** 当前是否使用远程（OpenRouter/OpenAI 兼容）通道。 */
  useOpenrouter(): boolean;
}

/** 默认实现占位：未注入 ModelClient 时抛出，提示 Phase 4 注入。 */
export const NO_OP_MODEL: ModelClient = {
  async call(): Promise<ModelResult> {
    throw new Error('模型服务未初始化：请先注入 ModelClient（Phase 4 modelService）');
  },
  useOpenrouter(): boolean {
    return false;
  },
};