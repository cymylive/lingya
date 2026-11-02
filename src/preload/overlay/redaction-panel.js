/**
 * 脱敏规则管理面板（2026-11-02）
 *
 * 侧边栏「脱敏」入口 -> 弹窗管理占位符映射。
 * 参照 security-panel.js 结构。
 */
const { showToast } = require('./ui');

function el(id) { return document.getElementById(id); }

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

async function openRedactionManager() {
  const panel = el('lingya-redaction-manager');
  if (!panel) return;
  panel.classList.remove('lingya-hidden');
  await loadRules();
}

function closeRedactionManager() {
  const panel = el('lingya-redaction-manager');
  if (panel) panel.classList.add('lingya-hidden');
}

async function loadRules() {
  const list = el('lingya-redaction-list');
  if (!list) return;
  try {
    const rules = await window.electronAPI.redactionRulesList();
    if (!Array.isArray(rules)) {
      list.innerHTML = '<div class="lingya-hint">加载失败：' + escapeHtml(rules && rules.error || '未知错误') + '</div>';
      return;
    }
    if (rules.length === 0) {
      list.innerHTML = '<div class="lingya-hint">暂无规则，点「新增规则」开始</div>';
      return;
    }
    const html = rules.map((r) => {
      const enabled = r.enabled !== false;
      return (
        '<div class="lingya-redaction-row" data-name="' + escapeHtml(r.name) + '">' +
          '<div class="lingya-redaction-row-main">' +
            '<span class="lingya-redaction-badge">⟦' + escapeHtml(r.name) + '⟧</span>' +
            '<span class="lingya-redaction-words">' + escapeHtml((r.words || []).join(' / ')) + '</span>' +
            '<span class="lingya-redaction-desc">' + escapeHtml(r.desc || '（无描述）') + '</span>' +
            '<span class="lingya-redaction-status" style="color:' + (enabled ? '#2dd4bf' : '#666') + ';">' + (enabled ? '启用' : '停用') + '</span>' +
          '</div>' +
          '<div class="lingya-redaction-row-actions">' +
            '<button class="lingya-btn lingya-btn-secondary lingya-btn-sm" data-act="edit" data-name="' + escapeHtml(r.name) + '">编辑</button>' +
            '<button class="lingya-btn lingya-btn-secondary lingya-btn-sm" data-act="delete" data-name="' + escapeHtml(r.name) + '">删除</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');
    list.innerHTML = html;
    // 绑定行内按钮
    list.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.getAttribute('data-act');
        const name = btn.getAttribute('data-name');
        if (act === 'edit') openEditForm(name);
        else if (act === 'delete') deleteRule(name);
      });
    });
  } catch (err) {
    list.innerHTML = '<div class="lingya-hint">加载失败：' + escapeHtml(err.message) + '</div>';
  }
}

async function openEditForm(name) {
  // 从列表里查该条规则
  const rules = await window.electronAPI.redactionRulesList();
  const r = (rules || []).find((x) => x.name === name);
  if (!r) { showToast('规则不存在', 2000); return; }
  el('lingya-redaction-edit-name').value = r.name;
  el('lingya-redaction-edit-name').readOnly = true;
  el('lingya-redaction-edit-words').value = (r.words || []).join(', ');
  el('lingya-redaction-edit-desc').value = r.desc || '';
  el('lingya-redaction-edit-enabled').checked = r.enabled !== false;
  el('lingya-redaction-edit-title').textContent = '编辑规则';
  el('lingya-redaction-edit').classList.remove('lingya-hidden');
}

function openNewForm() {
  el('lingya-redaction-edit-name').value = '';
  el('lingya-redaction-edit-name').readOnly = false;
  el('lingya-redaction-edit-words').value = '';
  el('lingya-redaction-edit-desc').value = '';
  el('lingya-redaction-edit-enabled').checked = true;
  el('lingya-redaction-edit-title').textContent = '新增规则';
  el('lingya-redaction-edit').classList.remove('lingya-hidden');
}

function closeEditForm() {
  el('lingya-redaction-edit').classList.add('lingya-hidden');
}

async function saveEditForm() {
  const name = (el('lingya-redaction-edit-name').value || '').trim();
  const wordsRaw = (el('lingya-redaction-edit-words').value || '').trim();
  const desc = (el('lingya-redaction-edit-desc').value || '').trim();
  const enabled = !!(el('lingya-redaction-edit-enabled') && el('lingya-redaction-edit-enabled').checked);
  if (!name) { showToast('占位符名不能为空', 2500); return; }
  if (!wordsRaw) { showToast('真词列表不能为空（用逗号分隔）', 2500); return; }
  const words = wordsRaw.split(/[,，、\n]+/).map((w) => w.trim()).filter(Boolean);
  if (words.length === 0) { showToast('真词列表不能为空', 2500); return; }
  const isNew = !el('lingya-redaction-edit-name').readOnly;
  try {
    const payload = { name, words, desc, enabled };
    let res;
    if (isNew) {
      res = await window.electronAPI.redactionRulesAdd(payload);
    } else {
      res = await window.electronAPI.redactionRulesUpdate(name, payload);
    }
    if (!res || res.error) { showToast('保存失败：' + ((res && res.error) || '未知错误'), 3000); return; }
    showToast(isNew ? '已新增' : '已更新', 2000);
    closeEditForm();
    await loadRules();
    // 通知 preload 侧刷新缓存（通过 refreshRules）
    try {
      const { refreshRules } = require('../dom/redaction-filter');
      await refreshRules();
    } catch (_) {}
  } catch (err) {
    showToast('保存失败：' + err.message, 3000);
  }
}

async function deleteRule(name) {
  if (!confirm('确定删除规则「' + name + '」？')) return;
  try {
    const res = await window.electronAPI.redactionRulesDelete(name);
    if (!res || res.error) { showToast('删除失败：' + ((res && res.error) || '未知错误'), 3000); return; }
    showToast('已删除', 2000);
    await loadRules();
    try {
      const { refreshRules } = require('../dom/redaction-filter');
      await refreshRules();
    } catch (_) {}
  } catch (err) {
    showToast('删除失败：' + err.message, 3000);
  }
}

function bindRedactionPanelEvents() {
  el('lingya-btn-redaction')?.addEventListener('click', openRedactionManager);
  el('lingya-redaction-close')?.addEventListener('click', closeRedactionManager);
  el('lingya-redaction-add')?.addEventListener('click', openNewForm);
  el('lingya-redaction-edit-save')?.addEventListener('click', saveEditForm);
  el('lingya-redaction-edit-cancel')?.addEventListener('click', closeEditForm);
  el('lingya-redaction-edit-close')?.addEventListener('click', closeEditForm);
}

module.exports = { bindRedactionPanelEvents, openRedactionManager, closeRedactionManager };
