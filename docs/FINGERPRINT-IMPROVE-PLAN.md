# 灵鸦浏览器指纹改造计划

> 制定时间：2026-11-05
> 前置：上一轮 docs/PROJECT-ANALYSIS-2026-11-05.md 的 P0-2 占位符 bug 与指纹层分析
> 目标：修补现有 JS 层指纹伪装的破绽，提升对 CreepJS / FingerprintJS 的抗性

---

## 一、背景

灵鸦（LINGYA）在 `src/main/user-agent.js` 集中做 JS 层浏览器指纹伪装，通过 6 个 `buildXxxFix()` 函数注入主世界。实测发现以下破绽：

- `navigator.webdriver.toString()` 返回 `function(){return false;}`，暴露 patch 痕迹
- UA / userAgentData / Client Hints 的 OS 段**硬编码 Windows**，macOS 上跑会自相矛盾
- 可信点击在同一点做 move/down/up，鼠标瞬移，行为特征明显

**不涉及的维度**：TLS、Canvas、WebGL、Audio、字体枚举——这些需换 Chromium 内核（C++ 层），JS 层无解。

---

## 二、前置核验结果（2026-11-05 实测）

| 项 | 核验方式 | 结果 | 结论 |
|---|---|---|---|
| 真 Chrome 是否仍有 `chrome.loadTimes` | Chrome headless 探测 `Object.keys(window.chrome)` | 返回 `["loadTimes","csi","app"]`，loadTimes 是 function | **保留**，原「删除 loadTimes」建议作废 |
| 可信点击坐标接口 | 读 `src/main/ipc.js:1368-1394` | 接收 `{x, y}` 视口 CSS 像素，内部 clamp 后同点 move/down/up | 可从现有接口补贝塞尔，无需改 IPC 协议 |

---

## 三、改造项

### P1-b getter toString 修复

**问题**：当前 `navigator.webdriver.toString()` 返回 `function(){return false;}`，真实 Chrome 是 `function get webdriver() { [native code] }`。CreepJS / FingerprintJS Pro 直接查这个。

**方案**：

1. 新增 `buildNativeMask()`，注入主世界（在 FIXES 数组中**最先执行**）
   - 保存原始 `Function.prototype.toString` 到闭包
   - 用 `WeakMap<fn, label>` 记录被 patch 的函数
   - 改写 `Function.prototype.toString`：优先查 WeakMap 返回伪造串，否则回落原始
   - 把改写后的 toString 本身也标记为 native（防 `toString.toString()` 暴露）
   - 用 `Symbol.for('lyNativeMask')` 暴露内部 `mark` 函数（Symbol 不进入 `Object.keys`，不可枚举）

2. 修改 `buildUserAgentDataFix()`：定义 `webdriver` 和 `userAgentData` 的 getter 后，调用 `mask.mark(getterFn, 'function get webdriver() { [native code] }')`

**代码量**：新增约 30 行（buildNativeMask）+ 修改 10 行（buildUserAgentDataFix）+ preload/index.js 加 1 行（注册到 FIXES）

### P2-a chrome.loadTimes 保留

**核验结论**：真 Chrome 仍有 `chrome.loadTimes`，保持不变，**不做任何改动**。

### P2-b OS 段动态生成

**问题**：`buildChromeUserAgent()` / `buildUserAgentDataFix()` / `buildClientHintsHeaders()` 三处硬编码 Windows，macOS 跑时出现「Chrome 130 + Windows UA + macOS platform」自相矛盾。

**方案**：

1. 新增 `detectOS()`：按 `process.platform` + `process.arch` 返回 `{uaSegment, platform, arch, bitness, mobile}`

| platform | uaSegment | platform 字段 | arch | bitness |
|---|---|---|---|---|
| win32 / x64 | `(Windows NT 10.0; Win64; x64)` | `Windows` | `x86` | `64` |
| win32 / ia32 | `(Windows NT 10.0; WOW64)` | `Windows` | `x86` | `32` |
| win32 / arm64 | `(Windows NT 10.0; ARM64)` | `Windows` | `arm` | `64` |
| darwin / arm64 | `(Macintosh; Intel Mac OS X 10_15_7)` | `macOS` | `arm` | `64` |
| darwin / x64 | 同上 | `macOS` | `x86` | `64` |
| linux / x64 | `(X11; Linux x86_64)` | `Linux` | `x86` | `64` |
| linux / arm64 | `(X11; Linux aarch64)` | `Linux` | `arm` | `64` |
| 其他 | 回退 Windows x64 | `Windows` | `x86` | `64` |

2. 三个 build 函数统一调用 `detectOS()`，替换硬编码

**代码量**：新增约 40 行（detectOS）+ 修改 3 处各 3-5 行

### P3 贝塞尔点击

**问题**：`ipc.js:1387-1389` 的 `trusted-click` 在同一点做 move/down/up，鼠标瞬移。

**方案**：

1. 模块级新增 `_lastMousePos = new Map()`，按 `wc.id` 记录上次点击位置
2. 首次点击从窗口中心（`w/2, h/2`）起，之后用上次位置
3. `_bezierPath(from, to, steps)`：
   - 计算 dx/dy/距离
   - 距离 < 5px 时直接返回终点（避免无意义绕圈）
   - 沿垂直方向随机偏移 10-40% 距离作为控制点
   - 二次贝塞尔插值 steps 个点
   - 每点加 ±1px 抖动（模拟手抖）
4. 循环 `sendInputEvent({type:'mouseMove'})`，每点间隔 **8-28ms 随机**
5. 终点精确 move → down → up（保持现有按钮事件语义）

**代码量**：新增约 55 行（辅助函数 + 循环逻辑），修改 handler 内 3 行

---

## 四、测试计划

新增 `test/main/user-agent-fingerprint.test.js`（约 80 行）：

| # | 断言 | 验证点 |
|---|---|---|
| 1 | `buildChromeUserAgent()` 输出不含 `Electron` | 基础伪装不退化 |
| 2 | UA 的 OS 段与 `process.platform` 一致 | win32 → `Windows NT`；darwin → `Macintosh`；linux → `X11` |
| 3 | `buildClientHintsHeaders()` 的 `sec-ch-ua-platform` 与平台一致 | Client Hints 一致性 |
| 4 | `buildNativeMask()` 输出包含 `Symbol.for`、`WeakMap`、`[native code]` | toString 修复的关键字都在 |
| 5 | `buildChromeObjectFix()` 输出包含 `chrome.loadTimes` | 保留 loadTimes 不被误删 |
| 6 | `buildUserAgentDataFix()` 输出包含 `lyNativeMask` 引用 | getter 会去标记 |

**P3 不写单测**（依赖真实 webContents，mock 成本高）。改为手动验收：
- 开发模式打开 DevTools Performance 录制
- 点一次发送按钮，看 timeline 里是否有 **8 次以上 mouseMove** 事件
- 每次间隔是否在 8-28ms 区间

---

## 五、验收标准

- [ ] `npm test` ≥ 1258 通过，无新增失败（当前基线 1258/1259，1 个已知失败在 redact-store）
- [ ] 控制台 `navigator.webdriver.toString()` 返回 `function get webdriver() { [native code] }`
- [ ] 控制台 `navigator.webdriver.toString.toString()` 也返回 native 串（无二次暴露）
- [ ] macOS 上 `navigator.userAgent` 含 `Macintosh`，`navigator.userAgentData.platform === 'macOS'`
- [ ] 点击发送按钮时，DevTools Performance 里能看到多次 mouseMove 且间隔随机
- [ ] 三个 AI 平台（DeepSeek / ChatGPT / Claude）各开一次，均能正常发消息，无新增风控拦截

---

## 六、风险与回滚

| 风险 | 缓解 |
|---|---|
| `Function.prototype.toString` 被改后仍能通过 `toString.toString()` 暴露 | 内层已做 native 标记；单测 #4 断言关键字；手动验收 #3 专项检查 |
| 某些库依赖真实 toString 行为 | WeakMap 未命中的函数回落原生 toString，不受影响 |
| UA 变化触发平台风控（尤其 Claude 的 CF 规则） | 三平台各回归一次；出问题快速 `git checkout src/main/user-agent.js`（**注：当前本机 git 不可用，回滚靠 .bak 备份**） |
| 贝塞尔点击延迟影响体验 | 最多约 15 步 × 28ms ≈ 420ms，用户可感知但可接受；实测若过慢可减步数 |
| 首次点击从窗口中心起算，视觉上「鼠标从中心飞来」 | 符合人类首次移动鼠标的常见行为，不违和 |
| 本机 git 不可用（P0-1 未解决），改坏无法 `git checkout` 回滚 | **改前先手动备份 user-agent.js / ipc.js / index.js 到 .bak 后缀** |

---

## 七、改动清单

| 文件 | 改动 | 预估行数 |
|---|---|---|
| `src/main/user-agent.js` | 新增 `detectOS` / `buildNativeMask`；修改 3 个 build 函数引用 detectOS；导出新增两个函数 | +80 / -20 |
| `src/main/ipc.js` | `trusted-click` handler 加贝塞尔路径 + `_lastMousePos` 模块级 Map | +55 / -5 |
| `src/preload/index.js` | FIXES 数组最前面加 `['nativeMask', buildNativeMask()]` | +1 |
| `test/main/user-agent-fingerprint.test.js` | 新建，6 条断言 | ~80 |

合计：约 +216 / -25 行，改 3 个文件 + 新增 1 个测试文件。

---

## 八、执行顺序

1. 备份三个待改文件（`.bak-fingerprint-20261105`）
2. 改 `user-agent.js`（先 detectOS，再 buildNativeMask，最后改三个 build 函数）
3. 改 `preload/index.js`（FIXES 数组）
4. 写测试 `test/main/user-agent-fingerprint.test.js`
5. 跑 `node --test test/main/user-agent-fingerprint.test.js`，本地验证
6. 改 `ipc.js`（贝塞尔点击）
7. 跑 `npm test` 全量
8. 手动验收：三平台各发一条消息 + DevTools 看 mouseMove
9. 若失败，从 `.bak` 恢复

---

## 九、非目标（明确不做）

- 不改 TLS / Canvas / WebGL / Audio 底层（架构不允许）
- 不改输入速度（P1-a 分片输入，用户已明确砍掉）
- 不引入 CloakBrowser 或任何第三方指纹库（会带来新依赖与新破绽）
- 不动主流程、不动沙箱、不动 IPC 协议（只加不删）

---

计划完成，等待批准后开始编码。
