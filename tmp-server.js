const http = require('http');
const fs = require('fs');
const os = require('os');

const port = 8899;
const apkPath = 'C:\\Users\\Administrator\\Desktop\\lingya-apk\\app-debug.apk';

const server = http.createServer((req, res) => {
  if (req.url === '/app-debug.apk') {
    if (fs.existsSync(apkPath)) {
      const stat = fs.statSync(apkPath);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Length': stat.size,
        'Content-Disposition': 'attachment; filename="lingya-new.apk"'
      });
      fs.createReadStream(apkPath).pipe(res);
    } else {
      res.writeHead(404); res.end('APK file not found');
    }
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<div style="text-align:center;margin-top:50px;font-family:sans-serif;"><h2>灵鸦最新版下载</h2><a href="/app-debug.apk" style="display:inline-block;padding:15px 30px;background:#2dd4bf;color:#fff;text-decoration:none;border-radius:8px;font-size:20px;font-weight:bold;">点我下载安装包</a></div>');
  }
});

const nets = os.networkInterfaces();
let lanIp = '127.0.0.1';
for (const name of Object.keys(nets)) {
  for (const net of nets[name]) {
    if (net.family === 'IPv4' && !net.internal) lanIp = net.address;
  }
}

server.listen(port, '0.0.0.0', () => {
  console.log('✅ 下载服务器已启动: http://' + lanIp + ':' + port);
});
