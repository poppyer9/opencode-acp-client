# Capability matrix — ACP v1 ↔ the opencode v2 surface

> 中文版：[ACP-MATRIX.zh.md](ACP-MATRIX.zh.md)

Sources for the ACP side: the stable schema **v1.25.0**
([`schema.json`](https://github.com/agentclientprotocol/agent-client-protocol/releases/download/schema-v1.25.0/schema.json),
[`meta.json`](https://github.com/agentclientprotocol/agent-client-protocol/releases/download/schema-v1.25.0/meta.json))
and the method reference at <https://agentclientprotocol.com/protocol/v1/schema>. Every
method name below is from there, spelled exactly. The opencode v2 side is
[docs/PROTOCOL.md](PROTOCOL.md), and what we answer is measured by
`scripts/check-openapi.py` and `tests/routes.test.ts`.

## ACP versions: what this client implements

| Version | Status | What that means here |
|---|---|---|
| **v1 stable (1.25.0)** | the target | `initialize` sends `protocolVersion: 1`; 13 client→agent methods, 11 agent→client callbacks + `$/cancel_request`, 14 `session/update` variants (9 translated). Every ✅ in this file is judged against this schema |
| **unstable** (`schema.unstable.json`) | selectively consumed | `PromptResponse.usage` is read (opencode v2's only usage report — see §4). The unstable **methods** `session/fork`, `providers/*`, `nes/*`, `session/set_model` are **not called**: `set_model` was removed, and `fork` is not used even when an agent advertises it |
| **v2 (draft)** | not implemented | v2 removes `session/load`, changes the update vocabulary (`state_update`, upserts) and drops `fs/*` / `terminal/*`. This client speaks v1 only; an agent that offers only v2 is unsupported. Zed's `v2.rs` is the reference we would follow if we add it |

Usage is not capability-gated in any version: `usage_update` is an update an agent may send at
any time, and `PromptResponse.usage` is optional.

### A client cannot choose the session id

`NewSessionRequest` has no id field — its properties are `{_meta, additionalDirectories, cwd,
mcpServers}` — so the agent mints the id and the client can only learn it. Measured against
dsh: `session/new` with `_meta: {sessionId: "ses_chosen_by_the_client"}` came back with a
UUID of its own, so the extension is not honoured either.

A client that *owns* its backend can do better — it can name the session when it creates it —
which is why projects built as part of an agent rather than as a client of one do not need this
map. A generic ACP client has no such call.

Consequence for this bridge: a session has two ids, the one the client is shown (`ses_…`) and
the agent's own (`acpSessionId`). Cross-run resume — a remembered tab showing its history —
needs those two related, and ACP offers no way to make them the same. Either the bridge keeps
a small map between them, or ACP grows a way for a client to name a session (an RFD, the same
conclusion the client-side title question reached). The id shape is not the obstacle: the
opencode v2 surface requires `^ses` and the agent's ids are UUIDs.

The map also records **which agent command created the session**
(`agent: {command, args}`, argv and never a shell string). ACP has no notion of "this session
belongs to that agent" — `session/resume`/`load` take an id and nothing else — so a remembered
tab from another backend would otherwise be handed to whatever agent the current run launched:
measured, reopening an `opencode acp` session under `dsh --profile acp` gave an empty tab with
no explanation. A record adopted from such an entry is bound to its own agent and spawned when
the tab actually needs it. Entries written before the field existed are REFUSED (404):
their owner is unknown, and guessing the launching agent is how a dsh id ends up in
opencode v2 as an empty tab.
See [SESSION-LIFECYCLE.md](SESSION-LIFECYCLE.md) §1.2 and §7.

## Spec conformance of the changes made in this round (checked, not remembered)

Read from the release, not from habit: `meta.json` shows `session_delete`,
`session_new`, `session_load` and `session_set_config_option` in the **stable** agent
registry, and **`session_set_model` in neither registry**; the stable `schema.json` gives
`NewSessionRequest = {_meta, additionalDirectories, cwd, mcpServers}` with `cwd` **required**,
and `NewSessionResponse = {_meta, configOptions, modes, sessionId}`.

| change | verdict |
|---|---|
| `DELETE /api/session/:id` forwards `session/delete` | in spec — a stable agent method |
| A model switch sends the value the agent advertised | in spec — `SessionConfigOption`'s own value |
| Per-session `cwd` | in spec, and **required** by it: `cwd` is a mandatory `NewSessionRequest` field. **Enabled**: the session takes the directory the request names. The TUI names the directory it was started in (the bridge's own, so nothing changes for it); a session opened programmatically names whatever it is showing |
| `additionalDirectories` not sent | in spec — it MUST only be sent when the agent advertises `sessionCapabilities.additionalDirectories` |
| ★ reading `models` from `session/new` | **NOT in spec.** `NewSessionResponse` has no such property, in the stable schema or the unstable one. It is an agent extension (qwen, and per the ecosystem survey gemini and kimi). We read it and never write it, and it is what makes those three agents' model pickers work; the spec's own channel is `configOptions`. **Registered here as a deliberate, read-only deviation.** Keep reading it — dropping it
  empties those pickers. We never write it, and the
  long-term fix belongs upstream — either those agents publish models through
  `configOptions`, or ACP standardises a model list (an RFD), which is the same conclusion
  the client-side-title question reached. |
| `session/set_model` | not in either registry (it is an unstable-surface method). If used, it must sit behind the capability the spec gates it on. |

## 1. What we advertise

`initialize` sends exactly this, and nothing else
([src/acp/capabilities.ts](../src/acp/capabilities.ts)):

```json
{ "elicitation": { "form": {} } }
```

ACP is explicit that this is a complete statement: *"Clients and Agents MUST treat all
capabilities omitted in the `initialize` request as UNSUPPORTED"*
([initialization](https://agentclientprotocol.com/protocol/v1/initialization)). So the
nine client capabilities ACP v1 defines divide up like this:

| Client capability | We advertise | Why |
|---|---|---|
| `elicitation.form` | ✅ | Implemented end to end: `elicitation/create` → `/api/form` + `form.created/replied/cancelled` |
| `elicitation.url` | ❌ | opencode v2 has no surface for "open this URL and wait"; answering it with a form is forbidden, so we refuse with `-32602` instead |
| `fs.readTextFile`, `fs.writeTextFile` | ❌ | The agent runs on the same machine and has its own file tools; a second file API would double the paths that can go wrong |
| `terminal` | ❌ | Same: the agent owns its terminals. We refuse `terminal/*` with a reason |
| `session.configOptions.boolean` | ❌ | We consume the *model* and *reasoning* options (see §2), but a boolean option has no control in opencode v2's UI |
| `session.compaction` | ❌ | No compaction surface in opencode v2 |
| `session.notices` | ❌ | Same — `notice` updates would have nowhere to go |
| `auth.terminal` | ❌ | We never call `authenticate`; the agents we have driven do not ask for it (see §2) |

## 2. Client → agent (13 methods)

| ACP method | Ours | Where it lands |
|---|---|---|
| `initialize` | ✅ | The capability handshake above; agent name/model feed `/api/agent` and `/api/model` |
| `session/new` | ✅ | `POST /api/session` (eager, so the model picker is populated before the first prompt) |
| `session/prompt` | ✅ | `POST /api/session/:id/prompt`; the HTTP response is a placeholder, the turn arrives on SSE |
| `session/cancel` | ✅ | `POST /api/session/:id/interrupt` (and the legacy `/abort`) — and we mark the turn interrupted ourselves rather than trusting the stop reason |
| `session/load` | ✅ | `--session <id>`; the replay becomes the transcript. Gated by the **agent's** `loadSession`, not a client capability. An agent that advertises it and then fails is retried once, then the tab is re-titled `[new conversation] <dir>` (logged with the likely cause: another process holds the session) |
| `session/resume` | ✅ | Only when the agent advertises `sessionCapabilities.resume` |
| `session/list` | ✅ | `GET /api/session` imports titled agent sessions under stable bridge `ses_…` aliases, so their ACP id, title and `session/load` path remain available; refused if the agent does not advertise `sessionCapabilities.list` |
| `session/set_config_option` | ✅ | Model picker (`model`), reasoning effort (`thought_level`) → `session.model.selected`, and session mode (`mode`) → `/api/agent` + `POST /api/session/:id/agent` + `session.agent.selected` (persisted per session for resume stickiness); the response's **complete** config state is kept, not merged |
| `session/set_mode` | ✅ (fallback) | Used when an agent exposes legacy ACP v1 `SessionModeState` (`modes`) without a `category: "mode"` config option; otherwise `session/set_config_option` is preferred |
| `session/close` | ❌ | no counterpart: opencode v2 has no "close but keep" verb |
| `session/delete` | ❌ | Deliberately not called — it deletes the agent's data, and opencode v2's own delete route is the user's business |
| `authenticate` | ❌ | Not implemented. No agent we have driven requires it; an agent that does will fail loudly rather than silently |
| `logout` | ❌ | Same, and gated by the agent's `auth.logout` |

## 3. Agent → client (11 methods + `$/cancel_request`)

The table below has 13 rows because `elicitation/create` is listed twice — its `form`
mode is supported and its `url` mode is not — which is the distinction that matters to a
reader.

"Refused" below means a JSON-RPC error **with a reason**, never silence: an agent blocked
on a callback with no answer hangs forever, because ACP has no timeout for this.

| ACP method | Our answer | What it powers |
|---|---|---|
| `session/request_permission` | ✅ | The permission dialog: `permission.asked` → `/api/session/:id/permission/:rid/reply` → `permission.replied` |
| `session/update` (notification) | ✅ (14 variants, §4) | Everything the screen shows |
| `elicitation/create` (form) | ✅ | The form flow, including `cancel` |
| `elicitation/create` (url) | ⛔ `-32602` | We advertise `form` only; the spec forbids answering a url request with a form |
| `elicitation/complete` (notification) | ✅ | Forwarded as `form.replied` |
| `fs/read_text_file` | ⛔ `-32601` | *"use the agent's own tools"* — the agent has its own file access |
| `fs/write_text_file` | ⛔ `-32601` | Same |
| `terminal/create` | ⛔ `-32601` | Same: the agent owns its terminals |
| `terminal/output` | ⛔ `-32601` | Same |
| `terminal/wait_for_exit` | ⛔ `-32601` | Same |
| `terminal/kill` | ⛔ `-32601` | Same |
| `terminal/release` | ⛔ `-32601` | Same |
| `$/cancel_request` | ⛔ `-32601` | A protocol-level cancel of *our* request; nothing we send is long enough to need it, and opencode v2 has no such verb |

## 4. `session/update` — the 14 variants

| Variant | Ours | Rendered as |
|---|---|---|
| `agent_message_chunk` | ✅ | The assistant's text (streamed) |
| `agent_thought_chunk` | ✅ | The reasoning block |
| `user_message_chunk` | ✅ (no-op) | Nothing: the user's row comes from the prompt itself |
| `tool_call` | ✅ | A tool card (this is what creates the row) |
| `tool_call_update` | ✅ | Input, output, and the terminal state of that card |
| `plan` | 🟡 logged | opencode v2 has **no todo surface**, so the agent's plan has nowhere to display. |
| `usage_update` | ✅ | Cost/token fields on the assistant row (the sidebar's context meter) |
| `session_info_update` | ✅ | The session's title |
| `config_option_update` | ✅ | The model/capability picker |
| `available_commands_update` | 🟡 logged | No matching UI |
| `current_mode_update` | ✅ | Updates `session.agent` and emits `session.agent.selected` for agents sending legacy `SessionModeState` mode updates |
| `notice` | ❌ never arrives | The agent does not send it: we do not advertise `session.notices` |
| `compaction_update` | ❌ never arrives | The agent does not send it: we do not advertise `session.compaction` |
| `compaction_summary_chunk` | ❌ never arrives | Same |

### Usage reporting: stable field vs opencode v2's unstable one

The stable protocol reports context usage as an update:

```json
{ "sessionUpdate": "usage_update", "used": 1234, "size": 200000, "cost": { … } }
```

`PromptResponse` in stable v1.25.0 carries only `stopReason` + `_meta` — **no `usage`**.
The **unstable** schema (`schema.unstable.json`) adds `PromptResponse.usage` with
`{totalTokens, inputTokens, outputTokens, thoughtTokens, cachedReadTokens,
cachedWriteTokens}`, explicitly marked "not part of the spec yet".

opencode v2 sends **only** the unstable result field and never a `usage_update`
(measured on v2.0.32). The bridge therefore:

- translates the stable `usage_update` (`used` → tokens; `size` → the model's
  `limit.context`, which is what the sidebar's percentage divides by; `cost` → the
  event's `cost`), and
- reads the unstable `PromptResponse.usage` **before ending the turn** as a fallback
  (`recordPromptUsage`), so opencode v2's sidebar meter and footer get tokens.

| Source | ACP field | Our `tokens` field |
|---|---|---|
| `usage_update` | `used` | `input` |
| `usage_update` | `size` | model `limit.context` (the percentage's denominator) |
| `usage_update` | `cost` | `cost`, USD only (another currency is not carried) |
| `PromptResponse.usage` | `inputTokens` | `input` |
| `PromptResponse.usage` | `outputTokens` | `output` |
| `PromptResponse.usage` | `thoughtTokens` | `reasoning` |
| `PromptResponse.usage` | `cachedReadTokens` | `cache.read` |
| `PromptResponse.usage` | `cachedWriteTokens` | `cache.write` |
| `PromptResponse.usage` | `totalTokens` | ignored (the client sums the parts) |

This is a client-side compatibility read: nothing non-standard is sent to the agent,
no capability is claimed, and the field is optional — an agent that stops sending it
loses the meter, not the session. It is recorded here rather than treated as a
stable-protocol guarantee.

**Deliberate tradeoff (no bridge usage ledger):** `PromptResponse.usage` is forwarded
unfiltered on `session.step.ended` (per-turn) and accumulated into `record.session.tokens`
on `session.usage.updated` / `GET /api/session/:id`, even when a multi-step agentic turn's
sum exceeds the model's context window `size`. Because the bridge deliberately keeps no
separate persistent usage ledger (`sessions.json` only), dropping `total > size` turns
would silently erase the heaviest turns from TUI usage plugins (such as `opencode-cache-hit`
and its Timeline logs). The explicit tradeoff is that the TUI's built-in sidebar context
meter (which reads `session.step.ended.tokens`) may temporarily show `>100%` after a heavy
multi-step turn until the next smaller turn settles.

## 5. What you lose when an agent lacks something

| Agent lacks | What still works | What does not |
|---|---|---|
| `loadSession` | New sessions, prompts, tools, permissions | `--session <id>` still carries the agent's context over (it takes `session/resume` when the agent advertises it, and starts a new ACP session otherwise), but **the TUI opens with an empty transcript** |
| model config options | Everything else | The model picker shows the placeholder (`acp/default`) — this is what `claude-agent-acp` does |
| permission support | Everything else | No dialogs. The agent acts on its own; nothing to approve |
| elicitation | Everything else | No forms. Agents that need structured input cannot get it |
| `promptCapabilities.image` | Text prompts | Image attachments (opencode v2's composer still offers them; we filter what the agent cannot take) |
| `promptCapabilities.embeddedContext` | Everything else | `resource_link` blocks are not sent |
| `sessionCapabilities.list` | Sessions created in this run | `/api/session` cannot show the agent's own list |
| `sessionCapabilities.resume` | `--session` via `session/load`, if advertised | Resuming without a full replay |
| MCP support (`mcpCapabilities.*`) | Everything else | Nothing to configure: the client is not an MCP host and serves no MCP server list, so the sidebar's MCP section stays empty |

## 6. opencode v2 surface we cannot align with ACP

These are opencode v2's own features. ACP has no counterpart, so we answer a
well-formed empty envelope or a logged 404 — the real TUI asks for every one of these
and carries on (verified from its own request log):

| opencode v2 route(s) | Why there is nothing to align |
|---|---|
| `/api/mcp`, `/api/mcp/resource` | MCP is the *agent's* business in ACP (`mcpServers` is passed at session creation); the client is not an MCP host. `/api/mcp` is not served at all (a logged empty envelope), and `/api/mcp/resource` answers empty |
| `/api/integration*`, provider OAuth | Sign-in flows belong to whoever owns the credentials — here, the agent |
| `/api/skill`, `/api/command`, `/api/reference` | ACP has `available_commands_update`, which we log; there is no skill/reference concept |
| `/api/fs/list` | Client-side file listing. ACP's `fs/*` is the opposite direction, and we do not advertise it (§1) |
| `/api/vcs`, worktree mutation, revert/share | Editor features with no ACP verb |
| `/api/shell`, `/api/pty`, persistent PTY | opencode v2's own terminal hosting. In ACP the *agent* owns terminals; `!` shell mode goes through opencode v2's route and is implemented separately (see the README status table) |
| `/tui/*`, `/api/plugin`, `/api/experimental/*` | UI-internal or experimental endpoints |

### 6.1 What we deliberately do not send, and what that costs

Checked row by row against Zed (`crates/agent_servers/src/acp/v1.rs`, `client_capabilities_for_agent`).
Each row is a decision, not an oversight.

| ACP surface | Zed | Us | Why |
|---|---|---|---|
| `additionalDirectories` on `session/new` | sends every workspace root | **not sent** | ACP's multi-root workspace is a different model from opencode v2's; we send one `cwd` |
| `session.configOptions.boolean` | advertised | **not advertised** | The spec lets an agent emit `type: "boolean"`, but opencode v2's picker only reads enum options |
| `session.notices` / `session.compaction` | advertised | **not advertised** | opencode v2 has no surface for them (rule 1: never advertise what you cannot honour) |
| `interrupt` | sends the `session/cancel` notification, then reads `stop_reason` (`Cancelled` → cancelled) | same | identical |

### 6.2 The one `_meta` entry we announce: `terminal_output`

`CLIENT_CAPABILITIES` carries `_meta: { terminal_output: true }`. This is not the `terminal/*`
capability (those are agent→client **methods**, still unimplemented and still unannounced, §1); it is
an entry in ACP's open extension object, agreed during `initialize` before any tool runs.

- **Zed announces exactly this** — `crates/agent_servers/src/acp/v1.rs`,
  `client_capabilities_for_agent`: `("terminal_output", true)`.
- **Agents branch on it** — some agents keep
  `clientCaps._meta?.['terminal_output'] === true ? 'terminal_output' : 'terminal_output_delta'`.
  Only the agreed form carries the finished command text; without it the agent sends a delta dialect
  this bridge does not reassemble and leaves `rawOutput: {formatted_output, exit_code}` on the card,
  which rendered as a JSON blob.
- **The path that honours it** — `toolOutput()` reads `_meta.terminal_output.data` (then
  `_meta.terminal_output_delta.data`) before falling back to `rawOutput`. Guard:
  `tests/translate.test.ts`.
- **How we read an agent is not how we should read one agent**: this is a negotiated key, not a
  particular agent's private structure.

### 6.3 A tool's `rawInput` is free-form; the TUI reads fixed field names

ACP declares `rawInput` as "any JSON value is accepted", and `kind` (`read` / `edit` /
`execute` / …) as the presentation category. opencode v2's TUI renders those rows from
**its own** input keys instead: a read/edit row reads `input.path`, a shell row reads
`input.command`. An agent that answers `kind: "read"` with `{file_path: …}` is conformant
and still rendered as an empty `Preparing edit…` / `Reading file…` row (measured on
v2.2.0 against an agent whose file arguments are `file_path`).

We bridge it with the **kind**, never with a particular agent's field name: for
`read`/`edit`/`delete`/`move`/`write` the first value that looks like a path is copied to
`path`, and for `execute` the first string is copied to `command`. Keys the agent sent are
never overwritten, and nothing is guessed without a `kind`. Guard: `tests/translate.test.ts`.

## 7. Deliberate differences from opencode v2's published spec

Not every deviation is a gap — some are a superset the client reads. They are recorded,
with reasons, in `scripts/check-openapi.py`'s `ALLOWED` table and in
[docs/PROTOCOL.md](PROTOCOL.md), rather than ignored. Examples: the envelope `location`
kept as `{directory}`, `parts` riding alongside the typed message fields, both
`/api/form` and `/api/form/request` served, and `/api/health` served next to
`/api/info` because the client's health probe moved between releases.

Two limits of that compatibility read, stated so they are not mistaken for bugs: the
percentage only appears once the session's model is a real catalog entry (the
placeholder `acp/default` has no window), and the agent's `size` reaches the model
catalog on the next `/api/model` read. Cost is passed on the events; whether the TUI
draws it depends on the screen (`/stats`), not on the bridge.
