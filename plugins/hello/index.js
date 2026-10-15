// hello 示例插件（DSH 风格 + LingYa 扩展）
// 统一插件标准：既能用 DSH 的 ctx.tools.register，也能用 LingYa 的 ctx.registerView 等。
export const name = 'hello'
export const inject = ['tools']

export function apply(ctx) {
  ctx.log('Hello 插件已加载，目录:', ctx.pluginDir || '(本地)')

  // DSH 标准写法
  ctx.tools.register({
    name: 'helloWorld',
    description: '一个示例工具，返回问候语。用于验证插件系统是否工作。',
    parameters: {
      name: { type: 'string', description: '要问候的名字，默认 World' },
    },
    execute(args) {
      const who = (args && args.name) || 'World'
      const greeting = (ctx.settings && ctx.settings.get('greeting')) || 'Hello'
      return greeting + ', ' + who + '! 来自 LingYa 插件系统 👋'
    },
  })

  ctx.tools.register({
    name: 'pluginInfo',
    description: '返回当前插件的元信息（id/名称/目录）。',
    parameters: {},
    execute() {
      return JSON.stringify({ id: ctx.pluginId, dir: ctx.pluginDir, config: ctx.config })
    },
  })
}
