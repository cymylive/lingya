/**
 * DSH 兼容层 - ctx.systemPrompt 提示词段注册表（CommonJS）
 *
 * 插件用 ctx.systemPrompt.section({ name, order, text }) 注册提示词段，
 * 这些段要合并进 LingYa 的系统提示词（{{TOOL_SECTIONS}} 或独立注入）。
 *
 * 模块级全局存储（project-context 读取时用同一份）。
 */

const sections = new Map();   // name -> { name, order, text, plugin }

/** 注册/覆盖一个提示词段（同名覆盖），返回 disposer */
function registerPromptSection(sec, pluginName) {
  if (!sec || typeof sec.name !== 'string') throw new Error('systemPrompt.section: name 必须是字符串');
  const entry = {
    name: sec.name,
    order: typeof sec.order === 'number' ? sec.order : 100,
    text: typeof sec.text === 'string' ? sec.text : '',
    plugin: pluginName,
  };
  sections.set(sec.name, entry);
  return () => { sections.delete(sec.name); };
}

/** 取所有提示词段（按 order 排序，再按 name） */
function getPromptSections() {
  return Array.from(sections.values()).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/** 拼接成可直接注入提示词的文本 */
function getFormattedPromptSections() {
  const list = getPromptSections();
  if (!list.length) return '';
  return list.map((s) => s.text).join('\n\n');
}

function clearPromptSections() { sections.clear(); }

module.exports = { registerPromptSection, getPromptSections, getFormattedPromptSections, clearPromptSections };
