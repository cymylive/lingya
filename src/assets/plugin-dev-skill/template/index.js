export function apply(ctx) {
  ctx.log('插件已加载')

  // 示例：注册一个工具
  ctx.tools.register({
    name: 'myDemoTool',
    description: '这是一个示例工具',
    parameters: { text: { type: 'string', description: '输入文本' } },
    execute(args) {
      return '你输入了: ' + (args && args.text || '')
    }
  })
}
