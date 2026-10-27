'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const memoryStore = require('../../src/main/memory-store');
const skillStore = require('../../src/main/skill-store');

/**
 * 初始化注入必须覆盖**全部**记忆与技能，而不是只挑最相关的几条。
 *
 * 【为什么】只注入 3 条时，模型看不到其余 453 条的存在，就不会主动
 * memoryList() 检索 —— 它不知道自己不知道什么。全量索引（仅标题/简介）
 * 让"有什么"这件事完全可见，正文仍按需取，体积可控。
 *
 * 这两条测试锁的是 project-context.js 里那两处调用点选用的函数：
 * 一旦有人改回 Minimal 版本，索引条目数会掉，测试立刻红。
 */

function freshMemoryDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'full-inj-mem-'));
  memoryStore.init(dir);
  return dir;
}

function freshSkillDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'full-inj-skill-'));
  skillStore.init(dir);
  return dir;
}

test('记忆注入块必须列出全部条目，不只是最相关的几条', () => {
  freshMemoryDir();
  const TOTAL = 30;
  for (let i = 1; i <= TOTAL; i++) {
    memoryStore.saveMemory({
      type: 'reference',
      name: '条目编号' + i,
      content: '正文内容' + i + ' ' + 'x'.repeat(300),
    });
  }

  const block = memoryStore.buildMemorySection({ prompt: '无关关键词' });

  // 每一条的名字都必须在注入块里出现
  const missing = [];
  for (let i = 1; i <= TOTAL; i++) {
    if (block.indexOf('条目编号' + i) === -1) missing.push(i);
  }
  assert.deepStrictEqual(missing, [], '这些记忆条目没有出现在注入块里: ' + missing.join(','));
});

test('记忆注入块不包含全部正文（体积可控）', () => {
  freshMemoryDir();
  const TOTAL = 30;
  for (let i = 1; i <= TOTAL; i++) {
    memoryStore.saveMemory({
      type: 'reference',
      name: '条目编号' + i,
      content: '正文内容' + i + ' ' + 'x'.repeat(300),
    });
  }

  const block = memoryStore.buildMemorySection({ prompt: '无关关键词' });
  const fullBodyCount = (block.match(/x{300}/g) || []).length;

  assert.ok(
    fullBodyCount < TOTAL,
    '不应把所有正文都塞进注入块（当前 ' + fullBodyCount + '/' + TOTAL + ' 条正文被注入）'
  );
});

test('技能注入块必须列出全部已启用技能', () => {
  freshSkillDir();
  const TOTAL = 20;
  for (let i = 1; i <= TOTAL; i++) {
    skillStore.saveSkill({
      name: '技能编号' + i,
      description: '第' + i + '个技能的说明',
      instructions: '# 技能' + i + '\n执行步骤...',
    });
  }

  const block = skillStore.buildSkillSection({});

  const missing = [];
  for (let i = 1; i <= TOTAL; i++) {
    if (block.indexOf('技能编号' + i) === -1) missing.push(i);
  }
  assert.deepStrictEqual(missing, [], '这些技能没有出现在注入块里: ' + missing.join(','));
});

test('有本地 SKILL.md 的技能只注入索引，不内联正文', () => {
  // 真实数据里 173 个技能全部是 source=local，走的就是这条路径。
  // 无 localPath 的 custom 技能设计上内联全文（AI 无法 read 它），不在此测试范围。
  freshSkillDir();
  for (let i = 1; i <= 10; i++) {
    skillStore.saveSkill({
      name: '本地技能' + i,
      description: '说明' + i,
      instructions: '# 技能' + i + '\nUNIQUE_BODY_MARKER_' + i,
      source: 'local',
      localPath: 'H:\\skills\\skill' + i + '\\SKILL.md',
    });
  }

  const block = skillStore.buildSkillSection({});

  assert.strictEqual(
    block.indexOf('UNIQUE_BODY_MARKER_1'),
    -1,
    '有本地文件的技能不该内联 instructions 正文，只该给索引 + 路径'
  );
  assert.ok(block.indexOf('本地技能1') !== -1, '技能名必须出现在索引里');
  assert.ok(block.indexOf('skill1') !== -1, '路径必须出现在索引里，否则 AI 无法 read');
});
