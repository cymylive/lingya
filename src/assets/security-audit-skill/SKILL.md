---
name: security-audit
description: 安全审计与漏洞复查。适用于安全问答、定向代码审查、漏洞排查、完整安全审计或渗透测试。只有当用户明确要求"审计整个代码库/渗透测试/完整安全审查/出报告"时才走完整工作流，其余按指导模式只取相关部分。
---

# Security Audit（LingYa 适配版）

找出违反真实信任边界的漏洞，给出来源证据、安全的复现路径、优先级和最小有效修复。这是一套**防御性、源码优先**的流程。没有具体受影响主体、资源或安全后果的候选，不算确认漏洞。

> **本版说明**：原版 skill 由 Cloudflare 编写，设计前提是「支持并行 sub-agent + OS 级沙箱的 coding agent」。LingYa 是**单 agent、无沙箱**环境，因此本版做了适配：
> - 并行 hunter / 独立 verifier → **串行逐单元检查 + 换视角自检 + 间隔复核**
> - 沙箱内执行 → **一律不做**，需运行才能确立的结论标 `needs_validation`
> - 16 个攻击面知识文件**全部保留**，按需 read
>
> 适配后能力弱于原设计（缺少独立验证者），但知识库价值完整保留。凡是原版要求"独立 agent 复核"的，本版要求**至少换一种攻击视角重读一遍，并明确记录换的是什么视角**。

## 运行模式

本 skill 默认是**指导模式**。加载它不等于授权执行完整审计或写文件。

- **指导模式**：安全问答、定向审查、方法论咨询、单点排查。只取本 skill 的相关部分，不自动跑六阶段，不建输出目录，不写报告文件。需要时可以用 todoWrite 记录步骤。
- **完整审计模式**：用户明确要求"审计/渗透测试/完整安全审查/端到端复查/出报告"时启用。跑完整六阶段并写出报告文件。

需求模糊时，**先问一个聚焦问题**再决定是否创建文件或启动完整流程。

## LingYa 环境约束（与原版的差异）

| 原版要求 | LingYa 现状 | 本版处理 |
|---|---|---|
| 并行 sub-agent 做 hunter / verifier | 无 sub-agent 机制 | 串行逐单元；验证靠换视角 + 间隔复核 |
| OS 级沙箱执行 target code | 无沙箱 | **禁止执行目标代码**，需运行的结论标 `needs_validation` |
| Node 跑 `.cjs` 验证器 | ✅ 有 bash 工具 | 可以用 `node validate-findings.cjs` |
| 多文件引用 | ✅ read 可读同目录 | 按需 read 16 个知识文件 |

**必须遵守的硬边界**（无沙箱情况下的替代方案）：

1. **只读源码**。不执行目标项目的构建、测试、脚本、二进制
2. 不联网探测任何端点，不修改目标源码
3. 需要运行才能确立的结论 → 标 `needs_validation`，附上「需要什么沙箱能力才能验证」
4. 用 dummy 数据描述攻击路径，不碰真实凭据、生产环境、他人数据
5. 可以跑本 skill 自带的验证器（`validate-findings.cjs` / `validate-coverage-ledger.cjs`），这些是纯校验脚本，不执行目标代码

## 核心原则

### 必须同时有「边界」和「结果」

每条候选都要能说出：

- **低信任主体**：谁能发起
- **接受的输入或动作**：通过什么进入
- **本应存在的控制**：什么机制该挡住
- **被跨越的边界**：实际绕过了什么
- **受影响主体或资源**：谁受害
- **具体的可观察结果**：发生了什么

**不能**把「缺少最佳实践」「猜测的部署行为」「通用的解析器崩溃」「自己影响自己」提升为安全漏洞。

### 只用有界证据

静态分析确立源码路径。**LingYa 无沙箱，因此不做动态验证**——如果结论依赖运行时行为，标 `needs_validation` 并说明缺哪个事实。

### 尊重源码可见性

部署配置、代理行为、浏览器头、身份策略、broker ACL、打包方式、网络拓扑都是真实控制。**如果它们是必要条件但源码里没有，既不要假设存在，也不要假设不存在**——用 `needs_validation` 给出缺失的事实和安全的验证方案。

### 区分「优先级」和「确定性」

- 只有 `confirmed` 记录才有严重性
- `needs_validation` 是「源码支持的边界假设被某个未知事实卡住」，**不是低置信度的确认漏洞**，**没有严重性**
- 严重性锚点：
  - **critical** — 未认证攻击者获得代码执行、完整数据存储访问、任意账号接管
  - **high** — 完全击穿某个显式安全控制且后果真实：认证绕过、跨租户读写、存储型脚本执行、已认证代码执行、未认证远程停服
  - **medium** — 真实的边界违反，但影响范围有限、前置条件少见或后果局限于窄资源集
  - **low** — 非机密内部信息泄露，或需持续投入才换来极小收益
  - **informational** — 确认但影响极小，主要作为更大发现的组成部分

**high/medium 的分界线**：演示的结果是**完全击穿**了某个显式控制并造成真实后果，还是只**削弱**了它？说不出具体损害，严重性就比你感觉的低。

### 推荐最小有效修复

对每条确认发现，指出代码必须强制的不变式，以及在**最后一个可信决策点**上强制它的最窄改动。优先给具体的仓库相对路径改动和回归测试，而不是泛泛的加固建议。**审计只描述修复，不修改目标源码。**

## 完整审计工作流（单 agent 串行版）

用 `todoWrite` 建立六步计划并逐步推进，每步完成立刻更新状态：

### 第 1 步：侦察

读 [RECONNAISSANCE.md](RECONNAISSANCE.md)，产出：

- `architecture.md` — 架构、信任边界、输入面
- `coverage-ledger.json` — 确定性覆盖单元清单

建完后立刻跑：
```
node <skill目录>/validate-coverage-ledger.cjs <输出目录>/coverage-ledger.json
```

### 第 2 步：按覆盖清单逐单元检查（串行）

读 [HUNTING.md](HUNTING.md) 和 [ATTACK-CLASSES.md](ATTACK-CLASSES.md)，再按目标类型选读领域文件：

| 目标特征 | 读这个 |
|---|---|
| Web 前端 / 浏览器扩展 | [CLIENT-SIDE.md](CLIENT-SIDE.md) |
| HTTP 协议 / 认证 | [WEB-PROTOCOL-AND-AUTH.md](WEB-PROTOCOL-AND-AUTH.md) |
| LLM / Agent / 提示词 | [AI-AND-LLM.md](AI-AND-LLM.md) |
| Electron / 桌面 / 本地 IPC | [DESKTOP-MOBILE-AND-LOCAL-IPC.md](DESKTOP-MOBILE-AND-LOCAL-IPC.md) |
| 原生 / 二进制 / 内存安全 | [MEMORY-SAFETY-AND-BINARY.md](MEMORY-SAFETY-AND-BINARY.md) |
| 依赖 / CI / 发布 / 插件 | [SUPPLY-CHAIN-AND-RELEASE.md](SUPPLY-CHAIN-AND-RELEASE.md) |
| 云 / IaC / 容器 / 无服务器 | [CLOUD-AND-DEPLOYMENT.md](CLOUD-AND-DEPLOYMENT.md) |
| RPC / 队列 / webhook / 流 | [PROTOCOLS-RPC-AND-MESSAGING.md](PROTOCOLS-RPC-AND-MESSAGING.md) |
| 配额 / 资源耗尽 / 可用性 | [RESOURCE-EXHAUSTION-AND-AVAILABILITY.md](RESOURCE-EXHAUSTION-AND-AVAILABILITY.md) |
| 多租户 / 数据生命周期 | [DATA-ISOLATION-AND-LIFECYCLE.md](DATA-ISOLATION-AND-LIFECYCLE.md) |

**串行执行**：按 ledger 单元逐个检查，每个单元完成就更新 ledger 状态。**不要试图并行**——LingYa 没有 sub-agent。

每发现一个候选，记录：指纹（文件+行+根因）、边界六要素、证据路径。

### 第 3 步：候选验证（换视角自检）

读 [VALIDATION-AND-REPORTING.md](VALIDATION-AND-REPORTING.md)。

原版要求「交给全新的独立 verifier 试图反驳」。LingYa 没有独立 agent，**替代方案**：

对每个候选，**换一种攻击视角重新审视一遍**，并在记录里写明：

1. **换的是什么视角**（例：从「攻击者」换成「防御者」——这个控制真的不存在吗？从「入口」换成「出口」——即使进来，能出去吗？）
2. **试图反驳的三个问题**：
   - 上一层是否已有别的控制挡住了？
   - 这个「漏洞」是否需要攻击者已有不该有的权限？
   - 观察到的结果是真实损害，还是仅仅是「不符合最佳实践」？
3. **如果一个候选在换视角后站不住，降级或拒绝，并记录降级的理由**

**重要**：换视角自检的强度**低于**独立 agent 验证。报告中应如实说明这一点。

### 第 4 步：结构化输出

把 `confirmed` / `needs_validation` / `rejected` 三类记录写入 `findings.json`，然后：

```
node <skill目录>/validate-findings.cjs <输出目录>/findings.json
node <skill目录>/validate-coverage-ledger.cjs <输出目录>/coverage-ledger.json
```

两个验证器都必须通过。

### 第 5 步：记录复核（间隔重读）

对每条 `confirmed` 记录，**间隔一段时间后**（至少完成其他单元之后）重新读一遍相关源码，确认：

- 行号和代码没有因期间改动而失效
- 引用的事实仍然成立
- 没有把「当时看到的」和「现在看到的」搞混

**如果发现源码已变，退回第 3 步重新验证。**

### 第 6 步：报告中立化

从已验证记录和覆盖清单派生：

- `REPORT.md` — 概览与优先级
- `FINDINGS-DETAIL.md` — 每条确认发现的详情
- `NEEDS-VALIDATION.md` — 被卡住的假设与所需验证能力

**报告中不得包含针对真实环境的探测指令。**

### 终止条件

只有两种合法终态：

- (a) 第 6 步三个文件全部写出，两个验证器都通过
- (b) 记录 `run_status: "incomplete"` 及确切原因，并在报告中披露缺口

**不允许中途停止。**

## 反模式（看到就是做错了）

1. 把清单偏差当成漏洞
2. 没有可达边界违反的纵深防御建议
3. 在有界证据不足时去测真实或共享环境（**LingYa 里这条永远不成立——无沙箱就不执行**）
4. 猜测源码里没有的 provider / 代理 / 浏览器 / 身份 / 部署行为
5. 把同主体权限或自影响当成跨边界结果
6. 报告的解析器或运行时影响强于实际观察到的
7. 输出无法去重或验证的纯散文结果
8. 重复上报已确认的同源记录，或拿它们当锚点
9. 给 `needs_validation` 记录分配严重性
10. 在验证前写报告，或让散文和 JSON 互相矛盾
11. **（本版新增）** 声称做过独立验证，实际只是自己看了一遍
12. **（本版新增）** 在没有沙箱的情况下执行了目标代码

## 与原版的差异声明

本版把原版的「并行 sub-agent 编排」替换为「单 agent 串行 + 换视角自检 + 间隔复核」。这意味着：

- **覆盖广度**：单 agent 串行，一轮覆盖有限，建议多次运行（原版也说「单次运行约发现总量的一半」）
- **验证强度**：换视角自检弱于独立 agent 反驳，`confirmed` 的可信度低于原版
- **动态证据**：无沙箱，所有需运行时确立的结论一律 `needs_validation`

**报告里必须如实披露以上三点**，不得暗示达到了原版证据标准。
