/**
 * cron 表达式解析（纯函数，无依赖）
 * 支持标准 5 字段：分 时 日 月 周
 * 每字段支持：*  a  a-b  a,b,c  *\/n  a-b\/n
 * 周：0-6（0=周日）
 */

/** 展开单个字段为数字集合 */
function expandField(field, min, max) {
  const set = new Set();
  for (const part of String(field).split(',')) {
    let step = 1;
    let range = part;
    const slash = part.indexOf('/');
    if (slash !== -1) {
      range = part.slice(0, slash);
      step = parseInt(part.slice(slash + 1), 10);
      if (!Number.isFinite(step) || step <= 0) step = 1;
    }
    let lo, hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.indexOf('-') !== -1) {
      const seg = range.split('-');
      lo = parseInt(seg[0], 10); hi = parseInt(seg[1], 10);
    } else {
      lo = hi = parseInt(range, 10);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    for (let i = lo; i <= hi; i += step) {
      if (i >= min && i <= max) set.add(i);
    }
  }
  return set;
}

/** 校验 5 字段 cron 是否合法 */
function isValidCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  for (let i = 0; i < 5; i++) {
    const set = expandField(parts[i], ranges[i][0], ranges[i][1]);
    if (set.size === 0) return false;
  }
  return true;
}

/** 判断某时刻是否命中 cron（分钟精度） */
function matches(expr, date) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minF, hourF, domF, monF, dowF] = parts;
  if (!expandField(minF, 0, 59).has(date.getMinutes())) return false;
  if (!expandField(hourF, 0, 23).has(date.getHours())) return false;
  if (!expandField(monF, 1, 12).has(date.getMonth() + 1)) return false;
  const domMatch = expandField(domF, 1, 31).has(date.getDate());
  const dowMatch = expandField(dowF, 0, 6).has(date.getDay());
  const domStar = domF === '*';
  const dowStar = dowF === '*';
  // 日/周都非 * 时按 OR（标准 cron 行为）
  if (!domStar && !dowStar) return domMatch || dowMatch;
  if (!domStar) return domMatch;
  if (!dowStar) return dowMatch;
  return true;
}

/** 简单模式 → cron：mode=daily 每天 / weekly 每周（weekday 0-6） */
function buildCron(mode, hour, minute, weekday) {
  const m = Number(minute) || 0;
  const h = Number(hour) || 0;
  if (mode === 'weekly') {
    return m + ' ' + h + ' * * ' + (Number(weekday) || 0);
  }
  return m + ' ' + h + ' * * *';
}

module.exports = { expandField, isValidCron, matches, buildCron };
