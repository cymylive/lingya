export const name = 'core-rules'
export const inject = []

const __req = eval('require')
const path = __req('path')
const fs = __req('fs')

// 必须用绝对路径 require，因为主进程的 require 基准目录不是插件目录
const modelPath = path.join(__dirname, 'rules-model.js')
const { normalizeRules, buildInjectionText, mergeRules } = __req(modelPath)

let SCRIPT = ''
try {
  const scriptPath = path.join(__dirname, 'panel.js')
  SCRIPT = fs.readFileSync(scriptPath, 'utf8')
} catch (err) {
  SCRIPT = 'console.warn("[core-rules] panel.js 加载失败:", ' + JSON.stringify(String(err && err.message)) + ')'
}

export function apply(ctx) {
  const readRules = () => normalizeRules(ctx.config || {})

  ctx.registerIpc('getConfig', async () => {
    return { rules: readRules() }
  })

  ctx.registerIpc('saveConfig', async (patch) => {
    const incoming = patch && Array.isArray(patch.rules) ? patch.rules : []
    const next = normalizeRules({ rules: incoming })
    ctx.config = Object.assign({}, ctx.config || {}, { rules: next })
    delete ctx.config.reportText
    delete ctx.config.enabled
    if (ctx.settings && typeof ctx.settings.save === 'function') {
      ctx.settings.save()
    }
    return { success: true, rules: next }
  })

  ctx.registerIpc('exportRules', async (args, event) => {
    const rules = readRules();
    if (!rules.length) {
      return { success: false, error: '没有可导出的规则' };
    }
    const electron = __req('electron');
    const { dialog, BrowserWindow } = electron;
    const parent = (() => {
      try {
        const wc = event && event.sender;
        return wc ? BrowserWindow.fromWebContents(wc) : null;
      } catch (_) { return null; }
    })();
    const stamp = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const defaultName = 'core-rules-' + stamp.getFullYear() + pad(stamp.getMonth() + 1) + pad(stamp.getDate()) + '.json';
    const opts = {
      title: '导出核心规则',
      defaultPath: defaultName,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    };
    const picked = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts);
    if (!picked || picked.canceled || !picked.filePath) {
      return { success: false, canceled: true };
    }
    const bundle = {
      plugin: 'core-rules',
      version: (() => {
        try {
          const mf = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
          return mf.version || '';
        } catch (_) { return ''; }
      })(),
      exportedAt: new Date().toISOString(),
      rules,
    };
    try {
      fs.writeFileSync(picked.filePath, JSON.stringify(bundle, null, 2), 'utf8');
      return { success: true, path: picked.filePath, count: rules.length };
    } catch (err) {
      return { success: false, error: '写入失败：' + err.message };
    }
  });

  ctx.registerIpc('importRules', async (args, event) => {
    const electron = __req('electron');
    const { dialog, BrowserWindow } = electron;
    const parent = (() => {
      try {
        const wc = event && event.sender;
        return wc ? BrowserWindow.fromWebContents(wc) : null;
      } catch (_) { return null; }
    })();
    const opts = {
      title: '导入核心规则',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    };
    const picked = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
    if (!picked || picked.canceled || !picked.filePaths || !picked.filePaths.length) {
      return { success: false, canceled: true };
    }
    const filePath = picked.filePaths[0];
    let parsed;
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      parsed = JSON.parse(text);
    } catch (_) {
      return { success: false, error: '文件格式错误' };
    }
    const incoming = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.rules) ? parsed.rules : null);
    if (!Array.isArray(incoming)) {
      return { success: false, error: '文件格式错误' };
    }
    const base = readRules();
    const merged = mergeRules(base, incoming);
    const baseIds = new Set(base.map((r) => r.id));
    let added = 0;
    let overwritten = 0;
    for (const r of incoming) {
      if (!r || !r.id) continue;
      if (baseIds.has(String(r.id))) overwritten++;
      else added++;
    }
    ctx.config = Object.assign({}, ctx.config || {}, { rules: merged });
    delete ctx.config.reportText;
    delete ctx.config.enabled;
    if (ctx.settings && typeof ctx.settings.save === 'function') ctx.settings.save();
    return { success: true, added, overwritten, total: merged.length, rules: merged };
  });

  const isScheduledTask = () => {
    try {
      const cur = ctx.sessions.current()
      if (cur && cur.projectDir) {
        const dir = String(cur.projectDir).toLowerCase()
        if (dir.includes('scheduled-tasks') || dir.includes('定时任务')) return true
      }
      if (process.cwd()) {
        const cwd = process.cwd().toLowerCase()
        if (cwd.includes('scheduled-tasks') || cwd.includes('定时任务')) return true
      }
    } catch (_) {}
    return false
  }

  ctx.registerPromptSection('CORE_RULES_LIST', () => {
    if (isScheduledTask()) return ''
    return buildInjectionText(readRules())
  })

  ctx.registerView({
    id: 'main',
    icon: '📜',
    label: '规则',
    title: '核心规则',
    render() {
      return [
        '<div class="sh-panel-head"><span class="sh-panel-title">核心规则</span></div>',
        '<div class="sh-panel-body">',
        '  <div class="sh-card" style="margin-bottom:8px;font-size:11.5px;line-height:1.6;color:var(--ck-text-dim);">',
        '    规则按列表顺序拼接到系统提示词。修改后需重新初始化项目才会生效。',
        '  </div>',
        '  <div id="cr-list"></div>',
        '  <div style="display:flex;gap:6px;margin-top:6px;">',
        '    <button class="sh-btn" id="cr-import" style="flex:1;font-size:12px;">导入规则</button>',
        '    <button class="sh-btn" id="cr-export" style="flex:1;font-size:12px;">导出规则</button>',
        '  </div>',
        '  <button class="sh-btn primary" id="cr-add" style="width:100%;font-size:12px;margin-top:6px;">+ 新增规则</button>',
        '  <div id="cr-editor" style="display:none;margin-top:10px;border-top:1px solid var(--ck-border);padding-top:10px;">',
        '    <div style="font-size:11px;color:var(--ck-text-dim);margin-bottom:2px;">规则名称</div>',
        '    <input id="cr-name" type="text" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;margin-bottom:8px;" />',
        '    <div style="font-size:11px;color:var(--ck-text-dim);margin-bottom:2px;">规则内容</div>',
        '    <textarea id="cr-content" rows="12" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;margin-bottom:8px;resize:vertical;"></textarea>',
        '    <button class="sh-btn primary" id="cr-save" style="width:100%;font-size:12px;">保存规则</button>',
        '    <button class="sh-btn" id="cr-cancel" style="width:100%;font-size:12px;margin-top:6px;">取消</button>',
        '  </div>',
        '  <div id="cr-msg" style="font-size:11px;color:var(--ck-accent);height:16px;margin-top:6px;text-align:center;"></div>',
        '  <script>' + SCRIPT + '</' + 'script>',
        '</div>',
      ].join('\n')
    },
  })

  ctx.log('核心规则插件已加载（v2.0.0 多规则版）')
}
