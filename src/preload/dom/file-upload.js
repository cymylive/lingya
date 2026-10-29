/**
 * 文件上传发送：将文本内容写入虚拟 .md 文件，通过 input[type=file] 上传。
 *
 * 全局替换文本输入：所有发送都走文件传输，不再直接填字。
 * 文件名每次随机生成（随机词 + 时分秒），内容每次在内存中替换，不产生磁盘垃圾。
 *
 * 发送顺序（由 chat-input.js 控制）：优先可信回车，失败再点发送按钮。
 */
// ===== 附件文件名：拟真随机（2026-10-30）=====
// 原固定名 lingya-input.md 在每条消息的附件卡片上重复出现，是强机器指纹。
// 改为「随机词 + 时分秒」组合，每次上传换一个，且不含恒定前缀。
// 时间戳用短格式（时分秒）而非完整日期：同日多条也不会重名，也不暴露规律。
const FILE_WORDS = ['笔记', '任务', '说明', '草稿', '分析', '资料', '片段', '文档', '记录', '备忘'];

/** 两位补零 */
function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/**
 * 生成一个拟真文件名：<随机词>-<时分秒>.md
 * @returns {string}
 */
function pickFileName() {
  const word = FILE_WORDS[Math.floor(Math.random() * FILE_WORDS.length)];
  const d = new Date();
  const stamp = pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  return word + '-' + stamp + '.md';
}

// ===== 并发锁（2026-10-29 审计修复）=====
// 无锁时两次 sendToChat 并发调用 uploadContent，都会读到相同的 beforeCount，
// 各自注入一个文件 → 输入框累积 2 个附件（用户截图 1.79KB + 248B 即此）。
// 用 promise chain 串行化：每次调用排队等上一次完成。
let uploadChain = Promise.resolve();

/** 找到页面的文件上传控件 */
function findFileInput() {
  return document.querySelector('input[type="file"]');
}

/** 用字符串构造一个 File 对象（不落盘） */
function buildFile(content, fileName) {
  return new File([content], fileName, { type: 'text/markdown' });
}

/**
 * 清空输入框。上传前必须清，避免旧文本残留被一起发出去。
 */
function clearInput(input) {
  if (!input) return;
  try {
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      const proto = input.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (input.isContentEditable) {
      input.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    }
  } catch (_) {}
}

/**
 * 统计区域内文件名出现的次数。
 *
 * 为什么用计数而不是 Set 差集：DeepSeek 可能复用 DOM 节点渲染新附件，
 * 节点身份不变但文本内容多了一份。计数法对「节点复用」和「历史消息」
 * 都免疫 —— 只看注入前后文本里文件名多没多。
 */
function countFileName(scope, name) {
  if (!scope || !scope.textContent) return 0;
  const txt = scope.textContent;
  let n = 0, idx = 0;
  while ((idx = txt.indexOf(name, idx)) !== -1) { n++; idx += name.length; }
  return n;
}

/**
 * 把文本内容上传为 .md 文件。
 *
 * @param {string} content 要发送的正文
 * @param {Element} input 输入框（用于上传前清空）
 * @returns {Promise<boolean>} 附件是否成功挂载到页面
 */
async function uploadContentInternal(content, input) {
  // 本次上传使用的文件名：每次调用独立生成，保证不重复
  const fileName = pickFileName();

  // 页面刚导航完时 file input 可能还没渲染，重试最多 5 秒
  let fileInput = findFileInput();
  if (!fileInput) {
    const startWait = Date.now();
    while (!fileInput && Date.now() - startWait < 5000) {
      await new Promise((r) => setTimeout(r, 400));
      fileInput = findFileInput();
    }
  }
  if (!fileInput) {
    console.warn('[LingYa] 未找到文件上传控件（等待 5s 后仍无），无法走文件发送');
    return { ok: false, fileName };
  }

  // 1. 清空输入框，避免残留文本混入
  clearInput(input);

  // 2. 记录上传前的文件名出现次数（以 document.body 为范围）
  //
  // 【真实事故 3 · 2026-10-29 用户截图】用 composer 祖先作范围时，附件卡片
  // 渲染在该范围之外，计数恒为 0 → 检测超时 → chat-input.js 回退把全文塞进
  // 输入框，界面出现「附件 + 正文」双份内容。
  // 附件挂载位置由平台决定，不能假设；改用整页计数增量，挂在哪都能看见。
  const beforeCount = countFileName(document.body, fileName);
  console.log('[LingYa][上传诊断] 上传前全页文件名出现次数=' + beforeCount + '（' + fileName + '）');

  // 2.5 残留附件处理（2026-10-29 审计后修订）
  //
  // 【已删除】旧代码在这里直接清空 fileInput.files。审计确认这是危险动作：
  //   - 只清底层 files、不清 UI 卡片，React 状态与 DOM 不一致；
  //   - 与第 3 步的重新注入之间存在窗口期，并发时另一次上传会读到空；
  //   - beforeCount 含历史消息，第 2 轮对话起几乎必然误判为"残留"。
  // 并发累积问题的正解是上面的 promise chain 串行锁，不是清 files。
  // 这里只在日志里提示，不做任何破坏性操作。

  // 3. 构造并注入文件
  try {
    const file = buildFile(content, fileName);
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (err) {
    console.warn('[LingYa] 注入文件失败:', err && err.message);
    return { ok: false, fileName };
  }

  // 4. 轮询等待文件名出现次数增加（最多 8 秒）
  //
  // 【真实事故 1】旧实现用 document.body.innerText 搜索文件名，历史消息会让
  // 第一次轮询立刻命中 → 假成功。
  // 【真实事故 2】改用节点 Set 差集后仍失败：检测超时、回退文本发送。原因是
  // 找到的 composer 祖先过宽，基线已含历史消息里的文件名，差集恒为空；且平台
  // 可能复用 DOM 节点渲染新附件，节点身份不变。改用「计数增加」判定。
  // 双判据（2026-10-29 审计修复 P0-3）：
  //   A. DOM 计数增加 —— 平台把文件渲染成了卡片
  //   B. 底层 fileInput.files 仍有内容 —— 文件已注入但卡片还没渲染出来
  //
  // 只用 A 有假阴性风险：长对话里虚拟滚动会卸载历史消息，计数可能不升反降，
  // 导致「实际已挂载但判定失败」→ chat-input.js 回退把全文塞进输入框 → 正文外漏复发。
  const start = Date.now();
  let lastCount = beforeCount;
  while (Date.now() - start < 8000) {
    await new Promise((r) => setTimeout(r, 200));
    lastCount = countFileName(document.body, fileName);
    if (lastCount > beforeCount) {
      console.log('[LingYa][上传诊断] 检测到附件（DOM 计数）：' + beforeCount + ' → ' + lastCount);
      await new Promise((r) => setTimeout(r, 400));
      return { ok: true, fileName };
    }
    // 兜底 B：平台已把 files 读走（注入后 fileInput.files 会从 1 变 0）。
    //
    // 【两条死路，都已排除】
    //   ① 用「files 非空」判成功 —— 那是第 3 步刚设的值，恒为真，
    //      会让第一个轮询周期就无条件返回成功，检测形同虚设。
    //   ② 用宽泛的 class 选择器找"附件节点" —— [class*="file"] 会命中
    //      页面上常驻的上传容器，同样造成假成功。
    // 唯一可靠的兜底信号是「files 被平台消费掉」：说明平台确实读取并接管了
    // 这个 File 对象，已进入其内部状态。此时即视为挂载成功。
    let fileCount = -1;
    try { fileCount = (fileInput.files && fileInput.files.length) || 0; } catch (_) {}
    if (fileCount === 0) {
      console.log('[LingYa][上传诊断] 检测到附件（files 已被平台消费）');
      await new Promise((r) => setTimeout(r, 300));
      return { ok: true, fileName };
    }
  }

  console.warn('[LingYa] 文件上传超时（8s 内既无 DOM 计数增加，files 也为空：' +
    beforeCount + ' → ' + lastCount + '）');
  return { ok: false, fileName };
}

/**
 * 串行化入口：同一时刻只允许一个上传流程。
 * 前一次失败也要放行下一次（catch 掉错误，不让链断）。
 */
function uploadContent(content, input) {
  const run = () => uploadContentInternal(content, input);
  const p = uploadChain.then(run, run);
  uploadChain = p.then(() => {}, () => {});   // 断开错误传播，保持链可用
  return p;
}

module.exports = { uploadContent, pickFileName, findFileInput };
