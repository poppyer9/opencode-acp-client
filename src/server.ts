/**
 * HTTP surface: an opencode v2 compatible server in front of one ACP agent.
 *
 * Route shapes come from opencode's own TUI test fixture plus the backend-oc's proven
 * bridge, so the *contract* is observed rather than guessed. The boot routes
 * below return deliberately boring values — the goal is that the client starts
 * and opens a session, not that every panel is populated yet. Anything the
 * client asks that we do not implement is answered with a truthful empty value
 * rather than a 404, because several client screens treat 404 as fatal.
 */

/**
 * the backend encodes a model choice as a JSON array string `["provider","model"]`.
 * Tolerate a plain `provider/model` or bare `model` too, so a config option
 * shape change degrades instead of producing `undefined/[...]` model ids.
 */
/**
 * The TUI's MCP panel reads `/api/mcp`; ACP has no agent→client MCP list, so the
 * bridge reports the servers configured in the same opencode config the agent
 * reads. This is display metadata only (the agent owns the actual connection):
 * `disabled` is read from the config, everything else is shown as connected.
 */
function configuredMcpServers(): Array<{ name: string; status: { status: 'connected' | 'disabled' } }> {
  const base = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, 'opencode')
    : join(homedir(), '.config', 'opencode');
  const file = process.env.OPENCODE_CONFIG ?? join(base, 'opencode.json');
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      mcp?: Record<string, { disabled?: unknown } | null>;
    };
    return Object.entries(raw.mcp ?? {}).flatMap(([name, entry]) => {
      if (!entry || typeof entry !== 'object') return [];
      return [{ name, status: { status: entry.disabled === true ? 'disabled' : 'connected' } }];
    });
  } catch {
    return [];
  }
}

const CONTEXT_WINDOW_FALLBACK = 1_000_000;

/** Exported for the tests: the accepted spellings are the contract with agents. */
export function modelValueParts(value: string): { providerID?: string; modelID: string } {
  return parseModelValue(value);
}

function parseModelValue(value: string): { providerID?: string; modelID: string } {
  const raw = value.trim();
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.length >= 2) {
        return { providerID: String(parsed[0]), modelID: String(parsed[1]) };
      }
      if (Array.isArray(parsed) && parsed.length === 1) return { modelID: String(parsed[0]) };
    } catch {
      /* fall through to the slash form */
    }
  }
  // `provider::model` — the form dsh's ACP profile advertises in its model option
  // (`acme::model-1`). Missing it made `modelFromConfigOptions` return
  // undefined, so the "already on this model" short-circuit below never fired: the TUI
  // re-posts its selection before every prompt, that re-post reached the agent, and the
  // agent refuses a config switch while a prompt runs — the reply was a 400, and the TUI
  // then retried instead of sending the prompt (owner: "a second message does nothing").
  const doubleColon = raw.indexOf('::');
  if (doubleColon > 0) {
    return { providerID: raw.slice(0, doubleColon), modelID: raw.slice(doubleColon + 2) };
  }
  const slash = raw.indexOf('/');
  if (slash > 0) return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) };
  return { modelID: raw };
}

import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { AcpClient, AcpError } from './acp/client.js';
import { filterPromptBlocks } from './acp/capabilities.js';
import { UPDATE } from './acp/types.js';
import type {
  ElicitationProperty,
  ElicitationRequest,
  ElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
  SessionUpdate,
} from './acp/types.js';
import {
  EVENT,
  type FormAnswer,
  type FormField,
  type FormFieldOption,
  type FormInfo,
  type Location,
  type PromptBody,
  type ShellRecord,
} from './contract.js';
import { historyFromReplay } from './acp-replay.js';
import type { HistoryEntry } from './acp-replay.js';
import { projectMessage, specMessageId } from './project.js';
import type { Message, TextPart } from './contract.js';
import { BridgeState, type SessionRecord } from './state.js';
import {
  agentBindingLabel,
  SessionMap,
  sessionMapPath,
  type AgentBinding,
} from './session-map.js';
import { SseHub } from './sse.js';
import { AcpTranslator } from './translate/events.js';

/** Reported by /api/info. Clients compare it against their own build. */
/** The provider/agent id opencode sees before a backend has named itself. */
const SHELL_RESPONSE_TIMEOUT_MS = 120_000;

const PLACEHOLDER_BACKEND = 'acp';
// The client warns when the server's version does not match its own build
// ("Server at … has version 2.0.26; this client is 2.0.30. Continuing anyway"). The
// surface we serve is the published v2 OpenAPI. The launcher passes the ACTUAL
// resolved client binary's version (v2.0.32 or v2.1.0) so the TUI's own version
// check matches; this is only the fallback for direct BridgeServer construction.
const CLIENT_VERSION_HINT = '2.1.0';

/**
 * The launch command as one readable line, for the footer when the agent never names
 * itself. Three rules, each learned from what the line looks like on screen:
 *   - a value behind a secret-looking flag (`--token`, `--api-key`, `--password`, …) is
 *     masked, since this line is on screen and in screenshots;
 *   - absolute paths are shortened to their tail, because the footer is narrow and
 *     `node /Users/me/very/deep/tree/agent.mjs` spends the whole width on one directory;
 *   - the whole thing is capped, because a long `npx …` invocation would push the layout.
 *
 * Note the client title-cases this field (`Locale.titlecase` in its footer), so `bash` will
 * read `Bash`. Passing the command verbatim is still the point: it stays a truthful
 * identifier even when its capitals are not ours to choose.
 */
export function displayAgentCommand(command: string): string {
  const secret = /^(-{1,2})?[\w-]*(token|key|apikey|secret|password|passwd|pwd|auth)[\w-]*$/i;
  const words = command
    .trim()
    .split(/\s+/)
    // `/a/b/c/agent.mjs` → `agent.mjs`; a bare word, a flag or `--k=v` is left alone.
    .map((word) => (word.startsWith('/') && !word.includes('=') ? word.slice(word.lastIndexOf('/') + 1) : word));
  const masked = words.map((word, index) => {
    const previous = words[index - 1] ?? '';
    // `--token=abc` carries its value in the same word; `--token abc` in the next one.
    const equals = word.startsWith('-') ? word.indexOf('=') : -1;
    const name = equals === -1 ? word : word.slice(0, equals);
    if (secret.test(name) && word.startsWith('-')) {
      return equals === -1 ? word : `${name}=***`;
    }
    // The word AFTER a secret flag is that flag's value — unless it is another flag.
    if (secret.test(previous) && previous.startsWith('-') && !word.startsWith('-')) return '***';
    return word;
  });
  const line = masked.join(' ');
  const LIMIT = 80;
  return line.length <= LIMIT ? line : `${line.slice(0, LIMIT - 1)}…`;
}

export interface BridgeServerOptions {
  /** Command that launches the ACP agent, `my-agent`. */
  command: string;
  args?: string[];
  /** Working directory exposed to the client and passed to `session/new`. */
  directory: string;
  host?: string;
  port?: number;
  /**
   * The resolved opencode client binary's version (e.g. `2.1.0`). `/api/info`
   * reports it so the launched TUI does not warn that the server is older than
   * itself; the launcher always knows this before it starts the TUI.
   */
  clientVersion?: string;
  /** Extra env for the agent process. */
  env?: Record<string, string | undefined>;
  /**
   * An existing the backend session to continue instead of creating one: the
   * AGENT's own id (a UUID), translated from what the user typed by the
   * launcher via the session map. This is what `session/load` is asked for.
   */
  resumeSession?: string;
  /**
   * The id the user TYPED for `--session` (the visible `ses_…`). The TUI is
   * launched with this id and asks for it, so the pre-created session must be
   * keyed by it too — otherwise the TUI's request misses the record, falls to
   * the adoption path, and a SECOND agent process loads the same backend
   * session. Measured: with the translated UUID as the pre-created record's
   * id, dsh (one writer per session) refused the second load and the TUI opened
   * an empty conversation wearing a title this bridge had marked as not-resumed.
   */
  resumeVisibleSessionId?: string;
  /**
   * `-c`/`--continue`: the launcher wants the NEWEST conversation, imported via
   * session/list. With this set the pre-created record does NOT eagerly spawn
   * an agent: two concurrent agent processes on one workspace measured as a
   * refused load (dsh: one writer per workspace — the eager shell's session/new
   * plus the adopted conversation's session/load = "Internal error" twice, then
   * a blank "resumed" conversation). The empty record still exists for the
   * routes that need one; nothing spawns until the user actually prompts it.
   */
  continueMode?: boolean;
  /**
   * Why `-c` had nothing to continue, so the fallback can name the cause instead
   * of leaving a directory title looking like a continuation that lost its
   * history. `no-list` is a CAPABILITY gap (the agent has no `session/list`).
   */
  continueModeReason?: 'no-list' | 'nothing' | 'failed';
  /**
   * Eagerly bring up the FIRST agent session (and with it the model catalog the
   * agent advertises) instead of waiting for the first prompt. Set by the
   * wrapped-subcommand bridge: `oc-acp-client models -- <agent>` has no
   * prompt coming — nobody would ever start the agent — and `models` answers
   * from the catalog, so without this the answer is the `acp/default`
   * placeholder no matter which agent is attached. The TUI never sets this:
   * its sessions are per-tab and start on the first message.
   */
  eagerCatalog?: boolean;
  onLog?: (line: string) => void;
}

interface PendingPermission {
  sessionId: string;
  requestId: string;
  request: RequestPermissionRequest;
  resolve: (answer: RequestPermissionResponse) => void;
}

/** One form the TUI is showing, and the elicitation waiting behind it. */
interface PendingForm {
  form: FormInfo;
  resolve: (answer: ElicitationResponse) => void;
}

export class BridgeServer {
  private readonly state = new BridgeState();
  /**
   * The most recently PROMPTED session's visible id. The single strongest signal
   * about "which conversation did the user actually use this run", because the
   * bridge sets it itself at the top of the prompt handler. Undefined until the
   * user actually sends a message.
   *
   * Read through `promptedSessionId()` — deliberately in memory, not over HTTP:
   * the exit epilogue reads it while shutting down, and a fetch at that moment
   * raced the listener closing (measured: the line kept the TUI's native one).
   */
  private lastPromptedSessionId: string | undefined;
  /**
   * The most recently VIEWED session's visible id: set by `POST /api/session/:id/view`
   * and by the singular `GET /api/session/:id`.
   *
   * Wider than "prompted" on purpose. Resuming a session and leaving without
   * typing never reaches the prompt path, and keying the exit epilogue off
   * prompts alone made the bridge fall back to the TUI's native
   * `opencode -s <visible id>` line — which names neither this product nor an id
   * the native daemon knows. It ranks BELOW the user's own `--session`/`-c`
   * intent, though: with several restored tabs the client hydrates each one in
   * turn, so this can end up naming a tab the user never opened.
   */
  private lastViewedSessionId: string | undefined;
  private readonly hub: SseHub;
  private readonly agents = new Map<string, AcpClient>();
  /**
   * One ACP connection per (command, args) — the agent program, not the tab.
   *
   * ACP sessions are independent on one connection (dsh's `acp` profile ships this shape: one
   * stdio connection, many session tabs), and a whole agent process per tab is what
   * made every new tab pay a cold start. Sessions still keep their own catalog
   * (`AcpClient` tracks config per session id) and their own translator; only the
   * process is shared.
   */
  private readonly pools = new Map<string, AcpClient>();
  /**
   * The transcript load a *read* is currently waiting on. See the `/message` route: one
   * at a time, because a client hydrates every remembered tab at once and each of those
   * loads belongs to its own agent process here (unlike the native single-process server,
   * where it is a database read). A second read while one is in flight answers from what
   * we have instead of starting another load — that is what makes tab hydration lazy.
   */
  private readLoad: { sessionId: string; done: Promise<void> } | null = null;
  /**
   * Sessions whose transcript read was answered WITHOUT loading, because another
   * tab was mid-load. If one of them turns out to be the tab on screen (the
   * startup burst can invert), it is loaded as soon as the focus signal arrives —
   * one extra load, never the whole burst.
   */
  private deferredLoads = new Set<string>();
  /**
   * The session the client is looking at, for the model catalog.
   *
   * `/api/model` carries only `location[directory]` — no session id — yet the catalog must
   * be the one of the tab's OWN agent: two tabs may be bound to dsh and to opencode, and
   * offering dsh's models on the opencode tab means every pick is rejected by the agent.
   * A tab switch makes the client read that session (mount sync); the startup tab
   * prefetch reads many sessions in one burst. So a read only moves the focus when it
   * arrives after a quiet gap — the visible mount comes first at connect, the prefetch
   * lands inside the same second and is ignored — while a human tab switch always does.
   */
  private focus: { id: string; at: number } | undefined;
  /**
   * Which agent each record's translator is already listening to. Needed because a
   * translator can exist BEFORE an agent does (a turn that failed to start still has
   * to render its own failure), and the listener must be wired exactly once per
   * agent — not once per translator.
   */
  private readonly wiredTranslators = new Map<string, AcpClient>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  /** Forms the TUI is showing and the agent is still waiting on, by form id. */
  private readonly pendingForms = new Map<string, PendingForm>();
  /** One best-effort session/list import per workspace, so startup does not spawn repeatedly. */
  private readonly discoveredSessionDirectories = new Set<string>();
  private readonly discoveringSessionDirectories = new Map<string, Promise<void>>();
  private server: http.Server | null = null;
  /** Set by `listen()`; `ServerInfo.urls` reports it back to the client. */
  private listenUrl = '';
  private readonly log: (line: string) => void;
  private readonly clientVersion: string;

  constructor(private readonly options: BridgeServerOptions) {
    this.clientVersion = options.clientVersion ?? CLIENT_VERSION_HINT;
    this.sessionMap = new SessionMap((line) => this.log(line));
    this.hub = new SseHub();
    this.log = options.onLog ?? ((line) => process.stderr.write(`${line}\n`));
  }

  get location(): Location {
    // No `workspaceID`. The client keys every location-scoped catalog by
    // `JSON.stringify([directory, workspaceID])`, and it asks with no workspace
    // (`?location[directory]=...`), so an invented id publishes the catalog under
    // one key and looks it up under another — every list then reads as empty.
    // Omitting it keeps both sides on `[directory, null]`.
    return {
      directory: this.options.directory,
      project: {
        id: this.projectId,
        directory: this.options.directory,
        canonical: this.options.directory,
      },
    };
  }

  /**
   * Stable id for the project we serve. Not a workspace: see `location`.
   * Lazy because class field initialisers run before the constructor assigns
   * `options`.
   */
  private get projectId(): string {
    return `proj_${createHash('sha1').update(this.options.directory).digest('hex').slice(0, 12)}`;
  }

  /**
   * The agent command this bridge was launched with — the default owner for new sessions.
   *
   * ACP never says which agent owns a session (`session/resume`/`load` just take an id), so a
   * remembered tab from another backend would otherwise be resumed into whatever agent this
   * run launched: measured, a session created with `opencode acp` reopened under `dsh` gave an
   * empty tab with nothing on screen explaining why. The session map records the binding, and
   * a restored tab is reattached with ITS agent instead.
   */
  private agentBinding(): AgentBinding {
    return { command: this.options.command, args: this.options.args ?? [] };
  }

  async listen(): Promise<{ host: string; port: number }> {
    const host = this.options.host ?? '127.0.0.1';
    this.server = http.createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        this.log(`[bridge] request failed: ${String(err)}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
        }
        res.end(JSON.stringify({ error: String(err) }));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.options.port ?? 0, host, resolve));
    if (this.options.eagerCatalog) {
      // Wrapped-subcommand mode: no prompt will ever arrive, so the agent (and
      // its catalog) must come up now. Errors are the honest empty answer: the
      // health route still serves, `models` then lists the placeholder.
      void this.ensureAgent(this.ensureSession()).catch((err) => {
        this.log(`[bridge] eager catalog failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    const address = this.server.address();
    const port = typeof address === 'object' && address ? address.port : (this.options.port ?? 0);
    this.listenUrl = `http://${host}:${port}`;
    return { host, port };
  }

  /** Where this server is reachable, for `ServerInfo.urls`. */
  private url(): string {
    return this.listenUrl;
  }

  async close(): Promise<void> {
    this.hub.closeAll();
    for (const shell of [...this.shells.values()]) this.killShell(shell);
    // One connection may back several sessions: dispose each pool once.
    for (const agent of [...this.pools.values()]) await agent.dispose();
    this.pools.clear();
    this.agents.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  // ---------------------------------------------------------------- routing

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();
    const body = method === 'POST' || method === 'PATCH' ? await readJson(req) : undefined;

    // Trace every request. Without this the only visible traffic is *unhandled*
    // routes, which makes "the client did nothing" indistinguishable from "the
    // client called something we handled". Set OPENCODE_ACP_CLIENT_TRACE=0 to quiet it.
    if (process.env.OPENCODE_ACP_CLIENT_TRACE !== '0') {
      const qs = url.search && url.search !== '?' ? ` ${url.search}` : '';
      const summary = body === undefined ? '' : ` body=${JSON.stringify(body).slice(0, 120)}`;
      this.log(`[http] ${method} ${path}${qs}${summary}`);
    }

    const json = (data: unknown, status = 200): void => {
      if (process.env.OPENCODE_ACP_CLIENT_TRACE !== '0') this.log(`[http] -> ${status} ${method} ${path}`);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const noContent = (): void => {
      if (process.env.OPENCODE_ACP_CLIENT_TRACE !== '0') this.log(`[http] -> 204 ${method} ${path}`);
      res.writeHead(204);
      res.end();
    };
    // The spec's envelope carries `Location.PublicRef`, which is `{directory}`
    // and nothing else (`additionalProperties: false`). The rich location — with
    // `project` — belongs to `/api/location`, whose schema is `Location.PublicInfo`.
    // The desktop is multi-workspace: it asks with `?location[directory]=<path>`, and
    // it filters payloads by the directory they carry. Stamping every envelope with
    // the bridge's own directory therefore made the agent and model lists, though
    // populated, count as belonging to another workspace — the composer then refused
    // with "select an agent and a model". Answer for the directory that was asked
    // about; fall back to ours when the client asks for nothing (the TUI does that).
    const asked = new URL(req.url ?? '/', 'http://localhost').searchParams.get('location[directory]');
    const envelopeDirectory = asked && asked.length > 0 ? asked : this.location.directory;
    const located = (data: unknown): void =>
      json({ location: { directory: envelopeDirectory }, data });

    // The desktop renderer is a browser page (origin `oc://renderer`), so every request
    // that is not a simple GET is preflighted; without these headers the browser blocks
    // it before it reaches us. The exported debug log shows exactly that:
    // "Access to fetch at '.../api/session/<id>/model' from origin 'oc://renderer' has
    // been blocked by CORS policy". The TUI never hit it: it is an HTTP client, not a page.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    res.setHeader(
      'access-control-allow-headers',
      (req.headers['access-control-request-headers'] as string | undefined) ?? '*',
    );
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── events ────────────────────────────────────────────────────────────
    if (path === '/api/event' && method === 'GET') {
      const response = this.hub.connect({
        lastEventId: req.headers['last-event-id'] as string | undefined,
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      const reader = response.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
      return;
    }

    // ── sessions ──────────────────────────────────────────────────────────
    if (path === '/api/session' && method === 'GET') {
      this.ensureSession(asked);
      // The client remembers only the bridge-visible `ses_…` id, while ACP session/list
      // knows the agent's id and (when supplied) its title. Import titled entries once per
      // workspace so old conversations get a stable visible alias, their agent id is saved in
      // SessionMap, and clicking them can call session/load instead of inventing a blank tab.
      await this.discoverAgentSessions(envelopeDirectory);
      // ★ The query the client sends is part of the contract, not decoration. This route
      // used to answer with every session it held whatever was asked, which is invisible
      // while there is one session per workspace and wrong as soon as there are more: the
      // TUI opens its list with `parentID=null&archived=false`, so anything without those
      // filters would start listing subagent sessions and archived ones among the
      // conversations. Semantics follow the published store
      // (`packages/core/src/session/store.ts`, `SessionStore.list`).
      const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
      json({
        location: this.location,
        data: sessionListQuery(this.state.all().map((r) => r.session), query),
        cursor: {},
      });
      return;
    }
    if (path === '/api/session' && method === 'POST') {
      // The client sends the workspace in the BODY here (`SessionCreateInput.location`),
      // unlike the `?location[directory]=` most GETs carry. After a first-screen `/cd`
      // this is how a new session lands in the switched-to directory; ignoring it made
      // the agent run in the bridge's own directory while the UI showed the new one.
      const bodyDirectory = (
        (body as { location?: { directory?: unknown } } | undefined)?.location
      )?.directory;
      const directory =
        typeof bodyDirectory === 'string' && bodyDirectory.length > 0
          ? bodyDirectory
          : envelopeDirectory;
      const sessionLocation = {
        directory,
        project: { id: projectIdFor(directory), directory, canonical: directory },
      };
      const createdTitle = titleFrom(body);
      const requestedId = sessionIdFrom(body);
      const requestedAgent = typeof (body as { agent?: unknown } | undefined)?.agent === 'string'
        ? (body as { agent: string }).agent
        : undefined;
      // ★ Adopt the pre-created shell instead of leaving a duplicate. Without this a fresh
      // TUI conversation ended with TWO sessions (an empty one titled after the directory)
      // and TWO agent processes: the shell's, warmed for the catalog, and the new record's
      // first turn. Reusing it keeps one session and one agent, and the catalog it already
      // fetched stays valid.
      const shell = this.state
        .all()
        .find(
          (candidate) =>
            candidate.precreated === true &&
            candidate.messages.length === 0 &&
            !candidate.busy &&
            canonicalPath(candidate.directory ?? this.options.directory) === canonicalPath(directory),
        );
      if (shell) {
        const oldId = shell.session.id;
        const adoptId = requestedId ?? oldId;
        // Compare IDS, not objects: `state.rekey` mutates and returns the same record, so
        // `record !== shell` was false and the per-session maps (agent, translator) stayed
        // keyed by the old id — the first prompt then found no agent, spawned a second one
        // and re-ran the resume branch ("cannot resume … Starting a NEW conversation"),
        // which is exactly the duplicate this was meant to remove.
        const adopted = adoptId === oldId ? shell : this.state.rekey(oldId, adoptId);
        if (adopted) {
          shell.precreated = false;
          if (adoptId !== oldId) this.rekeySession(oldId, adoptId, adopted);
          if (createdTitle) {
            adopted.session.title = createdTitle;
            adopted.titleFromUser = true;
          }
          adopted.session.time = { ...adopted.session.time, updated: Date.now() };
          adopted.session.location = { ...adopted.session.location, directory };
          adopted.session.directory = directory;
          adopted.session.projectID = projectIdFor(directory);
          if (requestedAgent) {
            await this.applyRequestedMode(adopted, requestedAgent, {
              emitSelected: false,
              failOnUnsupported: false,
            });
          } else if (!adopted.session.agent) {
            const initialMode =
              this.sessionMap.modeFor(adopted.session.id) ?? this.defaultModeFor(adopted);
            if (initialMode) adopted.session.agent = initialMode;
          }
          // Creating a session is a deliberate tab switch, not a startup prefetch read:
          // make it the focus, so the model catalog the client asks for next is THIS
          // session's agent (the one the user launched), not whichever restored tab the
          // client happened to read first.
          this.focus = { id: adopted.session.id, at: Date.now() };
          json({ location: this.location, data: adopted.session });
          return;
        }
      }
      const record = this.state.createSession(sessionLocation, createdTitle, requestedId);
      // A title the client asked for at creation is the user's, not a default.
      if (createdTitle) record.titleFromUser = true;
      // Remember whose workspace this is: the agent must run *there*, not in the
      // bridge's own directory — and the session object must say the same, because
      // the footer and the sidebar read `session.location.directory`.
      record.directory = directory;
      // Seed the session's model from the catalog *only* when it is a real one. The
      // pre-ACP catalog is a single placeholder (`acp/default`); storing that as the session's
      // model made the assistant card's footer render `acp/unknown` — the card looks the
      // message's model up in the catalog and falls back to `${providerID}/${id}` when it is
      // absent, which a placeholder can never match. A session created before the agent reports
      // its models now stays unset and is backfilled by `adoptCatalogModels` below.
      // This ACP session's own catalog, never another session's: one process drives
      // one agent, but each ACP session advertises its own config options. The
      // global catalog is only the same agent's pre-spawn fallback.
      let catalog = this.modelCatalog(record).models[0] as { providerID?: string; modelID?: string } | undefined;
      if (!catalog || !this.isRealModel(catalog as Record<string, unknown>)) {
        // A session created after startup: its own agent may not be spawned yet, but
        // one client drives one agent, so the global catalog is the same agent's.
        const fallback = this.defaultModel();
        if (fallback) catalog = { providerID: fallback.providerID, modelID: fallback.modelID };
      }
      if (catalog?.providerID && catalog.modelID && this.isRealModel(catalog as Record<string, unknown>)) {
        record.model = { providerID: catalog.providerID, modelID: catalog.modelID };
      }
      if (requestedAgent) {
        await this.applyRequestedMode(record, requestedAgent, {
          emitSelected: false,
          failOnUnsupported: false,
        });
      } else {
        const initialMode =
          this.sessionMap.modeFor(record.session.id) ?? this.defaultModeFor(record);
        if (initialMode) record.session.agent = initialMode;
      }
      this.hub.emit({
        type: EVENT.sessionCreated,
        // `sessionID` *and* `session`: the client's store keys off
        // `event.data.sessionID` (and syncs whatever it finds there), so sending
        // only `session` makes it ask for `GET /api/session/undefined` — which is
        // exactly what the real TUI did before this was fixed.
        data: { sessionID: record.session.id, session: record.session },
        location: this.location,
      });
      this.focus = { id: record.session.id, at: Date.now() };
      // The envelope carries the session's own directory, not the query's: a desktop
      // client filters payloads by the directory they carry, and the session we just
      // built belongs to `directory`, which the body may have named differently.
      json({ location: { directory }, data: record.session });
      return;
    }
    // The TUI only enables its composer on a *session route* (`!session` guards
    // everywhere in packages/tui). It does not create one on submit, so the
    // bridge guarantees at least one session exists and reports it as active.
    if (path === '/api/session/active' && method === 'GET') {
      // A MAP of sessionId -> status, but only the sessions that are actually
      // running. The client hydrates with
      // `Object.keys(active).map((id) => [id, "running"])` — it never reads the
      // values — so listing idle sessions marks them all as running and the TUI
      // shows a permanent spinner with "esc interrupt".
      //
      // The key set must therefore be exactly the running sessions; an idle
      // bridge answers `{}`.
      this.ensureSession(asked);
      // The value is `SessionActive` = `{type: "running"}`; only the *key set*
      // matters to the client, but the spec is explicit about the value shape.
      const statuses: Record<string, { type: string }> = {};
      for (const record of this.state.all()) {
        if (record.busy) statuses[record.session.id] = { type: 'running' };
      }
      json({ location: this.location, data: statuses });
      return;
    }

    // MUST precede the generic session match below: `/api/session/:id` accepts
    // any trailing path, so it would swallow `/permission/:requestID/reply` and
    // answer 204 without ever resolving the pending ACP request — the approval
    // dialog then hangs forever.
    const permissionMatch = /^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/.exec(path);
    if (permissionMatch && method === 'POST') {
      const answered = this.replyPermission(
        decodeURIComponent(permissionMatch[1]!),
        decodeURIComponent(permissionMatch[2]!),
        body,
      );
      // 404 for an unknown request: the terminal answer the TUI needs to recover instead of
      // sitting on a dialog it believes it answered.
      if (!answered) {
        json({ error: 'permission request not found' }, 404);
        return;
      }
      noContent();
      return;
    }

    // Literal `/api/session/<word>` routes. These are NOT session ids, so they
    // have to be answered before the generic `:id` match below or they resolve
    // to a 404 and the caller dereferences undefined — `/stats` crashed the TUI
    // with exactly that.
    // The TUI calls the `experimental/` spelling, which is not in the SDK types
    // at all — only the real request log shows it. Accept both.
    if ((path === '/api/session/stats' || path === '/api/experimental/session/stats') && method === 'GET') {
      located(this.emptyStats());
      return;
    }
    if (path === '/api/session/import' && method === 'POST') {
      noContent();
      return;
    }

    // `session.wait` lives under /api/experimental/session/:id/wait, so the plain session
    // matcher below would miss it and the generic fallback would answer 200 with an array —
    // a status the client does not accept for this route. Route it through the same session
    // handler so it can wait on the record and answer the declared 204.
    // `session.export` lives under /api/experimental/session/:id/export — `/copy` and
    // `/export` fetch the whole transcript through it. Routed through the session handler
    // so it can serve the merged view instead of the generic array fallback (an array made
    // the client dereference `transcript.info` on an Array and fail every copy).
    const exportMatch = /^\/api\/experimental\/session\/([^/]+)\/export$/.exec(path);
    if (exportMatch && method === 'GET') {
      await this.handleSessionRoute(
        req,
        res,
        method,
        decodeURIComponent(exportMatch[1]!),
        '/export',
        body,
        json,
        located,
        noContent,
      );
      return;
    }

    const waitMatch = /^\/api\/experimental\/session\/([^/]+)\/wait$/.exec(path);
    if (waitMatch && method === 'POST') {
      await this.handleSessionRoute(
        req,
        res,
        method,
        decodeURIComponent(waitMatch[1]!),
        '/wait',
        body,
        json,
        located,
        noContent,
      );
      return;
    }

    const sessionMatch = /^\/api\/session\/([^/]+)(\/.*)?$/.exec(path);
    if (sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1]!);
      const rest = sessionMatch[2] ?? '';
      await this.handleSessionRoute(req, res, method, sessionId, rest, body, json, located, noContent);
      return;
    }

    // ── permissions / forms (list) ─────────────────────────────────────────
    if (path === '/api/permission/request' && method === 'GET') {
      located(
        [...this.pendingPermissions.values()].map((p) => ({
          id: p.requestId,
          sessionID: p.sessionId,
          tool: p.request.toolCall?.title ?? p.request.toolCall?.kind ?? 'tool',
          options: p.request.options ?? [],
        })),
      );
      return;
    }
    // Pending forms, location-wide. This is the route the TUI polls for a form
    // that is not owned by a session (`session.selected.form.list("global")`),
    // and the one `form.request.list` resolves to.
    if (path === '/api/form/request' && method === 'GET') {
      located([...this.pendingForms.values()].map((pending) => pending.form));
      return;
    }
    // The TUI polls this alongside the permission queue; an empty list is a
    // truthful "nothing to ask you right now".
    if (path === '/api/form' && method === 'GET') {
      located([...this.pendingForms.values()].map((pending) => pending.form));
      return;
    }

    // ── server identity ───────────────────────────────────────────────────
    // The client refuses to attach without this: `server-connection.resolve`
    // treats a non-200 here as fatal, so it is the first thing it asks for.
    // BARE, like /api/location: the client reads `version` at the top level and
    // warns `Server … has version undefined` if it is wrapped in the envelope.
    if (path === '/api/info') {
      // `ServerInfo`: version, pid, urls and paths are required, and the schema
      // forbids extras — so no `healthy` here, however tempting.
      json({
        version: this.clientVersion,
        pid: process.pid,
        urls: [this.url()],
        paths: { tmp: tmpdir() },
      });
      return;
    }

    // v2.0.0's `/pair` screen reads this one and calls `urls.some(...)` on it — we
    // did not serve the route, so our shape-correct empty envelope (`[]`, no
    // `urls`) made the client throw `TypeError: undefined is not an object
    // (evaluating 'V.urls.some')` and crash (measured by running the whole gate
    // against 2.0.0). The schema is `{urls: string[]}`; `/api/info` already has
    // the same field.
    if (path === '/api/server') {
      json({ urls: [this.url()] });
      return;
    }

    // v2.2.0's TUI reads the location's Console budgets on startup (it renders usage
    // alerts from them). ACP says nothing about a Console, so the honest answer is the
    // declared `data: null` ("no limits known here") — not the catch-all empty array,
    // which is the wrong shape for `UsageLimits.Info | null` and logged as unhandled.
    if (path === '/api/experimental/usage/limits') {
      located(null);
      return;
    }

    // The health probe the *desktop* app gates "Add server" on. opencode split
    // this out of `/api/info` after 2.0.27 — current source has no `/api/info` at
    // all — so a bridge that serves only one of them is incompatible with half the
    // clients. Both are served, and the probe only checks `healthy === true` and
    // that `version` is a string.
    if (path === '/api/health') {
      json({ healthy: true, version: this.clientVersion, pid: process.pid });
      return;
    }

    // ── boot routes: the client will not start without these ───────────────
    // Values are intentionally minimal but well-formed (see the module note).
    if (path === '/path') {
      json({
        home: process.env.HOME ?? '',
        state: this.options.directory,
        config: this.options.directory,
        worktree: this.options.directory,
        directory: this.options.directory,
      });
      return;
    }
    if (path === '/config/providers') {
      json({ providers: {}, default: {} });
      return;
    }
    if (path === '/config' || path === '/mcp' || path === '/provider/auth' || path === '/session/status') {
      json({});
      return;
    }
    if (path === '/provider') {
      json({ all: [], default: {}, connected: [] });
      return;
    }
    if (path === '/experimental/capabilities') {
      json({ backgroundSubagents: false });
      return;
    }
    if (path === '/experimental/console') {
      json({ consoleManagedProviders: [], switchableOrgCount: 0 });
      return;
    }
    if (
      ['/agent', '/command', '/formatter', '/lsp', '/experimental/workspace', '/experimental/workspace/status'].includes(
        path,
      )
    ) {
      json([]);
      return;
    }
    // NOTE: `/api/location` is a *bare* location, not the {location,data}
    // envelope. The client feeds `directory`/`canonical` straight into a path
    // helper, so an array here crashes it with
    // `The "to" property must be of type string, got undefined`.
    // `POST /api/location/reload` — the TUI's `/reload`. The declaration is
    // `successStatus: 204`, and the generic unknown-route fallback (200 + an array) is
    // outside the declared set, so it showed up as `UnexpectedStatus` after the
    // "Reloading configuration…" toast. This bridge holds its configuration in the
    // process arguments; there is nothing to reload, and 204 says exactly that.
    if (path === '/api/location/reload' && method === 'POST') {
      noContent();
      return;
    }
    if (path === '/api/location') {
      // The rich location for the workspace being asked about, not necessarily ours:
      // the client keys its per-workspace state off this directory.
      const dir = envelopeDirectory;
      json({
        directory: dir,
        project: {
          id: dir === this.location.directory ? this.location.project.id : projectIdFor(dir),
          directory: dir,
          canonical: dir,
        },
      });
      return;
    }
    if (path === '/api/plugin') {
      located([]);
      return;
    }
    if (path === '/api/vcs') {
      json({
        location: { directory: envelopeDirectory },
        data: { branch: { current: currentBranch(envelopeDirectory), default: 'main' } },
      });
      return;
    }
    if (path === '/api/agent' && method === 'GET') {
      // The composer refuses to submit when `local.agent.current()` is empty,
      // and it does so *silently* (no toast, text stays in the box), which is
      // indistinguishable from "the bridge is broken". When the ACP agent
      // advertises `category: "mode"` config options or ACP v1 `modes`, project
      // each mode as an Agent.Info so `Shift+Tab` / `/agents` switches modes;
      // otherwise advertise a single primary agent that mirrors the ACP session.
      const focused = this.focusRecord();
      if (!this.modeOptionFor(focused)) {
        await this.ensureCatalogSession(focused, asked, 'the agent catalog');
      }
      located(this.agentCatalog(focused));
      return;
    }
    {
      const agentMatch = /^\/api\/agent\/([^/]+)$/.exec(path);
      if (agentMatch && method === 'GET') {
        const wanted = decodeURIComponent(agentMatch[1]!);
        const focused = this.focusRecord();
        if (!this.modeOptionFor(focused)) {
          await this.ensureCatalogSession(focused, asked, 'the agent catalog');
        }
        const found = this.agentCatalog(focused).find((entry) => entry['id'] === wanted);
        if (!found) {
          json({ error: `agent not found: ${wanted}` }, 404);
          return;
        }
        located(found);
        return;
      }
    }
    // ── shell (`!` mode) ──────────────────────────────────────────────────
    // The TUI creates a command here and then *polls* for its output; nothing
    // is streamed. `session.shell.started/ended` render the transcript row.
    if (path === '/api/shell' && method === 'GET') {
      // Only in-flight shells, which is what the client's live table is for and what it says:
      // "Currently running shell commands… Entries are removed once the command exits or is
      // deleted, so this only ever holds in-flight shells"
      // (packages/client/src/solid/data.ts). Its shell row derives
      // `backgroundRunning = Boolean(id && data.shell.get(id))` from this list, so listing an
      // exited shell made every reopened `!command` card spin forever. The record itself is kept
      // and stays queryable — the official viewer's final read after exit is
      // `GET /api/shell/:id/output`, which must still answer.
      located(
        [...this.shells.values()]
          .filter((sh) => sh.status === 'running')
          .map((sh) => this.shellInfo(sh)),
      );
      return;
    }
    if (path === '/api/shell' && method === 'POST') {
      const shellBody = (body ?? {}) as { command?: { command?: string; cwd?: string; timeout?: number } };
      const command = shellBody.command?.command;
      if (!command) {
        json({ error: 'shell command required' }, 400);
        return;
      }
      // The global route still announces itself. It has no session of its own — it is
      // the "run a command via the API" surface — so it uses the current session, which
      // is what it did before the session-scoped route started passing its own id. The
      // smoke suite asserts `session.shell.started` here, and it caught the regression
      // when this call stopped passing one.
      const record = this.startShell(command, shellBody.command?.cwd, this.state.all()[0]?.session.id);
      located(this.shellInfo(record));
      return;
    }
    {
      const shellMatch = /^\/api\/shell\/([^/]+)(\/output)?$/.exec(path);
      if (shellMatch) {
        const id = decodeURIComponent(shellMatch[1]!);
        const record = this.shells.get(id);
        if (!record) {
          json({ error: 'shell not found' }, 404);
          return;
        }
        if (shellMatch[2] === '/output' && method === 'GET') {
          const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
          // Shell.Output is byte-addressed in the published v2 schema. JavaScript string
          // `.length` / `.slice()` counts UTF-16 code units, so non-ASCII output made cursor
          // pagination repeat, skip or corrupt data in the official TUI viewer.
          const captured = Buffer.from(record.output, 'utf8');
          const size = captured.length;
          const rawCursor = Number(query.get('cursor') ?? '0');
          const cursor = Number.isFinite(rawCursor) && rawCursor > 0 ? Math.floor(rawCursor) : 0;
          const rawLimit = query.get('limit');
          const parsedLimit = rawLimit === null ? 64 * 1024 : Number(rawLimit);
          const limit = Number.isFinite(parsedLimit) && parsedLimit >= 0 ? Math.floor(parsedLimit) : 64 * 1024;
          if (cursor >= size) {
            json({
              location: { directory: this.location.directory },
              data: { output: '', cursor: size, size, truncated: false },
            });
            return;
          }
          const start = Math.max(0, cursor);
          const end = Math.min(size, start + limit);
          json({
            location: { directory: this.location.directory },
            data: {
              output: captured.subarray(start, end).toString('utf8'),
              cursor: end,
              size,
              truncated: false,
            },
          });
          return;
        }
        if (method === 'GET') {
          located(this.shellInfo(record));
          return;
        }
        if (method === 'DELETE') {
          this.killShell(record);
          // The official shell viewer keeps output it already captured, but a removed shell is
          // no longer queryable: list/get/output must all become 404 rather than returning a
          // misleading empty or stale record.
          this.shells.delete(id);
          noContent();
          return;
        }
      }
    }
    if (path === '/api/model' && method === 'GET') {
      // The catalog comes from the agent's config options, so a session that has been adopted but
      // not started yet has none: the answer would be the `acp/default` placeholder while the
      // transcripts already name real models. The client looks each message's model up in this
      // catalog and dereferences the result — `rows.ts` does `previous.model.providerID` on the
      // cached usage of a message whose model is absent — so a placeholder catalog plus a real
      // model in a message is a crash, not just a wrong label. Measured: the client asking `/model`
      // before `/message` produced `TypeError: undefined is not an object (evaluating
      // 'r.message.model.providerID')` on a restored session.
      //
      // Starting the agent here is what makes the two agree. It is the same lazy start the
      // transcript route already does, so it costs nothing when the catalog is already real.
      // ★ The tab in front decides whose models these are. Without this a second tab bound to
      // another agent (see the session map's `agent`) offered dsh's models while the tab was
      // opencode's, and every pick was rejected by the agent. The focus comes from the reads
      // the client makes on a tab switch; see `noteFocus`.
      const focused = this.focusRecord();
      if (this.modelCatalog(focused).models.every((m) => !this.isRealModel(m))) {
        await this.ensureCatalogSession(focused, asked, 'the model catalog');
      }
      const models = this.modelCatalog(focused).models;
      // The catalog is where a real model first becomes knowable, and the client asks for it on
      // every startup and refresh. Replayed transcripts are collected earlier — measured on the
      // restore path: `hist=1 real=none catalog=1` at read time — so a repair that only runs
      // while serving the transcript sees no real model and the card footer keeps `acp/unknown`.
      // Repairing here is idempotent, so a repeat visit costs nothing. It is deliberately *not*
      // inside modelCatalog(): that is a hot internal call, and hooking it disturbed startup.
      this.repairHistoryModels();
      // v2.2.0 added `types` ("chat" | "decision" | "image", one or many) and defaults it to
      // `chat`. Every model an ACP agent offers is a conversation model, so the honest answer
      // to any request that includes `chat` is the whole catalog; a request that asks ONLY for
      // types this bridge cannot offer gets an empty list rather than a wrong one.
      // ★ Observability for the "empty /models" report (owner, 2026-10-28): the TUI asks
      // for the catalog BEFORE it creates the new session, so the answer comes from whichever
      // session is focused — a restored one, whose catalog came from `session/load`, not from
      // `session/new`. This line says which session answered and how much it could offer, so
      // a single reproduction says whether the focused catalog was empty or the wrong one was
      // picked. It costs one log line per read and changes no behaviour.
      const realProviders = [...new Set(models.map((m) => String(m['providerID'] ?? '?')))].filter(
        (id) => id !== PLACEHOLDER_BACKEND,
      );
      this.log(
        `[bridge] /api/model: focused=${focused?.session.id ?? 'none'} ` +
          `models=${models.length} providers=${realProviders.length}` +
          `${realProviders.length ? ` (${realProviders.slice(0, 3).join(', ')}${realProviders.length > 3 ? ', …' : ''})` : models.length > 1 || (models[0]?.['id'] ?? 'default') !== 'default' ? ' (single provider)' : ' (placeholder only)'}` +
          ` sessions=${this.state.all().length} connected=${this.agents.size}`,
      );
      const types = new URL(req.url ?? '/', 'http://localhost').searchParams.getAll('types').flatMap((value) => value.split(','));
      const wanted = types.map((value) => value.trim()).filter((value) => value.length > 0);
      located(wanted.length === 0 || wanted.includes('chat') ? models : []);
      return;
    }
    if (path === '/api/provider') {
      located(this.modelCatalog().providers);
      return;
    }
    if (
      [
        '/api/integration',
        '/api/reference',
      ].includes(path)
    ) {
      located([]);
      return;
    }
    // `GET /api/fs/list` — the TUI's `/cd` argument completion lists directories through
    // here (directory-completion.ts: `file.list({location, path})`), so an always-empty
    // answer made every path the owner typed show "No matching directories", and Enter —
    // bound to `prompt.autocomplete.select` while the popup is visible — never submitted
    // the command at all. The official server lists the real filesystem; so does this.
    // Entry shape from the spec: `{path: RelativePath, type}`, `additionalProperties: false`,
    // and the client resolves each entry against the response's `location.directory`.
    if (path === '/api/fs/list') {
      const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
      const askedPath = query.get('path') ?? envelopeDirectory;
      let entries: Array<{ path: string; type: 'file' | 'directory' }> = [];
      try {
        entries = readdirSync(askedPath, { withFileTypes: true })
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((entry) => ({
            path: entry.name,
            type: entry.isDirectory() ? ('directory' as const) : ('file' as const),
          }));
      } catch {
        this.log(`[bridge] fs/list: cannot read ${askedPath}`);
      }
      json({ location: { directory: askedPath }, data: entries });
      return;
    }
    // `GET /api/fs/find?query=…[&type=file|directory][&limit=n]` — the TUI's `@`
    // attachment autocomplete searches through here (an always-empty answer made
    // every `@` show "No matching files, agents, or references", so an image could
    // never be attached from the TUI — the entry point of the whole image path was
    // dead). The official server does a real fuzzy search; this one walks the tree
    // from the requested directory, breadth-first with a visit cap, matching the
    // query case-insensitively as a substring of the relative path, type-filtered
    // when asked, and answers the same `{location, data}` envelope as fs/list.
    if (path === '/api/fs/find') {
      const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
      const needle = (query.get('query') ?? '').toLowerCase();
      const typeFilter = query.get('type');
      const limit = Math.min(Number(query.get('limit') ?? 20) || 20, 100);
      const root = envelopeDirectory;
      const found: Array<{ path: string; type: 'file' | 'directory' }> = [];
      if (needle.length > 0) {
        const seen = new Set<string>([root]);
        let queue: Array<{ dir: string; rel: string; depth: number }> = [{ dir: root, rel: '', depth: 0 }];
        while (queue.length > 0 && found.length < limit) {
          const next: Array<{ dir: string; rel: string; depth: number }> = [];
          for (const item of queue) {
            let dirents: Dirent[];
            try {
              dirents = readdirSync(item.dir, { withFileTypes: true });
            } catch {
              continue; // unreadable dir — skip, not fail
            }
            for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
              const rel = item.rel === '' ? dirent.name : `${item.rel}/${dirent.name}`;
              const absolute = `${item.dir}/${dirent.name}`;
              const type = dirent.isDirectory() ? ('directory' as const) : ('file' as const);
              if (!typeFilter || type === typeFilter) {
                if (rel.toLowerCase().includes(needle)) {
                  found.push({ path: rel, type });
                  if (found.length >= limit) break;
                }
              }
              // Descend directories (bounded): the search is for a file the user
              // half-remembers, not a full index — depth 4 and 2000 visited dirs
              // cover a repo; node_modules-scale noise is cut by the cap alone.
              if (dirent.isDirectory() && item.depth < 4 && !seen.has(absolute)) {
                seen.add(absolute);
                next.push({ dir: absolute, rel, depth: item.depth + 1 });
              }
            }
            if (found.length >= limit) break;
          }
          queue = next;
        }
      }
      this.log(`[bridge] fs/find '${needle}' in ${root}: ${found.length} match(es)`);
      json({ location: { directory: root }, data: found });
      return;
    }
    // `GET /api/skill` — the TUI's /skills picker. An always-empty answer made the picker
    // forever empty, so no skill could ever be attached from the TUI (the owner's report:
    // "load a skill via the slash command"). Skills are a *client-filesystem* concept —
    // ACP has no skill method — and the official server scans real directories, so this
    // scans the same roots: the config directory's skill/skills and the workspace's
    // .opencode/skill(s). Each skill is a directory with SKILL.md (frontmatter: name,
    // description), exactly the official SkillFile.parse shape.
    // `GET /api/command` — the palette's command list. The agent's own slash commands
    // (its ACP `available_commands_update`, dsh's being mostly skill runners) are stored
    // per session as the agent reports them; serve this location's sessions' union. The
    // agent is lazy, so a location whose session exists but has not started yet is
    // started here — the palette opens at startup, before any prompt.
    if (path === '/api/command') {
      const directory = envelopeDirectory;
      const records = this.state
        .all()
        .filter((candidate) => (candidate.directory ?? this.options.directory) === directory);
      if (records.length > 0 && !records.some((candidate) => candidate.commands)) {
        // Only start one session to discover the agent's commands — starting every remembered
        // session in the directory would replay dozens of historical sessions and race `/api/model`.
        const starter =
          records.find((candidate) => this.agents.has(candidate.session.id)) ??
          records.find((candidate) => !candidate.acpSessionId) ??
          records[0]!;
        try {
          await this.ensureAgent(starter);
        } catch (err) {
          this.log(`[bridge] could not start the agent for its commands: ${String(err)}`);
        }
        // The agent sends `available_commands_update` right after `session/new` answers,
        // which can still be in flight when ensureAgent resolves. Give it a moment.
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline && !records.some((candidate) => candidate.commands)) {
          await delay(100);
        }
      }
      const seen = new Set<string>();
      const commands: Array<{ name: string; description?: string }> = [];
      for (const candidate of records) {
        for (const command of candidate.commands ?? []) {
          if (seen.has(command.name)) continue;
          seen.add(command.name);
          commands.push({
            name: command.name,
            ...(command.description !== undefined ? { description: command.description } : {}),
          });
        }
      }
      json({ location: { directory }, data: commands });
      return;
    }
    if (path === '/api/skill') {
      const directory = envelopeDirectory;
      const roots = [
        join(homedir(), '.config', 'opencode', 'skill'),
        join(homedir(), '.config', 'opencode', 'skills'),
        join(directory, '.opencode', 'skill'),
        join(directory, '.opencode', 'skills'),
      ];
      const skills: Array<Record<string, unknown>> = [];
      const seen = new Set<string>();
      for (const root of roots) {
        let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
        try {
          entries = readdirSync(root, { withFileTypes: true }).map((entry) => ({
            name: entry.name,
            isDirectory: () => entry.isDirectory(),
          }));
        } catch {
          continue; // that root does not exist here
        }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const file = join(root, entry.name, 'SKILL.md');
          let raw: string;
          try {
            raw = readFileSync(file, 'utf8');
          } catch {
            continue; // not a skill directory
          }
          if (seen.has(file)) continue;
          seen.add(file);
          const front = /^---\n([\s\S]*?)\n---/.exec(raw);
          const frontmatter = front?.[1] ?? '';
          // Frontmatter values may be single-line (`name: x`) or YAML folded blocks
          // (`description: >` then indented lines), which the real skills on this machine
          // use. Parse both: a `>` or `|` marker folds/keeps the indented block below,
          // joined with spaces for `>` and newlines for `|`.
          const pick = (key: string): string | undefined => {
            const lines = frontmatter.split('\n');
            const start = lines.findIndex((line) => line.startsWith(`${key}:`));
            if (start < 0) return undefined;
            const inline = lines[start]!.slice(key.length + 1).trim();
            if (inline && inline !== '>' && inline !== '|') return inline;
            const block: string[] = [];
            for (const line of lines.slice(start + 1)) {
              if (line.startsWith('  ') || line.startsWith('\t')) block.push(line.trim());
              else break;
            }
            if (block.length === 0) return inline || undefined;
            return inline === '|' ? block.join('\n') : block.join(' ');
          };
          const description = pick('description');
          skills.push({
            id: entry.name,
            name: pick('name') ?? entry.name,
            ...(description ? { description } : {}),
            path: file,
            content: raw.slice((front?.[0]?.length ?? 0)),
          });
        }
      }
      this.log(`[bridge] skills: ${skills.length} found under ${directory}`);
      json({ location: { directory }, data: skills });
      return;
    }
    // Persistent PTY list. The bridge runs no PTY, so the honest answer is an
    // empty list — the TUI then clears any stale terminal selection.
    if (/^\/api\/experimental\/session\/[^/]+\/terminal$/.test(path) && method === 'GET') {
      located([]);
      return;
    }
    // v2.1's TUI reads the MCP list during startup (v2.0 used `/mcp`). An empty
    // list is honest — the bridge runs no MCP — and an unhandled route here makes
    // the startup burst look incomplete.
    if (path === '/api/mcp') {
      located(configuredMcpServers());
      return;
    }
    if (path === '/api/mcp/resource') {
      located({ resources: [], templates: [] });
      return;
    }
    if (path === '/api/config') {
      json([]);
      return;
    }
    if (path === '/api/config/shell') {
      // The desktop's Settings page fetches this and treats the body as an **array**
      // (`shells.reduce` / `.findIndex`). It fell through to the unknown-route handler,
      // which answers a well-formed *object* — and an object has no `.reduce`, so the
      // whole Settings screen died with `TypeError: e.shells.reduce is not a function`.
      // An empty array says "no shells discovered", which is true: we do not enumerate
      // the user's shells. Same bare-array shape as its sibling `/api/config`.
      json([]);
      return;
    }
    if (path === '/api/project/current') {
      json({ id: this.location.project.id, directory: this.options.directory });
      return;
    }
    if (path === '/api/project') {
      json([]);
      return;
    }
    if (path === '/api/worktree') {
      if (method === 'GET') json([{ directory: this.options.directory }]);
      else noContent();
      return;
    }
    if (path === '/api/worktree/refresh') {
      noContent();
      return;
    }
    if (path === '/api/experimental/migration/v1') {
      json({ status: 'completed' });
      return;
    }

    // Unknown: say so clearly. A 404 here is how we discover what a future
    // client build wants; silently inventing a shape would hide the gap.
    // Unknown routes still get a *well-formed* envelope: clients read
    // `.location` off these bodies unconditionally, so a bare 404 crashes them.
    // 200 + an empty payload keeps the UI alive; the log is the real signal.
    // `/api/integration/:id` has to be an **object with `connections`**, not the
    // generic array: the client does `integration.data.connections.filter(...)`, and
    // an array there is a TypeError — which the user sees as "Request failed" when
    // disconnecting a provider. Same empty-list truth, correct shape.
    if (/^\/api\/integration\/[^/]+$/.test(path) && method === 'GET') {
      located({ connections: [] });
      return;
    }
    // ★ `/api/rpc/{rpcID}/{method}` is a REAL route in the published spec ("Call a plugin RPC",
    // and a `/api/rpc` event in the v2 vocabulary) — it was falling through to the empty-array
    // default below, which is the wrong shape. `Rpc.Output` is `{output}`, so a caller that
    // destructures `.output` got `undefined` and asked again; measured: v2.3.2's
    // `opencode.goal/get` on every session switch, 44 requests in one session.
    //
    // The bridge runs no plugins, so the honest answer is "this RPC has no output" — the same
    // truth as the empty lists above, in the shape the schema declares.
    if (/^\/api\/rpc\/[^/]+\/[^/]+$/.test(path)) {
      this.log(`[bridge] ${method} ${path}: no plugin RPC is registered here (answering {output: null})`);
      json({ output: null });
      return;
    }
    this.log(`[bridge] unhandled route: ${method} ${path}`);
    if (path.startsWith('/api/')) {
      located([]);
      return;
    }
    json({ error: `not implemented: ${method} ${path}` }, 404);
  }

  private async handleSessionRoute(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    method: string,
    sessionId: string,
    rest: string,
    body: unknown,
    json: (data: unknown, status?: number) => void,
    located: (data: unknown) => void,
    noContent: () => void,
  ): Promise<void> {
    let record = this.state.get(sessionId);
    // Only the session itself is adopted, never a subroute: an unknown session's
    // `/message` (or any other read) must keep answering 404, which is the registered
    // behaviour of this surface and what AGENTS.md rule 3 asks for. The client's own
    // sequence works out — it asks for the session first, which adopts it, and by the time
    // it asks for the transcript the session exists.
    if (!record && rest === '') {
      // The client remembers sessions across runs — that is where a tab for a session from
      // a previous bridge comes from — and asks for it by the id it saw. A fresh bridge
      // holds no such record, and answering 404 makes the client show "Error" and drop the
      // tab. The agent may well know that session: `session/load` is the stable method for
      // exactly this, so adopt the id and let the normal resume path do the work. If the
      // agent does not know it either, the restore path says so loudly and starts a fresh
      // conversation, titled `[new conversation] …` rather than pretending it is the old one.
      if (this.deletedSessions.has(sessionId)) {
        json({ error: 'session was deleted', sessionID: sessionId }, 404);
        return;
      }
      // The map is the whole point of writing a file: the client remembers the id it was
      // shown, and the agent only answers to its own. Where we have learned the pair, use
      // it, so `session/load` can actually find the session and replay its history.
      const known = this.sessionMap.acpIdFor(sessionId);
      // ★ A map MISS is only adoptable when the id could be the AGENT's own: a UUID the
      // user copied from elsewhere (dsh's web UI shows those). Adopting anything else —
      // a bridge-minted `ses_…` whose pairing the map lost, or outright garbage the
      // client remembered ('dummy' from an old probe) — used to fabricate a record whose
      // load could only fail, and the recovery branch then started a BRAND-NEW session
      // under that id: a working, empty tab wearing a real conversation's name.
      // The owner's report — "切过去后也是空的" — is exactly that. A 404 instead is the
      // designed answer for a session nobody has: the client shows the miss and drops
      // the tab instead of pretending to resume it.
      const agentIdShaped = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        sessionId,
      );
      if (!known && !agentIdShaped) {
        this.log(
          `[bridge] refusing to adopt '${sessionId}': no map entry and not an agent-native id; answering 404`,
        );
        json({ error: 'session not found', sessionID: sessionId }, 404);
        return;
      }
      // ★ A remembered session may belong to another agent. ACP does not say so — the id is
      // all `session/resume` takes — so the map records the agent that created it, and the
      // record is bound to THAT command: reopening a tab created by `opencode acp` under a
      // `dsh` bridge spawns opencode for it (measured: handing the id to dsh gave an empty
      // tab, with nothing on screen explaining why).
      const rememberedAgent = this.sessionMap.agentFor(sessionId);
      const ownAgent = this.agentBinding();
      if (known && rememberedAgent === undefined) {
        // ★ An entry from before the `agent` field existed carries no way to know which
        // backend owns it. The first version adopted those with the launching agent, which
        // is a guess: with mixed agents in one map it resumes a dsh id into opencode and the
        // tab simply comes up empty. The owner's call (2026-10-18) is to stop guessing —
        // pre-release, a clean map is cheaper than a wrong one. Say exactly what to do.
        this.log(
          `[bridge] refusing to adopt '${sessionId}': its map entry predates the agent binding, ` +
            `so which agent owns it is unknown. Delete that entry (or the whole map at ${sessionMapPath()}) ` +
            `or open it with the agent that created it; answering 404`,
        );
        json({ error: 'session not found', sessionID: sessionId }, 404);
        return;
      }
      const foreign =
        rememberedAgent !== undefined &&
        agentBindingLabel(rememberedAgent) !== agentBindingLabel(ownAgent);
      // ★ One client = one agent (owner, 2026-10-19). The old behaviour spawned the
      // session's OWN agent here, which is how a dsh launch could show an opencode tab
      // and then offer opencode's models to a new dsh session. The TUI's state is now
      // per agent, so such a tab normally never loads; this is the hard boundary for
      // anything that still asks (a `-s`, a stale tab, a hand-written map).
      if (foreign) {
        const owner = agentBindingLabel(rememberedAgent);
        const own = agentBindingLabel(ownAgent);
        this.log(
          `[bridge] refusing '${sessionId}': it belongs to '${owner}', this bridge drives '${own}' — ` +
            `launch the client with that agent instead`,
        );
        json(
          { error: `this session belongs to ${owner}; launch the client with that agent`, sessionID: sessionId },
          404,
        );
        return;
      }
      // ...and the pair's *directory*, not this bridge's launch directory. A restarted
      // bridge starts in whatever directory the user launched from, but a session the user
      // moved with /cd lives where the move put it: the map recorded it, and ignoring it
      // here made the move look temporary — the reopened tab showed (and the agent worked
      // in, via the load's cwd) the launch directory again. Same write-without-reader family
      // as the self-mapping bug: the data was durable; the reader was missing.
      const rememberedDirectory = this.sessionMap.directoryFor(sessionId);
      // ★ Same place, different spelling: the map stores whatever the client sent when it
      // created the session (`/private/var/...` on macOS), while this bridge was launched
      // with the logical one (`/var/...`) and THAT is the workspace the client is showing
      // (it learns it from `/api/project`). Reporting the map's spelling made the client
      // treat the restored session as belonging to another workspace and drop the tab —
      // measured: a restart lost the very tab it had just restored, only when the two
      // spellings differed. A session genuinely moved elsewhere (a `/cd`) resolves to a
      // different place and keeps the map's directory.
      const sessionDirectory =
        rememberedDirectory && canonicalPath(rememberedDirectory) === canonicalPath(this.options.directory)
          ? this.options.directory
          : rememberedDirectory;
      const location: Location = sessionDirectory
        ? {
            directory: sessionDirectory,
            project: {
              id: projectIdFor(sessionDirectory),
              directory: sessionDirectory,
              canonical: sessionDirectory,
            },
          }
        : this.location;
      const rememberedTitle = this.sessionMap.titleFor(sessionId);
      const rememberedTime = resolveSessionTime(undefined, this.sessionMap.timesFor(sessionId));
      record = this.state.createSession(location, rememberedTitle ?? sessionId, sessionId, rememberedTime);
      if (rememberedTitle) this.adoptStoredTitle(record, rememberedTitle);
      const rememberedMode = this.sessionMap.modeFor(sessionId);
      if (rememberedMode) record.session.agent = rememberedMode;
      if (sessionDirectory) {
        record.directory = sessionDirectory;
        this.log(`[bridge] session map: ${sessionId} lives in ${sessionDirectory}`);
      }
      record.acpSessionId = known ?? sessionId;
      if (known) this.log(`[bridge] session map: ${sessionId} is the agent's ${known}`);
      this.log(`[bridge] adopting session ${sessionId} from the client's remembered id`);
    }
    // Still unknown: a subroute of a session nobody has, which answers 404 by design.
    if (!record) {
      json({ error: 'session not found', sessionID: sessionId }, 404);
      return;
    }
    // The client is looking at this session (a read, a prompt, a model pick, a rename): that
    // is the tab whose agent owns the model catalog. See `noteFocus` for the burst rule.
    this.noteFocus(record.session.id);

    // `POST /api/experimental/session/:id/wait` — the TUI calls this after an interrupt and
    // before staging an undo. The declaration is `successStatus: 204, empty: true`, and the
    // semantic is simply "return once the current turn is over", which this bridge can honour
    // from its own state. The generic unmatched-route fallback answers 200 with an array,
    // which the generated client rejects as `UnexpectedStatus`.
    if (rest === '/wait' && method === 'POST') {
      const deadline = Date.now() + 30_000;
      while (record.busy && Date.now() < deadline) await delay(100);
      noContent();
      return;
    }

    // `POST /api/session/:id/command` — a palette command the user picked (an agent
    // slash command listed by GET /api/command, or one of the built-ins).
    //
    // The ACP slash-commands contract (agentclientprotocol.com/protocol/v1/slash-commands):
    // "Commands are included as regular user messages in prompt requests … The Agent
    // recognizes the command prefix and processes it accordingly." So this is exactly
    // the prompt path with `/<name> <args>` as the text — same turn lifecycle, same
    // events, same transcript — which is also how the agent's own web UI triggers them.
    if (rest === '/command' && method === 'POST') {
      const body_ = (body ?? {}) as {
        name?: unknown;
        text?: unknown;
        delivery?: unknown;
        files?: unknown;
        agents?: unknown;
        skills?: unknown;
      };
      const name = body_['name'];
      if (typeof name !== 'string' || name.length === 0) {
        json({ _tag: 'InvalidRequestError', message: 'command name is required' }, 400);
        return;
      }
      const args = typeof body_['text'] === 'string' ? (body_['text'] as string) : '';
      const commandText = `/${name}${args ? ` ${args}` : ''}`;
      this.log(`[bridge] command: ${commandText}`);
      // The route declares `successStatus: 204, empty: true` — unlike POST /prompt's
      // 200-with-body. Reusing prompt()'s 200 answer made every command fail in the
      // client with `UnexpectedStatus: 200 / Failed to set up session`, and because the
      // submission "failed" the composer kept its text, which then concatenated onto the
      // next command. Same turn machinery, different success answer.
      await this.prompt(
        record,
        {
          ...((body_ as Record<string, unknown>) ?? {}),
          // The slash text IS the message; the raw `text` field was the arguments.
          text: commandText,
          parts: undefined,
        },
        json,
        located,
        true,
      );
      return;
    }
    // `POST /api/session/:id/move` — the TUI's `/cd`.
    //
    // Official semantics (packages/core/src/session/move.ts): resolve the target against the
    // session's current directory (~ expansion included), refuse anything that is not an
    // existing directory with the official messages, answer 204, and emit `session.moved`.
    // The client does the visible half by itself: its store rewrites the session's
    // location/projectID/subpath (that is what the footer and sidebar read) and inserts the
    // "↳ Moved to <dir>" row, purely from that event.
    //
    // The ACP side is a re-load, not an invention: the stable `session/load` takes `cwd`,
    // and the session id is unchanged. The agent then works out of the new directory —
    // which is the whole point of /cd, because the agent's own tool calls must follow the
    // directory the UI now claims. The re-load replays the conversation we already hold as
    // live rows, so the translator is muted for its duration: without the mute, apply()
    // would run the replay through `ensureMessage` and render the whole history twice.
    if (rest === '/move' && method === 'POST') {
      const raw = (body as { directory?: unknown } | undefined)?.directory;
      if (typeof raw !== 'string' || raw.trim().length === 0) {
        json({ _tag: 'InvalidRequestError', message: 'directory is required' }, 400);
        return;
      }
      // Mirror the official resolution: trim, expand `~`, resolve against the session's
      // current directory — the client sends the raw argument, not an absolute path.
      const value = raw.trim();
      const home = homedir();
      const expanded =
        value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : value;
      const base = record.directory ?? record.session.location.directory ?? this.options.directory;
      const directory = resolve(base, expanded);
      let stat: { isDirectory: () => boolean } | undefined;
      try {
        const info = statSync(directory);
        stat = { isDirectory: () => info.isDirectory() };
      } catch {
        stat = undefined;
      }
      if (!stat) {
        json({ _tag: 'InvalidRequestError', message: `Directory does not exist: ${directory}` }, 400);
        return;
      }
      if (!stat.isDirectory()) {
        json({ _tag: 'InvalidRequestError', message: `Not a directory: ${directory}` }, 400);
        return;
      }
      // A running turn is mid-conversation with the agent; the official server queues a
      // move and lands it at the next step boundary. Our inbox only holds prompts, so the
      // honest v1 is to wait briefly for the turn to settle and refuse if it does not.
      const busyDeadline = Date.now() + 30_000;
      while (record.busy && Date.now() < busyDeadline) await delay(100);
      if (record.busy) {
        json(
          {
            _tag: 'InvalidRequestError',
            message: 'a turn is still running; wait for it to finish before changing directory',
          },
          400,
        );
        return;
      }
      // Re-establish the ACP session in the new cwd before any bridge state moves: if the
      // agent declines, nothing has changed and the refusal is the agent's own words.
      const agent = this.agents.get(record.session.id);
      if (agent && record.acpSessionId) {
        if (!agent.capabilities.loadSession) {
          json(
            {
              _tag: 'InvalidRequestError',
              message: 'this agent cannot change a session directory (no session/load capability)',
            },
            400,
          );
          return;
        }
        const activeModeBeforeMove = record.session.agent;
        const translator = this.translators.get(record.session.id);
        translator?.mute();
        this.mutingModeUpdates.add(record.session.id);
        try {
          await agent.loadSession(record.acpSessionId, directory);
          await this.reconcileSessionMode(record, agent, record.acpSessionId, activeModeBeforeMove);
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          this.log(`[bridge] /move refused by the agent: ${text}`);
          json({ _tag: 'InvalidRequestError', message: `the agent refused the move: ${text}` }, 400);
          return;
        } finally {
          this.mutingModeUpdates.delete(record.session.id);
          translator?.unmute();
        }
      }
      const previous = record.directory ?? this.options.directory;
      record.directory = directory;
      record.session.directory = directory;
      record.session.location = {
        directory,
        workspaceID: record.session.location.workspaceID,
      };
      record.session.projectID = projectIdFor(directory);
      record.session.time = { ...record.session.time, updated: Date.now() };
      if (record.acpSessionId) {
        // `record.agent`, not the bridge's: a tab created by another agent keeps that agent
        // after a /cd, or the next run would reattach it with the wrong one.
        this.sessionMap.rememberBoth(
          record.session.id,
          record.acpSessionId,
          directory,
          undefined,
          record.agent ?? this.agentBinding(),
        );
        this.sessionMap.flush();
      }
      this.log(`[bridge] session moved: ${previous} -> ${directory}`);
      this.hub.emit({
        type: EVENT.sessionMoved,
        data: {
          sessionID: record.session.id,
          location: { directory },
          projectID: record.session.projectID,
          subpath: '',
        },
        location: this.location,
      });
      noContent();
      return;
    }

    // Session features the TUI offers but ACP has no method for. Each entry answers with a
    // status the route *declares*, so the client shows an ordinary toast instead of throwing
    // `UnexpectedStatus` (or, worse, accepting a 204 that silently did nothing).
    const featureRefusals: Record<
      string,
      {
        status: 400 | 409;
        tag: 'InvalidRequestError' | 'ConflictError';
        message: string;
        extra?: Record<string, unknown>;
      }
    > = {
      'POST /revert/stage': {
        status: 409,
        tag: 'ConflictError',
        message: 'session undo (/undo) is not acp supported',
        extra: { resource: 'session.revert' },
      },
      'DELETE /revert': {
        status: 409,
        tag: 'ConflictError',
        message: 'session redo (/redo) is not acp supported',
        extra: { resource: 'session.revert' },
      },
      'POST /revert/commit': {
        status: 409,
        tag: 'ConflictError',
        message: 'session undo commit (/undo) is not acp supported',
        extra: { resource: 'session.revert' },
      },
      'POST /background': {
        status: 400,
        tag: 'InvalidRequestError',
        message: 'background blocking tools (/background) are not acp supported',
      },
      'POST /synthetic': {
        status: 409,
        tag: 'ConflictError',
        message: 'editor context (/synthetic) is not acp supported',
        extra: { resource: 'session.synthetic' },
      },
      'POST /fork': {
        status: 400,
        tag: 'InvalidRequestError',
        message: 'session forking (/fork) is not acp supported',
      },
    };
    const refusal = featureRefusals[`${method} ${rest}`];
    if (refusal) {
      this.log(`[bridge] ${method} ${rest} refused: ${refusal.message}`);
      json(
        { _tag: refusal.tag, message: refusal.message, ...(refusal.extra ?? {}) },
        refusal.status,
      );
      return;
    }

    if (rest === '' && method === 'GET') {
      // ★ The client hydrates the conversation it is showing with this route, and
      // on v2.0.32 that is the ONLY per-session read a resume makes (measured: 12
      // calls for the active session, none for any other, and no /view at all —
      // the TUI stopped posting it). So it is the exit epilogue's ground truth for
      // "which conversation was on screen", which prompts alone cannot answer:
      // resume a session, type nothing, quit — and the Continue line used to
      // fall back to the TUI's native `opencode -s …`, naming neither this
      // product nor an id the native daemon knows.
      this.lastViewedSessionId = sessionId;
      // A tab that was answered lazily during the startup burst gets its transcript
      // now that the client says this is the one on screen.
      this.loadDeferredIfFocused();
      located(record.session);
      return;
    }
    if (rest === '' && method === 'DELETE') {
      // The client's `session.remove` requires 204 (`successStatus: 204` in the
      // generated client) and shows "Failed to delete session" otherwise, keeping the
      // tab — which is what a 404 did. Tear down in the launcher's order: stop the
      // agent, forget the translator, drop the record. No `session.deleted` event
      // exists in this surface, so the list refreshes from `/api/session`.
      const agent = this.agents.get(record.session.id);
      // Same fallback the resume path uses: the ACP id, or ours if the agent never
      // told us one. Being strict here meant the agent was never told at all — the
      // guard silently made the forward a no-op, which is the failure mode this whole
      // session keeps running into.
      const acpId = record.acpSessionId ?? record.session.id;
      // Remember that this one is gone. The client keeps its own list, and the adopt path
      // below would otherwise hand the tab straight back, which makes deleting look broken.
      this.deletedSessions.add(record.session.id);
      if (record.acpSessionId) this.deletedSessions.add(record.acpSessionId);
      // And forget the pair, so the map cannot hand the deleted session back on a later run.
      this.sessionMap.forget(record.session.id, record.acpSessionId ?? '');
      this.sessionMap.flush();
      this.agents.delete(record.session.id);
      this.translators.delete(record.session.id);
      this.state.removeSession(record.session.id);
      // Tell the agent, then dispose — in that order, in one chain. Firing the
      // request and calling dispose() separately raced: dispose won, the client was
      // closed first, and the ACP call died with `client disposed` without the agent
      // ever hearing it. The 204 above has already been sent, so awaiting here costs
      // the client nothing. Best-effort: a failure is logged, never fatal.
      void (async () => {
        if (agent && acpId) {
          try {
            await agent.deleteSession(acpId);
            this.log(`[bridge] agent released session ${acpId}`);
          } catch (err) {
            this.log(`[bridge] agent could not release ${acpId}: ${String(err)}`);
          }
        }
        await agent?.dispose().catch(() => undefined);
      })();
      this.log(`[bridge] deleted session ${record.session.id}`);
      noContent();
      return;
    }
    // The published spec spells this `PATCH /api/session/:id`, and the current
    // web/desktop client spells it `POST /api/session/:id/rename` with `{title}`,
    // expecting 204. We implement both, for the same reason we serve both
    // `/api/form` and `/api/form/request`: the client that exists decides.
    if ((rest === '' && method === 'PATCH') || (rest === '/rename' && method === 'POST')) {
      // Both spellings land here and do exactly the same thing; there is no
      // spelling-dependent behaviour, so nothing branches on which one it was.
      const title = titleFrom(body);
      if (title) {
        // Local only, and that is the whole feature: ACP has no client-side way to
        // set a session title — the registry (stable and unstable) has no rename or
        // title method, and `session/set_config_option` cannot carry free text.
        // Renaming in the TUI therefore works exactly as before: the record changes
        // and `session.renamed` goes out (the only event its store reads for this).
        record.session.title = title;
        // The title is the user's: the derived fallback must not replace it.
        record.titleFromUser = true;
        // A rename is a title change like any other: the map keeps the latest name, so a
        // restore shows it (the client also persists it in its own tab layout).
        this.persistTitle(record);
      } else {
        // The TUI's `/rename` with no argument means "generate a title": it POSTs an
        // empty string. There is no generator here and no ACP method for one, so say
        // so instead of answering 204 as if something had happened.
        this.log(
          '[bridge] rename: empty title ignored — the client uses this to ask for a generated title, and ACP has no title method; nothing was changed',
        );
      }
      this.hub.emit({
        type: EVENT.sessionUpdated,
        data: { session: record.session },
        location: this.location,
      });
      // `session.updated` is not in the TUI's store; the title only lands with this.
      this.hub.emit({
        type: EVENT.sessionRenamed,
        data: { sessionID: record.session.id, title: record.session.title },
        location: this.location,
      });
      // Both spellings answer 204. The published client's `session.update` (PATCH) declares
      // `successStatus: 204, empty: true`, and the older POST /rename spelling wanted the
      // same; answering 200 with the session JSON here made the very real `/rename` command
      // toast `UnexpectedStatus: 200` after a rename that had, in fact, worked — caught by
      // the first MODE=patrol run, which drove /rename for the first time this bridge ever
      // had.
      noContent();
      return;
    }
    // `!command` in the TUI. It arrives *session-scoped* — `POST /api/session/:id/shell`
    // with `{"command": "ls -la"}`, a plain string, unlike the global `/api/shell`
    // which takes `{command: {command, cwd?, timeout?}}`. We only had the global one, so
    // this fell into the unknown-session-verb handler and answered 204 as a no-op: the
    // transcript row appeared and stayed empty, which is what the owner saw with `!ls`.
    if (rest === '/shell' && method === 'POST') {
      const raw = (body ?? {}) as { id?: unknown; command?: unknown; cwd?: string };
      const command =
        typeof raw.command === 'string'
          ? raw.command
          : typeof (raw.command as { command?: unknown } | undefined)?.command === 'string'
            ? ((raw.command as { command: string }).command)
            : undefined;
      if (!command) {
        json({ error: 'shell command required' }, 400);
        return;
      }
      const shell = this.startShell(
        command,
        raw.cwd ?? record.directory ?? this.options.directory,
        record.session.id,
        typeof raw.id === 'string' ? raw.id : undefined,
      );
      shell.deferEnded = true;
      // ★ This response is the completion signal. The client's own transport says so:
      // "The HTTP response is the completion signal; session.shell resolves after the
      // command settled server-side." We used to answer immediately, while `output` was
      // still empty, and the client rendered nothing — which is exactly what `!ls`
      // looked like. Wait for the command here, with a ceiling so a long one cannot hold
      // the request open forever.
      await this.waitForShell(shell, SHELL_RESPONSE_TIMEOUT_MS);
      // `success: NoContent` in the protocol declaration, and `empty: true` in the
      // generated client: nothing reads this body. Answering 200 made the client reject
      // the call outright — `UnexpectedStatus: 200`, surfaced as "Failed to set up
      // session" — so the output travels by the two `session.shell.*` events and, for the
      // output dialog, by the cursor-paged `GET /api/shell/:id/output`.
      noContent();
      this.emitShellEnded(shell, record.session.id);
      return;
    }
    // `GET /api/experimental/session/:id/export` — `/copy` and `/export`. The client feeds
    // the result to `formatSessionTranscript(data.info, data.messages, …)` and the clipboard
    // or the file writer, so this is the one place that serves the whole transcript as a
    // single object: `SessionTransferData = {info, messages}` (messages chronologically
    // ordered, unlike `/message` which pages newest-first for the client's own reversal).
    if (rest === '/export' && method === 'GET') {
      const projection = {
        agent: record.backendName ?? this.backendName(),
        model: record.model ?? this.defaultModel(),
      };
      const live = record.messages.map((message) =>
        projectMessage(message, this.state.partsOf(record, message.id), projection),
      );
      const realModel = this.defaultModel();
      if (realModel) this.rescoreHistoryModels(record, realModel);
      const seen = new Set<string>();
      const chron: unknown[] = [];
      for (const message of [...(record.history ?? []), ...live]) {
        const id = (message as { id?: string }).id;
        if (id) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        chron.push(message);
      }
      // The export schema is strict (`additionalProperties: false` at every level and no
      // envelope `location`), unlike the superset the /message list is allowed to carry, so
      // this is the one place the internal session is projected down to the spec's
      // Session.Info: exactly the fields the client's formatter reads.
      const info: Record<string, unknown> = {
        id: record.session.id,
        projectID: record.session.projectID,
        cost: record.session.cost,
        tokens: record.session.tokens,
        time: record.session.time,
        location: record.session.location,
      };
      if (record.session.title !== undefined) info['title'] = record.session.title;
      if (record.session.time.archived !== undefined) info['time'] = record.session.time;
      if (record.session.outcome !== undefined) info['outcome'] = record.session.outcome;
      json({ data: { info, messages: chron } });
      return;
    }
    if (rest === '/message' && method === 'GET') {
      // A session we adopted from the client's memory has an ACP id but no agent yet: the
      // agent is lazy, so its `session/load` replay has not happened and this list would be
      // empty — which is exactly what an adopted tab showed: switchable, continuable, and
      // blank. Load it first, then serve whatever the replay produced.
      //
      // ★ Await `ensureAgent` even when the agent object already exists: the guard that
      // only checked `agents.has()` raced a restore badly. The startup sequence is
      // `agents.set()` (synchronous, inside the first attempt) → initialize →
      // session/load → replay lands in record.history. A second request arriving between
      // the set and the load — exactly what the tab prefetch does in parallel on a
      // reopened client — found the half-built agent, skipped the wait, and served an
      // empty transcript. Measured twice under the full gate and once by hand: the log
      // shows `-> 200 /message` *before* `load answered`.
      if (record.acpSessionId) {
        const inFlight = this.readLoad;
        if (inFlight && inFlight.sessionId === record.session.id) {
          await inFlight.done;
        } else if (inFlight) {
          // ★ A background tab, not the one on screen. The client hydrates every
          // remembered tab's messages ~300ms after connect (native opencode can afford
          // that: one process, SQLite reads). Here every load is a whole agent process
          // doing `session/load`/`session/resume` — N tabs = N agents, and a backend that
          // takes a workspace lock (dsh) refuses the second load outright, so the burst
          // also broke the tab it did not load. The visible tab's mount read arrives
          // first (the client's own comment says its syncs win the first slots), so it
          // gets the load; the others answer from what we have and load when the user
          // actually opens them, because switching tabs mounts that session and re-reads.
          // Remember it: if this turns out to be the tab on screen (the startup
          // burst can invert), it must not stay empty until the user switches away
          // and back. The focus signal loads it right after the current one.
          this.deferredLoads.add(record.session.id);
          this.log(
            `[bridge] lazy: ${record.session.id} answered without loading ` +
              `(${inFlight.sessionId} is loading its transcript)`,
          );
        } else {
          await this.loadTranscript(record);
        }
      }
      // History is whatever the backend replayed on `session/load` - and nothing
      // else. A backend that does not replay simply has none here, which is the
      // agreed trade for not reading its storage: resume works, the transcript
      // starts empty. `record.history` is set to [] by the load branch only.
      // Disk transcript is the prefix, the live record the suffix, both
      // oldest-first; the client asks with `order: "desc"` and calls
      // `.toReversed()` itself, so hand it newest-first. Ids do not collide
      // (history is `hist_*`, live is `msg_*`) but a turn can exist in both once
      // the backend has flushed it, so de-dupe by id.
      // Live rows go through the projector: the client reads `Session.Message.Info`
      // (typed, content inline), not our internal `{id, sessionID, role, time}`.
      // Replayed history is already in that shape (`toSessionMessage`).
      const projection = {
        agent: record.backendName ?? this.backendName(),
        model: record.model ?? this.defaultModel(),
      };
      const live = record.messages.map((message) =>
        projectMessage(message, this.state.partsOf(record, message.id), projection),
      );
      const seen = new Set<string>();
      const merged: unknown[] = [];
      // Name a real model on replayed entries before serving them. A replay is collected as soon
      // as the client asks for the transcript, while the catalog only arrives with `session/new`;
      // entries built in that window fell back to the placeholder and the card footer rendered
      // `acp/unknown`. Repairing here is safe because the catalog is ready by the time anyone
      // reads the transcript, and it is idempotent.
      const realModel = this.defaultModel();
      if (realModel) this.rescoreHistoryModels(record, realModel);
      for (const message of [...(record.history ?? []), ...live].reverse()) {
        const id = (message as { id?: string }).id;
        if (id) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        merged.push(message);
      }
      // The client asks with `limit` (20 by default, 200 when it wants the lot)
      // and pages with the cursor handed back, so serve a page rather than the
      // whole transcript. A resumed session can hold thousands of messages, and
      // handing them all over at once is what made opening a long one slow.
      // `cursor.next` is always present - the client reads it without a guard -
      // and `null` means there is nothing older left to fetch.
      const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
      // `type` filters before pagination, so a cursor handed back for a filtered
      // list keeps meaning the same rows. The projection already carries `type`;
      // unknown values (a forward-compatible enum member) simply match nothing.
      const askedType = query.get('type');
      if (askedType) {
        merged.splice(
          0,
          merged.length,
          ...merged.filter((message) => (message as { type?: unknown }).type === askedType),
        );
      }
      const askedLimit = Number.parseInt(query.get('limit') ?? '', 10);
      const limit =
        Number.isFinite(askedLimit) && askedLimit > 0
          ? Math.min(askedLimit, 1000)
          : merged.length;
      const askedCursor = Number.parseInt(query.get('cursor') ?? '', 10);
      const offset = Number.isFinite(askedCursor) && askedCursor > 0 ? askedCursor : 0;
      const page = merged.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      const next = nextOffset < merged.length ? String(nextOffset) : null;
      // OPENCODE_ACP_CLIENT_MESSAGE_PROBE=1: record what this response carries, so an
      // intermittent client-side drop can be traced to the answer or not.
      // The symptom is "the newest exchange vanishes", so log its ends: how
      // many, the newest id, and whether the newest live message is included.
      if (process.env['OPENCODE_ACP_CLIENT_MESSAGE_PROBE'] === '1') {
        const newest = merged[0] as { id?: unknown } | undefined; // newest-first
        const liveNewest = record.messages[record.messages.length - 1] as
          | { id?: unknown }
          | undefined;
        const isLiveNewest = (m: unknown) =>
          (m as { id?: unknown }).id === liveNewest?.id;
        this.log(
          `[message-probe] session=${record.session.id} total=${merged.length} ` +
            `page=${page.length} offset=${offset} next=${String(next)} ` +
            `newest=${String(newest?.id)} liveNewest=${String(liveNewest?.id)} ` +
            `liveCount=${record.messages.length} histCount=${record.history?.length ?? -1} ` +
            `hasLiveNewest=${merged.some(isLiveNewest)} inPage=${page.some(isLiveNewest)}`,
        );
      }
      // The spec's `SessionMessagesResponse` is `{data, cursor}` with no location
      // sibling — dropped here, and `scripts/e2e-real-tui.sh` is what keeps that
      // honest: if the client needed it, reopening a session would render nothing.
      json({ data: page, cursor: { previous: null, next } });
      return;
    }
    if (rest.startsWith('/message/') && method === 'GET') {
      const messageId = decodeURIComponent(rest.slice('/message/'.length));
      const message = this.state.getMessage(record, messageId);
      if (message) {
        json({
          data: projectMessage(message, this.state.partsOf(record, messageId), {
            agent: record.backendName ?? this.backendName(),
            model: record.model ?? this.defaultModel(),
          }),
        });
        return;
      }
      // A replayed message: already projected when the session was loaded, and its
      // id may arrive with the `msg_` prefix the spec requires.
      const replayed = (record.history ?? []).find((entry) => {
        const id = typeof entry.id === 'string' ? entry.id : '';
        return id === messageId || specMessageId(id) === messageId;
      });
      if (replayed) {
        json({ data: replayed });
        return;
      }
      return json({ error: 'message not found' }, 404);
    }
    if (rest === '/view' && method === 'POST') {
      // The client tells the server which conversation a tab is looking at. This
      // is the exit epilogue's widest (and weakest) signal — ranked last, see
      // `epilogueSessionId` in the launcher.
      this.lastViewedSessionId = sessionId;
      this.loadDeferredIfFocused();
      const idle = Number((body as { idle?: unknown } | undefined)?.idle);
      if (!Number.isFinite(idle)) {
        json({ error: 'idle must be a finite timestamp' }, 400);
        return;
      }
      // A tab acknowledges the idle watermark it observed. Never let an older view mark a
      // newer terminal transition as seen: the official TUI derives unread state from this
      // exact comparison and retries this request on failure.
      if (record.session.time.idle === idle) {
        record.session.time = { ...record.session.time, viewed: idle };
        this.hub.emit({
          type: EVENT.sessionViewed,
          data: { sessionID: record.session.id, idle },
          location: this.location,
        });
      }
      noContent();
      return;
    }
    if (rest === '/prompt' && method === 'POST') {
      await this.prompt(record, body, json, located);
      return;
    }
    // The spec names this `session.interrupt`; the older client called it
    // `/abort`. Both are served, so either spelling cancels.
    if ((rest === '/abort' || rest === '/interrupt') && method === 'POST') {
      const agent = this.agents.get(sessionId);
      // Read before cancelling: this is the spec's `interrupted` — true when a
      // running execution was actually interrupted, false for an idle no-op.
      //
      // ★ Two signals, because they are set by different layers and one can lag the other.
      //
      // `record.busy` is the translator's view: set when it emits the turn's start, cleared when
      // it closes the turns' parts. `promptsInFlight` is the server's own: added the moment the
      // prompt request is accepted, before any ACP frame has come back. A prompt that has been
      // accepted but whose first update has not arrived yet is BUSY, and answering
      // `{interrupted:false}` there tells the client nothing was running — it keeps its spinner
      // and the user sees a cancel that did nothing, although `agent.cancel()` was sent.
      // Line 3171 already consults both for the same reason.
      const interrupted = record.busy || this.promptsInFlight.has(record.session.id);
      // Remember the intent: the turn settles later, and by then the agent's stop
      // reason is the only other evidence of what happened.
      record.interruptRequested = true;
      agent?.cancel(record.acpSessionId ?? sessionId);
      // ACP's cancellation contract, in the order the spec states it: mark the
      // turn's unfinished tool calls cancelled, then answer everything the agent
      // is blocked on. Doing only the notification leaves a permission dialog and
      // a tool spinner waiting for an answer that no longer exists.
      const tools =
        this.translators
          .get(record.session.id)
          ?.closeOpenToolCalls(record, 'cancelled: the turn was aborted before this tool finished') ?? 0;
      const permissions = this.cancelPendingPermissions(sessionId);
      const forms = this.cancelPendingForms(sessionId);
      // NOT the shells. opencode's own server keeps them across an interrupt — its
      // `SessionExecution.interrupt` touches only the session's run fiber, and a running
      // `!command` is stopped by `DELETE /api/shell/:id` (which reports it `killed`)
      // alone. Killing them here looked helpful and was a deviation from the product we
      // adapt to: the client would then have to explain a shell that ended for a reason
      // the user never asked for.
      if (tools || permissions || forms) {
        this.log(
          `[bridge] abort: closed ${tools} tool call(s), ${permissions} permission(s), ${forms} form(s)`,
        );
      }
      // `session.interrupt` is specified as `200 {interrupted: boolean}`. Answering
      // 204 made the real TUI log an unhandled rejection (`UnexpectedStatus: 204`)
      // on every single cancel, even though the cancel itself worked.
      json({ interrupted });
      return;
    }
    if (rest === '/permission' && method === 'GET') {
      located(
        [...this.pendingPermissions.values()]
          .filter((p) => p.sessionId === sessionId)
          .map((p) => ({ id: p.requestId, tool: p.request.toolCall?.title ?? 'tool', options: p.request.options ?? [] })),
      );
      return;
    }
    // `/api/session/:id/agent` — switch the session's active ACP mode (`category: "mode"`)
    // when the agent advertises one, or answer 204 cleanly when it exposes no mode option.
    if (rest === '/agent' && method === 'POST') {
      const wanted = typeof (body as { agent?: unknown } | undefined)?.agent === 'string'
        ? (body as { agent: string }).agent
        : undefined;
      const result = await this.applyRequestedMode(record, wanted, {
        emitSelected: true,
        failOnUnsupported: true,
      });
      if (result.status === 400) {
        json({ _tag: 'InvalidRequestError', message: result.message }, 400);
        return;
      }
      noContent();
      return;
    }

    // Inbox: the client admits locally and reconciles from events; these verbs
    // only mutate an already-accepted prompt.
    if (rest === '/inbox' && method === 'GET') {
      located(
        [...this.pendingInbox.values()]
          .filter((e) => e.sessionID === sessionId)
          .map((e) => ({
            id: e.inboxID,
            sessionID: e.sessionID,
            timeCreated: Date.now(),
            type: 'user',
            payload: { text: e.text },
            delivery: e.delivery,
          })),
      );
      return;
    }
    {
      const inboxMatch = /^\/inbox\/([^/]+)(\/(steer|queue))?$/.exec(rest);
      if (inboxMatch) {
        const inboxID = decodeURIComponent(inboxMatch[1]!);
        const action = inboxMatch[3];
        const entry = this.pendingInbox.get(inboxID);
        if (method === 'DELETE') {
          this.pendingInbox.delete(inboxID);
          this.hub.emit({
            type: EVENT.inboxCancelled,
            data: { sessionID: sessionId, inboxID },
            location: this.location,
          });
          noContent();
          return;
        }
        // 2.0.32 spells the delivery switch `PATCH /inbox/:id {delivery}`; the
        // older clients used `POST /inbox/:id/{steer,queue}`. Both arrive here.
        const requestedDelivery =
          method === 'PATCH' && !action
            ? (body as { delivery?: unknown } | undefined)?.delivery
            : action;
        if (
          method === 'PATCH' &&
          !action &&
          requestedDelivery !== 'steer' &&
          requestedDelivery !== 'queue'
        ) {
          json({ error: 'delivery must be "steer" or "queue"' }, 400);
          return;
        }
        if ((method === 'PATCH' || method === 'POST') && requestedDelivery === 'queue') {
          if (entry) entry.delivery = 'queue';
          this.hub.emit({
            type: EVENT.inboxDeliveryChanged,
            data: { sessionID: sessionId, inboxID, delivery: 'queue' },
            location: this.location,
          });
          noContent();
          return;
        }
        if ((method === 'PATCH' || method === 'POST') && requestedDelivery === 'steer') {
          let remaining = this.pendingInbox.size;
          if (entry) {
            this.pendingInbox.delete(inboxID);
            remaining = this.pendingInbox.size;
          }
          this.hub.emit({
            type: EVENT.inboxDeliveryChanged,
            data: { sessionID: sessionId, inboxID, delivery: 'steer' },
            location: this.location,
          });
          const agent = this.agents.get(sessionId);
          if (agent) {
            void this.ensureAgent(record).then(() =>
              this.deliverPending(record, agent),
            );
          }
          this.log(`[bridge] steer ${inboxID} (${remaining} left)`);
          noContent();
          return;
        }
      }
    }
    // ── forms (an agent's `elicitation/create`, shown by the TUI) ──────────
    // The TUI reads this as `{data: [...]}` (not the location envelope) and
    // answers on `/form/:id/reply`; `/form/:id/cancel` is the dismiss path.
    // Registered before the generic POST fallback below, which would otherwise
    // answer 204 and leave the agent's elicitation pending forever.
    if (rest === '/form' && method === 'GET') {
      json({ data: [...this.pendingForms.values()].filter((f) => f.form.sessionID === sessionId).map((f) => f.form) });
      return;
    }
    {
      const formMatch = /^\/form\/([^/]+)(?:\/(reply|cancel|state))?$/.exec(rest);
      if (formMatch) {
        const formId = decodeURIComponent(formMatch[1]!);
        const action = formMatch[2];
        const pending = this.pendingForms.get(formId);
        if (!pending || pending.form.sessionID !== sessionId) {
          json({ error: 'form not found' }, 404);
          return;
        }
        if (action === 'reply' && method === 'POST') {
          const raw = (body ?? {}) as { answer?: unknown };
          const answer = raw.answer;
          if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
            json({ error: 'answer must be an object' }, 400);
            return;
          }
          this.settleForm(formId, { status: 'answered', answer: answer as FormAnswer });
          noContent();
          return;
        }
        if (action === 'cancel' && method === 'POST') {
          this.settleForm(formId, { status: 'cancelled' });
          noContent();
          return;
        }
        // The v2.0.28+ client's dismiss path: `DELETE /form/:fid` (spec-declared 204, an
        // optional `message` query nobody consumes). This is what Esc on a form sends —
        // unimplemented, it fell through to the generic 404, the client showed a red
        // "Error", the form never closed, and the agent's elicitation stayed pending
        // forever. The POST /cancel spelling above stays for older clients.
        if (action === undefined && method === 'DELETE') {
          this.settleForm(formId, { status: 'cancelled' });
          noContent();
          return;
        }
        if (action === 'state' && method === 'GET') {
          json({ data: { status: 'pending' } });
          return;
        }
        if (action === undefined && method === 'GET') {
          // `Form.Detail`, not `Form.Info`: the single-form read carries the
          // state, which is what the spec's schema requires here.
          json({ data: { ...pending.form, state: { status: 'pending' } } });
          return;
        }
      }
    }
    if (rest === '/diff' && method === 'GET') {
      located([]);
      return;
    }
    // ★ The client dereferences `.location.directory` on these bodies. A 404
    // (our old behaviour) has no `location`, which crashed it with
    // `undefined is not an object (evaluating 'O().location.directory')`.
    // So every read here answers with a well-formed empty envelope.
    const emptyReads = ['/terminal', '/form', '/diff', '/inbox', '/todo'];
    if (emptyReads.includes(rest) && method === 'GET') {
      located([]);
      return;
    }

    // A model pick in the TUI. the backend exposes its models as one ACP config option
    // (`id: "model"`) whose values are JSON array strings `["provider","model"]`,
    // so the switch has to travel as `session/set_config_option`.
    if (rest === '/model' && method === 'POST') {
      const picked = (body ?? {}) as {
        model?: { providerID?: string; id?: string; modelID?: string; variant?: string };
      };
      const providerID = picked.model?.providerID;
      // ★ The TUI's `/thinking` (variant picker) arrives HERE, as `model.variant`, not as a
      // separate route. It used to be ignored: the model id was unchanged, so the "already
      // selected" guard below answered 204 without calling the agent, and a session the
      // owner set to `max` stayed on the agent's `effort = off` — no reasoning, no thoughts.
      const variant = typeof picked.model?.variant === 'string' ? picked.model.variant : undefined;
      const raw = picked.model?.modelID ?? picked.model?.id;
      const modelID = raw?.includes('/') ? raw.slice(raw.indexOf('/') + 1) : raw;
      // The placeholder `the backend/default` exists so the composer is never empty
      // before ACP is ready. It is not a model the backend knows, so forwarding it
      // fails with "Invalid params" and leaves the session unusable.
      if (providerID === PLACEHOLDER_BACKEND && modelID === 'default') {
        this.log('[bridge] /model: ignoring the pre-ACP placeholder selection');
        noContent();
        return;
      }
      if (!providerID || !modelID) {
        this.log(`[bridge] /model: cannot read a model out of ${JSON.stringify(body)}`);
        noContent();
        return;
      }
      try {
        const { agent, sessionId: acpSessionId } = await this.ensureAgent(record);
        // ★ A model from another agent must be refused HERE, not by the agent: the catalog
        // the picker showed may have been another tab's (mixed agents), and the agent's own
        // rejection is a bare "Internal error" nobody can act on.
        const own = this.modelCatalog(record).models;
        if (
          own.length > 0 &&
          !own.some((m) => m['providerID'] === providerID && m['modelID'] === modelID)
        ) {
          // A model that another live agent DOES offer is the mixed-agent confusion: the
          // picker was drawn from a restored tab's catalog, and the client re-posts that
          // selection onto this new tab. Refusing it made the TUI abort the session with
          // "Failed to switch model"; ignoring it keeps the session on its own agent's
          // default, which is what the user actually launched.
          const foreign = this.modelCatalog().models.some(
            (m) => m['providerID'] === providerID && m['modelID'] === modelID,
          );
          if (foreign) {
            this.log(
              `[bridge] /model: ${providerID}/${modelID} belongs to another agent's catalog; keeping this session on its own default`,
            );
            noContent();
            return;
          }
          this.log(
            `[bridge] /model: ${providerID}/${modelID} is not offered by this session's agent; refusing`,
          );
          json(
            {
              error:
                `this session's agent does not offer ${providerID}/${modelID}; ` +
                `pick one of its own models (open another tab to use another agent)`,
            },
            400,
          );
          return;
        }
        // A switch to the model the session is already on is not a switch: the TUI re-posts
        // its selection on every mount, so this is the common path, and one agent call per
        // mount that cannot change anything is pure cost. (It was once believed to be a
        // correctness guard — that `set_config_option` broke later turns — but the agent's
        // "Connection error" turned out to be an unavailable provider, not the switch;
        // measured both same- and cross-provider switches, before and after a turn.)
        const current = modelFromConfigOptions(agent.configOptionsFor(record.acpSessionId));
        if (current && current.providerID === providerID && current.modelID === modelID) {
          this.log(`[bridge] /model: ${providerID}/${modelID} is already selected; not calling the agent`);
          record.model = { providerID, modelID };
          await this.applyVariant(record, agent, acpSessionId, variant);
          noContent();
          return;
        }
        // ★ Second guard, for a turn that is already running.
        //
        // The TUI re-posts agent + model before EVERY prompt. While a prompt runs the
        // agent refuses a config switch ("Invalid params: cannot switch models while a
        // prompt is running"), so a re-post that is really "no change" must not reach it —
        // the TUI then retries the 400 instead of sending the message, and the owner sees
        // "typing a second message does nothing". `modelFromConfigOptions` reads the value
        // the agent advertises and can miss an unfamiliar spelling (it missed dsh's
        // `provider::model`); this compares against what WE last recorded, which cannot be
        // spelled differently. Only applies mid-turn: outside one a real switch must still
        // be attempted.
        if (
          record.busy &&
          record.model &&
          record.model.providerID === providerID &&
          record.model.modelID === modelID
        ) {
          this.log(
            `[bridge] /model: ${providerID}/${modelID} is already this session's model; not switching mid-turn`,
          );
          noContent();
          return;
        }
        // Send back the value the agent itself advertises, rather than a format we
        // assume. opencode publishes JSON arrays (`["provider","model"]`) while dsh
        // publishes `provider/model`, and writing the wrong one is an error from the
        // agent — "Invalid params: model value must be a \"provider/model\" string" —
        // which the desktop shows as "request failed / unknown error" and leaves the
        // session on the old model (with the picker claiming the new one).
        const advertised: string[] = [];
        const sessionOptions = agent.configOptionsFor(record.acpSessionId);
        const switchOptions = sessionOptions.length > 0 ? sessionOptions : agent.anyConfigOptions();
        for (const option of switchOptions) {
          const optionId = option.id ?? option.configId;
          if (option.category !== 'model' && optionId !== 'model') continue;
          for (const entry of option.options ?? []) {
            const group = entry as { options?: Array<{ value?: string }> };
            if (Array.isArray(group.options)) {
              for (const choice of group.options) if (choice.value) advertised.push(choice.value);
            } else if ((entry as { value?: string }).value) {
              advertised.push((entry as { value: string }).value);
            }
          }
        }
        const wanted = advertised.find((value) => {
          const parsed = parseModelValue(value);
          return parsed.modelID === modelID && (!parsed.providerID || parsed.providerID === providerID);
        });
        await agent.setConfig(acpSessionId, 'model', wanted ?? `${providerID}/${modelID}`);
        record.model = { providerID, modelID };
        this.log(`[bridge] model -> ${providerID}/${modelID}`);
        await this.applyVariant(record, agent, acpSessionId, variant);
      } catch (err) {
        // ★ Do not answer 204 when the agent refused the switch. It used to: the TUI then
        // showed the picked model while the session stayed on the old one — measured with
        // dsh, whose "Invalid params" vanished into a log line. The declared 400 carries the
        // agent's own message, and `record.model` is deliberately left untouched.
        const text = err instanceof Error ? err.message : String(err);
        this.log(`[bridge] /model failed: ${text}`);
        json(
          { _tag: 'InvalidRequestError', message: `the agent refused the model switch: ${text}` },
          400,
        );
        return;
      }
      noContent();
      return;
    }

    // `PUT /api/session/:id/environment` — the TUI sets this up when a session gate runs,
    // and its protocol declaration is `success: NoContent`. It was landing in the
    // unknown-verb path, whose status the client rejected as `UnexpectedStatus`, so every
    // first `!command` from a fresh screen died with "Failed to set up session".
    // We hold no per-session environment to replace; 204 is the honest answer, and the
    // declaration asks for exactly that.
    if (rest === '/environment' && method === 'PUT') {
      noContent();
      return;
    }
    // `POST /api/session/:id/compact` — the TUI's `/compact` command.
    //
    // The declaration is `successStatus: 200, empty: false, declaredStatuses: [400,401,404,409]`,
    // so it wants a 200 with a `SessionInboxCompaction` body. We cannot produce one, and we must
    // not fake one: ACP has no "compact this session" method at all. `clientCapabilities.session.
    // compaction` is only a permission for the *agent* to send compaction updates, and we
    // deliberately do not advertise it (rule 1), so no compaction can happen on either side.
    //
    // Answering 204 from the generic verb fallback below is what produced the owner's
    // `UnexpectedStatus: 204` toast: 204 is not in `declaredStatuses`, and the generated client
    // throws for exactly that. The declared 409 IS handled — the client surfaces it as an ordinary
    // error — so this is the honest answer, with a message that says why.
    // `POST /api/session/:id/generate` — the TUI's `/btw` side question.
    //
    // The declaration is `successStatus: 200, empty: false, declaredStatuses: [400,401,404,503]`,
    // and the client shows the returned `{text}` in a one-shot dialog. ACP has no one-shot
    // generation method: `session/prompt` always writes to the agent's conversation, and the
    // unstable `session/fork` — whose own text is exactly this case, "generating summaries
    // without affecting the original session's history" — is not advertised by the agents
    // measured here (dsh exposes list/additionalDirectories/close only). We will not fake an
    // answer by prompting into the real session either, because that would silently add a card
    // and pollute the conversation the user asked a question *about*.
    //
    // The generic 204 fallback below is outside `declaredStatuses`, and the generated client
    // turns that into the owner's `UnexpectedStatus: 204` toast. The declared 503 is handled and
    // surfaces as an ordinary error message, so that is the honest answer.
    if (rest === '/generate' && method === 'POST') {
      this.log('[bridge] /generate refused: ACP has no side-question method that leaves the session untouched');
      // `ServiceUnavailableError` is the declared body for 503: `{_tag, message, service?}`.
      json(
        {
          _tag: 'ServiceUnavailableError',
          message: 'side questions (/btw) are not acp supported',
          service: 'session generation',
        },
        503,
      );
      return;
    }
    if (rest === '/compact' && method === 'POST') {
      this.log('[bridge] /compact refused: ACP has no session compaction method');
      // The declared body for 409 is `ConflictError` (`{_tag, message, resource?}`), not a shape of
      // our own: the conformance probe rejected `{error, detail}` because the spec forbids the extra
      // properties. `resource` names what conflicted.
      json(
        {
          _tag: 'ConflictError',
          message:
            'session compaction (/compact) is not acp supported',
          resource: 'session.compaction',
        },
        409,
      );
      return;
    }
    // Accepted-but-unimplemented session verbs: answer 204 so the client does
    // not treat them as a fatal protocol error.
    if (method === 'POST' || method === 'PUT') {
      this.log(`[bridge] unhandled session verb: ${method} ${rest}`);
      noContent();
      return;
    }
    this.log(`[bridge] unhandled session route: ${method} ${rest}`);
    json({ error: `not implemented: ${method} ${rest}` }, 404);
  }

  // ---------------------------------------------------------------- the turn

  /**
   * Guarantee a session exists. The TUI expects to *find* one rather than
   * create it, so a lazily-created default keeps its composer enabled from the
   * first frame.
   */
  /**
   * The session a fresh client should open.
   *
   * The TUI never creates a session on its own — it looks one up — so a launched
   * client has to be told which id to open. Calling this first
   * guarantees one exists.
   */
  primarySessionId(): string {
    return this.ensureSession().session.id;
  }

  /**
   * Wait until the ACP session has advertised its config options, so
   * `/api/model` answers with the backend's real list from the first request.
   *
   * Without this a launched client connects within milliseconds, reads the
   * placeholder model before `session/new` lands, and submits it as a choice —
   * which the backend then rejects as invalid params, leaving the session pinned to a
   * model that cannot answer.
   */
  async waitForCatalog(timeoutMs = 12_000): Promise<void> {
    const record = this.ensureSession();
    const deadline = Date.now() + timeoutMs;
    let lastError: string | undefined;
    let failures = 0;
    while (Date.now() < deadline) {
      if (this.modelCatalog().models.length > 0 && this.agentConfigReady) {
        this.adoptCatalogModels();
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        // `ensureAgent` awaits ACP requests whose own timeout is 120s, so the
        // deadline has to be enforced from out here — otherwise a command that
        // is not an ACP agent (it starts, then waits on stdin forever) would
        // hold up the ready line and the TUI for two full minutes.
        await Promise.race([this.ensureAgent(record), delay(remaining)]);
        lastError = undefined;
        failures = 0;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        failures += 1;
        // `ensureAgent` rebuilds the client from scratch after a failure, so a
        // second failure is the same failure. Sitting out the deadline only
        // delays placeholders the client runs on happily.
        if (failures >= 2) break;
      }
      await delay(100);
    }
    this.log(
      '[bridge] warning: ACP config options did not arrive; serving placeholders' +
        (lastError ? ` (last error: ${lastError})` : ''),
    );
  }

  /**
   * Give sessions created before the agent reported its models a real model.
   *
   * A session created while the catalog was still the `acp/default` placeholder has no model, or
   * (before the guard in the POST /api/session handler) carries the placeholder itself. Either
   * way the assistant card's footer cannot resolve it: the card looks the message's
   * `providerID`/`id` up in the model catalog and falls back to printing them verbatim, so a
   * placeholder renders as `acp/unknown`. Adopting the first *real* catalog entry keeps the
   * footer honest without inventing a model the agent never advertised.
   */
  /**
   * The model to name when a session has none of its own: the first *real* catalog entry,
   * never the `acp/default` placeholder. Handing the placeholder to the projection makes the
   * assistant footer print `acp/unknown`, which looks like a broken model rather than "this
   * backend has not reported one".
   */
  /**
   * The first real model in the catalog, or undefined while it is still the placeholder.
   *
   * Accepts `id` as well as `modelID`. The catalog builds every entry with both (see `add()`), but
   * an agent-supplied entry does not always carry `modelID` — measured against the fixture, whose
   * option value produces `{id: "model-1"}` only. Requiring `modelID` made this return undefined
   * for a perfectly real model, so the replay repair saw "no real model" and the card footer kept
   * printing `acp/unknown`.
   */
  /** The real default of THIS ACP session's catalog; the global one only before it exists. */
  /**
   * Is this catalog row a real model, or the `acp/default` placeholder?
   *
   * ★ Identified by the ROW, not by the provider. "providerID !== 'acp'" looked right while
   * every agent put its models under its own provider id — but an agent that advertises no
   * provider grouping (codex-acp) has all 32 of its models under `acp` too, so that test
   * called every one of them a placeholder: `defaultModel()` fell back to nothing, a new
   * session got no model, the TUI submitted the placeholder, and the run reported
   * "Failed to switch model: Internal error" against an agent that had answered perfectly.
   */
  private isRealModel(model: Record<string, unknown>): boolean {
    const id = String(model['modelID'] ?? model['id'] ?? '');
    if (id === '' || id === 'default') return false;
    return typeof model['modelID'] === 'string' || typeof model['id'] === 'string';
  }
  /**
   * The model the agent's own config state names, if it advertises one.
   *
   * `configOptionsFor` is what `session/new`, `session/load` and every
   * `config_option_update` keep current, so it is the agent's answer to "what are you on" —
   * unlike the catalog, whose order says nothing.
   */
  private reportedModelFor(record: SessionRecord): { providerID: string; modelID: string } | undefined {
    const agent = this.agents.get(record.session.id);
    const options = agent?.configOptionsFor(record.acpSessionId);
    return options ? modelFromConfigOptions(options) : undefined;
  }

  private defaultModelFor(record?: SessionRecord): { providerID: string; modelID: string } | undefined {
    // ★ What the AGENT says it is on wins over "the first real entry in the list".
    //
    // The catalog is a menu, and its order is the agent's own — it is not a statement about
    // which entry is running. Measured with `opencode acp` behind a custom provider: the list
    // began with the agent's own free models while `session/new` reported a `currentValue`
    // from the configured provider, so every assistant message was stamped with a model that
    // never answered (the reply was correct and the recorded model was wrong). A user reading
    // the footer, or a transcript reloaded later, was told the wrong thing.
    const reported = record ? this.reportedModelFor(record) : undefined;
    if (reported) return reported;
    const entry = (record ? this.modelCatalog(record).models : this.modelCatalog().models).find((model) =>
      this.isRealModel(model),
    );
    if (!entry) return undefined;
    const providerID = String(entry['providerID']);
    const modelID = String(entry['modelID'] ?? entry['id']);
    return { providerID, modelID };
  }

  private defaultModel(): { providerID: string; modelID: string } | undefined {
    const entry = this.modelCatalog().models.find((model) => this.isRealModel(model));
    if (!entry) return undefined;
    const providerID = String(entry['providerID']);
    const modelID = String(entry['modelID'] ?? entry['id']);
    return { providerID, modelID };
  }

  private adoptCatalogModels(): void {
    for (const record of this.state.all()) {
      const current = record.model;
      if (current && this.isRealModel({ ...current })) continue;
      // The session's own ACP catalog wins; the global catalog is the same agent's
      // other sessions and is only the pre-spawn fallback (one process, one agent).
      const real = this.defaultModelFor(record) ?? this.defaultModel();
      if (!real) continue;
      const previous = current;
      record.model = { providerID: real.providerID, modelID: real.modelID };
      this.log(`[bridge] session ${record.session.id} adopted model ${real.providerID}/${real.modelID}`);
      this.hub.emit({
        type: EVENT.modelSelected,
        data: { sessionID: record.session.id, model: record.model, ...(previous ? { previous } : {}) },
        location: this.location,
      });
      // Replayed history is rebuilt before the catalog arrives — an adopted session's replay
      // starts as soon as the client asks for it, while the model list comes from `session/new`.
      // Any entry built in that window fell back to the placeholder and rendered as
      // `acp/unknown` on the card. Rebuild them now that a real model is known.
      this.rescoreHistoryModels(record, real);
    }
  }

  /** Re-derive the model named by already-replayed history entries once a real one exists. */
  /** Repair every session's replayed history once a real model is known. Idempotent. */
  private repairHistoryModels(): void {
    const real = this.defaultModel();
    if (!real) return;
    for (const record of this.state.all()) this.rescoreHistoryModels(record, real);
  }

  private rescoreHistoryModels(record: SessionRecord, real: { providerID: string; modelID: string }): void {
    if (!record.history || record.history.length === 0) return;
    let changed = 0;
    for (const entry of record.history) {
      // Match on `role` as well as `type`. A stored transcript entry is the projected
      // `Session.Message.Info` (which carries `type`), but an entry can also be a raw
      // `HistoryEntry` from the replay collector, and that shape has only `role`. Reading just
      // `type` here matched nothing, so this repair silently did nothing at all.
      const isAssistant = entry['type'] === 'assistant' || (entry['type'] === undefined && entry['role'] === 'assistant');
      if (!isAssistant) continue;
      const model = entry['model'] as { providerID?: string; id?: string } | undefined;
      if (model && this.isRealModel({ ...model })) continue;
      entry['model'] = { id: real.modelID, providerID: real.providerID };
      changed += 1;
    }
    if (changed > 0) {
      this.log(`[bridge] session ${record.session.id}: named a real model on ${changed} replayed message(s)`);
    }
  }

  /**
   * Follow the backend's title for this session and tell the client when it moves.
   *
   * A rename can arrive two ways: the TUI's PATCH (handled where it lands) or,
   * more interestingly, from anywhere else - the `/session-title` skill writes a
   * request, a backend-side plugin renames it inside the backend, and the bridge would never
   * know. Polling the projection store is what makes the sidebar follow along,
   * and it is the same shape as the SSE keepalive: cheap, idempotent, no events
   * to subscribe to.
   */

  /**
   * A skill id → its inlined text block (the official toModelOutput envelope), or
   * undefined when no skill by that name is installed. Shares the scan /api/skill uses
   * (config skill/skills and the workspace's .opencode/skill(s)), because the prompt
   * body carries only the id the picker chose. The envelope is the official one so an
   * agent sees byte-identical instructions to what the official server would send:
   * content, base directory note, and up to ten sibling files (the official sample).
   */
  private skillBlock(id: string): { type: 'text'; text: string } | undefined {
    const workspace = this.location.directory;
    const roots = [
      join(homedir(), '.config', 'opencode', 'skill'),
      join(homedir(), '.config', 'opencode', 'skills'),
      join(workspace, '.opencode', 'skill'),
      join(workspace, '.opencode', 'skills'),
    ];
    for (const root of roots) {
      const file = join(root, id, 'SKILL.md');
      try {
        const raw = readFileSync(file, 'utf8');
        const directory = join(root, id);
        const files: string[] = [];
        try {
          files.push(
            ...readdirSync(directory, { withFileTypes: true })
              .filter((entry) => entry.isFile() && entry.name !== 'SKILL.md')
              .map((entry) => join(directory, entry.name))
              .sort()
              .slice(0, 10),
          );
        } catch {
          // no siblings to list
        }
        return {
          type: 'text',
          text: [
            `<skill_content name="${id}">`,
            `# Skill: ${id}`,
            '',
            raw.replace(/^---[\s\S]*?---\n/, '').trim(),
            '',
            `Base directory for this skill: ${directory}`,
            'Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.',
            'Note: file list is sampled.',
            '',
            '<skill_files>',
            ...files.map((f) => `<file>${f}</file>`),
            '</skill_files>',
            '</skill_content>',
          ].join('\n'),
        };
      } catch {
        // not under this root
      }
    }
    this.log(`[bridge] prompt mentions an unknown skill: ${id}`);
    return undefined;
  }

  /**
   * Import the agent's own sessions for a directory (`session/list`), so the
   * client's session list shows them and `-c`/`--continue` can pick the latest.
   *
   * The public entry for the launcher's `--continue`: the TUI's -c asks
   * `GET /api/session?limit=1&order=desc` and navigates to the first row —
   * without the import the answer is empty on a fresh bridge (it holds nothing
   * in memory), so "continue the last session" opened a blank conversation
   * instead. Importing up front is the same discovery GET /api/session already
   * does lazily; this just makes it happen before the TUI asks.
   */
  discoverSessions(directory: string): Promise<void> {
    return this.discoverAgentSessions(directory);
  }

  /**
   * The session the user actually PROMPTED this run, for the launcher's exit
   * epilogue — read from memory, not over HTTP.
   *
   * Measured: fetching it over HTTP at child-exit raced the shutdown (the
   * handler logs "the TUI exited, shutting down" before the request arrives,
   * the server closes under it, and the answer is null) — so the owner's
   * Continue line fell back to the native one intermittently, exactly when the
   * shutdown was quick. The launcher holds the server object, so it can just
   * ask the memory the prompt path wrote.
   */
  promptedSessionId(): string | undefined {
    return this.lastPromptedSessionId;
  }

  /**
   * Give an unnamed session the first words of its first prompt.
   *
   * Only once, and only over our own defaults: an agent title, a user rename, or a
   * previously derived title all outrank it (see `SessionRecord.titleFrom*`).
   * Persisted to the session map once the pairing is known, so a restored tab shows
   * the name the conversation got from its first prompt instead of the directory
   * basename (owner's call, 2026-10-18): a plain-ACP agent provides no titles at all,
   * so without this every restore fell back to the directory. The map stores titles
   * already; a derived title is a title, not conversation text.
   */
  /**
   * A title that came back from the map: keep it, and remember that it is not a
   * default, so the first prompt cannot overwrite it. A title carrying a resume
   * marker (`[new conversation] …`) is the exception: the fresh conversation may
   * still be named by its first message.
   */
  private adoptStoredTitle(record: SessionRecord, title: string | undefined): void {
    if (!title) return;
    record.session.title = title;
    if (stripTitleMarkers(title) === title) record.titleRestored = true;
  }

  private deriveTitle(record: SessionRecord, text: string): void {
    if (record.titleFromAgent || record.titleFromUser || record.titleDerived || record.titleRestored) return;
    const title = derivedTitle(text);
    if (!title) return;
    record.titleDerived = true;
    record.session.title = title;
    // The pairing may already be known (an adopted session being prompted); when it is
    // not, the pairing write that follows in `ensureAgent` carries the title instead.
    this.persistTitle(record);
    this.log(`[bridge] title from the first message: ${title}`);
    this.hub.emit({
      type: EVENT.sessionUpdated,
      data: { session: record.session },
      location: this.location,
    });
    // The TUI's store has no case for `session.updated`; this is the frame that moves
    // the tab's title.
    this.hub.emit({
      type: EVENT.sessionRenamed,
      data: { sessionID: record.session.id, title },
      location: this.location,
    });
  }

  /**
   * Persist a session's current title into the map.
   *
   * The title is **bidirectional**: we derive one from the first prompt, the agent
   * pushes one (`session_info_update`), `session/list` carries one, and the user can
   * rename. Whichever wins in memory, the map must hold the LATEST title — otherwise a
   * restore shows a stale one (measured: a plain-ACP session whose agent provides no
   * titles fell back to the directory basename on every reopen). The map's `title` field
   * therefore means "the conversation's last known name", not "the agent's title"; the
   * in-memory ranking (`titleFromAgent` > `titleFromUser` > derived) is unchanged.
   *
   * Markers (`[no history] …`) are display decoration added at restore time and are
   * never persisted.
   */
  /**
   * Apply the TUI's `/thinking` pick (`model.variant`) to the agent's effort option.
   *
   * Sent as `session/set_config_option` on the option `isEffortOption` finds, with the
   * variant id as the value — the same values the picker was given. Skipped when the agent
   * already reports that value, and when there is no effort option at all (an agent without
   * one cannot have offered the variant). A refusal is thrown to the caller, which answers
   * 400 with the agent's own message rather than a 204 that would let the TUI claim a level
   * the session is not on.
   */
  private async applyVariant(
    record: SessionRecord,
    agent: AcpClient,
    acpSessionId: string,
    variant: string | undefined,
  ): Promise<void> {
    if (!variant) return;
    const sessionOptions = agent.configOptionsFor(record.acpSessionId);
    const effortOptions = sessionOptions.length > 0 ? sessionOptions : agent.anyConfigOptions();
    const option = effortOptions.find(isEffortOption);
    if (!option) {
      this.log(`[bridge] /model: variant '${variant}' asked for, but this agent has no effort option`);
      return;
    }
    const configId = String(option.id ?? option.configId);
    if (option.currentValue === variant) {
      this.log(`[bridge] /model: ${configId} is already '${variant}'`);
      return;
    }
    await agent.setConfig(acpSessionId, configId, variant);
    this.log(`[bridge] ${configId} -> ${variant}`);
  }

  private persistTitle(record: SessionRecord): void {
    const title = record.session.title;
    if (!title || !record.acpSessionId) return;
    this.sessionMap.rememberBoth(
      record.session.id,
      record.acpSessionId,
      record.directory ?? this.options.directory,
      title,
      record.agent ?? this.agentBinding(),
    );
    this.sessionMap.flush();
  }

  /**
   * The last session the client read or focused, for the exit epilogue's
   * fallback tier. Kept separate from `promptedSessionId()` so the ranking lives
   * in one readable place (`epilogueSessionId` in the launcher) instead of
   * hiding inside an accessor.
   */
  /**
   * Append a non-conversation notice to a session's transcript.
   *
   * Projected as the client's `Session.Message.System`, which the TUI renders as a
   * `◈ Notice` row — the same surface the official client uses for "Instructions
   * updated". The bridge uses it to say WHY a restored tab is empty: the session
   * resumed, but the agent has no `session/load`, so the earlier conversation is
   * not replayed. A notice is not a user or assistant turn, so it never counts as
   * conversation content and does not affect the turn lifecycle.
   */
  private appendNotice(record: SessionRecord, text: string, description: string = text): void {
    this.state.addMessage(record, {
      id: this.state.newId('msg'),
      sessionID: record.session.id,
      role: 'assistant',
      time: { created: Date.now() },
      // ★ `description` is what the TUI DRAWS (`◈ <description>`); `text` is the
      // model-facing copy. Omitting it is not "no description" on screen — the client
      // falls back to "Instructions updated", which reads like an unrelated system
      // event (measured in the real TUI before this line existed).
      notice: { text, description },
    });
  }

  viewedSessionId(): string | undefined {
    return this.lastViewedSessionId;
  }

  private async discoverAgentSessions(directory: string): Promise<void> {
    if (this.discoveredSessionDirectories.has(directory)) return;
    const inFlight = this.discoveringSessionDirectories.get(directory);
    if (inFlight) return inFlight;

    const discover = (async () => {
      const agent = new AcpClient({
        command: this.options.command,
        args: this.options.args ?? [],
        cwd: directory,
        env: this.options.env,
        onLog: (line) => this.log(`[acp:session-list] ${line}`),
      });
      try {
        // initialize spawns the agent — and the agent may create a shell
        // session right on startup (measured: dsh's session/new on init). So
        // the "before" snapshot must come AFTER initialize but BEFORE any
        // list... which is impossible when the shell is born by initialize
        // itself. What IS observable: the sessions that appear between two
        // consecutive lists done by THIS connection, minus nothing — the
        // shell dsh creates on initialize exists already by the first list.
        // So a snapshot cannot separate "born by us" from "born earlier".
        //
        // The workable rule, measured on dsh's store: a shell session has NO
        // messages (≤8 journal lines: session header + presets + policies).
        // The list result carries no counts, but a subsequent session/load of
        // a shell replays ZERO updates — and load is how -c's pick gets its
        // history anyway. Sessions that load empty are therefore filtered at
        // the point that matters: they are not IMPORTED, so they never reach
        // the TUI's list, so -c cannot pick them.
        await agent.initialize();
        if (!agent.capabilities.listSessions) {
          this.log('[bridge] session/list unavailable: agent did not advertise sessionCapabilities.list');
          return;
        }
        const sessions = await agent.listSessions(directory);
        const location: Location = {
          directory,
          project: { id: projectIdFor(directory), directory, canonical: directory },
        };
        let imported = 0;
        for (const session of sessions) {
          // An untitled list of every backend UUID would make the tab bar worse. Import the
          // conversations the backend has named; newly-created bridge sessions are already in
          // state and become titled through the normal session_info_update path.
          const title = session.title?.trim();
          if (!title || session.cwd !== directory) continue;
          // A session the agent titled but whose LAST conversation predates
          // this map is still a real one. But a session that is titled YET
          // unknown to the map AND born this very second is this discovery
          // connection's own shell (dsh creates one on initialize; measured:
          // 37 empty shells in one workspace from successive probes) — and
          // that shell, "newest" by creation time, is what -c kept picking
          // over the real conversation. The map is written only on real use,
          // so an unmapped session titled milliseconds after the connection
          // spawned is a shell with near-certainty. Skip it: it never reaches
          // the TUI's list, so -c cannot pick it.
          // ★ The map decides, and ONLY the map.
          //
          // The `?? \`ses_acp_${…}\`` fallback gave an alias to EVERY titled session the
          // agent listed, so the agent's own private conversations were adopted as this
          // bridge's. Measured with one third-party dsh ACP profile: `session/list` returns 22
          // sessions for one directory, 21 of them titled "You are a careful implementer."
          // — dsh's internal ones. Every one became a map row, a TUI tab and a
          // `session.created` event; `-c` then restored them beside the conversation the
          // user wanted, and the ghost tab was frequently the one focused.
          //
          // This runs on `GET /api/session`, which the TUI issues at startup, so the
          // pollution re-appeared on every launch and survived cleaning the map — the only
          // fix is to stop inventing ids. A session the map does not pair was never created
          // through this bridge, and ACP gives no way to tell a user's conversation from an
          // agent's own, so adopting either means adopting both.
          const visibleId = this.sessionMap.visibleIdFor(session.sessionId, directory);
          if (!visibleId) continue;
          const time = resolveSessionTime(session.updatedAt, this.sessionMap.timesFor(visibleId));
          const record = this.state.createSession(location, title, visibleId, time);
          if (record.messages.length === 0 && !record.history && time?.updated !== undefined) {
            record.session.time.updated = time.updated;
            record.session.time.created = time.created ?? time.updated;
          }
          record.directory = directory;
          record.acpSessionId = session.sessionId;
          record.session.acpSessionId = session.sessionId;
          record.session.title = title;
          const rememberedMode = this.sessionMap.modeFor(visibleId);
          if (rememberedMode && !record.session.agent) record.session.agent = rememberedMode;
          this.sessionMap.rememberBoth(
            visibleId,
            session.sessionId,
            directory,
            title,
            this.agentBinding(),
          );
          // The TUI's tab store is event-driven. Returning this row in GET /api/session alone
          // does not add a newly discovered backend conversation to its tab bar; the same
          // session.created shape used for normal POST creation makes the titled tab visible.
          this.hub.emit({
            type: EVENT.sessionCreated,
            data: { sessionID: record.session.id, session: record.session },
            location,
          });
          imported += 1;
        }
        this.sessionMap.flush();
        if (imported > 0) this.log(`[bridge] session/list imported ${imported} titled session(s) for ${directory}`);
      } catch (err) {
        // Discovery is additive. A generic agent may not support it, may be slow or may have
        // a broken store; the bridge's own new-session path must remain usable either way.
        this.log(`[bridge] session/list discovery failed for ${directory}: ${String(err)}`);
      } finally {
        this.discoveredSessionDirectories.add(directory);
        this.discoveringSessionDirectories.delete(directory);
        await agent.dispose().catch(() => undefined);
      }
    })();
    this.discoveringSessionDirectories.set(directory, discover);
    return discover;
  }

  private ensureSession(requestedDirectory?: string | null): SessionRecord {
    const existing = this.state.all()[0];
    if (existing) return existing;
    // Title after the directory. Every bridge session defaulting to "default"
    // leaves the client (which remembers sessions across runs) showing a row of
    // indistinguishable tabs.
    const fallbackName =
      this.options.directory.split(/[\\/]/).filter(Boolean).pop() ?? this.options.directory;
    // The backend's own title arrives as `session_info_update`; until it does,
    // the directory basename keeps the client's tab row readable.
    const name = fallbackName;
    // When resuming, the record is keyed by the id the CLIENT was launched with
    // (`resumeVisibleSessionId`), while the agent-side id lives in
    // `record.acpSessionId` (set at load time from `resumeSession`). Keying the
    // record by the agent's UUID once made the TUI's `--session ses_…` miss it,
    // adopt, and double-load the backend session — which a one-writer-per-session
    // backend then refused, leaving an empty "resumed" conversation.
    const resumeId = this.options.resumeVisibleSessionId ?? this.options.resumeSession;
    const rememberedTime =
      resumeId !== undefined ? resolveSessionTime(undefined, this.sessionMap.timesFor(resumeId)) : undefined;
    const record = this.state.createSession(
      this.location,
      name,
      resumeId,
      rememberedTime,
    );
    // Decision (owner, 2026-10-14): a session belongs to the workspace the client named,
    // and only then. `cwd` is a required `session/new` field in ACP, so per-session
    // directories are the protocol's own model; setting one unconditionally is what broke
    // the TUI, which checks that a session's location matches the directory it works in.
    if (requestedDirectory) record.directory = requestedDirectory;
    // ★ `-s` pre-creates the record before any agent work, and the prompt path derives
    // its title BEFORE `ensureAgent` runs. Adopt the map's title here, at creation, so
    // the first prompt already sees a restored title and cannot replace it (reported
    // 2026-10-20: the tab and sidebar were renamed by the first prompt).
    if (this.options.resumeVisibleSessionId !== undefined) {
      const remembered = this.sessionMap.titleFor(record.session.id);
      if (remembered) this.adoptStoredTitle(record, remembered);
    }
    if (resumeId !== undefined) {
      const rememberedMode = this.sessionMap.modeFor(record.session.id);
      if (rememberedMode) record.session.agent = rememberedMode;
    }
    // Not a conversation yet: `POST /api/session` adopts it (see `rekeySession`).
    if (this.options.resumeSession === undefined && this.options.resumeVisibleSessionId === undefined) {
      record.precreated = true;
    }
    // `-s <id>` / `-c` name a session directly, bypassing the adoption branch — so a session
    // another agent created has to be bound here too, or `session/resume` would be sent to
    // the wrong backend (measured: an empty tab, no explanation).
    const resumedForeign =
      this.options.resumeSession !== undefined || this.options.resumeVisibleSessionId !== undefined
        ? this.sessionMap.agentFor(record.session.id)
        : undefined;
    if (resumedForeign && agentBindingLabel(resumedForeign) !== agentBindingLabel(this.agentBinding())) {
      const message =
        `session ${record.session.id} belongs to '${agentBindingLabel(resumedForeign)}', ` +
        `not '${agentBindingLabel(this.agentBinding())}' — one client drives one agent; ` +
        `launch with the owning agent instead`;
      this.log(`[bridge] ${message}`);
      throw new Error(message);
    }
    // A resumed session never goes through POST /api/session, which is where the
    // catalogue default is normally applied; without it `step.started` reports no
    // model and the sidebar's context meter gives up.
    const first = this.modelCatalog().models[0] as { providerID?: string; modelID?: string } | undefined;
    if (first?.providerID && first.modelID) {
      record.model = { providerID: first.providerID, modelID: first.modelID };
    }
    this.log(`[bridge] pre-created session ${record.session.id}`);
    // Eagerly open the ACP session. the backend only advertises its model list on
    // `session/new`, and the client's composer stays silently locked until
    // `/api/model` and `/api/agent` are non-empty, so waiting for the first
    // prompt would deadlock the UI. Fire and forget: the prompt path awaits
    // the same in-flight promise via `ensureAgent`.
    //
    // ★ Except in continue-mode: there, the conversation the user wants is the
    // imported one, and the eager spawn here measured as a SECOND agent process
    // on the same workspace whose presence made the adopted conversation's
    // session/load fail (dsh, one writer per workspace). The empty record is
    // navigated away from immediately; its catalog arrives with the adopted
    // session's replayed config.
    if (this.options.continueMode) {
      // `-c` was asked for but nothing could be resolved (no `session/list`, or the
      // agent listed nothing for this directory). The record the client's own `-c`
      // lands on is therefore a NEW conversation; say so in the only place the user
      // can see it, instead of leaving the directory name looking like a
      // continuation that silently lost its history.
      record.session.title = markTitle(record.session.title, name, '[new conversation]');
      const reason = this.options.continueModeReason;
      this.appendNotice(
        record,
        reason === 'no-list'
          ? 'Cannot continue: this agent has no sessionCapabilities.list capability, so a new conversation was started here'
          : reason === 'nothing'
            ? 'Nothing to continue in this directory, so a new conversation was started here'
            : reason === 'failed'
              ? "Could not list this agent's sessions, so a new conversation was started here"
              : 'Could not continue the previous conversation, so a new conversation was started here',
      );
      this.log(
        '[bridge] continue-mode: nothing to continue, so this is a NEW conversation (pre-created session stays lazy)',
      );
      return record;
    }
    void this.ensureAgent(record).catch((err) => {
      this.log(`[bridge] eager session/new failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    // Announce it so a client that attached first still learns about it.
    setTimeout(() => {
      this.hub.emit({
        type: EVENT.sessionCreated,
        data: { sessionID: record.session.id, session: record.session },
        location: this.location,
      });
    }, 0);
    return record;
  }

  private async prompt(
    record: SessionRecord,
    body: unknown,
    json: (data: unknown, status?: number) => void,
    located: (data: unknown) => void,
    /** Answer 204 instead of 200+body on success: POST /command declares `empty: true`. */
    answer204 = false,
  ): Promise<void> {
    const payload = (body ?? {}) as PromptBody;
    // ★ The prompt IS the activity signal: record it for the exit epilogue, and
    // record it FIRST — the idempotent-replay branch below (the TUI re-sending a
    // prompt id it already sent) returns before any turn work, and with the
    // assignment further down the owner's Continue line fell back to the native
    // one whenever that replay was the last request of the run (measured).
    // Guessing (the session map's newest entry) once printed the WRONG id
    // instead, because any touch updates `updatedAt`, not only prompts.
    this.lastPromptedSessionId = record.session.id;
    // The success answer differs per route (200+placeholder vs 204-empty); the errors
    // below stay json() so every declared failure status keeps its spec body.
    const answer = answer204 ? () => json(undefined, 204) : located;
    // Before anything else: refuse rather than pretend. A dropped attachment is a
    // silent lie to the person who attached it.
    const unsupported = unsupportedAttachments(payload);
    if (unsupported.length > 0) {
      this.log(`[bridge] prompt attachments have no ACP route: ${unsupported.join(', ')}`);
      json(
        {
          error: `attachment not supported: ${unsupported.join(', ')}`,
          detail: 'this client can forward image attachments and file:// resource links only — it announces no fs/* or terminal/* capability',
        },
        400,
      );
      return;
    }
    // Skills are inlined as text, the way the official server does it (core/skill.ts
    // toModelOutput → runner/to-llm-message.ts puts the skill before the user text).
    // The first version sent an ACP resource_link instead — spec-legal ("all agents
    // MUST support resource links") but measured toothless: the agent treats a link as a
    // reference and never applies the skill; a caveman-attached prompt came back as a
    // fourteen-section essay. Inline text is what makes the skill actually execute, on
    // any agent, because that is the shape the official server sends.
    const skillBlocks = (payload.skills ?? [])
      .map((skill) => (skill.id ? this.skillBlock(skill.id) : undefined))
      .filter((block): block is { type: 'text'; text: string } => block !== undefined);
    if (skillBlocks.length > 0 || (payload.agents?.length ?? 0) > 0) {
      this.log(
        `[bridge] prompt mentions: skills forwarded ${skillBlocks.length}, agents logged (not forwarded) ${(payload.agents?.length ?? 0)}`,
      );
    }
    // Skill text FIRST, user text second — the official order (runner/to-llm-message.ts:
    // skills' text blocks precede the message text). Reversed, the model reads the
    // skill as a trailing afterthought and the user's phrasing ("讲清楚每一个细节")
    // wins the style contest; measured: caveman attached last produced a full essay.
    const blocks = [...skillBlocks, ...promptParts(payload)];
    if (blocks.length === 0) {
      json({ error: 'prompt has no parts' }, 400);
      return;
    }

    // Echo the user's message immediately: the client renders it optimistically
    // and the TUI has nothing to show until the agent streams otherwise.
    const userId = payload.id ?? payload.messageID ?? this.state.newId('msg');
    const promptText = promptParts(payload)
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => String(b.text))
      .join('');
    // Name the session after what the user actually asked. The agent's own title
    // wins if it ever arrives; a rename in the client wins immediately.
    this.deriveTitle(record, promptText);
    const requested = payload.delivery === 'queue' ? 'queue' : 'steer';
    // ACP has no "steer into the running turn": the only truthful reading of a
    // follow-up sent mid-turn is "after this one". The TUI sends `delivery: "steer"`
    // for exactly that gesture, so a busy session queues it rather than forwarding a
    // second `session/prompt` — which the agent rejects ("Session already has an
    // active ACP prompt") and whose error used to end the running turn's progress
    // indicator, while the turn itself kept streaming (measured).
    const busy = record.busy || this.promptsInFlight.has(record.session.id);
    const delivery = busy ? 'queue' : requested;
    // The client admits a row optimistically under this id and reconciles from
    // `session.inbox.enqueued`, so the echo must carry the id it sent.
    this.hub.emit({
      type: EVENT.inboxEnqueued,
      data: {
        sessionID: record.session.id,
        inboxID: userId,
        item: { type: 'user', payload: { text: promptText }, delivery },
      },
      location: this.location,
    });
    // The client may retry a durable prompt after reconnecting. Its id is the id of the
    // optimistic user row, so accepting it twice must not add a second row or start a second
    // agent turn; the official TUI data suite relies on this deduplication.
    const existingUser = this.state.getMessage(record, userId);
    if (existingUser) {
      const existingParts = this.state.partsOf(record, userId);
      answer({ info: existingUser, parts: existingParts });
      return;
    }
    const userMessage = {
      id: userId,
      sessionID: record.session.id,
      role: 'user' as const,
      time: { created: Date.now(), completed: Date.now() },
    };
    this.state.addMessage(record, userMessage);
    this.hub.emit({
      type: EVENT.messageUpdated,
      data: { sessionID: record.session.id, messageID: userId, role: 'user' },
      location: this.location,
    });
    for (const block of blocks) {
      if (block.type !== 'text' || typeof block.text !== 'string') continue;
      const part: TextPart = {
        id: this.state.newId('prt'),
        sessionID: record.session.id,
        messageID: userId,
        type: 'text',
        text: block.text,
        time: { start: Date.now(), end: Date.now() },
      };
      // Store it as well as stream it. A client reading the transcript gets no
      // events, and `Session.Message.User.text` is built from these parts — with
      // them missing, a reopened session showed the user's turn as an empty row
      // (the real TUI rendered the reply and nothing else).
      this.state.upsertPart(record, userId, part);
      this.hub.emit({
        type: EVENT.messagePartUpdated,
        data: {
          sessionID: record.session.id,
          messageID: userId,
          time: Date.now(),
          part,
        },
        location: this.location,
      });
    }

    if (busy) {
      // Held until the running turn finishes; see deliverPending().
      this.pendingInbox.set(userId, {
        sessionID: record.session.id,
        inboxID: userId,
        text: promptText,
        delivery,
      });
      this.log(
        `[bridge] queued prompt ${userId} (${this.pendingInbox.size} pending; requested ${requested}, ACP cannot steer)`,
      );
      answer({ info: userMessage, parts: [] });
      return;
    }
    this.hub.emit({
      type: EVENT.inboxDelivered,
      data: { sessionID: record.session.id, inboxID: userId },
      location: this.location,
    });

    // A prompt the bridge accepted IS "the conversation the user is working in" — the only
    // thing `-c` may rank by. Metadata writes (session/list imports, `/cd`, restored
    // titles) must not move this stamp, or one import re-dates every row in the directory
    // and `-c` resumes whichever the walk hit first (measured 2026-10-27).
    this.noteUsed(record);
    // Serialize the agent's prompts: ACP allows one active prompt per session, and
    // two requests can both pass the `busy` check while the first waits on
    // `ensureAgent` (that await yields).
    this.promptsInFlight.add(record.session.id);
    let started: { agent: AcpClient; sessionId: string };
    try {
      started = await this.ensureAgent(record);
    } catch (err) {
      this.promptsInFlight.delete(record.session.id);
      // ★ A turn that cannot BEGIN used to fail on the wire only: the request
      // rejected, nothing reached the transcript, and the screen kept the optimistic
      // user row with nothing after it — no spinner, no error, no end. That is the
      // "silently stuck" shape the repo already documented as path ② of silent
      // failure; the honest answer is to say it where the user is looking.
      const reason = err instanceof Error ? err.message : String(err);
      this.log(`[bridge] could not start the agent for '${record.session.id}': ${reason}`);
      // A turn that could not start still renders a row: name it after the launch command,
      // which is all we know when the agent never got to say who it is.
      const failedTranslator = this.translatorFor(record, this.launchName());
      const failedId = failedTranslator.beginTurn(record);
      failedTranslator.endTurn(record, { error: `could not start the agent: ${reason}` });
      answer({ info: this.state.getMessage(record, failedId) ?? userMessage, parts: [] });
      return;
    }
    const { agent, sessionId: acpSessionId } = started;
    // The new session may have been created before its agent advertised the catalog;
    // adopt the real default now, and tell the client, so the composer/footer stop
    // showing `default acp` before the first token.
    this.adoptCatalogModels();
    const translator = this.translators.get(record.session.id) ?? this.attachTranslator(record, agent);

    const caps = agent.capabilities;
    const { kept, dropped } = filterPromptBlocks(blocks as Array<{ type: string }>, caps);
    if (dropped.length > 0) {
      this.log(`[bridge] dropped unsupported prompt blocks: ${dropped.join(', ')}`);
      // Say it in the transcript too: an attachment that silently disappears reads as
      // "the bridge lost my image", when the truth is the AGENT did not advertise the
      // capability. One notice per kind, naming the capability.
      const explained = new Set<string>();
      for (const kind of dropped) {
        const line =
          kind === 'image' || kind === 'audio'
            ? `${kind === 'image' ? 'Image' : 'Audio'} attachment dropped: this agent has no promptCapabilities.${kind} capability`
            : kind === 'resource'
              ? 'Embedded context dropped: this agent has no promptCapabilities.embeddedContext capability'
              : `Attachment dropped (${kind}): this agent does not advertise that prompt capability`;
        if (explained.has(line)) continue;
        explained.add(line);
        this.appendNotice(record, line);
      }
    }

    const assistant = translator.beginTurn(record);
    const message = this.state.getMessage(record, assistant);
    answer({ info: message, parts: [] });

    // Run the turn in the background: the HTTP response is the placeholder, the
    // rest arrives on /api/event. Awaiting here would block the request for the
    // whole turn and the client would time out.
    void (async () => {
      try {
        const result = await this.runPrompt(agent, acpSessionId, kept);
        translator.recordPromptUsage(record, (result as { usage?: unknown } | undefined)?.usage);
        this.log(`[bridge] prompt settled stopReason=${JSON.stringify((result as { stopReason?: string } | undefined)?.stopReason)}`);
        translator.endTurn(record, turnOutcome(result, record));
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        if (text.includes('agent exited')) {
          translator.endTurn(record, { error: text });
        } else if (text.includes('timed out')) {
          translator.endTurn(record, { error: text });
        } else {
          translator.endTurn(record, { error: text });
        }
      }
    })().finally(() => {
      this.promptsInFlight.delete(record.session.id);
      void this.deliverPending(record, agent);
    });
  }

  /**
   * `agent.prompt` with one recovery step for a stale "active prompt".
   *
   * This is the desync the mid-turn steer used to cause: our record says idle, the
   * agent still has a prompt registered, and it answers `Session already has an
   * active ACP prompt` — which used to surface as a red line at the end of the new
   * reply. A cancel clears the agent's stale prompt; then the prompt runs once.
   */
  private async runPrompt(
    agent: AcpClient,
    acpSessionId: string,
    blocks: Parameters<AcpClient['prompt']>[1],
  ): Promise<Awaited<ReturnType<AcpClient['prompt']>>> {
    try {
      return await agent.prompt(acpSessionId, blocks);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (!/already has an active ACP prompt/i.test(text)) throw err;
      this.log(
        `[bridge] the agent still reports an active prompt for ${acpSessionId}; cancelling the stale turn and retrying once`,
      );
      agent.cancel(acpSessionId);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return await agent.prompt(acpSessionId, blocks);
    }
  }

  /**
   * Run the next queued prompt for this session. The client only ever sees the
   * hand-off (`session.inbox.delivered`); the turn itself is identical to a
   * steer, so it reuses the same translator.
   */
  private async deliverPending(record: SessionRecord, agent: AcpClient): Promise<void> {
    const next = [...this.pendingInbox.values()].find((entry) => entry.sessionID === record.session.id);
    if (!next) return;
    this.pendingInbox.delete(next.inboxID);
    this.log(`[bridge] delivering queued prompt ${next.inboxID} (${this.pendingInbox.size} left)`);
    this.hub.emit({
      type: EVENT.inboxDelivered,
      data: { sessionID: record.session.id, inboxID: next.inboxID },
      location: this.location,
    });
    const translator = this.translators.get(record.session.id);
    if (!translator) return;
    this.promptsInFlight.add(record.session.id);
    translator.beginTurn(record);
    try {
      const result = await this.runPrompt(agent, record.acpSessionId ?? record.session.id, [
        { type: 'text', text: next.text },
      ]);
      translator.recordPromptUsage(record, (result as { usage?: unknown } | undefined)?.usage);
      translator.endTurn(record, turnOutcome(result, record));
    } catch (err) {
      translator.endTurn(record, { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.promptsInFlight.delete(record.session.id);
    }
    await this.deliverPending(record, agent);
  }

  /**
   * A valid `SessionStatsInfo` with no activity. The bridge keeps no usage
   * ledger, but the shape must be complete: `/stats` reads `stats.range.from`
   * and `stats.tokens` unguarded.
   */
  private emptyStats(): Record<string, unknown> {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    return {
      range: { from: now - 30 * day, to: now },
      sessions: this.state.all().length,
      subagents: 0,
      prompts: 0,
      steps: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
      tools: { mode: 'none' },
      activeDays: 0,
      streak: 0,
      activity: [],
      models: [],
    };
  }

  // ---------------------------------------------------------------- shells

  private startShell(command: string, cwd?: string, sessionId?: string, clientId?: string): ShellRun {
    // The client chooses this id itself (the SDK sends `{id, command}` and expects 204),
    // then matches the `session.shell.started` / `.ended` events against the row it
    // created. Generating our own id made every event land on an id the client had never
    // seen: the row appeared and stayed empty, which is what `!ls` looked like.
    const id = clientId ?? this.state.newId('sh');
    const workdir = cwd ?? this.options.directory;
    const child = spawn(command, {
      cwd: workdir,
      shell: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group. `shell: true` means the direct child is a shell,
      // so killing the pid alone leaves whatever it spawned (`!sleep 300`)
      // running with no parent — an orphan when the bridge exits.
      //
      // ★ POSIX only. On Windows `detached` puts the child in a new process group AND
      // detaches it from the console, and the pipes then deliver NOTHING: measured on a
      // Windows 11 VM, `spawn(cmd, {shell: true, detached: true})` exits 0 with an empty
      // stdout while the same call with `detached: false` returns the output. The whole
      // `!command` surface was blank there for that reason. `windowsKillArgs` already
      // handles the tree with `taskkill /T`, so this flag buys nothing on Windows anyway.
      detached: process.platform !== 'win32',
    });
    const record: ShellRun = {
      sessionID: sessionId,
      directory: workdir,
      id,
      command,
      cwd: workdir,
      metadata: {},
      shell: process.env.SHELL ?? '/bin/sh',
      file: '',
      status: 'running',
      output: '',
      time: { started: Date.now() },
      child,
      pid: child.pid,
    };
    this.shells.set(id, record);

    const append = (chunk: Buffer): void => {
      record.output += chunk.toString('utf8');
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (err) => {
      record.output += `${err.message}\n`;
      this.finishShell(record, 'exited');
    });
    child.on('close', (code) => {
      record.exit = code ?? undefined;
      this.finishShell(record, 'exited');
    });

    // Only for the session that asked: the first-session fallback this replaces put the
    // row in whichever session happened to be first, and the session-scoped route emits
    // for itself, so guessing here also produced two rows.
    if (sessionId) {
      this.emitShellTool(sessionId, record.id, command, workdir, { status: 'running' });
      this.hub.emit({
        type: EVENT.shellStarted,
        id: this.eventIdForShell(record.id),
        data: { sessionID: sessionId, shell: this.shellInfo(record) },
        // The client's store reads `event.metadata` (top level) for non-background
        // shells and hangs it on the message it inserts.
        metadata: {},
        location: this.location,
      });
    }
    return record;
  }

  /**
   * Stop a shell and everything it started.
   *
   * The direct child is a shell (`shell: true`), so a plain `child.kill()`
   * leaves the real command running. Signalling the whole process group is what
   * makes `!sleep 300` actually stop.
   */
  private killShell(record: ShellRun): void {
    const pid = record.child.pid;
    if (pid !== undefined) {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        // Group already gone, or never detached; fall through to the child.
        try {
          record.child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
      }
    }
    if (record.status === 'running') this.finishShell(record, 'killed');
  }

  /**
   * The envelope id a shell event must carry, matched to the shipped client.
   *
   * Read from v2.0.28, not guessed: the transport derives
   *   eventIDFromMessage(id) = id.replace(/^msg_/, 'evt_')
   * and the store derives the inverse, `evt_` -> `msg_`. So the request arrives with
   * `id: msg_abc`, the wait binds by comparing its `eventID` (`evt_abc`) with the event's
   * id, and the store turns that same id back into `msg_abc` to find the row it inserted.
   * Sending the raw `msg_abc` as the envelope id satisfied neither.
   */
  /**
   * The event id for a shell's own events.
   *
   * Both v2 client generations derive the shell MESSAGE id from the event id with
   * `event.id.replace(/^evt_/, "msg_")` (`SessionMessage.ID.fromEvent` in the store, and
   * the same replace in the TUI's rows). Returning the bare `sh_…` id therefore produced
   * a row that pointed at `sh_…` while the store's message is `msg_sh_…`: v2.1's rows
   * appended the row anyway, but v2.2 resolves `props.message(row.messageID)` before
   * rendering it and dropped the row entirely — a `!command` showed nothing at all.
   */
  private eventIdForShell(shellId: string): string {
    if (shellId.startsWith('evt_')) return shellId;
    // The client chooses the shell's message id (`msg_…`) and derives the event id it
    // waits for as `id.replace(/^msg_/, "evt_")`. Mirror that exactly: a bare `sh_…`
    // id has nothing to strip, and blindly prefixing produced `evt_msg_…` where the
    // client expects `evt_…` — either way its wait never resolved.
    const bare = shellId.startsWith('msg_') ? shellId.slice(4) : shellId;
    return `evt_${bare}`;
  }

  /**
   * Record a `!command` as the client's own shell message, keyed by shell id.
   *
   * The published schema gives a shell its **own top-level message type**
   * (`Session.Message.Shell`: `{type:"shell", shellID, command, status, exit?, output?}`), and
   * the TUI matches on `message.type === "shell"` to render it. This is what a reopened
   * transcript is rebuilt from, so a shell stored any other way — a `tool` part, say — came
   * back as a generic tool card without its shell context. Updating in place keeps one row for
   * the whole run, which is also what the client does with `session.shell.ended`.
   */
  private rememberShell(
    record: SessionRecord,
    shell: {
      id: string;
      sessionID: string;
      shellID: string;
      command: string;
      cwd?: string;
      status: 'running' | 'exited' | 'failed';
      exit?: number;
      output?: string;
      created: number;
      completed?: number;
    },
  ): void {
    const existing = this.state.getMessage(record, shell.id);
    const payload: NonNullable<Message['shell']> = {
      shellID: shell.shellID,
      command: shell.command,
      ...(shell.cwd === undefined ? {} : { cwd: shell.cwd }),
      status: shell.status,
      ...(shell.exit === undefined ? {} : { exit: shell.exit }),
      ...(shell.output === undefined ? {} : { output: shell.output }),
    };
    if (existing) {
      existing.shell = payload;
      if (shell.completed !== undefined) {
        existing.time = { created: existing.time.created, completed: shell.completed };
      }
      record.session.time.updated = Date.now();
      return;
    }
    this.state.addMessage(record, {
      id: shell.id,
      sessionID: shell.sessionID,
      role: 'assistant',
      time:
        shell.completed === undefined
          ? { created: shell.created }
          : { created: shell.created, completed: shell.completed },
      shell: payload,
    });
  }

  /**
   * The tool row the transcript expands a `!command` in.
   *
   * Read from the shipped source: `packages/tui/src/routes/session/rows.ts` creates a
   * message from `session.shell.started` using `event.id.replace(/^evt_/, "msg_")`, and
   * `packages/tui/src/routes/session/index.tsx` renders that message's tool part with
   * `Shell(props: ToolProps)`, reading `props.metadata.shellID`, `props.input.command`,
   * `props.input.workdir` and `props.part.state.status`, then fetching the text from
   * `/api/shell/:id/output` itself. Emitting only `session.shell.*` created no such part, so
   * there was nothing to expand — the shapes below are copied from our own tool events,
   * which the real-TUI acceptance already proves render.
   */
  private emitShellTool(
    sessionId: string,
    shellId: string,
    command: string,
    workdir: string,
    outcome: { status: 'running' } | { status: 'completed'; output: string } | { status: 'failed'; output: string },
  ): void {
    const assistantMessageID = `msg_${shellId.replace(/^sh_/, 'sh_')}`;
    const id = `part_${shellId}`;
    // Store the row as a real tool part, not just an event. The transcript a client reads after
    // a restart is rebuilt from stored parts (`projectMessage`), so a row that only ever existed
    // in the event stream disappeared from history — which is exactly what `!ls` did: present
    // while live, absent after reopening the session.
    const record = this.state.all().find((candidate) => candidate.session.id === sessionId);
    const started = Date.now();
    if (record) {
      this.rememberShell(record, {
        id: `msg_${shellId}`,
        sessionID: sessionId,
        shellID: shellId,
        command,
        cwd: workdir,
        status: 'running',
        created: started,
      });
    }
    if (outcome.status === 'running') {
      this.hub.emit({
        type: EVENT.toolInputStarted,
        // `evt_` + the shell id, so the client derives `msg_<shellId>` for the row — the
        // same message the `session.shell.started` event lands in.
        id: `evt_${shellId}`,
        data: { sessionID: sessionId, assistantMessageID, id, name: 'shell' },
        location: this.location,
      });
      this.hub.emit({
        type: EVENT.toolInputEnded,
        data: { sessionID: sessionId, assistantMessageID, id, text: JSON.stringify({ command }) },
        location: this.location,
      });
      this.hub.emit({
        type: EVENT.toolCalled,
        data: {
          sessionID: sessionId,
          assistantMessageID,
          id,
          input: { command, workdir },
          executed: true,
          state: undefined,
        },
        location: this.location,
      });
      return;
    }
    if (record) {
      this.rememberShell(record, {
        id: `msg_${shellId}`,
        sessionID: sessionId,
        shellID: shellId,
        command,
        cwd: workdir,
        status: outcome.status === 'completed' ? 'exited' : 'failed',
        exit: outcome.status === 'completed' ? 0 : 1,
        output: outcome.output,
        created: started,
        completed: Date.now(),
      });
    }
    this.hub.emit({
      type: outcome.status === 'completed' ? EVENT.toolSuccess : EVENT.toolFailed,
      data: {
        sessionID: sessionId,
        assistantMessageID,
        id,
        executed: true,
        // The shell's id, which is what `Shell` reads to find its entry and its output.
        metadata: { shellID: shellId },
        // ★ Never `[]`: the spec's `NonEmptyArray`, and opencode v2.3's client throws on an empty
        // tool content (`[r(n[0]), …]` reads `n[0].type`), which also swallows the events after
        // it. A `!command` that printed nothing still gets one empty text entry.
        content: [{ type: 'text', text: outcome.output ?? '' }],
        resultState: undefined,
      },
      location: this.location,
    });
  }

  /** The `session.shell.ended` payload, emitted from one place for both routes. */
  private emitShellEnded(record: ShellRun, sessionId: string | undefined): void {
    // Tell the client this shell is no longer running, without deleting the record.
    //
    // The client's shell row computes `backgroundRunning = Boolean(id && data.shell.get(id))`
    // against its live table, and that table drops ids on the ephemeral `shell.exited` event
    // (packages/schema/src/shell.ts declares Created/Exited/Deleted, with Exited carrying
    // `{id, exit?, status}`). We never emitted it, so a finished `!command` kept a spinner on
    // its card forever — including after the session was reopened. Keeping the record in
    // `/api/shell` matters too: the official viewer's final read after exit comes from
    // `/api/shell/:id/output`, which must still answer.
    this.hub.emit({
      type: EVENT.shellExited,
      id: this.eventIdForShell(record.id),
      data: {
        id: record.id,
        ...(typeof record.exit === 'number' ? { exit: record.exit } : {}),
        status: record.status === 'exited' ? 'exited' : 'killed',
      },
      metadata: {},
      location: this.location,
    });
    if (!sessionId) return;
    this.emitShellTool(sessionId, record.id, record.command, record.cwd, {
      status: record.status === 'exited' ? 'completed' : 'failed',
      output: record.output,
    });
    this.hub.emit({
      type: EVENT.shellEnded,
      id: this.eventIdForShell(record.id),
      data: {
        sessionID: sessionId,
        shell: this.shellInfo(record),
        // Shell.Ended is an opencode v2 event, not the older local-string shape.
        // The shipped v2.0.28 client schema requires a cursor-paged Shell.Output object;
        // `stream-v2.transport.ts` passes it to shellTerminal(), which reads
        // `.output/.cursor/.size/.truncated`. A plain string made all of those undefined
        // and left the single-entry TUI with an empty card even though the command ran.
        output: {
          output: record.output,
          cursor: Buffer.byteLength(record.output, 'utf8'),
          size: Buffer.byteLength(record.output, 'utf8'),
          truncated: false,
        },
      },
      metadata: {},
      location: this.location,
    });
  }

  /**
   * Resolve when the shell settles, or when `ms` is up — whichever first. The session
   * shell route answers only after this, because its response is the client's
   * "the command finished" signal.
   */
  private waitForShell(record: ShellRun, ms: number): Promise<void> {
    if (record.status !== 'running') return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        record.child.removeListener('close', done);
        resolve();
      }
      record.child.once('close', done);
    });
  }

  private finishShell(record: ShellRun, status: ShellRecord['status']): void {
    if (record.status !== 'running') return;
    record.status = status;
    record.time.completed = Date.now();
    if (record.deferEnded) return;
    // One place owns this payload; the session route emits the same thing after it has
    // answered, which is why that route sets `deferEnded`.
    this.emitShellEnded(record, this.state.all()[0]?.session.id);
  }

  /** `ShellInfo`: `child` and the raw transcript stay server-side. */
  private shellInfo(record: ShellRun): ShellRecord {
    return {
      id: record.id,
      command: record.command,
      cwd: record.cwd,
      shell: record.shell,
      file: record.file,
      pid: record.pid,
      exit: record.exit,
      status: record.status,
      // The TUI scopes shells to a session through `metadata.sessionID` — its
      // `data.shell.listBySession()` is what draws the card in a session's transcript —
      // and it opens the output dialog with `entry.location`. Read off the client's own
      // fixture (packages/tui/test/cli/tui/data.test.tsx at v2.0.28), not guessed.
      metadata: record.sessionID ? { sessionID: record.sessionID } : {},
      location: {
        directory: record.directory ?? this.options.directory,
        project: {
          id: projectIdFor(record.directory ?? this.options.directory),
          directory: record.directory ?? this.options.directory,
        },
      },
      // NO `output` here, deliberately. The TUI renders a `!command` as a tool row whose
      // component fetches the text itself from `/api/shell/:id/output` — unless the row's
      // part already carries an `output`, in which case it skips the fetch and yet renders
      // `undefined` for a shell row (packages/tui/src/routes/session/index.tsx: the
      // `Shell`/`ShellDisplay` pair). Sending it here put a value into that part and left
      // the card permanently empty. The output travels by `data.output` on the
      // `session.shell.ended` event and by the cursor-paged `/output` route.
      time: { ...record.time },
    };
  }

  // ---------------------------------------------------------------- agents

  private readonly translators = new Map<string, AcpTranslator>();
  private readonly pendingAgents = new Map<string, Promise<{ agent: AcpClient; sessionId: string }>>();
  /** Sessions currently booting or reloading where startup `config_option_update` must not emit `session.agent.selected`. */
  private readonly mutingModeUpdates = new Set<string>();
  /** True once any agent has advertised `session/new` config options. */
  private get agentConfigReady(): boolean {
    for (const agent of this.agents.values()) {
      if (agent.hasCatalog()) return true;
    }
    return false;
  }
  /** Live `!` shell commands, keyed by the id handed back to the client. */
  private readonly shells = new Map<string, ShellRun>();
  /** The ids a client remembers, and the agent's id behind each (the one file we write). */
  private readonly sessionMap: SessionMap;
  /**
   * Session ids the user deleted. The client keeps its own list across runs and asks for
   * ids this process never created, which we adopt so a remembered tab works — but a tab
   * the user deleted must stay gone, or deleting looks like it failed.
   */
  private readonly deletedSessions = new Set<string>();
  /** Prompts accepted while a turn is running, in arrival order. */
  private readonly pendingInbox = new Map<string, InboxEntry>();
  /**
   * Sessions with an `agent.prompt` in flight (including the gap while
   * `ensureAgent` runs). ACP allows one active prompt per session; a second
   * request queues behind this one.
   */
  private readonly promptsInFlight = new Set<string>();

  /**
   * The backend's title for this session, from the standard `session/list`.
   *
   * That is where ACP carries titles - `session/list` entries are
   * `{sessionId, cwd, title, updatedAt}` - and it replaces reading a backend's
   * own store, which is what used to supply this. Best effort: an agent without
   * `session/list`, or without a title on the entry, leaves the directory
   * basename in place.
   */
  private async applyBackendTitle(record: SessionRecord, agent: AcpClient): Promise<void> {
    try {
      // The session's own directory: after a /cd (or when the map stores the
      // physical path) the launch directory is the wrong bucket, and the lookup
      // silently misses — the same mistake the replayed-config event above fixes.
      const sessions = await agent.listSessions(record.directory ?? this.options.directory);
      const hit = sessions.find((session) => session.sessionId === record.acpSessionId);
      const title = hit?.title;
      if (!title) return;
      // The agent's own name is authoritative for the derive fallback: even when it
      // equals the current title (a restored/derived name), the first prompt must
      // not replace it with its own text.
      record.titleFromAgent = true;
      if (title === record.session.title) return;
      record.session.title = title;
      this.persistTitle(record);
      this.log(`[bridge] title from the backend: ${title}`);
      this.hub.emit({
        type: EVENT.sessionRenamed,
        data: { sessionID: record.session.id, title },
        location: this.location,
      });
    } catch {
      /* no session/list, or no title: the directory basename stays */
    }
  }

  /** The backend's own name, once it has introduced itself. */
  private backendName(): string {
    for (const agent of this.agents.values()) {
      const name = agent.capabilities.agentName;
      if (name && name !== 'unknown') return name;
    }
    return this.launchName();
  }

  /**
   * What to call the agent when it never introduced itself.
   *
   * ACP makes `agentInfo` a SHOULD, so plenty of agents say nothing. The launch command
   * is then the one piece of identity that is always true and reproducible — it is what
   * the user typed — and it beats the `acp` placeholder, which tells them nothing. It is
   * shown as a single line: secrets in named flags are masked, long commands truncated.
   */
  private launchName(): string {
    const command = [this.options.command, ...(this.options.args ?? [])].filter(Boolean).join(' ');
    return displayAgentCommand(command) || PLACEHOLDER_BACKEND;
  }

  /**
   * The agent changed its own session configuration: a model fallback under rate
   * limits, a mode switch after planning, options adjusted from what it learned
   * mid-turn.
   *
   * ACP sends the **complete** config state with the update, so ours is replaced
   * rather than merged. The UI then has to be moved with the event its store
   * actually reads for this — `session.model.selected`, which writes
   * `session.info[id].model` (the composer and the context meter read that).
   */
  private emitModelUpdated(record: SessionRecord): void {
    const directory = record.directory ?? this.location.directory;
    this.hub.emit({
      type: EVENT.modelUpdated,
      data: {},
      // The session's own directory, not the bridge's launch one: the client
      // keys the catalog by this event's location, and `local.model.available()`
      // looks the selection up under the SESSION's directory. The two differ
      // after a /cd or when the map stores the physical path (on macOS
      // /private/var vs /var) — with the launch location here, the refreshed
      // catalog landed under a key nothing reads and the composer stayed locked.
      location: {
        directory,
        project: {
          id: projectIdFor(directory),
          directory,
          canonical: directory,
        },
      },
    });
  }

  private emitAgentUpdated(record: SessionRecord): void {
    const directory = record.directory ?? this.location.directory;
    this.hub.emit({
      type: EVENT.agentUpdated,
      data: {},
      location: {
        directory,
        project: {
          id: projectIdFor(directory),
          directory,
          canonical: directory,
        },
      },
    });
  }

  private applyAgentModeUpdate(record: SessionRecord, nextMode: string | undefined): void {
    if (!nextMode || nextMode === record.session.agent || this.mutingModeUpdates.has(record.session.id)) {
      return;
    }
    const previousMode = record.session.agent;
    record.session.agent = nextMode;
    this.log(`[bridge] agent switched the mode -> ${nextMode}`);
    this.hub.emit({
      type: EVENT.agentSelected,
      data: {
        sessionID: record.session.id,
        agent: nextMode,
        ...(previousMode ? { previous: previousMode } : {}),
      },
      location: this.location,
    });
  }

  private applyConfigOptionUpdate(record: SessionRecord, agent: AcpClient, update: SessionUpdate): void {
    const options = Array.isArray(update['configOptions'])
      ? (update['configOptions'] as SessionConfigOption[])
      : undefined;
    if (!options) {
      this.log('[bridge] config_option_update without a configOptions array; ignoring');
      return;
    }
    const prevModeOpt = agent.configOptionsFor(record.acpSessionId).find(isModeOption);
    const prevModeChoiceIds = prevModeOpt
      ? modeChoicesOf(prevModeOpt).map((c) => c.value).join('\u0000')
      : '';
    agent.applyConfigOptions(record.acpSessionId ?? record.session.id, options);
    if (
      options.some(
        (option) =>
          option.category === 'model' || (option.id ?? option.configId) === 'model' || isEffortOption(option),
      )
    ) {
      this.emitModelUpdated(record);
    }

    const nextModeOpt = options.find(isModeOption);
    if (nextModeOpt) {
      const nextChoiceIds = modeChoicesOf(nextModeOpt).map((c) => c.value).join('\u0000');
      if (nextChoiceIds && nextChoiceIds !== prevModeChoiceIds) {
        this.emitAgentUpdated(record);
      }
      this.applyAgentModeUpdate(record, modeFromConfigOptions(options));
    }

    const model = modelFromConfigOptions(options);
    // What the session was using a moment ago. A session created before the agent reported its
    // models has `record.model` unset (the `acp/default` placeholder is deliberately not stored
    // — storing it is what made the assistant footer print `acp/unknown`). The model it *was*
    // effectively on is then the placeholder, and the client needs that in `previous` to render
    // "switched from X"; falling back to it keeps that honest without re-poisoning `record.model`.
    const previous = record.model ?? { providerID: PLACEHOLDER_BACKEND, modelID: 'default' };
    if (!model || (model.providerID === previous?.providerID && model.modelID === previous?.modelID)) {
      this.log(`[bridge] agent updated ${options.length} config option(s); model unchanged`);
      return;
    }

    // The client renders "switched to <name>" from this event, and the reference we
    // track is only `{providerID, modelID}` — so the line said "已切换到 undefined".
    // Merge in the catalog entry, which is where the human name lives.
    const known = this.modelCatalog().models.find(
      (entry) => entry.providerID === model.providerID && (entry.modelID === model.modelID || entry.id === model.modelID),
    );
    const named = known ? { ...known, ...model } : model;
    record.model = named;
    this.log(`[bridge] agent switched the model -> ${named.providerID}/${named.modelID}`);
    this.hub.emit({
      type: EVENT.modelSelected,
      data: { sessionID: record.session.id, model: named, ...(previous ? { previous } : {}) },
      location: this.location,
    });
  }

  /**
   * The record's translator, created on demand and NOT wired to an agent.
   *
   * Split out of `attachTranslator` for exactly one case: a turn that cannot start
   * at all (the agent process fails to spawn, initialize, or answer `session/new`).
   * The user's message is already on screen by then, and without a translator there
   * was nothing that could put the failure next to it — the request rejected, the
   * transcript stayed empty, and the screen kept a user row followed by nothing
   * forever (AGENTS.md §5.1's second silent-failure path). With this the prompt path
   * can open a turn and close it with the error, the same shape a rejected
   * `session/prompt` produces.
   */
  private translatorFor(record: SessionRecord, agentName: string | undefined): AcpTranslator {
    const existing = this.translators.get(record.session.id);
    if (existing) {
      // A translator created for a failed start carries the placeholder name; the
      // real one arrives with the agent that eventually starts (a retry).
      existing.setAgentName(agentName);
      return existing;
    }
    const translator = new AcpTranslator(
      this.state,
      this.hub,
      this.location,
      this.log,
      agentName || PLACEHOLDER_BACKEND,
      // The agent's `session_info_update` title must reach the map too: whichever source
      // wins in memory, the map keeps the latest name for a restore.
      (record) => this.persistTitle(record),
    );
    this.translators.set(record.session.id, translator);
    return translator;
  }

  private attachTranslator(record: SessionRecord, agent: AcpClient): AcpTranslator {
    const translator = this.translatorFor(
      record,
      agent.capabilities.agentName === 'unknown' ? this.launchName() : agent.capabilities.agentName,
    );
    // Idempotent per AGENT: `ensureAgent` attaches before a replay, the prompt path
    // attaches again, and a second listener would double every message. Keyed by the
    // agent (not by "a translator already exists") so a translator created for a
    // failed start still gets its listener when an agent really exists.
    if (this.wiredTranslators.get(record.session.id) === agent) return translator;
    this.wiredTranslators.set(record.session.id, agent);
    // A delegated run's own event stream (`opencode/session/child_update`). Keyed by the
    // ROOT session, so the card that reports the child lives in the same transcript.
    // Guarded once: a second listener would re-apply every child frame.
    if (this.wiredTranslators.get(`${record.session.id}:child`) !== agent) {
      this.wiredTranslators.set(`${record.session.id}:child`, agent);
      agent.on('child', (rootSessionId, event) => {
        if (record.acpSessionId && rootSessionId !== record.acpSessionId) return;
        this.translators.get(record.session.id)?.applyChildUpdate(record, event);
      });
    }
    agent.on('update', (sessionId, update) => {
      // Filter by the agent's own session id only once the pair is known. Each record
      // owns exactly one agent process, so before the pairing lands (during
      // session/new, whose notifications arrive before the response resolves) every
      // update already belongs to this record — and requiring a match here dropped
      // the agent's start-up announcements (available_commands_update among them):
      // the notification names the fresh agent id while record.acpSessionId is still
      // unset, so the guard returned and the commands never landed.
      if (record.acpSessionId && sessionId !== record.acpSessionId) return;
      // The agent changed its own configuration. That is session state, not
      // transcript, so it must not reach the translator (which would log it as
      // an unknown update and drop it).
      if (update.sessionUpdate === UPDATE.configOptionUpdate) {
        this.applyConfigOptionUpdate(record, agent, update);
        return;
      }
      if (update.sessionUpdate === UPDATE.currentModeUpdate) {
        const nextMode = typeof update['currentModeId'] === 'string' ? update['currentModeId'] : undefined;
        if (nextMode) {
          agent.applyCurrentMode(record.acpSessionId ?? sessionId, nextMode);
          this.applyAgentModeUpdate(record, nextMode);
        }
        return;
      }
      // The agent's slash commands (dsh advertises ~45, most of them skill runners).
      // Store them per session and tell the client to re-read `GET /api/command`: its
      // store has a dedicated `command.updated` case that invalidates and re-syncs
      // exactly that route, which is how these reach the palette — previously they were
      // logged and dropped, so the agent's own commands (its skill runners) could never be triggered from
      // this TUI while the same agent's own web UI runs them fine.
      if (update.sessionUpdate === UPDATE.availableCommandsUpdate) {
        const raw = update['availableCommands'] as
          | Array<{ name?: unknown; description?: unknown; input?: { hint?: unknown } }>
          | undefined;
        const commands = (raw ?? [])
          .filter((cmd): cmd is { name: string; description?: string; input?: { hint?: string } } =>
            typeof cmd?.name === 'string' && cmd.name.length > 0)
          .map((cmd) => ({
            name: cmd.name,
            ...(typeof cmd.description === 'string' ? { description: cmd.description } : {}),
            ...(typeof cmd.input?.hint === 'string' ? { input: { hint: cmd.input.hint } } : {}),
          }));
        record.commands = commands;
        this.log(`[bridge] agent offers ${commands.length} slash command(s)`);
        this.hub.emit({
          type: EVENT.commandUpdated,
          data: {},
          location: this.location,
        });
        return;
      }
      translator.apply(record, update);
    });
    agent.on('log', (line) => this.log(`[acp] ${line}`));
    agent.on('exit', ({ code }) => this.log(`[acp] agent exited code=${code}`));
    return translator;
  }

  /**
   * A single primary agent mirroring the ACP session. ACP exposes no agent
   * list, and the client's composer silently refuses to submit while
   * `local.agent.current()` is empty.
   */
  private primaryAgent(): Record<string, unknown> {
    return {
      id: this.backendName(),
      // Display name, kept short: a full plugin name crowds the composer line, and
      // the model is what belongs there anyway.
      name: this.backendName().replace(/^deepseek-harness-/, ''),
      mode: 'primary',
      hidden: false,
      // `Provider.Request` requires all three; `permissions` is a ruleset (an
      // array), and ACP has no equivalent to publish here.
      request: { settings: {}, headers: {}, body: {} },
      permissions: [],
    };
  }

  private liveAgentSessions(only?: SessionRecord): Array<{ record: SessionRecord; agent: AcpClient }> {
    // One connection can host several sessions, and each session has its own catalog.
    // Iterate SESSIONS (with their agent), not connections, or the union would only see
    // whichever session touched its connection last.
    if (!only) {
      return this.state
        .all()
        .map((record) => ({ record, agent: this.agents.get(record.session.id) }))
        .filter((entry): entry is { record: SessionRecord; agent: AcpClient } => entry.agent !== undefined);
    }
    const sameAgent = (candidate: SessionRecord): boolean =>
      agentBindingLabel(candidate.agent ?? this.agentBinding()) ===
      agentBindingLabel(only.agent ?? this.agentBinding());
    const ordered: Array<{ record: SessionRecord; agent: AcpClient }> = [];
    const onlyAgent = this.agents.get(only.session.id);
    if (onlyAgent) ordered.push({ record: only, agent: onlyAgent });
    for (const candidate of this.state.all()) {
      if (candidate.session.id === only.session.id || !sameAgent(candidate)) continue;
      const candidateAgent = this.agents.get(candidate.session.id);
      if (candidateAgent) ordered.push({ record: candidate, agent: candidateAgent });
    }
    return ordered;
  }

  /**
   * Ensure at least one ACP session has started (or join an in-flight startup) so
   * catalog routes (`/api/agent`, `/api/model`) return real ACP modes/models even on
   * a cold `--no-tui` bridge before any prompt or `GET /api/session` has arrived.
   */
  private async ensureCatalogSession(
    focused: SessionRecord | undefined,
    askedDirectory: string | null | undefined,
    reason: string,
  ): Promise<void> {
    const needsStart = (candidate: SessionRecord): boolean =>
      !this.agents.has(candidate.session.id) || this.pendingAgents.has(candidate.session.id);
    const requestedDirectory =
      askedDirectory && existsSync(askedDirectory) ? askedDirectory : undefined;
    const pending =
      focused && needsStart(focused)
        ? focused
        : this.state.all().find(needsStart) ??
          (this.state.all().length === 0 ? this.ensureSession(requestedDirectory) : undefined);
    if (!pending) return;
    try {
      await this.ensureAgent(pending);
    } catch (err) {
      this.log(`[bridge] could not resolve ${reason}: ${String(err)}`);
    }
  }

  private modeOptionFor(only?: SessionRecord): SessionConfigOption | undefined {
    for (const { record, agent } of this.liveAgentSessions(only)) {
      for (const option of agent.configOptionsFor(record.acpSessionId)) {
        if (isModeOption(option) && modeChoicesOf(option).length > 0) return option;
      }
    }
    return undefined;
  }

  private async applyRequestedMode(
    record: SessionRecord,
    wanted: string | undefined,
    options: { emitSelected: boolean; failOnUnsupported: boolean },
  ): Promise<{ status: 204 } | { status: 400; message: string }> {
    if (!wanted) {
      return options.failOnUnsupported
        ? { status: 400, message: 'agent is required' }
        : { status: 204 };
    }
    const prevBeforeEnsure = record.session.agent;
    record.pendingMode = wanted;
    try {
      const { agent, sessionId: acpSessionId } = await this.ensureAgent(record);
      const sessionOptions = agent.configOptionsFor(acpSessionId);
      const switchOptions = sessionOptions.length > 0 ? sessionOptions : agent.anyConfigOptions();
      const option = switchOptions.find(isModeOption);
      if (!option) return { status: 204 };
      const choices = modeChoicesOf(option);
      if (choices.length === 0) return { status: 204 };
      if (!choices.some((choice) => choice.value === wanted)) {
        if (
          wanted === this.backendName() ||
          wanted === PLACEHOLDER_BACKEND ||
          !options.failOnUnsupported
        ) {
          this.log(`[bridge] /agent: ignoring non-mode selection '${wanted}'`);
          return { status: 204 };
        }
        this.log(`[bridge] /agent: '${wanted}' is not offered by this session's agent; refusing`);
        return { status: 400, message: `this session's agent does not offer mode '${wanted}'` };
      }
      const current = modeFromConfigOptions(switchOptions);
      const previous = prevBeforeEnsure ?? current;
      if (current !== wanted) {
        await agent.setConfig(acpSessionId, String(option.id ?? option.configId ?? 'mode'), wanted);
        this.log(`[bridge] mode -> ${wanted}`);
      } else {
        this.log(`[bridge] /agent: ${wanted} is already selected; not calling the agent`);
      }
      record.session.agent = wanted;
      if (record.acpSessionId || this.sessionMap.acpIdFor(record.session.id)) {
        this.sessionMap.rememberMode(record.session.id, wanted);
        this.sessionMap.flush();
      }
      if (options.emitSelected && previous !== wanted) {
        this.hub.emit({
          type: EVENT.agentSelected,
          data: {
            sessionID: record.session.id,
            agent: wanted,
            ...(previous ? { previous } : {}),
          },
          location: this.location,
        });
      }
      return { status: 204 };
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.log(`[bridge] /agent failed: ${text}`);
      return options.failOnUnsupported
        ? { status: 400, message: `the agent refused the mode switch: ${text}` }
        : { status: 204 };
    } finally {
      record.pendingMode = undefined;
    }
  }

  private defaultModeFor(record?: SessionRecord): string | undefined {
    const option = this.modeOptionFor(record);
    if (!option) return undefined;
    const choices = modeChoicesOf(option);
    if (choices.length === 0) return undefined;
    if (
      typeof option.currentValue === 'string' &&
      choices.some((choice) => choice.value === option.currentValue)
    ) {
      return option.currentValue;
    }
    return choices[0]?.value;
  }

  private async reconcileSessionMode(
    record: SessionRecord,
    agent: AcpClient,
    acpSessionId: string,
    overrideMode?: string,
  ): Promise<void> {
    const option = agent.configOptionsFor(acpSessionId).find(isModeOption);
    if (!option) return;
    const choices = modeChoicesOf(option);
    if (choices.length === 0) return;
    const desired =
      record.pendingMode ??
      overrideMode ??
      this.sessionMap.modeFor(record.session.id);
    record.pendingMode = undefined;
    if (
      desired &&
      choices.some((choice) => choice.value === desired) &&
      option.currentValue !== desired
    ) {
      try {
        await agent.setConfig(acpSessionId, String(option.id ?? option.configId ?? 'mode'), desired);
        this.log(`[bridge] restored sticky mode -> ${desired}`);
      } catch (err) {
        this.log(
          `[bridge] could not restore sticky mode '${desired}': ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const finalMode = modeFromConfigOptions(agent.configOptionsFor(acpSessionId)) ?? option.currentValue;
    if (finalMode) record.session.agent = finalMode;
    this.emitAgentUpdated(record);
  }

  private agentCatalog(only?: SessionRecord): Array<Record<string, unknown>> {
    const option = this.modeOptionFor(only);
    if (!option) return [this.primaryAgent()];
    const choices = modeChoicesOf(option);
    if (choices.length === 0) return [this.primaryAgent()];
    // Preserve the agent's canonical mode order and omit explicit colors so the TUI
    // derives consistent colors from the user's active opencode theme.
    return choices.map((choice) => ({
      id: choice.value,
      name: choice.name || choice.value,
      ...(typeof choice.description === 'string' && choice.description.trim()
        ? { description: choice.description }
        : {}),
      mode: 'primary',
      hidden: false,
      request: { settings: {}, headers: {}, body: {} },
      permissions: [],
    }));
  }

  /**
   * Project ACP's `session/new` config options into opencode's model/provider
   * catalogue. the backend advertises models through one option (category `model`)
   * whose choices are grouped by provider, each value a JSON array string like
   * `["acme","some-model"]`.
   */
  /**
   * The catalog to serve. With `only`, just that session's agent — the tab in front. Without
   * it, every live agent (the old union), which is what startup and a fresh client get.
   */
  private modelCatalog(only?: SessionRecord): {
    models: Array<Record<string, unknown>>;
    providers: Array<Record<string, unknown>>;
  } {
    const live = this.liveAgentSessions(only);
    const models: Array<Record<string, unknown>> = [];
    const providers = new Map<string, Record<string, unknown>>();

    // the backend publishes reasoning effort as a `thought_level` config option. The
    // client models exactly this as model `variants`, and dereferences
    // `info.variants.some(...)` without optional chaining, so it must be an
    // array even when empty.
    const variants: Array<Record<string, unknown>> = [];
    for (const { record, agent } of live) {
      for (const option of agent.configOptionsFor(record.acpSessionId)) {
        const optionId = option.id ?? option.configId;
        // ★ The option's NAME is the agent's to choose; its CATEGORY is the spec's.
        //
        // Matching only `thought_level` / `reasoning_effort` made an agent that calls the same
        // idea `effort` invisible: one third-party dsh ACP profile offers `effort = off | high |
        // max`, none of it reached the picker, and there was no way to switch thinking on from
        // the TUI at all. The agent stayed on `off`, so its `agent_thought_chunk` updates —
        // which dsh-acp does emit for a `reasoning` block — never had anything to carry, and
        // the session showed no thoughts. `category` is the spec's stable vocabulary, so that
        // is what this matches on; the id checks stay for agents that only set a name.
        if (!isEffortOption(option)) continue;
        for (const entry of option.options ?? []) {
          const isGroup = Array.isArray((entry as SessionConfigSelectGroup).options);
          const choices = isGroup ? ((entry as SessionConfigSelectGroup).options ?? []) : [entry];
          for (const choice of choices as SessionConfigSelectOption[]) {
            // The empty opaque value is the backend's provider-default marker.
            if (!choice.value) continue;
            // v2.1's Model.Variant is `{ id }` + overlays; `name` is gone (the TUI
            // labels variants by id). Sending it made the client's model decode fail.
            variants.push({ id: choice.value });
          }
        }
      }
      if (variants.length > 0) break;
    }

    const add = (providerID: string, modelID: string, name: string, contextWindow?: number): void => {
      // `ModelInfo.id` is the *bare* model id, not `provider/model`: the client
      // builds its selection with `modelID: model.id`, and the sidebar's context
      // meter matches `ModelRef.id` against `ModelInfo.id` to find the context
      // limit. A qualified id silently costs the percentage.
      const id = modelID;
      // The full `ModelInfo` the TUI reads. Every field below is required by the
      // client's type, and two of them are dereferenced without a guard:
      // `model.cost.length` in the model dialog's `free()` (crash: "undefined is
      // not an object (evaluating 'G().length')") and `model.time.released` when
      // building the option list.
      models.push({
        id,
        modelID,
        providerID,
        name,
        // v2.2.0 added `Model.Type` (`chat` | `decision` | `image`) and made `GET /api/model`
        // list `chat` by default, the only type sessions offer. An ACP agent's models are
        // conversation models, so say so instead of leaving the client to infer it.
        type: 'chat',
        capabilities: { tools: true, input: ['text'], output: ['text'] },
        variants,
        time: { released: 0 },
        // the backend exposes no pricing, so this is honestly empty rather than guessed:
        // the dialog treats "no cost entries" as "not free".
        cost: [],
        status: 'active',
        enabled: true,
        limit: { context: contextWindow ?? CONTEXT_WINDOW_FALLBACK, output: 0 },
      });
      const provider = (providers.get(providerID) ?? {
        id: providerID,
        name: providerID,
        // Required by `Provider.Info`. ACP says nothing about activation or
        // packaging, so these are the honest neutral values.
        activation: 'enabled',
        package: 'acp',
        models: [] as Array<Record<string, unknown>>,
      }) as Record<string, unknown>;
      (provider.models as Array<Record<string, unknown>>).push({ id, modelID, name });
      providers.set(providerID, provider);
    };

    for (const { record, agent } of live) {
      for (const option of agent.configOptionsFor(record.acpSessionId)) {
        const optionId = option.id ?? option.configId;
        if (option.category !== 'model' && optionId !== 'model') continue;
        for (const entry of option.options ?? []) {
          const isGroup = Array.isArray((entry as SessionConfigSelectGroup).options);
          const groupId = isGroup
            ? ((entry as SessionConfigSelectGroup).group ?? (entry as SessionConfigSelectGroup).groupId)
            : undefined;
          const choices = isGroup
            ? ((entry as SessionConfigSelectGroup).options ?? []).map((o) => ({
                value: o.value,
                name: o.name,
                groupId,
              }))
            : [{ value: (entry as SessionConfigSelectOption).value, name: entry.name, groupId }];
          for (const choice of choices) {
            const parsed = parseModelValue(choice.value);
            const contextWindow = this.translators.get(record.session.id)?.contextWindowFor(record.session.id);
            add(choice.groupId ?? parsed.providerID ?? PLACEHOLDER_BACKEND, parsed.modelID, choice.name, contextWindow);
          }
        }
      }
      if (models.length > 0) break;
    }
    if (models.length === 0) {
      // No session has reached ACP yet. Fall back so the composer is not
      // silently dead while the first `session/new` settles.
      add(PLACEHOLDER_BACKEND, 'default', 'default');
    }
    return { models, providers: [...providers.values()] };
  }

  /**
   * Persist a visible→agent pairing the map does not know yet.
   *
   * ★ Why this exists: a restore that succeeds is a FACT about the pairing, and
   * the map is the only place it survives the process. Two cases had no entry:
   * `-c` (the launcher synthesises a `ses_acp_…` visible id from the agent's own
   * session list) and a resume by an agent-native id. The exit epilogue then
   * handed the user a `-s <id>` line naming an id the map had never heard of —
   * which now fails loudly at startup ("unknown session id") instead of silently
   * opening a blank conversation.
   *
   * `missingOnly` is for the recovery path: when the map ALREADY points at the
   * conversation the user asked for, a failed load must not move that pointer to
   * the fresh session we started instead — the next run should try the real one
   * again. It only fills in a pairing that did not exist at all.
   */
  /**
   * Record that this conversation was advanced, for `-c`'s recency ranking.
   *
   * Only a pair the map already holds can be re-stamped: without a pairing there is no
   * agent id to file, and the pairing write itself (which happens when the agent session
   * exists) marks the row used.
   */
  private noteUsed(record: SessionRecord): void {
    const agentId = this.sessionMap.acpIdFor(record.session.id) ?? record.acpSessionId;
    if (!agentId) return;
    this.sessionMap.rememberBoth(
      record.session.id,
      agentId,
      record.directory ?? this.options.directory,
      this.sessionMap.titleFor(record.session.id) ?? record.session.title,
      record.agent ?? this.agentBinding(),
      true,
    );
    this.sessionMap.flush();
  }

  private rememberPairing(
    visibleId: string,
    agentId: string,
    directory: string,
    missingOnly: boolean,
    agent: { command: string; args: string[] } = this.agentBinding(),
  ): void {
    // A self-mapping can never be read back (`visibleIdFor` requires `ses_`), and
    // the map's cap is sorted by recency, so do not spend a slot on it.
    if (visibleId === agentId) return;
    const known = this.sessionMap.acpIdFor(visibleId);
    if (known === agentId) return;
    if (missingOnly && known) return;
    // A fresh pairing means an agent session was just started for this client id — the
    // bridge is about to run the user's prompt on it, so this IS the conversation in use.
    this.sessionMap.rememberBoth(visibleId, agentId, directory, undefined, agent, true);
    this.sessionMap.flush();
    this.log(`[bridge] session map: ${visibleId} is now the agent's ${agentId}`);
  }

  /**
   * Move every per-session map from the shell's id to the id the client chose.
   *
   * Called from `POST /api/session` when it adopts the pre-created shell instead of
   * creating a second record. The shell may already own a warm agent (the `/api/model`
   * warm-up), a translator, and pending permission/form entries; the agent's own ACP
   * session is untouched, so the first prompt reuses it instead of spawning another.
   */
  private rekeySession(oldId: string, newId: string, record: SessionRecord): void {
    const move = <T>(map: Map<string, T>): void => {
      const value = map.get(oldId);
      if (value === undefined) return;
      map.delete(oldId);
      map.set(newId, value);
    };
    move(this.agents);
    move(this.pendingAgents);
    move(this.translators);
    move(this.pendingPermissions);
    move(this.pendingForms);
    // `pendingInbox` is keyed by inbox id (not session); the shell never has one.
    // ★ The session MAP must move too, or the pairing stays filed under the shell's id and
    // the conversation the user is looking at has no map entry at all — the exit epilogue
    // then prints `-s <client id>` and the next start answers "unknown session id"
    // (measured by the owner, 2026-10-18). The shell's entry is removed so one conversation
    // never answers to two visible ids.
    const pairing = this.sessionMap.acpIdFor(oldId);
    if (pairing) {
      const directory = this.sessionMap.directoryFor(oldId) ?? record.directory ?? this.options.directory;
      const title = this.sessionMap.titleFor(oldId);
      const agent = this.sessionMap.agentFor(oldId) ?? record.agent ?? this.agentBinding();
      const mode = this.sessionMap.modeFor(oldId) ?? record.session.agent;
      this.sessionMap.forget(oldId);
      this.sessionMap.remember(newId, pairing, directory, title, agent, false, mode);
      this.sessionMap.flush();
      this.log(`[bridge] session map: ${oldId} -> ${newId} keeps the agent pairing ${pairing}`);
    }
    this.log(`[bridge] adopted the pre-created session as ${newId} (it keeps its agent)`);
  }

  /** Must match the client's mount sync: a tab switch is a mount, a prefetch is a burst. */
  private static readonly FOCUS_GAP_MS = 1000;

  /**
   * Load one transcript, owning the single-flight slot.
   *
   * Extracted so the focus path can trigger the same load the read path does: the
   * tab on screen must not stay empty just because a background tab's read won
   * the startup race.
   */
  private async loadTranscript(record: SessionRecord): Promise<void> {
    const load = (async () => {
      try {
        await this.ensureAgent(record);
      } catch (err) {
        this.log(`[bridge] could not load the transcript for ${record.session.id}: ${String(err)}`);
      }
    })();
    this.readLoad = { sessionId: record.session.id, done: load };
    try {
      await load;
    } finally {
      if (this.readLoad?.sessionId === record.session.id) this.readLoad = null;
      this.loadDeferredIfFocused();
    }
  }

  /**
   * The tab on screen lost the startup race: load it now.
   *
   * Called when a lazily answered read turns out to be the focused session — from
   * the focus signal itself and from the end of whatever load was holding the
   * slot. Only the focused one is chased; the rest keep the lazy contract.
   */
  private loadDeferredIfFocused(): void {
    const focused = this.lastViewedSessionId;
    if (!focused || this.readLoad || !this.deferredLoads.has(focused)) return;
    this.deferredLoads.delete(focused);
    const record = this.state.get(focused);
    if (!record?.acpSessionId) return;
    this.log(`[bridge] lazy: ${focused} is the tab on screen, loading it now`);
    void this.loadTranscript(record);
  }

  private noteFocus(sessionId: string): void {
    const now = Date.now();
    const previous = this.focus;
    if (previous === undefined || previous.id === sessionId) {
      this.focus = { id: sessionId, at: now };
      return;
    }
    // Another session inside the same burst is the startup prefetch, not a tab switch.
    if (now - previous.at < BridgeServer.FOCUS_GAP_MS) return;
    this.focus = { id: sessionId, at: now };
  }

  private focusRecord(): SessionRecord | undefined {
    const focus = this.focus;
    if (!focus) return undefined;
    if (Date.now() - focus.at > 10 * 60_000) return undefined; // stale: a new client may be attached
    return this.state.get(focus.id);
  }

  /** The bridge session that owns an ACP session id (for routing shared-connection callbacks). */
  private bridgeIdForAgentSession(agentSessionId: string): string | undefined {
    for (const candidate of this.state.all()) {
      if (candidate.acpSessionId === agentSessionId) return candidate.session.id;
    }
    return undefined;
  }

  private ensureAgent(record: SessionRecord): Promise<{ agent: AcpClient; sessionId: string }> {
    // The same record's in-flight startup joins it instead of starting a second one. But
    // joining is not enough for correctness: a caller that arrives *after* `agents.set()`
    // ran inside the first attempt but *before* that attempt finished its `session/load`
    // used to check `agents.has()`, find the half-built agent, and serve whatever the
    // record held — for `/message` that was an empty transcript, because the replay the
    // load produces had not landed yet. Every caller must await the attempt's promise.
    const inFlight = this.pendingAgents.get(record.session.id);
    if (inFlight) return inFlight;
    const attempt = (async () => {
      let agent = this.agents.get(record.session.id);
      if (!agent) {
        // A restored tab may belong to another agent than the one this bridge launched with;
        // the record carries that binding (see the adoption path). Spawn argv directly — no
        // shell — and say which agent this session is getting.
        const binding = record.agent ?? this.agentBinding();
        const cwd = record.directory ?? this.options.directory;
        if (!existsSync(cwd)) {
          // spawn reports ENOENT for a missing cwd exactly like a missing binary, which made
          // "this session's workspace is gone" look like "the agent is not installed".
          throw new Error(`the session's directory no longer exists: ${cwd}`);
        }
        if (record.agent) {
          this.log(
            `[bridge] starting '${agentBindingLabel(binding)}' for ${record.session.id} ` +
              `(the agent that created it)`,
          );
        }
        const key = `${binding.command}\u0000${binding.args.join('\u0000')}`;
        const pooled = this.pools.get(key);
        if (pooled) {
          this.log(`[bridge] reusing the '${agentBindingLabel(binding)}' connection for ${record.session.id}`);
          agent = pooled;
        } else {
          const created = new AcpClient({
            command: binding.command,
            args: binding.args,
            cwd: (record.directory ?? this.options.directory),
            env: this.options.env,
            onLog: (line) => this.log(`[acp] ${line}`),
          });
          this.pools.set(key, created);
          // One handler for the whole connection: route by the ACP session the request
          // names, because the handler is installed once and serves every session.
          created.onPermission((req) => {
            const bridgeId = this.bridgeIdForAgentSession(req.sessionId);
            if (!bridgeId) {
              this.log(`[bridge] permission for an unknown session ${req.sessionId}; rejecting`);
              return Promise.resolve({ outcome: { outcome: 'cancelled' as const } });
            }
            return this.awaitPermission(bridgeId, req);
          });
          created.onElicitation((req) => {
            const bridgeId = this.bridgeIdForAgentSession(req.sessionId ?? '');
            if (!bridgeId) {
              this.log(`[bridge] elicitation for an unknown session ${req.sessionId}; cancelling`);
              return Promise.resolve({ action: 'cancel' as const });
            }
            return this.awaitElicitation(bridgeId, req);
          });
          await created.initialize();
          agent = created;
        }
        this.agents.set(record.session.id, agent);
        const who = agent.capabilities.agentName;
        record.backendName = who && who !== 'unknown' ? who : this.launchName();
        // Attach the translator the moment the agent exists, before any branch runs:
        // agents announce things as they come up (dsh sends ~45 slash commands around
        // session/new), and until now the listener only appeared on the first prompt —
        // every pre-prompt announcement (commands, titles, config) was dropped. The
        // load branch below mutes the translator for its replay window, so the replay
        // still lands only in `record.history` and never renders twice.
        this.attachTranslator(record, agent);
        this.mutingModeUpdates.add(record.session.id);
        try {
        // ★ The record's OWN id wins; the options-level `resumeSession` is for the
        // pre-created resume record ONLY (it has no acpSessionId of its own yet).
        // The reversed precedence — `resumeSession ?? record.acpSessionId` — made
        // EVERY adopted tab load the SAME process-level resume id: the a2.txt tab
        // loaded the -c'd conversation's id, the alias tabs of that same agent
        // session then collided with the pre-created record's live agent (one
        // writer per session) and fell into "NOT resumed" ×3 with three fresh
        // shells under their ids. A record that already knows which agent session
        // it is (adopted or imported) always loads THAT id.
        // The pre-created resume record is the one KEYED by the resume id pair
        // (`ensureSession` creates it as resumeVisibleSessionId ?? resumeSession),
        // so match on that key — works for both the launcher (which passes both
        // ids) and a direct constructor caller that passes only resumeSession.
        const resumeRecordKey = this.options.resumeVisibleSessionId ?? this.options.resumeSession;
        const wanted =
          record.acpSessionId ??
          (resumeRecordKey !== undefined && record.session.id === resumeRecordKey
            ? this.options.resumeSession
            : undefined);
        if (wanted) {
          // Set before the request, not after: the translator filters replayed
          // updates by `record.acpSessionId`, so a late assignment drops them all.
          record.acpSessionId = wanted;
          // Exposed on the session so it is visible over HTTP: the id the UI shows is
          // ours (the spec's session-id pattern is `^ses`, and the agent's id does not
          // exist until `session/new` answers), but nothing else tells you which
          // session the agent thinks this is.
          record.session.acpSessionId = wanted;
          const directory = record.directory ?? this.options.directory;
          // ★ Three outcomes, decided by what the agent ADVERTISES, and worded so
          // the log and the title tell the truth. ACP forbids calling
          // `session/load` without `loadSession` and `session/resume` without
          // `sessionCapabilities.resume`, so the capability decides which call we
          // may make; what we cannot do is said out loud instead of guessed at.
          //
          // The wording here is not cosmetic. The previous shape logged
          // "NOT resumed: … started a new session under that id" on the RESUME
          // path, where nothing was started — the resume had worked and only the
          // transcript was empty — and it prefixed the title with `[not resumed]`,
          // which the client then PERSISTED into its tab layout. The owner read
          // their own successfully-resumed conversation as a failed one.
          if (agent.capabilities.loadSession) {
            // The backend replays the transcript as `session/update`
            // notifications. Collect them into history entries rather than
            // letting the live translator have them: a replay has no turn or
            // step framing, and the translator reads its boundaries from there,
            // so it would collapse the whole thing into one malformed message.
            // History entries render through the same path as the disk reader,
            // which is the one already known to work.
            const replay: SessionUpdate[] = [];
            // The translator is attached (see ensureAgent's preamble) and would happily
            // render the replay as live rows; this bridge serves the replay from
            // `record.history` instead, so mute it for the collection window — the same
            // mechanism /cd's re-load uses.
            const loadTranslator = this.translators.get(record.session.id);
            loadTranslator?.mute();
            let collecting = true;
            let emittedModelUpdate = false;
            agent.on('update', (sessionId, update) => {
              if (!collecting || sessionId !== record.acpSessionId) return;
              // A replay carries configuration too, and that is not transcript content. Capturing
              // it into `replay` alone meant the catalog stayed on `acp/default` for a whole
              // restored session, because a restore never goes through `session/new` — measured:
              // `real=none` on every catalog read after a restart, while before it read
              // `real=fake/model-1`. Applying it here keeps the model list honest after a reopen.
              if (update['sessionUpdate'] === 'config_option_update') {
                const options = update['configOptions'] as SessionConfigOption[] | undefined;
                agent!.applyConfigOptions(sessionId, options);
                // The client fetched the catalog before this adoption (at startup) and saw
                // only the placeholder; nothing else would tell it to look again. The
                // replayed config IS a catalog change — say so, or every model stays
                // `(unavailable)` and the composer stays locked on the restored session.
                this.emitModelUpdated(record);
                emittedModelUpdate = true;
                if (options?.some(isModeOption)) {
                  this.emitAgentUpdated(record);
                }
                // The session's own model has to move with it. `session.step.started` carries
                // `model: record.model ? {...} : undefined`, and the client inserts the assistant
                // row from that event before dereferencing `message.model.providerID` in its
                // footer — measured: a restored session whose load updated the config but left
                // `record.model` unset crashed the TUI with exactly that TypeError on the next
                // turn. This is the replay path, so the model is applied silently: the row that
                // needs it has not been emitted yet, and `session.model.selected` is for a switch
                // the user made, not for state the agent replayed.
                const replayModel = options ? modelFromConfigOptions(options) : undefined;
                if (replayModel) record.model = replayModel;
                return;
              }
              replay.push(update);
            });
            this.log(`[bridge] history: backend advertises loadSession, replaying ${wanted} over ACP`);
            this.log(`[bridge] history: asking the agent to load '${wanted}' over ACP`);
            try {
              await agent.loadSession(wanted, (record.directory ?? this.options.directory));
              this.log(`[bridge] history: load answered, ${replay.length} replayed updates`);
              // The response carries the session's own config options; agents that
              // report them only here (not as a `config_option_update` notification)
              // otherwise leave the record on the catalog default.
              const loadedOptions = agent.configOptionsFor(wanted);
              const loadedModel = modelFromConfigOptions(loadedOptions);
              if (loadedModel) record.model = loadedModel;
              if (!emittedModelUpdate && loadedOptions.length > 0) {
                this.emitModelUpdated(record);
                emittedModelUpdate = true;
              }
              this.rememberPairing(record.session.id, wanted, directory, false, record.agent ?? this.agentBinding());
              await this.reconcileSessionMode(record, agent, wanted);
            } catch (firstErr) {
              // Measured with dsh: a load that arrives moments after the agent's
              // initialize — or while another process still holds the session
              // (backends are one-writer-per-session) — answers "Internal error",
              // and a moment later the same load succeeds. One delayed retry
              // covers both; the NOT-resumed path below stays for real failures.
              this.log(
                `[bridge] history: load of '${wanted}' failed (${String(firstErr)}); retrying once in 2s`,
              );
              await new Promise((resolve) => setTimeout(resolve, 2_000));
              try {
                await agent.loadSession(wanted, (record.directory ?? this.options.directory));
                this.log(`[bridge] history: load answered on retry, ${replay.length} replayed updates`);
                const loadedOptions = agent.configOptionsFor(wanted);
                const loadedModel = modelFromConfigOptions(loadedOptions);
                if (loadedModel) record.model = loadedModel;
                if (!emittedModelUpdate && loadedOptions.length > 0) {
                  this.emitModelUpdated(record);
                  emittedModelUpdate = true;
                }
                this.rememberPairing(record.session.id, wanted, directory, false, record.agent ?? this.agentBinding());
                await this.reconcileSessionMode(record, agent, wanted);
              } catch (err) {
                // Measured, twice: an agent that advertises loadSession and then
                // declines made this throw with nothing to catch it, so the rejection
                // escaped ensureAgent — the session was never registered, /api/model
                // stayed on the placeholder, and not one line was logged. The user saw
                // a session that did not exist. Recovering is not enough on its own:
                // say what happened, mark the session, and get them a working one.
                const text = err instanceof Error ? err.message : String(err);
                this.log(
                  `[bridge] could not load '${wanted}': ${text}. The conversation is untouched in the agent's own store; ` +
                    `the usual cause is another process holding it (the backend allows one writer per session). ` +
                    `Starting a NEW conversation under '${record.session.id}' so this tab is usable.`,
                );
                record.session.title = markTitle(record.session.title, wanted, '[new conversation]');
                // ★ Say it on screen, not only in the log. This is the path a REAL
                // dsh takes when another process still holds the session (measured:
                // `Internal error`, then the same load succeeds after the holder
                // exits): without a notice the user sees a blank tab named
                // `[new conversation]` and has no way to know the AGENT refused.
                this.appendNotice(
                  record,
                  `Agent could not load this session: ${text}. A new conversation was started here — ` +
                    `the usual cause is another process still holding it (this agent allows one writer per session).`,
                );
                replay.length = 0; // discard whatever half arrived
                const fresh = await agent.newSession(directory);
                record.acpSessionId = fresh.sessionId;
                record.session.acpSessionId = fresh.sessionId;
                this.log(`[bridge] new agent session ${fresh.sessionId} under '${record.session.id}'`);
                this.rememberPairing(record.session.id, fresh.sessionId, directory, true, record.agent ?? this.agentBinding());
                if (agent.configOptionsFor(fresh.sessionId).length > 0) {
                  this.adoptCatalogModels();
                  this.emitModelUpdated(record);
                }
                await this.reconcileSessionMode(record, agent, fresh.sessionId);
              }
            } finally {
              collecting = false;
              loadTranslator?.unmute();
            }
            const entries = historyFromReplay(replay);
            record.history = entries.map((entry) =>
              toSessionMessage(entry, record, record.backendName ?? PLACEHOLDER_BACKEND, this.defaultModel()),
            );
            this.log(
              `[bridge] history: ${replay.length} replayed updates → ${record.history.length} messages, no disk read`,
            );
            // ★ The loaded record is now the freshest real conversation (it
            // gained messages; others did not). Bumping `updated` here makes
            // GET /api/session list it first, which is what the TUI's -c
            // navigates to — without the bump, -c's list pick could name an
            // unrelated row and open a blank tab while the real conversation
            // sat second.
            this.state.touch(record.session.id);
            // Same reason as the resume branch: `-s` pre-creates the record with the
            // directory basename, and a replayed history does not carry the name.
            const rememberedName = this.sessionMap.titleFor(record.session.id);
            if (rememberedName && !record.titleFromAgent && !record.titleFromUser) {
              this.adoptStoredTitle(record, rememberedName);
            }
            void this.applyBackendTitle(record, agent);
            return { agent, sessionId: wanted };
          }
          if (agent.capabilities.resumeSessions) {
            // ACP's `session/resume` = "reconnect to an existing session WITHOUT
            // replaying history". The agent keeps its context, so the conversation
            // genuinely continues; there is simply no transcript to draw on the
            // client's first frame. Saying "not resumed" about this was the single
            // most misleading line in the bridge.
            try {
              await agent.resumeSession(wanted, directory);
              // ★ The resume RESPONSE carries the session's own config options (the
              // same shape `session/new` returns), so this is where the session's real
              // model comes from. Without it the record kept the catalog default —
              // measured on a real agent: the restored session's first turn was sent
              // with a different model than the conversation had used, and the footer
              // named the wrong one. The model genuinely in use is the session's own.
              const resumedModel = modelFromConfigOptions(agent.configOptionsFor(wanted));
              if (resumedModel) record.model = resumedModel;
              // ★ Tell the client the CATALOG changed, not just the model.
              //
              // The client fetches `/api/model` at startup — before this resume has run — and
              // sees only the placeholder, so the composer names `default` and `/models` lists
              // nothing. `session.model.selected` does not help: it updates the current model and
              // inserts a "model-switched" row, but never refetches the list. `model.updated` is
              // the event the client turns into `result.location.model.sync(...)`.
              //
              // The `session/load` path already emitted this for the same reason; resume did not,
              // and a resumed session therefore had a right card and a wrong footer. Measured on
              // `dsh --profile acp`: the resume response carries 2 config options (49 models) while
              // `/api/model` had answered with the placeholder one moment earlier.
              this.emitModelUpdated(record);
              this.log(
                `[bridge] resumed '${wanted}' without replay (session/resume carries no history); whether the ` +
                  `model still has the earlier conversation is up to the agent — measured both ways on the same profile`,
              );
              this.rememberPairing(record.session.id, wanted, directory, false, record.agent ?? this.agentBinding());
              await this.reconcileSessionMode(record, agent, wanted);
              // ★ No title marker (owner's call, 2026-10-18): the notice in the transcript
              // already says why the history is missing, so the tab keeps the conversation's
              // real name. Base it on the map's remembered name — `-s` pre-creates the record
              // with the directory basename, and without this a restore showed `tau` instead
              // of the name the first prompt gave the conversation.
              const remembered = this.sessionMap.titleFor(record.session.id);
              if (remembered) this.adoptStoredTitle(record, remembered);
              else record.session.title = stripTitleMarkers(record.session.title);
              // ★ Name the agent. "this agent" made a reader guess which one — and the answer is
              // the command they typed after `--`, which is the only thing they can act on.
              this.appendNotice(
                record,
                `Resumed without showing history: this agent "${agentBindingLabel(
                  record.agent ?? this.agentBinding(),
                )}" has no session/load capability`,
              );
            } catch (err) {
              const text = err instanceof Error ? err.message : String(err);
              this.log(
                `[bridge] session/resume('${wanted}') failed: ${text}. The conversation is untouched in the agent's own ` +
                  `store; the usual cause is another process holding it (one writer per session). Starting a NEW ` +
                  `conversation under '${record.session.id}' so this tab is usable.`,
              );
              const rememberedForFresh =
                this.sessionMap.titleFor(record.session.id) ?? record.session.title;
              record.session.title = markTitle(rememberedForFresh, wanted, '[new conversation]');
              this.appendNotice(
                record,
                // The agent's own words are part of the notice: without them the user
                // cannot tell a refused resume (a lock, a missing session) from a bug in
                // this bridge. dsh answers an opaque "Internal error" when another
                // process still holds the session — that is the agent refusing, and it
                // should read that way.
                `Agent resume failed: so a new conversation was started here. The agent said: ${text}`,
              );
              const fresh = await agent.newSession(directory);
              record.acpSessionId = fresh.sessionId;
              record.session.acpSessionId = fresh.sessionId;
              this.log(`[bridge] new agent session ${fresh.sessionId} under '${record.session.id}'`);
              this.rememberPairing(record.session.id, fresh.sessionId, directory, true, record.agent ?? this.agentBinding());
              if (agent.configOptionsFor(fresh.sessionId).length > 0) {
                this.adoptCatalogModels();
                this.emitModelUpdated(record);
              }
              await this.reconcileSessionMode(record, agent, fresh.sessionId);
            }
            void this.applyBackendTitle(record, agent);
            return { agent, sessionId: record.acpSessionId ?? wanted };
          }
          // Neither capability: this agent cannot reconnect to an existing session
          // at all, and calling either method would be a spec violation (and, for a
          // strict agent, an error the user never sees). Say exactly that, then give
          // them a usable conversation — the old one stays untouched in the agent's
          // store for an agent that can open it.
          this.log(
            `[bridge] cannot resume '${wanted}': agent advertises neither session/load nor sessionCapabilities.resume. ` +
              `Starting a NEW conversation under '${record.session.id}'.`,
          );
          const rememberedForNew =
            this.sessionMap.titleFor(record.session.id) ?? record.session.title;
          record.session.title = markTitle(rememberedForNew, wanted, '[new conversation]');
          this.appendNotice(
            record,
            'Cannot resume: this agent has no session/resume capability, so a new conversation was started here',
          );
          const rescued = await agent.newSession(directory);
          record.acpSessionId = rescued.sessionId;
          record.session.acpSessionId = rescued.sessionId;
          this.log(`[bridge] new agent session ${rescued.sessionId} under '${record.session.id}'`);
          this.rememberPairing(record.session.id, rescued.sessionId, directory, true, record.agent ?? this.agentBinding());
          if (agent.configOptionsFor(rescued.sessionId).length > 0) {
            this.adoptCatalogModels();
            this.emitModelUpdated(record);
          }
          await this.reconcileSessionMode(record, agent, rescued.sessionId);
          return { agent, sessionId: rescued.sessionId };
        }
        const session = await agent.newSession((record.directory ?? this.options.directory));
        record.acpSessionId = session.sessionId;
        record.session.acpSessionId = session.sessionId;
        const savedSessionMode = this.sessionMap.modeFor(record.session.id) ?? record.pendingMode;
        this.sessionMap.rememberBoth(
          record.session.id,
          session.sessionId,
          record.directory ?? this.options.directory,
          // A fresh session's first prompt derives the title before this write runs, so the
          // pairing carries it (owner's call: the restore must show the real name, not the
          // directory). `deriveTitle` already wrote it when the pairing existed at prompt time;
          // this is the case where it did not.
          record.titleDerived ? record.session.title : undefined,
          record.agent ?? this.agentBinding(),
          false,
          savedSessionMode,
        );
        this.sessionMap.flush();
        this.log(`[bridge] session ${record.session.id} -> acp ${session.sessionId} in ${record.directory ?? this.options.directory}`);
        // Attach here, not only on the first prompt: the agent announces things as it
        // comes up — `available_commands_update` among them (dsh sends ~45 commands right
        // after session/new) — and without a listener they were dropped, which is why
        // GET /api/command answered an empty palette even after the agent had started.
        // The prompt path's `?? attachTranslator` stays idempotent; the load branch above
        // keeps its own replay collector and is deliberately not doubled.
        this.attachTranslator(record, agent);
        if (agent.configOptionsFor(session.sessionId).length > 0) {
          this.adoptCatalogModels();
          this.emitModelUpdated(record);
        }
        await this.reconcileSessionMode(record, agent, session.sessionId);
        } finally {
          this.mutingModeUpdates.delete(record.session.id);
        }
      }
      return { agent, sessionId: record.acpSessionId ?? record.session.id };
    })();
    this.pendingAgents.set(record.session.id, attempt);
    void attempt
      .catch(() => {
        // Drop the half-built client. It was cached before `initialize()` /
        // `resumeSession()` had succeeded, and the retry path returns any cached
        // agent as if it were established - so leaving it here turned every
        // retry into a silent no-op. That is what made a failing resume cost the
        // full `waitForCatalog` deadline (30s) with a single error line at the
        // start and nothing after it.
        this.agents.delete(record.session.id);
      })
      .finally(() => this.pendingAgents.delete(record.session.id));
    return attempt;
  }

  /**
   * Answer an `elicitation/create` from the agent by asking the user through the
   * TUI's own form surface.
   *
   * The mapping is one-way and lossless in the direction that matters: the agent
   * declares a flat JSON Schema, we publish it as a `Form.Info`, the TUI renders
   * it, and the answer it hands back becomes `content` on an `accept`. A schema
   * we cannot render completely is refused with a JSON-RPC error rather than
   * shown partially — a partial form would collect an answer that silently does
   * not match the agent's schema, and the agent cannot tell that from a good one.
   */
  private awaitElicitation(sessionId: string, request: ElicitationRequest): Promise<ElicitationResponse> {
    const formId = this.state.newId('frm');
    // Throws (-> -32602 to the agent) when the schema cannot be rendered.
    const form = formFromElicitation(sessionId, formId, request);
    return new Promise<ElicitationResponse>((resolve) => {
      this.pendingForms.set(form.id, { form, resolve });
      const declared = Object.keys(request.requestedSchema?.properties ?? {}).length;
      if (form.fields.length < declared) {
        this.log(
          `[bridge] form ${form.id}: dropped ${declared - form.fields.length} redundant free-form "other" field(s)`,
        );
      }
      this.log(`[bridge] elicitation -> form ${form.id} (${form.fields.length} field(s): ${request.message ?? ''})`);
      this.hub.emit({
        type: EVENT.formCreated,
        data: { form },
        location: this.location,
      });
    });
  }

  /**
   * Settle a pending form from the TUI. Returns false when the id is unknown —
   * a double reply, or one for a form the agent already gave up on.
   */
  private settleForm(
    formId: string,
    outcome: { status: 'answered'; answer: FormAnswer } | { status: 'cancelled' },
  ): boolean {
    const pending = this.pendingForms.get(formId);
    if (!pending) return false;
    this.pendingForms.delete(formId);
    pending.resolve(
      outcome.status === 'answered'
        ? { action: 'accept', content: outcome.answer }
        : { action: 'cancel' },
    );
    this.hub.emit({
      type: outcome.status === 'answered' ? EVENT.formReplied : EVENT.formCancelled,
      data:
        outcome.status === 'answered'
          ? { id: formId, sessionID: pending.form.sessionID, answer: outcome.answer }
          : { id: formId, sessionID: pending.form.sessionID },
      location: this.location,
    });
    this.log(`[bridge] form ${formId} ${outcome.status}`);
    return true;
  }

  /**
   * Answer every permission request this session's agent is blocked on with the
   * `cancelled` outcome.
   *
   * ACP: "The Client **MUST** respond to all pending `session/request_permission`
   * requests with the `cancelled` outcome" — once the turn is aborted, no answer
   * is coming, and the agent has no timeout of its own.
   */
  private cancelPendingPermissions(sessionId: string): number {
    let cancelled = 0;
    for (const [requestId, pending] of [...this.pendingPermissions]) {
      if (pending.sessionId !== sessionId) continue;
      this.pendingPermissions.delete(requestId);
      pending.resolve({ outcome: { outcome: 'cancelled' } });
      this.hub.emit({
        type: EVENT.permissionReplied,
        data: { sessionID: sessionId, requestID: requestId },
        location: this.location,
      });
      cancelled += 1;
    }
    return cancelled;
  }

  /** Dismiss every form this session is showing; the elicitation gets `cancel`. */
  private cancelPendingForms(sessionId: string): number {
    let cancelled = 0;
    for (const pending of [...this.pendingForms.values()]) {
      if (pending.form.sessionID !== sessionId) continue;
      if (this.settleForm(pending.form.id, { status: 'cancelled' })) cancelled += 1;
    }
    return cancelled;
  }

  private awaitPermission(sessionId: string, request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const requestId = this.state.newId('perm');
    return new Promise<RequestPermissionResponse>((resolve) => {
      this.pendingPermissions.set(requestId, { sessionId, requestId, request, resolve });
      // v2 shape (`PermissionInfo`): {id, sessionID, action, resources,...}.
      // The v1 `tool`/`options` fields are not read by the TUI at all.
      this.hub.emit({
        type: EVENT.permissionAsked,
        data: {
          id: requestId,
          sessionID: sessionId,
          action: String(request.toolCall?.title ?? request.toolCall?.kind ?? 'tool'),
          resources: [],
          message: typeof request.toolCall?.title === 'string' ? request.toolCall.title : undefined,
          metadata: {},
        },
        location: this.location,
      });
    });
  }

  /**
   * Answer a pending permission request.
   *
   * Returns false when the request is unknown — already answered, expired by the agent, or
   * settled by an interrupt. The route turns that into `404` rather than `204`: the official
   * TUI's data suite has a case for a permission that expired before its reply, and a silent
   * success there leaves the client believing it answered something. The form route already
   * answers `404` for the same situation; the two must agree.
   */
  private replyPermission(sessionId: string, requestId: string, body: unknown): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      this.log(`[bridge] permission reply for unknown request ${requestId} — answering 404`);
      return false;
    }
    this.pendingPermissions.delete(requestId);
    const raw = (body ?? {}) as { optionId?: string; response?: string; outcome?: string; reply?: string };
    // The TUI sends {reply: "once" | "always" | "reject"}; older shapes accepted too.
    const requested = raw.optionId ? undefined : (raw.reply ?? raw.response ?? raw.outcome);
    const optionId =
      raw.optionId ??
      (requested ? mapPermissionResponse(requested, pending.request) : undefined) ??
      pending.request.options?.[0]?.optionId;
    pending.resolve(
      optionId
        ? { outcome: { outcome: 'selected', optionId } }
        : { outcome: { outcome: 'cancelled' } },
    );
    this.hub.emit({
      type: EVENT.permissionReplied,
      data: { sessionID: sessionId, requestID: requestId },
      location: this.location,
    });
    return true;
  }
}

// ------------------------------------------------------------------ helpers

/** A prompt the client handed over with `delivery: "queue"` (or that arrived mid-turn). */
interface InboxEntry {
  sessionID: string;
  inboxID: string;
  text: string;
  delivery: 'steer' | 'queue';
}

/** Server-side state for one `!` shell run; `child` never leaves the bridge. */
interface ShellRun extends ShellRecord {
  child: ChildProcess;
  /** Required here, optional on the wire shape: internally we always hold the text. */
  output: string;
  /** The session this command belongs to, and the directory it ran in. */
  sessionID?: string;
  directory?: string;
  /**
   * Set when the requester answers *before* announcing the end. The client's transport
   * notes that the live `shell.ended` "usually lands within the same tick" as the
   * response and holds the turn so the output commit renders inside it — so the ended
   * event is emitted after the response, not before it.
   */
  deferEnded?: boolean;
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The id an optimistic client already chose for this session, if any.
 */
function sessionIdFrom(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const id = (body as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * Map a disk transcript entry onto the client's `SessionMessageInfo`.
 *
 * `user` carries its text at the top level; `assistant` carries a content array
 * and a model reference. The model comes from the session, so history rendered
 * before the catalogue arrives falls back to a placeholder rather than crashing
 * the client's model lookup.
 */
/**
 * The ACP stop reason → the execution outcome the client's store switches on.
 *
 * `record.interruptRequested` wins over the stop reason: we cancelled the turn, so
 * it is interrupted whether or not the agent says so. The fake agent in the e2e
 * suite is deliberately unhelpful here (it answers `end_turn` after a cancelled
 * permission), which is exactly the case this guards.
 */
function turnOutcome(
  result: { stopReason?: string } | undefined,
  record: { interruptRequested?: boolean },
): { error?: string; interrupted?: boolean } {
  if (result?.stopReason === 'error') return { error: 'agent stop reason: error' };
  if (record.interruptRequested || result?.stopReason === 'cancelled') return { interrupted: true };
  return {};
}

function toSessionMessage(
  entry: HistoryEntry,
  record: SessionRecord,
  backendName = PLACEHOLDER_BACKEND,
  // The model to name when neither the replayed entry nor the session carries one. Resolved from
  // the real catalog by the caller: the placeholder would render as `acp/unknown` on the card,
  // because the client looks the message's model up in the catalog and prints
  // `${providerID}/${id}` when it is absent. Replayed history is exactly where this happens —
  // an ACP replay usually carries no per-message model, and the session's own model is not set
  // yet at replay time.
  defaultModel?: { providerID: string; modelID: string },
): Record<string, unknown> {
  if (entry.role === 'user') {
    return { id: specMessageId(entry.id), type: 'user', text: entry.text, time: { created: entry.created } };
  }
  const chosen = entry.model ?? record.model ?? defaultModel;
  const model = chosen
    ? { id: chosen.modelID, providerID: chosen.providerID }
    : { id: 'unknown', providerID: PLACEHOLDER_BACKEND };
  const content: Array<Record<string, unknown>> = [];
  const toolPart = (tool: {
    callId: string;
    name: string;
    input: unknown;
    completed: boolean;
    failed?: boolean;
    error?: string;
    output?: string;
    created: number;
  }) => {
    const input =
      tool.input && typeof tool.input === 'object' && !Array.isArray(tool.input)
        ? (tool.input as Record<string, unknown>)
        : {};
    let state: Record<string, unknown>;
    if (tool.failed) {
      const message = tool.error ?? tool.output ?? 'tool failed';
      state = {
        status: 'error',
        input,
        error: { type: 'tool', message },
        ...(tool.output === undefined || tool.output === message
          ? {}
          : { content: [{ type: 'text', text: tool.output }] }),
        metadata: {},
      };
    } else if (tool.completed) {
      state = {
        status: 'completed',
        input,
        content: [{ type: 'text', text: tool.output ?? '' }],
        metadata: {},
      };
    } else {
      state = { status: 'running', input, metadata: {} };
    }
    return {
      // `state` is a discriminated union: a finished call carries its output as
      // content, one still running carries none.
      type: 'tool',
      id: tool.callId,
      name: tool.name,
      executed: true,
      state,
      time: {
        created: tool.created,
        ran: tool.created,
        ...(tool.completed || tool.failed ? { completed: tool.created } : {}),
      },
    };
  };
  const placed = new Set<string>();
  if (entry.parts && entry.parts.length > 0) {
    // The ordered view: text, tool, text, tool stays that way.
    for (const part of entry.parts) {
      if (part.kind === 'text') {
        content.push({ type: 'text', text: part.text });
        continue;
      }
      if (part.kind === 'reasoning') {
        content.push({
          type: 'reasoning',
          text: part.text,
          time: { created: entry.created, completed: entry.created },
        });
        continue;
      }
      content.push(toolPart(part));
      placed.add(part.callId);
    }
  } else if (entry.text) {
    content.push({ type: 'text', text: entry.text });
  }
  // Anything the ordered view did not carry - older formats only record tools as
  // their own events - still has to appear.
  for (const tool of entry.tools ?? []) {
    if (placed.has(tool.callId)) continue;
    content.push(toolPart(tool));
  }
  return {
    id: specMessageId(entry.id),
    type: 'assistant',
    agent: backendName,
    model,
    content,
    finish: 'stop',
    time: { created: entry.created, completed: entry.created },
  };
}

/**
 * The fallback title taken from the first user message.
 *
 * ★ ACP has no client-side title method, and agents without a title surface (the
 * backend's plain ACP profile sends no `session_info_update` and no titles in
 * `session/list`) leave every session on the client's "New session" forever. The
 * user's own words are the only deterministic, local source of a name — so the
 * first prompt becomes the title, and an agent-provided title replaces it later.
 *
 * One line, whitespace collapsed, at most `max` code points, `…` when cut. Empty
 * (an attachment-only prompt) yields nothing: a title made of nothing is worse
 * than the default.
 */
export function derivedTitle(text: string, max = 48): string | undefined {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  const points = Array.from(flat);
  return points.length <= max ? flat : `${points.slice(0, max).join('').trimEnd()}…`;
}

/** Markers this bridge puts in front of a session title. */
const TITLE_MARKERS = ['[no history] ', '[no transcript] ', '[new conversation] ', '[not resumed] '] as const;

/**
 * A session title that carries one of our markers, without stacking them.
 *
 * The title is the only surface we have for "what this restored tab actually
 * is" (the client persists it into its tab layout, which is the point — and also
 * why a wrong one is expensive: `[not resumed]` outlived the bug that wrote it).
 * So each marker must be idempotent: a record re-created from a map that already
 * carries a marker must not grow `[new conversation] [new conversation] …`, and
 * the legacy `[not resumed]` prefix must be dropped rather than nested.
 */
/** Remove any stacked display markers from a title (`[no history] x` → `x`). */
export function stripTitleMarkers(current: string | undefined): string {
  let base = (current ?? '').trim();
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const known of TITLE_MARKERS) {
      if (base.startsWith(known)) {
        base = base.slice(known.length).trim();
        stripped = true;
      }
    }
  }
  return base;
}

export function markTitle(current: string | undefined, fallback: string, marker: string): string {
  const base = stripTitleMarkers(current ?? fallback);
  return `${marker} ${base || fallback}`;
}

function titleFrom(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as { title?: unknown };
  return typeof b.title === 'string' ? b.title : undefined;
}

/**
 * Map an ACP form elicitation onto the form the opencode TUI renders.
 *
 * Throws `AcpError(-32602)` for anything we cannot render **completely**: a
 * partially rendered form would collect an answer that does not match the
 * agent's schema, and the agent has no way to tell that from a correct one.
 * An explicit refusal lets it fall back or fail the operation, which is what the
 * spec requires agents to handle.
 *
 * The supported subset is form mode's own restriction (`packages/schema`'s
 * `Form.Field` union): string (optionally an enum), number, integer, boolean, and
 * a string array with an enum — which is the TUI's `multiselect`.
 */
export function formFromElicitation(sessionId: string, formId: string, request: ElicitationRequest): FormInfo {
  const schema = request.requestedSchema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new AcpError('elicitation/create without a requestedSchema object', -32602);
  }
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new AcpError('elicitation/create requestedSchema has no properties object', -32602);
  }
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((key) => typeof key === 'string') : [],
  );

  const fields: FormField[] = [];
  for (const [key, raw] of Object.entries(properties)) {
    const field = formFieldFromProperty(key, raw as ElicitationProperty, required.has(key));
    if (!field) {
      const type = (raw as { type?: unknown } | null)?.type;
      throw new AcpError(
        `unsupported elicitation field "${key}" (type=${type === undefined ? 'undefined' : String(type)})`,
        -32602,
      );
    }
    fields.push(field);
  }
  const rendered = dropRedundantFreeFormCustom(fields);
  if (rendered.length === 0) {
    throw new AcpError('elicitation/create requestedSchema declares no fields', -32602);
  }

  const message = typeof request.message === 'string' ? request.message.trim() : '';
  return {
    id: formId,
    sessionID: sessionId,
    // `Form.Info.title` is required and non-empty; the agent's message is the
    // only human-readable thing we have, so it becomes the form's heading.
    title: message || 'Input requested',
    fields: rendered,
    ...(request.toolCallId ? { metadata: { toolCallId: request.toolCallId } } : {}),
  };
}

/**
 * opencode's `question` tool always marks its field `custom: true`, which makes
 * its form service synthesize a second field (`q0_custom`, title "… (other)",
 * description "Type your own answer") even when the question is free-form
 * (`options: []`). The base field is already a text input, so the synthetic one
 * is redundant; the tool only reads `q0` anyway. Agents that need a real "other"
 * option have a base field with `options`, and that one is kept.
 */
function dropRedundantFreeFormCustom(fields: FormField[]): FormField[] {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  return fields.filter((field) => {
    if (!field.key.endsWith('_custom')) return true;
    const base = byKey.get(field.key.slice(0, -'_custom'.length));
    if (!base) return true;
    if (base.type !== 'string' || (base.options?.length ?? 0) > 0) return true;
    if (field.type !== 'string' || field.description !== 'Type your own answer') return true;
    // Never drop a REQUIRED field: omitting it would make the `content` we return
    // non-conforming to the agent's schema. Only the synthetic optional field.
    if (field.required === true) return true;
    return false;
  });
}

/** One JSON Schema property, or undefined when the type is outside the subset. */
function formFieldFromProperty(
  key: string,
  property: ElicitationProperty,
  required: boolean,
): FormField | undefined {
  if (!property || typeof property !== 'object') return undefined;
  const base = {
    key,
    required,
    ...(typeof property.title === 'string' ? { title: property.title } : {}),
    ...(typeof property.description === 'string' ? { description: property.description } : {}),
  };
  // Enum labels are the values: ACP's schema carries no separate display names,
  // and inventing prettier ones would misrepresent what the agent accepts.
  const optionsOf = (values: unknown): FormFieldOption[] | undefined => {
    if (!Array.isArray(values) || values.length === 0) return undefined;
    const strings = values.filter((value): value is string => typeof value === 'string');
    return strings.length > 0 ? strings.map((value) => ({ value, label: value })) : undefined;
  };

  switch (property.type) {
    case 'string': {
      const options = optionsOf(property.enum);
      return {
        ...base,
        type: 'string',
        ...(options ? { options } : {}),
        ...(typeof property.format === 'string' ? { format: property.format } : {}),
        ...(typeof property.minLength === 'number' ? { minLength: property.minLength } : {}),
        ...(typeof property.maxLength === 'number' ? { maxLength: property.maxLength } : {}),
        ...(typeof property.pattern === 'string' ? { pattern: property.pattern } : {}),
        ...(typeof property.default === 'string' ? { default: property.default } : {}),
      };
    }
    case 'number':
    case 'integer':
      return {
        ...base,
        type: property.type,
        ...(typeof property.minimum === 'number' ? { minimum: property.minimum } : {}),
        ...(typeof property.maximum === 'number' ? { maximum: property.maximum } : {}),
        ...(typeof property.default === 'number' ? { default: property.default } : {}),
      };
    case 'boolean':
      return {
        ...base,
        type: 'boolean',
        ...(typeof property.default === 'boolean' ? { default: property.default } : {}),
      };
    case 'array': {
      const items = property.items;
      if (!items || items.type !== 'string') return undefined;
      const options = optionsOf(items.enum);
      if (!options) return undefined;
      return {
        ...base,
        type: 'multiselect',
        options,
        ...(typeof property.minItems === 'number' ? { minItems: property.minItems } : {}),
        ...(typeof property.maxItems === 'number' ? { maxItems: property.maxItems } : {}),
        ...(Array.isArray(property.default)
          ? { default: property.default.filter((value): value is string => typeof value === 'string') }
          : {}),
      };
    }
    default:
      return undefined;
  }
}

/** Resolve after `ms`. Unref'd, so a pending timer never holds the process open. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * The model a config-option list currently selects, in the shape the TUI reads
 * (`{providerID, modelID}`, matched against `ModelInfo.providerID`/`.id`).
 *
 * Returns undefined unless both halves are present: a session model the client
 * cannot match makes it show "model (unavailable)".
 */
/** Parse an ISO 8601 timestamp from ACP (`SessionInfo.updatedAt`) into epoch ms. */
function parseAcpTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * Derive session `{ created, updated }` timestamps from ACP `updatedAt` and/or `SessionMap`.
 * Returns `undefined` when neither source holds a valid timestamp so new sessions default to `now`.
 */
function resolveSessionTime(
  acpUpdatedAt: unknown,
  remembered?: { createdAt?: number; updatedAt: number },
): { created?: number; updated?: number } | undefined {
  const fromAcp = parseAcpTimestamp(acpUpdatedAt);
  const fromMapUpdated = remembered && remembered.updatedAt > 0 ? remembered.updatedAt : undefined;
  const fromMapCreated =
    remembered?.createdAt !== undefined && remembered.createdAt > 0 ? remembered.createdAt : undefined;
  const updated = fromAcp ?? fromMapUpdated ?? fromMapCreated;
  if (updated === undefined) return undefined;
  const created = fromMapCreated !== undefined && fromMapCreated <= updated ? fromMapCreated : updated;
  return { created, updated };
}

/**
 * Apply `GET /api/session`'s query to the sessions we hold.
 *
 * Mirrors `SessionStore.list` (opencode v2.2.6, `packages/core/src/session/store.ts`):
 *   - `search` matches the TITLE (a `LIKE %…%`) — not the id, so a client searching an id
 *     correctly finds nothing;
 *   - `parentID=null` keeps root sessions only, a value keeps that parent's children;
 *   - `archived=false` drops archived ones, `true` keeps only those;
 *   - `order` sorts by `time.updated` (the field the client itself sorts on), `desc` by
 *     default;
 *   - `limit` caps the result AFTER ordering, and `cursor` is not implemented — the route
 *     never paged before, and a cursor the client cannot advance would be worse than none.
 *
 * `project`, `subpath` and `directory` are about a multi-project store this bridge does not
 * have (one directory per run), so they are accepted and ignored — the same shape as the
 * `location[directory]` handling above.
 */
export function sessionListQuery<T extends { id: string; title?: string; parentID?: string; time: { updated: number; archived?: number } }>(
  sessions: readonly T[],
  query: URLSearchParams,
): T[] {
  const search = query.get('search');
  const parentID = query.get('parentID');
  const archived = query.get('archived');
  const order = query.get('order') === 'asc' ? 'asc' : 'desc';
  const limit = Number(query.get('limit'));

  let rows = [...sessions];
  if (search) {
    const needle = search.toLowerCase();
    rows = rows.filter((session) => (session.title ?? '').toLowerCase().includes(needle));
  }
  if (parentID !== null) {
    rows =
      parentID === 'null' || parentID === ''
        ? rows.filter((session) => session.parentID === undefined)
        : rows.filter((session) => session.parentID === parentID);
  }
  if (archived !== null) {
    const wantArchived = archived === 'true';
    rows = rows.filter((session) => (session.time.archived !== undefined) === wantArchived);
  }
  rows.sort((a, b) =>
    order === 'asc' ? a.time.updated - b.time.updated : b.time.updated - a.time.updated || 0,
  );
  if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, limit);
  return rows;
}

/**
 * Whether a config option is the agent's reasoning effort — the one the TUI shows as model
 * `variants` and `/thinking` picks from. One predicate for both directions, so the picker's
 * list and the switch that applies a pick can never disagree about which option it is.
 */
function isEffortOption(option: SessionConfigOption): boolean {
  const optionId = option.id ?? option.configId;
  return option.category === 'thought_level' || optionId === 'reasoning_effort' || optionId === 'effort';
}

function isModeOption(option: SessionConfigOption): boolean {
  const optionId = option.id ?? option.configId;
  return option.category === 'mode' || optionId === 'mode';
}

function modeChoicesOf(option: SessionConfigOption): SessionConfigSelectOption[] {
  const choices: SessionConfigSelectOption[] = [];
  for (const entry of option.options ?? []) {
    const group = entry as SessionConfigSelectGroup;
    if (Array.isArray(group.options)) {
      for (const item of group.options) {
        if (typeof item.value === 'string' && item.value.length > 0) choices.push(item);
      }
    } else {
      const item = entry as SessionConfigSelectOption;
      if (typeof item.value === 'string' && item.value.length > 0) choices.push(item);
    }
  }
  return choices;
}

function modeFromConfigOptions(options: readonly SessionConfigOption[]): string | undefined {
  for (const option of options) {
    if (!isModeOption(option)) continue;
    if (typeof option.currentValue === 'string' && option.currentValue.length > 0) {
      return option.currentValue;
    }
  }
  return undefined;
}

function modelFromConfigOptions(
  options: readonly SessionConfigOption[],
): { providerID: string; modelID: string } | undefined {
  for (const option of options) {
    const optionId = option.id ?? option.configId;
    if (option.category !== 'model' && optionId !== 'model') continue;
    const value = option.currentValue;
    if (typeof value !== 'string' || !value) continue;
    const parsed = parseModelValue(value);
    if (!parsed.providerID || !parsed.modelID) continue;
    return { providerID: parsed.providerID, modelID: parsed.modelID };
  }
  return undefined;
}

/**
 * the backend's own title for a session, or undefined.
 *
 * the backend keeps it in its projection store; the sidebar in the opencode TUI renders
 * `session.title`, so reading it here is what makes an external launcher show
 * the backend web instead of the directory basename.
 */



/**
 * Attachments we cannot forward. Images travel as ACP `image` blocks, and any
 * other `file://` URI (file or directory from the TUI's `@` picker) travels as
 * an ACP `resource_link` block — baseline in ACP, requiring no `fs/*` client
 * callback. Only an inline non-image blob (`{data, mime}` with no `file://`
 * URI) has no route and must be refused with 400 rather than dropped silently.
 */
export function unsupportedAttachments(payload: PromptBody): string[] {
  return (payload.files ?? [])
    .filter((file) => !isForwardableAttachment(file))
    .map((file) => file.name ?? file.mime ?? 'attachment');
}

/** Does this attachment have a route to the agent? (see unsupportedAttachments) */
function isForwardableAttachment(file: { data?: string; uri?: string; mime?: string; name?: string }): boolean {
  const mime = file.mime ?? '';
  if (typeof file.data === 'string' && file.data && /^image\//i.test(mime)) return true;
  if (typeof file.uri === 'string' && file.uri.startsWith('file://')) return true;
  return false;
}

/** Accept the `parts` array, a bare `text` field, and the TUI's `files`. */
export function promptParts(payload: PromptBody): Array<{ type: string; text?: string; [k: string]: unknown }> {
  const blocks: Array<{ type: string; text?: string; [k: string]: unknown }> = [];
  if (Array.isArray(payload.parts) && payload.parts.length > 0) {
    blocks.push(
      ...payload.parts.map((p) => ({ type: p.type ?? 'text', ...(p.text !== undefined ? { text: p.text } : {}) })),
    );
  } else if (typeof payload.text === 'string' && payload.text) {
    blocks.push({ type: 'text', text: payload.text });
  }
  // Images: an ACP image block is `{type, data, mimeType}`. Whether the agent can
  // take one is not decided here — filterPromptBlocks gates it on the capability
  // the agent advertised, and logs what it drops.
  for (const file of payload.files ?? []) {
    const mime = file.mime ?? '';
    if (typeof file.data === 'string' && file.data && /^image\//i.test(mime)) {
      blocks.push({ type: 'image', data: file.data, mimeType: mime });
      continue;
    }
    // The real TUI's `@file` picker sends a file:// URI (measured v2.0.30):
    // images are read and inlined as base64 ACP image blocks; non-image files
    // and directories are forwarded as baseline ACP `resource_link` blocks.
    if (typeof file.uri === 'string' && file.uri.startsWith('file://')) {
      const name = file.name ?? decodeURIComponent(file.uri).replace(/\/+$/, '').split('/').pop() ?? '';
      const looksImage = /^image\//i.test(mime) || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name);
      if (!looksImage) {
        blocks.push({
          type: 'resource_link',
          uri: file.uri,
          name: name || file.uri,
          ...(mime ? { mimeType: mime } : {}),
        });
        continue;
      }
      try {
        const absolute = fileURLToPath(file.uri);
        const bytes = readFileSync(absolute);
        blocks.push({
          type: 'image',
          data: bytes.toString('base64'),
          mimeType: mime || guessImageMime(name),
        });
      } catch (err) {
        // Unreadable file: the prompt still goes, the image silently does not.
        // The caller logged the attachment set already; this is a partial loss.
        console.error(`[bridge] could not read attachment ${file.uri}: ${String(err)}`);
      }
    }
  }
  return blocks;
}

function guessImageMime(name: string): string {
  if (/\.png$/i.test(name)) return 'image/png';
  if (/\.jpe?g$/i.test(name)) return 'image/jpeg';
  if (/\.gif$/i.test(name)) return 'image/gif';
  if (/\.webp$/i.test(name)) return 'image/webp';
  if (/\.bmp$/i.test(name)) return 'image/bmp';
  if (/\.svg$/i.test(name)) return 'image/svg+xml';
  return 'application/octet-stream';
}

/**
 * The physical spelling of a path (symlinks resolved), or the text when it cannot be
 * resolved. macOS is the reason this exists: `/var/...` and `/private/var/...` are the
 * same directory spelled two ways, and comparing or hashing the raw strings split one
 * workspace into two identities.
 */
export function canonicalPath(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    return directory;
  }
}

export function projectIdFor(directory: string): string {
  // Stable per directory, so a workspace keeps the same project id across requests —
  // the client uses it as a key. Same shape as the id we derive for our own directory.
  //
  // ★ Canonicalised first. On macOS `/var/...` and `/private/var/...` are the same
  // place, and hashing the raw string split ONE workspace into TWO project ids: the
  // bridge's own launch directory is the logical spelling while the client's cwd is
  // physical, so the client's session list (filtered by project) could hide the very
  // session it had just restored. Measured with a TMPDIR workspace. A path that does
  // not exist yet keeps its text: an id is always produced.
  return `proj_${createHash('sha1').update(canonicalPath(directory)).digest('hex').slice(0, 12)}`;
}

function currentBranch(directory: string): string {
  try {
    const head = `${directory}/.git/HEAD`;
    const text = readFileSync(head, 'utf8').trim();
    const match = /^ref: refs\/heads\/(.+)$/.exec(text);
    return match?.[1] ?? 'HEAD';
  } catch {
    return 'main';
  }
}

function mapPermissionResponse(response: string, request: RequestPermissionRequest): string | undefined {
  const normalized = response.toLowerCase();
  if (normalized === 'always' || normalized === 'allow_always') {
    return (
      request.options?.find((o) => o.kind === 'allow_always')?.optionId ??
      request.options?.find((o) => o.kind === 'allow_once')?.optionId ??
      request.options?.[0]?.optionId
    );
  }
  if (normalized === 'once' || normalized === 'allow') {
    return request.options?.find((o) => o.kind === 'allow_once')?.optionId ?? request.options?.[0]?.optionId;
  }
  if (normalized === 'reject' || normalized === 'deny') {
    return request.options?.find((o) => o.kind === 'reject_once')?.optionId;
  }
  return undefined;
}
