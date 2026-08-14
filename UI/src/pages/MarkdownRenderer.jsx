import React, { useState, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';

// 使用 react-markdown + remark-gfm（GitHub Flavored Markdown）实现业界标准 Markdown 渲染
// 支持：加粗、斜体、标题、列表、表格、代码块、引用、删除线、任务列表等
// 附加能力：sources 提供的联网搜索来源，把回答中的 [N] 角标渲染成可点击上标，点击弹出来源链接
//
// 说明：react-markdown v10 的 hast-util-to-jsx-runtime 对 text 节点直接返回 node.value，
// 不会走 components.text 覆盖，因此不能靠覆盖 text 组件渲染角标。
// 这里改用 remark 插件：在 markdown AST 层面把 [N] 拆成链接节点（url 用 cite:N 标记），
// 再覆盖 a 组件把 cite: 链接渲染成可点击上标。

// 匹配 [1]、[12] 形式的角标标记
const CITE_RE = /\[(\d+)\]/g;
// 引用链接的专用 url 前缀，用于与真实链接区分
const CITE_PREFIX = 'cite:';

// remark 插件：遍历 text 节点，把 [N] 转成链接节点 {type:'link', url:'cite:N'}
function remarkCite() {
  return (tree) => {
    visit(tree, 'text', (node, index, parent) => {
      const value = node.value;
      if (!value || !CITE_RE.test(value)) return;
      CITE_RE.lastIndex = 0; // 复位全局正则 lastIndex

      // 按 [N] 拆分，保留纯文本与角标
      let last = 0;
      const children = [];
      let m;
      while ((m = CITE_RE.exec(value)) !== null) {
        const start = m.index;
        const num = m[0].slice(1, -1); // 去掉方括号
        // 角标前的纯文本
        if (start > last) {
          children.push({ type: 'text', value: value.slice(last, start) });
        }
        children.push({
          type: 'link',
          url: `${CITE_PREFIX}${num}`,
          children: [{ type: 'text', value: `[${num}]` }],
        });
        last = start + m[0].length;
      }
      // 角标后的剩余纯文本
      if (last < value.length) {
        children.push({ type: 'text', value: value.slice(last) });
      }

      if (children.length) {
        parent.children.splice(index, 1, ...children);
        // 跳过新插入的节点，避免 visit 再次遍历新节点内的 text 造成重复嵌套
        return index + children.length;
      }
    });
  };
}

const markdownComponents = {
  // 段落
  p: ({ children }) => <p style={{ margin: '3px 0' }}>{children}</p>,
  // 标题
  h1: ({ children }) => <h1 style={{ fontSize: '18px', fontWeight: 700, margin: '16px 0 8px 0' }}>{children}</h1>,
  h2: ({ children }) => <h2 style={{ fontSize: '16px', fontWeight: 700, margin: '14px 0 8px 0' }}>{children}</h2>,
  h3: ({ children }) => <h3 style={{ fontSize: '15px', fontWeight: 600, margin: '12px 0 6px 0' }}>{children}</h3>,
  h4: ({ children }) => <h4 style={{ fontSize: '14px', fontWeight: 600, margin: '10px 0 4px 0' }}>{children}</h4>,
  // 加粗
  strong: ({ children }) => <strong style={{ fontWeight: 700 }}>{children}</strong>,
  // 斜体
  em: ({ children }) => <em style={{ fontStyle: 'italic' }}>{children}</em>,
  // 删除线
  del: ({ children }) => <del style={{ textDecoration: 'line-through' }}>{children}</del>,
  // 行内代码
  code: ({ children, className }) => {
    const isInline = !className;
    if (isInline) {
      return <code style={{ background: '#f3f4f6', padding: '2px 6px', borderRadius: '4px', fontSize: '0.9em' }}>{children}</code>;
    }
    return <code style={{ fontSize: '13px' }}>{children}</code>;
  },
  // 代码块
  pre: ({ children }) => (
    <pre style={{ background: '#1f2937', color: '#e5e7eb', padding: '12px', borderRadius: '8px', overflowX: 'auto', margin: '8px 0', fontSize: '13px', lineHeight: '1.5' }}>
      {children}
    </pre>
  ),
  // 无序列表
  ul: ({ children }) => <ul style={{ margin: '4px 0', paddingLeft: '20px', listStyleType: 'disc' }}>{children}</ul>,
  // 有序列表
  ol: ({ children }) => <ol style={{ margin: '4px 0', paddingLeft: '20px', listStyleType: 'decimal' }}>{children}</ol>,
  // 列表项
  li: ({ children }) => <li style={{ margin: '2px 0' }}>{children}</li>,
  // 引用块
  blockquote: ({ children }) => (
    <blockquote style={{ borderLeft: '3px solid #6366f1', paddingLeft: '12px', margin: '8px 0', color: '#6b7280', fontStyle: 'italic' }}>
      {children}
    </blockquote>
  ),
  // 链接
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: '#6366f1', textDecoration: 'underline' }}>
      {children}
    </a>
  ),
  // 换行
  br: () => <br />,
  // 水平线
  hr: () => <hr style={{ border: 'none', borderTop: '1px solid #e5e7eb', margin: '12px 0' }} />,
  // 表格
  table: ({ children }) => (
    <div style={{ overflowX: 'auto', margin: '8px 0' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead style={{ background: '#f9fafb' }}>{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr style={{ borderBottom: '1px solid #e5e7eb' }}>{children}</tr>,
  th: ({ children }) => <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: '#374151' }}>{children}</th>,
  td: ({ children }) => <td style={{ padding: '6px 10px', color: '#4b5563' }}>{children}</td>,
  // 图片
  img: ({ src, alt }) => <img src={src} alt={alt} style={{ maxWidth: '100%', borderRadius: '8px', margin: '8px 0' }} />,
};

// 来源弹窗：展示所有被引用的来源标题 + 链接
const CitationPopup = ({ indices, sources, onClose }) => {
  const list = indices
    .map((n) => sources.find((s) => Number(s.index) === n))
    .filter(Boolean);
  if (list.length === 0) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: '20px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: '12px',
          maxWidth: '480px',
          width: '100%',
          boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '14px 18px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 700, fontSize: '15px', color: '#1f2937' }}>引用来源</span>
          <button
            onClick={onClose}
            style={{ border: 'none', background: 'transparent', color: '#9ca3af', fontSize: '18px', cursor: 'pointer', lineHeight: 1 }}
            aria-label="关闭"
          >
            ×
          </button>
        </div>
        <div style={{ maxHeight: '50vh', overflowY: 'auto', padding: '6px 0' }}>
          {list.map((s) => (
            <a
              key={`src-${s.index}`}
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'block',
                padding: '10px 18px',
                textDecoration: 'none',
                color: '#1f2937',
                borderBottom: '1px solid #f3f4f6',
              }}
            >
              <span style={{ fontWeight: 700, color: '#6366f1', marginRight: '8px' }}>[{s.index}]</span>
              <span>{s.title || s.url}</span>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
};

const MarkdownRenderer = ({ text, sources }) => {
  const [openIndices, setOpenIndices] = useState(null);

  const hasSources = Array.isArray(sources) && sources.length > 0;

  // 组件覆盖：a 组件把 cite: 前缀的链接渲染成可点击上标
  const components = useMemo(() => {
    const base = { ...markdownComponents };
    if (hasSources) {
      base.a = ({ href, children }) => {
        if (typeof href === 'string' && href.startsWith(CITE_PREFIX)) {
          const num = href.slice(CITE_PREFIX.length);
          const src = sources.find((s) => Number(s.index) === Number(num));
          if (src) {
            return (
              <sup
                onClick={(e) => { e.stopPropagation(); setOpenIndices([Number(num)]); }}
                title={`来源 ${num}`}
                style={{
                  color: '#6366f1',
                  fontWeight: 700,
                  fontSize: '0.72em',
                  cursor: 'pointer',
                  verticalAlign: 'super',
                  marginLeft: '1px',
                  userSelect: 'none',
                }}
              >
                [{num}]
              </sup>
            );
          }
        }
        return (
          <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: '#6366f1', textDecoration: 'underline' }}>
            {children}
          </a>
        );
      };
    }
    return base;
  }, [hasSources, sources]);

  if (!text) return null;
  return (
    <>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkCite]}
        components={components}
      >
        {text}
      </ReactMarkdown>
      {openIndices && (
        <CitationPopup indices={openIndices} sources={sources} onClose={() => setOpenIndices(null)} />
      )}
    </>
  );
};

export default MarkdownRenderer;