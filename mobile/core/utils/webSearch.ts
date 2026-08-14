/**
 * webSearch.ts — 手机端联网搜索工具（TypeScript 重写）
 *
 * 逐字等价复刻 Python 版 server/web_search_tool.py：
 *  - 通过私有化 SearXNG 实例的 JSON API 搜索，供 Function Calling 使用
 *  - 翻多页取更多结果，按标题/URL 去重
 *  - 保留来源引擎、域名、发布时间、相关性评分，供 AI 做多源交叉验证
 *  - 时效倾向查询按发布时间过滤旧结果
 *
 * 说明：SearXNG 地址在手机端通过 setSearxngBaseUrl 配置（默认 http://127.0.0.1:8888），
 *       与 Python 版环境变量 SEARXNG_BASE_URL 对应。
 */

// SearXNG JSON API 地址（可通过 setSearxngBaseUrl 覆盖）
let SEARXNG_BASE_URL = 'http://127.0.0.1:8888';

export function setSearxngBaseUrl(url: string): void {
  SEARXNG_BASE_URL = url || 'http://127.0.0.1:8888';
}

export function getSearxngBaseUrl(): string {
  return SEARXNG_BASE_URL;
}

/**
 * 从 Ollama 地址推导同一机器的 SearXNG 地址。
 * 手机端 Ollama 与 SearXNG 都跑在电脑上，当用户把 Ollama 配置为电脑的
 * 局域网/公网地址后，搜索服务应指向同一主机（默认 8888 端口），
 * 避免手机端仍用 127.0.0.1（指向手机自身）导致联网搜索失效。
 *
 * 注意：如果 Ollama 地址是 Cloudflare 隧道（trycloudflare.com 域名），
 * 则不做自动推导——因为 Cloudflare 隧道是按子域名区分服务，不是按端口，
 * 自动加 :8888 端口会导致搜索地址错误。这种情况下保持原有地址不变。
 */
export function deriveSearxngUrl(ollamaUrl: string): string {
  const u = (ollamaUrl || '').trim();
  const m = /^https?:\/\/([^/?#]+)/i.exec(u);
  if (!m) return SEARXNG_BASE_URL; // 无法解析时保留当前地址，不强制覆盖
  const host = m[1].replace(/:\d+$/, '');
  // Cloudflare 隧道：按子域名区分服务，不能用端口推导，保持原有搜索地址
  if (/trycloudflare\.com$/i.test(host)) {
    return SEARXNG_BASE_URL;
  }
  // ngrok 等其他隧道域名同理
  if (/ngrok\.io$|ngrok-free\.app$/i.test(host)) {
    return SEARXNG_BASE_URL;
  }
  const scheme = /^http:/i.test(u) ? 'http' : 'https';
  return `${scheme}://${host}:8888`;
}

// 工具 schema：喂给 LLM，让 AI 自主判断是否需要联网搜索
export function formatSearchResults(results: Array<Record<string, unknown>>, maxItems: number = 300): string {
  if (!results || !results.length) return '';
  const lines: string[] = [];
  for (let i = 0; i < Math.min(results.length, maxItems); i++) {
    const r = results[i];
    const title = String(r.title || '').trim();
    const content = String(r.content || '').trim();
    const domain = String(r.domain || '');
    const engines = (r.engines as string[] || []).join(',') || '';
    const pub = String(r.published_date || '');
    const metaBits: string[] = [];
    if (domain) metaBits.push(`来源:${domain}`);
    if (engines) metaBits.push(`引擎:${engines}`);
    if (pub) metaBits.push(`发布:${pub}`);
    const meta = metaBits.length ? `（${metaBits.join(' │ ')}）` : '';
    lines.push(`${i + 1}. ${title}: ${content.slice(0, 150)}${meta}`);
  }
  const crossCheck =
    '\n\n【信息可信度判断】\n' +
    '- 同一事实被多个互相独立来源（不同域名）一致提及，才可作为可靠事实引用。\n' +
    '- 仅来自单一来源、或不同来源说法互相矛盾的信息，属于存疑信息，必须明确标注『这一说法未经多方证实』，并说明分歧所在，绝不能当作既定事实陈述。\n' +
    '- 同一网址/域名被重复提及，不增加可信度，勿把它当作多源交叉验证。';
  const cite =
    '\n\n【引用标注规则】\n' +
    '- 上面每条结果前面的数字序号就是它的引用编号。\n' +
    '- 在正式回答中，凡是你引用了某条来源的信息，就在该句/该处结尾紧跟一个带方括号的上标序号标注，例如：xxx[1]，xxx[2]。\n' +
    '- 必须只标注你实际依据的来源；一处引用多条来源时写成 [1][2] 或 [3][4]。\n' +
    '- 同一来源被多次引用时始终用同一个编号。\n' +
    '- 纯情绪回应、闲聊、或未引用任何搜索结果时，不要加任何角标。';
  return lines.join('\n') + crossCheck + cite;
}

export const SEARCH_TOOL_SCHEMA = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      '在互联网上搜索信息。以下情况必须调用此工具：\n1. 事实核验——需要确认某说法、某事件是否属实\n2. 时事信息——新闻、热点、最新动态、政策变化、价格行情、版本更新等\n3. 用户明示或暗示要求联网搜索——如"帮我查一下""最新的""现在是什么情况""是真的吗"等\n4. 超出自身知识范围的问题\n5. 时效性强且自身知识可能过时的问题\n日常闲聊、情绪倾诉、基于日记的共情回应无需搜索。注意：查询词应尽量具体，在核心词后补充必要的限定词以消除歧义（例如搜网络热梗要带上出处如\'某节目/某圈子\'，搜人名要带上关键前缀），避免只用过于笼统的单字词。搜索会返回多个来源的结果并附带来源域名与搜索引擎；若你发现不同来源说法不一致，或关键事实仅来自单一小众来源，可再次调用本工具用不同关键词做交叉验证。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '要在互联网上搜索的关键词，必须是精简的关键词组合，用空格分隔。去掉口语化虚词（什么、那个、这个、就是）、疑问词（吗、呢、怎么）、语气词，不要用完整句子。例如：用户说"最近那个什么 AI 写代码的叫什么 Copilot" → query 应为"AI 写代码工具 Copilot"。若用户原话过于笼统，请补全必要的限定信息。',
        },
      },
      required: ['query'],
    },
  },
};

/** 从 URL 提取主域名（去除 www. 前缀），用于判断来源多样性。 */
function extractDomain(url: string): string {
  try {
    const match = /^[a-z]+:\/\/([^/?#]+)/i.exec(url);
    let host = match ? match[1].toLowerCase() : '';
    if (host.startsWith('www.')) host = host.slice(4);
    return host;
  } catch {
    return '';
  }
}

/** 标题规范化，用于去重。 */
function normalizeTitle(title: string): string {
  if (!title) return '';
  const t = title.replace(/[\s\-_|\u2502，。！？、；：,.!?;:()（）\[\]【】"'“”‘’/\\]/g, '');
  return t.toLowerCase().slice(0, 60);
}

// 时效敏感词：命中即认为该查询需要"尽量新"的信息，用于按发布时间过滤旧结果
const RECENCY_KEYWORDS = [
  '最近', '近期', '最新', '最新消息', '热点', '热搜', '新闻', '时事',
  '今天', '今日', '本周', '本月', '今年', '当下', '目前', '现在', '当下',
  '刚刚', '现场', '突发', 'recent', 'latest', 'today', 'this week',
  'this month', 'breaking', 'news', 'update',
];

/** 判断查询是否带有明显时效倾向（应优先返回新结果）。 */
function looksTimeSensitive(query: string): boolean {
  const q = (query || '').toLowerCase();
  return RECENCY_KEYWORDS.some((k) => q.includes(k));
}

/** 把 published_date 字符串解析为 Date；解析失败返回 null。 */
function parsePubDate(s: unknown): Date | null {
  if (!s) return null;
  const text = String(s).trim();
  const fmts = ['YYYY-MM-DD HH:mm:ss', 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD', 'YYYY/MM/DD'];
  for (const fmt of fmts) {
    const d = parseDateFmt(text, fmt);
    if (d) return d;
  }
  return null;
}

function parseDateFmt(text: string, fmt: string): Date | null {
  const tokens = fmt.split(/[^YMDHms]+/);
  const parts = text.split(/[^0-9]+/).filter(Boolean);
  if (tokens.length !== parts.length) return null;
  const map: Record<string, number> = {};
  for (let i = 0; i < tokens.length; i++) {
    map[tokens[i].slice(0, 1)] = Number(parts[i]);
  }
  const d = new Date(
    map.Y || 0,
    (map.M || 1) - 1,
    map.D || 1,
    map.H || 0,
    map.m || 0,
    map.s || 0,
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 时效过滤：对明显带时效倾向的查询，剔除发布时间明确且过旧的结果。
 *
 *  规则保持宽松（宁可多留，不漏信息）：
 *    - 没有 published_date 的结果一律保留（无法判断新旧，不误杀）。
 *    - 发布时间明确且超过 fresh_days 的旧结果被剔除。
 *    - 若剔除后列表为空，则回退为全量结果，避免把可用的旧信息也丢掉。
 */
function filterRecent(results: Array<Record<string, unknown>>, freshDays: number = 90): Array<Record<string, unknown>> {
  if (!results || !results.length) return results;
  const cutoff = Date.now() - freshDays * 24 * 3600 * 1000;
  const kept = results.filter((r) => {
    const pub = parsePubDate(r.published_date);
    return !pub || pub.getTime() >= cutoff;
  });
  return kept.length ? kept : results;
}

/** 调用 SearXNG JSON API 执行搜索，返回去重后的结果列表。
 *
 *  翻 pages 页取更多结果，按规范化标题去重，并保留来源信息：
 *    { title, url, content, domain, engines, score, published_date }
 *  搜索失败时返回空列表（不阻断主流程）。
 */
export async function webSearch(query: string, maxResults: number = 30, pages: number = 3): Promise<Array<Record<string, unknown>>> {
  if (!query) return [];
  // 手机端 127.0.0.1 指向手机自身，SearXNG 运行在电脑上 → 必然不可达，直接抛错避免 10s 超时
  if (/^http:\/\/127\.0\.0\.1:8888\/?$/.test(SEARXNG_BASE_URL)) {
    throw new Error('搜索服务地址未配置，请在设置中填写搜索服务公网地址（如 http://电脑IP:8888）');
  }
  const seen = new Map<string, Record<string, unknown>>();
  // 15 秒超时，避免 SearXNG 地址错误或网络不稳时一直卡住
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  // 检测查询是否含中文，含中文时指定语言为 zh 以提高中文搜索结果质量
  const hasChinese = /[\u4e00-\u9fff]/.test(query);
  const langParam = hasChinese ? '&language=zh-CN' : '';
  try {
    for (let page = 1; page <= pages; page++) {
      const url = `${SEARXNG_BASE_URL}/search?q=${encodeURIComponent(query)}&format=json&pageno=${page}&safesearch=0${langParam}`;
      const resp = await fetch(url, { method: 'GET', signal: controller.signal });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const data = await resp.json();
      const results = (data && data.results) || [];
      const resultsArr = Array.isArray(results) ? results : [];
      for (const r of resultsArr) {
        const title = String(r.title || '').trim();
        const url2 = String(r.url || '').trim();
        const content = String(r.content || '').trim();
        if ((!title && !content) || !url2) continue;
        const key = normalizeTitle(title) || url2;
        if (seen.has(key)) continue;
        seen.set(key, {
          title,
          url: url2,
          content,
          domain: extractDomain(url2),
          engines: (r.engines as unknown[]) || (r.engine ? [r.engine] : []),
          score: r.score,
          published_date: r.publishedDate || '',
        });
      }
      if (seen.size >= maxResults) break;
      if (!resultsArr.length) break;
    }
    // 按相关性评分降序，再截断到 maxResults
    let out = Array.from(seen.values())
      .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
      .slice(0, maxResults);
    // 时效倾向查询：剔除发布时间明确且过旧的旧闻，避免 AI 拿到过时信息
    if (looksTimeSensitive(query)) {
      const filtered = filterRecent(out);
      out = filtered;
    }
    return out;
  } catch (e: any) {
    // 重新抛出错误，让调用方（executeSearch）能区分"搜索失败"和"无结果"
    // 避免静默返回空数组导致 UI 显示 search_skip（瞬间消失）而非 search_error
    if (e?.name === 'AbortError') {
      throw new Error(`SearXNG 搜索超时（${SEARXNG_BASE_URL}）：15秒未响应`);
    } else {
      throw new Error(`SearXNG 搜索失败（${SEARXNG_BASE_URL}）：${e?.message || String(e)}`);
    }
  } finally {
    clearTimeout(timeoutId);
  }
}