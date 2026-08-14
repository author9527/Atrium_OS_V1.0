import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import DiaryEditor from '../../components/DiaryEditor';
import ChatPanel from '../../components/ChatPanel';
import { getToday } from '../../utils/date';

export default function WorkspaceScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ date?: string }>();
  const today = getToday();
  const [selectedDate, setSelectedDate] = useState(params.date || today.dateStr);
  const [chatVisible, setChatVisible] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);

  useEffect(() => {
    if (params.date) {
      setSelectedDate(params.date);
    }
  }, [params.date]);

  const handleBack = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(main)');
    }
  };

  const handleOpenChat = () => {
    setChatVisible(true);
    setHasUnread(false);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={handleBack} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color="#4f46e5" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>工作台</Text>
      </View>
      <DiaryEditor date={selectedDate} onChatGreeting={() => setHasUnread(true)} />
      <TouchableOpacity style={styles.chatFAB} onPress={handleOpenChat}>
        <Ionicons name="chatbubbles" size={24} color="#fff" />
        {hasUnread && <View style={styles.notificationDot} />}
      </TouchableOpacity>
      <ChatPanel
        visible={chatVisible}
        date={selectedDate}
        onClose={() => setChatVisible(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  backBtn: {
    padding: 4,
    marginRight: 8,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1e293b',
  },
  chatFAB: {
    position: 'absolute',
    bottom: 76,
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#4f46e5',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  notificationDot: {
    position: 'absolute',
    top: 4,
    left: 4,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#ef4444',
    borderWidth: 2,
    borderColor: '#fff',
  },
});
