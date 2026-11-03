const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { zipDir, unzipToDir } = require(path.join(ROOT, 'src', 'main', 'plugin-zip'));

const src = path.join(ROOT, 'plugins', 'core-rules');
const out = path.join(process.env.USERPROFILE, 'Desktop', '核心规则-2.0.0.lingya-plugin.zip');
const buf = zipDir(src, 'core-rules');
fs.writeFileSync(out, buf);
console.log('已生成:', out, '(' + buf.length + ' bytes)');

const tmp = path.join(process.env.TEMP, 'verify-core-rules-' + Date.now());
const written = unzipToDir(fs.readFileSync(out), tmp);
console.log('包内文件:');
written.forEach((f) => console.log('  ' + f));
fs.rmSync(tmp, { recursive: true, force: true });
