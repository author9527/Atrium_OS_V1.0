import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, Modal, Alert, ActivityIndicator, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import {
  listRelationships, deleteRelationship, createRelationshipStream, analyzeAliases,
} from '../../local/relationships';
import BottomTabBar from '../../components/BottomTabBar';

const PRIMARY = '#2FBF9F';
const TEXT = '#1F2937';
const TEXT_SUB = '#8A94A6';
const BG = '#F5F7F6';

interface RelationshipItem {
  id: string;
  person_name: string;
  created_at: string;
  updated_at: string;
}

interface AliasEntry {
  name: string;
  reason: string;
  enabled: boolean;
}

export default function RelationshipsScreen() {
  const router = useRouter();
  const [relationships, setRelationships] = useState<RelationshipItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [step, setStep] = useState<'input' | 'aliases' | 'creating'>('input');
  const [aliases, setAliases] = useState<AliasEntry[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [progressStep, setProgressStep] = useState('');

  useEffect(() => {
    loadRelationships();
  }, []);

  const loadRelationships = async () => {
    try {
      setLoading(true);
      const list = await listRelationships();
      setRelationships(list);
    } catch (e) {
      console.error('加载关系列表失败:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleAnalyze = async () => {
    const name = newName.trim();
    if (!name) return;
    // 前端预校验：拦截"我"、"你"等代词，避免触发后端日记海量搜索崩溃
    const invalidNames = ['我', '你', '他', '她', '它', '您', '咱', '俺', '我们', '你们', '他们', '咱们', '你们'];
    if (invalidNames.includes(name)) {
      Alert.alert('提示', `「${name}」不是有效的人名，请填写对方的真实名字或称呼`);
      return;
    }
    setAnalyzing(true);
    try {
      const candidates = await analyzeAliases(name);
      setAliases(
        candidates.map((c) => ({ name: c.name, reason: c.reason || '', enabled: true })),
      );
      setStep('aliases');
    } catch (e: any) {
      Alert.alert('分析失败', e.message || '请稍后重试');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleConfirm = async () => {
    const name = newName.trim();
    const confirmed = aliases
      .filter((a) => a.enabled && a.name.trim())
      .map((a) => a.name.trim());
    if (!confirmed.length) {
      Alert.alert('提示', '请至少保留一个称呼');
      return;
    }
    setStep('creating');
    setCreating(true);
    setProgressMsg('正在创建...');
    setProgressStep('creating');

    try {
      let resultRel: any = null;
      let resultStatus = '';
      let resultFollowups: string[] = [];
      let resultOpening = '';
      let errorMsg = '';

      for await (const chunk of createRelationshipStream(name, confirmed)) {
        if (chunk.type === 'progress') {
          setProgressStep(chunk.step || '');
          setProgressMsg(chunk.message || '');
        } else if (chunk.type === 'result') {
          resultRel = chunk.relationship;
          resultStatus = chunk.status || '';
          resultFollowups = chunk.followup_questions || [];
          resultOpening = chunk.opening_message || '';
        } else if (chunk.type === 'error') {
          errorMsg = chunk.message || '创建失败';
        }
      }

      if (errorMsg === 'already_exists') {
        Alert.alert('已存在', `已经有一个关于「${name}」的关系档案了`);
        resetCreateModal();
        await loadRelationships();
      } else if (errorMsg) {
        Alert.alert('创建失败', errorMsg);
        // 若为无效人名，回到输入步骤让用户重填
        if (errorMsg.includes('不是有效的人名')) {
          setStep('input');
        }
      } else if (resultRel) {
        resetCreateModal();
        await loadRelationships();
        router.push({
          pathname: '/(main)/relationship-chat',
          params: {
            id: resultRel.id,
            person_name: resultRel.person_name,
            followup: resultFollowups.join('|||') || '',
            opening: resultOpening,
          },
        });
      }
    } catch (e: any) {
      Alert.alert('创建失败', e.message || '请稍后重试');
    } finally {
      setCreating(false);
      setProgressMsg('');
      setProgressStep('');
    }
  };

  const resetCreateModal = () => {
    setShowCreate(false);
    setNewName('');
    setStep('input');
    setAliases([]);
  };

  const toggleAlias = (index: number) => {
    setAliases((prev) =>
      prev.map((a, i) => (i === index ? { ...a, enabled: !a.enabled } : a)),
    );
  };

  const updateAliasName = (index: number, name: string) => {
    setAliases((prev) => prev.map((a, i) => (i === index ? { ...a, name } : a)));
  };

  const addAlias = () => {
    setAliases((prev) => [
      ...prev,
      { name: '', reason: '手动添加', enabled: true },
    ]);
  };

  const removeAlias = (index: number) => {
    setAliases((prev) => prev.filter((_, i) => i !== index));
  };

  const handleDelete = (item: RelationshipItem) => {
    Alert.alert(
      '删除关系档案',
      `确定要删除「${item.person_name}」的关系档案吗？此操作不可撤销。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteRelationship(item.id);
              setRelationships((prev) => prev.filter((r) => r.id !== item.id));
            } catch (e: any) {
              Alert.alert('删除失败', e.message || '请稍后重试');
            }
          },
        },
      ],
    );
  };

  const handleOpenRelationship = (item: RelationshipItem) => {
    router.push({
      pathname: '/(main)/relationship-chat',
      params: { id: item.id, person_name: item.person_name },
    });
  };

  const renderItem = ({ item }: { item: RelationshipItem }) => (
    <TouchableOpacity
      style={styles.relCard}
      onPress={() => handleOpenRelationship(item)}
      onLongPress={() => handleDelete(item)}
      activeOpacity={0.7}
    >
      <View style={styles.relIcon}>
        <Ionicons name="person" size={24} color={PRIMARY} />
      </View>
      <View style={styles.relInfo}>
        <Text style={styles.relName}>{item.person_name}</Text>
        <Text style={styles.relDate}>
          更新于 {new Date(item.updated_at).toLocaleDateString('zh-CN')}
        </Text>
      </View>
      <TouchableOpacity
        style={styles.deleteBtn}
        onPress={() => handleDelete(item)}
      >
        <Ionicons name="trash-outline" size={18} color="#ef4444" />
      </TouchableOpacity>
      <Ionicons name="chevron-forward" size={20} color="#cbd5e1" />
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>人际关系</Text>
          <Text style={styles.subGreeting}>记录重要的人，看见关系</Text>
        </View>
        <TouchableOpacity
          onPress={() => { setStep('input'); setAliases([]); setShowCreate(true); }}
          style={styles.addBtn}
          activeOpacity={0.7}
        >
          <Ionicons name="add" size={24} color="#fff" />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={PRIMARY} />
        </View>
      ) : relationships.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="people-outline" size={64} color="#DCE4E1" />
          <Text style={styles.emptyText}>还没有关系档案哦</Text>
          <Text style={styles.emptyHint}>点右上角的"+"，添加一个你在意的人</Text>
        </View>
      ) : (
        <FlatList
          data={relationships}
          renderItem={renderItem}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
        />
      )}

      {/* 底部导航 */}
      <BottomTabBar active="relationships" />

      {/* Create Modal */}
      <Modal visible={showCreate} animationType="fade" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            {step === 'input' && (
              <>
                <Text style={styles.modalTitle}>新建人际关系</Text>
                <Text style={styles.modalHint}>
                  输入对方的名字，系统会先分析日记，找出他可能的外号/昵称供你确认
                </Text>
                <TextInput
                  style={styles.modalInput}
                  value={newName}
                  onChangeText={setNewName}
                  placeholder="输入名字..."
                  placeholderTextColor="#cbd5e1"
                  autoFocus
                  editable={!analyzing}
                />
                <View style={styles.modalButtons}>
                  <TouchableOpacity
                    style={styles.modalCancelBtn}
                    onPress={resetCreateModal}
                    disabled={analyzing}
                  >
                    <Text style={styles.modalCancelText}>取消</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.modalConfirmBtn, (!newName.trim() || analyzing) && styles.modalConfirmDisabled]}
                    onPress={handleAnalyze}
                    disabled={!newName.trim() || analyzing}
                  >
                    <Text style={styles.modalConfirmText}>{analyzing ? '分析中...' : '下一步'}</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}

            {step === 'aliases' && (
              <>
                <Text style={styles.modalTitle}>确认称呼</Text>
                <Text style={styles.modalHint}>
                  系统从日记中识别出「{newName.trim()}」可能的称呼，勾选确认、可修改或去掉，确认后生成档案
                </Text>
                <ScrollView style={styles.aliasList} contentContainerStyle={styles.aliasListContent}>
                  {aliases.map((a, i) => (
                    <View key={i} style={styles.aliasRow}>
                      <TouchableOpacity
                        style={[styles.checkbox, a.enabled && styles.checkboxOn]}
                        onPress={() => toggleAlias(i)}
                      >
                        {a.enabled && <Ionicons name="checkmark" size={16} color="#fff" />}
                      </TouchableOpacity>
                      <View style={styles.aliasBody}>
                        <TextInput
                          style={[styles.aliasInput, !a.enabled && styles.aliasInputDim]}
                          value={a.name}
                          onChangeText={(t) => updateAliasName(i, t)}
                          editable={!creating}
                          placeholder="输入称呼..."
                          placeholderTextColor="#cbd5e1"
                        />
                        {a.reason ? <Text style={styles.aliasReason}>{a.reason}</Text> : null}
                      </View>
                      <TouchableOpacity
                        style={styles.aliasRemoveBtn}
                        onPress={() => removeAlias(i)}
                        disabled={creating}
                      >
                        <Ionicons name="close-circle" size={20} color="#cbd5e1" />
                      </TouchableOpacity>
                    </View>
                  ))}
                  <TouchableOpacity
                    style={styles.addAliasBtn}
                    onPress={addAlias}
                    disabled={creating}
                  >
                    <Ionicons name="add" size={18} color="#4f46e5" />
                    <Text style={styles.addAliasText}>添加称呼</Text>
                  </TouchableOpacity>
                </ScrollView>
                <View style={styles.modalButtons}>
                  <TouchableOpacity
                    style={styles.modalCancelBtn}
                    onPress={resetCreateModal}
                    disabled={creating}
                  >
                    <Text style={styles.modalCancelText}>取消</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.modalReanalyzeBtn}
                    onPress={handleAnalyze}
                    disabled={creating}
                  >
                    <Text style={styles.modalReanalyzeText}>重新分析</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.modalConfirmBtn}
                    onPress={handleConfirm}
                    disabled={creating}
                  >
                    <Text style={styles.modalConfirmText}>确认并创建</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}

            {step === 'creating' && (
              <>
                <Text style={styles.modalTitle}>正在创建档案</Text>
                <Text style={styles.modalHint}>正在根据确认的称呼从日记中提取信息并生成档案</Text>
                <View style={styles.progressContainer}>
                  <View style={styles.progressBar}>
                    <View style={[
                      styles.progressFill,
                      { width: _getProgressWidth(progressStep) },
                    ]} />
                  </View>
                  <View style={styles.progressInfo}>
                    <ActivityIndicator size="small" color={PRIMARY} />
                    <Text style={styles.progressText}>{progressMsg}</Text>
                  </View>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function _getProgressWidth(step: string): `${number}%` {
  const steps: Record<string, number> = {
    'creating': 15,
    'searching': 30,
    'found_diaries': 45,
    'extracting': 60,
    'extracted': 75,
    'generating': 90,
    'done': 100,
  };
  return `${steps[step] || 5}%` as `${number}%`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 22,
    paddingTop: 18,
    paddingBottom: 14,
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
  addBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: PRIMARY,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: PRIMARY,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 3,
  },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { fontSize: 16, color: '#9CA3AF', marginTop: 16 },
  emptyHint: { fontSize: 14, color: '#C2CBC7', marginTop: 8 },
  listContent: { padding: 16, paddingBottom: 100 },
  relCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 12,
    elevation: 2,
  },
  relIcon: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: '#E6F7F1',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  relInfo: { flex: 1 },
  relName: { fontSize: 16, fontWeight: '600', color: TEXT },
  relDate: { fontSize: 13, color: '#9CA3AF', marginTop: 4 },
  deleteBtn: { padding: 8, marginRight: 4 },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  modalContent: {
    width: '85%',
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
  },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#1e293b' },
  modalHint: { fontSize: 14, color: '#64748b', marginTop: 8, marginBottom: 16 },
  modalInput: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: '#334155',
  },
  progressContainer: {
    marginTop: 16,
  },
  progressBar: {
    height: 6,
    backgroundColor: '#e2e8f0',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: PRIMARY,
    borderRadius: 3,
  },
  progressInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
  },
  progressText: {
    fontSize: 13,
    color: '#64748b',
    marginLeft: 8,
    flex: 1,
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 16,
  },
  modalCancelBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    marginRight: 8,
  },
  modalCancelText: { fontSize: 16, color: '#64748b' },
  modalConfirmBtn: {
    backgroundColor: PRIMARY,
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 20,
  },
  modalConfirmDisabled: { opacity: 0.4 },
  modalConfirmText: { fontSize: 16, color: '#fff', fontWeight: '600' },
  modalReanalyzeBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginRight: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#BFEADB',
  },
  modalReanalyzeText: { fontSize: 16, color: PRIMARY },
  aliasList: { maxHeight: 280, marginTop: 8 },
  aliasListContent: { paddingBottom: 4 },
  aliasRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#cbd5e1',
    backgroundColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
    marginRight: 10,
  },
  checkboxOn: { backgroundColor: PRIMARY, borderColor: PRIMARY },
  aliasBody: { flex: 1 },
  aliasInput: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1e293b',
    paddingVertical: 4,
    paddingHorizontal: 0,
  },
  aliasInputDim: { color: '#94a3b8', textDecorationLine: 'line-through' },
  aliasReason: { fontSize: 12, color: '#94a3b8', marginTop: 2, lineHeight: 17 },
  aliasRemoveBtn: { padding: 6, marginLeft: 6, alignSelf: 'center' },
  addAliasBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    marginTop: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#BFEADB',
  },
  addAliasText: { fontSize: 15, color: PRIMARY, marginLeft: 6, fontWeight: '600' },
});
