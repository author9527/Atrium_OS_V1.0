import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, Alert, ActivityIndicator, Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { getSettings, updateSettings, getLocalModels, testModelConnection, testWebSearchConnection, exportDiaries } from '../../local/settings';
import { exportFullBackup } from '../../local/backup';
import BottomTabBar from '../../components/BottomTabBar';
import { useRouter } from 'expo-router';

const PRIMARY = '#2FBF9F';
const TEXT = '#1F2937';
const TEXT_SUB = '#8A94A6';
const BG = '#F5F7F6';

interface OllamaModel {
  name: string;
  size: number;
  family: string;
}

export default function SettingsScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [modelPriority, setModelPriority] = useState('local');
  const [mainModel, setMainModel] = useState('');
  const [lightModel, setLightModel] = useState('');
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState('http://127.0.0.1:11434');
  const [searxngBaseUrl, setSearxngBaseUrl] = useState('');
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [apiModel, setApiModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [egoTemplate, setEgoTemplate] = useState('default');
  // 模型选择弹窗状态
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [pickingFor, setPickingFor] = useState<'main' | 'light'>('main');
  // 连接测试状态
  const [testing, setTesting] = useState(false);
  // 导出日记状态
  const [exporting, setExporting] = useState(false);
  // 全量备份状态
  const [showBackupModal, setShowBackupModal] = useState(false);
  const [backupPwd, setBackupPwd] = useState('');
  const [backupPwdConfirm, setBackupPwdConfirm] = useState('');
  const [exportingBackup, setExportingBackup] = useState(false);

  useEffect(() => {
    loadRemoteSettings();
  }, []);

  const loadRemoteSettings = async () => {
    try {
      const settings = await getSettings();
      setModelPriority(settings.model_priority || 'local');
      setMainModel(settings.local_model || '');
      setLightModel(settings.lightweight_model || '');
      setOllamaBaseUrl(settings.ollama_base_url || 'http://127.0.0.1:11434');
      setSearxngBaseUrl(settings.searxng_base_url || '');
      setApiModel(settings.openrouter_model || '');
      setApiKey(settings.openrouter_api_key || '');
      setEgoTemplate(settings.ego_template || 'default');
    } catch (e) {
      console.error('加载远程设置失败:', e);
    } finally {
      setLoading(false);
    }
  };

  const loadOllamaModels = async () => {
    setModelsLoading(true);
    try {
      const result = await getLocalModels();
      if (result.available) {
        setOllamaModels(result.models || []);
      } else {
        Alert.alert('提示', result.error || '无法获取模型列表，请确认 Ollama 已启动');
      }
    } catch (e: any) {
      Alert.alert('错误', e.message || '获取模型列表失败');
    } finally {
      setModelsLoading(false);
    }
  };

  // 切换到本地模式时自动加载模型列表（本地模式下挂载即调用）
  useEffect(() => {
    if (modelPriority === 'local' && !loading && ollamaModels.length === 0) {
      loadOllamaModels();
    }
  }, [modelPriority, loading]);

  const handleSaveModelSettings = async () => {
    try {
      const payload: Record<string, string> = {
        model_priority: modelPriority,
        ego_template: egoTemplate,
      };
      if (modelPriority === 'local') {
        if (!mainModel) {
          Alert.alert('提示', '请选择一个主模型');
          return;
        }
        const trimmedUrl = ollamaBaseUrl.trim().replace(/\/$/, '');
        if (!trimmedUrl) {
          Alert.alert('提示', '请输入 Ollama 地址');
          return;
        }
        payload.ollama_base_url = trimmedUrl;
        payload.local_model = mainModel;
        if (lightModel) {
          payload.lightweight_model = lightModel;
        }
        const trimmedSearxng = searxngBaseUrl.trim();
        if (trimmedSearxng) {
          payload.searxng_base_url = trimmedSearxng;
        }
      } else {
        if (!apiModel.trim()) {
          Alert.alert('提示', '请输入远程模型名称');
          return;
        }
        if (!apiKey.trim()) {
          Alert.alert('提示', '请输入 API Key');
          return;
        }
        payload.openrouter_model = apiModel.trim();
        payload.openrouter_api_key = apiKey.trim();
      }
      await updateSettings(payload);
      Alert.alert('已保存', '模型设置已更新');
    } catch (e: any) {
      Alert.alert('保存失败', e.message || '未知错误');
    }
  };

  // 连接测试：分别测试 Ollama 与 SearXNG 搜索服务，各自独立保存
  //  - Ollama 正常 → 保存 Ollama 地址 + 模型
  //  - SearXNG 正常 → 保存搜索服务地址
  //  - 两者互不依赖，各自成功各自保存
  const handleTestConnection = async () => {
    if (testing) return;
    setTesting(true);
    try {
      const parts: string[] = [];

      // 1. 测试并保存 Ollama（本地模式）
      if (modelPriority === 'local') {
        const ollamaResult = await testModelConnection({
          modelPriority,
          ollamaBaseUrl,
          mainModel,
          apiModel,
          apiKey,
        });
        if (ollamaResult.success) {
          const trimmedUrl = ollamaBaseUrl.trim();
          if (trimmedUrl) {
            try {
              await updateSettings({
                model_priority: 'local',
                ollama_base_url: trimmedUrl,
                local_model: mainModel,
                lightweight_model: lightModel,
              });
              parts.push('Ollama 地址已保存');
            } catch {
              parts.push('Ollama 连通用，但保存失败');
            }
          }
        } else {
          parts.push(`Ollama：${ollamaResult.message}`);
        }
      }

      // 2. 测试并保存 SearXNG 搜索服务（本地模式）
      if (modelPriority === 'local') {
        if (searxngBaseUrl.trim()) {
          const searchResult = await testWebSearchConnection(searxngBaseUrl);
          if (searchResult.success) {
            try {
              await updateSettings({ searxng_base_url: searxngBaseUrl.trim() });
              parts.push('搜索服务地址已保存');
            } catch {
              parts.push('搜索服务连通用，但保存失败');
            }
          } else {
            parts.push(`搜索服务：${searchResult.message}`);
          }
        } else {
          parts.push('搜索服务地址未填写（可稍后在保存时一并处理）');
        }
      }

      // 3. 远程 API 模式：只测并保存 API
      if (modelPriority === 'api') {
        const apiResult = await testModelConnection({
          modelPriority,
          ollamaBaseUrl,
          mainModel,
          apiModel,
          apiKey,
        });
        parts.push(apiResult.success ? '远程 API 连接正常' : `远程 API：${apiResult.message}`);
        if (apiResult.success) {
          try {
            await updateSettings({
              model_priority: 'api',
              openrouter_model: apiModel.trim(),
              openrouter_api_key: apiKey.trim(),
            });
          } catch {
            // 保存失败不阻塞提示
          }
        }
      }

      Alert.alert('测试完成', parts.join('\n'));
    } catch (e: any) {
      Alert.alert('测试失败', e?.message || '未知错误');
    } finally {
      setTesting(false);
    }
  };

  const openModelPicker = (target: 'main' | 'light') => {
    setPickingFor(target);
    setShowModelPicker(true);
  };

  // 导出全部日记为 JSON 文件并分享
  const handleExportDiaries = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const result = await exportDiaries();
      if (!result.success) {
        Alert.alert('导出失败', result.message);
      }
    } catch (e: any) {
      Alert.alert('导出失败', e?.message || '未知错误');
    } finally {
      setExporting(false);
    }
  };

  // 导出全部数据为加密备份（设定备份密码 + 二次确认）
  const handleExportBackup = async () => {
    if (exportingBackup) return;
    if (!backupPwd || backupPwd.trim().length < 4) {
      Alert.alert('提示', '请设置备份密码（至少 4 位）');
      return;
    }
    if (backupPwd !== backupPwdConfirm) {
      Alert.alert('提示', '两次输入的密码不一致');
      return;
    }
    setExportingBackup(true);
    try {
      const result = await exportFullBackup(backupPwd);
      Alert.alert(result.success ? '导出成功' : '导出失败', result.message);
      if (result.success) {
        setShowBackupModal(false);
        setBackupPwd('');
        setBackupPwdConfirm('');
      }
    } catch (e: any) {
      Alert.alert('导出失败', e?.message || '未知错误');
    } finally {
      setExportingBackup(false);
    }
  };

  const handleModelSelect = (name: string) => {
    if (pickingFor === 'main') {
      setMainModel(name);
    } else {
      setLightModel(name);
    }
    setShowModelPicker(false);
  };

  // 单行模型选择组件（点击弹窗选择）
  const renderModelPickerRow = (
    label: string,
    hint: string,
    selectedModel: string,
    target: 'main' | 'light',
  ) => (
    <View style={styles.modelPickerSection}>
      <Text style={styles.modelPickerLabel}>{label}</Text>
      <Text style={styles.modelPickerHint}>{hint}</Text>
      <TouchableOpacity
        style={styles.modelPickerRow}
        onPress={() => openModelPicker(target)}
        activeOpacity={0.7}
      >
        <View style={styles.modelPickerInfo}>
          <Text style={[styles.modelPickerName, !selectedModel && styles.modelPickerPlaceholder]}>
            {selectedModel || '点击选择模型'}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color="#9CA3AF" />
      </TouchableOpacity>
    </View>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>设置</Text>
          <Text style={styles.subGreeting}>连接与偏好</Text>
        </View>
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {/* 模型设置 */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>模型设置</Text>
          <Text style={styles.sectionHint}>选择本地 Ollama 或远程 API 作为模型服务</Text>
          <View style={styles.radioGroup}>
            <TouchableOpacity
              style={[styles.radio, modelPriority === 'local' && styles.radioLocalActive]}
              onPress={() => setModelPriority('local')}
            >
              <Text style={[styles.radioText, modelPriority === 'local' && styles.radioLocalTextActive]}>
                本地 Ollama
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.radio, modelPriority === 'api' && styles.radioApiActive]}
              onPress={() => setModelPriority('api')}
            >
              <Text style={[styles.radioText, modelPriority === 'api' && styles.radioApiTextActive]}>
                远程 API
              </Text>
            </TouchableOpacity>
          </View>

          {/* 本地模型：地址 + 主模型 + 轻量模型 */}
          {modelPriority === 'local' && (
            <View>
              <Text style={styles.fieldLabel}>Ollama 地址</Text>
              <TextInput
                style={styles.input}
                value={ollamaBaseUrl}
                onChangeText={setOllamaBaseUrl}
                placeholder="http://192.168.x.x:11434"
                placeholderTextColor="#cbd5e1"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
              <Text style={styles.fieldLabel}>搜索服务地址（SearXNG）</Text>
              <Text style={styles.fieldHint}>联网搜索用；留空则自动使用 Ollama 同一主机 8888 端口</Text>
              <TextInput
                style={styles.input}
                value={searxngBaseUrl}
                onChangeText={setSearxngBaseUrl}
                placeholder="http://192.168.x.x:8888"
                placeholderTextColor="#cbd5e1"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
              <View style={styles.modelSectionHeader}>
                <Text style={styles.modelSectionHeaderTitle}>选择模型</Text>
                <TouchableOpacity onPress={loadOllamaModels} disabled={modelsLoading}>
                  <Text style={styles.refreshText}>刷新</Text>
                </TouchableOpacity>
              </View>

              {renderModelPickerRow(
                '主模型',
                '负责对话、觉察分析等主要任务',
                mainModel,
                'main',
              )}

              <View style={styles.modelDivider} />

              {renderModelPickerRow(
                '轻量模型',
                '负责日记摘要、情绪分类等轻量任务',
                lightModel,
                'light',
              )}
            </View>
          )}

          {/* 远程 API 输入 */}
          {modelPriority === 'api' && (
            <View style={styles.modelPickerSection}>
              <Text style={styles.fieldLabel}>模型名称</Text>
              <TextInput
                style={styles.input}
                value={apiModel}
                onChangeText={setApiModel}
                placeholder="如: openai/gpt-4o"
                placeholderTextColor="#cbd5e1"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Text style={styles.fieldLabel}>API Key</Text>
              <TextInput
                style={styles.input}
                value={apiKey}
                onChangeText={setApiKey}
                placeholder="sk-..."
                placeholderTextColor="#cbd5e1"
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
              />
            </View>
          )}

          <View style={styles.btnRow}>
            <TouchableOpacity
              style={[styles.btn, styles.testBtn]}
              onPress={handleTestConnection}
              disabled={testing}
              activeOpacity={0.7}
            >
              {testing ? (
                <ActivityIndicator size="small" color={PRIMARY} />
              ) : (
                <Ionicons name="flash-outline" size={16} color={PRIMARY} />
              )}
              <Text style={styles.testBtnText}>{testing ? '测试中' : '连接测试'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.btn} onPress={handleSaveModelSettings}>
              <Text style={styles.btnText}>保存模型设置</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* 数据导出：导出日记（可读）或导出全部数据（加密备份） */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>数据导出</Text>
          <Text style={styles.sectionHint}>导出日记（可读 JSON）或导出全部数据（加密备份，用于换机迁移）</Text>
          <View style={styles.exportRow}>
            <TouchableOpacity
              style={[styles.exportBtn, styles.exportBtnDiary]}
              onPress={handleExportDiaries}
              disabled={exporting}
              activeOpacity={0.7}
            >
              {exporting ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Ionicons name="document-text-outline" size={18} color="#fff" />
              )}
              <Text style={styles.exportBtnText}>{exporting ? '导出中' : '导出日记'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.exportBtn, styles.exportBtnAll]}
              onPress={() => setShowBackupModal(true)}
              disabled={exportingBackup}
              activeOpacity={0.7}
            >
              {exportingBackup ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Ionicons name="archive-outline" size={18} color="#fff" />
              )}
              <Text style={styles.exportBtnText}>{exportingBackup ? '导出中' : '导出所有数据'}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* 数据迁移：导入历史日记 */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>数据迁移</Text>
          <Text style={styles.sectionHint}>把其他日记软件的历史日记导入到本项目</Text>
          <TouchableOpacity
            style={styles.migrateBtn}
            onPress={() => router.push('/(main)/import')}
            activeOpacity={0.7}
          >
            <Ionicons name="cloud-upload-outline" size={18} color="#fff" />
            <Text style={styles.migrateBtnText}>导入历史日记</Text>
            <Ionicons name="chevron-forward" size={16} color="#fff" />
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* 全量备份：设置备份密码弹窗 */}
      <Modal
        visible={showBackupModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowBackupModal(false)}
      >
        <TouchableOpacity
          style={styles.pickerOverlay}
          activeOpacity={1}
          onPress={() => setShowBackupModal(false)}
        >
          <View style={styles.backupModalCard} onStartShouldSetResponder={() => true}>
            <Text style={styles.backupModalTitle}>设置备份密码</Text>
            <Text style={styles.backupModalWarn}>
              此密码仅适用于本次导出的备份文件，且密码不可找回。软件不会保存该密码，请务必记住，否则该备份将无法被解开。
            </Text>
            <TextInput
              style={styles.input}
              value={backupPwd}
              onChangeText={setBackupPwd}
              placeholder="输入备份密码（至少 4 位）"
              placeholderTextColor="#cbd5e1"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TextInput
              style={styles.input}
              value={backupPwdConfirm}
              onChangeText={setBackupPwdConfirm}
              placeholder="再次输入确认"
              placeholderTextColor="#cbd5e1"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={styles.backupModalActions}>
              <TouchableOpacity
                style={[styles.backupModalBtn, styles.backupModalCancel]}
                onPress={() => setShowBackupModal(false)}
                activeOpacity={0.7}
              >
                <Text style={styles.backupModalCancelText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.backupModalBtn, styles.backupModalConfirm]}
                onPress={handleExportBackup}
                disabled={exportingBackup}
                activeOpacity={0.7}
              >
                {exportingBackup ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.backupModalConfirmText}>导出</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* 模型选择弹窗 */}
      <Modal
        visible={showModelPicker}
        transparent
        animationType="fade"
        onRequestClose={() => setShowModelPicker(false)}
      >
        <TouchableOpacity
          style={styles.pickerOverlay}
          activeOpacity={1}
          onPress={() => setShowModelPicker(false)}
        >
          <View style={styles.pickerCard} onStartShouldSetResponder={() => true}>
            <Text style={styles.pickerTitle}>
              选择{pickingFor === 'main' ? '主' : '轻量'}模型
            </Text>
            {modelsLoading ? (
              <ActivityIndicator size="small" color={PRIMARY} style={styles.pickerLoader} />
            ) : ollamaModels.length === 0 ? (
              <View style={styles.emptyModels}>
                <Text style={styles.emptyModelsText}>未发现已安装的模型</Text>
                <TouchableOpacity onPress={() => { loadOllamaModels(); }}>
                  <Text style={styles.refreshText}>重新加载</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <ScrollView style={styles.pickerList} showsVerticalScrollIndicator={false}>
                {ollamaModels.map(item => {
                  const isSelected = (pickingFor === 'main' ? mainModel : lightModel) === item.name;
                  return (
                    <TouchableOpacity
                      key={item.name}
                      style={[styles.pickerItem, isSelected && styles.pickerItemActive]}
                      onPress={() => handleModelSelect(item.name)}
                    >
                      <View style={styles.pickerItemInfo}>
                        <Text style={[styles.pickerItemName, isSelected && styles.pickerItemNameActive]}>
                          {item.name}
                        </Text>
                      </View>
                      {isSelected && <Text style={styles.pickerCheck}>✓</Text>}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}
            <TouchableOpacity
              style={styles.pickerCancelBtn}
              onPress={() => setShowModelPicker(false)}
            >
              <Text style={styles.pickerCancelText}>取消</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* 底部导航 */}
      <BottomTabBar active="settings" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 22,
    paddingTop: 18,
    paddingBottom: 6,
  },
  greeting: {
    fontSize: 24,
    fontWeight: '700',
    color: TEXT,
  },
  subGreeting: {
    fontSize: 13,
    color: TEXT_SUB,
    marginTop: 4,
  },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 100 },
  section: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 16,
    padding: 16,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 12,
    elevation: 2,
  },
  sectionTitle: { fontSize: 16, fontWeight: '600', color: TEXT, marginBottom: 4 },
  sectionHint: { fontSize: 13, color: '#9CA3AF', marginBottom: 12 },
  input: {
    backgroundColor: '#F7F9F8',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#334155',
    borderWidth: 1,
    borderColor: '#E7ECEA',
    marginBottom: 12,
  },
  btn: {
    flex: 1,
    backgroundColor: PRIMARY,
    borderRadius: 20,
    paddingVertical: 11,
    alignItems: 'center',
    marginTop: 4,
  },
  // 连接测试 + 保存双按钮行
  btnRow: {
    flexDirection: 'row',
    gap: 10,
  },
  testBtn: {
    backgroundColor: '#E6F7F1',
    borderWidth: 1,
    borderColor: PRIMARY,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  testBtnText: {
    color: PRIMARY,
    fontSize: 14,
    fontWeight: '600',
    marginLeft: 5,
  },
  btnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  radioGroup: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  radio: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E7ECEA',
    alignItems: 'center',
  },
  radioLocalActive: {
    borderColor: PRIMARY,
    backgroundColor: '#E6F7F1',
  },
  radioApiActive: {
    borderColor: PRIMARY,
    backgroundColor: '#E6F7F1',
  },
  radioText: { fontSize: 14, color: '#64748b', fontWeight: '500' },
  radioLocalTextActive: { color: '#1F9B80', fontWeight: '600' },
  radioApiTextActive: { color: '#1F9B80', fontWeight: '600' },
  // 模型选择区域
  modelPickerSection: {
    marginBottom: 0,
  },
  modelPickerLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 2,
  },
  modelPickerHint: {
    fontSize: 12,
    color: '#9CA3AF',
    marginBottom: 8,
  },
  modelPickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E7ECEA',
    backgroundColor: '#F7F9F8',
  },
  modelPickerInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  modelPickerName: {
    fontSize: 15,
    fontWeight: '500',
    color: '#334155',
  },
  modelPickerPlaceholder: {
    color: '#9CA3AF',
    fontWeight: '400',
  },
  modelPickerMeta: {
    fontSize: 12,
    color: '#9CA3AF',
  },
  modelSectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  modelSectionHeaderTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
  },
  modelDivider: {
    height: 1,
    backgroundColor: '#E7ECEA',
    marginVertical: 12,
  },
  refreshText: {
    fontSize: 13,
    color: PRIMARY,
    fontWeight: '500',
  },
  // 模型选择弹窗
  pickerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  pickerCard: {
    width: '78%',
    maxHeight: '65%',
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 20,
    paddingTop: 18,
  },
  pickerTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: TEXT,
    textAlign: 'center',
    marginBottom: 14,
  },
  pickerLoader: {
    paddingVertical: 24,
  },
  pickerList: {
    maxHeight: 320,
  },
  pickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    marginBottom: 4,
  },
  pickerItemActive: {
    backgroundColor: '#E6F7F1',
  },
  pickerItemInfo: {
    flex: 1,
  },
  pickerItemName: {
    fontSize: 15,
    color: '#6B7280',
    fontWeight: '500',
  },
  pickerItemNameActive: {
    color: PRIMARY,
    fontWeight: '700',
  },
  pickerItemMeta: {
    fontSize: 12,
    color: '#9CA3AF',
    marginTop: 2,
  },
  pickerCheck: {
    fontSize: 18,
    color: PRIMARY,
    fontWeight: '700',
    marginLeft: 8,
  },
  pickerCancelBtn: {
    marginTop: 12,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 12,
    backgroundColor: '#F2F5F4',
  },
  pickerCancelText: {
    fontSize: 15,
    color: '#6B7280',
    fontWeight: '600',
  },
  emptyModels: {
    alignItems: 'center',
    paddingVertical: 16,
    gap: 8,
  },
  emptyModelsText: {
    fontSize: 14,
    color: '#94a3b8',
  },
  fieldLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 6,
  },
  fieldHint: {
    fontSize: 12,
    color: '#9CA3AF',
    marginBottom: 6,
  },
  migrateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: PRIMARY,
    borderRadius: 20,
    paddingVertical: 12,
    marginTop: 4,
  },
  migrateBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  // 数据导出双按钮
  exportRow: {
    flexDirection: 'row',
    gap: 10,
  },
  exportBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 20,
    paddingVertical: 13,
  },
  exportBtnDiary: {
    backgroundColor: PRIMARY,
  },
  exportBtnAll: {
    backgroundColor: '#4f46e5',
  },
  exportBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  // 备份密码弹窗
  backupModalCard: {
    width: '86%',
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 20,
  },
  backupModalTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: TEXT,
    textAlign: 'center',
    marginBottom: 10,
  },
  backupModalWarn: {
    fontSize: 12,
    color: '#b45309',
    backgroundColor: '#FEF3C7',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 14,
    lineHeight: 18,
  },
  backupModalActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 6,
  },
  backupModalBtn: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 12,
    alignItems: 'center',
  },
  backupModalCancel: { backgroundColor: '#F2F5F4' },
  backupModalConfirm: { backgroundColor: PRIMARY },
  backupModalCancelText: { fontSize: 14, color: '#6B7280', fontWeight: '600' },
  backupModalConfirmText: { fontSize: 14, color: '#fff', fontWeight: '600' },
});