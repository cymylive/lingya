/**
 * JS 工具脚本检测与代码块提取
 * 由原 preload.js 拆分而来，逻辑保持不变。
 */
// ========== JS 工具脚本检测与执行 ==========

// 反引号与围栏（用字符码构造，避免源码中的转义问题）
const BT = String.fromCharCode(96);
const FENCE = BT + BT + BT;
// 工具调用特征：必须出现 "await 工具函数名(" 形式的调用（防止 fs.readFile 等普通示例误判）
// 必须与 tools/JsRunner.js 的 globalThis.xxx 注册保持同步。
// 曾经漏掉 bashOutput / bashKill / bashBackground —— 导致 AI 裸写 await bashOutput(...)
// 时不被识别为工具脚本（只有 log(await xxx()) 包裹才能被第三条规则兜住）。
const JS_TOOL_CALL_RE = /\bawait\s+(?:read|readLines|write|edit|glob|grep|bash|bashBackground|bashOutput|bashKill|pwsh|todoWrite|deleteFile|webFetch|webSearch|viewImage|mysql|openBrowserWindow|injectJS|readFile|readFileWithLines|writeFile|editFile|memorySave|memoryUpdate|memoryDelete|memoryList|skillList|nameConversation|listPlugins|purge)\s*\(/;
/**
 * 判断一段 JS 代码是否调用了工具函数
 */
function looksLikeIncompleteCodeError(error) {
  if (!error || typeof error !== 'string') return false;
  return /SyntaxError|Missing initializer|Unexpected end of input|Unexpected token|Unexpected identifier|Unexpected reserved word|Invalid or unexpected token/i.test(error);
}

function looksLikeToolScript(code) {
  const c = code || '';
  // 1. 内置工具白名单：await write( 等
  if (JS_TOOL_CALL_RE.test(c)) return true;
  // 2. MCP 工具：await mcpXxx(（MCP server 工具名动态，无法进白名单，按 mcp 前缀识别）
  if (/\bawait\s+mcp[A-Za-z_$][\w$]*\s*\(/.test(c)) return true;
  // 3. LingYa 输出封装：log(await xxx( ...（log 包裹的任意工具调用，含 MCP）
  if (/\blog\s*\(\s*await\s+[A-Za-z_$][\w$]*\s*\(/.test(c)) return true;
  return false;
}

/**
 * 判断原始文本去掉所有围栏代码块后是否只剩空白（整条回复只包含代码块）
 */
function hasOnlyFences(text) {
  if (!text || typeof text !== 'string') return false;
  const lines = text.split(String.fromCharCode(10));
  const rest = [];
  let inFence = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith(FENCE)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) rest.push(t);
  }
  return rest.join(' ').trim() === '';
}

/**
 * 从原始文本（含 Markdown 围栏）中提取 JS 工具代码块
 * 规则：
 * - lingya 代码块：一律视为工具脚本
 * - js / javascript 代码块：仅当整条回复只包含代码块、且代码调用了工具函数时才视为工具脚本
 *   （避免把正常回答里的示例代码误当作工具脚本执行）
 */
function extractJsToolBlocks(text) {
  const blocks = [];
  if (!text || typeof text !== 'string') return blocks;

  const onlyFences = hasOnlyFences(text);

  const lines = text.split(String.fromCharCode(10));
  let inBlock = false;
  let lang = '';
  let buf = [];

  const flush = () => {
    const code = buf.join(String.fromCharCode(10)).trim();
    const l = (lang || '').toLowerCase();
    if (code) {
      if (l === 'lingya') {
        blocks.push(code);
      } else if ((l === 'js' || l === 'javascript') && onlyFences && looksLikeToolScript(code)) {
        blocks.push(code);
      }
    }
    inBlock = false;
    lang = '';
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!inBlock) {
      if (trimmed.startsWith(FENCE)) {
        lang = (trimmed.slice(3) || '').split(' ')[0];
        inBlock = true;
        buf = [];
      }
      continue;
    }
    if (trimmed.startsWith(FENCE)) {
      flush();
      continue;
    }
    buf.push(line.replace(String.fromCharCode(13), ''));
  }
  if (inBlock) flush();

  // ============ 2. <lingya>...</lingya> 标签（AI 偶尔误用 XML 格式）============
  // 根因：system prompt 要求用 ```lingya 围栏，但模型有时会输出 <lingya> 标签，
  // 导致内容被当普通文本显示而不执行。这里做容错兼容。
  for (const code of extractLingyaTags(text)) {
    if (code && !blocks.includes(code)) blocks.push(code);
  }

  return blocks;
}

/**
 * 从文本中提取 <lingya>...</lingya> 标签包裹的工具脚本
 * 兼容 AI 偶尔误用 XML 格式的情况（system prompt 已要求用 ```lingya 围栏）
 * 支持两种情况：
 *   1. 闭合标签：<lingya>代码</lingya>
 *   2. 未闭合：<lingya> 之后的内容（取到消息结束）
 */
function extractLingyaTags(text) {
  const blocks = [];
  if (!text || typeof text !== 'string') return blocks;

  // 1) 标准闭合 <lingya>...</lingya>（大小写不敏感、非贪婪）
  const closedRe = /<lingya>([\s\S]*?)<\/lingya>/gi;
  let m;
  let hasClosed = false;
  while ((m = closedRe.exec(text)) !== null) {
    hasClosed = true;
    const code = m[1].trim();
    if (code) blocks.push(code);
  }
  if (hasClosed) return blocks;

  // 2) 未闭合：<lingya> 之后全部内容
  const openRe = /<lingya>([\s\S]*)$/i;
  const m2 = openRe.exec(text);
  if (m2) {
    let code = m2[1].trim();
    // 保险：去掉尾部可能的闭合标签
    code = code.replace(/<\/lingya>\s*$/i, '').trim();
    if (code) blocks.push(code);
  }
  return blocks;
}

module.exports = {
  BT,
  FENCE,
  JS_TOOL_CALL_RE,
  looksLikeIncompleteCodeError,
  looksLikeToolScript,
  hasOnlyFences,
  extractJsToolBlocks,
  extractLingyaTags,
};
