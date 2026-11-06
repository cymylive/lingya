# Agent Note: 手机端双向文件流转与本地分发机制

Status: implemented

## Problem
1. 用户需要手机与电脑之间无限制地互传文件，且不能受限于任何单个文件的大小。
2. 在进行 APK 构建时，遇到了 GitHub 私有仓库 Actions 额度耗尽（或 0 步秒挂）的问题，且 GitHub 的 Artifact 链接存在 302 跳转，传统下载方式极易因 Token 泄露或权限不足报 401。
3. 微信/飞书发送 APK 有 20MB 的大小限制，无法直接发送给手机。

## Decision
1. **流式文件传输**：在 `server.js` 中新增了 `/api/upload` 和 `/api/download` 路由，直接利用 Node 的 Stream（`req.pipe(writeStream)`）处理文件，不占内存，不限大小。前端采用 `fetch` 上传和 `a` 标签下载。
2. **本地 HTTP 分发**：利用 Node/Python 在本地起一个临时 HTTP Server（如 8902 端口），把打好的 APK 放到根目录。手机和电脑在同一局域网下，直接访问 `http://<IP>:8902/lingya-download.apk` 即可获得满速下载，完美绕过微信/飞书的 20MB 限制。
3. **脚本级下载处理 302**：在 Node 脚本中获取 GitHub Artifact 时，必须捕获 301/302 状态码，一旦发生跳转，立刻在后续请求中剥离 Authorization 头，否则 Azure 存储会直接拒绝访问。

## Alternatives considered
- **文件分片上传**：虽然对大文件更稳定，但需要处理复杂的断点续传和分片合并，Stream 已经足够。
- **通过第三方网盘（如阿里云盘、百度网盘）中转**：需要额外登录和客户端，局域网 HTTP 是零成本最高效的。

## Consequences
- 手机端突破了格式和大小限制，真正实现了生产力互传。
- 摆脱了对 GitHub Actions 额度和网络环境的绝对依赖，本地能随时通过局域网给手机分发最新构建。