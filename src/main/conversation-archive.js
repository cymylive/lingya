/**
 * 会话存档存储层
 *
 * 每个会话一个 .jsonl 文件，每行一个 JSON 对象（append-only）。
 * 路径：<userDataDir>/conversations/<profileId>/<sessionId>.jsonl
 *
 * 设计要点：
 * - appendFileSync 单行小写入，天然支持多窗口并发追加（操作系统保证 O_APPEND 原子性）
 *   【2026-11-06 审计 #8】重要前提：本实现的并发安全仅在「单主进程多窗口」前提下成立。
 *   所有 appendEntry 调用都走同一主进程，实际不会并发。如果未来支持多实例共享存档目录，
 *   需改为文件锁或单写入者模式（当前实现依赖操作系统 O_APPEND 语义，
 *   但单条 entry 超过 PIPE_BUF（Linux 4KB）时并非严格原子，可能交错损坏）。
 * - 读取逐行 JSON.parse，坏行跳过（不因一行损坏丢掉整个会话）
 * - 所有写操作 try/catch，失败返回 { success:false, error } 而不抛异常
 * - 目录惰性创建
 */
const fs = require('fs');
const path = require('path');

/**
 * 创建某 profile 专属的会话存档实例
 * @param {string} profileId
 * @param {string} userDataDir 用户数据根目录
 */
function createConversationArchive(profileId, userDataDir) {
  const archiveDir = path.join(userDataDir, 'conversations', String(profileId));

  function _ensureDir() {
    if (!fs.existsSync(archiveDir)) {
      fs.mkdirSync(archiveDir, { recursive: true });
    }
  }

  function _filePath(sessionId) {
    // 会话 ID 可能含特殊字符，做最小化安全处理
    const safe = String(sessionId).replace(/[^a-zA-Z0-9_.-]/g, '_');
    return path.join(archiveDir, safe + '.jsonl');
  }

  /**
   * 追加一条消息到指定会话的存档
   * @param {string} sessionId
   * @param {{role:string, text:string, ts:number, tag?:string, attachmentName?:string}} entry
   * @returns {{success:boolean, error?:string}}
   */
  function appendEntry(sessionId, entry) {
    if (!sessionId) return { success: false, error: '缺少 sessionId' };
    if (!entry || typeof entry !== 'object') return { success: false, error: 'entry 无效' };
    try {
      _ensureDir();
      const record = {
        role: entry.role || '',
        text: entry.text || '',
        ts: entry.ts || Date.now(),
        tag: entry.tag || '',
      };
      // 附件消息：保存文件名，重启后仍能正确渲染「> 附件：xxx」
      // （tag 里也有「附件:<name>」，此处双保险；旧存档无此字段不影响解析）
      if (entry.attachmentName) record.attachmentName = String(entry.attachmentName);
      const line = JSON.stringify(record);
      fs.appendFileSync(_filePath(sessionId), line + '\n', 'utf-8');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * 读取指定会话的全部存档条目
   * @param {string} sessionId
   * @returns {{success:boolean, entries:Array, error?:string}}
   */
  function readEntries(sessionId) {
    if (!sessionId) return { success: false, entries: [], error: '缺少 sessionId' };
    const file = _filePath(sessionId);
    try {
      if (!fs.existsSync(file)) return { success: true, entries: [] };
      const raw = fs.readFileSync(file, 'utf-8');
      const entries = [];
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t);
          if (obj && typeof obj === 'object') entries.push(obj);
        } catch (_) { /* 坏行跳过 */ }
      }
      return { success: true, entries };
    } catch (err) {
      return { success: false, entries: [], error: err.message };
    }
  }

  /** 会话是否有存档文件 */
  function hasArchive(sessionId) {
    if (!sessionId) return false;
    try {
      return fs.existsSync(_filePath(sessionId));
    } catch (_) { return false; }
  }

  /** 删除某个会话的存档 */
  function deleteArchive(sessionId) {
    if (!sessionId) return { success: false, error: '缺少 sessionId' };
    try {
      const file = _filePath(sessionId);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * 强制落盘。当前实现用 appendFileSync，写入已即时落盘，
   * 保留此方法是为了兼容接口约定和未来改为缓冲写入时的退出前刷新。
   */
  function flush() {
    return true;
  }

  return {
    profileId,
    archiveDir,
    appendEntry,
    readEntries,
    hasArchive,
    deleteArchive,
    flush,
  };
}

module.exports = { createConversationArchive };
