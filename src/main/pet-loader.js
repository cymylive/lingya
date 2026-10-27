/**
 * 外部宠物加载器（主进程）
 *
 * 扫描 <userData>/pets/*.json，校验后供 tab-manager 通过 additionalArguments
 * 注入到渲染进程（preload）。这样用户丢个 JSON 文件进目录就能换宠物皮肤，
 * 无需改代码、无需重启打包。
 *
 * 为什么走启动参数而不是 IPC：
 *   template.js 在模块加载时【同步】构造 OVERLAY_HTML，宠物 SVG 是其中一部分。
 *   IPC 是异步的，拿不到数据就会先渲染出空壳。启动参数在 preload 执行前就已就位，
 *   可以同步读取，模板构造不受影响。
 *
 * 安全约束：只接受 JSON（纯数据），绝不加载可执行 JS。
 *   外部文件能控制的是 SVG 字符串，写入 innerHTML。
 *   为防止通过 SVG 注入脚本，这里做白名单校验（见 validateSvgLines）。
 */
const fs = require('fs');
const path = require('path');

/** 宠物目录名（相对 userData） */
const PETS_DIR_NAME = 'pets';

/** 单个宠物 SVG 行数上限，防止超大文件拖慢覆盖层渲染 */
const MAX_SVG_LINES = 200;

/** 单行长度上限 */
const MAX_LINE_LENGTH = 2000;

/** 宠物数量上限，防止目录里堆几千个文件 */
const MAX_PETS = 50;

/**
 * 校验 SVG 行数组是否安全。
 *
 * 允许的标签：svg / path / ellipse / circle / rect / line / polygon / g / defs
 * 明确拒绝：script / foreignObject / iframe / object / embed / image / use
 * 拒绝 on* 事件属性与 javascript: 协议。
 *
 * 注意：这是"降低风险"而非"完全杜绝"。外部宠物本来就是用户自己放进去的，
 * 但至少要挡住从网上抄来的恶意片段。
 */
function validateSvgLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return 'svgLines 必须是非空数组';
  if (lines.length > MAX_SVG_LINES) return 'svgLines 超过 ' + MAX_SVG_LINES + ' 行上限';

  const joined = lines.join('');
  if (joined.length > MAX_SVG_LINES * MAX_LINE_LENGTH) return 'svgLines 体积过大';

  // 逐个检查超长行
  for (let i = 0; i < lines.length; i++) {
    if (typeof lines[i] !== 'string') return 'svgLines 第 ' + (i + 1) + ' 行不是字符串';
    if (lines[i].length > MAX_LINE_LENGTH) return 'svgLines 第 ' + (i + 1) + ' 行过长';
  }

  const lower = joined.toLowerCase();

  // 危险标签黑名单
  const bannedTags = ['script', 'foreignobject', 'iframe', 'object', 'embed', 'image', 'use', 'animate', 'set'];
  for (const tag of bannedTags) {
    if (new RegExp('<' + tag + '[\\s>/]', 'i').test(lower)) return '包含禁止的标签 <' + tag + '>';
  }

  // 事件属性（onclick / onload ...）
  if (/\son[a-z]+\s*=/.test(lower)) return '包含事件属性（on*）';

  // 脚本协议
  if (lower.includes('javascript:')) return '包含 javascript: 协议';
  if (lower.includes('data:text/html')) return '包含 data:text/html';

  return null;
}

/**
 * 校验单个宠物定义。
 * @returns {{ ok: true, pet: object } | { ok: false, reason: string }}
 */
function validatePet(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: '不是对象' };

  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return { ok: false, reason: '缺少 id' };
  // id 会进入 localStorage 与日志，限制为安全字符
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) return { ok: false, reason: 'id 只能含字母数字下划线连字符，长度 1-40' };

  const name = typeof raw.name === 'string' ? raw.name.trim() : id;
  if (name.length > 40) return { ok: false, reason: 'name 过长' };

  const err = validateSvgLines(raw.svgLines);
  if (err) return { ok: false, reason: err };

  return { ok: true, pet: { id, name, svgLines: raw.svgLines } };
}

/**
 * 扫描并加载外部宠物。
 * 任何单个文件出错都只跳过该文件，绝不让整个扫描失败——
 * 否则一个坏文件就能让用户所有宠物都用不了。
 *
 * @param {string} userDataDir 用户数据目录
 * @returns {{ pets: Array, warnings: Array<string> }}
 */
function loadExternalPets(userDataDir) {
  const pets = [];
  const warnings = [];

  if (!userDataDir) return { pets, warnings: ['未提供 userData 目录'] };

  const dir = path.join(userDataDir, PETS_DIR_NAME);

  let entries;
  try {
    if (!fs.existsSync(dir)) return { pets, warnings };
    entries = fs.readdirSync(dir);
  } catch (e) {
    warnings.push('读取宠物目录失败: ' + e.message);
    return { pets, warnings };
  }

  const jsonFiles = entries.filter(f => f.toLowerCase().endsWith('.json'));
  if (jsonFiles.length > MAX_PETS) {
    warnings.push('宠物文件过多（' + jsonFiles.length + '），只加载前 ' + MAX_PETS + ' 个');
  }

  const seen = new Set();
  for (const file of jsonFiles.slice(0, MAX_PETS)) {
    const full = path.join(dir, file);
    try {
      const text = fs.readFileSync(full, 'utf8');
      const raw = JSON.parse(text);
      const result = validatePet(raw);
      if (!result.ok) {
        warnings.push(file + ': ' + result.reason);
        continue;
      }
      if (seen.has(result.pet.id)) {
        warnings.push(file + ': id "' + result.pet.id + '" 与前面的宠物重复，已跳过');
        continue;
      }
      seen.add(result.pet.id);
      pets.push(result.pet);
    } catch (e) {
      warnings.push(file + ': ' + (e.message || '解析失败'));
    }
  }

  return { pets, warnings };
}

/**
 * 生成注入给渲染进程的启动参数值。
 * 用 base64 编码，避免路径/引号/中文在命令行里的转义问题。
 *
 * 参数过大时不注入（Electron 命令行有长度限制，Windows 约 32KB）。
 * 超限时宁可让外部宠物不生效，也不能让窗口创建失败。
 */
function buildArgValue(pets) {
  if (!Array.isArray(pets) || pets.length === 0) return '';
  try {
    const json = JSON.stringify(pets);
    const b64 = Buffer.from(json, 'utf8').toString('base64');
    // Windows 命令行总长限制约 32767，留足余量
    if (b64.length > 20000) return '';
    return b64;
  } catch (_) {
    return '';
  }
}

/** 启动参数名 */
const ARG_NAME = '--lingya-pets=';

module.exports = {
  PETS_DIR_NAME,
  ARG_NAME,
  loadExternalPets,
  buildArgValue,
  validatePet,
  validateSvgLines,
};
