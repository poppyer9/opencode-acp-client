# 能力矩阵 —— ACP v1 ↔ opencode v2 接口面

> English: [ACP-MATRIX.md](ACP-MATRIX.md)

ACP 一侧的来源是稳定版 schema **v1.25.0**
（[`schema.json`](https://github.com/agentclientprotocol/agent-client-protocol/releases/download/schema-v1.25.0/schema.json)、
[`meta.json`](https://github.com/agentclientprotocol/agent-client-protocol/releases/download/schema-v1.25.0/meta.json)）
以及 <https://agentclientprotocol.com/protocol/v1/schema> 上的方法参考。下面每个方法名都出自那里，
拼写一字不差。opencode v2 一侧见 [docs/PROTOCOL.zh.md](PROTOCOL.zh.md)；我们的实际应答由
`scripts/check-openapi.py` 与 `tests/routes.test.ts` 实测。

## ACP 版本：这个 client 实现了哪些

| 版本 | 状态 | 在这里意味着什么 |
|---|---|---|
| **v1 稳定版（1.25.0）** | 目标 | `initialize` 发 `protocolVersion: 1`；13 个 client→agent 方法、11 个 agent→client 回调 + `$/cancel_request`、14 个 `session/update` 变体（翻译 9 个）。本文件所有 ✅ 都按这份 schema 判定 |
| **unstable**（`schema.unstable.json`） | 选择性读取 | 读 `PromptResponse.usage`（opencode v2 唯一的用量上报，见 §4）。unstable 的**方法** `session/fork`、`providers/*`、`nes/*`、`session/set_model` **都不调用**：`set_model` 已移除，`fork` 即使 agent 宣告了也不用 |
| **v2（草案）** | 未实现 | v2 删掉 `session/load`、更换 update 词汇（`state_update`、upsert），并去掉 `fs/*` / `terminal/*`。本 client 只说 v1；只提供 v2 的 agent 不受支持。若将来要加，参考实现是 Zed 的 `v2.rs` |

用量在任何版本里都不受 capability 门控：`usage_update` 是 agent 随时可发的 update，`PromptResponse.usage` 是可选的。

### 客户端无法选择 session id

`NewSessionRequest` 没有 id 字段 —— 它的属性是 `{_meta, additionalDirectories, cwd, mcpServers}` ✓ ——
所以 id 由 **agent 生成** ✓，客户端只能事后得知 ✓。对 dsh 实测：`session/new` 带
`_meta: {sessionId: "ses_chosen_by_the_client"}` ✓，它回的仍是**它自己的 UUID** ✗ → 这个扩展也**不被采纳** ✓。

一个**自己拥有后端**的 client 可以做得更好 —— 它能在创建会话时自己命名 —— 这也是那些
"作为 agent 的一部分"而不是"agent 的客户端"的项目不需要这张表的原因；通用 ACP client 没有这种调用 ✓。

对本桥的后果 ✓：一个会话有**两个 id** ✓ —— 对外展示的那个（`ses_…` ✓）与 agent 自己的（`acpSessionId` ✓）。
**跨启动恢复**（记住的 tab 能显示历史 ✓）需要把两者关联起来 ✓，而 **ACP 没提供让两者相同的办法** ✗。
要么桥保存一张小的对应表 ✓，要么 **ACP 增加"客户端给会话命名"的能力**（提 RFD ✓，与"客户端设标题"那个问题同一结论 ✓）。
★ 障碍**不是 id 的形状** ✓：opencode v2 要求 `^ses` ✓，而 agent 的 id 是 UUID ✗。

## 本轮的 ACP 面改动与规范核对（核对过，不是凭记忆）

读自 release 本身 ✓：`meta.json` 里 `session_delete`、`session_new`、`session_load`、
`session_set_config_option` 都在 **stable** registry ✓，而 **`session_set_model` 两个 registry 都没有** ✗；
stable `schema.json` 里 `NewSessionRequest = {_meta, additionalDirectories, cwd, mcpServers}`（**`cwd` 必需** ✓）、
`NewSessionResponse = {_meta, configOptions, modes, sessionId}` ✓。

| 改动 | 结论 |
|---|---|
| `DELETE /api/session/:id` 转发 `session/delete` | **规范内** —— stable agent 方法 ✓ |
| 切模型发 agent 自己宣告的那个值 | **规范内** —— `SessionConfigOption` 自己的值 ✓ |
| 每会话 `cwd` | **规范内，而且规范要求**：`cwd` 是 `NewSessionRequest` 的**必需**字段 ✓。**已启用** ✓）：会话采用请求里指定的目录 ✓。TUI 指定的是它启动时所在目录 ✓（= 桥自己的目录 ✓，所以对它的行为不变 ✓）；程序化开的会话则指定它正在展示的那个目录 ✓|
| 不发 `additionalDirectories` | **规范内** —— 规范要求**只有** agent 宣告了 `sessionCapabilities.additionalDirectories` 才能发 ✓ |
| ★ 读 `session/new` 的 `models` | ✗ **规范里没有**：stable 与 unstable schema 的 `NewSessionResponse` 都没有这个属性 ✓。它是 **agent 扩展**（qwen ✓，以及调研里提到的 gemini/kimi ✓）。我们**只读不写** ✓，而且正是它让这三家的模型选择器能用 ✓；规范给的通道是 `configOptions` ✓。**在此登记为"刻意的、只读的偏离"** ✓。使用者于 决定：：**保留读取** ✓（去掉它那三家的选择器就是空的 ✗）。
  我们**从不写**它 ✓；长期正解在上游 —— 要么那些 agent 改走 `configOptions` ✓，要么 ACP 标准化一个模型列表（提 RFD ✓），
  这与"客户端设标题"那个问题得出的结论一致 ✓。 |
| `session/set_model` | 两个 registry 都没有 ✗（属于 unstable 面 ✓）。若要使用，**必须**放在规范给定的 capability 门控之后 ✓ |

## 1. 我们宣告了什么

`initialize` 只发下面这一项，别的一概不发
（[src/acp/capabilities.ts](../src/acp/capabilities.ts)）：

```json
{ "elicitation": { "form": {} } }
```

ACP 明确要求把这句话当作**完整声明**：*「Clients and Agents MUST treat all capabilities
omitted in the `initialize` request as UNSUPPORTED」*（规范原文；译文：**客户端与 agent 必须把
`initialize` 请求中省略的所有能力一律视为 UNSUPPORTED**）
（[initialization](https://agentclientprotocol.com/protocol/v1/initialization)）。所以 ACP v1 定义的
九个客户端能力，逐个落位如下：

| 客户端能力 | 我们宣告 | 原因 |
|---|---|---|
| `elicitation.form` | ✅ | 端到端实现：`elicitation/create` → `/api/form` + `form.created/replied/cancelled` |
| `elicitation.url` | ❌ | opencode v2 没有「打开这个 URL 并等待」的界面；而用表单去应答 url 请求是规范禁止的，所以我们改回 `-32602` |
| `fs.readTextFile`、`fs.writeTextFile` | ❌ | agent 就跑在同一台机器上、有自己的文件工具；再开第二套文件 API 只会让出问题的路径翻倍 |
| `terminal` | ❌ | 同理：终端归 agent 自己管。我们带理由地拒绝 `terminal/*` |
| `session.configOptions.boolean` | ❌ | 我们消费**模型**与**推理档位**配置项（见 §2），但布尔选项在 opencode v2 的界面上没有对应控件 |
| `session.compaction` | ❌ | opencode v2 没有压缩（compaction）界面 |
| `session.notices` | ❌ | 同理 —— `notice` 更新没有地方可放 |
| `auth.terminal` | ❌ | 我们从不调用 `authenticate`；已驱动过的 agent 也都不要求它（见 §2） |

## 2. 客户端 → agent（13 个方法）

| ACP 方法 | 我们 | 落在哪里 |
|---|---|---|
| `initialize` | ✅ | 就是上面的能力握手；agent 名字/模型喂给 `/api/agent` 与 `/api/model` |
| `session/new` | ✅ | `POST /api/session`（**提前**建，好让模型选择器在第一条 prompt 之前就有内容） |
| `session/prompt` | ✅ | `POST /api/session/:id/prompt`；HTTP 响应只是占位符，回合内容走 SSE |
| `session/cancel` | ✅ | `POST /api/session/:id/interrupt`（以及旧的 `/abort`）—— 而且**由我们自己**把回合标成 interrupted，不靠 agent 的 stop reason |
| `session/load` | ✅ | `--session <id>`；回放内容成为 transcript。门控在 **agent 的** `loadSession` 上，不是某个客户端能力 |
| `session/resume` | ✅ | 当 agent 宣告 `sessionCapabilities.resume` 时使用 |
| `session/list` | ✅ | `GET /api/session` 把带标题的 agent 会话导入为稳定的桥 `ses_…` 别名，保留 ACP id、标题与 `session/load` 路径；agent 未宣告 `sessionCapabilities.list` 时拒绝调用 |
| `session/set_config_option` | ✅ | 模型选择器与推理档位 → `session.model.selected`；响应里的**完整**配置状态会存下来，而不是做合并 |
| `session/set_mode` | ❌ | ACP 已废弃它、改用 config options（*「Dedicated session mode methods will be removed in a future version」*），而 config options 我们已经实现。`available_commands_update` / `current_mode_update` 只记日志、不渲染 |
| `session/close` | ❌ | 没有对应物：opencode v2 没有「关掉但保留」这种动词 |
| `session/delete` | ❌ | **故意不调** —— 它会真删 agent 的数据，而 opencode v2 自己的删除路由是使用者的决定 |
| `authenticate` | ❌ | 未实现。已驱动过的 agent 都不要求；真遇到要求的 agent，会**大声失败**而不是静默 |
| `logout` | ❌ | 同上，且由 agent 的 `auth.logout` 门控 |

## 3. agent → 客户端（11 个方法 + `$/cancel_request`）

下表有 13 行，是因为 `elicitation/create` 出现了两次 —— 它的 `form` 模式支持、`url` 模式不支持
—— 而这个区分对读者才是要紧的。

下表的「拒绝」是指**带理由的** JSON-RPC error，绝不是沉默：agent 卡在一个没人应答的回调上会**永久挂起**，
因为 ACP 对此没有超时。

| ACP 方法 | 我们的应答 | 它支撑什么 |
|---|---|---|
| `session/request_permission` | ✅ | 权限对话框：`permission.asked` → `/api/session/:id/permission/:rid/reply` → `permission.replied` |
| `session/update`（通知） | ✅（14 个变体，见 §4） | 屏幕上显示的一切 |
| `elicitation/create`（form） | ✅ | 表单流程，含 `cancel` |
| `elicitation/create`（url） | ⛔ `-32602` | 我们只宣告 `form`；用表单应答 url 请求是规范禁止的 |
| `elicitation/complete`（通知） | ✅ | 转成 `form.replied` |
| `fs/read_text_file` | ⛔ `-32601` | *「用 agent 自己的工具」* —— agent 自己就有文件访问能力 |
| `fs/write_text_file` | ⛔ `-32601` | 同上 |
| `terminal/create` | ⛔ `-32601` | 同理：终端归 agent 自己管 |
| `terminal/output` | ⛔ `-32601` | 同上 |
| `terminal/wait_for_exit` | ⛔ `-32601` | 同上 |
| `terminal/kill` | ⛔ `-32601` | 同上 |
| `terminal/release` | ⛔ `-32601` | 同上 |
| `$/cancel_request` | ⛔ `-32601` | 协议层面对**我们发出的**请求做取消；我们发的东西没有长到需要它，opencode v2 也没有对应动词 |

## 4. `session/update` 的 14 个变体

| 变体 | 我们 | 渲染成什么 |
|---|---|---|
| `agent_message_chunk` | ✅ | 助手文本（流式） |
| `agent_thought_chunk` | ✅ | 思考块 |
| `user_message_chunk` | ✅（空转） | 不渲染：用户那一行来自 prompt 本身 |
| `tool_call` | ✅ | 工具卡片（**创建那一行的就是它**） |
| `tool_call_update` | ✅ | 该卡片的输入、输出与终止状态 |
| `plan` | 🟡 只记日志 | opencode v2 **没有 todo 面**，所以计划无处可显示 |
| `usage_update` | ✅ | 助手行上的费用/token 字段（侧栏的上下文计量） |
| `session_info_update` | ✅ | 会话标题 |
| `config_option_update` | ✅ | 模型/能力选择器 |
| `available_commands_update` | 🟡 只记日志 | 没有对应界面 |
| `current_mode_update` | 🟡 只记日志 | mode 已废弃（见 §2） |
| `notice` | ❌ 不会到达 | agent 不会发它：我们没有宣告 `session.notices` |
| `compaction_update` | ❌ 不会到达 | agent 不会发它：我们没有宣告 `session.compaction` |
| `compaction_summary_chunk` | ❌ 不会到达 | 同上 |

### usage 上报：稳定字段 vs opencode v2 的 unstable 字段

稳定协议的上下文用量是通过 update 上报的：

```json
{ "sessionUpdate": "usage_update", "used": 1234, "size": 200000, "cost": { … } }
```

稳定 v1.25.0 的 `PromptResponse` 只有 `stopReason` + `_meta`，**没有 `usage`**。
**unstable** schema（`schema.unstable.json`）才给 `PromptResponse` 加了
`usage`：`{totalTokens, inputTokens, outputTokens, thoughtTokens, cachedReadTokens,
cachedWriteTokens}`，并明确标注"尚未进入规范、可能随时改/删"。

opencode v2 **只发**这个 unstable 的结果字段，从不发 `usage_update`（v2.0.32 实测）。
所以桥：

- 翻译稳定的 `usage_update`（`used` → tokens；`size` → 模型的 `limit.context`，也就是侧边栏百分比的除数；`cost` → 事件的 `cost`）；
- 在结束回合前读取 unstable 的 `PromptResponse.usage` 作为兜底
  （`recordPromptUsage`），让 opencode v2 的侧边栏与 footer 拿到 token。

| 来源 | ACP 字段 | 我们的 `tokens` 字段 |
|---|---|---|
| `usage_update` | `used` | `input` |
| `usage_update` | `size` | 模型的 `limit.context`（百分比的除数） |
| `usage_update` | `cost` | `cost`，仅 USD（其它币种不携带） |
| `PromptResponse.usage` | `inputTokens` | `input` |
| `PromptResponse.usage` | `outputTokens` | `output` |
| `PromptResponse.usage` | `thoughtTokens` | `reasoning` |
| `PromptResponse.usage` | `cachedReadTokens` | `cache.read` |
| `PromptResponse.usage` | `cachedWriteTokens` | `cache.write` |
| `PromptResponse.usage` | `totalTokens` | 忽略（客户端自己把各项相加） |

这是**客户端侧的兼容读取**：不向 agent 发送任何非规范字段、不宣告任何能力，字段是
可选的——agent 不再发它时丢的只是用量表，不是会话。因此记录在这里，而不当作稳定协议保证。

**明确取舍（桥不单独维护用量账本）：** `PromptResponse.usage` 会原样透传到
`session.step.ended`（单回合），并累加进 `record.session.tokens` 通过
`session.usage.updated` / `GET /api/session/:id` 上报——即便多步工具调用回合的总量超过
模型上下文窗口 `size` 也不丢弃。因为桥刻意不引入额外的持久化用量账本（只写 `sessions.json`），
若丢弃 `total > size` 会让 TUI 用量插件（如 `opencode-cache-hit` 及其 Timeline 日志）
静默丢失最重的回合；对应的取舍是：TUI 内置侧栏的上下文占比（读 `session.step.ended.tokens`）
在重回合结束后可能短暂显示 `>100%`，直到下一轮较小的回合完成。

## 5. agent 缺某个能力时，你会失去什么

| agent 缺少 | 仍然可用 | 不再可用 |
|---|---|---|
| `loadSession` | 新建会话、prompt、工具、权限 | `--session <id>` 仍能延续 agent 的上下文（它宣告了 `session/resume` 就走那条，否则新开一个 ACP 会话），但 **TUI 打开时 transcript 是空的** |
| 模型 config options | 其它一切 | 模型选择器显示占位模型（`acp/default`）—— `claude-agent-acp` 就是这样 |
| 权限支持 | 其它一切 | 没有对话框。agent 自行其是，没有东西需要你批准 |
| elicitation | 其它一切 | 没有表单。需要结构化输入的 agent 拿不到 |
| `promptCapabilities.image` | 文本 prompt | 图片附件（opencode v2 的输入框照样提供，但我们按 agent 能收的过滤） |
| `promptCapabilities.embeddedContext` | 其它一切 | 不会发送 `resource_link` 块 |
| `sessionCapabilities.list` | 本次运行里建过的会话 | `/api/session` 无法展示 agent 自己的列表 |
| `sessionCapabilities.resume` | 若宣告了 `session/load`，`--session` 仍可用 | 不做完整回放的续聊 |
| MCP 支持（`mcpCapabilities.*`） | 其它一切 | 没有东西可配：客户端不是 MCP 宿主，也不提供 MCP server 列表，所以侧栏的 MCP 区域永远是空的 |

## 6. 无法与 ACP 对齐的 opencode v2 接口面

这些是 opencode v2 自己的功能，ACP 没有对应物，所以我们回一个**格式正确的空信封**或一条**记了日志的 404**
—— 真 TUI 会把这些路由全都问一遍，然后照常继续（依据是它自己的请求日志）：

| opencode v2 路由 | 为什么没有东西可对齐 |
|---|---|
| `/api/mcp`、`/api/mcp/resource` | 在 ACP 里 MCP 是 **agent** 的事（`mcpServers` 在建会话时传给它）；客户端不是 MCP 宿主。`/api/mcp` **完全不提供**（只记日志的空信封），`/api/mcp/resource` 回空 |
| `/api/integration*`、provider OAuth | 登录流程属于**持有凭据的那一方** —— 在这里是 agent |
| `/api/skill`、`/api/command`、`/api/reference` | ACP 有 `available_commands_update`，我们只记日志；没有 skill/reference 这种概念 |
| `/api/fs/list` | 客户端侧的文件列表。ACP 的 `fs/*` 是**反方向**，而我们并不宣告它（见 §1） |
| `/api/vcs`、worktree 变更、revert/share | 编辑器功能，ACP 没有任何动词对应 |
| `/api/shell`、`/api/pty`、persistent PTY | opencode v2 自己的终端托管。在 ACP 里终端归 **agent**；`!` shell 模式走的是 opencode v2 的路由、单独实现（见 README 的状态表） |
| `/tui/*`、`/api/plugin`、`/api/experimental/*` | 界面内部或实验性端点 |

### 6.1 我们**故意**不发的，以及代价

对照 Zed（`crates/agent_servers/src/acp/v1.rs` 的 `client_capabilities_for_agent`）逐条定过。
每行都是一个决定，不是疏漏。

| ACP 面 | Zed | 我们 | 为什么 |
|---|---|---|---|
| `session/new` 的 `additionalDirectories` | 把每个 workspace 根都发过去 | **不发** | ACP 的多根 workspace 与 opencode v2 的模型不同；我们只发一个 `cwd` |
| `session.configOptions.boolean` | 宣告 | **不宣告** | 规范允许 agent 发 `type: "boolean"`，但 opencode v2 的选择器只认枚举型选项 |
| `session.notices` / `session.compaction` | 宣告 | **不宣告** | opencode v2 没有显示面（铁律 1：不宣告兑现不了的能力）|
| `interrupt` | 发 `session/cancel` 通知，再读 `stop_reason`（`Cancelled` → 已取消）| 同 | 一致 |

### 6.2 我们宣告的唯一 `_meta` 项：`terminal_output`

`CLIENT_CAPABILITIES` 带 `_meta: { terminal_output: true }`。它**不是** `terminal/*` 能力
（那是 agent→客户端的**方法**，仍未实现、仍未宣告，见 §1），而是 ACP 开放扩展对象里的一个键，
在任何工具运行之前的 `initialize` 里协商。

- **Zed 宣告的正是这个** —— `crates/agent_servers/src/acp/v1.rs` 的 `client_capabilities_for_agent`：
  `("terminal_output", true)`。
- **agent 据此分支** —— 有些 agent 保留
  `clientCaps._meta?.['terminal_output'] === true ? 'terminal_output' : 'terminal_output_delta'`。
  只有协商成功的那种形式才带**完成的命令输出**；不宣告，agent 发的是本桥不重组的 delta 方言，
  卡片上只剩 `rawOutput: {formatted_output, exit_code}`，渲染成一坨 JSON。
- **兑现它的路径** —— `toolOutput()` 先读 `_meta.terminal_output.data`（再 `_meta.terminal_output_delta.data`），
  都没有才退回 `rawOutput`。守卫测试：`tests/translate.test.ts`。
- **读 agent 的方式不等于读某一个 agent 的结构**：这是协商出来的键，不是某个 agent 的私有结构。

### 6.3 工具的 `rawInput` 是自由格式，而 TUI 读固定字段名

ACP 规定 `rawInput` 是"任何 JSON 值都接受"，`kind`（`read` / `edit` / `execute` / …）才是展示类别。
opencode v2 的 TUI 却按**它自己的**输入键来渲染：read/edit 行读 `input.path`，shell 行读 `input.command`。
一个 agent 用 `kind: "read"` 回 `{file_path: …}` **完全合规范**，却仍会被渲染成空的
`Preparing edit…` / `Reading file…` 行（在 v2.2.0 上对一个用 `file_path` 的 agent 实测过）。

我们用 **kind** 桥接，绝不用某个 agent 的字段名：对 `read`/`edit`/`delete`/`move`/`write`，
第一个像路径的值复制到 `path`；对 `execute`，第一个字符串复制到 `command`。
agent 发来的键永不被覆盖，没有 `kind` 就什么都不猜。守卫测试：`tests/translate.test.ts`。

## 7. 与 opencode v2 公开规范的**故意**差异

并非所有偏差都是缺口 —— 有些是客户端会读的**超集**。它们连同原因一起登记在
`scripts/check-openapi.py` 的 `ALLOWED` 表与 [docs/PROTOCOL.zh.md](PROTOCOL.zh.md) 里，而不是被无视。
例如：信封里的 `location` 保持为 `{directory}`；`parts` 与 typed message 的字段并存；
`/api/form` 与 `/api/form/request` **两种拼法都提供**；以及在 `/api/info` 旁边同时提供 `/api/health`
—— 因为客户端的健康探测端点在不同 release 之间搬过家。

这条兼容读取有两个边界，写清楚以免当成 bug：**百分比要等当前会话的模型是真实的目录条目**
才会出现（占位 `acp/default` 没有窗口），且 agent 的 `size` 要等下一次 `/api/model` 读取才会
进入目录。`cost` 会带到事件上；TUI 是否把它画出来取决于屏幕（`/stats`），不取决于桥。
