/**
 * 测试工具库
 */
const path = require('path');
const fs = require('fs');
const { ToolRegistry, ToolResult } = require('../tools/ToolRegistry');
const { FileWriteTool } = require('../tools/FileWriteTool');

async function test() {
  console.log('=== 测试工具库 ===\n');

  // 创建注册表
  const registry = new ToolRegistry();

  // 注册工具
  registry.register(new FileWriteTool());

  console.log(`\n已注册工具数量: ${registry.size()}`);
  console.log(`工具列表: ${registry.listNames().join(', ')}\n`);

  // 测试获取工具描述（用于发送给 AI）
  console.log('=== 工具描述 (用于 System Prompt) ===');
  console.log(registry.getFormattedToolsForPrompt());

  // 测试执行工具
  console.log('\n=== 测试执行 file_write ===');

  // 写入测试文件
  const testFile = path.join(__dirname, '..', 'test_output.txt');
  const testContent = `这是一个测试文件
创建时间: ${new Date().toISOString()}
工具库测试成功!`;

  const result = await registry.execute('file_write', {
    file_path: testFile,
    content: testContent
  });

  console.log('执行结果:', result.toString());

  // 验证文件是否存在
  const fs = require('fs');
  if (fs.existsSync(testFile)) {
    const readContent = fs.readFileSync(testFile, 'utf-8');
    console.log('\n文件内容验证:');
    console.log(readContent);
    // 清理测试文件
    fs.unlinkSync(testFile);
    console.log('\n测试文件已清理');
  }

  console.log('\n=== 测试完成 ===');
}

test().catch(console.error);
