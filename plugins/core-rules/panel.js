(function () {
  var PLUGIN = 'core-rules';
  var rules = [];
  var editingId = null;
  var listEl, nameEl, contentEl, editorEl, msgEl;

  function invoke(channel, args) {
    return window.shellAPI.pluginInvoke(PLUGIN, channel, args || {});
  }

  function flash(text) {
    if (!msgEl) return;
    msgEl.textContent = text;
    setTimeout(function () { if (msgEl.textContent === text) msgEl.textContent = ''; }, 2200);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function renderList() {
    if (!rules.length) {
      listEl.innerHTML = '<div style="font-size:11.5px;color:var(--ck-text-dim);padding:10px 4px;">还没有规则。点下方「新增规则」开始。</div>';
      return;
    }
    var html = rules.map(function (r, i) {
      var checked = r.enabled !== false ? ' checked' : '';
      var upDis = i === 0 ? ' disabled' : '';
      var downDis = i === rules.length - 1 ? ' disabled' : '';
      var id = esc(r.id);
      return '<div class="sh-card" style="display:flex;align-items:flex-start;gap:6px;padding:6px 8px;margin-bottom:6px;">' +
        '<input type="checkbox" data-act="toggle" data-id="' + id + '"' + checked + ' title="启用/禁用" style="margin-top:3px;" />' +
        '<span style="flex:1;font-size:12px;word-break:break-all;line-height:1.4;" title="' + esc(r.name) + '">' + esc(r.name) + '</span>' +
        '<div style="display:flex;gap:2px;flex-shrink:0;">' +
        '<button class="sh-btn" data-act="up" data-id="' + id + '"' + upDis + ' style="font-size:11px;padding:1px 4px;" title="上移">↑</button>' +
        '<button class="sh-btn" data-act="down" data-id="' + id + '"' + downDis + ' style="font-size:11px;padding:1px 4px;" title="下移">↓</button>' +
        '<button class="sh-btn" data-act="edit" data-id="' + id + '" style="font-size:11px;padding:1px 4px;">编辑</button>' +
        '<button class="sh-btn" data-act="del" data-id="' + id + '" style="font-size:11px;padding:1px 4px;">删除</button>' +
        '</div>' +
        '</div>';
    }).join('');
    listEl.innerHTML = html;
  }

  function openEditor(id) {
    editingId = id || null;
    var r = null;
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].id === editingId) { r = rules[i]; break; }
    }
    nameEl.value = r ? r.name : '';
    contentEl.value = r ? r.content : '';
    editorEl.style.display = 'block';
    nameEl.focus();
  }

  function closeEditor() {
    editingId = null;
    editorEl.style.display = 'none';
    nameEl.value = '';
    contentEl.value = '';
  }

  function persist() {
    return invoke('saveConfig', { rules: rules }).then(function (res) {
      if (res && res.success) {
        if (res.data && Array.isArray(res.data.rules)) rules = res.data.rules;
        renderList();
        flash('已保存（重新初始化项目后生效）');
      } else {
        flash('保存失败: ' + ((res && res.error) || 'unknown'));
      }
      return res;
    });
  }

  function moveLocal(arr, id, dir) {
    var idx = -1;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].id === id) { idx = i; break; }
    }
    if (idx < 0) return arr;
    var target = dir === 'up' ? idx - 1 : idx + 1;
    if (target < 0 || target >= arr.length) return arr;
    var next = arr.slice();
    var tmp = next[idx]; next[idx] = next[target]; next[target] = tmp;
    next.forEach(function (r, i) { r.order = i; });
    return next;
  }

  function handleListClick(ev) {
    var t = ev.target;
    if (!t || !t.getAttribute) return;
    var act = t.getAttribute('data-act');
    var id = t.getAttribute('data-id');
    if (!act || !id) return;
    if (act === 'toggle') {
      for (var i = 0; i < rules.length; i++) {
        if (rules[i].id === id) { rules[i].enabled = t.checked; break; }
      }
      persist();
    } else if (act === 'up' || act === 'down') {
      rules = moveLocal(rules, id, act);
      persist();
    } else if (act === 'edit') {
      openEditor(id);
    } else if (act === 'del') {
      if (!confirm('确定删除这条规则吗？')) return;
      rules = rules.filter(function (r) { return r.id !== id; });
      rules.forEach(function (r, i) { r.order = i; });
      if (editingId === id) closeEditor();
      persist();
    }
  }

  function saveEditor() {
    var nm = (nameEl.value || '').trim() || '未命名规则';
    var ct = (contentEl.value || '').trim();
    if (!ct) { flash('规则内容不能为空'); return; }
    if (editingId) {
      for (var i = 0; i < rules.length; i++) {
        if (rules[i].id === editingId) { rules[i].name = nm; rules[i].content = ct; break; }
      }
    } else {
      rules.push({
        id: 'tmp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: nm, content: ct, enabled: true, order: rules.length
      });
    }
    closeEditor();
    persist();
  }

  function boot() {
    listEl = document.getElementById('cr-list');
    nameEl = document.getElementById('cr-name');
    contentEl = document.getElementById('cr-content');
    editorEl = document.getElementById('cr-editor');
    msgEl = document.getElementById('cr-msg');
    if (!listEl) return;

    listEl.addEventListener('click', handleListClick);
    var addBtn = document.getElementById('cr-add');
    if (addBtn) addBtn.addEventListener('click', function () { openEditor(null); });
    var saveBtn = document.getElementById('cr-save');
    if (saveBtn) saveBtn.addEventListener('click', saveEditor);
    var cancelBtn = document.getElementById('cr-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', closeEditor);

    var importBtn = document.getElementById('cr-import');
    if (importBtn) importBtn.addEventListener('click', function () {
      importBtn.disabled = true;
      invoke('importRules').then(function (res) {
        importBtn.disabled = false;
        if (res && res.success) {
          if (res.data && Array.isArray(res.data.rules)) rules = res.data.rules;
          renderList();
          flash('已导入：新增 ' + (res.data.added || 0) + ' 条，覆盖 ' + (res.data.overwritten || 0) + ' 条');
        } else if (res && res.canceled) {
          /* 用户取消，静默 */
        } else {
          flash('导入失败：' + ((res && res.error) || '未知'));
        }
      })['catch'](function () { importBtn.disabled = false; flash('导入失败'); });
    });

    var exportBtn = document.getElementById('cr-export');
    if (exportBtn) exportBtn.addEventListener('click', function () {
      exportBtn.disabled = true;
      invoke('exportRules').then(function (res) {
        exportBtn.disabled = false;
        if (res && res.success) {
          flash('已导出 ' + (res.data.count || 0) + ' 条规则');
        } else if (res && res.canceled) {
          /* 用户取消，静默 */
        } else {
          flash('导出失败：' + ((res && res.error) || '未知'));
        }
      })['catch'](function () { exportBtn.disabled = false; flash('导出失败'); });
    });

    invoke('getConfig').then(function (res) {
      if (res && res.success && res.data && Array.isArray(res.data.rules)) {
        rules = res.data.rules;
      }
      renderList();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
