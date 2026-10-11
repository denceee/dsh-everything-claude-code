# Everything Claude Code · DSH 插件

[English](README.md) | 中文

把 [WorldFlowAI/everything-claude-code](https://github.com/WorldFlowAI/everything-claude-code)
（下称 ECC）适配成 DeepSeek Harness（DSH）插件，包含：

| 内容 | 数量 |
|---|---|
| 技能（skills） | 11 |
| 提示词（commands） | 15 |
| 角色（agents） | 9 |
| 规则（rules） | 8 |
| 上下文（contexts） | 3 |
| 钩子脚本 | 10 |
| 会话模式（agent preset） | 1 |

已在 DSH `0.2.0-rc.2`、`desktop` profile 上验证。

---

## 一、会话模式（Mode）

安装后，**新会话**的 Agent 预设选择器里会多出 **Everything Claude Code**，设置 →
Agent 预设里也能看到。选中它即启用 ECC 工作约定：

- **测试先行**：先写失败的测试，再写最小实现，然后重构；覆盖率目标 80%+
- **先验证再声称完成**：跑真实命令、读真实输出，绝不凭假设报成功
- **绝不硬编码密钥**：从环境变量读取，缺失就报错
- 不可变数据、小文件优先、每次改动做安全审查
- 提示模型按需加载 `tdd-workflow`、`verification-loop`、`security-review` 等技能

另含完整的工具面（文件、搜索、技能加载、计划模式、压缩、子代理委派、待办、联网）
和 `agent-instructions`，因此项目的 `AGENTS.md` 依旧生效。

**为什么用 preset 而不是全局挂载**：preset 是唯一能同时组合*人格 + 工具 + 上下文*的
座位。全局挂载会改变**每个**会话；preset 让单个会话按需开启。`order: 4`，排在官方
standard(1) / ptc(2) / minimal(3) 之后，所以它是"可选模式"而不是抢默认位。

---

## 二、设置页面

**设置** 里会多出 **Everything Claude Code** 一项，显示插件**实际发布**的内容：
11 个已注册技能、每个钩子的接入点与 matcher、资源统计、迁移说明、上游仓库链接。

- 默认**中文**，切换界面语言时页面**即时跟随**，无需刷新
- 数据来自 `GET /api/everything-claude-code/status`（在已鉴权的 `/api` 围栏内），
  统计值每次请求现读包目录，改文件后数字即变
- 只用宿主主题令牌 `--dsw-alias-*` 着色，**明暗主题都正常**

---

## 三、安装

```powershell
git clone https://github.com/<you>/dsh-everything-claude-code.git
```

然后用 DSH 的 `plugin_manager` 工具安装：

- `action: install_bundle`
- `target: <该目录的绝对路径>`

> `desktop` profile 由 Electron 应用独占管理，`dsh --profile desktop` 会被拒绝，
> 必须走 `plugin_manager`。

---

## 四、三个必须知道的坑

### 1. 阻断必须用 `permissionDecision`，不能用 exit 2

Claude Code 文档和 `dsh-hook-protocol` 源码都写着 exit 2 → block，但在
DSH `0.2.0-rc.2` 实测**拦不住**：钩子确实运行了、stderr 也写了原因，桥却把它记成
`exitCode: 1, decision: "pass"`，工具照常执行。

可用通道是 **stdout JSON + 退出码 0**：

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse",
 "permissionDecision":"deny","permissionDecisionReason":"…"}}
```

必须 exit 0——桥只在干净退出时解析结构化 stdout。

### 2. bundle patch 里 `baseUrl` 是 **profile 根目录**，不是 patch 所在目录

```yaml
# 错：解析成 <profile>/hooks/hooks.json（不存在），钩子静默全部失效
configPath: !!js "...new URL('hooks/hooks.json', baseUrl)"
# 对：锚定到被安装包
configPath: !!js "...new URL('node_modules/dsh-everything-claude-code/hooks/hooks.json', baseUrl)"
```

### 3. 首次新增 client 半端必须重启 DSH

`dsh-client-modules` 的 `pkgMeta` 是**只写一次的缓存，无失效路径**。若进程启动时包还
没声明 `dsh.client`，会被永久记成 `null`。之后改 `client.js` 可以热更新，但**第一次
出现**必须重启。

---

## 五、测试

```powershell
node tests/run-all.mjs
```

| 套件 | 项数 | 验证内容 |
|---|---|---|
| `hooks.test.mjs` | 18 | 每个钩子的决策符合本桥真正认的契约 |
| `preset.test.mjs` | 15 | preset 满足 schema，且写明 ECC 准则 |
| `client-bundle.test.mjs` | 14 | 浏览器工厂能加载、导出、渲染 |
| `status-payload.test.mjs` | 11 | 路由能应答，页面读的字段都存在 |
| `skills.test.mjs` | 9 | 每个技能符合真实 `dsh-skill` 语法 |
| `bridge-parse.test.mjs` | 7 | 没有事件或 matcher 被静默丢弃 |

诊断工具（读会话日志这一权威来源，不靠猜）：

```powershell
node tests/hook-timeline.mjs <session-dir>        # 每个 matcher 何时触发、决策为何
node tests/analyze-hook-decisions.mjs <dir>       # 决策与退出码分布
node tests/replay-hook.mjs <script.mjs> '<json>'  # 原始退出码 / stdout / stderr
```

> 会话日志是**多个 Zstandard 帧拼接**（实测一个日志 570 帧）。Node 的流式解码只返回
> 第一帧，会解出 1 条记录而误判"日志为空"。这些脚本逐帧解码。

---

## 六、已知缺失（不是"适配完成"）

1. **`PreCompact` / `SessionEnd` 未移植** —— 桥不支持这两个事件，ECC 的
   `memory-persistence` 记忆持久化能力**没有复现**。
2. **`Stop` 钩子只能警告、不能阻断** —— 桥永远报 `stop_hook_active: false`，
   无条件阻断会死循环。
3. ECC 的 slash command 在此是**提示词文档**（DSH 的 command 是人面向的，不进模型）；
   agent 定义是**角色提示词**（DSH 没有按文件注册子代理的机制）。

---

## 七、许可

MIT。上游 ECC 素材亦为 MIT，详见 [NOTICE](NOTICE)。
