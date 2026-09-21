/**
 * Web 搜索工具 - 移植自 deepseek-pp 的 web_search
 * 通过抓取 Bing 搜索结果页解析标题/URL/摘要，无需 API key。
 */
const { Tool, ToolResult } = require('./ToolRegistry');

const DOMAINS = ['cn.bing.com', 'www.bing.com'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * 解析 Bing 搜索结果（移植自 deepseek-pp parseBingResults）
 */
function parseBingResults(html, topK) {
  const results = [];
  const algoRegex = /<li[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let match;
  while ((match = algoRegex.exec(html)) !== null && results.length < topK) {
    const block = match[1];
    const titleLink = /<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/i.exec(block);
    if (!titleLink) continue;
    let url = titleLink[1];
    const title = stripHtml(titleLink[2]).replace(/\s+/g, ' ').trim();
    const captionBlock = /<div[^>]*class="[^"]*\bb_caption\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
    let snippet = '';
    if (captionBlock) {
      const paraText = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(captionBlock[1]);
      snippet = paraText
        ? stripHtml(paraText[1]).replace(/\s+/g, ' ').trim()
        : stripHtml(captionBlock[1]).replace(/\s+/g, ' ').trim();
    }
    if (url.startsWith('//')) url = 'https:' + url;
    if (title && url) results.push({ title, url, snippet });
  }
  return results.slice(0, topK);
}

async function bingSearch(domain, query, topK) {
  const url = 'https://' + domain + '/search?q=' + encodeURIComponent(query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(domain + ' 返回状态 ' + resp.status);
    const html = await resp.text();
    if (html.length < 200) throw new Error(domain + ' 返回内容过短，可能被拦截');
    return parseBingResults(html, topK);
  } finally {
    clearTimeout(timer);
  }
}

class WebSearchTool extends Tool {
  constructor() {
    super(
      'web_search',
      '搜索互联网，返回相关网页的标题、URL 和摘要。用于获取实时信息、事实核验或查找来源。',
      {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          topK: { type: 'integer', description: '返回结果数量（1-10，默认 5）' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      'webSearch(query, { topK })'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:web_search',
      order: 130,
      text: [
        '## 联网搜索',
        '',
        '当需要实时信息、事实核验或查找来源时，调用 webSearch(query, { topK }) 搜索互联网。',
        '搜索结果会返回标题、URL 和摘要，可据此判断是否需要进一步用 webFetch(url) 获取网页正文。',
        '如果一次搜索不够，可以继续用不同关键词多次调用。',
      ].join('\n'),
    };
  }

  async execute(params) {
    const query = params && typeof params.query === 'string' ? params.query.trim() : '';
    if (!query) return ToolResult.error('query 不能为空');
    const topK = params && typeof params.topK === 'number'
      ? Math.min(Math.max(1, Math.floor(params.topK)), 10)
      : 5;

    let lastError = null;
    for (const domain of DOMAINS) {
      try {
        const results = await bingSearch(domain, query, topK);
        if (results.length === 0) {
          lastError = domain + ' 未返回可解析结果';
          continue;
        }
        const lines = results.map((r, i) => (i + 1) + '. ' + r.title + '\n   ' + r.url + '\n   ' + r.snippet);
        console.log('[WebSearchTool] 搜索完成: ' + query + ' -> ' + results.length + ' 条');
        return ToolResult.success('找到 ' + results.length + ' 条结果：\n\n' + lines.join('\n\n'));
      } catch (err) {
        lastError = err.message;
      }
    }
    return ToolResult.error('搜索失败: ' + (lastError || '未知错误'));
  }
}

module.exports = { WebSearchTool, parseBingResults };
