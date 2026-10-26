// 任务守望者插件
// 任务中途停止（计划有未完成项 + AI 长时间无输出）时，自动催促 AI 继续推进。
//
// 判定条件（全部满足才催促）：
//   1. 未处于「已停止 / AI 在等用户回答 / 初始化分批发送中 / AI 已声明完成」
//   2. 距最后一次活动超过阈值（默认 120 秒）
//   3. 计划里还有未完成项（requirePlan 可关）
//   4. 本会话催促次数未超上限（0 = 不限）
//
// 计数持久化在主进程插件配置里（nudgeCounts），页面刷新 / 重启都不归零。
// 发送通道走 window.__lingyaPluginAPI.sendMessage（由 preload 注入），
// 插件脚本本身是裸函数，不能 require 项目内部模块。

export const name = 'task-watcher'
export const inject = []

const DEFAULTS = {
  enabled: true,
  thresholdSec: 120,
  maxNudge: 3,
  requirePlan: true,
  promptText: '请检查是否还有任务未执行完，如果有就继续；如果都做完了，请明确说任务已完成。',
  // 每会话催促计数：{ [sessionId]: { count, at } }
  // at = 上次催促时刻，用于判断「催促后是否又有新活动」
  nudgeCounts: {},
}

// 陈旧计数清理阈值：超过这个时长没有更新的记录直接丢弃，避免无限累积
const COUNT_TTL_MS = 24 * 60 * 60 * 1000

const PRELOAD_SCRIPT = "(function () {\n  if (window.__lingyaTaskWatcherInstalled) return;\n  window.__lingyaTaskWatcherInstalled = true;\n\n  var PLUGIN_ID = \"task-watcher\";\n  var CHECK_INTERVAL_MS = 15000;      // 检查节拍\n  var CONFIG_TTL_MS = 30000;          // 配置缓存时长\n\n  var cfg = null;\n  var cfgLoadedAt = 0;\n  var busy = false;\n\n  function loadConfig(force) {\n    var now = Date.now();\n    if (!force && cfg && (now - cfgLoadedAt) < CONFIG_TTL_MS) return Promise.resolve(cfg);\n    return window.electronAPI.pluginInvoke(PLUGIN_ID, \"getConfig\", {})\n      .then(function (r) {\n        if (r && r.success && r.data) { cfg = r.data; cfgLoadedAt = now; }\n        return cfg;\n      })\n      .catch(function () { return cfg; });\n  }\n\n  function unfinishedCount(todos) {\n    var n = 0;\n    for (var i = 0; i < todos.length; i++) {\n      var t = todos[i];\n      if (t && t.status !== \"completed\") n++;\n    }\n    return n;\n  }\n\n  function check() {\n    if (busy) return;\n    var api = window.__lingyaPluginAPI;\n    if (!api) return;\n    busy = true;\n\n    loadConfig(false).then(function (c) {\n      if (!c || !c.enabled) return;\n\n      var st = api.getRuntimeState();\n      var sid = st.sessionId || \"(home)\";\n\n      // 这些情况下催促本身就是错的\n      if (st.stopped) return;\n      if (st.awaitingUserInput) return;          // AI 在等用户回答\n      if (st.awaitingNextInitialChunk) return;   // 初始化分批发送中\n      if (st.taskDeclaredDone) return;           // AI 已声明完成\n\n      var idleMs = Date.now() - (st.lastActivityAt || 0);\n      if (idleMs < c.thresholdSec * 1000) return;\n\n      return api.getTodos().then(function (r) {\n        if (!r) return;\n        if (c.requirePlan) {\n          if (r.archived) return;\n          if (unfinishedCount(r.todos) === 0) return;\n        }\n        // 计数由主进程裁决并持久化：页面刷新不归零。\n        // 主进程侧会自动判断「催促后是否又有新活动」并重置计数。\n        return window.electronAPI.pluginInvoke(PLUGIN_ID, \"bumpNudgeCount\", {\n          sessionId: sid,\n          lastActivityAt: st.lastActivityAt || 0,\n        }).then(function (br) {\n          if (!br || !br.success || !br.data || !br.data.allowed) {\n            if (br && br.data && br.data.reason === \"limit\") {\n              console.log(\"[任务守望者] 会话 \" + sid + \" 已达催促上限 \" + br.data.max + \" 次，跳过\");\n            }\n            return;\n          }\n          console.log(\"[任务守望者] 会话 \" + sid + \" 已停滞 \" + Math.round(idleMs / 1000) +\n            \"s，第 \" + br.data.used + \" 次催促\");\n          return api.sendMessage(c.promptText, \"任务守望者\");\n        });\n      });\n    }).catch(function (e) {\n      console.warn(\"[任务守望者] 检查异常:\", e && e.message);\n    }).then(function () {\n      busy = false;\n    }, function () {\n      busy = false;\n    });\n  }\n\n  setInterval(check, CHECK_INTERVAL_MS);\n  setTimeout(check, 5000);   // 启动后先探一次\n  console.log(\"[任务守望者] 已启动，检查间隔 \" + (CHECK_INTERVAL_MS / 1000) + \"s\");\n})();"

export function apply(ctx) {
  const readCfg = () => Object.assign({}, DEFAULTS, ctx.config || {})

  // preload 脚本从这里拉配置（主进程侧存储，重启保留）
  ctx.registerIpc('getConfig', async () => readCfg())

  ctx.registerIpc('saveConfig', async (patch) => {
    const prev = readCfg()
    const next = Object.assign({}, prev, patch || {})
    next.thresholdSec = Math.max(10, Math.min(3600, Number(next.thresholdSec) || DEFAULTS.thresholdSec))
    next.maxNudge = Math.max(0, Math.min(100, Number(next.maxNudge) || 0))
    next.enabled = next.enabled !== false
    next.requirePlan = next.requirePlan !== false
    next.promptText = String(next.promptText || DEFAULTS.promptText).trim() || DEFAULTS.promptText
    // 计数不属于用户可配置项：强制沿用旧值，避免被表单 patch 覆盖或归一化破坏
    next.nudgeCounts = prev.nudgeCounts && typeof prev.nudgeCounts === 'object' ? prev.nudgeCounts : {}
    ctx.config = next
    return next
  })

  /**
   * 催促计数裁决（持久化）。
   *
   * 入参：{ sessionId, lastActivityAt }
   * 返回：{ allowed: boolean, used?: number, max?: number, reason?: string }
   *
   * 语义：
   *   - 若上次催促之后又有新活动（lastActivityAt > at + 1s）→ 视为 AI 已推进，计数归零
   *   - 达到上限 → allowed=false, reason='limit'
   *   - 否则计数 +1 并落盘 → allowed=true
   *   - 每次调用顺带清理超过 24h 未更新的会话记录
   */
  ctx.registerIpc('bumpNudgeCount', async (args) => {
    const sid = (args && args.sessionId) || '(home)'
    const lastActivityAt = Number((args && args.lastActivityAt) || 0)
    const cfg = readCfg()
    const counts = (cfg.nudgeCounts && typeof cfg.nudgeCounts === 'object')
      ? Object.assign({}, cfg.nudgeCounts) : {}

    // 清理陈旧记录
    const now = Date.now()
    for (const key of Object.keys(counts)) {
      const rec = counts[key]
      if (!rec || typeof rec !== 'object') { delete counts[key]; continue }
      if (now - (Number(rec.at) || 0) > COUNT_TTL_MS) delete counts[key]
    }

    const cur = counts[sid] && typeof counts[sid] === 'object' ? counts[sid] : { count: 0, at: 0 }
    let used = Number(cur.count) || 0
    const at = Number(cur.at) || 0

    // 催促后出现新活动 → AI 已推进，本会话计数归零
    if (at && lastActivityAt > at + 1000) used = 0

    const max = Number(cfg.maxNudge) || 0
    if (max > 0 && used >= max) {
      counts[sid] = { count: used, at }
      ctx.config = Object.assign({}, cfg, { nudgeCounts: counts })
      return { allowed: false, used, max, reason: 'limit' }
    }

    used += 1
    counts[sid] = { count: used, at: now }
    ctx.config = Object.assign({}, cfg, { nudgeCounts: counts })
    return { allowed: true, used, max }
  })

  // 手动清空计数（面板按钮用）
  ctx.registerIpc('resetNudgeCounts', async () => {
    const cfg = readCfg()
    ctx.config = Object.assign({}, cfg, { nudgeCounts: {} })
    return { nudgeCounts: {} }
  })

  ctx.registerPreload(PRELOAD_SCRIPT)

  const SCRIPT = [
    '(function(){',
    '  function load(){',
    '    window.shellAPI.pluginInvoke("task-watcher","getConfig",{}).then(function(r){',
    '      var d=(r&&r.success&&r.data)||{};',
    '      function v(id,val){var e=document.getElementById(id); if(e) e.value=val;}',
    '      function c(id,val){var e=document.getElementById(id); if(e) e.checked=!!val;}',
    '      c("tw-enabled", d.enabled);',
    '      c("tw-require-plan", d.requirePlan);',
    '      v("tw-threshold", d.thresholdSec);',
    '      v("tw-max", d.maxNudge);',
    '      v("tw-text", d.promptText);',
    '      drawCounts(d.nudgeCounts);',
    '    });',
    '  }',
    '  function drawCounts(counts){',
    '    var box=document.getElementById("tw-counts"); if(!box) return;',
    '    var keys=counts?Object.keys(counts):[];',
    '    if(!keys.length){ box.textContent="暂无催促记录"; return; }',
    '    var out=[];',
    '    for(var i=0;i<keys.length;i++){',
    '      var k=keys[i]; var r=counts[k]||{};',
    '      out.push("<div>会话 "+(k.length>10?k.slice(0,8)+"…":k)+"：已催 <b>"+(r.count||0)+"</b> 次</div>");',
    '    }',
    '    box.innerHTML=out.join("");',
    '  }',
    '  load();',
    '  var s=document.getElementById("tw-save");',
    '  if(s) s.addEventListener("click",function(){',
    '    function val(id){var e=document.getElementById(id); return e?e.value:"";}',
    '    function chk(id){var e=document.getElementById(id); return !!(e&&e.checked);}',
    '    var patch={ enabled:chk("tw-enabled"), requirePlan:chk("tw-require-plan"),',
    '      thresholdSec:val("tw-threshold"), maxNudge:val("tw-max"), promptText:val("tw-text") };',
    '    window.shellAPI.pluginInvoke("task-watcher","saveConfig",patch).then(function(r){',
    '      var m=document.getElementById("tw-msg");',
    '      if(m) m.textContent=(r&&r.success)?"已保存":"保存失败";',
    '      setTimeout(function(){ if(m) m.textContent=""; }, 2000);',
    '    });',
    '  });',
    '  var rst=document.getElementById("tw-reset-counts");',
    '  if(rst) rst.addEventListener("click",function(){',
    '    window.shellAPI.pluginInvoke("task-watcher","resetNudgeCounts",{}).then(function(r){',
    '      if(r&&r.success) drawCounts(r.data.nudgeCounts);',
    '      var m=document.getElementById("tw-msg");',
    '      if(m) m.textContent="计数已清空";',
    '      setTimeout(function(){ if(m) m.textContent=""; }, 2000);',
    '    });',
    '  });',
    '})();',
  ].join('\n')

  ctx.registerView({
    id: 'main',
    icon: '👁️',
    label: '守望',
    title: '任务守望者',
    render() {
      const c = readCfg()
      return [
        '<div class="sh-panel-head"><span class="sh-panel-title">任务守望者</span></div>',
        '<div class="sh-panel-body">',
        '  <div class="sh-card" style="margin-bottom:8px;font-size:11.5px;line-height:1.6;color:var(--ck-text-dim);">',
        '    任务中途停止（计划有未完成项 + AI 长时间无输出）时，自动催促 AI 继续推进。',
        '  </div>',
        '  <label class="sh-utodo-chk" style="display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:12px;">',
        '    <input type="checkbox" id="tw-enabled" /> 启用守望',
        '  </label>',
        '  <label class="sh-utodo-chk" style="display:flex;align-items:center;gap:6px;margin-bottom:10px;font-size:12px;">',
        '    <input type="checkbox" id="tw-require-plan" /> 仅在有未完成计划时催促',
        '  </label>',
        '  <div style="font-size:11px;color:var(--ck-text-dim);margin-bottom:2px;">停滞阈值（秒）</div>',
        '  <input id="tw-threshold" type="number" min="10" max="3600" value="' + c.thresholdSec + '"',
        '    style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;margin-bottom:8px;" />',
        '  <div style="font-size:11px;color:var(--ck-text-dim);margin-bottom:2px;">每会话催促上限（0 = 不限）</div>',
        '  <input id="tw-max" type="number" min="0" max="100" value="' + c.maxNudge + '"',
        '    style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;margin-bottom:8px;" />',
        '  <div style="font-size:11px;color:var(--ck-text-dim);margin-bottom:2px;">催促文案</div>',
        '  <textarea id="tw-text" rows="4" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;margin-bottom:8px;resize:vertical;">' + c.promptText + '</textarea>',
        '  <button class="sh-btn primary" id="tw-save" style="width:100%;font-size:12px;">保存</button>',
        '  <div id="tw-msg" style="font-size:11px;color:var(--ck-accent);height:16px;margin-top:4px;"></div>',
        '  <div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--ck-border);font-size:12px;font-weight:600;color:var(--ck-title);">当前计数</div>',
        '  <div id="tw-counts" class="sh-card" style="margin-top:6px;font-size:11.5px;line-height:1.7;color:var(--ck-text-dim);">加载中…</div>',
        '  <button class="sh-btn" id="tw-reset-counts" style="width:100%;font-size:12px;margin-top:6px;">清空计数</button>',
        '  <script>' + SCRIPT + '</' + 'script>',
        '</div>',
      ].join('\n')
    },
  })

  ctx.log('任务守望者已加载')
}
