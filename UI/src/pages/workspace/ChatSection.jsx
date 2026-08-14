import React from 'react';
import SessionList from '../../components/SessionList';
import ChatPanel from '../../components/ChatPanel';

// ==========================================
// ChatSection — 聊天区组件
// 包含：会话列表 + 共情助手聊天面板
// ==========================================

const ChatSection = ({
  chatPanelVisible,
  sessionListVisible,
  sessions,
  currentSessionId,
  messages,
  onSendMessage,
  onSelectSession,
  onCreateSession,
  onDeleteSession,
  onRenameSession,
  onToggleChatPanel,
  onToggleSessionList,
  aiGreeting,
  searchStatus,
}) => {
  return (
    <>
      {/* 会话列表：在共情助手左边，可折叠 */}
      <SessionList
        visible={chatPanelVisible && sessionListVisible}
        sessions={sessions}
        currentSessionId={currentSessionId}
        onSelect={onSelectSession}
        onCreate={onCreateSession}
        onDelete={onDeleteSession}
        onRename={onRenameSession}
        onToggle={onToggleSessionList}
      />

      <ChatPanel
        visible={chatPanelVisible}
        messages={messages}
        onSend={onSendMessage}
        onClose={() => onToggleChatPanel(false)}
        onOpen={() => onToggleChatPanel(true)}
        greeting={aiGreeting}
        canChat={true}
        searchStatus={searchStatus}
      />
    </>
  );
};

export default ChatSection;
