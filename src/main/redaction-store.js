/**
 * 脱敏映射存储（2026-11-02）
 *
 * 双向脱敏：
 *   正向（preload → 网页端）：真词 → 占位符 ⟦项目A⟧
 *   反向（网页端 → 工具）：占位符 ⟦项目A⟧ → 真词
 *
 * 存储文件：<userData>/lingya-redaction.json
 *
 * 【设计原则】
 * 1. 占位符用 ⟦ ⟧ 包裹（U+27E6 / U+27E7），几乎是零碰撞的特殊符号。
 * 2. 每条规则 = { name, words[], desc, enabled, source, scope }。
 *    - name：占位符内容，如 "项目A"
 *    - words：命中的真词列表（多对一）
 *    - desc：给 AI 看的描述（不含真词）
 *    - enabled：是否启用
 *    - source：'manual'（用户手动加）| 'auto'（AI 扫描自动加）
 *    - scope：'global'（全链路生效）| 'memory-only'（只影响记忆检索）
 *    auto 规则默认 memory-only，防止误伤用户输入；manual 默认 global。
 * 3. 存储格式：{ version: 2, rules: [...] }
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const storeEvents = new EventEmitter();

let storePath = null;

function getStorePath() {
  if (storePath) return storePath;
  try {
    const { app } = require('electron');
    storePath = path.join(app.getPath('userData'), 'lingya-redaction.json');
  } catch (_) {
    storePath = path.join(process.cwd(), 'lingya-redaction.json');
  }
  return storePath;
}

/** 通用词黑名单：这些词不加脱敏规则（避免正常对话被误伤） */
const COMMON_WORDS = new Set([
  '上传', '下载', '接口', '文件', '脚本', '数据', '批量', '自动', '配置', '部署',
  '测试', '文档', '日志', '服务', '客户端', '服务器', '请求', '响应', '解析',
  '登录', '注册', '账号', '密码', '权限', '管理', '用户', '系统', '平台', '功能',
  '模块', '函数', '变量', '类', '对象', '数组', '字符串', '数字', '布尔',
  '项目', '任务', '工具', '流程', '进度', '状态', '结果', '输出', '输入',
  '文件上传', '文件下载', '错误', '异常', '提示', '消息', '通知', '记录',
  '创建', '删除', '修改', '查询', '更新', '同步', '导入', '导出', '备份'
]);

/** 默认规则表（仅首次启动写入；用户可增删改） */
const DEFAULT_RULES = {
  version: 2,
  rules: [
    { name: '项目A', words: ['bdwkup'], desc: '一个百度文库相关的自动化项目', enabled: true, source: 'manual', scope: 'global' },
    { name: '项目B', words: ['wenku_sim'], desc: '一个文库上传工具包', enabled: true, source: 'manual', scope: 'global' },
    { name: '项目C', words: ['acmcoder', 'eztest', 'joytest'], desc: '一个在线考试平台相关工具', enabled: true, source: 'manual', scope: 'global' },
    { name: '操作1', words: ['养号', '账号养护'], desc: '账号维护流程', enabled: true, source: 'manual', scope: 'global' },
    { name: '操作2', words: ['a_bogus', 'abogus'], desc: '某平台接口的签名参数', enabled: true, source: 'manual', scope: 'global' },
    { name: '操作3', words: ['爬虫', '抓取接口', '接口逆向'], desc: '数据获取相关工作', enabled: true, source: 'manual', scope: 'global' },
    { name: '操作4', words: ['风控', '限流', '封号'], desc: '平台限制相关内容', enabled: true, source: 'manual', scope: 'global' },
    { name: '操作5', words: ['番茄签署', '批量签署'], desc: '批量合同操作', enabled: true, source: 'manual', scope: 'global' }
  ]
};

/** 快速脱敏密文生成默认配置（2026-11-06） */
const DEFAULT_QUICK_GEN = {
  charset: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
  length: 6,
  filterConfusable: true
};

/** 易混字符：默认过滤，降低 AI 抄错率 */
const CONFUSABLE_CHARS = /[0O1IL]/g;

let cache = null;
let _watcher = null;
let _watchDebounce = null;
let _isPersisting = false;

/**
 * 启动文件监听（只在第一次获取路径时启动）
 */
function startWatcher() {
  if (_watcher) return;
  const p = getStorePath();
  try {
    // fs.watch 在某些平台/网络盘上可能不触发，但不影响主流程
    _watcher = fs.watch(p, (eventType) => {
      // 忽略自己 persist 写文件触发的事件
      if (_isPersisting) return;
      if (eventType === 'change' || eventType === 'rename') {
        // 防抖：文件系统可能在 100ms 内触发多次事件
        if (_watchDebounce) clearTimeout(_watchDebounce);
        _watchDebounce = setTimeout(() => {
          _watchDebounce = null;
          console.log('[脱敏] 检测到规则文件被外部修改，自动刷新内存缓存');
          cache = null; // 清空内存缓存
          try { storeEvents.emit('changed'); } catch (_) {}
        }, 200);
      }
    });
    _watcher.unref(); // 不阻止进程退出
    // 【2026-11-06 审计 #10】watcher 生命周期加日志，便于排查「改了规则不生效」
    console.log('[脱敏] 已启动规则文件监听: ' + p);
    // 2026-11-06: 防止测试环境或文件被删除时抛出的 EPERM 导致未捕获异常
    _watcher.on('error', (err) => {
      // 静默处理，不阻断主流程，但记录以便排查
      console.warn('[脱敏] 规则文件监听出错，将关闭 watcher:', err && err.message);
      if (_watcher) {
        try { _watcher.close(); } catch (_) {}
        _watcher = null;
      }
    });
  } catch (err) {
    console.warn('[脱敏] 无法监听规则文件变化:', err.message);
  }
}

function ensureLoaded() {
  if (cache) return cache;
  // 2026-11-05: 加载完成后检查关键工具名（围栏标识 + 工具函数名）是否被脱敏。
  // 这些词被脱敏后会导致 js-detector 识别不到代码块、JsRunner 执行报未定义。
  // 只在首次加载时警告一次，不阻止任何操作。
  var _warnToolNamesOnce = false;
  function warnToolNameRules(){
    if (_warnToolNamesOnce) return;
    _warnToolNamesOnce = true;
    try {
      var RISKY = ['lingya','read','readLines','write','edit','glob','grep','bash','pwsh','todoWrite','deleteFile','webFetch','webSearch','viewImage','mysql','nameConversation','purge','bashBackground','bashOutput','bashKill','injectJs','mcpCall']
      var hits = [];
      for (var i = 0; i < (cache.rules || []).length; i++) {
        var r = cache.rules[i];
        if (r.enabled === false) continue;
        for (var j = 0; j < (r.words || []).length; j++) {
          var w = String(r.words[j] || '');
          if (RISKY.indexOf(w) >= 0) hits.push(r.name + ' <- ' + w);
        }
      }
      if (hits.length > 0) {
        console.warn('[脱敏] ⚠️ 规则表含 ' + hits.length + ' 条会破坏工具调用的词：' + hits.join(' , '));
        console.warn('[脱敏] ⚠️ 这些词被脱敏后，js-detector 可能识别不到代码块，JsRunner 可能报「xxx is not defined」。');
        console.warn('[脱敏] ⚠️ 如果遇到工具不执行/任务提前结束，请到「设置 → 脱敏规则」删掉这些规则。');
      }
    } catch (e) { /* 警告失败不影响加载 */ }
  }
  const p = getStorePath();
  startWatcher();
  try {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8');
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.rules)) {
        // 兼容旧版（v1 没有 source/scope），自动补默认值
        const normalized = [];
        let migrated = false;
        for (const r of data.rules) {
          const words = Array.isArray(r.words) ? r.words.slice() : [];
          const base = {
            name: r.name,
            words: words,
            desc: r.desc || '',
            enabled: r.enabled !== false,
            source: r.source || 'manual',
            scope: r.scope || 'global'
          };
          // 【审计修复 2026-11-02】多词规则自动拆分（防止反向还原丢失语义）
          if (words.length > 1) {
            migrated = true;
            for (let i = 0; i < words.length; i++) {
              normalized.push({
                name: r.name + '_' + (i + 1),
                words: [words[i]],
                desc: (r.desc || '') + ' (' + (i + 1) + '/' + words.length + ')',
                enabled: base.enabled,
                source: base.source,
                scope: base.scope
              });
            }
          } else {
            normalized.push(base);
          }
        }
        data.rules = normalized;
        cache = data;
  try { warnToolNameRules(); } catch (_) {}
        if (migrated) {
          console.log('[Redaction] 已迁移多词规则（拆分为单词语义）');
          persist();
        }
        return cache;
      }
    }
  } catch (err) {
    console.warn('[Redaction] 读取规则文件失败，使用默认:', err.message);
  }
  cache = JSON.parse(JSON.stringify(DEFAULT_RULES));
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cache, null, 2), 'utf-8');
    console.log('[Redaction] 已初始化默认规则表:', p);
  } catch (err) {
    console.warn('[Redaction] 写入默认规则表失败:', err.message);
  }
  return cache;
}

function listRules() {
  const data = ensureLoaded();
  return (data.rules || []).map((r) => ({
    name: r.name,
    words: Array.isArray(r.words) ? r.words.slice() : [],
    desc: r.desc || '',
    enabled: r.enabled !== false,
    source: r.source || 'manual',
    scope: r.scope || 'global'
  }));
}

/** 只取启用的规则，供脱敏引擎用；scopeFilter 为 null=全部，'global'=只拿全局 */
function getActiveRules(scopeFilter) {
  const all = listRules().filter((r) => r.enabled);
  if (!scopeFilter) return all;
  if (scopeFilter === 'global') return all.filter((r) => r.scope === 'global');
  return all.filter((r) => r.scope === scopeFilter);
}

/**
 * 危险真词护栏：这些词一旦进规则表会污染代码，导致工具调用失败。
 *
 * 【为什么必须拦】脱敏是纯子串替换，且出站方向生效。
 * 短词 / 通用词被脱后，工具结果回传里出现占位符，AI 把它当真词照抄进
 * 代码块 → 语法错误 / 文件找不到 → 任务中断。实测 'js' 一条就能毁掉所有
 * glob/grep 调用（*.js 变成 *.⟦占位符⟧）。
 */
const DANGEROUS_WORDS = new Set([
  // 文件扩展名 / 语言标识
  'js', 'ts', 'jsx', 'tsx', 'json', 'md', 'txt', 'yml', 'yaml', 'css', 'html',
  'exe', 'dll', 'log', 'lock', 'map', 'node', 'npm',
  // JS 关键字 / 内置对象
  'await', 'async', 'const', 'let', 'var', 'return', 'function', 'class', 'new',
  'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'try',
  'catch', 'finally', 'throw', 'typeof', 'instanceof', 'delete', 'void', 'this',
  'true', 'false', 'null', 'undefined', 'require', 'module', 'exports', 'process',
  'console', 'string', 'number', 'boolean', 'object', 'array', 'error',
  // 工具函数名 / 参数名
  'read', 'write', 'edit', 'glob', 'grep', 'bash', 'pwsh', 'log', 'include',
  'path', 'title', 'offset', 'limit', 'name', 'content', 'params', 'result',
]);

/** 规则词护栏检查，返回错误信息或 null */
function checkWordSafe(word) {
  // 2026-11-05: 用户要求取消所有导入限制——不再拒绝代码通用词和短词。
  // 历史背景：原实现会拒绝 const/js/read/title 等 80+ 个代码词和 ≤2 字符词。
  // 实际使用中用户需要脱敏 const 这类词（配合入站还原，工具调用不受影响）。
  // 保留函数签名（addRule / importRules 两个调用点不报错），但永远返回 null。
  //
  // ⚠️ 副作用警告（保留在此供后来者查阅）：
  //   加 js 进规则表 → 所有 *.js 路径变占位符，glob/grep 全废
  //   加 read/write 进规则表 → 工具函数名被脱敏，代码块里的 await read(...) 失效
  //   加 title/name/content → 工具参数字段名被脱敏，参数传不进去
  //   如果真遇到工具失效，去面板删掉对应规则即可。
  return null;
}

function addRule(rule) {
  const data = ensureLoaded();
  if (!rule || !rule.name) throw new Error('规则必须有 name');
  const words = Array.isArray(rule.words) ? rule.words.map(String) : [];
  if (words.length === 0) throw new Error('真词列表不能为空');
  for (const w of words) {
    const bad = checkWordSafe(w);
    if (bad) throw new Error(bad);
  }

  // 【审计修复 2026-11-02】多词自动拆成多条规则
  // 为什么：一占位符对多词时，反向还原（AI 传参 → 工具）无法确定用哪个词，
  // 会全部还原成 words[0]，导致语义丢失（实测 acmcoder+eztest → 都变成 acmcoder）。
  // 拆成多条：⟦项目C_1⟧ → acmcoder, ⟦项目C_2⟧ → eztest, ... 100% 可逆。
  const out = [];
  if (words.length === 1) {
    out.push(applyOne(rule.name, words[0], rule));
  } else {
    const baseName = String(rule.name);
    for (let i = 0; i < words.length; i++) {
      const subName = baseName + '_' + (i + 1);
      const subDesc = (rule.desc || '') + ' (' + (i + 1) + '/' + words.length + ')';
      out.push(applyOne(subName, words[i], { ...rule, desc: subDesc }));
    }
    // 如果原 name 已存在（旧的多词规则），删掉它
    const oldIdx = (data.rules || []).findIndex((r) => r.name === baseName);
    if (oldIdx >= 0) data.rules.splice(oldIdx, 1);
  }
  persist();
  return words.length === 1 ? out[0] : out;
}

/**
 * 读取快速脱敏配置（缺字段时用默认值补齐）。
 * 只读不写：调用方拿到即可用。
 */
function getQuickGenConfig() {
  const data = ensureLoaded();
  const raw = data.quickGen || {};
  // 只允许大写字母 + 数字，其余字符一律过滤，避免破坏 ⟦⟧ 占位符格式
  let charset = String(raw.charset == null ? DEFAULT_QUICK_GEN.charset : raw.charset)
    .replace(/[^A-Z0-9]/g, '');
  // 字符表被清空时回退默认，否则无法生成
  if (!charset) charset = DEFAULT_QUICK_GEN.charset;
  let length = parseInt(raw.length, 10);
  if (!Number.isFinite(length)) length = DEFAULT_QUICK_GEN.length;
  // 夹到 3~16：低于 3 碰撞率高，高于 16 AI 抄错率飙升
  length = Math.max(3, Math.min(16, length));
  const filterConfusable = raw.filterConfusable !== false;
  return { charset, length, filterConfusable };
}

/**
 * 更新快速脱敏配置（部分字段更新）。
 * @returns {{ ok: boolean, config: object }}
 */
function updateQuickGenConfig(patch) {
  const data = ensureLoaded();
  const cur = getQuickGenConfig();
  const next = { ...cur };
  if (patch && typeof patch === 'object') {
    if (patch.charset != null) {
      const cleaned = String(patch.charset).replace(/[^A-Z0-9]/g, '');
      if (!cleaned) throw new Error('字符表过滤后为空，至少保留一个大写字母或数字');
      next.charset = cleaned;
    }
    if (patch.length != null) {
      const n = parseInt(patch.length, 10);
      if (!Number.isFinite(n)) throw new Error('长度必须是数字');
      if (n < 3 || n > 16) throw new Error('长度必须在 3~16 之间');
      next.length = n;
    }
    if (patch.filterConfusable != null) next.filterConfusable = !!patch.filterConfusable;
  }
  data.quickGen = next;
  persist();
  return { ok: true, config: next };
}

/**
 * 快速脱敏：只给真词，自动生成随机密文作为占位符名。
 * 密文按 quickGen 配置生成（字符表 + 长度 + 易混字符过滤）。
 * @param {string} word 真词
 * @returns {{ name: string, words: string[], desc: string, enabled: boolean, source: string, scope: string }}
 */
function addQuickRule(word) {
  const data = ensureLoaded();
  const w = String(word == null ? '' : word).trim();
  if (!w) throw new Error('真词不能为空');

  // 已存在同一真词的规则 → 直接返回，避免重复建（幂等）
  const existed = (data.rules || []).find(
    (r) => r.enabled !== false && Array.isArray(r.words) && r.words.length === 1 && r.words[0] === w
  );
  if (existed) return { ...existed, reused: true };

  const cfg = getQuickGenConfig();
  let charset = cfg.charset;
  if (cfg.filterConfusable) {
    charset = charset.replace(CONFUSABLE_CHARS, '');
    // 过滤后若空了（用户字符表全是易混字符），回退到默认表的过滤结果
    if (!charset) charset = DEFAULT_QUICK_GEN.charset.replace(CONFUSABLE_CHARS, '');
  }
  if (!charset) throw new Error('字符表为空，无法生成密文');

  const usedNames = new Set((data.rules || []).map((r) => r.name));
  let code = '';
  let attempts = 0;
  do {
    code = '';
    for (let i = 0; i < cfg.length; i++) {
      code += charset[Math.floor(Math.random() * charset.length)];
    }
    attempts++;
    // 极端情况下防死循环（字符空间太小 + 规则太多）
    if (attempts > 5000) throw new Error('密文空间不足，请加长密文长度或扩充字符表');
  } while (usedNames.has(code));

  const rule = applyOne(code, w, {
    desc: '',
    enabled: true,
    source: 'manual',
    scope: 'global'
  });
  persist();
  return rule;
}

/** 辅助：应用单条规则到 data（内部用） */
function applyOne(name, word, rule) {
  const data = ensureLoaded();
  const idx = (data.rules || []).findIndex((r) => r.name === name);
  const normalized = {
    name: String(name),
    words: [String(word)],
    desc: String(rule.desc || ''),
    enabled: rule.enabled !== false,
    source: rule.source === 'auto' ? 'auto' : 'manual',
    scope: rule.scope === 'memory-only' ? 'memory-only' : 'global'
  };
  if (idx >= 0) {
    data.rules[idx] = normalized;
  } else {
    data.rules = data.rules || [];
    data.rules.push(normalized);
  }
  return normalized;
}

function updateRule(name, patch) {
  const data = ensureLoaded();
  const idx = (data.rules || []).findIndex((r) => r.name === name);
  if (idx < 0) throw new Error('规则不存在: ' + name);
  const cur = data.rules[idx];
  // 只允许改 words/desc/enabled/scope，不允许改 name/source
  if (patch.words) cur.words = patch.words.map(String);
  if (patch.desc != null) cur.desc = String(patch.desc);
  if (patch.enabled != null) cur.enabled = !!patch.enabled;
  if (patch.scope != null) cur.scope = (patch.scope === 'memory-only' ? 'memory-only' : 'global');
  persist();
  return cur;
}

/** 2026-11-05: 破坏性操作前备份规则表，误删可从 .bak 恢复 */
function backupBeforeDestructive(tag) {
  try {
    const p = getStorePath();
    if (!fs.existsSync(p)) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const bak = p + '.bak-' + (tag || 'destructive') + '-' + stamp;
    fs.copyFileSync(p, bak);
    console.log('[脱敏] 已备份规则表: ' + bak);
    return bak;
  } catch (err) {
    console.warn('[脱敏] 备份失败（不阻断删除）:', err.message);
    return null;
  }
}

function deleteRule(name) {
  const data = ensureLoaded();
  const before = (data.rules || []).length;
  backupBeforeDestructive('single');
  data.rules = (data.rules || []).filter((r) => r.name !== name);
  if (data.rules.length === before) throw new Error('规则不存在: ' + name);
  persist();
  return true;
}

/** 2026-11-05: 批量删除（按 name 数组） */
function deleteRules(names) {
  const data = ensureLoaded();
  const list = Array.isArray(names) ? names.filter(Boolean) : [];
  if (list.length === 0) return { deleted: 0, remaining: (data.rules || []).length };
  const nameSet = new Set(list.map(String));
  const before = (data.rules || []).length;
  backupBeforeDestructive('batch');
  data.rules = (data.rules || []).filter((r) => !nameSet.has(r.name));
  const deleted = before - data.rules.length;
  if (deleted > 0) persist();
  return { deleted: deleted, remaining: data.rules.length };
}

/** 2026-11-05: 删除全部规则（含 manual + auto） */
function deleteAllRules() {
  const data = ensureLoaded();
  const before = (data.rules || []).length;
  if (before === 0) return { deleted: 0 };
  backupBeforeDestructive('all');
  data.rules = [];
  persist();
  return { deleted: before };
}

/** 一键撤销所有 auto 规则（保留 manual） */
function deleteAllAutoRules() {
  const data = ensureLoaded();
  const before = (data.rules || []).length;
  backupBeforeDestructive('auto');
  data.rules = (data.rules || []).filter((r) => r.source !== 'auto');
  persist();
  return before - data.rules.length;
}

/** 一键把某条 auto 规则扩展到全局 */
function promoteToGlobal(name) {
  const data = ensureLoaded();
  const r = (data.rules || []).find((x) => x.name === name);
  if (!r) throw new Error('规则不存在: ' + name);
  r.scope = 'global';
  persist();
  return r;
}

/** 批量把最近一次 auto 添加的规则扩展到全局 */
function promoteRecentAutoToGlobal() {
  const data = ensureLoaded();
  let count = 0;
  for (const r of (data.rules || [])) {
    if (r.source === 'auto' && r.scope === 'memory-only') {
      r.scope = 'global';
      count++;
    }
  }
  if (count > 0) persist();
  return count;
}

function persist() {
  const p = getStorePath();
  _isPersisting = true;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[Redaction] 落盘失败:', err.message);
  } finally {
    // 延迟清理标记，确保 fs.watch 事件已忽略
    setTimeout(() => { _isPersisting = false; }, 100);
  }
}

/**
 * 判断某个匹配是否处于「必须保持原样」的上下文（与 preload 侧同款逻辑）。
 *
 * 脱敏是纯子串替换，短词（js / ts / src / read）会命中 json / adjust /
 * 路径分隔符 / 属性访问，导致工具结果被污染。AI 把占位符当真词照抄进
 * 代码块 → 工具调用直接失败，表现为「任务中断，要用户说继续」。
 */
function isProtectedMatch(text, idx, word) {
  const before = idx > 0 ? text[idx - 1] : '';
  const after = idx + word.length < text.length ? text[idx + word.length] : '';

  // 2026-11-05：取消「路径分隔符」「扩展名/属性访问」两项保护。
  // 原因：这两项会让 src/main/index.js、obj.const 这类真实场景里的真词
  // 原样泄露给 AI 平台（出站替换不生效），与「全替换」目标冲突。
  // 入站 unredactText 能正确还原所有占位符，双向闭环成立，故可安全取消。
  // 保留词边界保护：防止 js 这类短词把 json 拆成 xxxxon。

  if (/^[A-Za-z0-9_$]+$/.test(word)) {
    if (/[A-Za-z0-9_$]/.test(before)) return true;
    if (/[A-Za-z0-9_$]/.test(after)) return true;
  }

  return false;
}

function redactText(text) {
  if (!text || typeof text !== 'string') return text;
  const rules = getActiveRules();
  const pairs = [];
  for (const r of rules) {
    for (const w of r.words) {
      if (w) pairs.push({ word: w, placeholder: '⟦' + r.name + '⟧' });
    }
  }
  pairs.sort((a, b) => b.word.length - a.word.length);
  let out = text;
  for (const { word, placeholder } of pairs) {
    if (out.indexOf(word) === -1) continue;
    let result = '';
    let pos = 0;
    while (pos < out.length) {
      const idx = out.indexOf(word, pos);
      if (idx === -1) {
        result += out.slice(pos);
        break;
      }
      result += out.slice(pos, idx);
      result += isProtectedMatch(out, idx, word) ? word : placeholder;
      pos = idx + word.length;
    }
    out = result;
  }
  return out;
}

function unredactText(text) {
  if (!text || typeof text !== 'string') return text;
  const rules = getActiveRules();
  let out = text;
  for (const r of rules) {
    if (!r.words || r.words.length === 0) continue;
    // 【审计 2026-11-02】多词规则理论上已被迁移成单词语义，这里保留兜底
    if (r.words.length > 1) {
      console.warn('[Redaction] 检测到未迁移的多词规则 ⟦' + r.name + '⟧，反向还原将只用第一个词 "' + r.words[0] + '"');
    }
    const placeholder = '⟦' + r.name + '⟧';
    if (out.indexOf(placeholder) === -1) continue;
    out = out.split(placeholder).join(r.words[0]);
  }
  return out;
}

function unredactDeep(obj) {
  if (typeof obj === 'string') return unredactText(obj);
  if (Array.isArray(obj)) return obj.map(unredactDeep);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = unredactDeep(obj[k]);
    return out;
  }
  return obj;
}

function lookupPlaceholder(name) {
  const data = ensureLoaded();
  const clean = String(name || '').replace(/[⟦⟧]/g, '').trim();
  const r = (data.rules || []).find((x) => x.name === clean);
  if (!r) return null;
  return { name: r.name, desc: r.desc || '', enabled: r.enabled !== false, source: r.source || 'manual', scope: r.scope || 'global' };
}

/**
 * 自动扫描记忆，提取候选脱敏词并加规则。
 * 返回 { added: [...], skipped: [...], totalScanned }
 */
function autoScanMemories(getAllMemoriesFn) {
  const data = ensureLoaded();
  const memories = (typeof getAllMemoriesFn === 'function' ? getAllMemoriesFn() : []) || [];
  // 1) 收集现有规则已覆盖的词（含所有规则，不只 enabled，避免重复）
  const covered = new Set();
  for (const r of (data.rules || [])) {
    for (const w of (r.words || [])) covered.add(String(w).toLowerCase());
  }
  // 2) 从记忆里提取候选词（只扫 name 和 tags，不扫 content 避免噪声）
  const candidates = new Map(); // word -> { count, samples[] }
  for (const m of memories) {
    const text = [m.name || '', Array.isArray(m.tags) ? m.tags.join(' ') : ''].join(' ');
    // 提取英文/下划线/驼峰词（长度 >= 4）
    const enMatches = text.match(/[A-Za-z][A-Za-z0-9_-]{3,}/g) || [];
    for (const w of enMatches) {
      const lw = w.toLowerCase();
      if (covered.has(lw)) continue;
      if (w.length < 4) continue;
      // 过滤常见技术词
      if (/^(html|http|https|json|yaml|python|javascript|typescript|node|electron|react|vue|nginx|redis|mysql|api|url|uri|cookie|token|session|header|body|query|post|get|put|delete|patch|id|index|admin|user|password|email|phone|address|number|string|boolean|object|array|function|class|method|module|package|require|import|export|default|null|undefined|true|false)$/i.test(w)) continue;
      if (!candidates.has(w)) candidates.set(w, { count: 0, samples: [] });
      const c = candidates.get(w);
      c.count++;
      if (c.samples.length < 2 && m.name) c.samples.push(m.name);
    }
  }
  // 3) 排序按出现次数（多次出现的才算真正项目相关）
  const sorted = [...candidates.entries()].sort((a, b) => b[1].count - a[1].count);
  // 4. 最多加 10 条（防污染）
  const MAX_AUTO = 10;
  const added = [];
  const skipped = [];
  let autoIdx = 1;
  for (const [word, info] of sorted) {
    if (added.length >= MAX_AUTO) break;
    if (info.count < 2) {
      skipped.push({ word, reason: '仅出现 1 次' });
      continue;
    }
    // 生成占位符名：自动_N
    let name;
    do { name = '自动_' + autoIdx++; } while (data.rules.some((r) => r.name === name));
    const rule = {
      name: name,
      words: [word],
      desc: 'AI 识别：' + (info.samples[0] || '').slice(0, 40),
      enabled: true,
      source: 'auto',
      scope: 'memory-only'
    };
    data.rules.push(rule);
    added.push(rule);
  }
  if (added.length > 0) persist();
  return { added, skipped, totalScanned: memories.length };
}

/**
 * 导出完整规则表（含 name/words/desc/enabled/source/scope 全部字段）。
 * 输出结构即为存储文件格式 { version: 2, rules: [...] }，导入时可直接回灌。
 */
function exportRules() {
  const data = ensureLoaded();
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    // 多词规则按存储侧的既有约定拆分成 name_1..name_n 导出：
    // 一是与首次落盘后的迁移结果保持一致，二是保证「导出→导入」幂等
    // （importRules 遇到多词规则同样会拆分，不拆会导致往返后条数翻倍）。
    rules: (data.rules || []).reduce((acc, r) => {
      const words = Array.isArray(r.words) ? r.words.slice() : [];
      const desc = r.desc || '';
      const enabled = r.enabled !== false;
      const source = r.source === 'auto' ? 'auto' : 'manual';
      const scope = r.scope === 'memory-only' ? 'memory-only' : 'global';
      if (words.length <= 1) {
        acc.push({ name: r.name, words, desc, enabled, source, scope });
      } else {
        words.forEach((w, i) => {
          acc.push({
            name: r.name + '_' + (i + 1),
            words: [w],
            desc: desc + ' (' + (i + 1) + '/' + words.length + ')',
            enabled,
            source,
            scope,
          });
        });
      }
      return acc;
    }, []),
  };
}

/**
 * 导入规则表（合并策略：同名覆盖 + 新名追加，不删除文件中未出现的现有规则）。
 * @param {object|Array} payload { version, rules: [...] } 或直接 rules 数组
 * @returns {{added:number, updated:number, total:number}}
 */
function importRules(payload) {
  const data = ensureLoaded();
  let incoming = null;
  if (Array.isArray(payload)) incoming = payload;
  else if (payload && Array.isArray(payload.rules)) incoming = payload.rules;
  if (!incoming) throw new Error('导入数据格式错误：应为 { rules: [...] } 或规则数组');

  let added = 0;
  let updated = 0;
  for (const raw of incoming) {
    if (!raw || !raw.name || typeof raw.name !== 'string' || !raw.name.trim()) {
      throw new Error('导入数据格式错误：存在缺少 name 的规则');
    }
    const name = raw.name.trim();
    const words = Array.isArray(raw.words) ? raw.words.map(String).filter(Boolean) : [];
    if (words.length === 0) {
      throw new Error('导入数据格式错误：规则「' + name + '」的真词列表为空');
    }
    for (const w of words) {
      const bad = checkWordSafe(w);
      if (bad) throw new Error('导入被拒绝：' + bad);
    }
    // 多词规则按既有约定拆分（保证反向还原可逆）
    const baseDesc = raw.desc || '';
    const enabled = raw.enabled !== false;
    const source = raw.source === 'auto' ? 'auto' : 'manual';
    const scope = raw.scope === 'memory-only' ? 'memory-only' : 'global';

    const parts = words.length === 1
      ? [{ name, word: words[0], desc: baseDesc }]
      : words.map((w, i) => ({
          name: name + '_' + (i + 1),
          word: w,
          desc: baseDesc + ' (' + (i + 1) + '/' + words.length + ')',
        }));

    for (const p of parts) {
      const idx = (data.rules || []).findIndex((r) => r.name === p.name);
      const normalized = {
        name: p.name,
        words: [p.word],
        desc: p.desc,
        enabled,
        source,
        scope,
      };
      if (idx >= 0) {
        data.rules[idx] = normalized;
        updated++;
      } else {
        data.rules = data.rules || [];
        data.rules.push(normalized);
        added++;
      }
    }
  }
  persist();
  return { added, updated, total: (data.rules || []).length };
}

function _clearCache() { cache = null; }

module.exports = {
  listRules,
  getActiveRules,
  addRule,
  storeEvents,
  updateRule,
  deleteRule,
  deleteRules,
  deleteAllRules,
  backupBeforeDestructive,
  deleteAllAutoRules,
  promoteToGlobal,
  promoteRecentAutoToGlobal,
  redactText,
  isProtectedMatch,
  unredactText,
  unredactDeep,
  lookupPlaceholder,
  autoScanMemories,
  exportRules,
  importRules,
  getQuickGenConfig,
  updateQuickGenConfig,
  addQuickRule,
  DEFAULT_QUICK_GEN,
  COMMON_WORDS,
  DANGEROUS_WORDS,
  checkWordSafe,
  _clearCache,
  getStorePath
};
