/**
 * DSH 兼容层 - shim（CommonJS 版，移植自 cuckoo-code）
 *
 * 把 @deepseek-ai/dsh-tools 的 defineTool 转成 LingYa 工具描述。
 * 把 @deepseek-ai/* 的模块引用劫持到这个 shim（或万能 stub）。
 */

/** 万能空接口（stub）：Proxy 包装的函数——任何属性访问/调用/构造都返回新 stub，永不抛错 */
function makeStub(name) {
  const fn = function () { return p; };
  const p = new Proxy(fn, {
    get(_t, prop) {
      if (prop === 'then') return undefined;          // 避免被当 Promise
      if (prop === '__esModule') return false;
      if (prop === 'default') return p;
      if (prop === 'toString') return () => '[dsh-stub ' + name + ']';
      if (prop === Symbol.toPrimitive) return () => name;
      return makeStub(name + '.' + String(prop));
    },
    apply() { return p; },
    construct(_target, args) {
      // new XxxError(msg) 等场景：返回一个真 Error 实例（可 throw、有 message/name）
      const isErr = /Error$/.test(name);
      if (isErr) {
        const msg = (args && args[0] != null) ? String(args[0]) : name;
        const err = new Error(msg);
        err.name = name;
        if (args && args[1] != null) err.code = args[1];
        return err;
      }
      return p;
    },
  });
  return p;
}

/** 当前 DSH 运行时会话（由 loader 在加载插件前注入，用 globalThis 共享） */
function setDshSession(session) { globalThis.__dshSession = session; }
function getDshSession() { return globalThis.__dshSession || null; }

/** 把 DSH 的"值 schema"递归转成标准 JSON Schema（每层的 required:true 提取为该层 required 数组） */
function dshValueToJsonSchema(spec) {
  if (!spec || typeof spec !== 'object') return {};
  const t = spec.type || 'string';
  const node = { type: t === 'json' ? 'object' : t };
  if (spec.description) node.description = spec.description;
  if (spec.title) node.title = spec.title;
  if (spec.default !== undefined) node.default = spec.default;
  if (spec.examples !== undefined) node.examples = spec.examples;
  if (Array.isArray(spec.enum)) node.enum = spec.enum;
  if (spec.const !== undefined) node.const = spec.const;
  if (t === 'array') {
    node.items = spec.items ? dshValueToJsonSchema(spec.items) : {};
  } else if (t === 'object') {
    const inner = dshParamsToJsonSchema(spec.properties, spec.additionalProperties);
    node.properties = inner.properties;
    node.required = inner.required;
    node.additionalProperties = inner.additionalProperties;
  } else if (spec.oneOf) {
    node.oneOf = spec.oneOf.map((s) => dshValueToJsonSchema(s));
  }
  return node;
}

/** DSH 参数映射 → JSON Schema（隐式 open object；required 是每属性标注 → 提取为数组） */
function dshParamsToJsonSchema(params, additionalProperties) {
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(params || {})) {
    properties[key] = dshValueToJsonSchema(spec);
    if (spec && spec.required) required.push(key);
  }
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: additionalProperties !== false,
  };
}

/** 构造 exec：agent.session 用真会话，其余属性用 stub 兜底 */
function buildExec() {
  const base = { agent: { session: getDshSession() || makeStub('session') } };
  return new Proxy(base, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop === 'symbol') return undefined;
      return makeStub('exec.' + String(prop));
    },
  });
}

/** DSH defineTool → LingYa 工具描述 */
function defineTool(options) {
  if (!options || typeof options.name !== 'string' || !options.name) {
    throw new Error('defineTool: name 必须是非空字符串');
  }
  if (typeof options.description !== 'string') {
    throw new Error('defineTool(' + options.name + '): description 必须是字符串');
  }
  if (typeof options.execute !== 'function') {
    throw new Error('defineTool(' + options.name + '): execute 必须是函数');
  }
  return {
    name: options.name,
    description: options.description,
    parameters: dshParamsToJsonSchema(options.parameters),
    async execute(args, execOverride) {
      // execOverride 由 loader 注入（含真实 agent，供 agent 生命周期插件使用）
      const value = await options.execute(args || {}, execOverride || buildExec());
      // DSH 的 output.render 把值转成 ContentBlock[]；LingYa 工具返回字符串即可
      if (options.output && typeof options.output.render === 'function') {
        try {
          const blocks = options.output.render(args || {}, value);
          if (Array.isArray(blocks)) {
            return blocks.map((b) => (b && typeof b.text === 'string') ? b.text : '').join('');
          }
        } catch (_) { /* 回退 */ }
      }
      return typeof value === 'string' ? value : JSON.stringify(value);
    },
  };
}

/**
 * 极简 schemastery 实现（够用版）：
 * 支持 z.object / z.number / z.string / z.boolean / z.array / .default / .required / .description
 * schema 本身可调用（schemastery 约定：Config(config) 解析默认值）
 */
function makeSchema(def) {
  const fn = function (value) {
    if (def.type === 'object') {
      const out = {};
      const props = def.properties || {};
      for (const k in props) {
        if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
        const p = props[k];
        let v = (value && typeof value === 'object') ? value[k] : undefined;
        if (v === undefined) v = (typeof p._default === 'function') ? p._default() : p._default;
        if (v === undefined && p._required) throw new Error('schemastery: missing required field "' + k + '"');
        if (v !== undefined) out[k] = v;
      }
      // 保留传入的其他字段
      if (value && typeof value === 'object') { for (const k in value) if (!(k in out) && value[k] !== undefined) out[k] = value[k]; }
      return out;
    }
    if (value === undefined) return def._default;
    return value;
  };
  fn._type = def.type;
  fn._default = def._default;
  fn._required = def._required;
  fn._properties = def.properties;
  fn.default = (v) => { fn._default = v; return fn; };
  fn.required = () => { fn._required = true; return fn; };
  fn.description = () => fn;
  fn.optional = () => fn;
  fn.role = () => fn;
  fn.comment = () => fn;
  // 常见链式约束方法：只关心默认值解析，链式调用一律返回自身
  fn.step = () => fn;
  fn.min = () => fn;
  fn.max = () => fn;
  fn.length = () => fn;
  fn.pattern = () => fn;
  fn.range = () => fn;
  fn.unique = () => fn;
  fn.examples = () => fn;
  fn.hidden = () => fn;
  fn.label = () => fn;
  fn.set = () => fn;
  fn.alias = () => fn;
  return fn;
}

const z = {
  object(properties) { return makeSchema({ type: 'object', properties: properties || {} }); },
  number() { return makeSchema({ type: 'number' }); },
  string() { return makeSchema({ type: 'string' }); },
  boolean() { return makeSchema({ type: 'boolean' }); },
  any() { return makeSchema({ type: 'any' }); },
  array(inner) { return makeSchema({ type: 'array', inner }); },
  union(list) { return makeSchema({ type: 'union', list: list || [] }); },
  const(v) { return makeSchema({ type: 'const', value: v }); },
  literal(v) { return makeSchema({ type: 'const', value: v }); },
  // 常见 schemastery 类型别名
  natural() { return makeSchema({ type: 'number' }); },
  integer() { return makeSchema({ type: 'number' }); },
  date() { return makeSchema({ type: 'date' }); },
  dict(inner) { return makeSchema({ type: 'object', properties: {} }); },
  tuple(list) { return makeSchema({ type: 'array' }); },
  intersect(list) { return makeSchema({ type: 'object', properties: {} }); },
  transform() { return makeSchema({ type: 'any' }); },
  lazy(fn) { try { return typeof fn === 'function' ? fn() : makeSchema({ type: 'any' }); } catch (_) { return makeSchema({ type: 'any' }); } },
  is() { return () => true; },
  resolve() { return undefined; },
};

/** DSH cordis 的 Service 基类（简化占位） */
class Service {
  constructor(ctx, name) {
    this.ctx = ctx;
    this.name = name;
  }
}

module.exports = {
  default: z,
  __esModule: true,
  defineTool,
  dshParamsToJsonSchema,
  dshValueToJsonSchema,
  Service,
  makeStub,
  z,
  setDshSession,
  getDshSession,
};
// esbuild 在 platform=node 下用 node 模式 __toESM，总是令 default = 整个模块。
// 因此 import z from 'schemastery' 拿到的是 module.exports 本身 -> 把 z 的方法展开到顶层。
for (const _k of Object.keys(z)) {
  if (!(_k in module.exports)) module.exports[_k] = z[_k];
}
