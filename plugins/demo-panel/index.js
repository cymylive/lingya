// 面板演示插件（DSH 风格 + LingYa 扩展）
// 演示：DSH 的 tools.register + LingYa 的 registerView/registerIpc + depends
export const name = 'demo-panel'
export const inject = ['tools']
export const depends = ['hello']

export function apply(ctx) {
  ctx.log('面板演示插件已加载')

  // DSH 风格：注册一个工具
  ctx.tools.register({
    name: 'demoPing',
    description: '面板演示插件提供的测试工具，返回 pong。',
    parameters: {},
    execute() { return 'pong（来自 DSH 风格插件）' },
  })

  // LingYa 扩展：注册 IPC 通道（DSH 没有这个，是 LingYa 独有）
  let clickCount = 0
  ctx.registerIpc('getData', async () => ({
    plugin: ctx.pluginId,
    time: new Date().toLocaleString('zh-CN'),
    clickCount,
  }))
  ctx.registerIpc('bump', async () => { clickCount++; return { clickCount } })

  // LingYa 扩展：注册侧栏面板
  const SCRIPT = [
    '(function(){',
    '  function refresh(){',
    '    window.shellAPI.pluginInvoke("demo-panel","getData",{}).then(function(r){',
    '      var box=document.getElementById("dp-data"); if(!box) return;',
    '      var d=(r&&r.success&&r.data)||{};',
    '      box.innerHTML="插件: <b>"+(d.plugin||"")+"</b><br/>时间: "+(d.time||"")+"<br/>点击次数: <b>"+(d.clickCount||0)+"</b>";',
    '    });',
    '  }',
    '  refresh();',
    '  var b=document.getElementById("dp-bump");',
    '  if(b) b.addEventListener("click",function(){ window.shellAPI.pluginInvoke("demo-panel","bump",{}).then(refresh); });',
    '})();',
  ].join('\n')

  ctx.registerView({
    id: 'main',
    icon: '🎛️',
    label: '演示',
    title: '面板演示插件',
    render() {
      return [
        '<div class="sh-panel-head"><span class="sh-panel-title">面板演示插件</span></div>',
        '<div class="sh-panel-body">',
        '  <div class="sh-card" style="margin-bottom:8px;"><div style="font-size:12px;line-height:1.6;">统一插件标准演示：<b>DSH 的 tools.register</b> + <b>LingYa 的 registerView/registerIpc</b></div></div>',
        '  <div id="dp-data" class="sh-card" style="margin-bottom:8px;font-size:12px;">加载中…</div>',
        '  <button class="sh-btn primary" id="dp-bump" style="font-size:12px;">点我 +1</button>',
        '  <script>' + SCRIPT + '</' + 'script>',
        '</div>',
      ].join('\n')
    },
  })

  ctx.log('已注册工具 demoPing + 视图 + IPC')
}
