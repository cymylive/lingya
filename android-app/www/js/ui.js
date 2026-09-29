/** 手机端 UI 交互（骨架版） */
(function () {
  'use strict';
  var statusEl = document.getElementById('status');
  var logPanel = document.getElementById('log-panel');

  function setStatus(text) { if (statusEl) statusEl.textContent = text; }

  if (window.LingyaBridge && window.LingyaBridge.isAndroid) {
    setStatus('已连接原生插件');
  } else {
    setStatus('插件未就绪（需 cap sync）');
  }

  document.getElementById('btn-pick').addEventListener('click', async function () {
    if (!window.LingyaBridge) return;
    var r = await window.LingyaBridge.pickDirectory();
    console.log('pickDirectory', r);
    if (r.success) setStatus('已授权：' + (r.data && r.data.name));
    else alert('授权失败: ' + r.error);
  });

  document.getElementById('btn-roots').addEventListener('click', async function () {
    if (!window.LingyaBridge) return;
    var r = await window.LingyaBridge.listRoots();
    alert(JSON.stringify(r, null, 2));
  });

  document.getElementById('btn-log').addEventListener('click', function () {
    logPanel.hidden = !logPanel.hidden;
  });
})();
