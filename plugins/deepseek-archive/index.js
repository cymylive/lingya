// DeepSeek 对话归档插件
export const name = 'deepseek-archive'
export const inject = ['tools']

const __scriptPath = require('path').join(__dirname, "archive.js")
let ARCHIVE_SCRIPT
try {
  ARCHIVE_SCRIPT = require('fs').readFileSync(__scriptPath, 'utf8')
} catch (err) {
  throw new Error('缺少脚本文件 ' + __scriptPath + '：' + err.message)
}

export function apply(ctx) {
  ctx.log('DeepSeek 对话归档插件已加载');
  ctx.registerPreload(ARCHIVE_SCRIPT);
  ctx.log('已注册归档注入脚本（' + ARCHIVE_SCRIPT.length + ' 字符）');
}
