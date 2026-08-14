// ==========================================
// 手机端导入页 — 历史日记导入（草稿 JSON 生成器）
//
// 借鉴手机端主页/工作台设计：
//   - 上半部分：日历（复用 ImportCalendar，去掉情绪/摘要/档案/AI 人设），
//     点击日期格子 → 下方编辑器粘贴当天日记，改动实时写入草稿 JSON（不保存、不总结）。
//   - 前/后一天按钮：快速切换日期。
//   - 下半部分：快捷导入入口，从各日记软件导出的文件解析后合并进同一份草稿。
//   - 底部「导入完成」：把整份草稿以 canonical JSON 提交给后端，纯写库、不触发分析。
// 一切操作实时落盘到 AsyncStorage 草稿，防止半途退出丢数据。
// ==========================================

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  Alert, ActivityIndicator, TextInput, Modal, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import ImportCalendar from '../../components/ImportCalendar';
import RichTextEditor from '../../components/RichTextEditor';
import {
  emptyDraft, loadDraft, persistDraft, clearDraft, draftCount,
} from '../../utils/importDraft';
import { getIoFormats, parseImport, importDiaries, IoFormat } from '../../local/diaryIO';
import { isFullBackupPackage, importFullBackup } from '../../local/backup';
import { backfillDiaryAnalysis } from '../../local/diary';
import { formatDateStr } from '../../utils/date';

const PRIMARY = '#2FBF9F';
const TEXT = '#1F2937';
const BG = '#F5F7F6';

// 各格式的展示名（用于「从 xxx 导入」按钮）
const FORMAT_NAME: Record<string, string> = {
  atrium: 'Atrium',
  dayone: 'Day One',
  csv: 'CSV',
  markdown: 'Markdown',
  text: '纯文本',
};

const shiftDateStr = (dateStr: string, offset: number): string => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + offset);
  return formatDateStr(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
};

export default function ImportScreen() {
  const router = useRouter();

  const handleBack = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(main)/settings');
    }
  };

  const today = new Date();
  const todayStr = formatDateStr(today.getFullYear(), today.getMonth() + 1, today.getDate());

  // ---- 草稿与编辑状态 ----
  const [draft, setDraft] = useState<any>(null);
  const [selectedDateStr, setSelectedDateStr] = useState(todayStr);
  const [editorContent, setEditorContent] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);

  // ---- 快捷导入 / 提交状态 ----
  const [ioFormats, setIoFormats] = useState<IoFormat[]>([]);
  const [parseMsg, setParseMsg] = useState('');
  const [parsing, setParsing] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteModal, setPasteModal] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [backfill, setBackfill] = useState<{ active: boolean; total: number; done: number } | null>(null);
  // 全量备份恢复状态
  const [showBackupModal, setShowBackupModal] = useState(false);
  const [backupPwd, setBackupPwd] = useState('');
  const [backupUri, setBackupUri] = useState('');
  const [backupImportMsg, setBackupImportMsg] = useState('');
  const [importingBackup, setImportingBackup] = useState(false);

  const draftRef = useRef<any>(emptyDraft());
  const flashTimerRef = useRef<any>(null);

  // ---- 初始化：加载草稿 + 格式列表 ----
  useEffect(() => {
    (async () => {
      const d = await loadDraft();
      draftRef.current = d;
      setDraft(d);
      const entry = d.entries?.[todayStr];
      setEditorContent(entry?.content || '');
    })();
    setIoFormats(getIoFormats());
  }, []);

  // draft 变化时同步 ref，方便回调读取最新值
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const flashSaved = useCallback(() => {
    setSavedFlash(true);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setSavedFlash(false), 1500);
  }, []);

  // ---- 选择日期：切换编辑器内容 ----
  const selectDate = useCallback((dateStr: string) => {
    setSelectedDateStr(dateStr);
    const entry = draftRef.current?.entries?.[dateStr];
    setEditorContent(entry?.content || '');
  }, []);

  // ---- 编辑器改动：实时写入草稿并持久化 ----
  const handleEditorChange = useCallback((content: string) => {
    setEditorContent(content);
    const d = draftRef.current || emptyDraft();
    const entries = { ...d.entries };
    const sel = selectedDateStr;
    const isEmpty = !content || content === '<p></p>' || content.trim() === '';
    if (isEmpty) {
      delete entries[sel];
    } else {
      const now = new Date().toISOString();
      const existing = entries[sel];
      entries[sel] = {
        date: sel,
        content,
        weather: existing?.weather || '晴',
        tags: existing?.tags || [],
        created_at: existing?.created_at || now,
        updated_at: now,
      };
    }
    const next = { ...d, entries };
    setDraft(next);
    draftRef.current = next;
    persistDraft(next);
    flashSaved();
  }, [selectedDateStr, flashSaved]);

  // ---- 日期切换按钮（前/后一天）----
  const shiftDay = useCallback((offset: number) => {
    selectDate(shiftDateStr(selectedDateStr, offset));
  }, [selectedDateStr, selectDate]);

  // ---- 合并解析结果进草稿 ----
  const mergeEntries = useCallback((entries: any[] | undefined) => {
    const d = draftRef.current || emptyDraft();
    const cur = { ...d.entries };
    let added = 0, updated = 0;
    for (const e of entries || []) {
      if (!e || !e.date) continue;
      cur[e.date] = { ...e };
      if (e.date in d.entries) { updated++; } else { added++; }
    }
    const next = { ...d, entries: cur };
    setDraft(next);
    draftRef.current = next;
    persistDraft(next);
    return { added, updated };
  }, []);

  // ---- 快捷导入：从软件文件导入 ----
  const handleSoftwareFile = async (fmt: IoFormat) => {
    try {
      const pick = await DocumentPicker.getDocumentAsync({
        type: fmt.id === 'atrium' ? 'application/json' : '*/*',
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (pick.canceled || !pick.assets?.length) return;
      const asset = pick.assets[0];
      const response = await fetch(asset.uri);
      const text = await response.text();

      // 若为全量备份包（.abk），走「密码 + 强确认」恢复流程
      if (isFullBackupPackage(text)) {
        setBackupUri(asset.uri);
        setBackupPwd('');
        setBackupImportMsg('');
        setShowBackupModal(true);
        return;
      }

      setParsing(true);
      setParseMsg('');
      try {
        const res = await parseImport(text, fmt.id, asset.name);
        if (res.success) {
          const { added, updated } = mergeEntries(res.entries);
          setParseMsg(`已解析 ${res.entries?.length} 篇（${FORMAT_NAME[fmt.id] || fmt.label}）：新增 ${added} 篇、覆盖 ${updated} 篇`);
        } else {
          setParseMsg(`解析失败：${res.error?.message || '未知错误'}`);
        }
      } catch (err: any) {
        setParseMsg(`解析失败：${err.message || err}`);
      }
      setParsing(false);
    } catch (err: any) {
      Alert.alert('选择文件失败', err.message || String(err));
    }
  };

  // ---- 粘贴文本解析 ----
  const handlePasteParse = async () => {
    if (!pasteText || !pasteText.trim()) { setParseMsg('请先粘贴要导入的内容'); return; }
    setParsing(true);
    setParseMsg('');
    try {
      const res = await parseImport(pasteText, null, '');
      if (res.success) {
        const { added, updated } = mergeEntries(res.entries);
        setParseMsg(`已解析 ${res.entries?.length} 篇（${res.format}）：新增 ${added} 篇、覆盖 ${updated} 篇`);
        setPasteText('');
        setPasteModal(false);
      } else {
        setParseMsg(`解析失败：${res.error?.message || '未知错误'}`);
      }
    } catch (err: any) {
      setParseMsg(`解析失败：${err.message || err}`);
    }
    setParsing(false);
  };

  // ---- 恢复全量备份：输入密码 + 强确认后替换全部数据 ----
  const handleImportBackup = async () => {
    if (importingBackup) return;
    if (!backupUri) { setBackupImportMsg('未找到备份文件'); return; }
    if (!backupPwd) { setBackupImportMsg('请输入备份密码'); return; }
    setImportingBackup(true);
    setBackupImportMsg('');
    try {
      const result = await importFullBackup(backupUri, backupPwd);
      if (result.success) {
        setShowBackupModal(false);
        setBackupUri('');
        setBackupPwd('');
        Alert.alert('恢复成功', result.message);
      } else {
        setBackupImportMsg(result.message);
      }
    } catch (err: any) {
      setBackupImportMsg(err?.message || '恢复失败');
    } finally {
      setImportingBackup(false);
    }
  };

  // ---- 导入完成：提交草稿到后端并退出 ----
  const handleCommit = async () => {
    const d = draftRef.current || emptyDraft();
    const entries = d.entries ? Object.values(d.entries) : [];
    if (!entries.length) { setCommitMsg('草稿为空，请先在日历中选择日期粘贴日记，或从日记软件导入'); return; }
    setCommitting(true);
    setCommitMsg('');
    try {
      const text = JSON.stringify({ format: 'atrium-diary', version: '1.0', entries });
      const res = await importDiaries(text, 'atrium', true);
      if (res.success) {
        await clearDraft();
        setDraft(emptyDraft());
        draftRef.current = emptyDraft();
        setCommitMsg(`导入完成：新增 ${res.imported} 条、覆盖 ${res.updated} 条、跳过 ${res.skipped} 条`);

        // 后台补齐历史日记的情绪/摘要（幂等，逐篇一次 AI 调用），实时显示进度。
        // 用户可随时返回，补全继续在后台进行，日历轮询会逐步渲染结果。
        setBackfill({ active: true, total: 0, done: 0 });
        backfillDiaryAnalysis((p) => {
          setBackfill({ active: true, total: p.total, done: p.done });
        })
          .then((r) => {
            setBackfill({ active: false, total: r.total, done: r.analyzed });
          })
          .catch(() => {
            setBackfill({ active: false, total: 0, done: 0 });
          });
      } else {
        setCommitMsg(`导入失败：${res.error?.message || '未知错误'}`);
      }
    } catch (err: any) {
      setCommitMsg(`导入失败：${err.message || err}`);
    }
    setCommitting(false);
  };

  const handleClearDraft = async () => {
    if (!draftCount(draftRef.current)) return;
    Alert.alert('清空草稿', '确定清空当前所有草稿吗？此操作不可撤销。', [
      { text: '取消', style: 'cancel' },
      {
        text: '清空', style: 'destructive',
        onPress: async () => {
          await clearDraft();
          setDraft(emptyDraft());
          draftRef.current = emptyDraft();
          setEditorContent('');
          setParseMsg('');
          setCommitMsg('');
        },
      },
    ]);
  };

  const count = draftCount(draft);

  if (!draft) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={[styles.center, { flex: 1 }]}>
          <ActivityIndicator size="large" color={PRIMARY} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* 顶部栏 */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <TouchableOpacity onPress={handleBack} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color="#4f46e5" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>导入历史日记</Text>
        </View>
        <View style={styles.headerRight}>
          <Text style={[styles.savedBadge, savedFlash && styles.savedBadgeFlash]}>
            {savedFlash ? '草稿已保存' : `已收录 ${count} 篇`}
          </Text>
          <TouchableOpacity onPress={handleClearDraft} style={styles.clearBtn}>
            <Ionicons name="trash-outline" size={16} color="#EF4444" />
          </TouchableOpacity>
        </View>
      </View>

      <KeyboardAvoidingView
        style={styles.flex1}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* 日历 */}
          <ImportCalendar
            draft={draft}
            selectedDateStr={selectedDateStr}
            onDateSelect={selectDate}
          />

          {/* 前/后一天 */}
          <View style={styles.dayNav}>
            <TouchableOpacity style={styles.dayNavBtn} onPress={() => shiftDay(-1)} activeOpacity={0.7}>
              <Ionicons name="chevron-back" size={16} color="#6B7280" />
              <Text style={styles.dayNavText}>前一天</Text>
            </TouchableOpacity>
            <Text style={styles.dayNavCenter}>{selectedDateStr.replace(/-/g, ' / ')}</Text>
            <TouchableOpacity style={styles.dayNavBtn} onPress={() => shiftDay(1)} activeOpacity={0.7}>
              <Text style={styles.dayNavText}>后一天</Text>
              <Ionicons name="chevron-forward" size={16} color="#6B7280" />
            </TouchableOpacity>
          </View>

          {/* 编辑器 */}
          <View style={styles.editorCard}>
            <View style={styles.editorHeader}>
              <Text style={styles.editorTitle}>{selectedDateStr} 的日记</Text>
              <Text style={styles.editorHint}>改动即时写入草稿</Text>
            </View>
            <View style={styles.editorBox}>
              <RichTextEditor
                key={selectedDateStr}
                initialContent={editorContent}
                onChange={handleEditorChange}
              />
            </View>
          </View>

          {/* 快捷导入 */}
          <View style={styles.quickCard}>
            <View style={styles.quickHeader}>
              <Text style={styles.quickTitle}>快捷导入</Text>
              {parseMsg ? <Text style={styles.parseMsg}>{parseMsg}</Text> : null}
            </View>
            <Text style={styles.quickHint}>从日记软件导出的文件合并进同一份草稿</Text>

            <View style={styles.formatGrid}>
              {ioFormats.map((fmt) => (
                <TouchableOpacity
                  key={fmt.id}
                  style={styles.formatBtn}
                  onPress={() => handleSoftwareFile(fmt)}
                  disabled={parsing}
                  activeOpacity={0.7}
                >
                  <Ionicons name="cloud-upload-outline" size={16} color={parsing ? '#9CA3AF' : PRIMARY} />
                  <Text style={[styles.formatBtnText, parsing && styles.disabledText]}>
                    从 {FORMAT_NAME[fmt.id] || fmt.label} 导入
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <TouchableOpacity
              style={styles.pasteBtn}
              onPress={() => setPasteModal(true)}
              disabled={parsing}
              activeOpacity={0.7}
            >
              <Ionicons name="clipboard-outline" size={16} color="#fff" />
              <Text style={styles.pasteBtnText}>粘贴文本导入</Text>
            </TouchableOpacity>
          </View>

          {/* 导入完成 */}
          <View style={styles.commitRow}>
            <Text style={styles.commitHint}>导入完成后会自动生成历史日记的情绪与摘要，可放心提交</Text>
            {commitMsg ? <Text style={styles.commitMsg}>{commitMsg}</Text> : null}
            {backfill?.active ? (
              <View style={styles.backfillCard}>
                <View style={styles.backfillHeader}>
                  <ActivityIndicator size="small" color={PRIMARY} />
                  <Text style={styles.backfillText}>
                    正在生成情绪与摘要 {backfill.done}/{backfill.total || '…'}
                  </Text>
                </View>
                <Text style={styles.backfillTip}>可随时返回，补全在后台继续，日历会逐步显示结果</Text>
              </View>
            ) : backfill && !backfill.active ? (
              <View style={styles.backfillCard}>
                <Ionicons name="checkmark-circle" size={16} color={PRIMARY} />
                <Text style={styles.backfillText}>
                  已生成 {backfill.done} 篇情绪与摘要
                </Text>
              </View>
            ) : null}
            <TouchableOpacity
              style={[styles.commitBtn, committing && styles.commitBtnDisabled]}
              onPress={handleCommit}
              disabled={committing}
              activeOpacity={0.7}
            >
              {committing ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Ionicons name="checkmark-circle" size={18} color="#fff" />
              )}
              <Text style={styles.commitBtnText}>{committing ? '导入中...' : '导入完成'}</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* 粘贴文本弹窗 */}
      <Modal visible={pasteModal} transparent animationType="fade" onRequestClose={() => setPasteModal(false)}>
        <TouchableOpacity style={styles.pickerOverlay} activeOpacity={1} onPress={() => setPasteModal(false)}>
          <View style={styles.pasteModalCard} onStartShouldSetResponder={() => true}>
            <Text style={styles.pasteModalTitle}>粘贴要导入的内容</Text>
            <Text style={styles.pasteModalSub}>支持 Day One JSON / CSV / Markdown / 纯文本，自动识别格式</Text>
            <TextInput
              style={styles.pasteInput}
              value={pasteText}
              onChangeText={setPasteText}
              placeholder="在此粘贴日记内容..."
              placeholderTextColor="#cbd5e1"
              multiline
              textAlignVertical="top"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={styles.pasteModalActions}>
              <TouchableOpacity
                style={[styles.pasteModalBtn, styles.pasteModalCancel]}
                onPress={() => setPasteModal(false)}
                activeOpacity={0.7}
              >
                <Text style={styles.pasteModalCancelText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.pasteModalBtn, styles.pasteModalConfirm]}
                onPress={handlePasteParse}
                disabled={parsing}
                activeOpacity={0.7}
              >
                {parsing ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.pasteModalConfirmText}>解析并加入草稿</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* 全量备份恢复弹窗 */}
      <Modal visible={showBackupModal} transparent animationType="fade" onRequestClose={() => setShowBackupModal(false)}>
        <TouchableOpacity style={styles.pickerOverlay} activeOpacity={1} onPress={() => setShowBackupModal(false)}>
          <View style={styles.pasteModalCard} onStartShouldSetResponder={() => true}>
            <Text style={styles.pasteModalTitle}>恢复全量备份</Text>
            <Text style={styles.backupWarn}>
              将以备份中的全部数据替换当前设备上的数据（日记、对话、人际关系档案、AI 人设、设置），覆盖后不可撤销。
            </Text>
            <Text style={styles.backupPwdHint}>
              请输入导出该备份时设定的密码。此密码仅适用于该备份文件，且不可找回，软件不会保存，仅用于解锁此备份文件。
            </Text>
            <TextInput
              style={styles.backupPwdInput}
              value={backupPwd}
              onChangeText={setBackupPwd}
              placeholder="输入备份密码"
              placeholderTextColor="#cbd5e1"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
            {backupImportMsg ? <Text style={styles.backupImportMsg}>{backupImportMsg}</Text> : null}
            <View style={styles.pasteModalActions}>
              <TouchableOpacity
                style={[styles.pasteModalBtn, styles.pasteModalCancel]}
                onPress={() => setShowBackupModal(false)}
                activeOpacity={0.7}
              >
                <Text style={styles.pasteModalCancelText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.pasteModalBtn, styles.backupConfirmBtn]}
                onPress={handleImportBackup}
                disabled={importingBackup}
                activeOpacity={0.7}
              >
                {importingBackup ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.pasteModalConfirmText}>恢复</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  flex1: { flex: 1 },
  center: { justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center' },
  backBtn: { padding: 4, marginRight: 8 },
  headerTitle: { fontSize: 18, fontWeight: '700', color: TEXT },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  savedBadge: {
    fontSize: 12,
    color: '#9CA3AF',
    backgroundColor: '#F2F5F4',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    overflow: 'hidden',
  },
  savedBadgeFlash: { color: PRIMARY, backgroundColor: '#E6F7F1' },
  clearBtn: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: '#FDEDED', alignItems: 'center', justifyContent: 'center',
  },
  scroll: { flex: 1 },
  scrollContent: { paddingVertical: 16, paddingBottom: 40 },
  dayNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: 16,
    marginTop: 12,
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  dayNavBtn: { flexDirection: 'row', alignItems: 'center', padding: 6 },
  dayNavText: { fontSize: 14, color: '#6B7280', fontWeight: '600' },
  dayNavCenter: { fontSize: 14, fontWeight: '700', color: TEXT },
  editorCard: {
    marginHorizontal: 16,
    marginTop: 12,
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 16,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 16,
    elevation: 2,
  },
  editorHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  editorTitle: { fontSize: 15, fontWeight: '700', color: TEXT },
  editorHint: { fontSize: 12, color: '#9CA3AF' },
  editorBox: {
    height: 240,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#E7ECEA',
    backgroundColor: '#fff',
  },
  quickCard: {
    marginHorizontal: 16,
    marginTop: 12,
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 16,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 16,
    elevation: 2,
  },
  quickHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  quickTitle: { fontSize: 15, fontWeight: '700', color: TEXT },
  parseMsg: { fontSize: 12, color: '#6B7280', flex: 1, textAlign: 'right', marginLeft: 8 },
  quickHint: { fontSize: 12, color: '#9CA3AF', marginTop: 4, marginBottom: 12 },
  formatGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  formatBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E7ECEA',
    backgroundColor: '#F7F9F8',
  },
  formatBtnText: { fontSize: 13, color: '#334155', fontWeight: '600' },
  disabledText: { color: '#9CA3AF' },
  pasteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 12,
    paddingVertical: 11,
    borderRadius: 12,
    backgroundColor: PRIMARY,
  },
  pasteBtnText: { fontSize: 14, color: '#fff', fontWeight: '600' },
  commitRow: {
    marginHorizontal: 16,
    marginTop: 12,
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 16,
    alignItems: 'center',
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 16,
    elevation: 2,
  },
  commitHint: { fontSize: 12, color: '#9CA3AF', textAlign: 'center', marginBottom: 8 },
  commitMsg: { fontSize: 12, color: PRIMARY, textAlign: 'center', marginBottom: 8 },
  backfillCard: {
    backgroundColor: '#E6F7F1',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 10,
    width: '100%',
  },
  backfillHeader: { flexDirection: 'row', alignItems: 'center' },
  backfillText: { fontSize: 13, color: PRIMARY, fontWeight: '600', marginLeft: 8 },
  backfillTip: { fontSize: 11, color: '#6B7280', marginTop: 2 },
  commitBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    width: '100%',
    paddingVertical: 13,
    borderRadius: 22,
    backgroundColor: PRIMARY,
  },
  commitBtnDisabled: { opacity: 0.6 },
  commitBtnText: { fontSize: 15, color: '#fff', fontWeight: '700' },
  // 粘贴弹窗
  pickerOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center', alignItems: 'center',
  },
  pasteModalCard: {
    width: '86%', backgroundColor: '#fff',
    borderRadius: 20, padding: 20,
  },
  pasteModalTitle: { fontSize: 17, fontWeight: '700', color: TEXT, textAlign: 'center' },
  pasteModalSub: { fontSize: 12, color: '#9CA3AF', textAlign: 'center', marginTop: 6, marginBottom: 14 },
  pasteInput: {
    backgroundColor: '#F7F9F8',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E7ECEA',
    padding: 12,
    minHeight: 140,
    fontSize: 14,
    color: '#334155',
    textAlignVertical: 'top',
  },
  pasteModalActions: { flexDirection: 'row', gap: 8, marginTop: 14 },
  pasteModalBtn: {
    flex: 1, paddingVertical: 11, borderRadius: 12, alignItems: 'center',
  },
  pasteModalCancel: { backgroundColor: '#F2F5F4' },
  pasteModalConfirm: { backgroundColor: PRIMARY },
  pasteModalCancelText: { fontSize: 14, color: '#6B7280', fontWeight: '600' },
  pasteModalConfirmText: { fontSize: 14, color: '#fff', fontWeight: '600' },
  // 全量备份恢复弹窗
  backupWarn: {
    fontSize: 12,
    color: '#b91c1c',
    backgroundColor: '#FEE2E2',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 10,
    lineHeight: 18,
  },
  backupPwdHint: {
    fontSize: 12,
    color: '#9CA3AF',
    marginBottom: 10,
    lineHeight: 17,
  },
  backupPwdInput: {
    backgroundColor: '#F7F9F8',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E7ECEA',
    padding: 12,
    fontSize: 14,
    color: '#334155',
  },
  backupImportMsg: {
    fontSize: 12,
    color: '#b91c1c',
    marginTop: 8,
    textAlign: 'center',
  },
  backupConfirmBtn: {
    backgroundColor: '#b91c1c',
  },
});