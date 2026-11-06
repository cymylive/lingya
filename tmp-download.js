const https = require('https');
const fs = require('fs');
const { execSync } = require('child_process');

const token = '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';

function getUrl() {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'api.github.com',
      path: '/repos/cymylive/lingya/actions/runs?per_page=1',
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'User-Agent': 'lingya-agent' }
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        const run = JSON.parse(body).workflow_runs[0];
        https.get({
          hostname: 'api.github.com',
          path: '/repos/cymylive/lingya/actions/runs/' + run.id + '/artifacts',
          headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'User-Agent': 'lingya-agent' }
        }, (res2) => {
          let body2 = '';
          res2.on('data', d => body2 += d);
          res2.on('end', () => {
            const artifact = JSON.parse(body2).artifacts.find(a => a.name === 'lingya-android-debug');
            if (artifact) resolve(artifact.archive_download_url);
            else reject('Artifact not found');
          });
        });
      });
    }).on('error', reject);
  });
}

(async () => {
  try {
    const url = await getUrl();
    console.log('Download URL:', url);
    // 使用 PowerShell 下载
    const psCmd = "Invoke-WebRequest -Uri '" + url + "' -Headers @{Authorization='Bearer ' + '" + token + "'; 'Accept'='application/vnd.github+json'} -OutFile 'C:\\Users\\Administrator\\Desktop\\lingya-android.zip'";
    execSync('powershell -NoProfile -Command "' + psCmd + '"', { stdio: 'inherit' });
    console.log('Download completed');
  } catch (e) { console.error(e); }
})();
