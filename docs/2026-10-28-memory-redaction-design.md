# 记忆出口脱敏设计

日期：2026-10-28
范围：LingYa 0.6.88 / 记忆出口层（不涉及存储结构变更）

## 一、问题

排查确认：LingYa 的全部元信息只能以「用户消息」形式发到网页端（无 system 角色）。
其中记忆系统有两条泄漏路径：

1. **索引注入**：`buildMemorySection()` 把全部 456 条记忆的 id/type/名称拼进 systemPrompt，
   逐字发送。其中包含"DeepSeek 封号真因""注入隐蔽性加固""邮箱注册协议逆向"等条目。
2. **正文回传**：`memoryList()` 返回全部记忆正文，实测 606,118 字符，
   一次性作为工具结果发回网页端；且可能触发压缩重试，再发一遍。

这两条让账号主动向平台广播"我在研究怎么对抗你"。

## 二、目标与非目标

**目标**
- 索引注入时，敏感条目不出现（id、名称都不出现）
- `memoryList()` 回传时，敏感条目不出现正文；整体输出有硬上限
- 本地存储、本地检索、AI 主动查证能力**不受影响**（记忆还在，只是不外发）

**非目标**
- 不改记忆存储结构（仍为单 JSON 文件）
- 不改 provider / 注入层（不在本次范围）
- 不做内容语义审查（不判断记忆"写得好不好"，只判断"能不能外发"）

## 三、核心设计：sensitive 标记

### 3.1 字段

每条记忆新增可选布尔字段 `sensitive`。缺省视为 `false`。

```js
{ id, type, name, content, tags, pinned, sensitive?: true }
```

不写 false，只在需要标记时写 true，保持存量数据零迁移。

### 3.2 判定：显式标记 + 默认规则

`isSensitive(memory)` 判定顺序：

1. `memory.sensitive === true` → 敏感（人工显式标记，最高优先级）
2. 否则跑 `DEFAULT_SENSITIVE_RULES` 关键词规则，命中任一 → 敏感

默认规则（匹配 name + content，忽略大小写）：

| 规则 | 命中示例 |
|---|---|
| `封号|封禁|被封` 且 `真因|根因|原因` | #418、#422 |
| `逆向` 且 `注册|协议|API|接口` | #443、#330 |
| `规避|绕过|对抗|隐蔽|伪装` 且 `检测|风控|指纹|平台` | #427、#425 |
| `模拟真人|去机器标记|行为指纹|bot 指纹` | #425、#422 |
| `toString 伪装|Symbol 幂等|注入隐蔽` | #427 |

**关键：规则要求「双词共现」，避免单关键词误伤。**
例如「番茄音乐自动发布」含"发布"但不含对抗语义 → 不命中。
「百度文库逆向」含"逆向"但不含"注册/协议/API/接口" → 不命中（属正常业务逆向）。

### 3.3 规则可配置

规则表放在 `src/main/memory-redaction.js`，导出 `DEFAULT_RULES` 与 `isSensitive()`。
后续发现漏判/误判，只改这一个文件，不动 memory-store 与 MemoryTool。

## 四、改造点

### 4.1 memory-store.js：索引过滤

`buildMemorySection(options)` 内两处：

```js
// 1) 选正文时排除敏感
const all = getAllMemories();
const safe = all.filter(m => !isSensitive(m));

// 2) 生成索引时用 safe，而非全部
const omitted = safe.filter(m => !selectedIds.has(m.id));
```

同时 **头部计数要改**：现在写「【长期记忆】共 N 条」，N 用 safe.length，
避免"456 条里只列 380 条"这种数字对不上、反被模型追问的破绽。

`buildMemorySectionMinimal` 同样处理（两处保持一致）。

### 4.2 MemoryTool.js：memoryList 过滤 + 截断

```js
async execute(params) {
  let list = memoryStore.getAllMemories()
    .filter(m => !isSensitive(m))        // 新增：过滤敏感
    .filter(m => !params.type || m.type === params.type);
  // ...拼行
  const text = lines.join('\n');
  return ToolResult.success(truncate(text, MAX_MEMORY_LIST_CHARS));  // 新增：硬上限
}
```

`MAX_MEMORY_LIST_CHARS = 60000`（约 6 万字符，是原来 606K 的 1/10）。
超限时截断并追加一行说明：`\n…（共 N 条，已截断，可用 type 参数筛选）`。

**为什么是 6 万而不是更小**：正常查询（按 type 筛选）通常几千字符；
全量查询会被截断但保留足够上下文。6 万字符约 4 万 token，接近但不超单次输入上限。

### 4.3 敏感条目仍可被人工查看

新增只读脚本 `tools/memory-janitor.js` 已有基础，加一个 `--audit-sensitive` 参数：
列出所有被判为敏感的记忆，供人工确认规则是否误伤。

**注意：这个脚本只在本地终端输出，不经过网页端。**

## 五、风险与边界

| 风险 | 处置 |
|---|---|
| 规则误伤正常记忆（如把「番茄发布」判敏感） | 双词共现 + `--audit-sensitive` 人工核对后再上线 |
| AI 发现记忆编号跳号而追问 | 头部计数改用 safe.length，索引本身连续 |
| 敏感记忆里的信息 AI 再也查不到 | 这是设计意图；如需使用，人工临时取消标记 |
| 只防了索引与 memoryList，没防 AI 主动复述 | 本次不解决，属提示词层，另案 |

## 六、验证

1. 单元测试：`isSensitive` 对 #418/#422/#425/#427/#443/#330 判 true；
   对 #60（番茄发布）、#147（抖音文案）、#290（AI音乐发布）判 false
2. 集成测试：`buildMemorySection()` 输出不含上述敏感条目的 id 与名称
3. 集成测试：`memoryList()` 输出长度 ≤ 60000，且不含敏感条目正文
4. 手工：`--audit-sensitive` 跑一遍，人工过目清单
