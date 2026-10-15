/**
 * DSH 插件市场（CommonJS）
 *
 * DSH 插件是 npm 包（@deepseek-ai/dsh-*），从 npm registry 搜索接口分页拉取全部。
 * 缓存 10 分钟。
 */
const fs = require('fs');
const path = require('path');
const { getZh } = require('./market-zh');

const SEARCH_ENDPOINT = 'https://registry.npmjs.org/-/v1/search';
const SEARCH_TEXT = '@deepseek-ai';
const PER_PAGE = 250;
const MAX_PAGES = 8;              // 最多拉 8 页（2000 条），够覆盖 @deepseek-ai 全量
const CACHE_TTL_MS = 10 * 60 * 1000;

let CACHE_FILE = null;

function init(storeDir) {
  CACHE_FILE = path.join(storeDir, 'lingya-dsh-market.json');
}

function readCache() {
  try {
    if (CACHE_FILE && fs.existsSync(CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      if (raw && Array.isArray(raw.items) && typeof raw.cachedAt === 'string') return raw;
    }
  } catch (_) {}
  return null;
}

function writeCache(items, now) {
  const cachedAt = new Date(now).toISOString();
  try {
    if (CACHE_FILE) {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify({ cachedAt, items }, null, 2), 'utf-8');
    }
  } catch (_) {}
  return cachedAt;
}

/** 按包名归类 */
function categorize(name) {
  if (/dsh-tool-/.test(name)) return 'tool';               // 给 AI 加工具（最有用）
  if (/-app$/.test(name) || name === '@deepseek-ai/dsh-base' || name === '@deepseek-ai/dsh-sdk-minimal') return 'app'; // 组合包/profile
  if (/dsh-experimental-/.test(name)) return 'experimental'; // 实验性
  if (/dsh-client-/.test(name)) return 'ui';                // 界面组件
  return 'service';                                          // 内部服务/工具库
}

function normalizePkg(obj) {
  const p = obj && obj.package;
  if (!p || typeof p.name !== 'string') return null;
  // 保留所有 @deepseek-ai/dsh* 包
  if (!/^@deepseek-ai\/dsh(?:-|$)/.test(p.name)) return null;
  const zh = getZh(p.name);
  return {
    name: p.name,
    version: (p.version || '').trim(),
    description: p.description || '',
    descriptionZh: zh || '',          // 中文描述（未收录为空）
    descriptionEn: p.description || '',
    date: p.date || '',
    links: p.links || {},
    publisher: (p.publisher && p.publisher.username) || '',
    category: categorize(p.name),
  };
}

function buildUrl(from) {
  return SEARCH_ENDPOINT + '?text=' + encodeURIComponent(SEARCH_TEXT) + '&size=' + PER_PAGE + '&from=' + (from || 0);
}

/** 分页拉取全部 dsh 包 */
async function fetchAll() {
  const seen = new Map();
  let pageError = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    let res;
    try {
      res = await fetch(buildUrl(page * PER_PAGE), { headers: { 'Accept': 'application/json' } });
    } catch (err) {
      pageError = '网络失败：' + (err && err.message ? err.message : String(err));
      break;
    }
    if (!res.ok) { pageError = 'npm registry 返回 HTTP ' + res.status; break; }
    let data;
    try { data = await res.json(); } catch (err) { pageError = '响应解析失败：' + err.message; break; }
    const objs = (data && Array.isArray(data.objects)) ? data.objects : [];
    for (const o of objs) {
      const it = normalizePkg(o);
      if (it && !seen.has(it.name)) seen.set(it.name, it);
    }
    if (objs.length < PER_PAGE) break; // 最后一页
  }
  return { items: Array.from(seen.values()), error: pageError };
}

/**
 * 搜索 DSH 插件（npm registry，分页拉全）。
 * @param {{force?: boolean, now?: number}} [opts]
 */
async function search(opts) {
  opts = opts || {};
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  if (!opts.force) {
    const cache = readCache();
    if (cache) {
      const age = now - Date.parse(cache.cachedAt);
      if (Number.isFinite(age) && age >= 0 && age < CACHE_TTL_MS) {
        return { success: true, items: cache.items, fromCache: true, cachedAt: cache.cachedAt };
      }
    }
  }

  const { items, error } = await fetchAll();

  if (items.length === 0 && error) {
    const stale = readCache();
    if (stale) return { success: true, items: stale.items, fromCache: true, cachedAt: stale.cachedAt, error };
    return { success: false, items: [], fromCache: false, error };
  }

  const cachedAt = writeCache(items, now);
  return { success: true, items, fromCache: false, cachedAt, error: error || undefined };
}

module.exports = { init, search, categorize };
