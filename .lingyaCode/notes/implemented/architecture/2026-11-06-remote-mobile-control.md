# Agent Note: 手机远程控制与 PWA 双端架构

Status: implemented

## Problem
灵鸦原本只能在电脑前使用，用户希望能通过手机（浏览器或 App）远程查看 AI 对话流、发送消息、甚至管理历史会话。但 Electron 主进程的 IPC 无法直接被外部网络访问，且需要保证鉴权和双向实时通信。

## Decision
1. 采用 **WebSocket + HTTP** 在本地主进程起一个轻量级 Server（默认端口 7799/7800），通过 Cloudflare Tunnel 或局域网暴露。
2. 手机端采用 **PWA（纯原生 JS+CSS）**，不引入 React/Vue 等重型框架，确保极低延迟和低门槛。
3. 底层通过统一的 `manager.js` 桥接：手机的 WS 消息转化为 Electron 的 `view.webContents.send`；AI 的流式事件通过 `broadcastAiEvent` 转发给 WS。
4. 会话数据不通过内存转储，而是由手机端直接向主进程请求，主进程从磁盘的 `.jsonl`（conversation-archive）中读取最近 40 条。

## Alternatives considered
- **通过 WebRTC 点对点直连**：太复杂，且穿透内网困难，运维成本高。
- **通过公共 MQTT 服务器中转**：依赖第三方，且对话内容明文经过第三方，存在安全隐患。
- **直接暴露 Electron 原有 IPC**：外部网络无法直接调用，且没有鉴权机制，极其危险。

## Consequences
- 手机端与桌面端实现了完全解耦，手机端仅作为一个纯粹的“遥控器”。
- 引入了 PWA 的状态同步痛点（如顶部状态栏遮挡、WebSocket 断线重连等），需要在 PWA 层用原生 JS 解决。
- 手机端新建项目等操作必须依赖电脑端的 `ipc` 底层能力，跨进程链路变长。