'use strict';
/**
 * 核心规则占位符兜底
 *
 * 背景事故：用户自定义提示词模板（lingya-prompt-templates.json 的 overrides）
 * 漏写了 {{CORE_RULE_REPORT}} 占位符。project-context 里 CORE_RULE_REPORT 属于
 * RESERVED_SECTION_KEYS，被排除在 {{PLUGIN_CUSTOM_SECTION}} 通用通道之外，
 * 于是 core-rules 插件注册的规则内容无处落地，被静默丢弃 —— 表现为
 * 「插件装好了、enabled=true、重新初始化项目也不生效」。
 *
 * 兜底策略：模板里缺哪个保留占位符，就把该段内容并入 {{PLUGIN_CUSTOM_SECTION}}。
 */

/**
 * @param {string} templateContent 当前生效的提示词模板
 * @param {string} pluginCustomSection 已收集的通用插件 section
 * @param {Object} reservedSections { CORE_RULE_REPORT: '...', ... }
 * @returns {string} 兜底后的 pluginCustomSection
 */
function applyCoreRuleFallback(templateContent, pluginCustomSection, reservedSections) {
  const tpl = typeof templateContent === 'string' ? templateContent : '';
  let custom = typeof pluginCustomSection === 'string' ? pluginCustomSection : '';
  // 模板里连通用通道都没有，并入也无处落地
  if (!tpl.includes('{{PLUGIN_CUSTOM_SECTION}}')) return custom;
  const merged = [];
  for (const [key, value] of Object.entries(reservedSections || {})) {
    if (typeof value !== 'string' || !value.trim()) continue;
    // 模板已有该占位符 → 内容会走专属通道，无需重复并入
    if (tpl.includes('{{' + key + '}}')) continue;
    merged.push(value.trim());
  }
  if (merged.length === 0) return custom;
  if (custom && custom.trim()) merged.unshift(custom.trim());
  return merged.join('\n\n');
}

module.exports = { applyCoreRuleFallback };
