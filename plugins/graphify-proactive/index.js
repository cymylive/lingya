// 图谱优先插件（graphify-proactive）
// 目标：让 AI 开发/修 bug 时主动查知识图谱，而不是默认先 grep。
// 三层能力：提示词注入、六个 gq_* 工具、启动时自动建图。

export const name = 'graphify-proactive'
export const inject = []

const DEFAULT_PROMPT = [
  '## 图谱优先（Graphify）',
  '',
  '当前项目已建立代码知识图谱。处理下列问题前，**优先查图，不要直接 grep**：',
  '',
  '- 「这个类/函数谁在用」「改了会影响什么」→ `gq_explain`',
  '- 「A 和 B 怎么连起来的」→ `gq_path`',
  '- 「这个模块的架构是什么」「核心抽象有哪些」→ `gq_godnodes`',
  '- 接手陌生模块、评估改动影响面 → 先 `gq_status` 看图是否可用',
  '',
  '**grep 更适合**：找具体字符串、找某个配置项出现在哪、看代码原文。',
  '',
  '图谱过期时先调 `gq_build` 重建，不要基于旧图下结论。',
].join('\n')

export function apply(ctx) {
  const path = require('path')
  const fs = require('fs')
  const { spawnSync, spawn } = require('child_process')

  const readCfg = () => {
    const c = Object.assign(
      { enabled: true, autoBuild: true, staleMinutes: 30, customPrompt: '' },
      ctx.config || {}
    )
    c.enabled = c.enabled !== false
    c.autoBuild = c.autoBuild !== false
    c.staleMinutes = Math.max(0, Number(c.staleMinutes) || 30)
    c.customPrompt = String(c.customPrompt || '')
    return c
  }

  function locateCli() {
    const cands = []
    try { if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'graphify', 'graphify.exe')) } catch (_) {}
    cands.push(path.join(__dirname, '..', '..', 'resources', 'graphify', 'graphify.exe'))
    for (const p of cands) {
      try { if (p && fs.existsSync(p)) return p } catch (_) {}
    }
    return null
  }

  function getGraphDir() {
    const { app } = require('electron')
    return path.join(app.getPath('userData'), 'graphify')
  }
  function getGraphJson() { return path.join(getGraphDir(), 'graph.json') }
  function getSourceFile() { return path.join(getGraphDir(), '.source.json') }

  function readSource() {
    try {
      const j = JSON.parse(fs.readFileSync(getSourceFile(), 'utf-8'))
      return j && typeof j.projectDir === 'string' ? j : null
    } catch (_) { return null }
  }

  function currentProjectDir() {
    const s = readSource()
    if (s && fs.existsSync(s.projectDir)) return s.projectDir
    try {
      const sessionStore = require(path.join(__dirname, '..', '..', 'src', 'main', 'session-store'))
      const d = sessionStore.state && sessionStore.state.selectedProjectDir
      if (d && fs.existsSync(d)) return d
    } catch (_) {}
    return null
  }

  function graphStatus() {
    const graphJson = getGraphJson()
    if (!fs.existsSync(graphJson)) {
      return { exists: false, stale: true, reason: '图谱不存在' }
    }
    const gStat = fs.statSync(graphJson)
    const src = readSource()
    const projectDir = src && src.projectDir
    let newestSrc = 0
    let newestFile = ''
    if (projectDir && fs.existsSync(projectDir)) {
      const SKIP = new Set(['node_modules', 'dist', 'build', '.git', 'graphify-out', 'coverage'])
      const EXTS = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.py'])
      let scanned = 0
      const walk = (dir, depth) => {
        if (depth > 6 || scanned > 5000) return
        let ents = []
        try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return }
        for (const e of ents) {
          if (e.name.startsWith('.')) continue
          if (SKIP.has(e.name)) continue
          const full = path.join(dir, e.name)
          if (e.isDirectory()) { walk(full, depth + 1); continue }
          if (!EXTS.has(path.extname(e.name).toLowerCase())) continue
          scanned++
          try {
            const st = fs.statSync(full)
            if (st.mtimeMs > newestSrc) { newestSrc = st.mtimeMs; newestFile = full }
          } catch (_) {}
        }
      }
      walk(projectDir, 0)
    }
    const cfg = readCfg()
    const ageMin = (Date.now() - gStat.mtimeMs) / 60000
    const staleByAge = cfg.staleMinutes > 0 && ageMin > cfg.staleMinutes
    const staleBySrc = newestSrc > gStat.mtimeMs
    return {
      exists: true,
      stale: staleByAge || staleBySrc,
      ageMinutes: Math.round(ageMin),
      staleByAge: staleByAge,
      staleBySrc: staleBySrc,
      newestSrcFile: newestFile,
      projectDir: projectDir || null,
      sizeMB: Math.round(gStat.size / 1048576 * 100) / 100,
      mtime: new Date(gStat.mtimeMs).toISOString(),
    }
  }

  function runCli(args, timeoutMs) {
    const cli = locateCli()
    if (!cli) return { ok: false, error: 'graphify.exe 未找到（resources/graphify/）' }
    const r = spawnSync(cli, args, {
      encoding: 'utf-8',
      timeout: timeoutMs || 60000,
      maxBuffer: 16 * 1024 * 1024,
      env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }),
    })
    if (r.error) return { ok: false, error: r.error.message }
    if (r.status !== 0) {
      const msg = (r.stderr || r.stdout || '').trim().slice(-500)
      return { ok: false, error: '退出码 ' + r.status + (msg ? ': ' + msg : '') }
    }
    return { ok: true, out: String(r.stdout || '') }
  }

  function ensureGraphArg() {
    const g = getGraphJson()
    if (!fs.existsSync(g)) {
      return { error: '图谱尚未生成。先调用 gq_build 建图，或确认项目已初始化。' }
    }
    return { graph: g }
  }

  ctx.tools.register({
    name: 'gq_status',
    description: '查看当前项目知识图谱状态：是否存在、是否过期、大小、来源项目。查结构问题前先看这个。',
    parameters: {},
    execute() {
      const st = graphStatus()
      const lines = []
      lines.push('图谱状态：' + (st.exists ? (st.stale ? '已过期' : '可用') : '不存在'))
      if (st.exists) {
        lines.push('- 文件：' + getGraphJson())
        lines.push('- 大小：' + st.sizeMB + ' MB，建于 ' + st.mtime + '（' + st.ageMinutes + ' 分钟前）')
        lines.push('- 来源项目：' + (st.projectDir || '(未记录)'))
        if (st.staleByAge) lines.push('- 过期原因：超过 ' + readCfg().staleMinutes + ' 分钟未更新')
        if (st.staleBySrc) lines.push('- 过期原因：源码有更新，最新为 ' + st.newestSrcFile)
        if (st.stale) lines.push('')
        if (st.stale) lines.push('建议先调 gq_build 重建，再查图。')
      } else {
        lines.push('')
        lines.push('先调 gq_build 建图。')
      }
      return lines.join('\n')
    },
  })

  ctx.tools.register({
    name: 'gq_explain',
    description: '查一个符号（类/函数/模块名）的全部关系：谁 import 它、它有哪些方法、被哪些测试覆盖。改代码前评估影响面首选。',
    parameters: {
      name: { type: 'string', description: '符号名，如 ToolRegistry、JsRunner、memoryRecall' },
    },
    execute(args) {
      const nm = String((args && args.name) || '').trim()
      if (!nm) return { success: false, error: 'name 不能为空' }
      const e = ensureGraphArg()
      if (e.error) return { success: false, error: e.error }
      const r = runCli(['explain', nm, '--graph', e.graph], 60000)
      if (!r.ok) return { success: false, error: r.error }
      return r.out.slice(0, 18000)
    },
  })

  ctx.tools.register({
    name: 'gq_path',
    description: '查两个符号之间的最短连接路径，回答「A 和 B 怎么连起来的」。',
    parameters: {
      source: { type: 'string', description: '起点符号' },
      target: { type: 'string', description: '终点符号' },
      undirected: { type: 'boolean', description: '忽略边方向（默认 false）' },
    },
    execute(args) {
      const a = String((args && args.source) || '').trim()
      const b = String((args && args.target) || '').trim()
      if (!a || !b) return { success: false, error: 'source 与 target 都不能为空' }
      const e = ensureGraphArg()
      if (e.error) return { success: false, error: e.error }
      const cliArgs = ['path', a, b, '--graph', e.graph]
      if (args && args.undirected) cliArgs.push('--undirected')
      const r = runCli(cliArgs, 60000)
      if (!r.ok) return { success: false, error: r.error }
      return r.out.slice(0, 18000)
    },
  })

  ctx.tools.register({
    name: 'gq_godnodes',
    description: '列出图谱中度数最高的节点（核心抽象）。评估「哪里最该加测试」「架构枢纽在哪」时用。',
    parameters: {
      top_n: { type: 'integer', description: '返回条数，默认 10，最多 50' },
    },
    execute(args) {
      const e = ensureGraphArg()
      if (e.error) return { success: false, error: e.error }
      const n = Math.max(1, Math.min(50, Number(args && args.top_n) || 10))
      const r = runCli(['god-nodes', '--graph', e.graph, '--top', String(n)], 60000)
      if (!r.ok) return { success: false, error: r.error }
      return r.out.slice(0, 12000)
    },
  })

  ctx.tools.register({
    name: 'gq_query',
    description: '用自然语言问代码结构问题（BFS 遍历）。中文查询需 jieba 扩展（当前未装），建议用英文关键词或改用 gq_explain 直接点名。',
    parameters: {
      question: { type: 'string', description: '问题，建议英文关键词' },
      depth: { type: 'integer', description: '遍历深度 1-6，默认 2' },
    },
    execute(args) {
      const q = String((args && args.question) || '').trim()
      if (!q) return { success: false, error: 'question 不能为空' }
      const e = ensureGraphArg()
      if (e.error) return { success: false, error: e.error }
      const r = runCli(['query', q, '--graph', e.graph], 60000)
      if (!r.ok) return { success: false, error: r.error }
      return r.out.slice(0, 15000)
    },
  })

  ctx.tools.register({
    name: 'gq_build',
    description: '为当前项目重建知识图谱。图不存在或已过期时调用。构建需几十秒，期间勿重复调用。',
    parameters: {},
    async execute() {
      const cli = locateCli()
      if (!cli) return { success: false, error: 'graphify.exe 未找到（resources/graphify/）' }
      const proj = currentProjectDir()
      if (!proj) return { success: false, error: '无法确定当前项目目录。请先初始化项目。' }
      const outDir = getGraphDir()
      try { fs.mkdirSync(outDir, { recursive: true }) } catch (_) {}
      return await new Promise((resolve) => {
        let settled = false
        const finish = (r) => { if (!settled) { settled = true; resolve(r) } }
        const child = spawn(cli, ['extract', proj, '--code-only'], {
          cwd: proj,
          windowsHide: true,
          env: Object.assign({}, process.env, { GRAPHIFY_OUT: outDir, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }),
        })
        let stderr = ''
        child.stderr.on('data', (d) => { stderr += d.toString() })
        child.on('error', (err) => finish({ success: false, error: '启动失败: ' + err.message }))
        child.on('close', (code) => {
          if (code !== 0) {
            finish({ success: false, error: '建图失败，退出码 ' + code + (stderr ? ': ' + stderr.slice(-300) : '') })
            return
          }
          const st = graphStatus()
          finish('图谱已重建：' + (st.sizeMB || 0) + ' MB，项目 ' + proj)
        })
      })
    },
  })

  // ===== 提示词注入 =====
  // 通过 ctx.registerPromptSection 注册，内核拼进 {{PLUGIN_CUSTOM_SECTION}}
  // （位于 systemPrompt 第一段，紧邻插件能力章节）
  try {
    ctx.registerPromptSection('GRAPHIFY_PROACTIVE', () => {
      const cfg = readCfg()
      if (!cfg.enabled) return ''
      const st = graphStatus()
      const head = (cfg.customPrompt && cfg.customPrompt.trim())
        ? cfg.customPrompt.trim()
        : DEFAULT_PROMPT
      let status = ''
      if (!st.exists) {
        status = '\n\n> 当前图谱**尚未生成**，需先调 \`gq_build\`。'
      } else if (st.stale) {
        status = '\n\n> 当前图谱**已过期**（' + (st.staleBySrc ? '源码有更新' : st.ageMinutes + ' 分钟未重建') + '），查图前先 \`gq_build\`。'
      }
      return head + status
    })
  } catch (err) {
    ctx.log('注册提示词 section 失败:', err && err.message)
  }

  // ===== 配置 IPC =====
  ctx.registerIpc('getConfig', async () => {
    const c = readCfg()
    return {
      enabled: c.enabled,
      autoBuild: c.autoBuild,
      staleMinutes: c.staleMinutes,
      customPrompt: c.customPrompt,
      defaultPrompt: DEFAULT_PROMPT,
      status: graphStatus(),
    }
  })

  ctx.registerIpc('saveConfig', async (patch) => {
    const prev = readCfg()
    const next = Object.assign({}, prev, patch || {})
    next.enabled = next.enabled !== false
    next.autoBuild = next.autoBuild !== false
    next.staleMinutes = Math.max(0, Number(next.staleMinutes) || 30)
    next.customPrompt = String(next.customPrompt || '')
    ctx.config = next
    if (ctx.settings && ctx.settings.save) ctx.settings.save()
    return next
  })

  ctx.registerIpc('rebuildNow', async () => {
    const cli = locateCli()
    if (!cli) return { success: false, error: 'graphify.exe 未找到' }
    const proj = currentProjectDir()
    if (!proj) return { success: false, error: '无法确定项目目录' }
    const outDir = getGraphDir()
    try { fs.mkdirSync(outDir, { recursive: true }) } catch (_) {}
    return await new Promise((resolve) => {
      let settled = false
      const finish = (x) => { if (!settled) { settled = true; resolve(x) } }
      const child = spawn(cli, ['extract', proj, '--code-only'], {
        cwd: proj, windowsHide: true,
        env: Object.assign({}, process.env, { GRAPHIFY_OUT: outDir, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }),
      })
      let err = ''
      child.stderr.on('data', (d) => { err += d.toString() })
      child.on('error', (e) => finish({ success: false, error: e.message }))
      child.on('close', (code) => {
        if (code !== 0) finish({ success: false, error: '退出码 ' + code + ': ' + err.slice(-300) })
        else finish({ success: true, status: graphStatus() })
      })
    })
  })

  // ===== 侧栏面板 =====
  const SCRIPT = [
    '(function(){',
    '  function q(id){ return document.getElementById(id); }',
    '  function load(){',
    '    window.shellAPI.pluginInvoke("graphify-proactive","getConfig",{}).then(function(r){',
    '      if(!r||!r.success) return;',
    '      var d=r.data||{};',
    '      var e=q("gq-enabled"); if(e) e.checked = d.enabled!==false;',
    '      var ab=q("gq-auto"); if(ab) ab.checked = d.autoBuild!==false;',
    '      var sm=q("gq-stale"); if(sm) sm.value = d.staleMinutes==null?30:d.staleMinutes;',
    '      var cp=q("gq-prompt"); if(cp && !cp.value) cp.value = d.customPrompt||d.defaultPrompt||"";',
    '      var st=q("gq-status"); if(st && d.status){',
    '        st.textContent = d.status.exists',
    '          ? ("图谱 " + (d.status.stale?"已过期":"可用") + " · " + d.status.sizeMB + " MB · " + d.status.ageMinutes + " 分钟前")',
    '          : "图谱尚未生成";',
    '      }',
    '    }).catch(function(){});',
    '  }',
    '  var b=q("gq-save");',
    '  if(b) b.addEventListener("click", function(){',
    '    var cp=q("gq-prompt"); var sm=q("gq-stale");',
    '    window.shellAPI.pluginInvoke("graphify-proactive","saveConfig",{',
    '      enabled: q("gq-enabled") ? q("gq-enabled").checked : true,',
    '      autoBuild: q("gq-auto") ? q("gq-auto").checked : true,',
    '      staleMinutes: sm ? Number(sm.value) : 30,',
    '      customPrompt: cp ? cp.value : ""',
    '    }).then(function(){ var t=q("gq-status"); if(t) t.textContent="已保存，下次初始化项目后生效"; });',
    '  });',
    '  var rb=q("gq-rebuild");',
    '  if(rb) rb.addEventListener("click", function(){',
    '    var t=q("gq-status"); if(t) t.textContent="正在重建，请稍候…";',
    '    window.shellAPI.pluginInvoke("graphify-proactive","rebuildNow",{}).then(function(r){',
    '      if(t) t.textContent = (r&&r.success) ? "重建完成" : ("重建失败：" + ((r&&r.error)||""));',
    '      setTimeout(load, 500);',
    '    });',
    '  });',
    '  setTimeout(load, 100);',
    '})();',
  ].join('\n')

  ctx.registerView({
    id: 'main',
    icon: '🕸️',
    label: '图谱',
    title: '图谱优先 · Graphify',
    render() {
      let cfg
      try { cfg = readCfg() } catch (_) { cfg = { enabled: true, autoBuild: true, staleMinutes: 30, customPrompt: '' } }
      const promptText = (cfg.customPrompt || DEFAULT_PROMPT)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      return [
        '<div class="sh-panel-head"><span class="sh-panel-title">🕸️ 图谱优先</span></div>',
        '<div class="sh-panel-body">',
        '  <div id="gq-status" style="margin-bottom:10px;color:#2dd4bf;font-size:12px;">加载中…</div>',
        '  <label style="display:block;margin:8px 0;"><input type="checkbox" id="gq-enabled" /> 启用提示词注入</label>',
        '  <label style="display:block;margin:8px 0;"><input type="checkbox" id="gq-auto" /> 启动时自动建图</label>',
        '  <label style="display:block;margin:8px 0;">过期阈值（分钟，0=不按时间判断）<br>',
        '    <input id="gq-stale" type="number" min="0" style="width:90px;" />',
        '  </label>',
        '  <div style="margin:10px 0 4px;font-size:12px;color:#94a3b8;">自定义触发规则（留空用默认）</div>',
        '  <textarea id="gq-prompt" style="width:100%;height:220px;font-family:monospace;font-size:12px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:4px;padding:6px;">' + promptText + '</textarea>',
        '  <div style="margin-top:10px;display:flex;gap:8px;">',
        '    <button id="gq-save" class="lingya-btn">保存</button>',
        '    <button id="gq-rebuild" class="lingya-btn lingya-btn-secondary">立即重建图谱</button>',
        '  </div>',
        '  <script>' + SCRIPT + '</' + 'script>',
        '</div>',
      ].join('\n')
    },
  })

  // ===== 启动时自动建图 =====
  // 延后 5 秒执行，绝不阻塞主进程启动
  try {
    setTimeout(() => {
      try {
        const cfg = readCfg()
        if (!cfg.enabled || !cfg.autoBuild) return
        const st = graphStatus()
        if (st.exists && !st.stale) {
          ctx.log('图谱可用，跳过自动建图')
          return
        }
        const cli = locateCli()
        if (!cli) { ctx.log('graphify.exe 未找到，跳过自动建图'); return }
        const proj = currentProjectDir()
        if (!proj) { ctx.log('无法确定项目目录，跳过自动建图'); return }
        const outDir = getGraphDir()
        try { fs.mkdirSync(outDir, { recursive: true }) } catch (_) {}
        ctx.log('图谱' + (st.exists ? '过期' : '缺失') + '，后台建图中: ' + proj)
        const child = spawn(cli, ['extract', proj, '--code-only'], {
          cwd: proj,
          windowsHide: true,
          env: Object.assign({}, process.env, { GRAPHIFY_OUT: outDir, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }),
        })
        child.on('close', (code) => ctx.log('自动建图结束，退出码 ' + code))
        child.on('error', (e) => ctx.log('自动建图失败: ' + e.message))
      } catch (e) {
        ctx.log('自动建图异常: ' + (e && e.message))
      }
    }, 5000)
  } catch (_) {}
}
