const https = require('https');
const fs = require('fs');
const { execSync } = require('child_process');
const token = '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';
const runId = '42246697894';

function getArtifact() {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'api.github.com',
      path: '/repos/cymylive/lingya/actions/runs/' + runId + '/artifacts',
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'User-Agent': 'lingya-agent' }
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        const j = JSON.parse(body);
        const art = j.artifacts.find(a => a.name === 'lingya-android-debug');
        if (art) resolve(art.archive_download_url);
        else reject('artifact not found');
      });
    }).on('error', reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = (u, withAuth) => {
      const headers = { 'User-Agent': 'lingya-agent' };
      if (withAuth) {
        headers['Authorization'] = 'Bearer ' + token;
        headers['Accept'] = 'application/vnd.github+json';
      }
      https.get(u, { headers }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          // 关键：一旦发生重定向，立刻把 withAuth 设为 false，甩掉 Token
          request(res.headers.location, false);
        } else if (res.statusCode === 200) {
          res.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
        } else {
          reject(new Error('HTTP ' + res.statusCode));
        }
      }).on('error', reject);
    };
    request(url, true); // 第一次请求带 Token
  });
}

(async () => {
  try {
    console.log('1. 获取链接...');
    const url = await getArtifact();
    const zipPath = process.cwd() + '\\tmp-dl.zip';
    const extractDir = process.cwd() + '\\tmp-apk-v4';
    
    console.log('2. 下载...');
    await downloadFile(url, zipPath);
    
    console.log('3. 解压...');
    execSync('powershell -NoProfile -Command "Expand-Archive -Path tmp-dl.zip -DestinationPath tmp-apk-v4 -Force"');
    
    console.log('4. 覆盖文件...');
    fs.copyFileSync(extractDir + '\\app-debug.apk', process.cwd() + '\\lingya-download.apk');
    
    fs.unlinkSync(zipPath);
    fs.rmSync(extractDir, { recursive: true, force: true });
    console.log('✅ SUCCESS');
  } catch (e) {
    console.log('❌ FAIL: ' + e.message);
  }
})();
