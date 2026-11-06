const https = require('https');
const token = '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';

https.get({
  hostname: 'api.github.com',
  path: '/repos/cymylive/lingya/actions/workflows/android.yml/runs?per_page=1',
  headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'User-Agent': 'lingya-agent' }
}, (res) => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => {
    if (res.statusCode === 200) {
      const runs = JSON.parse(body).workflow_runs;
      if (runs.length > 0) {
        const run = runs[0];
        console.log('最近一次 CI:');
        console.log('Run ID: ' + run.id);
        console.log('Status: ' + run.status);
        console.log('Conclusion: ' + run.conclusion);
        console.log('Created: ' + run.created_at);
      } else {
        console.log('没有 CI 记录');
      }
    } else {
      console.log('查询 CI 失败，状态码: ' + res.statusCode);
    }
  });
});
