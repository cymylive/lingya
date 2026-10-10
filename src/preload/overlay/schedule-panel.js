/**
 * 定时任务面板：任务列表 + 新建/编辑/删除 + 立即执行 + 目标窗口/项目目录。
 * 仿 feishu-panel.js 结构。
 */
const { showToast } = require('./ui');

function el(id) { return document.getElementById(id); }

let editingId = null; // 正在编辑的任务 id（null 表示新建）

/** 打开面板 */
async function openScheduleManager() {
  const panel = el('lingya-schedule-manager');
  if (!panel) return;
  panel.classList.remove('lingya-hidden');
  resetForm();
  await loadWindows();
  await loadScheduleList();
}

/** 加载目标窗口下拉 */
async function loadWindows() {
  const sel = el('lingya-schedule-window');
  if (!sel) return;
  try {
    const r = await window.electronAPI.scheduleListWindows();
    const wins = (r && r.success && r.windows) || [];
    sel.innerHTML = '<option value="">— 当前活跃窗口 —</option>' +
      wins.map((w) => '<option value="' + w.id + '">' + esc(w.name) + (w.open ? '' : '（未打开）') + '</option>').join('');
  } catch (_) {}
}

function closeScheduleManager() {
  const p = el('lingya-schedule-manager');
  if (p) p.classList.add('lingya-hidden');
}

/** 重置表单为新建态 */
function resetForm() {
  editingId = null;
  const t = el('lingya-schedule-form-title');
  if (t) t.textContent = '新建任务';
  const name = el('lingya-schedule-name'); if (name) name.value = '';
  const prompt = el('lingya-schedule-prompt'); if (prompt) prompt.value = '';
  const mode = el('lingya-schedule-mode'); if (mode) mode.value = 'daily';
  const hour = el('lingya-schedule-hour'); if (hour) hour.value = '3';
  const minute = el('lingya-schedule-minute'); if (minute) minute.value = '0';
  const wk = el('lingya-schedule-weekday'); if (wk) wk.value = '1';
  const cronEl = el('lingya-schedule-cron'); if (cronEl) cronEl.value = '';
  const en = el('lingya-schedule-enabled'); if (en) en.checked = true;
  const win = el('lingya-schedule-window'); if (win) win.value = '';
  const proj = el('lingya-schedule-project'); if (proj) proj.value = '';
  const cancel = el('lingya-schedule-cancel'); if (cancel) cancel.classList.add('lingya-hidden');
  updateModeVisibility();
}

/** 根据调度模式切换输入框显隐 */
function updateModeVisibility() {
  const mode = el('lingya-schedule-mode') ? el('lingya-schedule-mode').value : 'daily';
  const timeRow = el('lingya-schedule-time-row');
  const cronInput = el('lingya-schedule-cron');
  const wk = el('lingya-schedule-weekday');
  if (timeRow) timeRow.classList.toggle('lingya-hidden', mode === 'cron');
  if (cronInput) cronInput.classList.toggle('lingya-hidden', mode !== 'cron');
  if (wk) wk.classList.toggle('lingya-hidden', mode !== 'weekly');
}

/** 从表单收集 cron 表达式 */
function collectCron() {
  const mode = el('lingya-schedule-mode') ? el('lingya-schedule-mode').value : 'daily';
  if (mode === 'cron') {
    return el('lingya-schedule-cron') ? el('lingya-schedule-cron').value.trim() : '';
  }
  const h = el('lingya-schedule-hour') ? el('lingya-schedule-hour').value : '0';
  const m = el('lingya-schedule-minute') ? el('lingya-schedule-minute').value : '0';
  if (mode === 'weekly') {
    const wd = el('lingya-schedule-weekday') ? el('lingya-schedule-weekday').value : '0';
    return (Number(m) || 0) + ' ' + (Number(h) || 0) + ' * * ' + (Number(wd) || 0);
  }
  return (Number(m) || 0) + ' ' + (Number(h) || 0) + ' * * *';
}

/** 渲染任务列表 */
async function loadScheduleList() {
  const list = el('lingya-schedule-list');
  if (!list) return;
  try {
    const r = await window.electronAPI.scheduleList();
    const tasks = (r && r.success && r.tasks) || [];
    if (tasks.length === 0) {
      list.innerHTML = '<div class="lingya-schedule-empty">暂无定时任务</div>';
      return;
    }
    list.innerHTML = tasks.map((t) => {
      const meta = [];
      if (t.lastRunAt) meta.push('上次：' + new Date(t.lastRunAt).toLocaleString());
      else meta.push('尚未运行');
      return '<div class="lingya-schedule-item" data-id="' + t.id + '">' +
        '<div class="lingya-schedule-head">' +
        '<span class="lingya-schedule-name">' + esc(t.name) + '</span>' +
        '<span class="lingya-schedule-cron-tag">' + esc(t.cron) + '</span>' +
        (t.enabled ? '' : '<span class="lingya-schedule-off">已停用</span>') +
        '</div>' +
        '<div class="lingya-schedule-prompt">' + esc(t.prompt) + '</div>' +
        '<div class="lingya-schedule-meta">' + esc(meta.join(' · ')) + '</div>' +
        '<div class="lingya-schedule-ops">' +
        '<span class="lingya-schedule-op" data-act="run">立即执行</span>' +
        '<span class="lingya-schedule-op" data-act="edit">编辑</span>' +
        '<span class="lingya-schedule-op" data-act="toggle">' + (t.enabled ? '停用' : '启用') + '</span>' +
        '<span class="lingya-schedule-op" data-act="delete">删除</span>' +
        '</div>' +
        '</div>';
    }).join('');
    // 绑定操作
    list.querySelectorAll('.lingya-schedule-item').forEach((item) => {
      const id = item.dataset.id;
      item.querySelectorAll('.lingya-schedule-op').forEach((op) => {
        op.addEventListener('click', () => handleOp(op.dataset.act, id));
      });
    });
  } catch (err) {
    list.innerHTML = '<div class="lingya-schedule-empty">加载失败：' + esc(err.message) + '</div>';
  }
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

async function handleOp(act, id) {
  try {
    const r = await window.electronAPI.scheduleList();
    const tasks = (r && r.tasks) || [];
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    if (act === 'run') {
      await window.electronAPI.scheduleRunNow(id);
      showToast('已触发执行', 2000);
    } else if (act === 'toggle') {
      await window.electronAPI.scheduleUpdate(id, { enabled: !task.enabled });
      await loadScheduleList();
    } else if (act === 'delete') {
      if (!confirm('确定删除任务「' + task.name + '」？')) return;
      await window.electronAPI.scheduleDelete(id);
      await loadScheduleList();
    } else if (act === 'edit') {
      editingId = id;
      const t = el('lingya-schedule-form-title');
      if (t) t.textContent = '编辑任务：' + task.name;
      if (el('lingya-schedule-name')) el('lingya-schedule-name').value = task.name;
      if (el('lingya-schedule-prompt')) el('lingya-schedule-prompt').value = task.prompt;
      if (el('lingya-schedule-enabled')) el('lingya-schedule-enabled').checked = !!task.enabled;
      if (el('lingya-schedule-window')) el('lingya-schedule-window').value = task.profileId || '';
      if (el('lingya-schedule-project')) el('lingya-schedule-project').value = task.projectDir || '';
      // 反解析 cron：简单模式则填时间，否则填 cron 框
      const parts = task.cron.split(/\s+/);
      if (parts.length === 5 && parts[2] === '*' && parts[3] === '*') {
        if (el('lingya-schedule-hour')) el('lingya-schedule-hour').value = parts[1];
        if (el('lingya-schedule-minute')) el('lingya-schedule-minute').value = parts[0];
        if (parts[4] === '*') {
          if (el('lingya-schedule-mode')) el('lingya-schedule-mode').value = 'daily';
        } else {
          if (el('lingya-schedule-mode')) el('lingya-schedule-mode').value = 'weekly';
          if (el('lingya-schedule-weekday')) el('lingya-schedule-weekday').value = parts[4];
        }
      } else {
        if (el('lingya-schedule-mode')) el('lingya-schedule-mode').value = 'cron';
        if (el('lingya-schedule-cron')) el('lingya-schedule-cron').value = task.cron;
      }
      if (el('lingya-schedule-cancel')) el('lingya-schedule-cancel').classList.remove('lingya-hidden');
      updateModeVisibility();
    }
  } catch (err) {
    showToast('操作失败：' + err.message, 3000);
  }
}

/** 保存任务（新建或更新） */
async function saveSchedule() {
  const name = el('lingya-schedule-name') ? el('lingya-schedule-name').value.trim() : '';
  const prompt = el('lingya-schedule-prompt') ? el('lingya-schedule-prompt').value.trim() : '';
  const cron = collectCron();
  const enabled = el('lingya-schedule-enabled') ? el('lingya-schedule-enabled').checked : true;
  const profileId = el('lingya-schedule-window') ? el('lingya-schedule-window').value : '';
  const projectDir = el('lingya-schedule-project') ? el('lingya-schedule-project').value.trim() : '';
  if (!name) { showToast('请填任务名', 2000); return; }
  if (!prompt) { showToast('请填给 AI 的指令', 2000); return; }
  // 校验 cron
  const v = await window.electronAPI.scheduleValidate(cron);
  if (!v || !v.valid) { showToast('调度表达式无效：' + cron, 3000); return; }
  try {
    let r;
    const data = { name, cron, prompt, enabled, profileId, projectDir };
    if (editingId) {
      r = await window.electronAPI.scheduleUpdate(editingId, data);
    } else {
      r = await window.electronAPI.scheduleAdd(data);
    }
    if (!r || !r.success) {
      showToast('保存失败：' + ((r && r.error) || '未知错误'), 3000);
      return;
    }
    showToast(editingId ? '已更新' : '已创建', 2000);
    resetForm();
    await loadScheduleList();
  } catch (err) {
    showToast('保存失败：' + err.message, 3000);
  }
}

/** cron 输入实时校验提示 */
async function validateCronHint() {
  const hint = el('lingya-schedule-cron-hint');
  if (!hint) return;
  const mode = el('lingya-schedule-mode') ? el('lingya-schedule-mode').value : 'daily';
  if (mode !== 'cron') { hint.textContent = ''; return; }
  const cron = collectCron();
  if (!cron) { hint.textContent = ''; return; }
  try {
    const v = await window.electronAPI.scheduleValidate(cron);
    hint.textContent = v && v.valid ? '✅ 表达式有效' : '❌ 表达式无效（格式：分 时 日 月 周）';
    hint.style.color = v && v.valid ? '#4ade80' : '#f87171';
  } catch (_) {}
}

function bindSchedulePanelEvents() {
  const openBtn = el('lingya-btn-schedule');
  openBtn && openBtn.addEventListener('click', openScheduleManager);

  const closeBtn = el('lingya-schedule-close');
  closeBtn && closeBtn.addEventListener('click', closeScheduleManager);

  const refreshBtn = el('lingya-schedule-refresh');
  refreshBtn && refreshBtn.addEventListener('click', loadScheduleList);

  const saveBtn = el('lingya-schedule-save');
  saveBtn && saveBtn.addEventListener('click', saveSchedule);

  const cancelBtn = el('lingya-schedule-cancel');
  cancelBtn && cancelBtn.addEventListener('click', resetForm);

  const modeSel = el('lingya-schedule-mode');
  modeSel && modeSel.addEventListener('change', () => { updateModeVisibility(); validateCronHint(); });

  const cronInput = el('lingya-schedule-cron');
  cronInput && cronInput.addEventListener('input', validateCronHint);
}

module.exports = { bindSchedulePanelEvents, openScheduleManager, closeScheduleManager };
