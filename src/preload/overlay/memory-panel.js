/**
 * 记忆管理面板：列表渲染、增删改、插入输入框
 */
const { showToast } = require('./ui');
const { sendToChat } = require('../dom/chat-input');

const TYPE_LABELS = {
  user: '用户画像',
  feedback: '行为反馈',
  topic: '话题上下文',
  reference: '参考资料',
};

let editingId = null;
let cachedMemories = [];

function typeLabel(t) {
  return TYPE_LABELS[t] || t;
}

/** 取当前搜索关键字（去空白，小写） */
function getSearchKeyword() {
  const el = document.getElementById('lingya-memory-search');
  return el ? el.value.trim().toLowerCase() : '';
}

/** 记忆是否匹配关键字（名称 / 内容 / 标签） */
function memoryMatches(m, keyword) {
  if (!keyword) return true;
  const hay = [m.name, m.content, (m.tags || []).join(' ')].join(' ').toLowerCase();
  return hay.indexOf(keyword) !== -1;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

/**
 * 打开记忆面板
 */
async function openMemoryManager() {
  const panel = document.getElementById('lingya-memory-manager');
  if (!panel) return;
  panel.classList.remove('lingya-hidden');
  hideEditor();
  await renderMemoryList();
}

function closeMemoryManager() {
  const panel = document.getElementById('lingya-memory-manager');
  if (panel) panel.classList.add('lingya-hidden');
}

function hideEditor() {
  editingId = null;
  const editor = document.getElementById('lingya-memory-editor');
  if (editor) editor.classList.add('lingya-hidden');
  const nameEl = document.getElementById('lingya-memory-ed-name');
  const contentEl = document.getElementById('lingya-memory-ed-content');
  const tagsEl = document.getElementById('lingya-memory-ed-tags');
  const pinEl = document.getElementById('lingya-memory-ed-pinned');
  if (nameEl) nameEl.value = '';
  if (contentEl) contentEl.value = '';
  if (tagsEl) tagsEl.value = '';
  if (pinEl) pinEl.checked = false;
}

/**
 * 显示编辑器（新建或编辑）
 */
function showEditor(memory) {
  const editor = document.getElementById('lingya-memory-editor');
  if (!editor) return;
  editor.classList.remove('lingya-hidden');
  editingId = memory ? memory.id : null;
  const nameEl = document.getElementById('lingya-memory-ed-name');
  const typeEl = document.getElementById('lingya-memory-ed-type');
  const contentEl = document.getElementById('lingya-memory-ed-content');
  const tagsEl = document.getElementById('lingya-memory-ed-tags');
  const pinEl = document.getElementById('lingya-memory-ed-pinned');
  if (nameEl) nameEl.value = memory ? memory.name : '';
  if (typeEl) typeEl.value = memory ? memory.type : 'user';
  if (contentEl) contentEl.value = memory ? memory.content : '';
  if (tagsEl) tagsEl.value = memory && Array.isArray(memory.tags) ? memory.tags.join(', ') : '';
  if (pinEl) pinEl.checked = !!(memory && memory.pinned);
}

/**
 * 渲染记忆列表
 */
async function renderMemoryList() {
  const list = document.getElementById('lingya-memory-list');
  if (!list) return;
  const filterEl = document.getElementById('lingya-memory-filter');
  const filter = filterEl ? filterEl.value : '';
  try {
    const res = await window.electronAPI.listMemories();
    if (!res || !res.success) {
      list.innerHTML = '<div class="lingya-session-empty">加载失败：' + escapeHtml((res && res.error) || '未知错误') + '</div>';
      return;
    }
    cachedMemories = res.memories || [];
  } catch (err) {
    list.innerHTML = '<div class="lingya-session-empty">加载失败：' + escapeHtml(err.message) + '</div>';
    return;
  }

  let items = cachedMemories;
  if (filter) items = items.filter((m) => m.type === filter);
  const keyword = getSearchKeyword();
  if (keyword) items = items.filter((m) => memoryMatches(m, keyword));

  if (items.length === 0) {
    list.innerHTML = '<div class="lingya-session-empty">' + (keyword ? '无匹配记忆' : '暂无记忆') + '</div>';
    return;
  }

  list.innerHTML = items.map((m) => (
    '<div class="lingya-memory-item" data-id="' + m.id + '">' +
      '<div class="lingya-memory-head">' +
        '<span class="lingya-memory-type">' + escapeHtml(typeLabel(m.type)) + '</span>' +
        (m.pinned ? '<span class="lingya-memory-pin-tag">📌</span>' : '') +
        '<span class="lingya-memory-name">' + escapeHtml(m.name) + '</span>' +
      '</div>' +
      '<div class="lingya-memory-content">' + escapeHtml(m.content) + '</div>' +
      '<div class="lingya-memory-ops">' +
        '<span class="lingya-memory-op insert" data-op="insert">插入</span>' +
        '<span class="lingya-memory-op" data-op="edit">编辑</span>' +
        '<span class="lingya-memory-op del" data-op="del">删除</span>' +
      '</div>' +
    '</div>'
  )).join('');

  list.querySelectorAll('.lingya-memory-item').forEach((el) => {
    const id = Number(el.dataset.id);
    const memory = cachedMemories.find((m) => m.id === id);
    el.querySelector('[data-op="insert"]').addEventListener('click', () => insertMemory(memory));
    el.querySelector('[data-op="edit"]').addEventListener('click', () => showEditor(memory));
    el.querySelector('[data-op="del"]').addEventListener('click', () => deleteMemoryById(id));
  });
}

/**
 * 插入单条记忆到输入框
 */
function insertMemory(memory) {
  if (!memory) return;
  const text = '【记忆】' + memory.name + '：' + memory.content;
  if (!sendToChat(text, '插入记忆', 300)) {
    showToast('未找到输入框，请确保已打开聊天界面', 3000);
  } else {
    showToast('已插入记忆', 2000);
  }
}

/**
 * 插入全部记忆（按当前筛选）到输入框
 */
async function insertAllMemories() {
  const filterEl = document.getElementById('lingya-memory-filter');
  const filter = filterEl ? filterEl.value : '';
  let items = cachedMemories;
  if (filter) items = items.filter((m) => m.type === filter);
  const keyword = getSearchKeyword();
  if (keyword) items = items.filter((m) => memoryMatches(m, keyword));
  if (items.length === 0) {
    showToast('没有可插入的记忆', 2000);
    return;
  }
  const text = '【长期记忆】\n' + items.map((m) => '- [' + typeLabel(m.type) + '] ' + m.name + '：' + m.content).join('\n');
  if (!sendToChat(text, '插入全部记忆', 300)) {
    showToast('未找到输入框，请确保已打开聊天界面', 3000);
  } else {
    showToast('已插入 ' + items.length + ' 条记忆', 2000);
  }
}

/**
 * 从 JSON 文件导入记忆
 */
async function importMemories() {
  try {
    const res = await window.electronAPI.importMemories();
    if (!res || !res.success) {
      if (res && res.canceled) return;
      showToast('导入失败：' + ((res && res.error) || '未知错误'), 3500);
      return;
    }
    showToast('导入完成：新增 ' + res.imported + '，重复 ' + res.duplicates + '，拒绝 ' + res.rejected, 4000);
    await renderMemoryList();
  } catch (err) {
    showToast('导入失败：' + err.message, 3500);
  }
}

/**
 * 导出记忆为 JSON 文件
 */
async function exportMemories() {
  try {
    const res = await window.electronAPI.exportMemories();
    if (!res || !res.success) {
      if (res && res.canceled) return;
      showToast('导出失败：' + ((res && res.error) || '未知错误'), 3500);
      return;
    }
    showToast('已导出 ' + res.count + ' 条记忆', 3000);
  } catch (err) {
    showToast('导出失败：' + err.message, 3500);
  }
}

/**
 * 保存编辑器内容
 */
async function saveEditor() {
  const nameEl = document.getElementById('lingya-memory-ed-name');
  const typeEl = document.getElementById('lingya-memory-ed-type');
  const contentEl = document.getElementById('lingya-memory-ed-content');
  const tagsEl = document.getElementById('lingya-memory-ed-tags');
  const pinEl = document.getElementById('lingya-memory-ed-pinned');

  const memory = {
    type: typeEl ? typeEl.value : 'user',
    name: nameEl ? nameEl.value.trim() : '',
    content: contentEl ? contentEl.value.trim() : '',
    tags: tagsEl ? tagsEl.value.split(',').map((s) => s.trim()).filter(Boolean) : [],
    pinned: !!(pinEl && pinEl.checked),
  };

  if (!memory.name) { showToast('标题不能为空', 3000); return; }
  if (!memory.content) { showToast('内容不能为空', 3000); return; }

  try {
    let res;
    if (editingId != null) {
      res = await window.electronAPI.updateMemory({ id: editingId, ...memory });
    } else {
      res = await window.electronAPI.saveMemory(memory);
    }
    if (!res || !res.success) {
      showToast('保存失败：' + ((res && res.error) || '未知错误'), 3000);
      return;
    }
    showToast(editingId != null ? '已更新' : '已保存', 2000);
    hideEditor();
    await renderMemoryList();
  } catch (err) {
    showToast('保存失败：' + err.message, 3000);
  }
}

/**
 * 删除记忆
 */
async function deleteMemoryById(id) {
  try {
    const res = await window.electronAPI.deleteMemory(id);
    if (!res || !res.success) {
      showToast('删除失败：' + ((res && res.error) || '未知错误'), 3000);
      return;
    }
    showToast('已删除', 2000);
    await renderMemoryList();
  } catch (err) {
    showToast('删除失败：' + err.message, 3000);
  }
}

/**
 * 绑定记忆面板事件
 */
function bindMemoryPanelEvents() {
  const memBtn = document.getElementById('lingya-btn-memory');
  memBtn?.addEventListener('click', openMemoryManager);

  const closeBtn = document.getElementById('lingya-memory-close');
  closeBtn?.addEventListener('click', closeMemoryManager);

  const newBtn = document.getElementById('lingya-memory-new');
  newBtn?.addEventListener('click', () => showEditor(null));

  const refreshBtn = document.getElementById('lingya-memory-refresh');
  refreshBtn?.addEventListener('click', renderMemoryList);

  const insertAllBtn = document.getElementById('lingya-memory-insert-all');
  insertAllBtn?.addEventListener('click', insertAllMemories);

  const importBtn = document.getElementById('lingya-memory-import');
  importBtn?.addEventListener('click', importMemories);

  const exportBtn = document.getElementById('lingya-memory-export');
  exportBtn?.addEventListener('click', exportMemories);

  const filterEl = document.getElementById('lingya-memory-filter');
  filterEl?.addEventListener('change', renderMemoryList);

  const searchEl = document.getElementById('lingya-memory-search');
  searchEl?.addEventListener('input', renderMemoryList);

  const saveBtn = document.getElementById('lingya-memory-ed-save');
  saveBtn?.addEventListener('click', saveEditor);

  const cancelBtn = document.getElementById('lingya-memory-ed-cancel');
  cancelBtn?.addEventListener('click', hideEditor);
}

module.exports = { bindMemoryPanelEvents, openMemoryManager, closeMemoryManager };
