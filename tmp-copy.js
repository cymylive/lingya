const fs = require('fs');
const path = require('path');
const src = 'H:\\lingyadata';
const dst = 'H:\\lingyatestdata';
if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
const items = ['Partitions', 'profiles.json', 'lingya-memory.json', 'lingya-security.json', 'lingya-plugins.json'];
items.forEach(f => {
  const s = path.join(src, f);
  const d = path.join(dst, f);
  if (fs.existsSync(s)) {
    fs.cpSync(s, d, { recursive: true, force: true });
    console.log('Copied: ' + f);
  }
});
console.log('数据复制完成');
