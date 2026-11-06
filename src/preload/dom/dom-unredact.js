/**
 * 网页 DOM 占位符还原（2026-11-05）
 *
 * 【要解决的问题】
 *   出站脱敏把真词换成占位符再发给 AI（防泄露），AI 复述时带占位符。
 *   DeepSeek 网页渲染出的 AI 回复里就是占位符，用户复制/阅读看到的是假词。
 *
 * 【做法】
 *   监听 AI 回复容器的 DOM 变化，遍历文本节点把 ⟦xxx⟧ 换回真词。
 *   只改 nodeValue，不碰 innerHTML，不破坏 React/Vue 结构。
 *
 * 【三条防坑措施】
 *   1. 防自触发：改 DOM 前 disconnect observer，改完再 observe，避免死循环
 *   2. 节流：流式输出时每 150ms 最多处理一次，避免卡顿
 *   3. 覆盖后重放：DeepSeek 前端 diff 可能还原占位符，observer 会再触发一次补刀
 *
 * 【边界】
 *   选择器失效时静默降级（只 warn 一次），不影响正常对话。
 */

const UNREDACT_SELECTORS = [
  '.ds-markdown',
  '[class*="markdown"]',
  '[class*="message"] [class*="content"]',
];

const LB = String.fromCharCode(0x27E6);
const THROTTLE_MS = 150;

let observer = null;
let timer = null;
let running = false;
let warnedOnce = false;
let started = false;

/** 遍历 root 下所有文本节点，把占位符换回真词。返回替换处数 */
function walkAndUnredact(root, unredactText) {
  if (!root) return 0;
  let count = 0;
  let walker;
  try {
    walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
  } catch (_) {
    return 0;
  }
  let node;
  while ((node = walker.nextNode())) {
    const t = node.nodeValue;
    if (!t || t.indexOf(LB) === -1) continue;
    let replaced;
    try { replaced = unredactText(t); } catch (_) { continue; }
    if (replaced && replaced !== t) {
      node.nodeValue = replaced;
      count++;
    }
  }
  return count;
}

/** 处理当前所有 AI 回复容器 */
function processOnce(unredactText) {
  if (running) return;
  running = true;
  if (observer) {
    try { observer.disconnect(); } catch (_) {}
  }
  try {
    let total = 0;
    for (const sel of UNREDACT_SELECTORS) {
      let nodes;
      try { nodes = document.querySelectorAll(sel); } catch (_) { continue; }
      if (!nodes || nodes.length === 0) continue;
      for (let i = 0; i < nodes.length; i++) {
        total += walkAndUnredact(nodes[i], unredactText);
      }
    }
    if (total > 0) {
      console.log('[灵鸦][DOM还原] 本次替换 ' + total + ' 处占位符');
    }
  } catch (err) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn('[灵鸦][DOM还原] 处理异常（后续静默）:', err && err.message);
    }
  } finally {
    if (observer) {
      try {
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      } catch (_) {}
    }
    running = false;
  }
}

/** 节流调度 */
function schedule(unredactText) {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    processOnce(unredactText);
  }, THROTTLE_MS);
}

/** 启动监听（幂等） */
function startDomUnredact() {
  if (started) return;
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;

  let unredactText = null;
  try {
    const mod = require('./redaction-filter');
    unredactText = mod.unredactText || null;
  } catch (_) {}
  if (typeof unredactText !== 'function') {
    console.warn('[灵鸦][DOM还原] redaction-filter 无 unredactText，跳过');
    return;
  }

  started = true;

  try {
    observer = new MutationObserver(() => schedule(unredactText));
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  } catch (err) {
    console.warn('[灵鸦][DOM还原] observer 启动失败:', err && err.message);
    started = false;
    return;
  }

  // 页面已有内容先处理一次
  schedule(unredactText);
  console.log('[灵鸦][DOM还原] 已启动（节流 ' + THROTTLE_MS + 'ms）');
}

/** 停止（调试用） */
function stopDomUnredact() {
  if (observer) { try { observer.disconnect(); } catch (_) {} observer = null; }
  if (timer) { clearTimeout(timer); timer = null; }
  started = false;
}

module.exports = { startDomUnredact, stopDomUnredact };
