/**
 * 文件上传发送：将文本内容写入虚拟 .md 文件，通过 input[type=file] 上传。
 *
 * 全局替换文本输入：所有发送都走文件传输，不再直接填字。
 * 固定文件名 lingya-input.md，内容每次在内存中替换，不产生磁盘垃圾。
 *
 * 发送顺序（由 chat-input.js 控制）：优先可信回车，失败再点发送按钮。
 */
const FILE_NAME = 'lingya-input.md';

/** 找到页面的文件上传控件 */
function findFileInput() {
  return document.querySelector('input[type="file"]');
}

/** 用字符串构造一个 File 对象（不落盘） */
function buildFile(content) {
  return new File([content], FILE_NAME, { type: 'text/markdown' });
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
 * 把文本内容上传为 .md 文件。
 *
 * @param {string} content 要发送的正文
 * @param {Element} input 输入框（用于上传前清空）
 * @returns {Promise<boolean>} 附件是否成功挂载到页面
 */
async function uploadContent(content, input) {
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
    return false;
  }

  // 1. 清空输入框，避免残留文本混入
  clearInput(input);

  // 2. 构造并注入文件
  try {
    const file = buildFile(content);
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (err) {
    console.warn('[LingYa] 注入文件失败:', err && err.message);
    return false;
  }

  // 3. 轮询等待附件卡片出现在页面上（最多 8 秒）
  const start = Date.now();
  while (Date.now() - start < 8000) {
    await new Promise((r) => setTimeout(r, 300));
    const bodyText = document.body && document.body.innerText ? document.body.innerText : '';
    if (bodyText.indexOf(FILE_NAME) !== -1) {
      // 附件已挂载，再多等 400ms 让平台完成解析，避免发出去时内容还没绑定
      await new Promise((r) => setTimeout(r, 400));
      return true;
    }
  }

  console.warn('[LingYa] 文件上传超时（8s 内未检测到附件）');
  return false;
}

module.exports = { uploadContent, FILE_NAME, findFileInput };
