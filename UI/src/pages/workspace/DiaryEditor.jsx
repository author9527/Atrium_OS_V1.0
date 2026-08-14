import React from 'react';
import RichTextEditor from '../../components/RichTextEditor';

// ==========================================
// DiaryEditor — 日记编辑区
// 封装 RichTextEditor，负责日记内容的编辑展示
// ==========================================

const DiaryEditor = ({
  content,
  editable,
  onChange,
  onSave,
  hideSave = false,
}) => {
  return (
    <div className="flex-1 flex flex-col min-w-0">
      <RichTextEditor
        content={content}
        editable={editable}
        onChange={onChange}
        onSave={onSave}
        hideSave={hideSave}
      />
    </div>
  );
};

export default DiaryEditor;
