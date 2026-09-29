/**
 * 统一工具接口 —— LingYa 移动端工具抽象层
 *
 * 设计目标：
 *   - 与桌面版 tools/ 的 ToolResult 语义保持一致（{success, data|error}）
 *   - 按运行平台把调用路由到不同后端：
 *       android  → Capacitor.Plugins.LingyaFs（原生文件插件）
 *       desktop  → window.__hostBridge（Electron 主进程，本工程内不启用）
 *   - AI 生成的 JS 代码只依赖本层暴露的函数名，不感知底层平台
 *
 * 注意：安卓端无 Node vm 沙箱，runner.js 用受限作用域执行 AI 代码；
 *       工具实现全部在原生插件里，天然与 AI 代码隔离。
 */

(function () {
  'use strict';

  /** 检测 Capacitor 插件是否可用 */
  function getNativePlugin() {
    const cap = window.Capacitor;
    if (!cap || !cap.Plugins || !cap.Plugins.LingyaFs) {
      return null;
    }
    return cap.Plugins.LingyaFs;
  }

  const native = getNativePlugin();

  /** 统一结果包装（对齐桌面 ToolResult 的 success/error 字段） */
  function ok(data) { return { success: true, data: data, error: null }; }
  function fail(error) { return { success: false, data: null, error: String(error) }; }

  /**
   * 调用原生插件并归一化结果。
   * 原生插件统一返回 { ok: true, data } 或 { ok: false, error }。
   */
  async function callNative(method, args) {
    if (!native) {
      return fail('原生文件插件不可用：请确认已安装 LingYaFs 插件并 cap sync');
    }
    try {
      const res = await native[method](args || {});
      if (res && res.ok === true) return ok(res.data);
      return fail((res && res.error) || (method + ' 执行失败'));
    } catch (err) {
      return fail(err && err.message ? err.message : String(err));
    }
  }

  /** 判断是否运行在安卓原生环境 */
  const isAndroid = !!(native && window.Capacitor.getPlatform && window.Capacitor.getPlatform() === 'android');

  const Bridge = {
    isAndroid: isAndroid,

    // ---------- 文件系统 ----------

    /** 读取文本文件，返回 {path, content, totalLines} */
    readFile: function (filePath) {
      return callNative('readFile', { path: filePath });
    },

    /** 写入文本文件（覆盖或创建），返回 {path, operation} */
    writeFile: function (filePath, content) {
      return callNative('writeFile', { path: filePath, content: content });
    },

    /** 精确替换，返回 {path, replacements} */
    editFile: function (filePath, oldString, newString, replaceAll) {
      return callNative('editFile', {
        path: filePath,
        oldString: oldString,
        newString: newString,
        replaceAll: replaceAll === true,
      });
    },

    /** 列举目录，返回 {path, entries: [{name, isDir, size}]} */
    listDir: function (dirPath) {
      return callNative('listDir', { path: dirPath });
    },

    /** 删除文件，返回 {path} */
    deleteFile: function (filePath) {
      return callNative('deleteFile', { path: filePath });
    },

    /** 文件/目录信息，返回 {path, exists, isDir, size, lastModified} */
    stat: function (filePath) {
      return callNative('stat', { path: filePath });
    },

    /** 在指定目录内按 glob 匹配文件路径（受限：仅限已授权目录） */
    glob: function (pattern, searchPath) {
      return callNative('glob', { pattern: pattern, searchPath: searchPath });
    },

    /** 在指定目录内按正则搜索文件内容（受限：仅限已授权目录） */
    grep: function (pattern, options) {
      options = options || {};
      return callNative('grep', {
        pattern: pattern,
        searchPath: options.path,
        include: options.include,
      });
    },

    // ---------- SAF 授权目录 ----------

    /** 弹出系统目录选择器，让用户授权一个目录，返回持久化的 rootId */
    pickDirectory: function () {
      return callNative('pickDirectory', {});
    },

    /** 列出已授权的目录 root，返回 [{id, name, uri}] */
    listRoots: function () {
      return callNative('listRoots', {});
    },

    /** 释放某个已授权目录 */
    releaseRoot: function (rootId) {
      return callNative('releaseRoot', { rootId: rootId });
    },
  };

  window.LingyaBridge = Bridge;
})();
