(function () {
  if (window.__lingyaTaskWatcherInstalled) return;
  window.__lingyaTaskWatcherInstalled = true;

  var PLUGIN_ID = "task-watcher";
  var CHECK_INTERVAL_MS = 15000;      // 检查节拍
  var CONFIG_TTL_MS = 30000;          // 配置缓存时长

  var cfg = null;
  var cfgLoadedAt = 0;
  var busy = false;

  function loadConfig(force) {
    var now = Date.now();
    if (!force && cfg && (now - cfgLoadedAt) < CONFIG_TTL_MS) return Promise.resolve(cfg);
    return window.electronAPI.pluginInvoke(PLUGIN_ID, "getConfig", {})
      .then(function (r) {
        if (r && r.success && r.data) { cfg = r.data; cfgLoadedAt = now; }
        return cfg;
      })
      .catch(function () { return cfg; });
  }

  function unfinishedCount(todos) {
    var n = 0;
    for (var i = 0; i < todos.length; i++) {
      var t = todos[i];
      if (t && t.status !== "completed") n++;
    }
    return n;
  }

  function check() {
    if (busy) return;
    var api = window.__lingyaPluginAPI;
    if (!api) return;
    busy = true;

    loadConfig(false).then(function (c) {
      if (!c || !c.enabled) return;

      var st = api.getRuntimeState();
      var sid = st.sessionId || "(home)";

      // 这些情况下催促本身就是错的
      if (st.stopped) return;
      if (st.awaitingUserInput) return;          // AI 在等用户回答
      if (st.awaitingNextInitialChunk) return;   // 初始化分批发送中
      if (st.taskDeclaredDone) return;           // AI 已声明完成

      var idleMs = Date.now() - (st.lastActivityAt || 0);
      if (idleMs < c.thresholdSec * 1000) return;

      return api.getTodos().then(function (r) {
        if (!r) return;
        if (c.requirePlan) {
          if (r.archived) return;
          if (unfinishedCount(r.todos) === 0) return;
        }
        // 计数由主进程裁决并持久化：页面刷新不归零。
        // 主进程侧会自动判断「催促后是否又有新活动」并重置计数。
        return window.electronAPI.pluginInvoke(PLUGIN_ID, "bumpNudgeCount", {
          sessionId: sid,
          lastActivityAt: st.lastActivityAt || 0,
        }).then(function (br) {
          if (!br || !br.success || !br.data || !br.data.allowed) {
            if (br && br.data && br.data.reason === "limit") {
              console.log("[任务守望者] 会话 " + sid + " 已达催促上限 " + br.data.max + " 次，跳过");
            }
            return;
          }
          console.log("[任务守望者] 会话 " + sid + " 已停滞 " + Math.round(idleMs / 1000) +
            "s，第 " + br.data.used + " 次催促");
          return api.sendMessage(c.promptText, "任务守望者");
        });
      });
    }).catch(function (e) {
      console.warn("[任务守望者] 检查异常:", e && e.message);
    }).then(function () {
      busy = false;
    }, function () {
      busy = false;
    });
  }

  setInterval(check, CHECK_INTERVAL_MS);
  setTimeout(check, 5000);   // 启动后先探一次
  console.log("[任务守望者] 已启动，检查间隔 " + (CHECK_INTERVAL_MS / 1000) + "s");
})();