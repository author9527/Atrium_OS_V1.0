import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  ActivityIndicator, Modal, TextInput, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { getPersonas, updatePersona, Persona } from '../../local/personas';

const PRIMARY = '#2FBF9F';
const TEXT = '#1F2937';
const TEXT_SUB = '#8A94A6';
const BG = '#F5F7F6';

export default function PersonasScreen() {
  const router = useRouter();
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<Persona | null>(null);
  const [egoDraft, setEgoDraft] = useState('');
  const [speakDraft, setSpeakDraft] = useState('');
  const [nameDraft, setNameDraft] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const res = await getPersonas();
      setPersonas(res.personas || []);
    } catch (e: any) {
      Alert.alert('加载失败', e.message || '无法获取机器人人设');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openEdit = (p: Persona) => {
    setEditing(p);
    setEgoDraft(p.ego || '');
    setSpeakDraft(p.speak_tendency || '');
    setNameDraft(p.name || '');
  };

  const handleSave = async () => {
    if (!editing) return;
    if (!egoDraft.trim()) {
      Alert.alert('提示', '人设内容不能为空');
      return;
    }
    setSaving(true);
    try {
      const payload: any = { ego: egoDraft.trim() };
      if (nameDraft.trim()) payload.name = nameDraft.trim();
      if (editing.role === 'chatroom' && speakDraft.trim()) {
        payload.speak_tendency = speakDraft.trim();
      }
      await updatePersona(editing.key, payload);
      setEditing(null);
      await load();
      Alert.alert('已保存', '人设已更新，将立即生效');
    } catch (e: any) {
      Alert.alert('保存失败', e.message || '未知错误');
    } finally {
      setSaving(false);
    }
  };

  const assistants = personas.filter(p => p.role === 'assistant');
  const chatrooms = personas.filter(p => p.role === 'chatroom');

  const renderRobot = (p: Persona) => (
    <TouchableOpacity key={p.key} style={styles.card} onPress={() => openEdit(p)} activeOpacity={0.7}>
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{p.emoji || '🤖'}</Text>
      </View>
      <View style={styles.cardBody}>
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardName}>{p.name}</Text>
          <View style={[styles.roleBadge, p.role === 'chatroom' ? styles.roleChatroom : styles.roleAssistant]}>
            <Text style={[styles.roleBadgeText, p.role === 'chatroom' ? styles.roleChatroomText : styles.roleAssistantText]}>
              {p.role === 'chatroom' ? '气氛组' : '助手'}
            </Text>
          </View>
        </View>
        {!!p.desc && <Text style={styles.cardDesc}>{p.desc}</Text>}
        <Text style={styles.cardEgo} numberOfLines={2}>
          {p.ego || '（未设置人设）'}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color="#9CA3AF" />
    </TouchableOpacity>
  );

  const handleBack = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(main)');
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      {/* 头部 */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={handleBack} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={22} color="#fff" />
        </TouchableOpacity>
        <View style={styles.headerTitleWrap}>
          <Text style={styles.headerTitle}>机器人人设</Text>
          <Text style={styles.headerSub}>管理所有 AI 机器人的性格设定</Text>
        </View>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={PRIMARY} />
        </View>
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          {assistants.length > 0 && (
            <View style={styles.group}>
              <Text style={styles.groupTitle}>助手</Text>
              {assistants.map(renderRobot)}
            </View>
          )}
          {chatrooms.length > 0 && (
            <View style={styles.group}>
              <Text style={styles.groupTitle}>气氛组</Text>
              {chatrooms.map(renderRobot)}
            </View>
          )}
          <Text style={styles.tip}>点击任一机器人即可编辑其人设，保存后立即生效。</Text>
        </ScrollView>
      )}

      {/* 编辑弹窗 */}
      <Modal
        visible={!!editing}
        transparent
        animationType="slide"
        onRequestClose={() => !saving && setEditing(null)}
      >
        <View style={styles.overlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>编辑「{editing?.name}」人设</Text>
              <TouchableOpacity onPress={() => !saving && setEditing(null)} activeOpacity={0.7}>
                <Ionicons name="close" size={22} color="#64748B" />
              </TouchableOpacity>
            </View>

            {editing?.role === 'chatroom' && (
              <>
                <Text style={styles.fieldLabel}>名字</Text>
                <TextInput
                  style={styles.input}
                  value={nameDraft}
                  onChangeText={setNameDraft}
                  placeholder="机器人名字"
                  placeholderTextColor="#cbd5e1"
                />
              </>
            )}

            <Text style={styles.fieldLabel}>人设描述（人格设定）</Text>
            <TextInput
              style={[styles.input, styles.textArea]}
              value={egoDraft}
              onChangeText={setEgoDraft}
              placeholder="描述这个机器人的性格、说话方式、与用户的关系等"
              placeholderTextColor="#cbd5e1"
              multiline
              textAlignVertical="top"
            />

            {editing?.role === 'chatroom' && (
              <>
                <Text style={styles.fieldLabel}>说话倾向（可选）</Text>
                <TextInput
                  style={[styles.input, styles.textArea]}
                  value={speakDraft}
                  onChangeText={setSpeakDraft}
                  placeholder="何时更想发言，如：用户情绪低落时"
                  placeholderTextColor="#cbd5e1"
                  multiline
                  textAlignVertical="top"
                />
              </>
            )}

            <TouchableOpacity
              style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
              onPress={handleSave}
              disabled={saving}
              activeOpacity={0.8}
            >
              {saving ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.saveBtnText}>保存人设</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 14,
  },
  backBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: PRIMARY,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  headerTitleWrap: { flex: 1 },
  headerTitle: { fontSize: 24, fontWeight: '700', color: TEXT },
  headerSub: { fontSize: 13, color: TEXT_SUB, marginTop: 2 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 18, paddingBottom: 40 },
  group: { marginBottom: 20 },
  groupTitle: { fontSize: 13, fontWeight: '700', color: TEXT_SUB, marginBottom: 10, letterSpacing: 1 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: '#E6F7F1',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  avatarText: { fontSize: 24 },
  cardBody: { flex: 1, marginRight: 8 },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center' },
  cardName: { fontSize: 17, fontWeight: '700', color: TEXT },
  roleBadge: {
    marginLeft: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  roleChatroom: { backgroundColor: '#FEF3C7' },
  roleAssistant: { backgroundColor: '#E6F7F1' },
  roleBadgeText: { fontSize: 11, fontWeight: '600' },
  roleChatroomText: { color: '#B45309' },
  roleAssistantText: { color: PRIMARY },
  cardDesc: { fontSize: 12, color: TEXT_SUB, marginTop: 2 },
  cardEgo: { fontSize: 13, color: '#475569', marginTop: 6, lineHeight: 18 },
  tip: { fontSize: 12, color: TEXT_SUB, textAlign: 'center', marginTop: 8 },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 22,
    paddingBottom: 40,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  modalTitle: { fontSize: 18, fontWeight: '700', color: TEXT },
  fieldLabel: { fontSize: 14, fontWeight: '600', color: '#475569', marginBottom: 8, marginTop: 6 },
  input: {
    backgroundColor: '#F8FAFC',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: TEXT,
    marginBottom: 12,
  },
  textArea: { minHeight: 120, maxHeight: 220 },
  saveBtn: {
    backgroundColor: PRIMARY,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  saveBtnDisabled: { opacity: 0.6 },
  saveBtnText: { fontSize: 16, fontWeight: '700', color: '#fff' },
});