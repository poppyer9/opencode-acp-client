/**
 * ACP client: spawns an agent process and speaks ACP JSON-RPC over stdio.
 *
 * Two rules drive the whole implementation:
 *
 *  1. **Every inbound request gets an answer.** An ACP agent that asks us
 *     something and hears nothing will wait forever. So anything we cannot
 *     service is answered with an explicit JSON-RPC error, never dropped.
 *  2. **Timeouts are mandatory.** Several agents have bugs where a request
 *     simply never resolves. Without a timeout the HTTP request waiting on it
 *     would hang for the lifetime of the process.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ChildSessionEvent } from '../subagent-sessions.js';

/** `opencode acp`'s notification for one event in a delegated run (see subagent-sessions). */
export const CHILD_UPDATE_METHOD = 'opencode/session/child_update';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import {
  client as sdkClient,
  ndJsonStream,
  RequestError,
  type ClientConnection,
  type Stream,
} from '@agentclientprotocol/sdk';

import {
  CLIENT_CAPABILITIES,
  NO_CAPABILITIES,
  clientCallbackSupport,
  effectiveCapabilities,
  type EffectiveCapabilities,
} from './capabilities.js';
import type {
  ContentBlock,
  ElicitationRequest,
  ElicitationResponse,
  InitializeResponse,
  JsonRpcMessage,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNewResponse,
  SessionUpdate,
} from './types.js';

export interface AcpClientOptions {
  /** Command to spawn, `my-agent` or `npx`. */
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** How long to wait for any single JSON-RPC response. */
  requestTimeoutMs?: number;
  /**
   * Timeout for `session/prompt` specifically.
   *
   * One timeout for everything was wrong: `initialize` and `session/new` answer in
   * milliseconds, while a prompt is a *task* — an agent may work through a dozen
   * tool calls without touching the wire, and 120s of silence is normal for real
   * work. Measured case: a review task with 20+ tool calls was killed mid-flight by
   * the request timeout, and the turn ended with `timed out waiting for
   * session/prompt` while the agent was still working.
   */
  promptTimeoutMs?: number;
  /** Protocol revision we claim. Agents negotiate down. */
  protocolVersion?: number;
  /** Sink for diagnostics; never written to stdout (that is the ACP wire). */
  onLog?: (line: string) => void;
}

export interface AcpEvents {
  /** A `session/update` notification. */
  update: [sessionId: string, update: SessionUpdate];
  /** The agent exited; no further calls will succeed. */
  exit: [{ code: number | null; signal: string | null }];
  /**
   * One event of a delegated run (`opencode/session/child_update`), keyed by the ROOT
   * session so it lands on the transcript that owns the subagent card.
   */
  child: [rootSessionId: string, event: ChildSessionEvent];
  /** Diagnostics. */
  log: [line: string];
}

type StandardModeState = {
  currentModeId?: string;
  availableModes?: Array<{ id?: string; name?: string; description?: string | null }>;
};

function isClientModeOption(option: SessionConfigOption): boolean {
  return option.category === 'mode' || (option.id ?? option.configId) === 'mode';
}

/** Raised when the agent answered with a JSON-RPC error. */
export class AcpError extends Error {
  constructor(
    message: string,
    readonly code: number | string = 'acp-error',
  ) {
    super(message);
    this.name = 'AcpError';
  }
}

/** The agent does not implement the method we called. */
/**
 * Turn an SDK `RequestError` into the vocabulary this repo's callers branch on.
 *
 * The codes come from the wire unchanged (`-32601` unknown method is how an agent says
 * "not supported"), so the mapping is about the *class*, not the payload: a missing
 * method becomes `AcpMethodNotFound`, everything else an `AcpError` carrying the agent's
 * own code and message.
 */
export function translateSdkError(method: string, err: unknown): AcpError {
  if (err instanceof AcpError) return err;
  const code = (err as { code?: unknown }).code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === -32601 || /unknown method/i.test(message)) return new AcpMethodNotFound(method);
  // ★ The SDK's stream says "ACP connection closed" when the transport goes away; what
  // actually happened is that the agent process died, and that is the wording the user
  // reads on the message row (and what the smoke's crash scenario asserts). Keep the two
  // facts together rather than leaving the SDK's phrasing in the UI.
  if (/ACP connection closed|connection closed/i.test(message)) {
    return new AcpError('agent exited: ACP connection closed', 'agent-exited');
  }
  return new AcpError(message, typeof code === 'number' ? code : 'acp-error');
}

export class AcpMethodNotFound extends AcpError {
  constructor(method: string) {
    super(`agent does not implement ${method}`, -32601);
    this.name = 'AcpMethodNotFound';
  }
}


/** Variants seen on the wire that this client does not know (logged once each). */
const UNKNOWN_UPDATES_SEEN = new Set<string>();

export class AcpClient extends EventEmitter<AcpEvents> {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly timeoutMs: number;
  private readonly promptTimeoutMs: number;
  private readonly protocolVersion: number;
  private nextId = 1;
  private buffer = '';
  /** The SDK's connection: it owns JSON-RPC correlation and the transport. */
  private conn: ClientConnection | null = null;
  private closed = false;
  private caps: EffectiveCapabilities | null = null;
  private agentVersion: string | undefined;
  private pendingRecordedFrames: JsonRpcMessage[] = [];
  private recordFlushed = false;
  private recordFile: string | undefined;
  /** Permission requests the agent is currently blocked on. */
  private permissionHandler:
    | ((req: RequestPermissionRequest) => Promise<RequestPermissionResponse>)
    | null = null;
  /** `elicitation/create` — the agent asking the user something. */
  private elicitationHandler:
    | ((req: ElicitationRequest) => Promise<ElicitationResponse>)
    | null = null;

  constructor(private readonly options: AcpClientOptions) {
    super();
    this.timeoutMs = options.requestTimeoutMs ?? 120_000;
    // ★ No prompt clock by default (2026-10-20). A real long task was killed
    // twice at 30 minutes while the agent was still working; the TUI showed "timed
    // out waiting for session/prompt", the agent kept its prompt active, and the
    // user had to type "continue". ACP has no server-side prompt timeout, and the
    // TUI's Esc/interrupt is the user's stop control. Set the env (or the option)
    // to a positive number to restore a clock.
    this.promptTimeoutMs =
      options.promptTimeoutMs ??
      (Number(process.env['OPENCODE_ACP_CLIENT_PROMPT_TIMEOUT_MS']) > 0
        ? Number(process.env['OPENCODE_ACP_CLIENT_PROMPT_TIMEOUT_MS'])
        : 0);
    this.protocolVersion = options.protocolVersion ?? 1;

    const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? {}) };
    // Strip anything that would make the agent try to phone home during tests.
    env.NO_COLOR = env.NO_COLOR ?? '1';

    const spec = launchSpec(options.command, options.args ?? []);
    this.child = spawn(spec.file, spec.args, {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Verbatim only for the `cmd.exe` form: our own quoting must reach it unchanged.
      windowsVerbatimArguments: spec.verbatim,
      // Its own process group on POSIX, so dispose can kill the whole tree. An agent
      // that forks helpers (shells, watchers) used to leave them behind: `child.kill`
      // only reaches the direct child, and the survivors became `ppid=1` orphans that
      // keep workspace locks (measured twice with dsh).
      detached: process.platform !== 'win32',
    });

    // ★ `onLog` was declared, passed by two call sites, and never consumed — the event was
    // the only real sink. The practical cost: the session-discovery client in
    // `src/server.ts` passed `onLog` and its ACP frames were dropped on the floor, so a failed
    // discovery explained nothing. Wired here so the option means what its name says.
    if (options.onLog) this.on('log', (line: string) => options.onLog?.(line));
    // ★ The SDK owns the transport now. `ndJsonStream` splits NDJSON on BYTES with the
    // SDK's own `LineBuffer` (incremental, with a frame-size cap), and the connection below
    // owns JSON-RPC correlation. `onStdout` is kept for the frame recorder only: recording
    // wants the raw frames verbatim, which a decoded connection no longer exposes.
    this.conn = sdkClient()
      .onRequest('session/request_permission', async (context) =>
        this.answerPermission((context.params ?? {}) as RequestPermissionRequest),
      )
      // The SDK's generated `CreateElicitationResponse` is a stricter nominal type than the
      // protocol needs; ours carries exactly the same two fields (`action`, `content`) and
      // is what the rest of this repo speaks, so the cast is at the boundary and nowhere else.
      .onRequest('elicitation/create', async (context) =>
        (await this.answerElicitation((context.params ?? {}) as ElicitationRequest)) as never,
      )
      // ★ Iron rule 3 ("never degrade silently") needs a catch-all: the SDK dispatches
      // `session/update` to our typed handler, and an update whose `sessionUpdate` value we
      // do not know would be dropped without a word. This records anything the specific
      // handlers did not claim, so a new variant shows up in the log instead of on a blank
      // screen.
      .onNotification('*', async (context) => {
        const method = (context as { method?: string }).method;
        if (method === 'session/update') return; // handled below
        this.emit('log', `[acp] notification ${String(method ?? '(unknown)')} has no handler`);
      })
      .onNotification('session/update', async (context) => {
        const params = (context.params ?? {}) as { sessionId?: string; update?: unknown; _meta?: unknown };
        if (typeof params.sessionId !== 'string' || params.update === undefined) return;
        const variant = (params.update as { sessionUpdate?: unknown }).sessionUpdate;
        if (typeof variant !== 'string') {
          this.emit('log', '[acp] session/update without a sessionUpdate discriminator; ignored');
          return;
        }
        await this.onUpdate(params.sessionId, params.update as SessionUpdate, params._meta);
      })
      .connect(
        this.traced(
          ndJsonStream(
            Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>,
            Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>,
          ),
        ),
      );


    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) this.emit('log', `[agent] ${line}`);
      }
    });

    this.child.on('error', (err) => {
      this.emit('log', `[acp] failed to start the agent: ${err.message}`);
    });
    this.child.on('exit', (code, signal) => {
      this.closed = true;

      this.emit('exit', { code, signal });
    });
  }

  get capabilities(): EffectiveCapabilities {
    // Before `initialize` answers, the honest profile is "nothing advertised".
    return this.caps ?? NO_CAPABILITIES;
  }

  /** Register the handler used to resolve `session/request_permission`. */
  onPermission(
    handler: (req: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
  ): void {
    this.permissionHandler = handler;
  }

  /**
   * Register the handler used to answer `elicitation/create`.
   *
   * Only ever called for `mode: "form"` — the mode we advertise. The handler may
   * throw to refuse the request outright; that becomes a JSON-RPC error, which is
   * the honest answer when the requested schema cannot be rendered.
   */
  onElicitation(handler: (req: ElicitationRequest) => Promise<ElicitationResponse>): void {
    this.elicitationHandler = handler;
  }

  /**
   * `initialize`. Failure here is fatal: without it we do not know what the
   * agent supports, and guessing is how hangs happen.
   */
  async initialize(): Promise<EffectiveCapabilities> {
    const result = await this.request<InitializeResponse>('initialize', {
      protocolVersion: this.protocolVersion,
      // Only what has a path behind it. See CLIENT_CAPABILITIES.
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    this.caps = effectiveCapabilities(result);
    const info = (result as { agentInfo?: { version?: unknown } }).agentInfo;
    if (typeof info?.version === 'string') this.agentVersion = info.version;
    // The header needs the agent's name, which only exists after this response.
    this.flushRecordedFrames();
    this.emit('log', `initialized: ${JSON.stringify(this.caps)}`);
    return this.caps;
  }

  async newSession(cwd: string): Promise<SessionNewResponse> {
    const result = await this.request<SessionNewResponse>('session/new', { cwd, mcpServers: [] });
    this.catalog(result.sessionId).configOptions = result.configOptions ?? [];
    this.noteStandardModels(result.sessionId, result);
    this.noteStandardModes(result.sessionId, result);
    if (process.env.OPENCODE_ACP_CLIENT_DUMP) {
      try {
        writeFileSync(process.env.OPENCODE_ACP_CLIENT_DUMP, JSON.stringify(result, null, 2));
      } catch {
        /* diagnostics only */
      }
    }
    return result;
  }

  /**
   * Per-SESSION catalogs: the config options, standard `models`, and legacy `modes` lists
   * are session-scoped in ACP (`session/new`/`load`/`resume` each carry their own), so
   * they are kept per session id rather than in one field. One field was fine while
   * one client meant one session; a shared connection would let the newest session's
   * defaults (and a `set_config_option` meant for another session) leak across.
   */
  private catalogs = new Map<
    string,
    {
      configOptions: SessionConfigOption[];
      standardModels?:
        | { currentModelId?: string; availableModels?: Array<{ modelId?: string; name?: string }> }
        | undefined;
      standardModes?: StandardModeState | undefined;
    }
  >();
  private lastSessionId: string | undefined;

  /** (Re)select a session's catalog state, remembering it as the most recent one. */
  private catalog(sessionId: string): {
    configOptions: SessionConfigOption[];
    standardModels?:
      | { currentModelId?: string; availableModels?: Array<{ modelId?: string; name?: string }> }
      | undefined;
    standardModes?: StandardModeState | undefined;
  } {
    let state = this.catalogs.get(sessionId);
    if (!state) {
      state = { configOptions: [] };
      this.catalogs.set(sessionId, state);
    }
    this.lastSessionId = sessionId;
    return state;
  }

  /** The options a given session advertised; omitted = the most recently touched one. */
  configOptionsFor(sessionId?: string): SessionConfigOption[] {
    const id = sessionId ?? this.lastSessionId;
    return id ? (this.catalogs.get(id)?.configOptions ?? []) : [];
  }

  /** First non-empty config option list on this connection (fallback when a restored session omitted its own). */
  anyConfigOptions(): SessionConfigOption[] {
    for (const state of this.catalogs.values()) {
      if (state.configOptions.length > 0) return state.configOptions;
    }
    return [];
  }

  private anyStandardModels():
    | { currentModelId?: string; availableModels?: Array<{ modelId?: string; name?: string }> }
    | undefined {
    for (const state of this.catalogs.values()) {
      if (state.standardModels) return state.standardModels;
    }
    return undefined;
  }

  private anyStandardModes(): StandardModeState | undefined {
    for (const state of this.catalogs.values()) {
      if (state.standardModes) return state.standardModes;
    }
    return undefined;
  }

  private synthesizeModeOption(modes: StandardModeState): SessionConfigOption | undefined {
    const available = (modes.availableModes ?? []).filter(
      (mode): mode is { id: string; name?: string; description?: string | null } =>
        typeof mode?.id === 'string' && mode.id.length > 0,
    );
    if (available.length === 0) return undefined;
    return {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue:
        typeof modes.currentModeId === 'string' && modes.currentModeId.length > 0
          ? modes.currentModeId
          : available[0]!.id,
      options: available.map((mode) => ({
        value: mode.id,
        name: typeof mode.name === 'string' && mode.name.length > 0 ? mode.name : mode.id,
        ...(typeof mode.description === 'string' && mode.description.trim()
          ? { description: mode.description }
          : {}),
      })),
    };
  }

  /**
   * ACP v1 `SessionModeState` (`modes: { currentModeId, availableModes[] }`).
   * Used when an agent advertises modes via the legacy field instead of a `category: "mode"`
   * entry in `configOptions`; when `configOptions` already carries modes, it wins.
   */
  private noteStandardModes(sessionId: string, result: SessionNewResponse): void {
    const state = this.catalog(sessionId);
    if (state.configOptions.some(isClientModeOption)) {
      state.standardModes = undefined;
      return;
    }
    const modes = result.modes as StandardModeState | undefined;
    if (!modes) return;
    const synthesized = this.synthesizeModeOption(modes);
    if (!synthesized) return;
    state.standardModes = modes;
    state.configOptions = [...state.configOptions, synthesized];
  }

  /** Any session on this connection advertised a catalog (pool-aware). */
  hasCatalog(): boolean {
    for (const state of this.catalogs.values()) {
      if (state.configOptions.length > 0) return true;
    }
    return false;
  }

  /**
   * The ACP-standard model list: `models: {currentModelId, availableModels[]}`.
   *
   * Agents that use it (qwen, and per the ecosystem survey gemini and kimi) put their
   * models here rather than in an opencode-shaped `configOptions` entry — we ignored
   * the field entirely, so their model picker came up empty (`/api/model` stayed on the
   * `acp/default` placeholder) even though the agent had just told us every model it
   * has. Measured: qwen --acp returns four models this way.
   */
  private noteStandardModels(sessionId: string, result: SessionNewResponse): void {
    const models = result.models as
      | { currentModelId?: string; availableModels?: Array<{ modelId?: string; name?: string }> }
      | undefined;
    const available = models?.availableModels ?? [];
    if (available.length === 0) return;
    const state = this.catalog(sessionId);
    state.standardModels = models;
    // ★ Merge the two sources by IDENTITY, and let `configOptions` own the spelling when
    // both describe the same model.
    //
    // Measured on shapers that disagree:
    //   • codex-acp 2.8.0 — `configOptions` says `deepseek-flash`, while `models` says
    //     `deepseek-flash[none]` / `[high]` / `[max]` (a reasoning-effort suffix). Appending
    //     the second on top of the first put the suffixed values in the picker; the TUI
    //     submitted the unsuffixed one it had read from `configOptions`, the lookup found no
    //     match, the request fell back to `acp/deepseek-flash`, codex refused it with
    //     `Internal error`, and the session never set up.
    //   • qwen --acp — both lists carry the identical ids, so appending only duplicated rows.
    //
    // So: keep every `configOptions` value, and add a `models` entry only when no existing
    // option already means that model (compared with any `[suffix]` stripped).
    const existing = new Set<string>();
    for (const option of state.configOptions) {
      if (option.category !== 'model' && option.id !== 'model') continue;
      for (const entry of option.options ?? []) {
        const group = entry as { options?: Array<{ value?: string }>; value?: string };
        const values = Array.isArray(group.options)
          ? group.options.map((choice) => choice.value)
          : [group.value];
        for (const value of values) {
          if (typeof value !== 'string') continue;
          // `["provider","model"]` and `provider::model` both reduce to the model id.
          const bare = value.replace(/\[[^\]]*\]$/, '');
          existing.add(bare);
          try {
            const parsed = JSON.parse(value) as unknown;
            if (Array.isArray(parsed) && typeof parsed[1] === 'string') existing.add(parsed[1]);
          } catch {
            /* not JSON: the raw string is the id */
          }
        }
      }
    }
    const novel = available.filter((model) => {
      const id = String(model.modelId ?? '');
      return id !== '' && !existing.has(id) && !existing.has(id.replace(/\[[^\]]*\]$/, ''));
    });
    if (novel.length === 0) return;
    const currentId = models?.currentModelId ?? novel[0]?.modelId ?? '';
    state.configOptions = [
      ...state.configOptions,
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: JSON.stringify([currentId, currentId]),
        options: novel.map((model) => ({
          value: JSON.stringify([model.modelId ?? '', model.modelId ?? '']),
          name: model.name ?? String(model.modelId ?? ''),
        })),
      } as SessionConfigOption,
    ];
  }

  get configOptions(): SessionConfigOption[] {
    return this.configOptionsFor();
  }

  /**
   * `session/load`. Caller must check `capabilities.loadSession` first.
   * Agents without `loadSession` get an explicit, catchable error.
   */
  async loadSession(sessionId: string, cwd: string): Promise<void> {
    if (!this.capabilities.loadSession) {
      throw new AcpMethodNotFound('session/load');
    }
    const result = await this.request<SessionNewResponse>('session/load', {
      sessionId,
      cwd,
      mcpServers: [],
    });
    // A replay carries the session's config options too, and that is where a
    // resumed session's model list comes from - `session/new` never runs for it.
    // `?? []` and not `?? this.sessionConfig`... except agents that send the config
    // as a `config_option_update` *notification* before the response (the fixture does;
    // real agents vary) have it applied by the update listener already, and a bare
    // response then wiped it back to empty — measured: the catalog stayed on the
    // placeholder forever after a restart, the client showed `model-1 (unavailable)`
    // and refused to submit. The response wins when it carries options; when it does
    // not, whatever the notifications already applied stands.
    if (Array.isArray(result.configOptions)) this.catalog(sessionId).configOptions = result.configOptions;
    this.noteStandardModels(sessionId, result);
    this.noteStandardModes(sessionId, result);
  }

  /**
   * `session/resume`. ACP defines it as "reconnect to an existing session WITHOUT
   * replaying history" — and that is all it promises.
   *
   * Measured on the backend's plain ACP profile (2026-10-17, probes in
   * docs/KNOWN-ISSUES.md): the call succeeds, the response carries configOptions, no
   * updates follow, and the next turn runs. Whether the agent's model actually still
   * has the earlier conversation was **not consistent**: the same profile answered
   * "there's no word I was asked to remember in this conversation" under one model
   * and recalled the word correctly under another.
   *
   * So describe only what is guaranteed: same session id, empty transcript, and the
   * conversation's continuity left to the agent. Never promise that context survived.
   */
  async resumeSession(sessionId: string, cwd: string): Promise<SessionNewResponse> {
    // ACP: a client MUST NOT call `session/resume` without
    // `sessionCapabilities.resume`. Refusing here (as `listSessions` does) keeps
    // the gate in one place, so no future caller can quietly violate it.
    if (!this.capabilities.resumeSessions) {
      throw new AcpMethodNotFound('session/resume');
    }
    const result = await this.request<SessionNewResponse>('session/resume', { sessionId, cwd });
    this.catalog(sessionId).configOptions = result.configOptions ?? [];
    this.noteStandardModels(sessionId, result);
    this.noteStandardModes(sessionId, result);
    return result;
  }

  /**
   * `session/list`. the backend returns `{sessionId, cwd}` entries newest first, 100 per
   * page with a cursor. An unpaginated read only ever sees recent sessions — for a
   * directory whose sessions are all older, a "latest" lookup finds nothing.
   */
  async listSessions(
    cwd: string,
    maxPages = 10,
  ): Promise<Array<{ sessionId: string; cwd: string; title?: string; updatedAt?: string | null }>> {
    // ACP: a client MUST NOT call `session/list` without `sessionCapabilities.list`.
    // Refusing here (rather than in each caller) keeps the gate in one place.
    if (!this.capabilities.listSessions) {
      throw new AcpMethodNotFound('session/list');
    }
    const all: Array<{ sessionId: string; cwd: string; title?: string; updatedAt?: string | null }> = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.request<{
        sessions?: Array<{ sessionId: string; cwd: string; title?: string; updatedAt?: string | null }>;
        nextCursor?: string | null;
      }>('session/list', cursor ? { cwd, cursor } : { cwd });
      all.push(...(result.sessions ?? []));
      cursor = result.nextCursor ?? undefined;
      if (!cursor) break;
    }
    return all;
  }

  async prompt(sessionId: string, prompt: ContentBlock[]): Promise<PromptResponse> {
    return this.request<PromptResponse>(
      'session/prompt',
      { sessionId, prompt },
      this.promptTimeoutMs > 0 ? this.promptTimeoutMs : null,
    );
  }

  /**
   * `session/set_config_option`. the backend advertises models through a config option
   * (`id: "model"`), so this is how a model switch reaches the agent.
   *
   * Returns the config state the agent answered with: the spec requires the
   * response to carry the **complete** list, which is how dependent changes
   * (reasoning options that follow the model, for instance) reach us at all.
   */
  /**
   * Tell the agent a session is gone (`session/delete`, a stable agent method).
   *
   * Without this the agent keeps the session it created: the bridge forgets it, the
   * UI forgets it, and the agent's own store keeps growing. Best-effort by design —
   * the user asked to delete, and that must succeed locally even if the agent cannot
   * honour it.
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.request('session/delete', { sessionId });
  }

  /**
   * The spelling `set_model` expects for a model the caller names by its bare id.
   *
   * An agent that publishes `models.availableModels` may append a variant to the id
   * (`deepseek-flash[high]`) while `configOptions` offers the bare one; the two
   * methods accept different spellings (see `setConfig`). Match on the bare part and
   * return the standard list's own string, so neither the picker nor the wire has to
   * know which surface the user clicked on.
   */
  private resolveStandardModelId(
    state: { standardModels?: { availableModels?: Array<{ modelId?: string }> } | undefined },
    modelId: string,
  ): string | undefined {
    const available = state.standardModels?.availableModels ?? [];
    if (available.length === 0) return undefined;
    const bare = (id: string): string => id.replace(/\[[^\]]*\]$/, '');
    const exact = available.find((model) => model.modelId === modelId);
    if (exact?.modelId) return exact.modelId;
    const sameModel = available.find((model) => typeof model.modelId === 'string' && bare(model.modelId) === bare(modelId));
    return sameModel?.modelId;
  }

  async setConfig(sessionId: string, configId: string, value: string): Promise<SessionConfigOption[]> {
    // An agent whose models arrived in the standard `models` field switches them with
    // `session/set_model` (that is the family gemini and kimi use too), not by writing
    // a config option we synthesised on its behalf.
    const state = this.catalog(sessionId);
    const standard = state.standardModels ?? this.anyStandardModels();
    if (configId === 'model' && standard) {
      let modelId = value;
      try {
        const parsed = JSON.parse(value) as unknown;
        if (Array.isArray(parsed) && typeof parsed[1] === 'string') modelId = parsed[1];
      } catch {
        /* a bare model id is fine too */
      }
      // ★ `set_model` wants the id EXACTLY as `models.availableModels` spells it, which
      // is not always what `configOptions` offers. Measured on codex-acp 2.8.0:
      //   session/set_config_option + `deepseek-flash`      -> OK
      //   session/set_model        + `deepseek-flash`      -> "Unsupported format of
      //                                                       modelId … Expected: modelId[effort]"
      //   session/set_model        + `deepseek-flash[high]` -> OK
      // The caller has the bare id (that is what the picker shows), so resolve it
      // against the standard list before switching — matching on the part before
      // `[`, which is the model's identity on both sides.
      const wanted = this.resolveStandardModelId({ standardModels: standard }, modelId) ?? modelId;
      await this.request('session/set_model', { sessionId, modelId: wanted });
      if (state.standardModels) state.standardModels.currentModelId = wanted;
      return state.configOptions;
    }
    // Agents that expose ACP v1 `SessionModeState` without a `category: "mode"` config
    // option expect `session/set_mode` instead of `session/set_config_option`.
    const standardModes =
      state.standardModes ??
      (state.configOptions.some(isClientModeOption) ? undefined : this.anyStandardModes());
    if (configId === 'mode' && standardModes) {
      await this.request('session/set_mode', { sessionId, modeId: value });
      this.applyCurrentMode(sessionId, value);
      return state.configOptions;
    }
    // `value` goes on the wire as a bare string, NOT as the `{type:"id", value}`
    // envelope the ACP SDK types declare. the backend validates the envelope away with
    // zod and hands the inner value straight to a `typeof value !== "string"`
    // check, so the SDK-shaped object is rejected as "Invalid params".
    //
    // Probed against the backend directly:
    //   {type:"id", value:"['p','m']"} -> Invalid params
    //   "['p','m']"                     -> accepted, configOptions returned
    const result = await this.request<{ configOptions?: SessionConfigOption[] }>(
      'session/set_config_option',
      { sessionId, configId, value },
    );
    this.applyConfigOptions(sessionId, result?.configOptions);
    return state.configOptions;
  }

  /**
   * Replace the session's config options.
   *
   * Used for both halves of the negotiation: the reply to a `set_config_option`,
   * and an agent-pushed `config_option_update` (the spec sends the complete state
   * in both, so replacing is correct — merging would keep stale values alive).
   */
  applyConfigOptions(sessionId: string, options: SessionConfigOption[] | undefined): void {
    if (!Array.isArray(options)) return;
    const state = this.catalog(sessionId);
    if (options.some(isClientModeOption)) {
      state.standardModes = undefined;
      state.configOptions = options;
      return;
    }
    if (state.standardModes) {
      const synthesized = this.synthesizeModeOption(state.standardModes);
      state.configOptions = synthesized ? [...options, synthesized] : options;
      return;
    }
    state.configOptions = options;
  }

  /** Record an agent-pushed or confirmed `currentModeId` / mode value for this session. */
  applyCurrentMode(sessionId: string, modeId: string): void {
    const state = this.catalog(sessionId);
    if (state.standardModes) state.standardModes.currentModeId = modeId;
    state.configOptions = state.configOptions.map((option) =>
      isClientModeOption(option) ? { ...option, currentValue: modeId } : option,
    );
  }

  /** `session/cancel` is a notification: fire and forget, per the spec. */
  cancel(sessionId: string): void {
    // Fire and forget, per the spec: `session/cancel` is a notification. The SDK's
    // `notify` never rejects for a transport error (there is nobody to answer), so the
    // `void` here is the whole error story.
    void this.conn?.agent.notify('session/cancel', { sessionId }).catch(() => undefined);
  }

  /** Terminate the agent. Safe to call repeatedly. */
  /** Signal the agent AND its descendants (one process group on POSIX). */
  private killGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    if (process.platform === 'win32') {
      // Windows has no process group we can signal: `taskkill /T` walks the tree.
      // Without /F it asks the app to close (our SIGTERM step); /F is the force
      // step. A failure falls through to the direct-child kill below.
      try {
        spawnSync('taskkill', windowsKillArgs(pid, signal), { stdio: 'ignore' });
        return;
      } catch {
        /* taskkill missing; fall through */
      }
    }
    if (process.platform !== 'win32') {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        /* the group is already gone, or it never became a group leader */
      }
    }
    try {
      this.child.kill(signal);
    } catch {
      /* already gone */
    }
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.stdin.end();
    } catch {
      /* already gone */
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          this.killGroup('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve();
      }, 3000);
      this.child.once('exit', () => {
        clearTimeout(t);
        // The leader is gone; helpers that ignored SIGTERM would linger as orphans.
        this.killGroup('SIGKILL');
        resolve();
      });
      try {
        this.killGroup('SIGTERM');
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
  }

  // ---------------------------------------------------------------- internals

  /**
   * `OPENCODE_ACP_CLIENT_RECORD_FRAMES=<dir>`: append every inbound frame to
   * `<dir>/<backend>.jsonl`, headed by a provenance line.
   *
   * A recorded turn is the only fixture that carries a REAL agent's shapes — the
   * synthetic fake agent can only exercise shapes we thought of. The corpus format
   * follows KiroCrew's: the first line is `_meta` (backend, recorded, date,
   * agent_version) and every line after it is the wire verbatim, so a replay can
   * be weighed against what produced it. Recording never breaks the wire: a
   * write failure is logged and dropped.
   */
  private recordFrame(msg: JsonRpcMessage): void {
    if (!process.env.OPENCODE_ACP_CLIENT_RECORD_FRAMES) return;
    if (this.recordFlushed && this.recordFile) {
      try {
        appendFileSync(this.recordFile, `${JSON.stringify(msg)}\n`);
      } catch (err) {
        this.emit('log', `[record] ${String(err)}`);
      }
      return;
    }
    this.pendingRecordedFrames.push(msg);
    // Frames that arrive before `initialize` answers are buffered: the header needs
    // the agent's own name, and writing it first with `unknown` would mislabel a
    // corpus that a replay later weighs by its backend.
    if (this.caps) this.flushRecordedFrames();
  }

  /** Write the buffered frames (header first) once the backend is known. */
  private flushRecordedFrames(): void {
    const dir = process.env.OPENCODE_ACP_CLIENT_RECORD_FRAMES;
    if (!dir || this.recordFlushed) return;
    this.recordFlushed = true;
    try {
      mkdirSync(dir, { recursive: true });
      const backend = (this.caps?.agentName ?? 'unknown').replace(/[^\w.-]+/g, '-');
      const file = join(dir, `${backend}.jsonl`);
      this.recordFile = file;
      const header = {
        _meta: {
          backend,
          recorded: 'live',
          date: new Date().toISOString().slice(0, 10),
          agent_version: this.agentVersion ?? 'unmeasured',
        },
      };
      const body = this.pendingRecordedFrames.map((frame) => JSON.stringify(frame)).join('\n');
      appendFileSync(file, `${JSON.stringify(header)}\n${body}${body ? '\n' : ''}`);
      this.pendingRecordedFrames = [];
    } catch (err) {
      this.emit('log', `[record] ${String(err)}`);
    }
  }

  private onNotification(method: string, params: unknown): void {
    if (method === 'session/update') {
      const p = (params ?? {}) as { sessionId?: string; update?: SessionUpdate };
      if (typeof p.sessionId === 'string' && p.update) {
        // Config state is recorded on the client, not by a listener: the
        // translator attaches on the first prompt, and an agent that announces
        // new options between session/new and that point would otherwise be
        // silently ignored (and its model change lost).
        if (p.update.sessionUpdate === 'config_option_update') {
          this.applyConfigOptions(
            p.sessionId,
            p.update['configOptions'] as SessionConfigOption[] | undefined,
          );
        }
        // `_meta` may sit on the notification params, on the update, or both.
        // ACP reserves it for extensions, so it is merged and handed on rather
        // than dropped — never overwriting the agent's own keys.
        const paramsMeta = (p as { _meta?: unknown })._meta;
        const updateMeta = p.update['_meta'];
        const meta = {
          ...(paramsMeta && typeof paramsMeta === 'object' ? (paramsMeta as Record<string, unknown>) : {}),
          ...(updateMeta && typeof updateMeta === 'object' ? (updateMeta as Record<string, unknown>) : {}),
        };
        this.emit('update', p.sessionId, Object.keys(meta).length > 0 ? { ...p.update, _meta: meta } : p.update);
      }
      return;
    }
    // opencode's delegated-run stream: a second stream of `session/update`-shaped frames
    // belonging to the same session as its parent. Handed to the translator, which owns
    // everything the client renders.
    if (method === CHILD_UPDATE_METHOD) {
      const p = (params ?? {}) as { rootSessionId?: unknown };
      if (typeof p.rootSessionId === 'string') {
        this.emit('child', p.rootSessionId, params as ChildSessionEvent);
        return;
      }
    }
    this.emit('log', `[agent] notification ${method}`);
  }

    /**
   * One ACP request, with the clock this repo insists on.
   *
   * The JSON-RPC correlation itself is the SDK's (`conn.agent.request`): it owns the id
   * map, the send queue, `$/cancel_request` and the frame limits, all of which used to be
   * hand-written here. What stays ours is the part that is a *product* decision:
   *
   *  • **the timeout** — an agent that never answers must not hang a request forever.
   *    Expressed through the SDK's `cancellationSignal` + `stopWaitingOnCancel`, which
   *    additionally tells the agent we gave up (a `$/cancel_request`) instead of leaving
   *    it working on something nobody is listening for anymore;
   *  • **the error vocabulary** — callers branch on `AcpError`/`AcpMethodNotFound`, so an
   *    SDK `RequestError` is translated rather than leaked.
   */
  /**
   * One ACP request, with the clock this repo insists on.
   *
   * The JSON-RPC correlation itself is the SDK's (`conn.agent.request`): it owns the id
   * map, the send queue, `$/cancel_request` handling and the frame limits, all of which
   * used to be hand-written here. What stays ours is the part that is a *product*
   * decision:
   *
   *  • **the timeout** — an agent that never answers must not hang a request forever,
   *    and we must tell it we gave up rather than leave it working for nobody. That is
   *    the SDK's `cancellationSignal` + `stopWaitingOnCancel`: the signal's abort reason
   *    is what the promise rejects with, so it carries our own `AcpError('timeout')`;
   *  • **the error vocabulary** — callers branch on `AcpError`/`AcpMethodNotFound`, so
   *    an SDK `RequestError` is translated here rather than leaking out.
   *
   * `timeoutMs === null` and `0` both mean "no clock" (`session/prompt`'s default).
   */
  /**
   * The SDK stream with `_TRACE` and frame recording wrapped around it.
   *
   * The SDK owns reading and writing, so this is the only place between our code and the
   * wire — and it is a message-level seam, which is better than the byte-level one this
   * used to be: a frame is recorded exactly as the connection saw it, and the trace cannot
   * disagree with what was actually exchanged. Taps are pass-through and never await
   * anything the connection depends on, so a slow log cannot stall the protocol.
   */
  private traced(inner: Stream): Stream {
    const trace = Boolean(process.env.OPENCODE_ACP_CLIENT_TRACE);
    // `WritableStream` has no `pipeThrough`; a `TransformStream` is the pair that does.
    // The reader side tees into the recorder, the writer side only traces.
    const inbound = new TransformStream<unknown, unknown>({
      transform: (msg, controller) => {
        // ★ This sits on the RAW inbound stream, BEFORE the SDK's schema validation — which
        // is the only place an unknown `sessionUpdate` value can still be seen. The SDK
        // validates each notification against the generated schema and drops what does not
        // match, so a variant it predates never reaches our handler; iron rule 3 says that
        // must not happen silently. Note it here, then let the SDK do what it does.
        const update = (msg as { params?: { update?: { sessionUpdate?: unknown } } })?.params?.update;
        if (update && typeof update === 'object' && !AcpClient.KNOWN_UPDATES.has(String(update.sessionUpdate))) {
          // ★ Say it in the vocabulary the rest of the repo already uses — the smoke and
          // the translator both speak `unknown session/update: <variant>` — AND say what
          // happens to it. The second half is not decoration: what "unknown" costs changed
          // with the SDK. A variant outside the generated schema is dropped by validation
          // and never reaches the translator, so a reader chasing "why does this render
          // nothing" must not be sent looking in the translator for it.
          this.emit(
            'log',
            `unknown session/update: ${String(update.sessionUpdate)} (dropped by schema validation)`,
          );
          UNKNOWN_UPDATES_SEEN.add(String(update.sessionUpdate));
        }
        if (trace) this.emit('log', `[recv] ${JSON.stringify(msg).slice(0, 4000)}`);
        this.recordFrame(msg as JsonRpcMessage);
        controller.enqueue(msg);
      },
    });
    const outbound = new TransformStream<unknown, unknown>({
      transform: (msg, controller) => {
        if (trace) this.emit('log', `[send] ${JSON.stringify(msg).slice(0, 4000)}`);
        controller.enqueue(msg);
      },
    });
    void inner.readable.pipeTo(inbound.writable).catch(() => undefined);
    void outbound.readable.pipeTo(inner.writable).catch(() => undefined);
    return { readable: inbound.readable, writable: outbound.writable } as Stream;
  }

  /**
   * One `session/update`, dispatched through the SDK's notification handler.
   *
   * Two details ride along that the SDK does not know about:
   *
   *  • **config state is recorded here, not by a listener.** The translator only attaches on
   *    the first prompt, so an agent that announces new options between `session/new` and
   *    that point would otherwise be silently ignored (and its model change lost);
   *  • **`_meta` is merged from both places it can sit** — the notification params and the
   *    update itself — without overwriting the agent's own keys.
   */
  /** The variants this client knows about; anything else is logged, never dropped silently. */
  /**
   * The variants the TRANSLATOR has a branch for — nothing more.
   *
   * ★ This list used to hold every variant the spec defines, including `notice`,
   * `compaction_update` and `compaction_summary_chunk`. Those are not handled anywhere: the
   * translator has no case for them, so an agent that sends one has its update dropped.
   * Listing them as "known" silenced the only signal we had, which is a straight breach of
   * iron rule 3 — measured by smoke scenario 8, which asserts exactly that log line. A
   * variant belongs here only when something downstream acts on it.
   */
  static readonly KNOWN_UPDATES = new Set<string>([
    'agent_message_chunk',
    'agent_thought_chunk',
    'user_message_chunk',
    'tool_call',
    'tool_call_update',
    'plan',
    'available_commands_update',
    'current_mode_update',
    'config_option_update',
    'session_info_update',
    'usage_update',
  ]);

  private async onUpdate(sessionId: string, update: SessionUpdate, paramsMeta?: unknown): Promise<void> {
    // ★ Iron rule 3. The SDK's generated type lists the variants that exist TODAY; an agent
    // running a newer (or its own) revision can send one we have never heard of, and the
    // type cannot stop that at runtime. Say so in the log — the alternative is a silent
    // drop, which is the failure mode this repo is built against.
    if (update.sessionUpdate === 'config_option_update') {
      this.applyConfigOptions(sessionId, update['configOptions'] as SessionConfigOption[] | undefined);
    }
    const updateMeta = update['_meta'];
    const meta = {
      ...(paramsMeta && typeof paramsMeta === 'object' ? (paramsMeta as Record<string, unknown>) : {}),
      ...(updateMeta && typeof updateMeta === 'object' ? (updateMeta as Record<string, unknown>) : {}),
    };
    this.emit('update', sessionId, Object.keys(meta).length > 0 ? { ...update, _meta: meta } : update);
  }

  /**
   * `session/request_permission`, moved behind the SDK's handler.
   *
   * The rule this repo is strictest about survives the move: **an answer always goes
   * back**. With no handler registered the agent is told `cancelled` rather than being
   * left to wait forever, and a handler that throws still produces a JSON-RPC error
   * instead of silence.
   */
  private async answerPermission(req: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (!this.permissionHandler) return { outcome: { outcome: 'cancelled' } };
    return this.permissionHandler(req);
  }

  /**
   * `elicitation/create`. Only `mode: "form"` is advertised, and the spec forbids
   * answering a `url` request with a form — so that is refused rather than faked.
   */
  private async answerElicitation(req: ElicitationRequest): Promise<ElicitationResponse> {
    if (req.mode !== 'form') {
      // ★ A `RequestError`, not our own `AcpError`: the SDK turns an unrecognised throw from a
      // handler into `-32603 Internal error` and buries the original inside
      // `data.details`. The spec wants `-32602 Invalid params` here, and the shipped client
      // (and this repo's smoke test) branch on the code — so the error has to be the type the
      // SDK understands. Measured: the first attempt answered -32603 and scenario 6 failed.
      throw RequestError.invalidParams(
        undefined,
        `only form elicitation is supported (mode=${req.mode === undefined ? 'undefined' : String(req.mode)})`,
      );
    }
    if (!this.elicitationHandler) return { action: 'cancel' };
    return this.elicitationHandler(req);
  }

  private request<T>(
    method: string,
    params: unknown,
    timeoutMs: number | null = this.timeoutMs,
  ): Promise<T> {
    const conn = this.conn;
    if (!conn) return Promise.reject(new AcpError('agent is not running', 'agent-exited'));

    const send = (signal?: AbortSignal): Promise<T> =>
      (async () =>
        (await conn.agent.request(method, params, {
          ...(signal ? { cancellationSignal: signal, stopWaitingOnCancel: true } : {}),
        })) as T)().catch((err: unknown) => {
        // A timeout aborts with our own error; that is the answer, not the SDK's.
        const reason = signal?.aborted ? signal.reason : undefined;
        throw reason instanceof AcpError ? reason : translateSdkError(method, err);
      });

    if (timeoutMs === null || timeoutMs <= 0) return send();

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new AcpError(`timed out waiting for ${method}`, 'timeout'));
    }, timeoutMs);
    timer.unref?.();
    return send(controller.signal).finally(() => clearTimeout(timer));
  }

}

/**
 * The `taskkill` arguments that end an agent AND its descendants on Windows.
 *
 * Windows has no signalable process groups, so the portable `process.kill(-pid)`
 * has nothing to do; `taskkill /T` is the tree walk. `/F` is the force step: the
 * SIGKILL pass uses it, the SIGTERM pass lets the app close first.
 */
/**
 * How to launch the agent command on this platform.
 *
 * ★ On Windows a global npm install is a `.cmd` shim (`opencode.cmd`), and `spawn` cannot
 * execute one: the call fails with `ENOENT` even though the command is right there on PATH.
 * Measured on a Windows 11 VM — `opencode acp` is a real, documented agent command and the
 * bridge could not start it at all (`spawn opencode ENOENT`), which reached the user as
 * "agent exited: ACP connection closed" with no hint about the cause.
 *
 * The fix is `cmd /d /s /c` with `windowsVerbatimArguments`, the same shape `printHelp()`
 * uses and for the same reasons: `shell: true` would re-parse the line and mangle a path
 * with spaces, while the verbatim form passes our quoting through untouched. Only used when
 * the command actually needs it — an `.exe` agent keeps the direct spawn.
 */
export function launchSpec(command: string, args: string[]): { file: string; args: string[]; verbatim: boolean } {
  if (process.platform !== 'win32') return { file: command, args, verbatim: false };
  // ★ A SCRIPT IS NOT AN EXECUTABLE on Windows. `node tests/agent.mjs` works there, but
  // spawning `tests/agent.mjs` directly fails with `spawn EFTYPE` — Windows has no shebang
  // dispatch, so the file is not a runnable image however executable it looks on POSIX. Measured
  // by the entry e2e from Git Bash: `OPENCODE_BIN=/c/oac/tests/fake-opencode-tui.mjs` made the
  // bridge die with `spawn EFTYPE` and the TUI's exit code never propagate.
  //
  // `.cmd`/`.bat` (and a bare name, which PATH may resolve to one) go through cmd; a known
  // script extension goes through the interpreter that owns it.
  const script = /\.(mjs|cjs|js)$/i.test(command)
    ? process.execPath
    : /\.py$/i.test(command)
      ? 'python'
      : undefined;
  if (script !== undefined) return { file: script, args: [command, ...args], verbatim: false };
  const needsShell = !/\.[A-Za-z0-9]+$/.test(command) || /\.(cmd|bat)$/i.test(command);
  if (!needsShell) return { file: command, args, verbatim: false };
  const quote = (value: string): string => (/\s/.test(value) ? `"${value}"` : value);
  const line = [quote(command), ...args.map(quote)].join(' ');
  // The outer pair is cmd's own escaping rule for `/s /c`: everything inside is verbatim.
  return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}

export function windowsKillArgs(pid: number, signal: NodeJS.Signals): string[] {
  return ['/PID', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])];
}
