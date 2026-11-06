const { execSync } = require('child_process');
console.log('正在清理残留进程...');
try {
  execSync('wmic process where "name=\'electron.exe\'" call terminate', { stdio: 'ignore' });
  execSync('wmic process where "name=\'lingya.exe\'" call terminate', { stdio: 'ignore' });
  console.log('清理完成');
} catch (e) {
  console.log('清理过程中可能有部分进程已退出');
}
