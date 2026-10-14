#!/usr/bin/env node
/**
 * 校验 .lingyaCode/notes/ 下的 Agent Note 是否符合规范。
 * 移植自 DeepSeek Harness 的 verify-agent-note-format.ts（简化版）。
 *
 * 用法：node scripts/check-notes.js
 * 退出码：0 = 通过；1 = 有违规
 */
'use strict';

const fs = require('fs');
const path = require('path');

const NOTES_DIR = path.join(__dirname, '..', '.lingyaCode', 'notes');
const LIFECYCLES = ['proposed', 'implemented', 'rejected'];
const CLASSES = ['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing'];
// implemented 笔记中禁止出现的提案阶段用语
const PROPOSAL_HEADINGS = ['## Proposal', '## Plan', '## Migration plan', '## Acceptance criteria'];
const FILENAME_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/;

const errors = [];
const warnings = [];
let checked = 0;

function err(file, msg) { errors.push(file + ': ' + msg); }
function warn(file, msg) { warnings.push(file + ': ' + msg); }

function walkLifecycle(lifecycle) {
  const dir = path.join(NOTES_DIR, lifecycle);
  if (!fs.existsSync(dir)) return;
  for (const cls of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!cls.isDirectory()) continue;
    if (!CLASSES.includes(cls.name)) {
      err(path.join(lifecycle, cls.name), '类别文件夹不在封闭集合内（应为 ' + CLASSES.join('/') + '）');
      continue;
    }
    const classDir = path.join(dir, cls.name);
    for (const f of fs.readdirSync(classDir)) {
      if (!f.endsWith('.md')) continue;
      if (f.startsWith('_')) continue; // 模板文件跳过
      checkNote(path.join(classDir, f), lifecycle, f);
    }
  }
}

function checkNote(absPath, lifecycle, filename) {
  checked++;
  const rel = path.relative(NOTES_DIR, absPath).replace(/\\/g, '/');
  const raw = fs.readFileSync(absPath, 'utf-8');
  const lines = raw.split(/\r?\n/);

  // 1. 文件名格式
  if (!FILENAME_RE.test(filename)) {
    err(rel, '文件名须符合 yyyy-mm-dd-topic-title.md（小写字母/数字/连字符）');
  }

  // 2. 头部块：前两行严格为 '# Agent Note: <title>' 和空行，第三行 'Status: ...'
  if (!/^# Agent Note: .+/.test(lines[0] || '')) {
    err(rel, '首行须为 "# Agent Note: <title>"');
  }
  if ((lines[1] || '').trim() !== '') {
    err(rel, '第 2 行须为空行');
  }
  const statusLine = (lines[2] || '').trim();
  const expected = 'Status: ' + lifecycle;
  if (lifecycle === 'rejected') {
    if (!/^Status: rejected — .+/.test(statusLine)) {
      err(rel, 'rejected 笔记状态行须为 "Status: rejected — <原因>"');
    }
  } else if (statusLine !== expected) {
    err(rel, '状态行须为 "' + expected + '"，实际为 "' + statusLine + '"');
  }

  // 3. 正文以 ## Problem 开头
  const bodyStart = lines.slice(3).join('\n');
  const firstHeading = (bodyStart.match(/^## .+$/m) || [])[0];
  if (firstHeading !== '## Problem') {
    err(rel, '正文首个章节须为 "## Problem"，实际为 "' + (firstHeading || '(无)') + '"');
  }

  // 4. 必需章节
  if (!/^## Alternatives considered$/m.test(bodyStart)) {
    err(rel, '缺少必需章节 "## Alternatives considered"');
  }

  // 5. implemented 笔记禁止提案用语
  if (lifecycle === 'implemented') {
    for (const h of PROPOSAL_HEADINGS) {
      if (new RegExp('^' + h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm').test(bodyStart)) {
        err(rel, 'implemented 笔记不得出现提案阶段用语 "' + h + '"');
      }
    }
  }
}

// 主流程
if (!fs.existsSync(NOTES_DIR)) {
  console.log('[check-notes] 未找到 .lingyaCode/notes/，跳过');
  process.exit(0);
}

for (const lc of LIFECYCLES) walkLifecycle(lc);

// 归档目录只做存在性提示，不校验内容
const archived = path.join(NOTES_DIR, 'archived');
if (fs.existsSync(archived)) {
  warn('archived/', '归档目录存在（归档内容冻结，不参与格式校验）');
}

console.log('[check-notes] 已检查 ' + checked + ' 份笔记');

if (warnings.length > 0) {
  console.log('\n提示：');
  for (const w of warnings) console.log('  - ' + w);
}

if (errors.length > 0) {
  console.error('\n违规：');
  for (const e of errors) console.error('  ✗ ' + e);
  process.exit(1);
}

console.log('✓ 全部通过');
