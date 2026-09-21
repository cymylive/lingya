/**
 * 工具调用解析：宽容 JSON 解析与修复
 * 由原 preload.js 拆分而来，逻辑保持不变。
 */

// ========== 工具调用解析与执行 ==========

/**
 * 尝试解析工具调用
 * 支持格式：
 * 1. 标准格式: {"toolName": "...", "params": {...}, "callId": "..."}
 * 2. 代码块格式: ```json {...} ``` 或 ```tool {...} ```
 * 3. 包含额外文本的混合内容
 */
/**
 * 宽容解析 JSON：先严格解析，失败后修复常见格式问题再解析
 * 常见问题：字符串值内未转义的换行、tab、引号（AI 生成的 JSON 经常忘记转义）
 */
/**
 * 宽容解析 JSON：先严格解析，失败后修复常见格式问题再解析
 * 常见问题：字符串值内未转义的换行、tab、引号（AI 生成的 JSON 经常忘记转义）
 * @param {string} str - 待解析的 JSON 字符串
 * @returns {Object|null} 解析后的对象，解析失败返回 null
 */
function parseJsonWithRepair(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch (e) {
    // 修复：把字符串值内裸的换行/tab 转义为 \n \t
    const repaired = repairJsonString(str);
    try {
      return JSON.parse(repaired);
    } catch (e2) {
      return null;
    }
  }
}

/**
 * 修复 JSON 字符串：逐字符扫描，把字符串值内的裸换行、\r、\t 转义，
 * 并把明显是内容而非边界的裸引号转义为 \"
 */
function repairJsonString(str) {
  let result = '';
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (escapeNext) {
      result += ch;
      escapeNext = false;
      continue;
    }

    if (ch === '\\') {
      result += ch;
      escapeNext = true;
      continue;
    }

    if (ch === '"') {
      if (inString) {
        // 字符串内遇到的引号：判断是边界还是内容
        const nextChar = str[i + 1];
        const prevChar = result[result.length - 1] || '';
        const isBoundary = nextChar === ':' || nextChar === ',' || nextChar === '}' || nextChar === ']' ||
          nextChar === undefined || /[\s]/.test(nextChar || '') ||
          prevChar === ':' || prevChar === ',' || prevChar === '{' || prevChar === '[';
        if (isBoundary) {
          // 字符串结束边界
          inString = false;
          result += '"';
        } else {
          // 内容里的引号，转义
          result += '\\"';
        }
      } else {
        inString = true;
        result += '"';
      }
      continue;
    }

    if (inString) {
      // 字符串值内的裸控制字符 → 转义
      if (ch === '\n') { result += '\\n'; continue; }
      if (ch === '\r') { result += '\\r'; continue; }
      if (ch === '\t') { result += '\\t'; continue; }
    }

    result += ch;
  }

  return result;
}

function tryParseToolCall(content) {
  if (!content || typeof content !== 'string') return null;
  const str = content.trim();

  let parsed = null;

  // 1. 尝试直接解析 JSON（纯 JSON 响应，含容错修复）
  parsed = parseJsonWithRepair(str);

  // 2. 提取代码块 ```json/tool ... ```
  if (!parsed) {
    const codeBlockMatch = str.match(/```(?:json|tool)?\s*\n?(\{[\s\S]*?\})\s*```/);
    if (codeBlockMatch) {
      const extracted = codeBlockMatch[1].trim();
      parsed = parseJsonWithRepair(extracted);
    }
  }

  // 3. 在文本中查找 JSON 对象（取第一个完整的 { ... }）
  if (!parsed) {
    const firstBrace = str.indexOf('{');
    if (firstBrace !== -1) {
      const candidate = extractJsonObject(str, firstBrace);
      if (candidate) {
        parsed = parseJsonWithRepair(candidate);
      }
    }
  }

  if (!parsed) {
    return null;
  }

  // 支持多种字段名：toolName/tool, params/parameters/arguments
  if (!parsed.toolName && !parsed.tool) {
    console.log('[LingYa] 缺少 toolName/tool 字段, 完整对象:', JSON.stringify(parsed));
    return null;
  }

  // 标准化输出
  const result = {
    toolName: parsed.toolName || parsed.tool,
    params: parsed.params || parsed.parameters || parsed.arguments || {},
    callId: parsed.callId || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  };
  console.log('[LingYa] ✅ 解析成功, toolName=' + result.toolName + ', params=' + JSON.stringify(result.params));
  return result;
}


/**
 * 从文本中提取完整的 JSON 对象字符串（从 startPos 的 { 开始）
 * 通过括号配对找到对应的 } 结束位置
 */
function extractJsonObject(str, startPos) {
  let braceCount = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = startPos; i < str.length; i++) {
    const char = str[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') braceCount++;
      else if (char === '}') {
        braceCount--;
        if (braceCount === 0) {
          return str.substring(startPos, i + 1);
        }
      }
    }
  }

  // 括号未配对完成（流式输出未结束）
  return null;
}

module.exports = { parseJsonWithRepair, repairJsonString, tryParseToolCall, extractJsonObject };
