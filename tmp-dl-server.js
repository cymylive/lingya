const http = require('http');
const fs = require('fs');
const path = require('path');
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
      res.writeHead(404); res.end('Not found');
    }
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>灵鸦最新版 APK 下载</h2><p><a href="/app-debug.apk" style="font-size:20px; padding:10px; background:#2dd4bf; color:#fff; text-decoration:none; border-radius:5px;">点我下载 APK</a></p>');
  }
});

// 获取局域网 IP
const nets = os.networkInterfaces();
let lanIp = '127.0.0.1';
for (const name of Object.keys(nets)) {
  for (const net of nets[name]) {
    if (net.family === 'IPv4' && !net.internal) {
      lanIp = net.address;
    }
  }
}

server.listen(port, '0.0.0.0', () => {
  console.log('✅ 下载服务器已启动！');
  console.log('请在手机浏览器打开: http://' + lanIp + ':' + port);
});
