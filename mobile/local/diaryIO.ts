/**
 * local/diaryIO.ts — 手机端本地日记导入/导出服务（Phase 5）
 *
 * 与 api/diaryIO.ts 保持相同函数签名与返回结构，
 * 内部改用 core/utils/diaryIO.ts 的转换器 + core/db/diaryDb.ts 本地写库。
 * 纯写库，不触发任何分析管线（与后端一致）。
 */

import { getDiaryStorage } from '../core/db/diaryDb';
import {
  SUPPORTED_FORMATS,
  formatLabel,
  exportExtension,
  importToCanonical,
  exportAtrium,
} from '../core/utils/diaryIO';
import type { ImportEntry } from '../utils/importDraft';

export interface IoFormat {
  id: string;
  label: string;
  ext: string;
}

export interface ParseResult {
  success: boolean;
  format?: string;
  entries?: ImportEntry[];
  error?: { code: string; message: string };
}

export interface ImportResult {
  success: boolean;
  format?: string;
  imported?: number;
  updated?: number;
  skipped?: number;
  error?: { code: string; message: string };
}

const USER_ID = 'default';

/** 列出支持的导入/导出格式 */
export function getIoFormats(): IoFormat[] {
  return SUPPORTED_FORMATS.map((id) => ({
    id,
    label: formatLabel(id),
    ext: exportExtension(id),
  }));
}

/** 解析导入内容为 canonical 条目（绝不写库），供草稿合并 */
export function parseImport(
  text: string,
  sourceFormat?: string | null,
  filename?: string,
): ParseResult {
  try {
    const { entries, detectedFormat } = importToCanonical(text, sourceFormat ?? null, filename || '');
    const now = new Date().toISOString();
    // 转成草稿格式 ImportEntry（补齐 created_at/updated_at）
    const importEntries: ImportEntry[] = entries.map((e) => ({
      date: e.date,
      content: e.content || '',
      weather: e.weather || '晴',
      tags: e.tags || [],
      created_at: e.created_at || now,
      updated_at: e.updated_at || now,
    }));
    return {
      success: true,
      format: detectedFormat,
      entries: importEntries,
    };
  } catch (e: any) {
    return {
      success: false,
      error: { code: 'PARSE_ERROR', message: e?.message || '解析失败' },
    };
  }
}

/** 批量导入日记（纯写库，不触发分析管线） */
export function importDiaries(
  text: string,
  sourceFormat: string,
  overwrite = true,
): ImportResult {
  try {
    const { entries } = importToCanonical(text, sourceFormat, '');
    const storage = getDiaryStorage();
    const result = storage.batchImportDiaries(entries as unknown as Array<Record<string, unknown>>, USER_ID, overwrite);
    return {
      success: true,
      format: sourceFormat,
      imported: result.imported,
      updated: result.updated,
      skipped: result.skipped,
    };
  } catch (e: any) {
    return {
      success: false,
      error: { code: 'IMPORT_ERROR', message: e?.message || '导入失败' },
    };
  }
}

/** 导出为 atrium 规范 JSON（纯函数，返回字符串） */
export function exportDiariesJson(): string {
  const storage = getDiaryStorage();
  const diaries = storage.getAllDiaries(USER_ID);
  const entries = diaries.map((d) => ({
    date: d.date,
    content: d.content,
    weather: d.weather,
    tags: d.tags,
    created_at: d.created_at,
    updated_at: d.updated_at,
  }));
  return exportAtrium(entries);
}