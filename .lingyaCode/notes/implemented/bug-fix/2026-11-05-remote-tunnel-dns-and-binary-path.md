# Agent Note: 手机远程隧道起不来——二进制路径与 DNS 双重失效

Status: implemented

## Problem

用户在「设置 → 手机远程」点「启动隧道」始终失败，界面提示「隧道错误: 系统中未检测到 cloudflared，请先安装或将 cloudflared 加入环境变量 PATH」。排查发现这是**两个相互独立的故障叠加**，单独修任何一个都不足以恢复功能：

### 故障一：开发版永远找不到 cloudflared 二进制

`getPackagedCloudflared()` 用 `process.resourcesPath` 拼「应用自带二进制」的路径。这个值只在打包后才指向安装目录的 `resources/`；**开发版下它指向 `node_modules/electron/dist/resources`**，该目录里没有 cloudflared。

`findCloudflaredBinary()` 的其余候选全是系统级安装路径（`C:/Program Files/cloudflared/`、`%LOCALAPPDATA%/cloudflared/`、`C:/cloudflared/` 等），用户的二进制放在仓库根目录的 `resources/cloudflared/`，不在候选里。

更隐蔽的是兜底逻辑：函数末尾 `return 'cloudflared.exe'`，**永远返回非空字符串**。因此 `startTunnel` 里「未找到 cloudflared 可执行文件」的分支是死代码，真实失败只能从 spawn 的 `error` 事件（ENOENT）暴露，错误信息与根因（路径没找对）不对应。

### 故障二：系统 DNS 拒绝解析 argotunnel.com

即使手动指定二进制路径让 cloudflared 跑起来，它仍会失败退出（exit 1）：

```
INF  Your quick Tunnel has been created! Visit it at: https://xxx.trycloudflare.com
ERR  edge discovery: error looking up Cloudflare edge IPs: the DNS query failed
     error="lookup argotunnel.com: no such host"
ERR  Initiating shutdown error="Could not lookup srv records on _v2-origintunneld._tcp.argotunnel.com"
```

现场核实：

- 系统 DNS 是 IPv6 路由器地址 `fe80::1`，`nslookup argotunnel.com` 直接返回 **Query refused**
- 用 `1.1.1.1` 解析超时
- 用 `223.5.5.5` 可正常解析出 `region1.v2.argotunnel.com` / `region2.v2.argotunnel.com` 的 A 记录

即 cloudflared 拿到了公网 URL（控制面通），但数据面建立连接时需要解析 edge 域名，被本地 DNS 挡住，隧道随即关闭。

## Decision

### 针对故障一：扩充候选路径

`buildCloudflaredCandidates()` 的 win32 分支追加三个候选，按优先级排在系统路径之后：

1. `$LINGYA_RESOURCES/cloudflared/cloudflared.exe`（环境变量显式指定）
2. `path.join(__dirname, '..', '..', '..', 'resources', 'cloudflared', 'cloudflared.exe')`（源码仓库相对路径）
3. `path.join(process.cwd(), 'resources', 'cloudflared', 'cloudflared.exe')`（工作目录兜底）

同时把仓库根目录的 `resources/cloudflared/cloudflared.exe` 补齐（该目录此前只有 README.txt，二进制缺失）。

### 针对故障二：可配置 DNS 解析 edge IP，用 `--edge` 绕过系统 DNS

新增 `resolveEdgeIps(dnsServer)`：用 Node 的 `dns.Resolver` 指定服务器（默认 `223.5.5.5`）解析 `region1/region2.v2.argotunnel.com` 的 IPv4，结果按 `server + 10 分钟 TTL` 缓存。

新增 `buildEdgeArgs(ips)`：把 IP 列表拼成 `['--edge', 'ip:7844', ...]`。

`startTunnel` 改为 async，在 spawn 之前先解析（失败则返回空数组、静默回退到默认行为，不阻塞启动），再把 `--edge` 参数追加到 cloudflared 命令行。

配置层新增 `edgeDns` 字段，默认 `'223.5.5.5'`，由 `remote-ipc.js` 读取后传入 `startTunnel`。

## Alternatives considered

**直接把 edge IP 硬编码进代码** —— 把实测拿到的 `198.41.192.x` 写死成常量。落选原因：Cloudflare edge IP 会变，硬编码在换区域或官方调整后必然失效，而且失效时的表现（连不上但无明确报错）比现在更难排查。动态解析 + 缓存既避免每次启动都查 DNS，也不怕 IP 变更。

**让用户改系统 DNS** —— 把网卡 DNS 改成 223.5.5.5。落选原因：需要管理员权限，且影响整台机器的所有程序；用户机器上还有 `lan` 后缀的内网域名解析，改全局 DNS 可能破坏内网服务。改动应当局限在 LingYa 自己的进程内。

**改 hosts 文件固定 argotunnel.com 的解析** —— 落选原因：同样需要管理员权限，且同样会因 IP 变化而失效，还需要用户手动维护；相比 `--edge` 参数没有任何优势。

**只设 `CLOUDFLARED_BIN` 环境变量绕过路径问题** —— `findCloudflaredBinary` 已经支持读这个变量。落选原因：这是临时手段，用户换个终端或从桌面图标启动就失效；问题在于候选列表本身不完整，应当补齐而不是让用户记环境变量。

**修掉 `findCloudflaredBinary` 永远返回非空的兜底逻辑** —— 让函数在找不到时返回空串，使「未找到」分支生效。本次未做，原因：这会改变函数的对外契约（目前调用方依赖它总是返回一个可 spawn 的字符串），且不属于本次故障的必要修复路径。属于已知的后续改进点。

## Consequences

**收益**

- 开发版与打包版都能从 `resources/cloudflared/` 找到二进制，不再依赖系统级安装
- 系统 DNS 被拒绝的环境下隧道仍能建立，不再要求用户改动机器网络配置
- edge IP 有 10 分钟缓存，正常路径下不增加启动耗时；解析失败静默回退，不会因为 DNS 抖动导致隧道完全起不来
- 真机验证：公网 URL 返回 HTTP 200，服务端口与本机 cloudflared 进程之间建立 ESTABLISHED 连接

**代价**

- 隧道启动多了一次 DNS 查询的等待（有缓存，通常仅首次）
- `edgeDns` 配置项对用户不可见（未暴露到设置页 UI），改默认值需要改代码或手改 `remote.json`
- 单元测试的 mock 需要真实模拟 `exitCode` 属性（真实 ChildProcess 未退出时为 `null`，原先的 mock 缺这个属性，导致三个用例在修复过程中假阳性失败），测试代码与实际运行时对象的形状耦合更紧
- Quick Tunnel 的公网地址每次重启都会变化，本次改动没有解决这个问题；要固定地址仍需配置 named tunnel 的 `tunnelToken`
