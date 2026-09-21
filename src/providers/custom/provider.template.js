/**
 * 自定义平台 Provider 模板
 * 使用方法：
 *   1. 复制本文件，改名为你的平台 id（如 my-platform.js）
 *   2. 修改 id、name、homeUrl 等字段
 *   3. 根据目标平台 DOM 结构，填写 inputSelectors、sendButtonSelectors 等选择器
 *   4. 实现 extractSessionId、matchesUrl 等方法
 *   5. （可选）需要网络拦截时，设置 useIntercept 并实现 getHookSource
 *
 * 类型提示：见下方 @type 注释
 */
/** @type {import('./custom/provider.d.ts').Provider} */
module.exports = {
  id: 'my-platform',
  name: '我的平台',
  homeUrl: 'https://example.com/',
  sessionUrlBase: 'https://example.com/chat/',

  // 输入框选择器（按优先级）
  inputSelectors: [
    'textarea[placeholder*="输入"]',
    'textarea',
    'div[contenteditable="true"]',
    '[role="textbox"]',
  ],
  inputKeywords: ['输入', '消息', 'message'],

  // 发送按钮选择器
  sendButtonSelectors: [
    'button[type="submit"]',
    'button[aria-label*="send"]',
    'button[aria-label*="发送"]',
  ],

  // 用户信息选择器
  userInfoSelector: '.user-name',

  // 首页判断正则
  homeUrlPattern: /^https:\/\/example\.com\/?$/,

  // 从 URL 提取会话 ID
  extractSessionId(url) {
    if (!url) return null;
    const m = url.match(/\/chat\/([a-zA-Z0-9_-]+)/i);
    return m ? m[1] : null;
  },

  // 判断 URL 是否属于本平台
  matchesUrl(url) {
    return url.includes('example.com');
  },

  // 判断元素是否可见
  isElementVisible(el) {
    if (!el) return false;
    return el.offsetWidth > 0 && el.offsetHeight > 0;
  },

  // 查找输入框
  findInput() {
    for (const sel of this.inputSelectors) {
      const el = document.querySelector(sel);
      if (this.isElementVisible(el)) return el;
    }
    return null;
  },

  // 查找发送按钮
  findSendButton() {
    for (const sel of this.sendButtonSelectors) {
      const btn = document.querySelector(sel);
      if (this.isElementVisible(btn) && !btn.disabled) return btn;
    }
    return null;
  },

  // 提取用户信息
  extractUserInfo() {
    const el = document.querySelector(this.userInfoSelector);
    return el ? el.textContent.trim() : '';
  },

  // ========== 网络拦截模式（可选）==========
  // 默认走 DOM 抓取；若目标平台需要拦截网络请求获取回复，
  // 设置 useIntercept: true 并实现 getHookSource()。
  //
  // ⚠️ 必须自包含：provider 是单文件上传，hook 源码要内联在此方法中，
  // 不能 require 外部文件。hook 函数体在主世界独立执行，
  // 只能使用浏览器全局（window/document/fetch 等），不引用模块级变量。
  //
  // getHookSource() 返回源码字符串，负责监听 fetch/XHR 的 SSE 流，并派发：
  //   window.dispatchEvent(new CustomEvent('lingya-ai-response', {
  //     detail: {
  //       text: '<完整回复文本>',
  //       finished: true,
  //       // 可选：服务端 token 统计（面板会显示）
  //       tokenUsage: { accumulatedTokens, insertedAt, updatedAt, modelType }
  //     }
  //   }));
  //
  // 参考内置 provider 的 getHookSource()（deepseek.js / claude.js / chatgpt.js）。
  //
  // useIntercept: true,
  // getHookSource() {
  //   return '(' + function () {
  //     // 在此编写主世界拦截逻辑
  //   }.toString() + ')();';
  // },
};
