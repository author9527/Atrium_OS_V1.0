import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Modal, ScrollView, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { getProfile, getBasicInfo, saveBasicInfo, BasicInfo, updateProfileStream } from '../local/profile';

interface Props {
  visible: boolean;
  onClose: () => void;
}

// 档案维度 → 中文标题 + 图标
const DIMENSION_META: { key: string; label: string; icon: any }[] = [
  { key: 'personality_traits', label: '人格特质', icon: 'sparkles' },
  { key: 'behavior_patterns', label: '行为模式', icon: 'repeat' },
  { key: 'core_conflicts', label: '核心矛盾', icon: 'git-compare' },
  { key: 'relationship_dynamics', label: '关系动态', icon: 'people' },
  { key: 'supplementary', label: '补充维度', icon: 'add-circle' },
];

// 基础信息字段 → 中文标题 + 图标
const BASIC_FIELD_META: { key: keyof BasicInfo; label: string; icon: any; placeholder: string }[] = [
  { key: 'name', label: '姓名', icon: 'person-outline', placeholder: '你的名字' },
  { key: 'nickname', label: '外号', icon: 'pricetag-outline', placeholder: '外号或昵称' },
  { key: 'identity', label: '身份', icon: 'briefcase-outline', placeholder: '职业/社会身份' },
  { key: 'age', label: '年龄', icon: 'calendar-number-outline', placeholder: '年龄' },
  { key: 'gender', label: '性别', icon: 'male-female-outline', placeholder: '性别' },
  { key: 'birthday', label: '生日', icon: 'gift-outline', placeholder: '生日（如 2000-01-01）' },
  { key: 'address', label: '住址', icon: 'home-outline', placeholder: '所在地或住址' },
  { key: 'relationship_status', label: '感情', icon: 'heart-outline', placeholder: '单身/恋爱/已婚' },
  { key: 'hometown', label: '家乡', icon: 'flag-outline', placeholder: '家乡' },
  { key: 'education', label: '教育', icon: 'school-outline', placeholder: '教育背景' },
  { key: 'hobbies', label: '兴趣', icon: 'color-palette-outline', placeholder: '兴趣爱好' },
];

type StatusType = 'info' | 'ok' | 'err';

export default function ProfileModal({ visible, onClose }: Props) {
  const [loading, setLoading] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [content, setContent] = useState('');
  const [hasProfile, setHasProfile] = useState(false);
  const [parsed, setParsed] = useState<Record<string, string[]> | null>(null);
  const [status, setStatus] = useState<{ type: StatusType; text: string } | null>(null);

  // 基础信息状态
  const [basicInfo, setBasicInfo] = useState<BasicInfo>({
    name: '', nickname: '', identity: '', age: '', gender: '', birthday: '', address: '',
    relationship_status: '', hometown: '', education: '', hobbies: '',
  });
  const [editingBasic, setEditingBasic] = useState(false);
  const [basicStatus, setBasicStatus] = useState<{ type: StatusType; text: string } | null>(null);

  // 流式更新状态
  const [streamingInfo, setStreamingInfo] = useState<Partial<BasicInfo>>({});
  const [streamingProgress, setStreamingProgress] = useState('');
  const [streamingDims, setStreamingDims] = useState<Record<string, string[]>>({});
  const streamingRef = useRef(false);
  const filledFieldsRef = useRef(new Set<string>());

  const loadProfile = useCallback(async () => {
    if (!visible) return;
    setLoading(true);
    setStatus(null);
    setBasicStatus(null);
    setEditingBasic(false);
    try {
      const res = await getProfile();
      setContent(res.content || '');
      setHasProfile(res.has_profile);
      try {
        const obj = JSON.parse(res.content);
        if (obj && typeof obj === 'object') setParsed(obj);
        else setParsed(null);
      } catch {
        setParsed(null);
      }
      // 加载基础信息
      const info = getBasicInfo();
      setBasicInfo(info);
    } catch {
      setHasProfile(false);
      setContent('');
      setParsed(null);
    } finally {
      setLoading(false);
    }
  }, [visible]);

  useEffect(() => {
    if (visible) loadProfile();
  }, [visible, loadProfile]);

  const handleUpdate = useCallback(async () => {
    if (updating || streamingRef.current) return;
    setUpdating(true);
    streamingRef.current = true;
    setStatus(null);
    setEditingBasic(false);
    setStreamingInfo({});
    setStreamingProgress('');
    setStreamingDims({});
    filledFieldsRef.current = new Set();

    setStatus({ type: 'info', text: '正在分析日记并生成档案...' });

    try {
      for await (const event of updateProfileStream()) {
        switch (event.type) {
          case 'progress':
            setStreamingProgress(event.text);
            break;
          case 'basic_info_field':
            filledFieldsRef.current.add(event.key);
            setStreamingInfo(prev => ({ ...prev, [event.key]: event.value }));
            setStreamingProgress(`已提取：${event.key}`);
            break;
          case 'dimension_item':
            setStreamingDims(prev => ({ ...prev, [event.key]: event.items }));
            setStreamingProgress(`正在生成：${event.key}`);
            break;
          case 'done': {
            setContent(event.content || '');
            setHasProfile(!!(event.content && event.content.trim()));
            try {
              const obj = JSON.parse(event.content);
              if (obj && typeof obj === 'object') setParsed(obj);
              else setParsed(null);
            } catch {
              setParsed(null);
            }
            // 更新后重新加载基础信息
            const info = getBasicInfo();
            setBasicInfo(info);
            setStatus({
              type: 'ok',
              text: event.message || '档案已更新',
            });
            // 清除流式动画状态
            setStreamingInfo({});
            setStreamingProgress('');
            setStreamingDims({});
            break;
          }
          case 'error':
            setStatus({ type: 'err', text: event.message });
            // 清除流式动画状态
            setStreamingInfo({});
            setStreamingProgress('');
            setStreamingDims({});
            break;
        }
      }
    } catch (e: any) {
      setStatus({ type: 'err', text: e?.message || '更新失败，请检查服务器连接' });
      setStreamingInfo({});
      setStreamingProgress('');
      setStreamingDims({});
    } finally {
      setUpdating(false);
      streamingRef.current = false;
    }
  }, []);

  // 保存基础信息编辑
  const handleSaveBasic = useCallback(() => {
    saveBasicInfo(basicInfo);
    setEditingBasic(false);
    setBasicStatus({ type: 'ok', text: '基础信息已保存' });
    setTimeout(() => setBasicStatus(null), 2500);
  }, [basicInfo]);

  // 更新某个基础信息字段
  const updateBasicField = (key: keyof BasicInfo, value: string) => {
    setBasicInfo(prev => ({ ...prev, [key]: value }));
  };

  // 渲染基础信息板块（支持流式填充动画）
  const renderBasicInfo = () => {
    const isStreaming = streamingRef.current && Object.keys(streamingInfo).length > 0;
    const displayInfo = isStreaming ? { ...basicInfo, ...streamingInfo } : basicInfo;
    const hasAnyInfo = Object.values(displayInfo).some(v => v.trim());

    return (
      <View style={styles.basicCard}>
        <View style={styles.basicHeader}>
          <View style={styles.basicTitleRow}>
            <Ionicons name="id-card-outline" size={18} color="#2FBF9F" />
            <Text style={styles.basicTitle}>基础信息</Text>
            {isStreaming && (
              <View style={styles.streamingDot}>
                <ActivityIndicator size="small" color="#2FBF9F" />
              </View>
            )}
          </View>
          {!isStreaming && (
            <TouchableOpacity
              onPress={() => {
                if (editingBasic) {
                  handleSaveBasic();
                } else {
                  setEditingBasic(true);
                }
              }}
              style={styles.editBasicBtn}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons
                name={editingBasic ? 'checkmark-circle' : 'create-outline'}
                size={18}
                color={editingBasic ? '#16A34A' : '#64748B'}
              />
              <Text style={[styles.editBasicText, editingBasic && { color: '#16A34A' }]}>
                {editingBasic ? '保存' : '编辑'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
        {basicStatus && !isStreaming && (
          <Text style={[styles.basicStatusText, basicStatus.type === 'ok' ? styles.basicStatusOk : styles.basicStatusErr]}>
            {basicStatus.text}
          </Text>
        )}
        {streamingProgress ? (
          <Text style={styles.streamingProgressText}>{streamingProgress}</Text>
        ) : null}
        <View style={styles.basicFields}>
          {BASIC_FIELD_META.map(field => {
            const val = (displayInfo[field.key] || '').trim();
            const isNewlyFilled = isStreaming && streamingInfo[field.key] && streamingInfo[field.key]!.trim();
            const isStreamingPending = isStreaming && !val;
            return (
              <View key={field.key} style={[styles.basicFieldRow, isNewlyFilled && styles.basicFieldRowHighlight]}>
                <View style={styles.basicFieldLabel}>
                  <Ionicons
                    name={isNewlyFilled ? 'checkmark-circle' : field.icon}
                    size={14}
                    color={isNewlyFilled ? '#16A34A' : '#64748B'}
                  />
                  <Text style={styles.basicFieldLabelText}>{field.label}</Text>
                </View>
                {editingBasic && !isStreaming ? (
                  <TextInput
                    style={styles.basicInput}
                    value={displayInfo[field.key]}
                    onChangeText={v => updateBasicField(field.key, v)}
                    placeholder={field.placeholder}
                    placeholderTextColor="#C4D3CE"
                    autoCapitalize="none"
                  />
                ) : (
                  <Text style={[
                    styles.basicValue,
                    !val && styles.basicValueEmpty,
                    isNewlyFilled && styles.basicValueNew,
                    isStreamingPending && styles.basicValuePending,
                  ]}>
                    {val || (isStreamingPending ? '读取中...' : '未填写')}
                  </Text>
                )}
              </View>
            );
          })}
        </View>
        {!hasAnyInfo && !editingBasic && !isStreaming && (
          <Text style={styles.basicHint}>
            基础信息由 LLM 自动从日记中提取，你也可以手动编辑
          </Text>
        )}
      </View>
    );
  };

  // 渲染维度内容（支持流式展示）
  const renderDimensions = () => {
    if (!hasProfile && !streamingRef.current) return null;

    const dims = streamingRef.current ? streamingDims : {};
    const hasContent = content && parsed;

    // 如果有完整档案且不在流式状态，使用 parsed 展示
    if (hasContent && !streamingRef.current) {
      return (
        <View style={styles.dimList}>
          {DIMENSION_META.filter(d => Array.isArray(parsed[d.key]) && parsed[d.key].length > 0).map(d => (
            <View key={d.key} style={styles.dimCard}>
              <View style={styles.dimHeader}>
                <Ionicons name={d.icon} size={16} color="#2FBF9F" />
                <Text style={styles.dimLabel}>{d.label}</Text>
              </View>
              {parsed[d.key].map((item, idx) => (
                <Text key={idx} style={styles.dimItem}>· {item}</Text>
              ))}
            </View>
          ))}
        </View>
      );
    }

    // 流式状态下展示已生成的维度
    const dimKeys = Object.keys(dims);
    if (dimKeys.length === 0) return null;

    return (
      <View style={styles.dimList}>
        {DIMENSION_META.filter(d => dims[d.key] && dims[d.key]!.length > 0).map(d => {
          const items = dims[d.key]!;
          return (
            <View key={d.key} style={[styles.dimCard, styles.dimCardStreaming]}>
              <View style={styles.dimHeader}>
                <Ionicons name={d.icon} size={16} color="#2FBF9F" />
                <Text style={styles.dimLabel}>{d.label}</Text>
                <ActivityIndicator size="small" color="#2FBF9F" style={{ marginLeft: 6 }} />
              </View>
              {items.map((item, idx) => (
                <Text key={idx} style={styles.dimItem}>· {item}</Text>
              ))}
            </View>
          );
        })}
      </View>
    );
  };

  // 渲染主体内容
  const renderBody = () => {
    if (loading) {
      return <ActivityIndicator size="large" color="#2FBF9F" style={{ marginTop: 40 }} />;
    }
    return (
      <>
        {renderBasicInfo()}
        {renderDimensions()}
        {!hasProfile && !content && !streamingRef.current && (
          <View style={styles.emptyBox}>
            <Ionicons name="document-text-outline" size={44} color="#C4D3CE" />
            <Text style={styles.emptyText}>暂无心理档案哦</Text>
            <Text style={styles.emptyHint}>继续写日记，攒够 5 篇后点下面的"更新档案"就能生成了</Text>
          </View>
        )}
        {!hasProfile && content && !streamingRef.current && !parsed && (
          <Text style={styles.plainText}>{content}</Text>
        )}
      </>
    );
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <View style={styles.titleWrap}>
            <Ionicons name="person-circle-outline" size={22} color="#2FBF9F" />
            <Text style={styles.title}>我的档案</Text>
          </View>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="close" size={26} color="#475569" />
          </TouchableOpacity>
        </View>
        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
          {renderBody()}
        </ScrollView>
        {/* 底部固定更新按钮 */}
        <View style={styles.footer}>
          <TouchableOpacity
            onPress={handleUpdate}
            disabled={updating}
            style={[styles.updateBtn, updating && styles.updateBtnDisabled]}
            activeOpacity={0.85}
          >
            {updating ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Ionicons name="refresh" size={18} color="#fff" />
                <Text style={styles.updateBtnText}>更新档案</Text>
              </>
            )}
          </TouchableOpacity>
          {status && (
            <Text style={[styles.statusText, styles[`status_${status.type}`]]}>{status.text}</Text>
          )}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: 'rgba(245,247,246,0.98)',
    marginTop: 40,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E6EAE8',
  },
  titleWrap: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 20, fontWeight: '700', color: '#1F2937' },
  closeBtn: { padding: 4 },
  body: { flex: 1 },
  bodyContent: { padding: 20, paddingBottom: 16 },
  emptyBox: { alignItems: 'center', marginTop: 40, paddingHorizontal: 24 },
  emptyText: { fontSize: 17, fontWeight: '600', color: '#64748B', marginTop: 12 },
  emptyHint: { fontSize: 13, color: '#94A3B8', textAlign: 'center', marginTop: 8, lineHeight: 20 },
  // 基础信息
  basicCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  basicHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  basicTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  basicTitle: { fontSize: 16, fontWeight: '700', color: '#1F2937' },
  editBasicBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  editBasicText: { fontSize: 13, color: '#64748B', fontWeight: '600' },
  basicStatusText: { fontSize: 12, textAlign: 'center', marginBottom: 8 },
  basicStatusOk: { color: '#16A34A' },
  basicStatusErr: { color: '#DC2626' },
  basicFields: { gap: 10 },
  basicFieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#F0F2F1',
    paddingVertical: 8,
  },
  basicFieldLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    width: 70,
    flexShrink: 0,
  },
  basicFieldLabelText: { fontSize: 14, color: '#64748B', fontWeight: '500' },
  basicInput: {
    flex: 1,
    fontSize: 15,
    color: '#1F2937',
    borderBottomWidth: 1,
    borderBottomColor: '#2FBF9F',
    paddingVertical: 2,
    paddingHorizontal: 4,
  },
  basicValue: { flex: 1, fontSize: 15, color: '#1F2937' },
  basicValueEmpty: { color: '#C4D3CE', fontStyle: 'italic' },
  basicHint: {
    fontSize: 12,
    color: '#94A3B8',
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 18,
  },
  // 流式更新
  streamingDot: { marginLeft: 6 },
  streamingProgressText: {
    fontSize: 12,
    color: '#2FBF9F',
    textAlign: 'center',
    marginBottom: 8,
    fontStyle: 'italic',
  },
  basicFieldRowHighlight: {
    backgroundColor: '#F0FDF4',
    borderRadius: 6,
    paddingHorizontal: 4,
  },
  basicValueNew: {
    color: '#16A34A',
    fontWeight: '600',
  },
  basicValuePending: {
    color: '#94A3B8',
    fontStyle: 'italic',
  },
  dimCardStreaming: {
    borderLeftWidth: 3,
    borderLeftColor: '#2FBF9F',
  },
  // 心理档案维度
  dimList: { gap: 14 },
  dimCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  dimHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  dimLabel: { fontSize: 15, fontWeight: '700', color: '#1F2937' },
  dimItem: { fontSize: 15, color: '#475569', lineHeight: 23, marginBottom: 4 },
  plainText: { fontSize: 15, color: '#475569', lineHeight: 24 },
  footer: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 24,
    borderTopWidth: 1,
    borderTopColor: '#E6EAE8',
    backgroundColor: '#fff',
  },
  updateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2FBF9F',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    shadowColor: '#2FBF9F',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 3,
  },
  updateBtnDisabled: { opacity: 0.6 },
  updateBtnText: { color: '#fff', fontSize: 16, fontWeight: '700', marginLeft: 8 },
  statusText: { textAlign: 'center', fontSize: 13, marginTop: 10, lineHeight: 18 },
  status_info: { color: '#94A3B8' },
  status_ok: { color: '#16A34A' },
  status_err: { color: '#DC2626' },
});