/**
 * diaryIO.ts — 手机端日记数据导入导出（中转格式 + 转换器）（TypeScript 重写）
 *
 * 逐字等价复刻 Python 版 server/diary_io.py：
 *   1. 自建「富文本 JSON」作为唯一事实来源（canonical 格式），以 HTML 承载富文本
 *   2. 其余格式（Day One JSON / CSV / Markdown / 纯文本）一律通过转换器映射到 canonical
 *   3. 导入仅写库，绝不触发任何数据分析管线
 *
 * 注意：本模块仅操作内存字符串，不直接读写文件系统。
 */

// ==========================================
// 常量
// ==========================================

// must be a plain string, not JSON object
export const CANONICAL_FORMAT = 'atrium-diary';
export const CANONICAL_VERSION = '1.0';

// 支持的导入/导出格式（route 与前端共用）
export const SUPPORTED_FORMATS = ['atrium', 'dayone', 'csv', 'markdown', 'text'];

// 常见天气词映射（Day One 用英文/中文天气词 → 本项目默认中文天气词）
const WEATHER_MAP: Record<string, string> = {
  sunny: '晴', clear: '晴', 晴: '晴',
  cloudy: '多云', 'partly cloudy': '多云', 多云: '多云',
  rain: '雨', rainy: '雨', 雨: '雨',
  snow: '雪', snowy: '雪', 雪: '雪',
  windy: '风', 风: '风',
  fog: '雾', foggy: '雾', 雾: '雾',
  storm: '雷雨', thunderstorm: '雷雨', 雷雨: '雷雨',
  hot: '热', cold: '冷', overcast: '阴', 阴: '阴',
};

export interface CanonicalEntry {
  date: string;
  content: string;
  weather: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

const BLOCK_TAGS = ['p', 'div', 'br', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'tr', 'ul', 'ol'];

// ==========================================
// 富文本转换工具（HTML ↔ 纯文本 / Markdown）
// ==========================================

/** 从 HTML 中提取纯文本，保留块级换行。 */
export function htmlToText(html: string): string {
  if (!html) return '';
  let text = html;
  // 跳过 script/style 内容
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  // 块级标签 → 换行
  const blockRe = new RegExp(`</?(?:${BLOCK_TAGS.join('|')})[^>]*/?>`, 'gi');
  text = text.replace(blockRe, '\n');
  // 兜底剥离剩余标签
  text = text.replace(/<[^>]+>/g, '');
  // 实体还原
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  text = text.replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  // 压缩连续空行，保留单换行
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''));
  const out: string[] = [];
  let prevBlank = false;
  for (const line of lines) {
    if (!line.trim()) {
      if (!prevBlank) out.push('');
      prevBlank = true;
    } else {
      out.push(line);
      prevBlank = false;
    }
  }
  return out.join('\n').trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const HEADING_RE = /^#{1,6}\s+(.*)$/;
const BOLD_RE = /\*\*(.+?)\*\*/g;
const ITAL_RE = /(?<!\*)\*([^*\n]+)\*(?!\*)/g;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;
const IMG_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
const LIST_RE = /^[-*+]\s+(.*)$/;
const ORDERED_LIST_RE = /^\d+\.\s+(.*)$/;
const CODE_FENCE_RE = /```(\w*)\n?([\s\S]*?)```/g;

/** 行内 Markdown → HTML（图片/链接/代码/加粗/斜体）。 */
function inlineMd(text: string): string {
  let t = text;
  t = t.replace(IMG_RE, (_, alt: string, src: string) => `<img src="${src}" alt="${alt}">`);
  t = t.replace(LINK_RE, (_, label: string, url: string) => `<a href="${url}">${inlineMd(label)}</a>`);
  t = t.replace(INLINE_CODE_RE, (_, code: string) => `<code>${escapeHtml(code)}</code>`);
  t = t.replace(BOLD_RE, '<strong>$1</strong>');
  t = t.replace(ITAL_RE, '<em>$1</em>');
  return t;
}

/** 轻量 Markdown → HTML（覆盖日记常用语法：标题/加粗/斜体/代码/链接/图片/列表/引用）。 */
export function markdownToHtml(md: string): string {
  if (!md) return '';
  let text = md;
  // 代码块优先处理
  text = text.replace(CODE_FENCE_RE, (_, lang: string, code: string) => {
    const encoded = escapeHtml(code);
    const cls = lang ? ` class="language-${lang}"` : '';
    return `<pre><code${cls}>${encoded}</code></pre>`;
  });

  const outLines: string[] = [];
  let inList = false;
  let listType = 'ul';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    let heading = HEADING_RE.exec(line);
    if (heading) {
      if (inList) { outLines.push(`</${listType}>`); inList = false; }
      const level = line.split(' ')[0].length;
      outLines.push(`<h${level}>${inlineMd(heading[1])}</h${level}>`);
      continue;
    }
    if (line.trim() === '---') {
      if (inList) { outLines.push(`</${listType}>`); inList = false; }
      outLines.push('<hr>');
      continue;
    }
    if (line.trim().startsWith('>')) {
      if (inList) { outLines.push(`</${listType}>`); inList = false; }
      outLines.push(`<blockquote>${inlineMd(line.trim().slice(1).trim())}</blockquote>`);
      continue;
    }
    heading = null;
    const listMatch = LIST_RE.exec(line);
    const orderedMatch = !listMatch ? ORDERED_LIST_RE.exec(line) : null;
    let item: string;
    let t = 'ul';
    if (listMatch) {
      t = 'ul';
      item = listMatch[1];
    } else if (orderedMatch) {
      t = 'ol';
      item = orderedMatch[1];
    } else {
      if (inList) { outLines.push(`</${listType}>`); inList = false; }
      if (line.trim()) {
        outLines.push(`<p>${inlineMd(line.trim())}</p>`);
      } else {
        outLines.push('');
      }
      continue;
    }
    if (!inList) {
      inList = true;
      listType = t;
      outLines.push(`<${t}>`);
    }
    outLines.push(`<li>${inlineMd(item)}</li>`);
  }
  if (inList) outLines.push(`</${listType}>`);
  return outLines.join('\n');
}

/** 对一段文本做行内标签 → Markdown 的轻量替换（供 htmlToMarkdown 复用）。 */
function tagsToMd(text: string): string {
  let t = text;
  t = t.replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**');
  t = t.replace(/<em>([\s\S]*?)<\/em>/g, '*$1*');
  t = t.replace(/<code>([\s\S]*?)<\/code>/g, '`$1`');
  t = t.replace(/<[^>]+>/g, '');
  return t;
}

/** 富文本 HTML → Markdown（保留标题/加粗/斜体/列表/链接/图片/代码块）。 */
export function htmlToMarkdown(html: string): string {
  if (!html) return '';
  let md = html;
  md = md.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (m, level: string, inner: string) => '#'.repeat(Number(level)) + ' ' + tagsToMd(inner) + '\n');
  md = md.replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**');
  md = md.replace(/<b>([\s\S]*?)<\/b>/g, '**$1**');
  md = md.replace(/<em>([\s\S]*?)<\/em>/g, '*$1*');
  md = md.replace(/<i>([\s\S]*?)<\/i>/g, '*$1*');
  md = md.replace(/<code>([\s\S]*?)<\/code>/g, '`$1`');
  md = md.replace(/<a href="([^"]*)">([\s\S]*?)<\/a>/g, '[$2]($1)');
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*>/g, '![]($1)');
  md = md.replace(/<blockquote>([\s\S]*?)<\/blockquote>/g, (m, inner: string) => '> ' + tagsToMd(inner).replace(/\n/g, '\n> '));
  md = md.replace(/<li>([\s\S]*?)<\/li>/g, (m, inner: string) => '- ' + tagsToMd(inner));
  md = md.replace(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g, (m, inner: string) => '```\n' + tagsToMd(inner) + '\n```');
  md = md.replace(/<p>([\s\S]*?)<\/p>/g, (m, inner: string) => tagsToMd(inner) + '\n\n');
  md = md.replace(/<br\s*\/?>/g, '\n');
  md = md.replace(/<[^>]+>/g, ''); // 兜底剥离剩余标签
  md = md.replace(/\n{3,}/g, '\n\n'); // 清理多余空行
  return md.trim();
}

// ==========================================
// 自建富文本 JSON（canonical）格式
// ==========================================

function nowIso(): string {
  return new Date().toISOString();
}

/** 构造一条 canonical 日记条目。content 为富文本 HTML。 */
export function makeCanonicalEntry(
  date: string,
  content: string,
  weather: string = '晴',
  tags: string[] | null = null,
  created_at: string | null = null,
  updated_at: string | null = null,
): CanonicalEntry {
  const now = nowIso();
  return {
    date,
    content: content || '',
    weather: weather || '晴',
    tags: tags || [],
    created_at: created_at || now,
    updated_at: updated_at || now,
  };
}

/** 把条目列表包装为 canonical 文档（含格式标记与版本）。 */
export function buildCanonical(entries: CanonicalEntry[]): Record<string, unknown> {
  return {
    format: CANONICAL_FORMAT,
    version: CANONICAL_VERSION,
    exported_at: nowIso(),
    count: entries.length,
    entries,
  };
}

// ==========================================
// 格式检测
// ==========================================

/** 判断是否为 atrium 格式。 */
function looksLikeAtrium(text: string): boolean {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof obj === 'object' && obj !== null) {
    const o = obj as Record<string, unknown>;
    if (o.format === CANONICAL_FORMAT) return true;
    if ('entries' in o && Array.isArray(o.entries)) return true;
  }
  return false;
}

/** 根据文件内容与文件名推断导入格式。返回 SUPPORTED_FORMATS 之一。 */
export function detectFormat(text: string, filename: string = ''): string {
  const name = (filename || '').toLowerCase();
  if (name.endsWith('.json')) {
    return looksLikeAtrium(text) ? 'atrium' : 'dayone';
  }
  if (name.endsWith('.csv')) return 'csv';
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'markdown';
  if (name.endsWith('.txt')) return 'text';
  // 无扩展名 → 按内容嗅探
  const stripped = text.replace(/^\s+/, '');
  if (stripped.startsWith('{')) {
    return looksLikeAtrium(text) ? 'atrium' : 'dayone';
  }
  if (stripped.startsWith('[')) return 'dayone';
  if (text.slice(0, 500).includes(',') && text.includes('\n')) {
    const firstLine = text.split('\n', 1)[0].trim().toLowerCase();
    if (firstLine.startsWith('date') || firstLine.startsWith('日期') || firstLine.includes(',')) {
      return 'csv';
    }
  }
  if (stripped.startsWith('---') || stripped.startsWith('# ') || text.slice(0, 400).includes('##')) {
    return 'markdown';
  }
  return 'text';
}

// ==========================================
// 各格式 → canonical（导入）
// ==========================================

/** 把各种日期表示（ISO 字符串/时间戳/毫秒时间戳）归一为 YYYY-MM-DD。 */
function normDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const v = Number(value);
  if (!Number.isNaN(v) && typeof value !== 'string') {
    // 秒或毫秒时间戳
    let ts = v;
    if (ts > 1e12) ts = ts / 1000.0;
    const d = new Date(ts * 1000);
    if (!Number.isNaN(d.getTime())) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    return null;
  }
  const s = String(value).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) {
    return `${String(Number(m[1])).padStart(4, '0')}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
  }
  m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})/.exec(s);
  if (m) {
    return `${String(Number(m[1])).padStart(4, '0')}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
  }
  return null;
}

/** 归一化天气。 */
function normWeather(value: unknown): string {
  if (!value) return '晴';
  const key = String(value).trim().toLowerCase();
  return WEATHER_MAP[key] || String(value).trim();
}

/** 归一化标签。 */
function normTags(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.map((t) => String(t)).filter((t) => t.trim());
  }
  if (typeof value === 'string') {
    const parts = value.trim().split(/[,，、\s;；]+/);
    return parts.filter((p) => p);
  }
  return [];
}

/** 确保 content 是富文本 HTML（若为纯文本则包一层 p）。 */
function ensureHtml(content: string): string {
  if (content && !/<[a-zA-Z/]/.test(content)) {
    return `<p>${content}</p>`;
  }
  return content;
}

/** 自建 JSON → canonical（基本为透传，做字段归一与兜底）。 */
export function convertAtriumToCanonical(text: string): CanonicalEntry[] {
  const obj = JSON.parse(text);
  let rawEntries = (obj && typeof obj === 'object' && 'entries' in obj) ? (obj as Record<string, unknown>).entries : obj;
  if (rawEntries && typeof rawEntries === 'object' && !Array.isArray(rawEntries)) {
    rawEntries = [rawEntries];
  }
  if (!Array.isArray(rawEntries)) {
    throw new Error('atrium JSON 中缺少 entries 数组');
  }
  const entries: CanonicalEntry[] = [];
  for (const raw of rawEntries) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const date = normDate(r.date || r.creationDate);
    if (!date) continue;
    const content = String(r.content ?? r.text ?? '');
    entries.push(makeCanonicalEntry(
      date,
      ensureHtml(content),
      normWeather(r.weather),
      normTags(r.tags),
      String(r.created_at ?? r.creationDate ?? '') || null,
      String(r.updated_at ?? r.modifiedDate ?? '') || null,
    ));
  }
  return entries;
}

/** Day One JSON → canonical。Day One 导出为 JSON 数组，或含 entries 键的对象。 */
export function convertDayoneToCanonical(text: string): CanonicalEntry[] {
  const obj = JSON.parse(text);
  let rawEntries = (obj && typeof obj === 'object' && 'entries' in obj) ? (obj as Record<string, unknown>).entries : obj;
  if (rawEntries && typeof rawEntries === 'object' && !Array.isArray(rawEntries)) {
    rawEntries = [rawEntries];
  }
  if (!Array.isArray(rawEntries)) {
    throw new Error('Day One JSON 中缺少 entries 数组');
  }
  const entries: CanonicalEntry[] = [];
  for (const raw of rawEntries) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const date = normDate(r.creationDate || r.modifiedDate || r.date);
    if (!date) continue;
    // Day One 富文本优先用 richContent（HTML），否则用 text（纯文本/Markdown）
    const content = String(r.richContent ?? r.richText ?? r.text ?? '');
    entries.push(makeCanonicalEntry(
      date,
      ensureHtml(content),
      normWeather(r.weather),
      normTags(r.tags),
      String(r.creationDate ?? r.date ?? '') || null,
      String(r.modifiedDate ?? r.date ?? '') || null,
    ));
  }
  return entries;
}

/** 极简 CSV 解析：支持引号包裹字段、含逗号/换行的字段。 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const input = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  while (i < input.length) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === ',') { row.push(field); field = ''; i += 1; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** CSV → canonical。期望表头含 date/日期、content/内容/正文、weather/天气、tags/标签。 */
export function convertCsvToCanonical(text: string): CanonicalEntry[] {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('CSV 缺少表头');
  const header = rows[0].map((h) => h.trim());
  if (rows.length < 2) return [];
  // 字段名归一（英文/中文）
  const colIndex = (name: string[]) => header.findIndex((h) => name.includes(h));
  const dateCol = colIndex(['date', 'Date', '日期', 'creationDate', 'day']);
  const contentCol = colIndex(['content', 'Content', '内容', '正文', 'text', 'note', 'entry']);
  const tagsCol = colIndex(['tags', 'Tags', '标签', 'tag']);
  const weatherCol = colIndex(['weather', 'Weather', '天气']);
  const entries: CanonicalEntry[] = [];
  for (let ri = 1; ri < rows.length; ri++) {
    const row = rows[ri];
    const get = (col: number): string => (col >= 0 && row[col] !== undefined ? row[col] : '');
    const date = normDate(get(dateCol));
    if (!date) continue;
    const content = get(contentCol);
    entries.push(makeCanonicalEntry(
      date,
      content ? `<p>${content}</p>` : '',
      normWeather(get(weatherCol)),
      normTags(get(tagsCol)),
      null,
      null,
    ));
  }
  return entries;
}

/** 极简 YAML frontmatter 解析（key: value 形式）。 */
export function parseFrontmatter(yamlText: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const line of yamlText.split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    const idx = l.indexOf(':');
    if (idx >= 0) {
      const k = l.slice(0, idx).trim().toLowerCase();
      const v = l.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
      meta[k] = v;
    }
  }
  return meta;
}

/** Markdown → canonical。支持两类：
 *   1) 单篇：YAML frontmatter（date/weather/tags）+ 正文
 *   2) 多篇：以 --- 分隔的多个 frontmatter 块。 */
export function convertMarkdownToCanonical(text: string): CanonicalEntry[] {
  const entries: CanonicalEntry[] = [];
  // 按 frontmatter 块切分：---\n yaml \n---\n body
  const blocks = text.split(/^---\s*$/gm);
  // blocks 结构: [前导, yaml, body, yaml, body, ...]
  let i = 1;
  while (i + 1 < blocks.length) {
    const meta = parseFrontmatter(blocks[i]);
    const body = (i + 1 < blocks.length ? blocks[i + 1] : '').trim();
    const date = meta.date || meta['日期'];
    if (date) {
      entries.push(makeCanonicalEntry(
        normDate(date) || date,
        markdownToHtml(body || ''),
        normWeather(meta.weather),
        normTags(meta.tags),
        null,
        null,
      ));
    }
    i += 2;
  }
  // 无 frontmatter → 尝试从首行 # 标题推断日期
  if (!entries.length) {
    const firstHeading = text.split('\n', 1)[0].trim().replace(/^#+\s*/, '').trim();
    const date = normDate(firstHeading);
    if (date) {
      const body = text.split('\n').slice(1).join('\n').trim();
      entries.push(makeCanonicalEntry(date, markdownToHtml(body), '晴', [], null, null));
    }
  }
  return entries;
}

/** 从文件名提取日期。 */
function extractDateFromFilename(filename: string): string {
  const m = /(\d{4})[-/.]?(\d{1,2})[-/.]?(\d{1,2})/.exec(filename || '');
  if (m) {
    return `${String(Number(m[1])).padStart(4, '0')}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
  }
  return '';
}

function getTodayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 纯文本 → canonical。日期来源：首行 date:/日期: 标记，或文件名，否则用今天。 */
export function convertTextToCanonical(text: string, filename: string = ''): CanonicalEntry[] {
  let date: string | null = null;
  const firstLine = text.split('\n', 1)[0].trim();
  const m = /^(?:date|日期)\s*[:：]\s*(.+)$/i.exec(firstLine);
  let body: string;
  if (m) {
    date = normDate(m[1]);
    body = text.split('\n').slice(1).join('\n').trim();
  } else {
    date = normDate(extractDateFromFilename(filename));
    body = text.trim();
  }
  if (!date) date = getTodayStr();
  return [makeCanonicalEntry(date, body ? `<p>${body}</p>` : '', '晴', [], null, null)];
}

// 导入分派表
export type ImportConverter = (text: string, filename?: string) => CanonicalEntry[];

const IMPORT_CONVERTERS: Record<string, ImportConverter> = {
  atrium: convertAtriumToCanonical,
  dayone: convertDayoneToCanonical,
  csv: convertCsvToCanonical,
  markdown: convertMarkdownToCanonical,
  text: convertTextToCanonical,
};

/** 统一导入入口：任意支持的格式 → canonical 条目列表。
 *  返回 { entries, detectedFormat }。sourceFormat 为空时自动检测。 */
export function importToCanonical(
  text: string,
  sourceFormat: string | null = null,
  filename: string = '',
): { entries: CanonicalEntry[]; detectedFormat: string } {
  const fmt = sourceFormat || detectFormat(text, filename);
  const converter = IMPORT_CONVERTERS[fmt];
  if (!converter) {
    throw new Error(`不支持的导入格式: ${fmt}`);
  }
  const entries = fmt === 'text' ? converter(text, filename) : converter(text);
  return { entries, detectedFormat: fmt };
}

// ==========================================
// canonical → 各格式（导出）
// ==========================================

/** canonical → Atrium JSON。 */
export function exportAtrium(entries: CanonicalEntry[]): string {
  return JSON.stringify(buildCanonical(entries), null, 2);
}

/** canonical → Day One JSON（数组）。保留富文本为 richContent，纯文本为 text。 */
export function exportDayone(entries: CanonicalEntry[]): string {
  const out: Array<Record<string, unknown>> = [];
  for (const e of entries) {
    const content = e.content || '';
    const plain = htmlToText(content);
    const item: Record<string, unknown> = {
      creationDate: e.created_at || `${e.date}T09:00:00`,
      text: plain,
      tags: e.tags || [],
      weather: e.weather || '晴',
    };
    if (content && /<[a-zA-Z/]/.test(content)) {
      item.richContent = content;
    }
    out.push(item);
  }
  return JSON.stringify(out, null, 2);
}

/** canonical → CSV。 */
export function exportCsv(entries: CanonicalEntry[]): string {
  const lines: string[] = [];
  lines.push('date,weather,tags,content');
  for (const e of entries) {
    const plain = htmlToText(e.content || '').replace(/"/g, '""');
    lines.push([
      e.date || '',
      e.weather || '',
      (e.tags || []).join('|'),
      `"${plain}"`,
    ].join(','));
  }
  return lines.join('\n');
}

/** canonical → Markdown（每篇一个 frontmatter 块，--- 分隔）。 */
export function exportMarkdown(entries: CanonicalEntry[]): string {
  const parts: string[] = [];
  for (const e of entries) {
    const meta: string[] = [];
    meta.push(`date: ${e.date || ''}`);
    meta.push(`weather: ${e.weather || ''}`);
    if (e.tags && e.tags.length) {
      meta.push(`tags: ${e.tags.join(',')}`);
    }
    const body = htmlToMarkdown(e.content || '');
    parts.push('---\n' + meta.join('\n') + '\n---\n\n' + body);
  }
  return parts.join('\n\n---\n\n');
}

/** canonical → 纯文本。 */
export function exportText(entries: CanonicalEntry[]): string {
  const blocks: string[] = [];
  for (const e of entries) {
    blocks.push(`date: ${e.date || ''}\n\n${htmlToText(e.content || '')}`);
  }
  return blocks.join('\n\n---\n\n');
}

export type ExportConverter = (entries: CanonicalEntry[]) => string;

const EXPORT_CONVERTERS: Record<string, ExportConverter> = {
  atrium: exportAtrium,
  dayone: exportDayone,
  csv: exportCsv,
  markdown: exportMarkdown,
  text: exportText,
};

const EXPORT_EXT: Record<string, string> = {
  atrium: 'json',
  dayone: 'json',
  csv: 'csv',
  markdown: 'md',
  text: 'txt',
};

/** 统一导出入口：canonical 条目列表 → 目标格式文本。 */
export function exportEntries(entries: CanonicalEntry[], targetFormat: string): string {
  const converter = EXPORT_CONVERTERS[targetFormat];
  if (!converter) {
    throw new Error(`不支持的导出格式: ${targetFormat}`);
  }
  return converter(entries);
}

export function exportExtension(targetFormat: string): string {
  return EXPORT_EXT[targetFormat] || 'txt';
}

export function formatLabel(fmt: string): string {
  const labels: Record<string, string> = {
    atrium: 'Atrium 富文本 JSON',
    dayone: 'Day One JSON',
    csv: 'CSV',
    markdown: 'Markdown',
    text: '纯文本',
  };
  return labels[fmt] || fmt;
}