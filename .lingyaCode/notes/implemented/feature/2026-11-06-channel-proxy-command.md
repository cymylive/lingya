# Agent Note: 三平台统一通信指令与 /proxy 快捷获取

Status: implemented

## Problem
灵鸦支持飞书、微信、QQ 三个通道。原本飞书有一套自己的指令系统（/new /stop 等），微信和 QQ 是各自分开的。为了增加获取最新隧道地址的指令（/proxy），如果不统一，需要在三个文件里写三遍重复逻辑，极难维护。此外，临时隧道的域名每次重启都会变，用户每次都要去电脑前看一眼，体验很差。

## Decision
1. 将指令解析抽象到 `channel-commands.js`（仅微信和 QQ 复用了它），飞书因为底层消息结构特殊，在 `feishu-ipc.js` 中单独写了 `handleFeishuCommand`。
2. 新增 `/proxy` (兼容 `/pxory`) 指令。当收到该指令时，主进程调用 `tunnel.stopTunnel()` 和 `remoteIpc.startTunnelNow()` 重新建立隧道。
3. 将获取到的 `publicUrl` 和 `remote.json` 中的 `token` 一并通过各平台的 `reply` 接口发送给用户，用户直接复制即可连接手机端。

## Alternatives considered
- **让三个通道彻底共用一套解析器**：飞书底层使用的是卡片消息，消息格式与其他两个平台有差异，强行合并会导致复杂度陡增。
- **定时自动刷新地址并推送到通信平台**：容易造成消息骚扰，且如果用户不连，推了也没用。

## Consequences
- 用户在任何地方，只要在微信/QQ/飞书中发一个 `/proxy`，就能拿到最新的手机端连接凭证。
- 每次调用 `/proxy` 都会强行重启隧道，会有大约 3~5 秒的网络断开，但这对于手动获取地址的场景是可以接受的。