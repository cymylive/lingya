/**
 * AI 代码执行器（安卓端）
 *
 * 与桌面版的差异：
 *   - 桌面用 Node 的 vm.createContext 做沙箱；安卓 WebView 无 Node，无法用 vm
 *   - 这里用 new Function 构造受限作用域：注入工具函数，屏蔽全局
 *   - 安全性依赖：工具实现全在原生插件里（AI 代码只能通过 bridge 调），
 *     AI 代码本身跑在 WebView 里，能碰到的只有 bridge 暴露的函数
 *
 * ⚠ 安全说明：new Function 不是强沙箱。安卓端如需更强隔离，
 *   应把 AI 代码下发到原生侧用受限解释器执行，或加 CSP + 单独 webview。
 *   当前实现适用于"用户自己手机、自担风险"的场景。
 */

(function () {
  'use strict';

  var OUTPUT_LIMIT = 20000;

  /** 从 AI 回复里提取 lingya 代码块 */
  function extractLingyaBlocks(text) {
    var blocks = [];
    var re = /```lingya\s*\n([\s\S]*?)```/g;
    var m;
    while ((m = re.exec(text)) !== null) blocks.push(m[1]);
    return blocks;
  }

  /** 收集一次执行里的 log 输出 */
  function makeLogger(sink) {
    return function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        var v = arguments[i];
        parts.push(typeof v === 'string' ? v : safeStringify(v));
      }
      sink.push(parts.join(' '));
    };
  }

  function safeStringify(v) {
    try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
  }

  /**
   * 执行一段 AI 生成的 JS。
   * @param {string} code
   * @returns {Promise<{ok:boolean, logs:string, value:any, error:string|null}>}
   */
  async function runCode(code) {
    var logs = [];
    var logFn = makeLogger(logs);
    var B = window.LingyaBridge;

    // 注入给 AI 代码的工具函数（与桌面 systemPrompt 中的 API 名对齐）
    var scope = {
      log: logFn,
      readFile: function (p) { return B.readFile(p); },
      write: function (p, c) { return B.writeFile(p, c); },
      writeFile: function (p, c) { return B.writeFile(p, c); },
      edit: function (p, o, n, all) { return B.editFile(p, o, n, all); },
      listDir: function (p) { return B.listDir(p); },
      deleteFile: function (p) { return B.deleteFile(p); },
      stat: function (p) { return B.stat(p); },
      glob: function (pat, sp) { return B.glob(pat, sp); },
      grep: function (pat, opt) { return B.grep(pat, opt); },
      pickDirectory: function () { return B.pickDirectory(); },
      listRoots: function () { return B.listRoots(); },
    };

    try {
      var names = Object.keys(scope);
      var values = names.map(function (k) { return scope[k]; });
      // 用 Function 构造：AI 代码只能用注入的名字 + 内建 JS，无 require/process
      var fn = new Function('"use strict"; return (async function (' + names.join(',') + ') {\n' + code + '\n})');
      var ret = await fn.apply(null, values);
      var out = logs.join('\n');
      var valText = ret === undefined ? '' : safeStringify(ret);
      var combined = (out + (valText ? '\n' + valText : '')).slice(0, OUTPUT_LIMIT);
      return { ok: true, logs: combined, value: ret === undefined ? null : ret, error: null };
    } catch (err) {
      return {
        ok: false,
        logs: logs.join('\n'),
        value: null,
        error: (err && err.message) ? err.message : String(err),
      };
    }
  }

  window.LingyaRunner = {
    extractLingyaBlocks: extractLingyaBlocks,
    runCode: runCode,
  };
})();
