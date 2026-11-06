const fs = require('fs');
const path = require('path');

const src = 'H:\\lingyadata';
const dst = 'H:\\lingyatestdata';

// 需要排除的（防止锁冲突或循环拷贝）
const exclude = ['instances', 'lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket'];

if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });

function copyDir(srcDir, dstDir) {
  const items = fs.readdirSync(srcDir);
  for (const item of items) {
    if (exclude.includes(item)) continue;
    const s = path.join(srcDir, item);
    const d = path.join(dstDir, item);
    try {
      const stat = fs.statSync(s);
      if (stat.isDirectory()) {
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
        copyDir(s, d);
      } else {
        fs.copyFileSync(s, d);
      }
    } catch (e) {
      console.log('Copy warning: ' + item + ' - ' + e.message);
    }
  }
}

copyDir(src, dst);
console.log('全量数据同步完成');
