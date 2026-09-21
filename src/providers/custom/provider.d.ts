/**
 * LingYa 自定义 Provider 接口定义
 * 用户编写自定义平台 Provider 时，可参考本文件获得类型提示。
 *
 * 使用方式（在用户 JS 文件顶部）：
 *   /** @type {import('./custom/provider.d.ts').Provider} */
 *   module.exports = { ... }
 */

/**
 * 输入框元素
 */
interface InputElement {
  tagName?: string;
  isContentEditable?: boolean;
  disabled?: boolean;
  focus?: () => void;
  click?: () => void;
}

/**
 * 平台 Provider 接口
 */
export interface Provider {
  /** 平台唯一标识，如 'my-platform' */
  id: string;
  /** 显示名称 */
  name: string;
  /** 首页地址 */
  homeUrl: string;
  /** 会话 URL 前缀 */
  sessionUrlBase: string;

  /** 输入框查找选择器（按优先级排序） */
  inputSelectors?: string[];
  /** 发送按钮查找选择器 */
  sendButtonSelectors?: string[];
  /** 用户信息选择器 */
  userInfoSelector?: string;
  /** 首页判断正则 */
  homeUrlPattern?: RegExp;
  /** 输入框关键词兜底 */
  inputKeywords?: string[];

  /** 从 URL 提取会话 ID */
  extractSessionId(url: string): string | null;
  /** 判断 URL 是否属于本平台 */
  matchesUrl(url: string): boolean;

  /**
   * 是否使用网络拦截模式获取 AI 回复（默认 false = DOM 抓取）
   * 为 true 时需实现 getHookSource()
   */
  useIntercept?: boolean;

  /**
   * 返回注入页面主世界的网络拦截器源码（拦截模式使用）
   * 仅当 useIntercept 为 true 时需要。源码会在主世界执行，
   * 负责监听 fetch/XHR 并派发 'lingya-ai-response' 事件。
   *
   * ⚠️ 必须自包含：provider 是单文件上传，hook 源码要内联在此方法中，
   * 不能 require 外部文件。推荐写法：
   *   getHookSource() {
   *     return '(' + function () { /* 拦截逻辑，只用浏览器全局 */ }.toString() + ')();';
   *   }
   *
   * 派发事件时可选携带 tokenUsage 字段（详见 provider.template.js）。
   */
  getHookSource?(): string;

  /** 返回自定义提示词模板（优先级最高；返回空则回退到文件模板） */
  getPromptTemplate?(): string;

  /** 查找可见输入框（可选实现） */
  findInput?(): InputElement | null;
  /** 查找发送按钮（可选实现） */
  findSendButton?(): InputElement | null;
  /** 提取用户信息文本（可选实现） */
  extractUserInfo?(): string;
  /** 判断元素可见（可选实现） */
  isElementVisible?(el: Element): boolean;
}
