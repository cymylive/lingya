/**
 * 事件名混淆器（每会话随机后缀）
 *
 * 【封号风险改造 2026-11-01】
 * 原实现所有主世界 CustomEvent 用明文固定名（lingya-ai-response / lingya-ai-start …）。
 * 页面任意脚本 window.addEventListener('lingya-ai-response', ...) 即可监听 AI 回复全文；
 * window.dispatchEvent(new CustomEvent('lingya-ai-start')) 可伪造生成中状态。
 *
 * 现在每次 preload 启动生成一个随机后缀（如 '_k3j9x2a1'），所有事件名追加此后缀：
 *   lingya-ai-response → lingya-ai-response_k3j9x2a1
 * 页面脚本无法预知后缀，无法监听/伪造。hook 注入时把后缀作为参数传入主世界，
 * 主世界与隔离世界使用同一后缀。
 *
 * 后缀在同一 preload 生命周期内固定（页面刷新会变），已够防预埋监听器。
 */
'use strict';

// 生成 8 位 36 进制随机串（不含大写，避免阅读歧义）
const SUFFIX = '_' + Math.random().toString(36).slice(2, 10);

// 随机后缀版本（内置 provider 使用）
const names = {
  AI_START: 'lingya-ai-start' + SUFFIX,
  AI_RESPONSE: 'lingya-ai-response' + SUFFIX,
  AI_STREAM: 'lingya-ai-stream' + SUFFIX,
  AI_ERROR: 'lingya-ai-error' + SUFFIX,
  USER_MESSAGE: 'lingya-user-message' + SUFFIX,
  DS_HEADERS: 'lingya-ds-headers' + SUFFIX,
  HOOK_READY: 'lingya-hook-ready' + SUFFIX,
};

// 默认（明文）版本（自定义 provider 未适配事件名参数时使用，保持向后兼容）
const DEFAULTS = {
  AI_START: 'lingya-ai-start',
  AI_RESPONSE: 'lingya-ai-response',
  AI_STREAM: 'lingya-ai-stream',
  AI_ERROR: 'lingya-ai-error',
  USER_MESSAGE: 'lingya-user-message',
  DS_HEADERS: 'lingya-ds-headers',
  HOOK_READY: 'lingya-hook-ready',
};

module.exports = Object.assign({ SUFFIX, DEFAULTS }, names);
