const https = require('https');
const token = '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';
function check() {
  https.get({
    hostname: 'api.github.com',
    path: '/repos/cymylive/lingya/actions/workflows/android.yml/runs?per_page=1',
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'User-Agent': 'lingya-agent' }
  }, (res) => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => {
      const j = JSON.parse(body);
      if (j.workflow_runs && j.workflow_runs.length > 0) {
        const run = j.workflow_runs[0];
        if (run.status === 'completed') {
          console.log('状态: ' + run.conclusion);
          console.log('链接: https://github.com/cymylive/lingya/actions/runs/' + run.id);
        } else {
          console.log('仍在运行中: ' + run.status);
          setTimeout(check, 15000);
        }
      }
    });
  });
}
check();
