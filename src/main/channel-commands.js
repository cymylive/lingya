/**
 * 通道通用指令：/help /new /list /say /stop
 *
 * 三个通道（飞书/微信/QQ）共用同一套实现，差别只在「怎么回复」。
 * 调用方传入一个 reply(msg) 回调，模块负责业务逻辑（建目录、导航、读写会话库）。
 *
 * 为什么抽出来：原本飞书有一套完整实现，微信/QQ 只是发了个没人监听的 IPC，
 * 复制三遍等于三处维护。统一后加指令只改这里。
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

/** 相对时间（纯文本场景比时间戳易读） */
function relTime(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + '分钟前';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + '小时前';
  const day = Math.floor(hr / 24);
  if (day < 30) return day + '天前';
  const d = new Date(t);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

/** 会话条目归一化：兼容旧格式（字符串=项目目录）与新格式（对象） */
function normalizeEntry(store, e) {
  if (typeof store.normalizeEntry === 'function') return store.normalizeEntry(e);
  if (typeof e === 'string') return { projectDir: e, title: null, updatedAt: null, archivedAt: null };
  if (e && typeof e === 'object') {
    return {
      projectDir: e.projectDir || null,
      title: e.title || null,
      updatedAt: e.updatedAt || null,
      archivedAt: e.archivedAt || null,
    };
  }
  return {};
}

/** 从项目目录路径取最后一段作为标题兜底 */
function titleFromDir(dir) {
  if (!dir) return '';
  const parts = String(dir).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || '';
}

/**
 * 处理一条斜杠指令。
 *
 * @param {string} text 原始消息
 * @param {object} ctx 窗口上下文（含 win / sessionStore / profileId）
 * @param {Function} reply async (msg) => void，把回复发给用户
 * @param {string} channelLabel 通道名（用于帮助文案，如「微信」）
 * @returns {Promise<boolean>} true = 已作为指令处理
 */
async function handleCommand(text, ctx, reply, channelLabel) {
  const cmd = String(text || '').replace(/^(@\S+\s*)+/, '').trim();
  if (!cmd.startsWith('/')) return false;

  const parts = cmd.slice(1).split(/\s+/);
  const name = (parts[0] || '').toLowerCase();
  const arg = parts.slice(1).join(' ').trim();
  const win = ctx && ctx.win;
  const label = channelLabel || 'LingYa';

  // ---------- /help ----------
  if (name === 'help' || name === '?') {
    await reply([
      '🤖 ' + label + ' 指令：',
      '/new [项目名] — 开新对话：桌面新建项目文件夹 + 注入提示词（AI 可访问电脑）',
      '/list — 列出会话：标题 + 相对时间，当前置顶、归档垫底',
      '/say <ID> — 切换到指定会话（ID 用 /list 查看，支持前缀）',
      '/stop — 停止当前任务（中断 AI 生成 + 终止工具执行）',
      '/proxy (或 /pxory) — 重启远程隧道并获取新的公网访问地址',
      '/help — 显示本帮助',
    ].join('\n'));
    return true;
  }

  // ---------- /proxy 或 /pxory ----------
  if (name === 'proxy' || name === 'pxory') {
    await reply('⏳ 正在重启隧道并获取新地址，请稍候…');
    try {
      const tunnel = require('./remote/tunnel');
      const remoteIpc = require('./remote-ipc');
      const config = require('./remote/config');
      await tunnel.stopTunnel();
      const r = await remoteIpc.startTunnelNow();
      const cfg = config.readConfig();
      if (r.ok && r.url) {
        await reply(
          '🌐 新的连接信息已生成：\n\n' +
          '电脑地址：' + r.url + '\n' +
          '访问令牌：' + cfg.token + '\n\n' +
          '💡 直接复制以上两条信息，填入手机端即可连接。'
        );
      } else {
        await reply('❌ 启动隧道失败：' + (r.error || '未知错误，请检查网络或 cloudflared 安装'));
      }
    } catch (err) {
      await reply('❌ 执行异常：' + err.message);
    }
    return true;
  }

  // ---------- /new ----------
  if (name === 'new') {
    if (!win || win.isDestroyed()) { await reply('❌ 目标窗口不可用'); return true; }

    // 从当前页面 URL 反查 provider 的首页
    let homeUrl = null;
    try {
      const { getProviderByUrl } = require('../providers');
      const provider = getProviderByUrl(win.webContents.getURL());
      if (provider && provider.homeUrl) homeUrl = provider.homeUrl;
    } catch (_) {}
    if (!homeUrl) { await reply('❌ 无法确定平台首页（当前平台未提供 homeUrl）'); return true; }

    // 1) 桌面新建项目目录
    let newDir = null;
    try {
      const desktop = app.getPath('desktop');
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = '' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) +
        '_' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
      const baseName = (arg ? arg.replace(/[\\/:*?"<>|]/g, '_') : 'LingYa项目') + '_' + stamp;
      newDir = path.join(desktop, baseName);
      fs.mkdirSync(newDir, { recursive: true });
      console.log('[' + label + '] /new 新建项目目录:', newDir);
    } catch (err) {
      console.error('[' + label + '] /new 建目录失败:', err.message);
      newDir = null;
    }

    // 2) 导航到平台首页（开新会话）
    try {
      await win.webContents.loadURL(homeUrl);
    } catch (err) {
      await reply('❌ 开新对话失败：' + err.message);
      return true;
    }

    // 3) 注入初始化提示词
    if (newDir) {
      try {
        await new Promise((r) => setTimeout(r, 1200));
        const { initProject } = require('./project-context');
        await initProject(false, ctx, newDir);
        console.log('[' + label + '] /new 已注入初始化提示词');
      } catch (err) {
        console.error('[' + label + '] /new 初始化失败:', err.message);
        await reply('🆕 已开新对话，但项目初始化失败：' + err.message);
        return true;
      }
    }

    await reply(
      '🆕 已开新对话' +
      (newDir ? ('\n📁 项目目录：' + newDir) : '') +
      '\n✅ 已注入项目提示词与工具能力，AI 可直接访问该目录及电脑。' +
      '\n\n💡 用法：/new 自定义项目名'
    );
    return true;
  }

  // ---------- /stop ----------
  if (name === 'stop') {
    if (!win || win.isDestroyed()) { await reply('❌ 目标窗口不可用'); return true; }
    try {
      // 通知渲染进程执行 stopTask（kill 子进程 + 点停止 + 置停止标志）
      win.webContents.send('lingya-stop-task');
      console.log('[' + label + '] 收到 /stop，已通知窗口停止任务');
      await reply('🛑 已停止：中断 AI 生成 + 终止工具执行。发送任意消息即可恢复。');
    } catch (err) {
      await reply('❌ 停止失败：' + err.message);
    }
    return true;
  }

  // ---------- /list ----------
  if (name === 'list') {
    const store = ctx && ctx.sessionStore;
    if (!store) { await reply('❌ 当前窗口无会话存储'); return true; }
    const all = store.readSessionStore();
    const ids = Object.keys(all);
    if (ids.length === 0) { await reply('📭 当前窗口暂无历史会话'); return true; }

    const current = store.state && store.state.currentSessionId;
    const items = ids.map((sid) => {
      const e = normalizeEntry(store, all[sid]);
      let title = String(e.title || '').trim();
      if (!title) title = titleFromDir(e.projectDir);
      if (!title) title = '(未命名)';
      return {
        sid,
        shortId: sid.slice(0, 8),
        title,
        updatedAt: e.updatedAt || null,
        archived: !!e.archivedAt,
        isCurrent: sid === current,
      };
    });

    items.sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      if (a.archived !== b.archived) return a.archived ? 1 : -1;
      const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    });

    const MAX_SHOW = 30;
    const shown = items.slice(0, MAX_SHOW);
    const body = shown.map((it) => {
      const mark = it.isCurrent ? '👉' : '  ';
      const time = relTime(it.updatedAt);
      const tail = (time ? '  ' + time : '') + (it.archived ? '  📦' : '');
      return mark + ' ' + it.shortId + '  ' + it.title + tail;
    }).join('\n');

    const more = items.length > MAX_SHOW
      ? ('\n\n… 另有 ' + (items.length - MAX_SHOW) + ' 个未显示')
      : '';

    await reply(
      '📋 会话列表（共 ' + items.length + ' 个）\n\n' + body + more +
      '\n\n💡 /say <ID前几位> 切换会话\n   👉 当前会话   📦 已归档'
    );
    return true;
  }

  // ---------- /say ----------
  if (name === 'say' || name === 'switch' || name === 'to') {
    if (!win || win.isDestroyed()) { await reply('❌ 目标窗口不可用'); return true; }
    if (!arg) { await reply('用法：/say <会话ID>（用 /list 查看，支持前缀匹配）'); return true; }
    const store = ctx && ctx.sessionStore;
    if (!store) { await reply('❌ 当前窗口无会话存储'); return true; }
    const all = store.readSessionStore();
    const ids = Object.keys(all);
    if (ids.length === 0) { await reply('📭 当前窗口暂无历史会话'); return true; }

    let target = ids.find((id) => id === arg);
    if (!target) {
      const matches = ids.filter((id) => id.startsWith(arg));
      if (matches.length === 0) {
        await reply('❌ 未找到会话：' + arg + '（用 /list 查看可用 ID）');
        return true;
      }
      if (matches.length > 1) {
        await reply('❌ 前缀不唯一（' + matches.length + ' 个匹配）：' +
          matches.map((m) => m.slice(0, 8)).join('、') + '\n请输入更长的前缀。');
        return true;
      }
      target = matches[0];
    }

    let url = null;
    try {
      const { getProviderByUrl } = require('../providers');
      const provider = getProviderByUrl(win.webContents.getURL());
      if (provider && typeof provider.sessionUrlBase === 'string' && provider.sessionUrlBase) {
        url = provider.sessionUrlBase + target;
      }
    } catch (_) {}
    if (!url) { await reply('❌ 无法确定会话 URL（当前平台未提供 sessionUrlBase）'); return true; }

    try {
      await win.webContents.loadURL(url);
    } catch (err) {
      await reply('❌ 切换会话失败：' + err.message);
      return true;
    }
    const e = normalizeEntry(store, all[target]);
    const dir = e.projectDir || '(未绑定目录)';
    console.log('[' + label + '] /say 已切换会话:', target);
    await reply('✅ 已切换到会话：\n· ID：' + target + '\n· 目录：' + dir + '\n\n后续消息将发送到该会话。');
    return true;
  }

  // ---------- 未知 ----------
  await reply('❓ 未知指令：/' + name + '（发送 /help 查看可用指令）');
  return true;
}

module.exports = { handleCommand, relTime };
