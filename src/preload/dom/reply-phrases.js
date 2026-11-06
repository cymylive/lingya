/**
 * 回传消息措辞池
 *
 * 为什么需要：灵鸦发给 AI 的工具回传消息会作为「用户消息」进入服务端对话历史。
 * 几百轮对话里如果每条失败都是「出错了：xxx 再试一下看看。」一字不差，
 * 服务端行为分析能看出这是机器生成的固定模板。
 *
 * 客户端指纹（fp.min.js）看不到这些文本，这是与 mousemove / WebGL 完全不同的一类信号。
 *
 * 设计要点：
 * - 每组 8~10 条，语义等价但措辞不同
 * - 避免连续重复：记录上次索引，随机时排除
 * - 队列异常那组必须保留「别重复做」和「做完告诉我」两层指令意图，
 *   否则会改变 AI 的行为（见 intercept-observer.js 的调用方注释）
 */
'use strict';

const NL = String.fromCharCode(10);

/**
 * 通用 picker：从池子随机取，排除上一次用过的索引。
 * @param {string[]} pool
 * @param {{ lastIndex: number }} state
 * @returns {string}
 */
function pickFrom(pool, state) {
  if (!Array.isArray(pool) || pool.length === 0) return '';
  if (pool.length === 1) return pool[0];
  let idx = Math.floor(Math.random() * pool.length);
  // 排除上一次的索引，保证连续两次不同
  if (idx === state.lastIndex) {
    idx = (idx + 1 + Math.floor(Math.random() * (pool.length - 1))) % pool.length;
    if (idx === state.lastIndex) idx = (state.lastIndex + 1) % pool.length;
  }
  state.lastIndex = idx;
  return pool[idx];
}

// ===== 1. 执行完成但无输出 =====
const EMPTY_OUTPUT_POOL = [
  '(执行完成，没有输出)',
  '(跑完了，没有任何输出)',
  '(执行结束，无返回内容)',
  '(已执行，输出为空)',
  '(完成了，但什么也没打印)',
  '(执行成功，无输出)',
  '(没有输出内容)',
  '(跑通了，没产生输出)',
  '(执行完毕，结果为空)',
  '(命令已跑完，无输出)',
];
const emptyState = { lastIndex: -1 };

// ===== 2. 工具/脚本失败后重试 =====
// 占位 {e} 会被替换成错误文本。语义必须是「失败了 + 打算重试」。
const ERROR_RETRY_POOL = [
  '出错了：{e}' + NL + '再试一下看看。',
  '这次没成功：{e}' + NL + '换个方式再来。',
  '报错了：{e}' + NL + '我调整下再试。',
  '失败了：{e}' + NL + '重跑一遍看看。',
  '有问题：{e}' + NL + '再试试别的路子。',
  '没跑通：{e}' + NL + '我改改再执行。',
  '出问题了：{e}' + NL + '换一种做法试试。',
  '执行报错：{e}' + NL + '再走一遍。',
  '这里卡住了：{e}' + NL + '重试一下。',
  '不太对：{e}' + NL + '我再跑一次。',
];
const errorState = { lastIndex: -1 };

// ===== 3. 附图提示 =====
// 占位 {n} 会被替换成图片数量。
const IMAGE_POOL = [
  '（附了 {n} 张图，你看下。）',
  '（带了 {n} 张图，瞅一眼。）',
  '（{n} 张图附上了，看下。）',
  '（顺手传了 {n} 张图。）',
  '（{n} 张图片见附件。）',
  '（也放了 {n} 张图，你看看。）',
  '（附 {n} 张截图。）',
  '（{n} 张图一并给了。）',
  '（这里有 {n} 张图。）',
  '（图片 {n} 张，已附。）',
];
const imageState = { lastIndex: -1 };

// ===== 4. 队列异常重试 =====
// 【重要】每条都必须保留两层指令意图：
//   a) 别重复做（先确认上一步是否已生效）
//   b) 全做完了告诉我
// 改写时只能换外壳措辞，不能丢掉这两层，否则会改变 AI 行为。
const QUEUE_ERROR_POOL = [
  '刚才那步出错了：{d}' + NL + NL + '接着往下做，先看看上一步是不是已经生效，别重复做。全做完了跟我说“完成了”。',
  '上一步有问题：{d}' + NL + NL + '继续往下，先确认刚才那步有没有生效，不要重复执行。全部搞定后告诉我一声。',
  '出岔子了：{d}' + NL + NL + '往下推进，先检查上一步的实际结果，避免重复。都做完时说一声“完成了”。',
  '这步没成：{d}' + NL + NL + '继续做，先核实上一步是否已生效，别重做。全部完成告诉我。',
  '碰到错误：{d}' + NL + NL + '接着来，先确认上一步有没有实际生效，不要重复操作。最后全做完了跟我说“搞定”。',
  '这里出错了：{d}' + NL + NL + '继续往下走，先看看上一步的结果是否已落地，别重来。都完成后告诉我一声。',
  '出问题了：{d}' + NL + NL + '往下继续，先确认上一步是否真的生效，避免重复。全做完记得说“完成了”。',
  '上一步报错：{d}' + NL + NL + '接着推进，先检查上一步有没有生效，不要重复做。全部搞定后跟我说一声。',
  '刚才那步没成功：{d}' + NL + NL + '往下做，先核实上一步是否已生效，别重复。都完成了告诉我。',
  '这步执行失败：{d}' + NL + NL + '继续往下推进，先确认上一步是否生效，避免重复操作。全做完说一声“完成”。',
];
const queueState = { lastIndex: -1 };

/**
 * 执行完成但无输出。
 * @returns {string}
 */
function pickEmptyOutput() {
  return pickFrom(EMPTY_OUTPUT_POOL, emptyState);
}

/**
 * 工具/脚本失败后的回传。
 * @param {string} errorText 错误原文
 * @returns {string}
 */
function pickErrorRetry(errorText) {
  const e = String(errorText == null ? '' : errorText).trim() || '未知错误';
  return pickFrom(ERROR_RETRY_POOL, errorState).replace('{e}', e);
}

/**
 * 附图提示。
 * @param {number} n 图片数量
 * @returns {string}
 */
function pickImageAttached(n) {
  const count = Number.isFinite(Number(n)) && Number(n) > 0 ? Math.floor(Number(n)) : 0;
  return pickFrom(IMAGE_POOL, imageState).replace('{n}', String(count));
}

/**
 * 队列异常重试。
 * 保留「别重复做」+「做完告诉我」两层指令意图（见池子注释）。
 * @param {string} detail 错误详情
 * @returns {string}
 */
function pickQueueError(detail) {
  const d = String(detail == null ? '' : detail).trim() || '未知错误';
  return pickFrom(QUEUE_ERROR_POOL, queueState).replace('{d}', d);
}

module.exports = {
  pickEmptyOutput,
  pickErrorRetry,
  pickImageAttached,
  pickQueueError,
  // 仅测试用：重置内部状态，避免测试间互相影响
  __resetForTest() {
    emptyState.lastIndex = -1;
    errorState.lastIndex = -1;
    imageState.lastIndex = -1;
    queueState.lastIndex = -1;
  },
};
