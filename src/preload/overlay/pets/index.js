/**
 * 宠物注册表 —— 悬浮球的视觉造型可替换
 *
 * 宠物来源有两种：
 *   1. 内置：pets/pet-*.js（随程序发布）
 *   2. 外部：<userData>/pets/*.json（用户自建，主进程扫描后通过启动参数注入）
 *
 * 外部宠物的加载链路：
 *   主进程 pet-loader.js 扫描目录 → buildArgValue() 转 base64
 *   → tab-manager 写入 additionalArguments('--lingya-pets=...')
 *   → 本模块在加载时同步解析 process.argv → 与内置宠物合并
 *
 * 为什么走启动参数而不是 IPC：
 *   template.js 在模块加载时【同步】构造 OVERLAY_HTML，宠物 SVG 是其中一部分。
 *   IPC 是异步的，来不及。启动参数在 preload 执行前就位，可同步读取。
 *
 * 新增内置宠物：
 *   1. 在 pets/ 下新建 pet-xxx.js，导出 { id, name, svgLines }
 *   2. 在下方 BUILTIN 表里加一行
 *   3. localStorage 设 lingya-pet-id = 'xxx' 即生效
 */

const bird = require('./pet-bird');
const robot48 = require('./pet-robot48');

/** 内置宠物。key 即 id */
const BUILTIN = {
  bird,
  robot48,
};

/** 找不到配置时的兜底宠物 */
const DEFAULT_PET_ID = 'robot48';

/** localStorage 键名 */
const STORAGE_KEY = 'lingya-pet-id';

/** 启动参数名（与 pet-loader.js 的 ARG_NAME 保持一致） */
const ARG_NAME = '--lingya-pets=';

/**
 * 从启动参数解析外部宠物。
 * 解析失败一律返回空数组 —— 外部宠物是锦上添花，绝不能因为它让覆盖层渲染失败。
 */
function parseExternalPetsFromArgv() {
  try {
    const argv = (typeof process !== 'undefined' && Array.isArray(process.argv)) ? process.argv : [];
    const arg = argv.find(a => typeof a === 'string' && a.startsWith(ARG_NAME));
    if (!arg) return [];

    const b64 = arg.slice(ARG_NAME.length);
    if (!b64) return [];

    // 渲染进程有 Node 权限（sandbox: false），可直接用 Buffer
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const list = JSON.parse(json);
    if (!Array.isArray(list)) return [];

    // 二次校验：主进程已校验过，但渲染进程不能盲信跨进程数据
    return list.filter(p =>
      p && typeof p.id === 'string' && p.id &&
      Array.isArray(p.svgLines) && p.svgLines.length > 0 &&
      p.svgLines.every(l => typeof l === 'string')
    ).map(p => ({
      id: p.id,
      name: typeof p.name === 'string' ? p.name : p.id,
      svgLines: p.svgLines,
      external: true,
    }));
  } catch (_) {
    return [];
  }
}

/** 合并后的全部宠物：内置优先，外部同 id 时覆盖（方便用户改内置造型） */
const PETS = (function buildAll() {
  const all = Object.assign({}, BUILTIN);
  const externals = parseExternalPetsFromArgv();
  for (const pet of externals) {
    all[pet.id] = pet;
  }
  return all;
})();

/** 列出所有可用宠物 id */
function listPetIds() {
  return Object.keys(PETS);
}

/** 按 id 取宠物定义，不存在返回 null */
function getPet(id) {
  return Object.prototype.hasOwnProperty.call(PETS, id) ? PETS[id] : null;
}

/**
 * 读取当前选中的宠物 id。
 * localStorage 不可用（隐私模式/异常）时静默回退到默认。
 */
function getActivePetId() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && getPet(raw)) return raw;
  } catch (_) { /* localStorage 不可用时走默认 */ }
  return DEFAULT_PET_ID;
}

/** 取当前选中宠物的定义 */
function getActivePet() {
  return getPet(getActivePetId()) || PETS[DEFAULT_PET_ID];
}

/**
 * 取当前选中宠物的 SVG 行数组（供 template.js 展开插入）。
 * 若宠物定义缺失或 svgLines 非法，回退到默认宠物，绝不返回 undefined，
 * 否则 template.js 的数组展开会抛错导致整个覆盖层渲染失败。
 */
function getActivePetSvgLines() {
  const pet = getActivePet();
  if (pet && Array.isArray(pet.svgLines) && pet.svgLines.length) {
    return pet.svgLines;
  }
  const fallback = PETS[DEFAULT_PET_ID];
  return Array.isArray(fallback.svgLines) ? fallback.svgLines : [];
}

/** 切换宠物（写 localStorage），返回是否成功 */
function setActivePetId(id) {
  if (!getPet(id)) return false;
  try {
    localStorage.setItem(STORAGE_KEY, id);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  PETS,
  BUILTIN,
  DEFAULT_PET_ID,
  STORAGE_KEY,
  ARG_NAME,
  listPetIds,
  getPet,
  getActivePetId,
  getActivePet,
  getActivePetSvgLines,
  setActivePetId,
  parseExternalPetsFromArgv,
};
