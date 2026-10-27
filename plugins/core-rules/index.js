// 核心规则插件
// 为 LingYa 注入三段核心行为约束。可在面板中关闭或微调文案。

export const name = 'core-rules'
export const inject = []

const DEFAULT_RULES = {
  "REPORT": "## 铁律：需求先汇报，等确认再动手\n\n本会话初始化完成后，用户提出任何需求时，你**必须先汇报理解并停下来等确认**，不得直接建计划或写代码。初始化阶段（接收系统配置）不适用此规则。\n\n汇报四项：\n\n【理解】我理解你要做的是……\n【思路】打算这样做（不展开细节）\n【风险】容易出错或需要特别注意的地方\n【待确认】我不确定、需要你拍板的地方\n\n用户明确说「对」「可以」「开始」之后，才进入计划与执行。\n\n无例外：即使是「把第 20 行的 X 改成 Y」这种明确指令，也要用一句话复述后等确认。\n无例外：即使是「接着做」「继续」这类延续指令，也要先说明承接的是哪件事，再等确认。\n\n禁止的自我欺骗：「需求很清楚不用确认」「我先做着看看」「边做边对齐」——全部不允许。\n\n违反示例：用户说「请修复」→ 直接建 todo、改代码。这是错的。\n正确示例：用户说「请修复」→ 复述要修什么、怎么修、风险在哪 → 等「开始」。",
  "IRREVERSIBLE": "## 必须二次确认的操作（「别停」「继续」不构成授权）\n\n以下操作**即使**用户此前说过「别停」「继续」「不用问我」，也必须在执行前明确确认一次：\n\n- **向外部平台发布 / 上传 / 推送内容**：发歌、发帖、发文章、发邮件、`git push`、提 PR、调发布接口\n- **批量删除或覆盖已有文件**：`rm`、`del`、覆盖写入、清空队列/进度文件\n- **调用会产生真实费用或消耗额度的接口**\n- **对生产环境 / 线上账号执行写操作**\n\n确认话术要求：**说明你要做什么、影响范围多大、能否撤销**，然后等用户明确回复。\n不要用「我准备开始执行了」这种通知式表达代替确认。\n\n> 判据：**如果这个操作做完之后无法用一条命令回滚，就必须先确认。**",
  "AMBIGUOUS": "### 5. 模糊指令先确认（硬规则）\n\n当用户指令**同时**满足以下条件时，**必须先问一句再动手**，不得自行补全任务：\n\n- 指令本身不含具体对象或动作（例如「接着做」「继续」「别停」「往下走」「你看着办」）\n- 当前对话前文里**没有**对应的未完成任务\n- 需要从「当前目录里有什么」或「历史日志里做到哪了」反推任务是什么\n\n确认只需一句话，例如：\n\n> 「你说的往下做，是指继续 XX 项目，还是别的？」\n\n**以下想法全部禁止**：\n\n| 想法 | 事实 |\n|---|---|\n| 「用户说别停，那我就找个最合理的事做」 | 「别停」不等于「授权你自行决定做什么」 |\n| 「当前目录里有个项目，那一定就是要做的项目」 | 发现一个项目 ≠ 用户要你做这个项目 |\n| 「先做着，做错了用户会喊停」 | 不可逆操作做错了，用户喊停也来不及 |\n| 「问一句显得我不够主动」 | 问一句的成本远低于做错一整套 |\n\n同理，「继续」只能解释为**继续前文已经明确过的任务**。前文没有明确任务时，必须先问。"
}

export function apply(ctx) {
  const readCfg = () => {
    const c = Object.assign({ enabled: true }, ctx.config || {})
    // 如果存了自定义文本，就用自定义的，否则用默认
    c.reportText = String(c.reportText || DEFAULT_RULES.REPORT)
    c.irreversibleText = String(c.irreversibleText || DEFAULT_RULES.IRREVERSIBLE)
    c.ambiguousText = String(c.ambiguousText || DEFAULT_RULES.AMBIGUOUS)
    return c
  }

  ctx.registerIpc('getConfig', async () => {
    const c = readCfg()
    return {
      enabled: c.enabled,
      reportText: c.reportText,
      irreversibleText: c.irreversibleText,
      ambiguousText: c.ambiguousText,
      defaults: DEFAULT_RULES
    }
  })

  ctx.registerIpc('saveConfig', async (patch) => {
    const prev = readCfg()
    const next = Object.assign({}, prev, patch || {})
    next.enabled = next.enabled !== false
    next.reportText = String(next.reportText || DEFAULT_RULES.REPORT).trim()
    next.irreversibleText = String(next.irreversibleText || DEFAULT_RULES.IRREVERSIBLE).trim()
    next.ambiguousText = String(next.ambiguousText || DEFAULT_RULES.AMBIGUOUS).trim()
    ctx.config = next
    if (ctx.settings) {
      if (typeof ctx.settings.save === 'function') {
        ctx.settings.save()
      } else if (typeof ctx.settings.set === 'function') {
        for (const k of Object.keys(next)) ctx.settings.set(k, next[k])
      }
    }
    return { success: true }
  })

  // 注入到系统提示词组装流程
  ctx.registerPromptSection('CORE_RULE_REPORT', () => {
    const c = readCfg()
    return c.enabled ? c.reportText : ''
  })
  ctx.registerPromptSection('CORE_RULE_IRREVERSIBLE', () => {
    const c = readCfg()
    return c.enabled ? c.irreversibleText : ''
  })
  ctx.registerPromptSection('CORE_RULE_AMBIGUOUS', () => {
    const c = readCfg()
    return c.enabled ? c.ambiguousText : ''
  })

  // 侧栏视图
  const SCRIPT = [
    '(function(){',
    '  function load(){',
    '    window.shellAPI.pluginInvoke("core-rules","getConfig",{}).then(function(r){',
    '      var d=(r&&r.success&&r.data)||{};',
    '      document.getElementById("cr-enabled").checked = d.enabled !== false;',
    '      document.getElementById("cr-report").value = d.reportText || "";',
    '      document.getElementById("cr-irreversible").value = d.irreversibleText || "";',
    '      document.getElementById("cr-ambiguous").value = d.ambiguousText || "";',
    '    });',
    '  }',
    '  load();',
    '  var s=document.getElementById("cr-save");',
    '  if(s) s.addEventListener("click",function(){',
    '    var patch = {',
    '      enabled: document.getElementById("cr-enabled").checked,',
    '      reportText: document.getElementById("cr-report").value,',
    '      irreversibleText: document.getElementById("cr-irreversible").value,',
    '      ambiguousText: document.getElementById("cr-ambiguous").value',
    '    };',
    '    window.shellAPI.pluginInvoke("core-rules","saveConfig",patch).then(function(r){',
    '      var m=document.getElementById("cr-msg");',
    '      if(m) { m.textContent = "已保存"; setTimeout(function(){ m.textContent=""; }, 2000); }',
    '    });',
    '  });',
    '  var rst=document.getElementById("cr-reset");',
    '  if(rst) rst.addEventListener("click",function(){',
    '    if(!confirm("确定恢复默认文案吗？")) return;',
    '    window.shellAPI.pluginInvoke("core-rules","getConfig",{}).then(function(r){',
    '      var def=(r&&r.success&&r.data&&r.data.defaults)||{};',
    '      document.getElementById("cr-report").value = def.REPORT || "";',
    '      document.getElementById("cr-irreversible").value = def.IRREVERSIBLE || "";',
    '      document.getElementById("cr-ambiguous").value = def.AMBIGUOUS || "";',
    '      document.getElementById("cr-save").click();',
    '    });',
    '  });',
    '})();',
  ].join('\n')

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
        '    修改后需重新初始化项目才会生效（系统提示词在初始化时组装）。',
        '  </div>',
        '  <label class="sh-utodo-chk" style="display:flex;align-items:center;gap:6px;margin-bottom:10px;font-size:12px;">',
        '    <input type="checkbox" id="cr-enabled" /> 启用核心规则',
        '  </label>',
        '  <div style="font-size:11px;color:var(--ck-text-dim);margin-bottom:2px;">铁律：需求先汇报（放在最前）</div>',
        '  <textarea id="cr-report" rows="6" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;margin-bottom:8px;resize:vertical;"></textarea>',
        '  <div style="font-size:11px;color:var(--ck-text-dim);margin-bottom:2px;">不可逆操作二次确认</div>',
        '  <textarea id="cr-irreversible" rows="6" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;margin-bottom:8px;resize:vertical;"></textarea>',
        '  <div style="font-size:11px;color:var(--ck-text-dim);margin-bottom:2px;">模糊指令先追问</div>',
        '  <textarea id="cr-ambiguous" rows="6" style="width:100%;box-sizing:border-box;background:var(--ck-surface);border:1px solid var(--ck-border);border-radius:6px;padding:5px;color:var(--ck-text);font-size:12px;margin-bottom:12px;resize:vertical;"></textarea>',
        '  <button class="sh-btn primary" id="cr-save" style="width:100%;font-size:12px;">保存配置</button>',
        '  <button class="sh-btn" id="cr-reset" style="width:100%;font-size:12px;margin-top:6px;">恢复默认文案</button>',
        '  <div id="cr-msg" style="font-size:11px;color:var(--ck-accent);height:16px;margin-top:4px;text-align:center;"></div>',
        '  <script>' + SCRIPT + '</' + 'script>',
        '</div>',
      ].join('\n')
    },
  })

  ctx.log('核心规则插件已加载')
}
