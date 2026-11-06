/**
 * 纯净对话模式（Harness）的 bridge 侧逻辑
 * 对齐 Cuckoo Code 0.8.19 的事件格式。
 * 运行在 AI 页面 preload。
 */
const { ipcRenderer } = require('electron');
const {
  onInterceptedResponse, onToolCall, onStream, onTaskIdle, onAiError,
} = require('./dom/intercept-observer');
const {
  sendToChat, cancelPendingSend, onMessageDelivered, onUserMessageSent,
} = require('./dom/chat-input');

/** 移除文本里的 lingya / js 工具代码块 */
function stripToolBlocks(text) {
  if (!text) return '';
  let out = text;
  out = out.replace(/```(?:lingya|javascript|js)\s*\n[\s\S]*?```/gi, '');
  out = out.replace(/```(?:lingya|javascript|js)\s*\n[\s\S]*$/gi, '');
  out = out.replace(/```(?:lingya|javascript|js)\s*$/gi, '');
  return out.trim();
}

const HAS_TOOL_BLOCK_RE = /```(?:lingya|javascript|js)\s*\n/i;

/**
 * 【审计修复 2026-11-02】脱敏正文但保护代码块。
 * AI 回复里可能有代码块（含路径、变量名等），如果代码块被脱敏会破坏语法，
 * 所以只对代码块外的正文脱敏。
 */
function redactInBody(text) {
  if (!text || typeof text !== 'string') return text;
  try {
    const { redactText } = require('./dom/redaction-filter');
    // 用 split 分段：代码块（```...```）和非代码块交替
    const parts = text.split(/(```[\s\S]*?```)/g);
    for (let i = 0; i < parts.length; i++) {
      // 奇数索引是代码块，偶数索引是正文
      if (i % 2 === 1) continue;
      if (parts[i]) parts[i] = redactText(parts[i]);
    }
    return parts.join('');
  } catch (_) { return text; }
}

function report(payload) {
  try {
    ipcRenderer.invoke('harness-event-report', payload).catch(() => {});
  } catch (_) {}
}

// ============ 历史抓取 ============

/** 从 URL 提取当前会话 ID（DeepSeek） */
function getCurrentSessionId() {
  try {
    const m = String(window.location.href).match(/\/a\/chat\/s\/([a-zA-Z0-9-]+)/);
    if (m) return m[1];
    const m2 = String(window.location.href).match(/\/chat\/s\/([a-zA-Z0-9-]+)/);
    if (m2) return m2[1];
  } catch (_) {}
  return null;
}

/** 从 DeepSeek 的 IndexedDB 读全量消息（含 fragments） */
function fetchFromIndexedDB(sessionId) {
  return new Promise((resolve, reject) => {
    if (!sessionId) { reject(new Error('无 sessionId')); return; }
    let req;
    try { req = indexedDB.open('deepseek-chat'); } catch (e) { reject(e); return; }
    req.onerror = () => reject(new Error('打开 IndexedDB 失败'));
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction('history-message', 'readonly');
        const store = tx.objectStore('history-message');
        const g = store.get(sessionId);
        g.onsuccess = () => {
          db.close();
          try {
            const val = g.result;
            const msgs = val && val.data && val.data.chat_messages;
            if (!Array.isArray(msgs)) { resolve([]); return; }
            const sorted = msgs
              .filter((m) => typeof m.message_id === 'number')
              .sort((a, b) => a.message_id - b.message_id);
            // 【诊断】打印最后 3 条的完整结构（含 fragments 字段名）
            try {
              const diag = sorted.slice(-3).map((m) => ({
                id: m.message_id,
                role: m.role,
                fragCount: Array.isArray(m.fragments) ? m.fragments.length : 'none',
                fragTypes: Array.isArray(m.fragments) ? m.fragments.map((f) => String(f.type || '?') + ':' + (f.content || '').length) : null,
                keys: Object.keys(m).slice(0, 15),
              }));
              console.log('[Harness诊断] 消息结构:', JSON.stringify(diag));
            } catch (de) { console.warn('[Harness诊断] 结构打印失败:', de && de.message); }

            const out = [];
            let skipped = 0;
            for (const m of sorted) {
              const role = String(m.role || '').toUpperCase();
              const frags = Array.isArray(m.fragments) ? m.fragments : [];
              if (role === 'USER') {
                const reqs = frags.filter((f) => f && f.type === 'REQUEST').map((f) => f.content || '').join('\n').trim();
                if (reqs) out.push({ role: 'user', text: reqs });
                else skipped++;
              } else if (role === 'ASSISTANT') {
                const thinks = frags.filter((f) => f && f.type === 'THINK').map((f) => f.content || '').join('\n').trim();
                const resps = frags.filter((f) => f && f.type === 'RESPONSE').map((f) => f.content || '').join('\n').trim();
                if (resps || thinks) {
                  out.push({ role: 'assistant', text: stripToolBlocks(resps), think: thinks });
                } else skipped++;
              } else {
                skipped++;
              }
            }
            console.log('[Harness诊断] 原始=' + sorted.length + ' 有效=' + out.length + ' 跳过=' + skipped);
            resolve(out);
          } catch (e) { reject(e); }
        };
        g.onerror = () => { db.close(); reject(new Error('读取消息失败')); };
      } catch (e) { db.close(); reject(e); }
    };
  });
}

/** 从 DOM 抓当前会话消息（兜底方案） */
function fetchFromDOM() {
  try {
    const out = [];
    // 找所有消息容器（从 dom-fallback 的 MESSAGE_SELECTORS 借鉴）
    const selectors = ['.ds-markdown', '[class*="markdown"]', '[class*="message"] [class*="content"]'];
    let nodes = null;
    for (const sel of selectors) {
      try { nodes = document.querySelectorAll(sel); } catch (_) {}
      if (nodes && nodes.length > 0) break;
    }
    if (!nodes || nodes.length === 0) return out;
    // 太简单，只抓 AI 回复块，不区分 user/assistant 混合
    // 更好的做法是找 role=user 和 role=assistant 的兄弟节点
    // 先走简化：只抓 AI 回复
    for (const el of nodes) {
      const text = String(el.innerText || '').trim();
      if (text.length < 5) continue;
      const cls = String(el.className || '') + ' ' + String((el.parentElement && el.parentElement.className) || '');
      const isUser = /fbb737a4|user-message|message-user/i.test(cls);
      out.push({ role: isUser ? 'user' : 'assistant', text: text });
    }
    return out;
  } catch (_) { return []; }
}

/** 主入口：抓历史，IndexedDB 优先，DOM 兜底 */
async function fetchConversationHistory() {
  const sid = getCurrentSessionId();
  let msgs = [];
  if (sid) {
    try {
      msgs = await fetchFromIndexedDB(sid);
      console.log('[LingYa Harness] IndexedDB 抓到 ' + msgs.length + ' 条历史');
    } catch (err) {
      console.warn('[LingYa Harness] IndexedDB 失败，回退 DOM:', err && err.message);
    }
  }
  if (!msgs || msgs.length === 0) {
    msgs = fetchFromDOM();
    console.log('[LingYa Harness] DOM 抓到 ' + msgs.length + ' 条历史');
  }
  // 截取最近 100 条
  if (msgs.length > 100) msgs = msgs.slice(-100);
  return msgs;
}

// ============ bridge 主流程 ============

let inited = false;
function initHarnessBridge() {
  if (inited) return;
  inited = true;

  // ===== AI 生成状态 =====
  let aiGenerating = false;
  function setAiGenerating(next) {
    if (aiGenerating === next) return;
    aiGenerating = next;
    report({ type: 'ai-state', generating: next });
  }
  try {
    // 【审计 2026-11-02】降频：心跳从 2 秒改 5 秒，减少日志噪音；harness.html 会合并 ai-state
    // 【2026-11-06 修复 #5】幂等保护
    if (!window.__lyHarnessHeartbeat) {
      window.__lyHarnessHeartbeat = setInterval(() => report({ type: 'ai-state', generating: aiGenerating }), 5000);
    }
  } catch (_) {}

  onStream((ev) => {
    if (!ev) return;
    if (!ev.finished && (ev.text || ev.think)) setAiGenerating(true);
    const t = stripToolBlocks(ev.text || '');
    report({ type: 'stream', think: ev.think || '', text: t, finished: !!ev.finished });
  });

  onInterceptedResponse((text) => {
    const raw = text || '';
    if (!HAS_TOOL_BLOCK_RE.test(raw)) setAiGenerating(false);
    const stripped = stripToolBlocks(raw).trim();
    // 【审计修复 2026-11-02】派发前脱敏（保护代码块，只脱正文）
    const safe = redactInBody(stripped);
    report({ type: 'assistant-done', text: safe });
    report({ type: 'assistant', text: safe });
  });

  onTaskIdle(() => {
    setAiGenerating(false);
    report({ type: 'task-idle' });
  });

  onAiError(() => { setAiGenerating(false); });

  onToolCall((ev) => {
    if (!ev) return;
    if (ev.phase === 'start') {
      report({ type: 'tool-start', code: ev.code || '', toolName: ev.toolName || '' });
    } else if (ev.phase === 'end') {
      report({
        type: 'tool-end',
        code: ev.code || '',
        toolName: ev.toolName || '',
        success: !!ev.success,
        output: ev.output || '',
        error: ev.error || '',
      });
    }
  });

  onMessageDelivered((info) => {
    if (!info) return;
    setAiGenerating(true);
    if (info.tag === 'harness') return;
    report({ type: 'framework-send', tag: info.tag || '', system: !!info.isSystem });
  });

  onUserMessageSent((text, tag) => {
    if (!text) return;
    report({ type: 'user', text: String(text) });
  });

  // ===== 历史抓取（切换进纯净模式时主进程请求）=====
  ipcRenderer.on('harness-request-history', async () => {
    try {
      const msgs = await fetchConversationHistory();
      report({ type: 'history', messages: msgs });
    } catch (err) {
      console.warn('[LingYa Harness] 抓取历史失败:', err && err.message);
      report({ type: 'history', messages: [] });
    }
  });

  // ===== Plan（todo 变化）→ 上报 =====
  try {
    ipcRenderer.on('lingya-todos-updated', (_e, payload) => {
      try {
        const todos = (payload && payload.todos) || [];
        if (!Array.isArray(todos)) return;
        const mapped = todos.map((t) => ({
          text: String(t.content || t.text || ''),
          status: String(t.status || 'pending'),
        }));
        report({ type: 'plan', todos: mapped });
      } catch (_) {}
    });
  } catch (_) {}

  // 会话切换 → 上报
  // 【2026-11-06 修复 #5】幂等保护
  (function watchSessionChange() {
    if (window.__lyHarnessSessionTimer) return;
    let lastSid = getCurrentSessionId();
    try {
      window.__lyHarnessSessionTimer = setInterval(() => {
        const sid = getCurrentSessionId();
        if (sid === lastSid) return;
        lastSid = sid;
        report({ type: 'session-changed', sessionId: sid || '' });
        report({ type: 'reset' });
      }, 1500);
    } catch (_) {}
  })();

  // 用户在 harness 输入 → 主进程转发到此 → 发到 AI
  ipcRenderer.on('harness-user-message', (_e, payload) => {
    const text = payload && payload.text;
    if (!text) return;
    try { window.electronAPI.clearAbort(); } catch (_) {}
    sendToChat(text, 'harness', 300).catch(() => {});
  });

  ipcRenderer.on('harness-stop-signal', () => {
    try { cancelPendingSend(); } catch (_) {}
    try { window.electronAPI.clearAbort(); } catch (_) {}
    setAiGenerating(false);
    console.log('[LingYa Harness] 收到停止信号');
  });

  ipcRenderer.on('lingya-new-chat-request', () => {
    try {
      if (window.electronAPI && window.electronAPI.newChat) {
        window.electronAPI.newChat().then(() => {
          // 新对话跳转到首页后：
          // 1. 通知 harness 清空界面
          report({ type: 'reset' });
          // 2. 延迟一小会等首页加载完成，再抓历史（首页无历史，只是保险）
          setTimeout(() => {
            report({ type: 'session-changed', sessionId: '' });
          }, 500);
        }).catch((err) => {
          console.warn('[LingYa Harness] 新对话失败:', err && err.message);
        });
      }
    } catch (_) {}
  });

  console.log('[LingYa Harness] bridge 已初始化');
}

module.exports = { initHarnessBridge };
