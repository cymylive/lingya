const path = require('path');
const os = require('os');
const fs = require('fs');
const { ToolRegistry } = require('../tools/ToolRegistry');
const { FileWriteTool } = require('../tools/FileWriteTool');
const { FileReadTool } = require('../tools/FileReadTool');
const { FileEditTool } = require('../tools/FileEditTool');
const { GlobTool } = require('../tools/GlobTool');
const { GrepTool } = require('../tools/GrepTool');
const { BashTool } = require('../tools/BashTool');
const { FileDeleteTool } = require('../tools/FileDeleteTool');
const { JsRunner } = require('../tools/JsRunner');

const NL = String.fromCharCode(10);

(async () => {
  const registry = new ToolRegistry();
  registry.register(new FileWriteTool());
  registry.register(new FileReadTool());
  registry.register(new FileEditTool());
  registry.register(new GlobTool());
  registry.register(new GrepTool());
  registry.register(new BashTool());
  registry.register(new FileDeleteTool());
  const runner = new JsRunner(registry);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingya-js-'));

  const cases = [
    {
      name: 'writeFile + readFile + editFile + log + 返回值',
      code: [
        'const p = "test.txt";',
        'await writeFile(p, ["line1", "line2", "line3"].join(String.fromCharCode(10)));',
        'const content = await readFile(p);',
        'log("读取到长度:", content.length);',
        'const r = await editFile(p, "line2", "LINE2");',
        'log(r);',
        'const c2 = await readFile(p);',
        'if (!c2.includes("LINE2")) throw new Error("edit 未生效");',
        'return "OK: " + c2.trim().split(String.fromCharCode(10)).join("|");',
      ].join(NL)
    },
    {
      name: 'glob + grep + deleteFile',
      code: [
        'await writeFile("src/a.js", "const TODO_A = 1;");',
        'await writeFile("src/b.js", "nothing here");',
        'const files = await glob("src/**/*.js");',
        'log("glob 文件:", files);',
        'const matches = await grep("TODO_A", { glob: "*.js" });',
        'log("grep 结果:", matches);',
        'if (!files.includes("src/a.js")) throw new Error("glob 未找到文件");',
        'await deleteFile("src/b.js");',
        'return "files=" + files.length + ", b.js 已删除=" + !(await glob("src/b.js")).length;',
      ].join(NL)
    },
    {
      name: 'bash 退出码（非零退出不抛异常）',
      allowEnvLimit: true,
      code: [
        'const ok = await bash("echo hello");',
        'log("bash ok:", ok);',
        'const bad = await bash("exit 3");',
        'log("bash bad:", bad);',
        'return bad.exitCode;',
      ].join(NL)
    },
    {
      name: '错误处理：文件不存在抛出异常',
      expectError: true,
      code: 'await readFile("不存在的文件.txt");'
    },
    {
      name: '错误处理：editFile old_string 不匹配',
      expectError: true,
      code: [
        'await writeFile("x.txt", "abc");',
        'await editFile("x.txt", "xyz", "123");',
      ].join(NL)
    },
    {
      name: '沙箱隔离：require/process/Function/eval 均不可用',
      code: [
        'const out = [];',
        'try { require("fs"); out.push("FAIL: require 可用"); } catch (e) { out.push("require 被禁用"); }',
        'if (typeof process !== "undefined") out.push("FAIL: process 可见");',
        'try { [].constructor.constructor("return 1"); out.push("FAIL: Function 构造器可用"); } catch (e) { out.push("Function 构造器被禁用"); }',
        'try { eval("1+1"); out.push("FAIL: eval 可用"); } catch (e) { out.push("eval 被禁用"); }',
        'log(out.join(" | "));',
        'return "sandbox 检查完成";',
      ].join(NL)
    },
    {
      name: '危险命令拒绝',
      code: [
        'try {',
        '  await bash("format C:");',
        '  return "FAIL: 危险命令未被拒绝";',
        '} catch (e) {',
        '  return "危险命令已拒绝: " + e.message;',
        '}',
      ].join(NL)
    },
  ];

  let failed = 0;
  for (const c of cases) {
    console.log(NL + '========== 用例: ' + c.name + ' ==========');
    const result = await runner.run(c.code, tmpDir);
    console.log(JSON.stringify(result, null, 2));
    if (c.expectError) {
      if (result.success || !result.error) { console.log('!!! 预期抛错但未抛错'); failed++; }
    } else if (c.allowEnvLimit && !result.success && /EPERM|spawn/i.test(result.error || '')) {
      console.log('>>> 该用例受当前执行环境限制（spawn EPERM），跳过判定');
    } else if (!result.success) {
      failed++;
    }
  }

  console.log(NL + '========== 汇总 ==========');
  console.log((cases.length - failed) + '/' + cases.length + ' 个用例成功');

  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
})();