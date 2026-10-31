/**
 * 模型输出速度（TPS）测速器（移植自 Cuckoo-Code 2026-11-01）
 *
 * 两条路径：
 *  1) 精确路径：DeepSeek 每帧下发 accumulated_token_usage（= 对话上下文累计 token），
 *     本轮输出 token = 当前值 − 本轮起始值，优先采用。**不含输入 token**。
 *  2) 回退估算：正文长度近似估算（CJK 0.7/字，英文 0.28/字符）。
 *
 * 新一轮检测：finished=true 或正文长度回退 → 自动重置基准。
 */
'use strict';

function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/g) || []).length;
  const emoji = (text.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length;
  const digits = (text.match(/\d/g) || []).length;
  const spaces = (text.match(/\s/g) || []).length;
  const rest = Math.max(0, text.length - cjk - emoji - digits - spaces);
  return Math.round(cjk * 0.7 + emoji * 2.5 + digits * 0.35 + spaces * 0.25 + rest * 0.28);
}

const MIN_WINDOW = 0.3;

function createTpsMeter() {
  let startAt = 0;
  let baseAcc = 0;
  let lastAcc = 0;
  let hasAcc = false;
  let running = false;
  let value = 0;
  let tokens = 0;
  let lastTextLen = 0;

  function startNewRound() {
    startAt = 0; baseAcc = 0; lastAcc = 0; hasAcc = false;
    running = false; tokens = 0; lastTextLen = 0;
  }

  return {
    update(text, finished, acc, now) {
      now = now || Date.now();
      if (finished) { running = false; return value; }
      const textLen = (text || '').length;
      if ((!running && startAt !== 0) || (startAt !== 0 && textLen < lastTextLen)) {
        startNewRound();
      }
      running = true;
      lastTextLen = textLen;
      let outTokens = -1;
      if (typeof acc === 'number' && acc >= 0) {
        if (!hasAcc) { baseAcc = acc; hasAcc = true; startAt = now; }
        lastAcc = acc;
        const accTokens = lastAcc - baseAcc;
        if (accTokens > 0) outTokens = accTokens;
      }
      if (outTokens <= 0) {
        outTokens = estimateTokens(text);
        if (outTokens <= 0) return value;
        if (startAt === 0) startAt = now;
      }
      tokens = outTokens;
      const elapsed = (now - startAt) / 1000;
      if (elapsed >= MIN_WINDOW) value = tokens / elapsed;
      return value;
    },
    reset() { startNewRound(); value = 0; },
    /** 【对齐 Cuckoo】结束后用真实值覆盖估算值（供 handleLoadingFinished 校准） */
    setValue(v) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0 && n < 10000) value = n;
    },
    get value() { return value; },
    get tokens() { return tokens; },
    get active() { return running; },
  };
}

function formatTps(value) {
  if (!Number.isFinite(value) || value <= 0) return '';
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1);
}

module.exports = { estimateTokens, createTpsMeter, formatTps };
