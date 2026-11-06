<path>C:\Users\Administrator\Desktop\lingya-0.6.88-src-20261103_20261103_183031/src/main/remote-ipc.js</path>
<type>file</type>
<content>
1: /**
2:  * 手机远程控制：IPC 注册
3:  * 供桌面设置页调用；服务/隧道/粘合层在此接线。
4:  */
5: const { ipcMain } = require('electron');
6: const os = require('os');
7: const config = require('./remote/config');
8: const server = require('./remote/server');
9: const manager = require('./remote/manager');
10: const tunnel = require('./remote/tunnel');
11: 
12: let registered = false;
13: let currentRemoteConfig = null;
14: let isRestartingTunnel = false;
15: let isRestartingTunnel = false;
16: 
17: function getRemoteConfig() {
18:   if (!currentRemoteConfig) currentRemoteConfig = config.readConfig();
19:   return currentRemoteConfig;
20: }
21: 
22: function saveRemoteConfig(patch) {
23:   config.writeConfig(patch);
24:   currentRemoteConfig = config.readConfig();
25:   return currentRemoteConfig;
26: }
27: 
28: /** 启动服务（不启隧道） */
29: async function startService() {
30:   const cfg = getRemoteConfig();
31:   const r = await server.startServer({
32:     port: cfg.port,
33:     token: cfg.token,
34:     deps: {
35:       onUserMessage: (text) => manager.onUserMessage(text, ''),
36:       onStop: () => manager.onStop(''),
37:       onSelectProfile: (pid, ws) => manager.onSelectProfile(pid, ws),
38:       onNewClient: (ws) => manager.onNewClient(ws),
39:       onRefresh: (ws) => manager.refreshHistory(ws),
40:       onReqSessions: (pid, ws) => {
41:         const ctx = pid ? manager.findContextByProfileId(pid) : manager.getTargetContext();
42:         const sessions = manager.getSessionsForContext(ctx);
43:         if (ws && ws.readyState === 1) {
44:           ws.send(JSON.stringify({ type: 'sessions-data', sessions }));
45:         }
46:       },
47:       onActionNewChat: (pid) => manager.onActionNewChat(pid),
48:       onActionInitProject: (pid, name) => manager.onActionInitProject(pid, name),
49:       onActionRename: (pid, sid, title) => manager.onActionRename(pid, sid, title),
50:       onActionImport: (pid, srcId) => manager.onActionImport(pid, srcId),
51:       onActionSwitchSession: (pid, session) => manager.onActionSwitchSession(pid, session),
52:     },
53:   });
54:   if (!r.ok) return { ok: false, error: r.error };
55:   manager.initRemote({ server });
56:   return { ok: true, port: r.port };
57: }
58: 
59: /** 停止服务与隧道 */
60: async function stopAll() {
61:   try { await tunnel.stopTunnel(); } catch (_) {}
62:   try { await server.stopServer(); } catch (_) {}
63:   try { manager.stopRemote(); } catch (_) {}
64: }
65: 
66: /** 启动隧道 */
67: async function startTunnelNow() {
68:   if (isRestartingTunnel) {
69:     return { ok: false, error: '隧道正在重启中，请稍候…' };
70:   }
71:   isRestartingTunnel = true;
72:   try {
73:     const cfg = getRemoteConfig();
74:   if (!server.isRunning()) {
75:     const s = await startService();
76:     if (!s.ok) return { ok: false, error: s.error };
77:   }
78:   const r = await tunnel.startTunnel({
79:     port: cfg.port,
80:     tunnelToken: cfg.tunnelToken || '',
81:     edgeDns: cfg.edgeDns || '',
82:     onUrlDetected: (url) => { saveRemoteConfig({ publicUrl: url }); },
83:   });
84:   if (r.ok && r.url) {
85:     saveRemoteConfig({ publicUrl: r.url });
86:   } else {
87:     saveRemoteConfig({ publicUrl: '' });
88:   }
89:   return r;
90: }
91: 
92: /** 枚举本机局域网 IPv4（非回环、非内网链接本地） */
93: function listLanUrls(port) {
94:   const out = [];
95:   try {
96:     const ifaces = os.networkInterfaces();
97:     for (const name of Object.keys(ifaces)) {
98:       for (const info of ifaces[name] || []) {
99:         if (!info || info.family !== 'IPv4' || info.internal) continue;
100:         out.push('http://' + info.address + ':' + port);
101:       }
102:     }
103:   } catch (_) {}
104:   return out;
105: }
106: 
107: /** 聚合状态（设置页轮询） */
108: function getStatus() {
109:   const cfg = getRemoteConfig();
110:   const ts = tunnel.getTunnelStatus();
111:   return {
112:     enabled: cfg.enabled === true,
113:     port: cfg.port,
114:     token: cfg.token,
115:     publicUrl: cfg.publicUrl || ts.url || '',
116:     lanUrls: listLanUrls(cfg.port),
117:     serverRunning: server.isRunning(),
118:     tunnel: ts,
119:     clients: server.listClients(),
120:     platform: process.platform,
121:     profiles: manager.listProfilesForRemote(),
122:   };
123: }
124: 
125: function registerRemoteIpc() {
126:   if (registered) return;
127:   registered = true;
128: 
129:   ipcMain.handle('remote-status', async () => ({ success: true, ...getStatus() }));
130: 
131:   ipcMain.handle('remote-set-enabled', async (event, enabled) => {
132:     const cfg = saveRemoteConfig({ enabled: !!enabled });
133:     if (cfg.enabled) {
134:       const s = await startService();
135:       if (!s.ok) return { success: false, error: s.error, ...getStatus() };
136:     } else {
137:       await stopAll();
138:     }
139:     return { success: true, ...getStatus() };
140:   });
141: 
142:   ipcMain.handle('remote-set-config', async (event, patch) => {
143:     const p = patch || {};
144:     const next = {};
145:     if (typeof p.port === 'number') next.port = p.port;
146:     if (typeof p.tunnelToken === 'string') next.tunnelToken = p.tunnelToken;
147:     if (typeof p.publicUrl === 'string') next.publicUrl = p.publicUrl;
148:     if (typeof p.tunnelEnabled === 'boolean') next.tunnelEnabled = p.tunnelEnabled;
149:     saveRemoteConfig(next);
150:     return { success: true, ...getStatus() };
151:   });
152: 
153:   ipcMain.handle('remote-reset-token', async () => {
154:     const token = config.genToken();
155:     saveRemoteConfig({ token });
156:     try { server.kickAll(); } catch (_) {}
157:     return { success: true, ...getStatus() };
158:   });
159: 
160:   ipcMain.handle('remote-start-tunnel', async () => {
161:     const r = await startTunnelNow();
162:     return { success: !!r.ok, error: r.error || '', ...getStatus() };
163:   });
164: 
165:   ipcMain.handle('remote-stop-tunnel', async () => {
166:     try { await tunnel.stopTunnel(); } catch (_) {}
167:     saveRemoteConfig({ publicUrl: '' });
168:     return { success: true, ...getStatus() };
169:   });
170: 
171:   ipcMain.handle('remote-list-clients', async () => ({ success: true, clients: server.listClients() }));
172: 
173:   // 生成包含连接信息的二维码 (Base64)
174:   ipcMain.handle('remote-get-qrcode', async () => {
175:     const cfg = getRemoteConfig();
176:     const ts = tunnel.getTunnelStatus();
177:     const lanUrls = listLanUrls(cfg.port);
178:     
179:     // 优先用公网地址，没有的话用局域网地址
180:     const addr = cfg.publicUrl || ts.url || (lanUrls.length > 0 ? lanUrls[0] : 'http://127.0.0.1:' + cfg.port);
181:     
182:     // 构造专用扫码协议：lingya://connect?addr=xxx&token=xxx
183:     const qrContent = 'lingya://connect?addr=' + encodeURIComponent(addr) + '&token=' + encodeURIComponent(cfg.token);
184:     
185:     try {
186:       const QRCode = require('qrcode');
187:       const dataUrl = await QRCode.toDataURL(qrContent, { margin: 1, width: 300 });
188:       return { success: true, dataUrl, addr, token: cfg.token };
189:     } catch (err) {
190:       return { success: false, error: err.message };
191:     }
192:   });
193: 
194:   ipcMain.handle('remote-kick-all', async () => {
195:     try { server.kickAll(); } catch (_) {}
196:     return { success: true, ...getStatus() };
197:   });
198: 
199:   // AI 视图上报的事件 -> 手机（fire-and-forget，用 on 而非 handle）
200:   ipcMain.on('remote-ai-event', (event, payload) => {
201:     const p = payload || {};
202:     try { manager.broadcastAiEvent(p.webContentsId, p.kind || '', p.data || {}); } catch (_) {}
203:   });
204: }
205: 
206: /** 应用启动时若已启用则自动拉起服务 */
207: async function initRemoteOnBoot() {
208:   const cfg = getRemoteConfig();
209:   if (!cfg.enabled) return { ok: true, skipped: true };
210:   const s = await startService();
211:   if (!s.ok) return s;
212:   if (cfg.tunnelEnabled || cfg.tunnelToken) {
213:     try {
214:       console.log('[Remote] 检测到已启用隧道配置，正在自动拉起隧道...');
215:       await startTunnelNow();
216:     } catch (_) {}
217:   }
218:   return { ok: true };
219: }
220: 
221: module.exports = {
222:   registerRemoteIpc,
223:   initRemoteOnBoot,
224:   stopAll,
225:   getStatus,
226:   startService,
227:   startTunnelNow,
228: };
229: 

(End of file - total 229 lines)
</content>