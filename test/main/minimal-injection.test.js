'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const memoryStore = require('../../src/main/memory-store');
const skillStore = require('../../src/main/skill-store');
const { SkillListTool } = require('../../tools/SkillTool');

function freshDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('minimal 记忆注入：不附全部索引，且体积受控', () => {
  memoryStore.init(freshDir('mem-min-'));
  for (let i = 1; i <= 100; i++) {
    memoryStore.saveMemory({
      type: 'reference',
      name: '记忆' + i,
      content: 'x'.repeat(200) + ' ' + i,
      tags: ['t' + i]
    });
  }

  const block = memoryStore.buildMemorySectionMinimal({});
  assert.ok(block.length < 2000, 'minimal 记忆块应小于 2000 字符，实际=' + block.length);
  assert.ok(!block.includes('全部记忆索引'), 'minimal 不应附全部记忆索引');
  assert.match(block, /memoryList/);
  assert.match(block, /共 100 条/);
});

test('minimal 技能注入：不附全部索引，且体积受控', () => {
  skillStore.init(freshDir('skill-min-'));
  for (let i = 1; i <= 100; i++) {
    skillStore.saveSkill({
      name: 'skill-' + i,
      description: 'desc ' + i,
      instructions: 'do things ' + i,
      source: 'local',
      localPath: 'H:/skills/skill-' + i + '/SKILL.md'
    });
  }

  const block = skillStore.buildSkillSectionMinimal({});
  assert.ok(block.length < 2000, 'minimal 技能块应小于 2000 字符，实际=' + block.length);
  assert.ok(!block.includes('### 技能索引'), 'minimal 不应附完整技能索引标题');
  assert.match(block, /skillList/);
  assert.match(block, /共 100 个/);
});

test('SkillListTool：可按名称取内联全文', async () => {
  skillStore.init(freshDir('skill-tool-'));
  skillStore.saveSkill({
    name: 'alpha',
    description: 'alpha desc',
    instructions: 'ALPHA_INSTRUCTIONS',
    source: 'custom'
  });

  const tool = new SkillListTool();
  const res = await tool.execute({ name: 'alpha', includeInstructions: true });
  const txt = JSON.stringify(res);
  assert.ok(txt.includes('ALPHA_INSTRUCTIONS'), '应返回技能全文：' + txt);
});

test('SkillListTool：可按 query 检索技能', async () => {
  skillStore.init(freshDir('skill-query-'));
  skillStore.saveSkill({
    name: 'beta',
    description: 'beta desc',
    instructions: 'BETA_INSTRUCTIONS',
    source: 'local',
    localPath: 'H:/skills/beta/SKILL.md'
  });

  const tool = new SkillListTool();
  const res = await tool.execute({ query: 'beta', limit: 10 });
  const txt = JSON.stringify(res);
  assert.ok(txt.includes('beta'), '应按 query 命中技能：' + txt);
  assert.ok(txt.includes('SKILL.md'), '应返回本地技能路径：' + txt);
});
