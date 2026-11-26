# The opencode v2 surface we implement

> 中文版：[PROTOCOL.zh.md](PROTOCOL.zh.md)

**Source of truth, in order of authority:**

1. **The published OpenAPI spec** — <https://opencode.ai/v2/docs/api>, machine
   readable at <https://opencode.ai/v2/openapi.json> (OpenAPI 3.1.0). It
   documents **the `/api/*` plane itself**, which is the plane the TUI drives:
   every route implemented here appears there under the same path and
   `operationId` (`server.info`, `session.form.reply`, `permission.request.list`,
   `event.subscribe`, `session.message.list`, …). Check a shape here first.
2. `packages/tui/test/fixture/tui-client.ts` in the opencode v2 repository — the
   minimal server their own TUI tests accept. It is the floor: a route the spec
   marks experimental still has to keep the fixture working.
3. The TUI's own generated client (`packages/protocol/src/groups/*.ts`,
   `packages/client/src/effect/generated/client.ts`) — the spelling the running
   TUI actually uses **where it differs from the spec**. One such difference is
   known, and both spellings are served: the spec calls the pending-forms list
   `form.list` at `GET /api/form`, while the TUI's client calls
   `form.request.list` at `GET /api/form/request`.

> **Correction.** This section used to say the surface was
> undocumented, that the fixture was the only authority, and it warned about an
> SDK `/session` plane distinct from the TUI's `/api/*` plane. That was wrong:
> the plane is published (see 1), and every route below has since been re-checked
> against it. The rule now is — **the spec wins**; and where the *TUI* disagrees
> with the spec, serve both spellings, as we do for the forms list.
>
> **How this is checked.** `python3 scripts/check-openapi.py --spec openapi.json`
> drives the real server against the fake agent and validates every response body
> against the spec's schema (52 probes; needs `jsonschema`). It reports `PASS`,
> `NOTE` for a deliberate difference, or `FAIL`. Its `ALLOWED` table *is* the
> register of deliberate differences, and each entry says why.
>
> It reports 32 pass, 20 deliberate notes and **0 failures**. The
> differences that remain, and why:
>
> | Difference | Why it stays |
> |---|---|
> | session routes carry a `location` sibling the spec does not list | the client reads `.location` off these bodies (see the route table) |
> | `/api/provider` entries keep `models` | the model picker groups by it |
> | `Shell.Info` keeps `output` | we poll output on its own route; the field rides along |
> | `/api/form/request` beside the spec's `/api/form` | the TUI's own client calls the former |
> | `/api/project/current`, `/api/session/:id/form/:id/state`, `/api/session/:id/terminal`, `/api/session/:id/todo` | served but not in the spec; the last two answer empty because v2 has no such surface |
> | `session.message.list` items and `session.message.get` | ✓ **fixed**: both serve the spec's typed `Session.Message.Info` (user carries `text`, assistant carries `agent`/`model`/`content[text\|reasoning\|tool]`), projected by `src/project.ts`, plus our `parts`/`role`/`sessionID` mirror. Measured with the real v2.0.27 TUI: **reloading a session now renders both rows** (`scripts/e2e-real-tui.sh`), where it used to render nothing |
>
> Anything not in that table is a bug if it disagrees with the spec.

## Session identity: two ids, and neither is derived from the other

The id the TUI shows is the **bridge's** session id; the ACP agent has its own.
That is not an accident of implementation — the client asks `POST /api/session` for
a session, and the party playing *server* answers with an id. Native opencode v2 can
return its own id because the server *is* the agent's host; here the agent sits
behind us, so there are two identities and they must be mapped.

How this is actually handled, and why it is not what I first designed:

1. **A launcher can choose the id, and it is honoured verbatim.** A launcher that
   knows the *agent's* session id can pass it in (a launcher that already knows it
   does, with `-s`), and `createSession` uses it as given (`state.ts`:
   `const id = requestedId ?? this.newId('ses')`). The agent's own id is then what
   the TUI shows — not displayed as a derived value, adopted. Resume passes the
   same id back and the bridge hands it to `session/resume`.
2. **Sessions created in the TUI get the bridge's id.** Nothing is derived from the
   agent's id: at that moment the agent has not answered yet, and rewriting a
   primary id after the client has stored it would break the client's routing.
3. **The agent's id is reported alongside** as `acpSessionId` (on `/api/session`
   and `/api/session/:id`), so the pair is always discoverable.
4. **Either id resolves to the same session.** `State.get` falls back to matching
   `acpSessionId`, so a route or `--session` accepts whichever id was copied.
5. **`^ses` is a spec constraint, not a TUI one.** The published schema's session-id
   pattern is `^ses`; the TUI does not enforce it, which is why a launcher-supplied
   agent id (an agent's own store filename) works in practice. Keep that in mind before
   "fixing" an id that does not look like ours.

## Cancelling a turn

`POST /api/session/:id/interrupt` (the older client's spelling, `/abort`, is served
with the same body) answers `200 {"interrupted": boolean}` — `true` when a running
execution was actually interrupted, `false` for an idle no-op. Answering `204` here
is what made the real v2.0.27 TUI log `UnexpectedStatus: 204` as an unhandled
rejection on every cancel.

The gesture that triggers it is **Escape twice within five seconds** (the first
press only arms it: the footer goes from `esc interrupt` to `esc again to
interrupt`). Note also what ends the turn on the client side: its store flips a
session from `running` to `idle` on `session.execution.succeeded` / `.failed` /
`.interrupted` — **not** on `session.idle`, which it does not handle at all. It also
records which of the three it was, so the choice matters:

| The turn | We emit |
|---|---|
| finished normally | `session.execution.succeeded` |
| failed | `session.execution.failed` |
| the user cancelled it | `session.execution.interrupted` |

`session.execution.*` is not in the published OpenAPI at all (the spec models no
execution events), so the client is the authority for these three names.

Who decides "cancelled": **we do**. `/interrupt` and `/abort` set
`record.interruptRequested`, and that flag — not the agent's `stopReason` — picks
the interrupted outcome, because an agent that is cancelled while blocked on a
permission may still answer `end_turn`. An agent that reports
`stopReason: "cancelled"` by itself is honoured too.

## Event stream — `GET /api/event`

```
data: {"id":"evt_connected","type":"server.connected","data":{}}\n\n
```

The `server.connected` frame is the handshake; the client treats its absence as
"server not ready". Optional `Last-Event-ID` replays from the ring.

## Routes implemented

### Boot / identity

| Route | Response |
|---|---|
| `GET /api/info` | `{location, data:{healthy:true, version, pid}}` — **the client refuses to attach without this** |
| `GET /path` | `{home, state, config, worktree, directory}` |
| `GET /config` | `{}` |
| `GET /config/providers` | `{providers:{}, default:{}}` |
| `GET /provider` | `{all:[], default:{}, connected:[]}` |
| `GET /provider/auth`, `GET /mcp`, `GET /session/status` | `{}` |
| `GET /agent`, `/command`, `/formatter`, `/lsp`, `/experimental/workspace*` | `[]` |
| `GET /experimental/capabilities` | `{backgroundSubagents:false}` |
| `GET /experimental/console` | `{consoleManagedProviders:[], switchableOrgCount:0}` |

### Location / project / vcs

| Route | Response |
|---|---|
| `GET /api/location` | **bare** `{directory, project:{id,directory,canonical}}` — *not* the envelope |
| `GET /api/project/current` | `{id, directory}` |
| `GET /api/project` | `[]` |
| `GET /api/vcs` | `{location, data:{branch:{current, default}}}` |
| `GET /api/worktree`, `/api/worktree/refresh` | list / 204 |

> The client feeds `location.directory` and `project.canonical` straight into a
> path helper. Returning an array here crashes it with
> `The "to" property must be of type string, got undefined`.
>
> `workspaceID` is **deliberately absent** (the `location` getter in `src/server.ts` carries the
> note): the client keys every location-scoped catalog by
> `JSON.stringify([directory, workspaceID])`, and it asks without a workspace
> (`?location[directory]=...`). Inventing an id publishes a catalog under one key and looks it up
> under another, so **every list reads as empty**. Omitting it keeps both sides on
> `[directory, null]`.

### Sessions

| Route | Response |
|---|---|
| `GET /api/session` | `{location, data:[session], cursor:{}}` |
| `POST /api/session` | `{location, data: session}` + `session.created` event |
| `GET /api/session/active` | `{location, data:{sessionID: "idle"\|"running"}}` — a **map**, and it carries a location |
| `GET /api/session/:id` | `{location, data: session}` — the session needs `location`, `projectID`, `cost`, `tokens` |
| `PATCH /api/session/:id` | rename, **204**, + `session.updated` + `session.renamed` (the client declares `successStatus: 204, empty: true`) |
| `POST /api/session/:id/model` | forwards to ACP `session/set_config_option` |
| `GET /api/session/:id/message` | `{location, data:[message]}` |
| `GET /api/session/:id/message/:mid` | `{location, data:{info, parts}}` |
| `POST /api/session/:id/prompt` | placeholder assistant message; turn streams |
| `POST /api/session/:id/generate` | **503** `ServiceUnavailableError` — `/btw`; ACP has no side-question method that leaves the session untouched |
| `POST /api/session/:id/compact` | **409** `ConflictError` — `/compact`; ACP has no compaction method |
| `POST /api/session/:id/revert/stage` | **409** — `/undo`; ACP has no history-revert method |
| `DELETE /api/session/:id/revert` | **409** — `/redo`; same |
| `POST /api/session/:id/revert/commit` | **409** — committing an undo; same |
| `POST /api/session/:id/move` | 204 + `session.moved` — `/cd`. The target is validated like the official server (`Directory does not exist` / `Not a directory` → 400), the session is re-loaded over ACP with the new `cwd` (stable `session/load` takes one), and the event is what renders the "↳ Moved to" row and re-points the footer. **Durable**: the moved directory is written to the session map and read back on the next run's adoption, so a restart does not un-do it |
| `GET /api/experimental/session/:id/export` | `{location, data:{info, messages}}` — `/copy` and `/export`; the whole transcript as one object |
| `POST /api/location/reload` | 204 — `/reload`; the bridge's configuration is its process arguments, nothing to reload |
| `GET /api/skill` | `{location, data:[Skill.Info]}` — real skills scanned from the config skill/skills roots and the workspace's `.opencode/skill(s)`, so the `/skills` picker offers them; an attached skill is forwarded to the agent as an ACP resource link (`file://<SKILL.md>`), which the spec requires every agent to accept |
| `GET /api/fs/list` | `{location, data:[{path, type}]}` — real entries; the TUI's `/cd` completion lists directories through this, and an empty answer made Enter never submit |
| `POST /api/session/:id/background` | **400** — backgrounding blocking tools; no ACP surface |
| `POST /api/session/:id/synthetic` | **409** — injecting editor selection; no ACP surface |
| `POST /api/session/:id/fork` | **400** — `session/fork` is unstable and not advertised by the measured agents |
| `POST /api/experimental/session/:id/wait` | **204** — returns once the current turn is over (the bridge's own state) |
| `POST /api/session/:id/abort` | 204; `session/cancel`, then closes unfinished tool rows, answers pending permissions `cancelled`, settles pending forms as `cancel` |
| `GET /api/session/:id/todo` | `{location, data:[todo]}` |
| `GET /api/session/:id/inbox` | held prompts |
| `POST /api/session/:id/inbox/:iid/{steer,queue}` | 204 + `session.inbox.delivery.changed` |
| `DELETE /api/session/:id/inbox/:iid` | 204 + `session.inbox.cancelled` |
| `GET /api/session/:id/diff`, `/terminal` | `{location, data:[]}` |

> `config_option_update` is consumed. ACP sends the **complete** config state, so
> ours is replaced rather than merged (`AcpClient.applyConfigOptions`), and the
> update is intercepted in the listener in `src/server.ts` **before** the
> translator, which would otherwise log it as unknown and drop it. If the change
> moved the selected model, the TUI is moved with `session.model.selected` — the
> one event its store reads for this. The `session/set_config_option` reply also
> carries the complete state and is now stored, so dependent changes (a
> reasoning-effort option that follows the model) are reflected too.

### Models / agents

Derived from the ACP `session/new` configuration — an agent advertises models as
one option (`category: "model"`) grouped by provider, each value a JSON array
string `["provider","model"]`, reasoning effort as `thought_level`, and modes as
`category: "mode"` config options (or fallback ACP v1 `SessionModeState` `modes`).

| Route | Response |
|---|---|
| `GET /api/agent` | ACP `category: "mode"` (or `SessionModeState`) choices projected in the agent's canonical order as primary `Agent.Info` entries (inheriting the TUI's active theme colors), or one synthetic `primary` agent when the agent advertises no modes; **must not be empty** or the composer silently refuses to submit |
| `GET /api/agent/:agentID` | single `Agent.Info` matching `id`, or 404 |
| `GET /api/model` | `{location, data:[{id, modelID, providerID, name, capabilities, variants}]}` — `variants` is required (the client dereferences `info.variants.some`) |
| `GET /api/provider` | `{location, data:[{id, name, models}]}` |

### Shell (`!`)

| Route | Response |
|---|---|
| `GET /api/shell` | `{location, data:[ShellInfo]}` |
| `POST /api/shell` | runs `{command:{command, cwd?, timeout}}`; `{location, data: ShellInfo}` + `session.shell.started` |
| `GET /api/shell/:id` | one `ShellInfo` |
| `GET /api/shell/:id/output?cursor=N` | `{location, data:{output, cursor, size, truncated}}` — the TUI **polls** this |
| `DELETE /api/shell/:id` | 204 + `session.shell.ended` |

### Permissions

| Route | Response |
|---|---|
| `GET /api/permission/request` | `{location, data:[…]}` |
| `GET /api/session/:id/permission` | same, for one session |
| `POST /api/session/:id/permission/:rid/reply` | 204; accepts the TUI's `{reply:"once"\|"always"\|"reject"}`. **404** when the request is already answered, expired or cancelled by an interrupt — a terminal answer, so the dialog can recover instead of believing it replied |

**Route order matters**: this reply route must be registered *before*
`/api/session/:id(/.*)`, which would otherwise swallow it, answer 204, and leave
the ACP request pending forever.

### Forms (an agent's `elicitation/create`)

An ACP `elicitation/create` in form mode is shown through the TUI's own form
plane. The ACP request is `{sessionId, mode:"form", message, requestedSchema}`,
where `requestedSchema` is a flat JSON Schema; it becomes a `Form.Info`
(`{id, sessionID, title, fields[]}`, id carrying the `frm_` prefix, fields
non-empty). `string` (optionally an `enum` → options), `number`, `integer`,
`boolean` and an `array` of string enum (the TUI's `multiselect`) are renderable;
anything else is refused with JSON-RPC `-32602` rather than half-drawn.

Watch the envelope: the location-wide routes carry a location, the session ones
do not.

| Route | Response |
|---|---|
| `GET /api/form/request` | `{location, data:[Form.Info]}` — every pending form |
| `GET /api/form` | `{location, data:[Form.Info]}` — the same list |
| `GET /api/session/:id/form` | `{data:[Form.Info]}` — **not** the location envelope |
| `GET /api/session/:id/form/:formID` | `{data: Form.Info}` |
| `GET /api/session/:id/form/:formID/state` | `{data:{status:"pending"}}` |
| `POST /api/session/:id/form/:formID/reply` | body `{answer:{…}}`, 204 |
| `DELETE /api/session/:id/form/:formID` | 204 — **the shipped client's Esc-on-a-form** (spec-declared; optional `message` query). Unimplemented it fell to the generic 404: the form stayed open with a red "Error" and the agent's elicitation hung forever |
| `POST /api/session/:id/form/:formID/cancel` | 204 — the older spelling, kept for older clients |

An unknown or foreign `:formID` answers 404 `{error:"form not found"}`; a reply
whose `answer` is not an object answers 400. As with the permission reply route,
these are registered **before** the generic session matcher, which would
otherwise answer 204 and leave the agent's elicitation pending forever.

The user's answer becomes the `content` of an `accept`; dismissing the dialog
becomes `cancel`. `decline` has no control in this UI, so it is never sent.

### Not implemented (404 + logged)

pty, `/api/mcp` (the MCP server list), mcp connect/auth, provider oauth,
`/session/:id/{revert,unrevert,share,init,summarize,fork,command}`,
most `/tui/*`, `/log`, `/auth/:id`, `/find*`, `/file*`, `/experimental/tool*`.

Unknown `/api/*` reads answer a well-formed empty envelope rather than 404,
because the client dereferences `.location` off response bodies unconditionally.
The `[bridge] unhandled route: …` log line is still the real signal.

### Write requests whose body we do not consume

`POST /api/session/:id/agent` switches the session's ACP mode (via `session/set_config_option`
for `category: "mode"` or `session/set_mode` for `SessionModeState`, persisting the choice per
session in `SessionMap` so restored/resumed sessions keep it across restarts, and emitting
`session.agent.selected`); when the agent advertises no modes it answers 204 honestly.
The other "accepted but not implemented" session actions all answer 204, so the client does
not treat them as a fatal protocol error.

## What the TUI can and cannot do through this bridge

The TUI is a client of the HTTP surface above, so its feature list is exactly that surface —
not opencode v2's own daemon. Screen-level evidence is the `scripts/e2e-real-tui.sh` modes.

| TUI feature | Through this bridge | Evidence |
|---|---|---|
| Chat, streaming text, reasoning, tool cards | ✅ | history/replay modes |
| Queue a follow-up during a running turn | ✅ it waits (`N queued`) and runs after the turn; ACP cannot inject mid-turn | `MODE=queue` |
| Permission dialog | ✅ | `MODE=permission` |
| Elicitation form (`session/request_elicitation`) | ✅ | `MODE=form` |
| `!completion` shell | ✅ | `MODE=shell` |
| Model picker | ✅ when the agent exposes config options; otherwise the placeholder (`acp/default`) and no switch | `tests/session-catalog.test.ts` |
| Session list / switch / rename | ✅ | restore modes, patrol |
| Delete a session | ✅ locally; the agent's copy is deleted only if it advertises `sessionCapabilities.delete` | `session/delete` forwarding |
| Continue / `-c` / `-s` | ✅; history is replayed only if the agent supports `loadSession` | restore modes |
| Diff viewer | ✅ it reads `/api/session/:id/diff` | patrol `/diff` |
| Copy / export | ✅ | patrol `/copy`, `/export` |
| Fork | ❌ no stable ACP method; the unstable `session/fork` is not called (see ACP-MATRIX) | `/session/:id/fork` is not implemented |
| Compact / undo / redo / `btw` side question | ❌ with a **readable refusal** (declared 409/503), never `UnexpectedStatus` | `MODE=unsupported-verb` |
| Integrated terminal | ❌ `/terminal` answers an empty envelope; the TUI does not offer the panel in this context | patrol skips `/terminal` |
| MCP panel | ❌ this is not an MCP host; `/api/mcp` and the connect/auth routes are not implemented | [ACP-COMPAT.md](ACP-COMPAT.md) |
| Share | ❌ opencode v2 removed session sharing; the route is not implemented | PROTOCOL "Not implemented" |
| Provider / model list | 📖 **read-only** — projected from the agent's catalog (`GET /api/provider`, `/api/model`); the TUI cannot **create**, edit, or log in to a provider: providers belong to the agent's configuration | `modelCatalog`; `/api/integration` is empty |
| Provider login / oauth, `find`/`file` search, most `/tui/*` | ❌ not implemented; authentication belongs to the agent (its own `authMethods`) | same list |
| Autoupdate of the TUI | ❌ disabled by design (a silent version bump broke the bridge before) | `isolatedTuiRoots` in `src/index.ts` |
| Any other v2 client | not measured, and **not recommended yet**: the per-agent state roots are injected into the TUI we spawn, and no other client receives them | README «Other v2 clients — not yet» |

**One client serves one agent — and the TUI's tab layout is per agent.** The TUI's
`tabs.json` and its own db live under the isolated roots we hand it, and those roots are
now named after the agent command (`~/.opencode-acp-client/opencode/<slug>/`). A launch
with `dsh` therefore never restores an `opencode` tab: the TUI reads a different
`tabs.json`, so nothing has to be filtered in the tab bar. The bridge is the hard
boundary: a remembered session whose map entry names another agent is refused (404), and
`-s` says which agent owns it. The model catalog is then unambiguous — it is whatever the
launch agent advertises (the focus heuristic and the foreign-model ignore remain for
same-agent tabs).

**Where providers come from — and why there is no “add provider” button.** The TUI's
provider/model list is a **projection of the agent's catalog** (`GET /api/provider`
returns `modelCatalog.providers`; `/api/integration` is deliberately empty). The
provider/auth, oauth and `/auth/*` routes are not implemented, and the model picker
only chooses among what the agent advertises. **Do not expect to create, edit or log
in to a provider in this TUI** — that would be the TUI managing the agent's
credentials, which this bridge does not do. Add a provider in the agent instead
(opencode: `opencode auth login` or `~/.config/opencode/opencode.json`; dsh: the
profile's provider config; claude/codex: their own auth), restart, and the picker
will show it. Per-agent details: [AGENT-CAPABILITIES.md](AGENT-CAPABILITIES.md).

## Event names we emit

opencode v2 speaks a different vocabulary than v1. The TUI ignores v1's
`message.part.*` entirely, so both are emitted: v1 keeps the smoke harness
honest, v2 is what renders.

| Event | Payload |
|---|---|
| `server.connected` | `{}` |
| `session.created` / `session.updated` | `{session}` |
| `session.renamed` | `{sessionID, title}` — the only title frame the TUI's store reads |
| `model.updated` / `agent.updated` | `{}` + `location` — invalidates and re-syncs `/api/model` or `/api/agent` |
| `session.model.selected` | `{sessionID, model:{providerID, modelID}, previous?}` — also emitted when the *agent* moves the model |
| `session.agent.selected` | `{sessionID, agent, previous?}` — emitted on `/api/session/:id/agent` mode switch or agent-pushed mode change |
| `session.idle` / `session.status` | `{sessionID}` / `{sessionID, status}` |
| `session.usage.updated` | `{sessionID, cost, tokens}` |
| `session.step.started` | `{sessionID, assistantMessageID, agent, model}` — **the only event that creates the assistant row** |
| `session.execution.started` / `.succeeded` / `.failed` | `{sessionID}` |
| `session.text.started` / `.delta` / `.ended` | `{sessionID, assistantMessageID[, delta\|text]}` |
| `session.reasoning.started` / `.delta` / `.ended` | same |
| `session.tool.input.started` | `{sessionID, assistantMessageID, id, name}` — **creates the tool row** |
| `session.tool.input.delta` / `.ended` | `{…, delta}` / `{…, text}` |
| `session.tool.called` / `.success` / `.failed` | `{…, id, executed, …}` |
| `session.shell.started` / `.ended` | `{sessionID, shell[, output]}` |
| `session.inbox.enqueued` | `{sessionID, inboxID, item}` |
| `session.inbox.delivered` / `.cancelled` | `{sessionID, inboxID}` |
| `session.inbox.delivery.changed` | `{sessionID, inboxID, delivery}` |
| `message.updated` (v1) | `{sessionID, messageID, role?, completed?}` |
| `message.part.updated` (v1) | `{sessionID, messageID, part, time}` |
| `todo.updated` | **removed** — opencode v2 has no todo surface, see [ACP-COMPAT.md](ACP-COMPAT.md) |
| `permission.asked` | `{id, sessionID, action, resources}` |
| `permission.replied` | `{sessionID, requestID}` |
| `form.created` | `{form}` — a `Form.Info`; this is what makes the form UI appear |
| `form.replied` | `{id, sessionID, answer}` |
| `form.cancelled` | `{id, sessionID}` |
| `turn.wait` / `turn.idle` | `{sessionID}` |

> **`session.updated` is emitted but the TUI ignores it.** Verified against the
> client's store (`packages/client/src/solid/data.ts`): it has a case for
> `session.renamed` and **none** for `session.updated`. A rename — the TUI's
> `PATCH /api/session/:id`, or the agent's `session_info_update` — only reaches
> the sidebar through `session.renamed`, which is why both are emitted. An event
> nothing handles looks exactly like a working one in a log.

Two rules the client enforces silently (unchanged):

1. `session.text.*` and `session.tool.*` **edit** rows and drop the event when the
   row is missing. Only `session.step.started` and `session.tool.input.started`
   create rows, so they must be emitted first.
2. Every event carries `created`; the client stamps `time.created` from it.