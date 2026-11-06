const fs = require('fs');
const cssPath = 'src/main/remote/pwa/style.css';
let content = fs.readFileSync(cssPath, 'utf8');

const newCss = `
/* 项目级归档动作按钮 */
.project-actions {
  color: var(--text-dim);
  cursor: pointer;
  padding: 0 8px;
  font-weight: bold;
}
.project-actions:hover { color: var(--text); }

/* 已归档对话折叠 */
.archived-group {
  margin-top: 8px;
  border-top: 1px dashed var(--border);
}
.archived-header {
  padding: 8px 16px;
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
  user-select: none;
}
.archived-header:hover { color: var(--text); }
.archived-sessions {
  display: none;
}
.archived-group.open .archived-sessions {
  display: block;
}
.archived-group.open .archived-header {
  color: var(--accent);
}
`;

// 插入到 .project-group 后面
const idx = content.indexOf('.project-group {');
if (idx !== -1) {
  content = content.slice(0, idx) + newCss + '\n' + content.slice(idx);
  fs.writeFileSync(cssPath, content, 'utf8');
  console.log('✅ CSS 样式已追加');
} else {
  console.log('❌ 找不到插入位置');
}
