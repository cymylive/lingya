# SOP：GitHub Release 发布全流程（LingYa 本机）

> 本机 git 的 TLS 栈长期故障，直接 `git push` 十次九败。这份 SOP 把踩过的坑固化，照做即可。

## 阶段 0 — 发布前检查

```bash
git status --short          # 必须干净（或确认改动都属于本次发布）
git log --oneline -3        # 确认 HEAD 是想要的提交
findstr /C:"version" package.json   # 确认版本号已升
```

**版本号规则**：每次发布必须升，不能复用旧号——electron-builder 的 `portable.unpackDirName`
不随版本升级会导致装了新版跑旧代码（记忆 #349）。

升完版本要跑同步脚本：

```bash
node scripts/sync-version.js
# 本地模式：用 package.json 自身 version，同步 unpackDirName 等派生字段
```

## 阶段 1 — 本地构建验证（可选但推荐）

```bash
set "PATH=D:\NodeJS;%PATH%"
npm run build:win:nsis:local     # 安装版
npm run build:win:portable:local # 便携版
```

构建完**必须验证 asar 里是新代码**，不能只看 exe 时间戳：

```js
const asar = require("@electron/asar");
const f = "dist/win-unpacked/resources/app.asar";
const s = asar.extractFile(f, "src/preload/overlay/ui.js").toString();
console.log("新函数存在:", s.includes("function startTaskbar"));
```

> 路径坑：`asar.extractFile` 在 Windows 上要用**反斜杠**（`src\\preload\\...`），
> 用正斜杠会报 `was not found in this archive`。

## 阶段 2 — 推送代码（TLS 战场）

### 标准重试命令

```batch
for /l %i in (1,1,8) do @(
  "E:\Git\cmd\git.exe" -c http.version=HTTP/1.1 -c http.sslVerify=false -c http.postBuffer=524288000 ^
  push https://<TOKEN>@github.com/cymylive/lingya.git main 2>&1 ^
  && echo PUSH_OK_%i && exit /b 0
)
```

典型结果：前 3 次报 `schannel SEC_E_INVALID_TOKEN`，第 4 次成功。**必须循环，单次必败。**

### 关键：不要相信 git 说成功

记忆 #341 踩过：git 输出 `Everything up-to-date` 但实际因 TLS 失败什么都没推。

**唯一可靠的验证**是 GitHub API 比对 SHA：

```python
import json, ssl, urllib.request
ctx = ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
h = {"Authorization":"Bearer <TOKEN>","User-Agent":"x","Accept":"application/vnd.github+json"}
r = urllib.request.urlopen(urllib.request.Request(
    "https://api.github.com/repos/cymylive/lingya/commits/main", headers=h), context=ctx, timeout=30)
print(json.load(r)["sha"])   # 与 git rev-parse HEAD 比对
```

> Python 的 urllib 在本机完全正常，只有 git 的 TLS 栈坏。所以**用 API 验证，不用 git ls-remote**。

## 阶段 3 — 打 tag 触发 CI

```bash
git tag -a v0.6.100 -m "v0.6.100: 说明"
# 推送 tag（同样循环重试）
git -c http.version=HTTP/1.1 -c http.sslVerify=false push <TOKEN>@github.com/cymylive/lingya.git refs/tags/v0.6.100
```

tag 推送通常比 main 顺利（体积小），实测一次过。

`release.yml` 由 `push: tags: v*` 触发，双平台构建（windows-latest + macos-latest）。

## 阶段 4 — 等待 CI

轮询脚本（不要用固定 sleep，容易等太久或等不够）：

```python
d = get("https://api.github.com/repos/cymylive/lingya/actions/runs/%d" % RUN_ID)
print(d["status"], d["conclusion"])
jobs = get(".../runs/%d/jobs" % RUN_ID)["jobs"]
for j in jobs: print(j["name"], j["status"], j["conclusion"])
```

实测耗时：Windows 约 3 分钟，macOS 约 5 分钟，串行共 8 分钟。

## 阶段 5 — 转正 draft Release

electron-builder `--publish always` 创建的是 **draft**，必须手动转正：

```python
body = {"draft": False, "name": "LingYa v0.6.100", "body": release_notes}
req = urllib.request.Request(
    "https://api.github.com/repos/cymylive/lingya/releases/%d" % release_id,
    data=json.dumps(body).encode(), headers={**h, "Content-Type":"application/json"}, method="PATCH")
```

### 坑 1：双平台竞态产生两个 draft

`max-parallel: 1` 只约束 **job** 并行，管不住 **electron-builder 的 publish 阶段**。
两个平台各自创建 draft 抢同一个 tag → GitHub 上两个独立 draft → `GET /releases/tags/<tag>` 返回 404。

### 坑 2：API 瞬时返回空列表

`releases?per_page=10` 首次可能返回 `[]`（2 字节），隔 2 秒再查就是 200KB+。
**单次空结果不能当「不存在」，必须重试确认。**

### 坑 3：不要在本机搬运资产

实测本机下载 GitHub release 资产 **0.10 MB/s**，425MB 要 70 分钟。

正确做法——用 GitHub Actions 搬运（runner 到 release 资产是内网速度）：

见 `.github/workflows/merge-releases.yml`，核心三步：

```yaml
- run: gh release download "$SRC" --dir /tmp/assets
- run: gh release upload "$DST" /tmp/assets/* --clobber
- run: |
    # 校验通过才删源（顺序不能反，否则中途失败产物永久丢失）
    COUNT=$(gh release view "$DST" --json assets --jq ".assets | length")
    [ "$COUNT" -ge 14 ] || exit 1
    gh release delete "$SRC" --yes --cleanup-tag
```

触发：

```python
urllib.request.Request(
  "https://api.github.com/repos/cymylive/lingya/actions/workflows/merge-releases.yml/dispatches",
  data=json.dumps({"ref":"main","inputs":{"source_tag":"v0.6.100-macos","target_tag":"v0.6.100"}}).encode(),
  headers={**h,"Content-Type":"application/json"}, method="POST")
# 返回 204 即成功，run 约 90 秒
```

## 阶段 6 — 验证

```python
r = get("https://api.github.com/repos/cymylive/lingya/releases/tags/v0.6.100")
print("draft=", r["draft"], "assets=", len(r["assets"]))
for a in r["assets"]: print(a["name"], a["state"])   # state 必须是 uploaded
```

预期：单一 Release，14 个资产（5 Windows + 9 macOS），`draft=False`。

## 一页速查

| 阶段 | 命令 | 坑 |
|---|---|---|
| 升版本 | 改 package.json + `node scripts/sync-version.js` | unpackDirName 不跟着改会跑旧代码 |
| 推送 | for 循环重试 8 次 | 前 3 次必败，第 4 次成 |
| 验证推送 | GitHub API 比 SHA | git 的「成功」可能是假的 |
| 打 tag | `git tag -a` + 循环推送 | 通常一次过 |
| 等 CI | 轮询 API | 别用固定 sleep |
| 转正 | PATCH draft:false | 两个 draft 要先合并 |
| 合并 | Actions 搬运 | 本机下载 0.1 MB/s，别硬搬 |
