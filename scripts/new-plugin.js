#!/usr/bin/env node
/**
 * 插件脚手架：一键生成标准插件目录。
 * 用法：node scripts/new-plugin.js <id> [显示名称]
 */
const fs = require('fs');
const path = require('path');

const id = process.argv[2];
const name = process.argv[3] || id;

if (!id || !/^[a-z0-9][a-z0-9-_.]*$/.test(id)) {
  console.error('用法: npm run new:plugin <id> [名称]');
  console.error('id 规则：只能包含小写字母、数字、- _ .，且以字母或数字开头');
  process.exit(1);
}

const dir = path.join(__dirname, '..', 'plugins', id);
if (fs.existsSync(dir)) {
  console.error('目录已存在：' + dir);
  process.exit(1);
}

fs.mkdirSync(dir, { recursive: true });

const manifest = {
  id,
  name,
  version: '1.0.0',
  description: '插件用途说明（一句话）',
  icon: '🔌',
  entry: 'index.js',
  apiVersion: 1,
};
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const indexJs = `// 插件 ${name}
export const name = '${id}'

const DEFAULTS = {
  enabled: true,
}

export function apply(ctx) {
  ctx.log('插件已加载，目录:', ctx.pluginDir)

  const readCfg = () => Object.assign({}, DEFAULTS, ctx.config || {})

  ctx.registerIpc('getConfig', async () => readCfg())

  ctx.registerIpc('saveConfig', async (patch) => {
    const prev = readCfg()
    const next = Object.assign({}, prev, patch || {})
    next.enabled = next.enabled !== false
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

  // 示例：注册一个工具
  // ctx.tools.register({
  //   name: '${id.replace(/-/g, '_')}_demo',
  //   description: '示例工具',
  //   parameters: { text: { type: 'string', description: '输入文本' } },
  //   execute(args) { return String((args && args.text) || '') },
  // })

  // 示例：注册侧栏视图
  ctx.registerView({
    id: 'main',
    icon: '🔌',
    label: '${name.slice(0, 2)}',
    title: '${name}',
    render() {
      return [
        '<div class="sh-panel-head"><span class="sh-panel-title">${name}</span></div>',
        '<div class="sh-panel-body">',
        '  <p style="font-size:12px;color:var(--ck-text-dim);">插件配置面板（由脚手架生成）</p>',
        '</div>',
      ].join('\\n')
    },
  })
}
`;
fs.writeFileSync(path.join(dir, 'index.js'), indexJs);

const readme = `# ${name}

## 用途

（填写插件做什么）

## 配置

（填写配置项说明）

## 开发

1. 编辑 \`index.js\`，在 \`apply(ctx)\` 中注册能力
2. 重启 LingYa，侧栏「插件」面板启用
3. 修改后用「重载」按钮或重启生效

详见项目根 \`docs/PLUGIN-DEV.md\`。
`;
fs.writeFileSync(path.join(dir, 'README.md'), readme);

console.log('✅ 插件已创建：' + dir);
console.log('下一步：编辑 index.js 实现功能，然后重启 LingYa 启用插件。');
