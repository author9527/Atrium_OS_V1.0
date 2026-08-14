/**
 * context/InsightContext.tsx — 觉察报告后台生成状态管理（全局单例）
 *
 * 把"生成觉察报告"从觉察页的局部动作提升为全局后台任务：
 *  - 用户在觉察页点击"生成报告"后，生成在后台继续进行，允许用户离开该页
 *  - 同一时间只允许一个生成任务（正在生成时忽略重复请求）
 *  - 生成完成时：
 *      * 用户正在觉察页  → 递增 completionToken，觉察页据此直接进入新报告的卡片列表
 *      * 用户不在觉察页  → 置 notification，底栏觉察图标左上角显示红点
 *  - clearNotification / reportFocus 用于消除红点
 */
import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { runInsightAnalysis, InsightResult } from '../local/insight';

interface InsightContextValue {
  /** 是否正在后台生成觉察报告 */
  generating: boolean;
  /** 底栏觉察图标是否显示红点（报告已在后台生成完成，用户不在觉察页） */
  notification: boolean;
  /** 最近一次成功生成的结果（供觉察页拿到后直接进入卡片列表） */
  lastResult: InsightResult | null;
  /** 觉察页焦点下生成完成时递增，觉察页据此导航到新报告 */
  completionToken: number;
  /** 触发后台生成（幂等：生成中调用会被忽略） */
  startGeneration: () => Promise<void>;
  /** 清除红点 */
  clearNotification: () => void;
  /** 觉察页焦点变化上报：focused=true 时清除红点并记录焦点 */
  reportFocus: (focused: boolean) => void;
  /** 消费一次完成事件（重置 completionToken，避免重进觉察页再次触发导航） */
  resetCompletion: () => void;
}

const InsightContext = createContext<InsightContextValue | null>(null);

export function InsightProvider({ children }: { children: React.ReactNode }) {
  const [generating, setGenerating] = useState(false);
  const [notification, setNotification] = useState(false);
  const [lastResult, setLastResult] = useState<InsightResult | null>(null);
  const [completionToken, setCompletionToken] = useState(0);
  const focusedRef = useRef(false);
  const runningRef = useRef(false);

  const startGeneration = useCallback(async () => {
    // 生成过程中不响应新发起的生成请求
    if (runningRef.current) return;
    runningRef.current = true;
    setGenerating(true);
    try {
      const result = await runInsightAnalysis();
      if (result && result.id) {
        setLastResult(result);
        if (focusedRef.current) {
          // 用户正在觉察页：直接进入该报告的分点卡片展示页面
          setCompletionToken((t) => t + 1);
        } else {
          // 用户不在觉察页：底栏觉察图标左上角产生红点
          setNotification(true);
        }
      } else {
        // 生成失败（日记不足等）：给出明确提示
        const msg = (result as unknown as { analysis?: string })?.analysis || '当前可用日记不足，无法生成觉察报告';
        Alert.alert('无法生成', msg);
      }
    } catch (e: any) {
      Alert.alert('生成觉察报告失败', e?.message || '请稍后重试');
    } finally {
      runningRef.current = false;
      setGenerating(false);
    }
  }, []);

  const clearNotification = useCallback(() => setNotification(false), []);

  const reportFocus = useCallback((focused: boolean) => {
    focusedRef.current = focused;
    // 只要用户回到觉察页，就清除红点
    if (focused) setNotification(false);
  }, []);

  const resetCompletion = useCallback(() => setCompletionToken(0), []);

  return (
    <InsightContext.Provider
      value={{
        generating,
        notification,
        lastResult,
        completionToken,
        startGeneration,
        clearNotification,
        reportFocus,
        resetCompletion,
      }}
    >
      {children}
    </InsightContext.Provider>
  );
}

export function useInsightContext(): InsightContextValue {
  const ctx = useContext(InsightContext);
  if (!ctx) throw new Error('useInsightContext must be used within InsightProvider');
  return ctx;
}