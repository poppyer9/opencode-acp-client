#!/usr/bin/env node
/**
 * A scriptable fake ACP agent, used by the unit tests and the e2e smoke.
 *
 * Configuration comes from env so a test can describe the agent it wants:
 *
 *   FAKE_ACP_CAPS_LOAD_SESSION=0     do not advertise session/load
 *   FAKE_ACP_CAPS_LIST_SESSIONS=1    advertise session/list and return a titled old session
 *   FAKE_ACP_CAPS_RESUME=1           advertise session/resume and accept it (reconnect
 *                                    WITHOUT replaying history — the backend's plain ACP
 *                                    profile: context continues, transcript starts empty)
 *   FAKE_ACP_RESUME_FAILS=1          advertise session/resume, then reject the call
 *   FAKE_ACP_RESUME_MODEL='["p","m"]' the model the resume RESPONSE reports (a restored
 *                                    session's own model — it can differ from session/new's)
 *   FAKE_ACP_CAPS_IMAGES=1           advertise image prompts
 *   FAKE_ACP_REPLY="hello"           text to stream back per prompt
 *   FAKE_ACP_CHUNKS="hel,lo"         stream in these chunks instead
 *   FAKE_ACP_THINKING=1              emit a reasoning chunk first
 *   FAKE_ACP_TOOL=1                  emit a tool_call + tool_call_update
 *   FAKE_ACP_PLAN=1                  emit a plan update (todos)
 *   FAKE_ACP_PERMISSION=allow|reject ask for permission and require an answer
 *   FAKE_ACP_HANG=1                  never answer session/prompt (timeout test)
 *   FAKE_ACP_HANG_TOOL=1             with HANG: a shell tool in flight, failed only AFTER the cancel
 *   FAKE_ACP_CALLBACK=fs/read_text_file   call back into the client
 *   FAKE_ACP_MODELS=1                session/new advertises a `model` config option
 *   FAKE_ACP_MODES=1                 session/new advertises a `mode` config option (`default|accept-edits|auto|plan`)
 *   FAKE_ACP_LEGACY_MODES=1          session/new/load/resume advertise ACP `modes` (`code|architect|ask`) + `session/set_mode`
 *   FAKE_ACP_MODE_IN_REPLY=1         include `[mode=<current>]` in prompt replies
 *   FAKE_ACP_MODE_UPDATE=<mode>      emit a `config_option_update` moving mode during a prompt
 *   FAKE_ACP_CURRENT_MODE_UPDATE=<m> emit a `current_mode_update` moving mode during a prompt
 *   FAKE_ACP_ADVERSARIAL_TOOL_ID=1   a tool call whose id looks like a content part (`reasoning:0`)
 *   FAKE_ACP_REPLAY_ON_LOAD=1        replay a message on session/load (a real agent replays what it
 *                                    recorded; without this an empty load makes "restored transcript"
 *                                    tests pass against nothing). Sent *before* the load response —
 *                                    the bridge stops collecting updates once that resolves
 *   FAKE_ACP_MODEL_UPDATE='["p","m2"]'  the agent moves the model itself
 *                                    (a `config_option_update`) once the prompt runs
 *   FAKE_ACP_TITLE="Some title"      the agent renames the session
 *                                    (a `session_info_update`)
 *   FAKE_ACP_ELICIT=1                ask the user something with
 *                                    `elicitation/create` (form mode) and stream
 *                                    the answer back as `ELICIT <json>`
 *   FAKE_ACP_ELICIT=url              ask in the mode we do NOT advertise; the
 *                                    refusal (`-32602`) is streamed the same way
 *   FAKE_ACP_GATE=<path>             pause mid-turn until the test creates `<path>`.
 *                                    This is the timing hook Zed's tests use channels for:
 *                                    send a frame, WAIT, let the test assert what the
 *                                    bridge did with it, then continue. Written as a file
 *                                    because the fake agent is a separate process.
 *   FAKE_ACP_GATE_TIMEOUT_MS=8000    how long to wait for the gate before giving up
 *
 * Newline-delimited JSON-RPC on stdio, exactly like a real ACP agent.
 */

import process from 'node:process'
import { spawn as spawnChild } from 'node:child_process'
import { existsSync, writeFileSync as writeChildPid } from 'node:fs'

// FAKE_ACP_SPAWN_CHILD=<pid file>: fork a helper that outlives a naive `child.kill`
// (the orphan shape), so a test can prove the client kills the whole process group.
if (process.env.FAKE_ACP_SPAWN_CHILD) {
  const helper = spawnChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  if (helper.pid) writeChildPid(process.env.FAKE_ACP_SPAWN_CHILD, String(helper.pid))
}


const SCENARIO = process.env.FAKE_ACP_SCENARIO ?? ''
// Applied before CAPS exists: that literal reads the capability switches at
// import time, so a scenario that turns one on must run first.
applyScenario()

const CAPS = {
  // The awkward case: the agent SAYS it can load a session, then fails to. Its
  // `session/load` handler already answers -32601, so advertising the capability is
  // all it takes to reproduce "promised, then did not deliver".
  loadSession:
    process.env.FAKE_ACP_CAPS_LOAD_SESSION === '1' || process.env.FAKE_ACP_LOAD_FAILS === '1',
  sessionCapabilities: (() => {
    const caps = {}
    if (process.env.FAKE_ACP_CAPS_LIST_SESSIONS === '1') caps.list = {}
    // `resume` is advertised independently of `list`: the backend's plain ACP
    // profile has resume+list+close and NO loadSession, which is the combination
    // every "restored tab comes up empty" report traces back to.
    if (process.env.FAKE_ACP_CAPS_RESUME === '1' || process.env.FAKE_ACP_RESUME_FAILS === '1') {
      caps.resume = {}
    }
    return Object.keys(caps).length > 0 ? caps : undefined
  })(),
  promptCapabilities: {
    image: process.env.FAKE_ACP_CAPS_IMAGES === '1',
    audio: false,
    embeddedContext: false,
  },
  // opencode's negotiated extension for a delegated run's own event stream.
  ...(process.env.FAKE_ACP_CAPS_CHILD_UPDATES === '1'
    ? { _meta: { 'opencode/child-session-updates': true } }
    : {}),
}

/** The model option `session/new` advertises when FAKE_ACP_MODELS=1. */
// `--model-only=model-2` narrows the catalog to one model, so two agents started with
// different flags offer different catalogs. That is what a mixed-agent session list needs:
// the bridge must serve the models of the tab's OWN agent, not another tab's.
const MODEL_ONLY = (process.argv.slice(2).find((arg) => arg.startsWith('--model-only=')) ?? '').replace(
  '--model-only=',
  '',
)

function modelOption(currentValue) {
  const all = [
    { value: '["fake","model-1"]', name: 'Fake One' },
    { value: '["fake","model-2"]', name: 'Fake Two' },
  ]
  const options = MODEL_ONLY ? all.filter((option) => option.value.includes(`"${MODEL_ONLY}"`)) : all
  return {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    // Only narrow the current value when the catalog itself was narrowed; otherwise keep
    // the caller's value (tests use it to simulate what a resume response reports).
    currentValue: MODEL_ONLY ? (options[0]?.value ?? currentValue) : currentValue,
    options,
  }
}

let buffer = ''
let nextSession = 0
// ── scenarios ───────────────────────────────────────────────────────────────
// A named scenario is one coherent set of behaviours, so a test can state what
// kind of agent it faces instead of assembling a dozen flags and hoping the
// combination is meaningful. The mapping only sets those same switches, so every
// flag still works on its own (existing scripts and tests depend on that).

function applyScenario() {
  switch (SCENARIO) {
    case 'rich-turn':
      process.env.FAKE_ACP_THINKING = '1'
      process.env.FAKE_ACP_TOOL = '1'
      break
    case 'images':
      process.env.FAKE_ACP_CAPS_IMAGES = '1'
      break
    case 'plan':
      process.env.FAKE_ACP_PLAN = '1'
      break
    case 'subagent':
      // A delegated agent, in the shapes the real adapters actually send (measured
      // 2026-11-06): dsh names the tool `subagent`, claude-agent-acp `Task`, codex-acp
      // verb-prefixes the title. The TUI draws its Subagent row only for `task`, so the
      // bridge maps these; the description is what the row shows beside it.
      process.env.FAKE_ACP_SUBAGENT ||= 'dsh'
      break
    case 'permission':
      process.env.FAKE_ACP_PERMISSION ||= 'allow'
      break
    case 'elicit-form':
      process.env.FAKE_ACP_ELICIT ||= 'form'
      break
    case 'slow':
      // Slow *chunk* delivery: the turn is visible and unfinished for a while,
      // which is the state the UI must show as working rather than as done.
      process.env.FAKE_ACP_DELAY_MS ||= '1200'
      break
    case 'title-and-model':
      process.env.FAKE_ACP_TITLE ||= 'Renamed by the scenario'
      // A decodable value: the client parses this option's choice into
      // {providerID, modelID}, so a bare '1' silently means "no model".
      process.env.FAKE_ACP_MODEL_UPDATE ||= '["fake","model-2"]'
      break
    // `tools-many`, `error-turn` and `hostile` are implemented in runPrompt,
    // because their whole point is the sequence of updates, not a flag.
    default:
      break
  }
}

const sessions = new Map()
// A hanging prompt is deliberately unresolved until the client sends session/cancel. Keeping
// the responder lets cancellation tests prove terminal cleanup without turning the fixture into
// a permanently leaked request.
const hangingPrompts = new Map()

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params })
}

/**
 * A delegated-run frame: `opencode acp`'s `opencode/session/child_update`, keyed by the
 * ROOT session the child was spawned from.
 */
function childUpdate(fields) {
  send({
    jsonrpc: '2.0',
    method: 'opencode/session/child_update',
    params: { rootSessionId: CURRENT_SESSION, parentSessionId: CURRENT_SESSION, depth: 1, ...fields },
  })
}

// `FAKE_ACP_EFFORT=1`: an agent that calls the reasoning-effort option `effort` — dsh's name.
// ★ NOT `thought_level`: dsh leaves the category off and names the option `effort`, so a
// fixture that set the category would let a name-blind check pass.
let effortValue = 'off'
function effortOption() {
  return {
    id: 'effort',
    name: 'Effort',
    category: 'other',
    type: 'select',
    currentValue: effortValue,
    options: [
      { value: 'off', name: 'off' },
      { value: 'high', name: 'high' },
      { value: 'max', name: 'max' },
    ],
  }
}

const VALID_MODES = ['default', 'accept-edits', 'auto', 'plan']
const VALID_LEGACY_MODES = ['code', 'architect', 'ask']

function defaultModeValue() {
  return process.env.FAKE_ACP_LEGACY_MODES === '1' && process.env.FAKE_ACP_MODES !== '1'
    ? 'code'
    : 'default'
}

function legacyModesState(currentModeId = defaultModeValue()) {
  return {
    currentModeId,
    availableModes: [
      { id: 'code', name: 'Code', description: 'Write and edit code.' },
      { id: 'architect', name: 'Architect', description: 'Design and plan changes.' },
      { id: 'ask', name: 'Ask' },
    ],
  }
}

function modeOption(currentValue = 'default') {
  return {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue,
    options: [
      { value: 'default', name: 'Default', description: 'Ask before edits and commands, per your permission settings.' },
      { value: 'accept-edits', name: 'Accept edits', description: 'Approve file edits in the workspace without asking.' },
      { value: 'auto', name: 'Auto', description: 'Approve edits and safe commands; ask before irreversible actions.' },
      { value: 'plan', name: 'Plan', description: 'Plan carefully before executing a task.' },
    ],
  }
}

function configOptionsFor(sessionId, overrides = {}) {
  const session = sessions.get(sessionId) ?? { model: '["fake","model-1"]', mode: defaultModeValue() }
  const model = overrides.model ?? session.model ?? '["fake","model-1"]'
  const mode = overrides.mode ?? session.mode ?? defaultModeValue()
  const list = []
  if (process.env.FAKE_ACP_MODELS_SUFFIXED === '1') {
    list.push({
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'suffixed-1',
      options: [
        { value: 'suffixed-1', name: 'Suffixed One' },
        { value: 'suffixed-2', name: 'Suffixed Two' },
      ],
    })
  } else if (process.env.FAKE_ACP_MODELS === '1') {
    list.push(modelOption(model))
    if (process.env.FAKE_ACP_EFFORT === '1') list.push(effortOption())
  }
  if (process.env.FAKE_ACP_MODES === '1') {
    list.push(modeOption(mode))
  }
  return list
}

function update(sessionId, u) {
  notify('session/update', { sessionId, update: u })
}

// Sessions whose first prompt the stale-prompt scenario rejected; a session/cancel
// clears them, which is what the bridge's recovery path relies on.
const staleCleared = new Set()

function chunksOf(text) {
  const configured = process.env.FAKE_ACP_CHUNKS
  if (configured) return configured.split(',')
  const size = Number(process.env.FAKE_ACP_CHUNK_SIZE ?? '0')
  if (!size) return [text]
  const out = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

/**
 * Block the turn until the test opens the gate.
 *
 * ACP has no notion of "now assert what the bridge did" — the fake agent can only be
 * observed through the frames it sends and the frames it receives. A gate file lets a test
 * do exactly what Zed's harness does with channels: send one frame, wait for the bridge to
 * react, assert, then release the next frame.
 */
async function gate(label) {
  const path = process.env.FAKE_ACP_GATE
  if (!path) return
  const marker = `${path}.${label}`
  const deadline = Date.now() + Number(process.env.FAKE_ACP_GATE_TIMEOUT_MS ?? 8000)
  while (!existsSync(marker)) {
    if (Date.now() > deadline) throw new Error(`fake agent: the test never opened gate ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function askPermission(sessionId, toolCallId) {
  const id = `perm-${toolCallId}`
  const answer = await new Promise((resolve) => {
    pendingRequests.set(id, resolve)
    send({
      jsonrpc: '2.0',
      id,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { toolCallId },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    })
  })
  return answer
}

async function callClient(method, params) {
  const id = `cb-${method}`
  return new Promise((resolve) => {
    pendingRequests.set(id, resolve)
    send({ jsonrpc: '2.0', id, method, params })
  })
}

const pendingRequests = new Map()
/** The session the current prompt runs on, so `childUpdate` can name its root. */
let CURRENT_SESSION = ''

async function runPrompt(sessionId, prompt) {
  CURRENT_SESSION = sessionId
  // dsh's shape: `tool_call.title` is the command itself ("bash all commands"), and
  // the command only arrives with the in_progress update. A bridge that publishes the
  // title as the row's program name renders the card as "Writing command…".
  if (process.env.FAKE_ACP_TOOL_TITLE_FIRST === '1') {
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-late', title: 'bash all commands', kind: 'execute', status: 'pending' })
    await new Promise((resolve) => setTimeout(resolve, 800))
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-late',
      status: 'in_progress',
      rawInput: { command: 'ls -la /tmp', cwd: '/tmp' },
    })
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-late',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'total 0' } }],
      rawOutput: { metadata: { status: 'completed', exit: 0 } },
    })
  }
  // A tool that streams its input, starts running, then reports failure — the shape
  // dsh's `Write` produces when the file vanished (FS_STALE_VERSION). The client must
  // stop every progress indicator on a failed tool, not only on a successful one.
  if (process.env.FAKE_ACP_TOOL_FAIL === '1') {
    const id = 'call-fail-write'
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: id, title: 'write', kind: 'edit', status: 'pending', rawInput: { path: 'build_fail.py' } })
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress', rawInput: { path: 'build_fail.py', content: 'print(1)\n' } })
    await new Promise((resolve) => setTimeout(resolve, 1500))
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: id,
      status: 'failed',
      rawInput: { path: 'build_fail.py', content: 'print(1)\n' },
      rawOutput: { error: '[tool error: FS_STALE_VERSION]' },
      content: [{ type: 'content', content: { type: 'text', text: '[tool error: FS_STALE_VERSION]' } }],
    })
    if (process.env.FAKE_ACP_TOOL_FAIL_CONTINUE) {
      await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_ACP_TOOL_FAIL_CONTINUE)))
      update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-after-fail', title: 'read', kind: 'read', status: 'pending', rawInput: { path: 'base.md' } })
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-after-fail', status: 'completed', rawInput: { path: 'base.md' }, content: [{ type: 'content', content: { type: 'text', text: 'base' } }] })
    }
  }
  const text = prompt
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')

  // The agent moving the session's own configuration: the spec says an update
  // carries the *complete* state, so this replaces the model/mode option wholesale.
  if (process.env.FAKE_ACP_MODEL_UPDATE) {
    const session = sessions.get(sessionId)
    if (session) session.model = process.env.FAKE_ACP_MODEL_UPDATE
    update(sessionId, {
      sessionUpdate: 'config_option_update',
      configOptions: configOptionsFor(sessionId, { model: process.env.FAKE_ACP_MODEL_UPDATE }),
    })
  }
  if (process.env.FAKE_ACP_MODE_UPDATE) {
    const session = sessions.get(sessionId)
    if (session) session.mode = process.env.FAKE_ACP_MODE_UPDATE
    update(sessionId, {
      sessionUpdate: 'config_option_update',
      configOptions: configOptionsFor(sessionId, { mode: process.env.FAKE_ACP_MODE_UPDATE }),
    })
  }
  if (process.env.FAKE_ACP_CURRENT_MODE_UPDATE) {
    const session = sessions.get(sessionId)
    if (session) session.mode = process.env.FAKE_ACP_CURRENT_MODE_UPDATE
    update(sessionId, {
      sessionUpdate: 'current_mode_update',
      currentModeId: process.env.FAKE_ACP_CURRENT_MODE_UPDATE,
    })
  }

  // The agent renaming the session. ACP carries this as `session_info_update`,
  // which is what a title plugin in the agent would send.
  if (process.env.FAKE_ACP_TITLE) {
    update(sessionId, { sessionUpdate: 'session_info_update', title: process.env.FAKE_ACP_TITLE })
  }

  // Ask the user something before answering. The answer is streamed back as
  // `ELICIT <json>` so an end-to-end check can see exactly what the client sent.
  // `FAKE_ACP_ELICIT=url` sends the mode we do NOT advertise, which must come
  // back as a JSON-RPC error rather than a half-served form.
  if (process.env.FAKE_ACP_ELICIT) {
    const urlMode = process.env.FAKE_ACP_ELICIT === 'url'
    const answer = await callClient(
      'elicitation/create',
      urlMode
        ? {
            sessionId,
            mode: 'url',
            elicitationId: 'fake-oauth',
            url: 'https://example.com/authorize',
            message: 'Please authorize access.',
          }
        : {
            sessionId,
            mode: 'form',
            message: 'Which strategy should I use?',
            requestedSchema: {
              type: 'object',
              properties: {
                strategy: { type: 'string', enum: ['conservative', 'balanced'], title: 'Strategy' },
                notes: { type: 'string', title: 'Notes' },
                extras: { type: 'array', items: { type: 'string', enum: ['fast', 'safe'] }, title: 'Extras' },
              },
              required: ['strategy'],
            },
          },
    )
    for (const chunk of chunksOf(`ELICIT ${JSON.stringify(answer)}`)) {
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } })
    }
  }

  if (process.env.FAKE_ACP_THINKING === '1') {
    for (const chunk of chunksOf('thinking…')) {
      update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: chunk } })
    }
  }

  if (process.env.FAKE_ACP_PERMISSION) {
    const answer = await askPermission(sessionId, 'call-1')
    const outcome = answer?.outcome
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'risky',
      kind: 'other',
      status: 'pending',
      rawInput: { danger: true },
    })
    const rejected = outcome?.outcome === 'cancelled' || outcome?.optionId === 'reject-once'
    // Report the outcome the client sent, so a test can prove the answer actually
    // reached the agent — not merely that the bridge emitted its own events.
    for (const chunk of chunksOf(`PERM ${JSON.stringify(answer?.outcome ?? null)}`)) {
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } })
    }
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: rejected ? 'failed' : 'completed',
      content: [{ type: 'content', content: { type: 'text', text: rejected ? 'rejected' : 'allowed' } }],
    })
    if (rejected) {
      return { stopReason: 'refusal' }
    }
  }

  // Gates around the tool block: a test can assert what the bridge published BEFORE the
  // call started and again while it is still open (see FAKE_ACP_GATE above).
  if (process.env.FAKE_ACP_GATE && process.env.FAKE_ACP_TOOL === '1') await gate('before-tool')
  if (process.env.FAKE_ACP_SUBAGENT) {
    const shape = process.env.FAKE_ACP_SUBAGENT
    const frame =
      shape === 'codex'
        ? { name: 'exec_command', title: 'Start subagent explorer', kind: 'other' }
        : shape === 'claude'
          ? { name: 'Task', title: 'List the files', kind: 'other' }
          : { name: 'subagent', title: 'subagent', kind: 'other' }
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-sub',
      status: 'in_progress',
      rawInput: { description: 'List files in current directory', prompt: 'ls' },
      ...frame,
    })
    if (process.env.FAKE_ACP_CAPS_CHILD_UPDATES === '1') {
      // A delegated run that reports its own activity: a tool call, then a status. The
      // bridge folds these into the card's caption and its `Background` badge.
      childUpdate({ childSessionId: 'child-1', title: 'explore', type: 'status', status: 'running' })
      childUpdate({
        childSessionId: 'child-1',
        title: 'explore',
        type: 'update',
        update: { sessionUpdate: 'tool_call', toolCallId: 'ct-1', name: 'grep', title: 'grep', kind: 'search' },
      })
    }
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-sub',
      status: 'completed',
      rawOutput: 'a.txt\nb.txt\n',
    })
    if (process.env.FAKE_ACP_CAPS_CHILD_UPDATES === '1' && process.env.FAKE_ACP_CHILD_STAYS_RUNNING !== '1') {
      childUpdate({ childSessionId: 'child-1', title: 'explore', type: 'status', status: 'completed' })
    }
  }

  if (process.env.FAKE_ACP_TOOL === '1') {
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-tool',
      title: 'echo',
      kind: 'other',
      status: 'in_progress',
      rawInput: { text },
    })
    if (process.env.FAKE_ACP_GATE) await gate('before-complete')
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-tool',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: `echo: ${text}` } }],
    })
  }

  if (process.env.FAKE_ACP_ADVERSARIAL_TOOL_ID === '1') {
    // An id shaped like a content-part id, which is exactly what the official TUI suite uses to
    // prove it classifies a live tool row by the *event* rather than by the id's shape
    // (`cli/tui/data.test.tsx:1069`, id `reasoning:0`). A bridge that keyed rows off the raw ACP
    // call id would leak that shape into the row id; ours maps it to its own part id.
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'reasoning:0',
      title: 'bash',
      kind: 'other',
      status: 'in_progress',
      rawInput: { command: 'echo adversarial' },
    })
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'reasoning:0',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'adversarial-output' } }],
    })
  }

  if (process.env.FAKE_ACP_PLAN === '1') {
    update(sessionId, {
      sessionUpdate: 'plan',
      // `PlanEntry` requires `priority` (schema v1), not only content+status. The SDK's
      // validation rejects an entry missing it, and then the client never gets to log the
      // thing this scenario is about.
      entries: [
        { content: 'first', status: 'completed', priority: 'high' },
        { content: 'second', status: 'in_progress', priority: 'medium' },
      ],
    })
  }

  if (process.env.FAKE_ACP_CALLBACK) {
    // Deliberately call something we never advertised, to prove the bridge
    // answers with an explicit error instead of leaving the agent hanging.
    const answer = await callClient(process.env.FAKE_ACP_CALLBACK, {
      sessionId,
      path: '/tmp/whatever',
    })
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `callback:${JSON.stringify(answer)}` },
    })
  }

  if (SCENARIO === 'usage') {
    // ACP reports context usage as {used, size}; the bridge normalises it.
    update(sessionId, {
      sessionUpdate: 'usage_update',
      used: 50000,
      size: 200000,
      cost: { amount: 0.05, currency: 'USD' },
    })
  }

  if (SCENARIO === 'long-output') {
    // A tool that returns a lot, and a reply delivered in many small chunks: this
    // is about the client's chunking and truncation paths, not about size itself.
    const big = Array.from({ length: 400 }, (_, i) => `line ${i}: ${'x'.repeat(80)}`).join('\n')
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-big',
      title: 'big-output',
      kind: 'other',
      status: 'in_progress',
      rawInput: { lines: 400 },
    })
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-big',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: big } }],
    })
    process.env.FAKE_ACP_CHUNK_SIZE ||= '17'
  }

  if (SCENARIO === 'interleaved') {
    // Thought, text, tool, thought, text: the projection must keep this order
    // rather than grouping by kind.
    update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'think one' } })
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'text one' } })
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-mid',
      title: 'echo-mid',
      kind: 'other',
      status: 'in_progress',
      rawInput: { step: 1 },
    })
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-mid',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'mid' } }],
    })
    update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'think two' } })
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'text two' } })
  }

  if (SCENARIO === 'slow') {
    // A pause *inside* the turn, so "still working" is observable.
    const delay = Number(process.env.FAKE_ACP_DELAY_MS ?? 1200)
    await new Promise((resolve) => setTimeout(resolve, delay))
  }

  if (SCENARIO === 'crash') {
    // The agent dies mid-turn, after the UI has something to show. The client
    // must settle the turn instead of leaving a spinner nobody will ever update.
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'about to die' } })
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-crash',
      title: 'echo-crash',
      kind: 'other',
      status: 'in_progress',
      rawInput: { n: 0 },
    })
    process.exit(1)
  }

  if (SCENARIO === 'tools-many') {
    // Three calls: one that succeeds, one that fails, and one the agent
    // deliberately leaves in progress when the turn ends. A client that does not
    // close the last one shows a spinner forever, which is the bug this exists to
    // catch.
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-ok',
      title: 'echo-ok',
      kind: 'other',
      status: 'in_progress',
      rawInput: { n: 1 },
    })
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-ok',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
    })
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-fail',
      title: 'echo-fail',
      kind: 'other',
      status: 'in_progress',
      rawInput: { n: 2 },
    })
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-fail',
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'boom' } }],
    })
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-open',
      title: 'echo-open',
      kind: 'other',
      status: 'in_progress',
      rawInput: { n: 3 },
    })
  }

  if (SCENARIO === 'error-turn') {
    // A turn that fails: the assistant said something, then the turn ends with
    // the failure stop reason rather than end_turn.
    for (const chunk of chunksOf('about to fail')) {
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } })
    }
    return { stopReason: 'error' }
  }

  if (SCENARIO === 'hostile') {
    // An agent that does everything the spec says it must not. The client is
    // required to log and carry on, never to crash and never to leave the turn
    // open.
    // `Notice` requires `severity` and `title` (schema v1); an earlier version sent
    // `{ message }`, which the SDK's validation rejects before the client can log it. The
    // shape here is the one the spec defines, so the scenario tests what it says it tests:
    // a WELL-FORMED notice that this client simply does not handle.
    update(sessionId, {
      sessionUpdate: 'notice',
      severity: 'warning',
      title: 'we never advertised notices',
    })
    // `CompactionUpdate` needs `compactionId` as well; see the notice note above.
    update(sessionId, { sessionUpdate: 'compaction_update', compactionId: 'cmp_1', status: 'started' })
    update(sessionId, { sessionUpdate: 'some_unknown_update_v9', payload: { nope: true } })
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'never-created',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'ghost' } }],
    })
    // ★ Every other frame here is deliberately ill-formed at the PROTOCOL-RULES level (an
    // update for a tool call that was never created, say) — but each one still has to be
    // schema-VALID, or the SDK's validation drops it before the client can log anything.
    // This one keeps its `content` for exactly that reason: the scenario is "the client
    // survives what the spec forbids", not "the client survives frames that are not ACP".
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'a chunk for a session the agent invented' },
    })
  }

  // Report what actually arrived, so a test can tell "the client forwarded the
  // attachment" from "the client quietly dropped it".
  const images = (Array.isArray(prompt) ? prompt : []).filter(
    (b) => b && b.type === 'image' && typeof b.data === 'string',
  ).length
  const reply =
    process.env.FAKE_ACP_ECHO_PROMPT === '1'
      ? // The prompt blocks, verbatim: lets a test prove a block (a resource link, an
        // image) really crossed the ACP wire, by reading it back from the reply.
        `ECHO ${JSON.stringify(prompt)}`
      : process.env.FAKE_ACP_REPLY ??
        `you said: ${text}${images > 0 ? ` images:${images}` : ''}` +
      // Where the agent believes the session runs. `session/new`/`session/load` both record
      // it, so a `/cd` acceptance can assert on screen that the re-load actually moved the
      // session — the bridge state alone would prove nothing about the agent.
      (process.env.FAKE_ACP_CWD_IN_REPLY === '1' ? ` (cwd: ${sessions.get(sessionId)?.cwd ?? 'unknown'})` : '') +
      (process.env.FAKE_ACP_MODE_IN_REPLY === '1' ? ` [mode=${sessions.get(sessionId)?.mode ?? defaultModeValue()}]` : '')
  for (const chunk of chunksOf(reply)) {
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } })
  }
  // A read tool that ENDS (completed) early in the turn. dsh's `read` reports its
  // result as `content` with a `path` rawInput and NO rawOutput at all, so the bridge
  // had no metadata and the TUI kept the row's activity spinner running forever.
  if (process.env.FAKE_ACP_COMMANDS_EACH_TURN === '1') {
    update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'greet', description: 'Run the greet skill' }] })
  }
  if (process.env.FAKE_ACP_TOOL_READ === '1') {
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call-read', title: 'read', kind: 'read', status: 'pending', rawInput: { path: 'README.md' } })
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call-read', status: 'completed', rawInput: { path: 'README.md' }, content: [{ type: 'content', content: { type: 'text', text: '# hi' } }] })
    await new Promise((resolve) => setTimeout(resolve, 1200))
  }
  if (process.env.FAKE_ACP_TOOL_STAGES === '1') {
    // opencode's real sequence: the pending frame carries only {cwd} (or {}), the
    // command/query arrives with in_progress, and completion carries content plus
    // rawOutput.metadata. Measured on v2.0.32 with the default model.
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-shell',
      title: 'shell',
      kind: 'execute',
      status: 'pending',
      rawInput: { cwd: '/tmp' },
    })
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-shell',
      status: 'in_progress',
      title: 'echo hello',
      kind: 'execute',
      rawInput: { command: 'echo hello', cwd: '/tmp' },
    })
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-shell',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'hello\n' } }],
      rawOutput: { metadata: { status: 'completed', truncated: false, exit: 0 } },
    })
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-search',
      title: 'websearch',
      kind: 'other',
      status: 'pending',
      rawInput: {},
    })
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-search',
      status: 'in_progress',
      kind: 'other',
      title: 'websearch',
      rawInput: { query: 'opencode v2' },
    })
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-search',
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'Web search cancelled' } }],
      rawOutput: { metadata: {}, error: 'Web search cancelled' },
    })
  }

  if (process.env.FAKE_ACP_TODO === '1') {
    // v2.1's TUI derives the todo list from the latest completed `todowrite` tool call
    // (`state.input.todos`); the name must be exactly `todowrite`.
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-todo',
      title: 'todowrite',
      kind: 'other',
      status: 'in_progress',
      rawInput: {
        todos: [
          { content: 'write the parser', status: 'completed' },
          { content: 'run the tests', status: 'in_progress' },
          { content: 'ship it', status: 'pending' },
        ],
      },
    })
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-todo',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'Todos updated: 1/3 completed' } }],
      rawOutput: { metadata: { todos: [] } },
    })
  }

  if (process.env.FAKE_ACP_USAGE_AGGREGATE === '1') {
    // opencode's ACP adapter reports a whole turn's processed tokens here; for a
    // 1M model a long agentic turn can exceed it several times. The bridge must
    // not present that aggregate as context.
    update(sessionId, {
      sessionUpdate: 'usage_update',
      used: 3_000_000,
      size: 1_000_000,
      cost: { amount: 0, currency: 'USD' },
    })
  }
  return { stopReason: 'end_turn' }
}

async function onMessage(msg) {
  // A *response* to something we asked: `{id, result|error}` with no `method`.
  // This used to require `msg.method !== undefined`, which meant the client's
  // answers never resolved anything — they fell through to the switch and were
  // answered with `-32601` as if they were requests. Every "round trip" the
  // harness claimed to make was really only checking the bridge's own events.
  if (msg.method === undefined && msg.id !== undefined) {
    const resolve = pendingRequests.get(msg.id)
    if (resolve) {
      pendingRequests.delete(msg.id)
      resolve(msg.result ?? { error: msg.error })
    }
    return
  }
  switch (msg.method) {
    case 'initialize':
      // `FAKE_ACP_AGENT_NAME` lets a scenario report a different identity: the bridge
      // gates one shape (codex-acp's verb-prefixed subagent titles) on this name, so a
      // test of that gate has to be able to wear it.
      respond(msg.id, {
        protocolVersion: 1,
        agentCapabilities: CAPS,
        agentInfo: { name: process.env.FAKE_ACP_AGENT_NAME ?? 'fake-acp', version: '0.0.1' },
      })
      return
    case 'session/new': {
      if (process.env.FAKE_ACP_DELAY_SESSION_NEW_MS) {
        await new Promise((resolve) =>
          setTimeout(resolve, Number(process.env.FAKE_ACP_DELAY_SESSION_NEW_MS) || 0),
        )
      }
      nextSession += 1
      const sessionId = `fake-session-${nextSession}`
      sessions.set(sessionId, {
        cwd: msg.params?.cwd ?? process.cwd(),
        model: '["fake","model-1"]',
        mode: defaultModeValue(),
      })
      // A load must report the configuration too, not just the replayed messages. A restore never
      // goes through `session/new`, so a fixture that only advertised its models there left the
      // bridge on the `acp/default` placeholder for the whole restored session — and anything that
      // needs a real model (the card footer, the replay repair) had nothing to resolve against.
      // Measured: after a restart the catalog read `real=none` on every request, while before the
      // restart it read `real=fake/model-1`.
      const initialOptions = configOptionsFor(sessionId)
      if (initialOptions.length > 0 && process.env.FAKE_ACP_MODELS_SUFFIXED !== '1') {
        notify('session/update', {
          sessionId,
          update: { sessionUpdate: 'config_option_update', configOptions: initialOptions },
        })
      }
      // The agent's slash commands, announced as the agent comes up — the same timing dsh
      // uses, so GET /api/command (the palette, opened at startup before any prompt) can
      // list them. Assertions pin the bridge's store, list and run paths.
      if (process.env.FAKE_ACP_COMMANDS === '1') {
        notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [
              { name: 'greet', description: 'Run the greet skill', input: { hint: 'who to greet' } },
              { name: 'status', description: 'Show session status' },
            ],
          },
        })
      }
      // stderr only: stdout is the JSON-RPC wire, and anything written there corrupts
      // it. The bridge does not relay this — the assertion uses the bridge's own log
      // line instead — but it makes a stray agent's working directory visible when
      // somebody runs the fixture by hand.
      process.stderr.write(`fake-acp: session/new cwd=${msg.params?.cwd ?? '(none)'}\n`)
      // ★ `FAKE_ACP_MODELS_SUFFIXED=1` reproduces codex-acp 2.8.0 (see below); declared
      // before `configOptions` because that line reads it.
      const suffixed = process.env.FAKE_ACP_MODELS_SUFFIXED === '1'
      const configOptions = initialOptions.length > 0 ? initialOptions : undefined
      // The ACP-standard model list, which real agents (qwen, gemini, kimi) use
      // instead of an opencode-shaped config option.
      // ★ `FAKE_ACP_MODELS_SUFFIXED=1` reproduces codex-acp 2.8.0: the session's
      // `configOptions` names the bare model (`suffixed-1`) while `models.availableModels`
      // appends a variant (`suffixed-1[high]`), and `session/set_model` accepts ONLY the
      // suffixed spelling ("Unsupported format of modelId … Expected: modelId[effort]").
      // The bare/suffixed split is what made a switch fail with `Internal error`.
      const standardModels =
        process.env.FAKE_ACP_MODELS_FIELD === '1' || suffixed
          ? {
              currentModelId: suffixed ? 'suffixed-1[high]' : 'qwen-like-1',
              availableModels: suffixed
                ? [
                    { modelId: 'suffixed-1[none]', name: 'Suffixed One (none)' },
                    { modelId: 'suffixed-1[high]', name: 'Suffixed One (high)' },
                  ]
                : [
                    { modelId: 'qwen-like-1', name: 'Qwen Like One' },
                    { modelId: 'qwen-like-2', name: 'Qwen Like Two' },
                  ],
            }
          : undefined
      const standardModes =
        process.env.FAKE_ACP_LEGACY_MODES === '1' ? legacyModesState(defaultModeValue()) : undefined
      respond(msg.id, {
        sessionId,
        ...(configOptions ? { configOptions } : {}),
        ...(standardModels ? { models: standardModels } : {}),
        ...(standardModes ? { modes: standardModes } : {}),
      })
      return
    }
    case 'session/set_mode': {
      if (process.env.FAKE_ACP_SET_CONFIG_FAILS === '1') {
        respondError(msg.id, -32602, 'Invalid params: mode switch refused by the fixture')
        return
      }
      const value = msg.params?.modeId
      if (typeof value !== 'string' || !VALID_LEGACY_MODES.includes(value)) {
        respondError(msg.id, -32602, `Invalid params: modeId must be one of ${VALID_LEGACY_MODES.join(', ')}`)
        return
      }
      const session = sessions.get(msg.params?.sessionId)
      if (session) session.mode = value
      process.stderr.write(`[fake] set legacy mode=${value}\n`)
      respond(msg.id, {})
      return
    }
    case 'session/set_model': {
      // ★ Only the SUFFIXED spelling is accepted when the agent advertises one, the way
      // codex-acp 2.8.0 behaves: it answers "Unsupported format of modelId: x. Expected:
      // modelId[effort]" for `suffixed-1` and accepts `suffixed-1[high]`. Without this
      // check the fixture would accept anything and prove nothing.
      const wanted = String(msg.params?.modelId ?? '')
      if (/^suffixed-1$/.test(wanted)) {
        respondError(msg.id, {
          code: -32603,
          message: 'Internal error',
          data: { details: `Unsupported format of modelId: ${wanted}. Expected: modelId[effort]` },
        })
        return
      }
      // The response shape real agents send: an empty result. What matters is
      // whether the id was accepted, which the test asserts through /api/model.
      respond(msg.id, {})
      return
    }
    case 'session/set_config_option': {
      // A real agent validates the value it is given, and the desktop showed exactly what
      // that costs when we invented a format: dsh answered
      // `Invalid params: model value must be a "provider/model" string`, the UI said
      // "request failed / unknown error", and the session stayed on the old model. This
      // fixture is deliberately just as strict — it only accepts what it advertised — so
      // a client that sends its own idea of a model value fails here too.
      // Every value the fixture advertises (modelOption() lists both) must be
      // acceptable here, or a client that switches to the second one hits a
      // validation error the real agent would not have produced.
      if (process.env.FAKE_ACP_SET_CONFIG_FAILS === '1') {
        // A real agent can refuse a switch, and the bridge must say so instead of answering
        // 204 (measured with dsh: the TUI showed the picked model, the session kept the old
        // one, and the only trace was a log line).
        respondError(msg.id, -32602, 'Invalid params: model switch refused by the fixture')
        return
      }
      // ★ The effort option (`FAKE_ACP_EFFORT=1`) is a separate config id; accept only the
      // values it advertised, and answer with the full state carrying the new value — which
      // is what lets a test assert the agent really moved, not just that a request was sent.
      if (msg.params?.configId === 'effort') {
        const levels = ['off', 'high', 'max']
        if (!levels.includes(msg.params?.value)) {
          respondError(msg.id, -32602, `Invalid params: effort must be one of ${levels.join(', ')}`)
          return
        }
        effortValue = msg.params.value
        process.stderr.write(`[fake] set effort=${effortValue}\n`)
        respond(msg.id, { configOptions: configOptionsFor(msg.params?.sessionId) })
        return
      }
      if (msg.params?.configId === 'mode') {
        const value = msg.params?.value
        if (typeof value !== 'string' || !VALID_MODES.includes(value)) {
          respondError(msg.id, -32602, `Invalid params: mode must be one of ${VALID_MODES.join(', ')}`)
          return
        }
        const session = sessions.get(msg.params?.sessionId)
        if (session) session.mode = value
        process.stderr.write(`[fake] set mode=${value}\n`)
        respond(msg.id, { configOptions: configOptionsFor(msg.params?.sessionId, { mode: value }) })
        return
      }
      const advertised = ['["fake","model-1"]', '["fake","model-2"]']
      const value = msg.params?.value
      if (typeof value !== 'string' || !advertised.includes(value)) {
        respondError(msg.id, -32602, `Invalid params: model value must be one of ${advertised.join(', ')}`)
        return
      }
      const session = sessions.get(msg.params?.sessionId)
      if (session) session.model = value
      respond(msg.id, { configOptions: configOptionsFor(msg.params?.sessionId, { model: value }) })
      return
    }
    case 'session/delete': {
      sessions.delete(msg.params?.sessionId)
      respond(msg.id, {})
      return
    }
    case 'session/list': {
      if (!CAPS.sessionCapabilities?.list) {
        respondError(msg.id, -32601, 'session/list not supported')
        return
      }
      respond(msg.id, {
        sessions: [{
          sessionId: 'listed-agent-session-1',
          cwd: msg.params?.cwd ?? process.cwd(),
          title: process.env.FAKE_ACP_LIST_TITLE ?? 'Imported old conversation',
          ...(process.env.FAKE_ACP_LIST_UPDATED_AT ? { updatedAt: process.env.FAKE_ACP_LIST_UPDATED_AT } : {}),
        }],
        nextCursor: null,
      })
      return
    }
    case 'session/resume': {
      const sessionId = msg.params?.sessionId
      if (!CAPS.sessionCapabilities?.resume) {
        respondError(msg.id, -32601, 'session/resume not supported')
        return
      }
      if (process.env.FAKE_ACP_RESUME_FAILS === '1') {
        respondError(msg.id, -32000, `session/resume failed: unknown session ${sessionId}`)
        return
      }
      // Resume = reconnect to the agent's existing context WITHOUT replaying
      // history. So: adopt the id, send NO transcript, and report configuration
      // (the bridge's model catalog comes from these options on a restore).
      sessions.set(sessionId, {
        cwd: msg.params?.cwd ?? process.cwd(),
        model: process.env.FAKE_ACP_RESUME_MODEL ?? '["fake","model-1"]',
        mode: defaultModeValue(),
      })
      const resumeOptions = configOptionsFor(sessionId, {
        model: process.env.FAKE_ACP_RESUME_MODEL ?? '["fake","model-1"]',
      })
      const resumeModes =
        process.env.FAKE_ACP_LEGACY_MODES === '1' ? legacyModesState(defaultModeValue()) : undefined
      respond(msg.id, {
        ...(resumeOptions.length > 0 ? { configOptions: resumeOptions } : {}),
        ...(resumeModes ? { modes: resumeModes } : {}),
      })
      return
    }
    case 'session/load': {
      const sessionId = msg.params?.sessionId
      // Widen the startup race the /message route used to lose: the replay must land after
      // the agent object exists but before a second request can be served, which is exactly
      // the window `FAKE_ACP_DELAY_SESSION_NEW_MS` opens for session/new.
      if (process.env.FAKE_ACP_DELAY_SESSION_LOAD_MS) {
        await new Promise((resolve) =>
          setTimeout(resolve, Number(process.env.FAKE_ACP_DELAY_SESSION_LOAD_MS) || 0),
        )
      }
      if (process.env.FAKE_ACP_LOAD_FAILS === '1') {
        // Advertised the capability and then failed anyway — the case a client gets
        // wrong by assuming "the agent said it could" means "it did". My first
        // fixture only turned the capability ON, and the handler below then
        // *succeeded*, which is how a test can look like it exercises a failure and
        // exercise nothing.
        respondError(msg.id, -32000, `session/load failed: unknown session ${sessionId}`)
        return
      }
      if (!CAPS.loadSession) {
        respondError(msg.id, -32601, 'session/load not supported')
        return
      }
      sessions.set(sessionId, {
        cwd: msg.params?.cwd ?? process.cwd(),
        model: '["fake","model-1"]',
        mode: defaultModeValue(),
      })
      // A restored session never goes through `session/new`, so a load has to report the
      // configuration itself. Without this the bridge's `record.model` stays unset, the next
      // `session.step.started` carries `model: undefined`, and the client — which dereferences
      // `message.model.providerID` without a guard — crashes on the next turn.
      const inResponse = process.env.FAKE_ACP_LOAD_MODELS_IN_RESPONSE === '1'
      const loadOptions =
        process.env.FAKE_ACP_LOAD_NO_MODELS === '1'
          ? (process.env.FAKE_ACP_MODES === '1' ? [modeOption('default')] : [])
          : configOptionsFor(sessionId)
      if (loadOptions.length > 0 && !inResponse) {
        notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'config_option_update',
            configOptions: loadOptions,
          },
        })
      }
      // A real agent replays the conversation it recorded (dsh does; see the bridge's
      // `history:` log). The replay must go out *before* the load response: the bridge collects
      // `session/update` notifications only until the response resolves, so sending them
      // afterwards loses the race and the load looks empty — which is exactly what the first
      // version of this fixture did, making a "replayed" transcript test exercise nothing.
      if (process.env.FAKE_ACP_REPLAY_ON_LOAD === '1') {
        update(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'replayed-from-agent' },
        })
      }
      if (process.env.FAKE_ACP_REPLAY_TOOLS === '1') {
        update(sessionId, {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'check files' },
        })
        update(sessionId, {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'reading first' },
        })
        update(sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: 'rep-done',
          title: 'read',
          status: 'completed',
          rawInput: { path: 'README.md' },
          content: [{ type: 'content', content: { type: 'text', text: 'replayed-tool-output' } }],
        })
        update(sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: 'rep-open',
          title: 'search',
        })
        update(sessionId, {
          sessionUpdate: 'tool_call',
          toolCallId: 'rep-fail',
          title: 'write',
          status: 'failed',
          rawInput: { path: 'x.txt' },
          rawOutput: { error: 'boom' },
        })
        update(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'all checked' },
        })
      }
      const loadModes =
        process.env.FAKE_ACP_LEGACY_MODES === '1' ? legacyModesState(defaultModeValue()) : undefined
      respond(msg.id, {
        ...(inResponse && loadOptions.length > 0 ? { configOptions: loadOptions } : {}),
        ...(loadModes ? { modes: loadModes } : {}),
      })
      if (process.env.FAKE_ACP_POST_LOAD_META === '1') {
        setTimeout(() => {
          update(sessionId, {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'greet', description: 'Run the greet skill' }],
          })
          update(sessionId, {
            sessionUpdate: 'usage_update',
            used: 1200,
            size: 200000,
          })
          update(sessionId, {
            sessionUpdate: 'session_info_update',
            title: 'Today News',
          })
        }, 20)
      }
      return
    }
    case 'session/prompt': {
      const sessionId = msg.params?.sessionId
      // A prompt whose text carries the marker is HELD until the test writes the
      // release file — a deterministic gate instead of a sleep, the shape both
      // Microsoft's Intelligent Terminal and KiroCrew use for timing tests.
      const holdOn = process.env.FAKE_ACP_HOLD_ON
      if (holdOn) {
        const text = (msg.params?.prompt ?? [])
          .map((block) => (block && block.type === 'text' ? block.text : ''))
          .join(' ')
        if (text.includes(holdOn)) {
          const release = process.env.FAKE_ACP_HOLD_RELEASE
          let done = false
          let timer
          const settle = (stopReason) => {
            if (done) return
            done = true
            if (timer) clearInterval(timer)
            hangingPrompts.delete(sessionId)
            respond(msg.id, { stopReason })
          }
          hangingPrompts.set(sessionId, () => settle('cancelled'))
          if (release) {
            timer = setInterval(() => {
              if (done || !existsSync(release)) return
              done = true
              clearInterval(timer)
              hangingPrompts.delete(sessionId)
              void runPrompt(sessionId, msg.params?.prompt ?? []).then((result) => respond(msg.id, result))
            }, 50)
          }
          return
        }
      }
      if (process.env.FAKE_ACP_HANG === '1') {
        // ★ `FAKE_ACP_HANG_TOOL=1` reproduces what dsh does on a cancel: a shell tool is in
        // flight when the turn is cancelled, the prompt answers `cancelled`, and only THEN does
        // the tool's own terminal `failed` update arrive. That late update is the one that
        // reached the client after `session.execution.interrupted`.
        const withTool = process.env.FAKE_ACP_HANG_TOOL === '1'
        if (withTool) {
          update(sessionId, {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-hang',
            title: 'bash',
            kind: 'execute',
            status: 'in_progress',
            rawInput: { command: 'sleep 600' },
          })
        }
        hangingPrompts.set(sessionId, () => {
          respond(msg.id, { stopReason: 'cancelled' })
          if (withTool) {
            setTimeout(() => {
              update(sessionId, {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'call-hang',
                status: 'failed',
                rawOutput: { output: 'interrupted', isError: true },
              })
            }, 100)
          }
        })
        return
      }
      if (process.env.FAKE_ACP_STALE_PROMPT === '1' && !staleCleared.has(sessionId)) {
        // The desync the bridge has to survive: it believes the session is idle, but
        // the agent still has a prompt registered as active. Only a session/cancel
        // clears it — the retry must then succeed.
        respondError(
          msg.id,
          -32000,
          `Internal error: Session already has an active ACP prompt: ${sessionId}`,
        )
        return
      }
      if (SCENARIO === 'error-response') {
        // A JSON-RPC *error* where a result belongs. This is a different failure
        // path from `error-turn`, which is a well-formed response carrying
        // stopReason: 'error' — here the request itself fails.
        respondError(msg.id, -32000, 'scenario: the agent refused this prompt')
        return
      }
      const result = await runPrompt(sessionId, msg.params?.prompt ?? [])
      // opencode reports usage in the prompt RESULT (`PromptResponse.usage`) and never
      // sends a `usage_update` frame; this switch reproduces that shape.
      respond(
        msg.id,
        process.env.FAKE_ACP_USAGE_AGGREGATE === '1'
          ? {
              ...result,
              usage: {
                inputTokens: 3_000_000,
                outputTokens: 0,
                thoughtTokens: 0,
                cachedReadTokens: 0,
                cachedWriteTokens: 0,
                totalTokens: 3_000_000,
              },
            }
          : process.env.FAKE_ACP_USAGE === '1'
            ? {
                ...result,
                usage: {
                  inputTokens: 1234,
                  outputTokens: 56,
                  thoughtTokens: 7,
                  cachedReadTokens: 890,
                  cachedWriteTokens: 12,
                  totalTokens: 2199,
                },
              }
            : result,
      )
      if (process.env.FAKE_ACP_LATE_REASONING === '1') {
        // dsh's background job: after the prompt result, a new internal turn starts
        // and sends reasoning into the same session. The bridge must record it
        // without making the completed message sprout a thinking spinner.
        setTimeout(() => {
          update(sessionId, {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'late thought after the turn' },
          })
        }, 300)
      }
      return
    }
    case 'session/cancel': {
      const sessionId = msg.params?.sessionId
      staleCleared.add(sessionId)
      const settle = hangingPrompts.get(sessionId)
      if (settle) {
        hangingPrompts.delete(sessionId)
        settle()
      }
      return
    }
    default:
      if (msg.id !== undefined) respondError(msg.id, -32601, `unknown method ${msg.method}`)
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    void onMessage(msg)
  }
})
process.stdin.on('end', () => process.exit(0))
