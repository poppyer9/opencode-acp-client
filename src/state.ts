/**
 * In-memory bridge state: sessions, messages and parts.
 *
 * Deliberately small. The ACP agent owns the authoritative transcript; this is
 * only what the opencode surface needs to answer its reads (`/api/session`,
 * `/api/session/:id/message`, …) between events.
 *
 * One subtlety worth stating: an ACP agent only ever tells us about *its*
 * session id. opencode's surface is keyed the same way, so we use the agent's
 * id directly and keep a reverse map for the paths that arrive before the id is
 * known.
 */

import type { Location, Message, Part, Session } from './contract.js';

export interface SessionRecord {
  session: Session;
  messages: Message[];
  parts: Map<string, Part[]>;
  /** ACP side id, once `session/new` answered. */
  acpSessionId?: string;
  /**
   * The agent command that owns this session, when it is not the one this bridge was
   * launched with. A tab restored from a session created by `opencode acp` must be
   * reattached with THAT agent — ACP has no notion of which agent a session belongs to,
   * so the session map records it and the adoption path binds the record to it here.
   * Undefined means "this bridge's own agent".
   */
  agent?: { command: string; args: string[] };
  /**
   * The shell `ensureSession` creates so the client has a session route before the user
   * types anything. It is not a conversation: `POST /api/session` adopts it (re-keyed to
   * the id the client chose) instead of leaving an empty duplicate row and a second agent
   * behind — measured: a fresh TUI conversation used to end with two sessions and two
   * agent processes, one of them an empty "New session" titled after the directory.
   * Cleared the moment a turn starts, so a shell that has been used is never adopted.
   */
  precreated?: boolean;
  /**
   * Where this session's title came from. Kept so the fallback title (the first
   * user message, truncated) can never overwrite something better:
   *
   *   - `titleFromAgent` — the agent said it (`session_info_update`, `session/list`);
   *   - `titleFromUser` — the client renamed it (PATCH / `/rename`);
   *   - `titleDerived` — we made it up from the first prompt.
   *
   * ACP has no client-side title method, and the plain ACP profile publishes no
   * titles at all, so without the derived fallback every such session is stuck on
   * the client's "New session". The agent's own title always wins when it arrives.
   */
  titleFromAgent?: boolean;
  titleFromUser?: boolean;
  titleDerived?: boolean;
  /**
   * The title came back from the session map (or was restored by the client) rather
   * than being the directory default. The first prompt must not replace it: measured
   * 2026-10-20 — `-s ses_acp_…` showed the real title, then the first prompt renamed
   * the tab and the sidebar to the prompt text, and only a restart restored it.
   */
  titleRestored?: boolean;
  /**
   * The ACP agent's slash commands, from `available_commands_update` — dsh advertises
   * ~45, most of them "Run the <skill> skill". Served by `GET /api/command` so the TUI
   * palette offers them, and run by `POST /api/session/:id/command` as a
   * `/name args` prompt (the official ACP slash-commands contract: "Commands are
   * included as regular user messages in prompt requests").
   */
  commands?: Array<{ name: string; description?: string; input?: { hint?: string } }>;
  /**
   * The workspace this session belongs to, taken from `?location[directory]=<path>`.
   *
   * Both clients send one. The TUI sends the directory it was started in, which is the
   * bridge's own, so nothing changes for it; the desktop sends the workspace it is
   * showing, which is the point. `cwd` is a required field of `session/new` in ACP, so a
   * per-session directory is the protocol's own model — and the TUI also checks that a
   * session's location matches the directory it is working in, which is why this must
   * never disagree with what the client asked for.
   */
  directory?: string;
  /**
   * `_meta` the agent has sent for this session, merged and never overwritten.
   *
   * ACP reserves `_meta` for extensions. opencode's HTTP schemas have no field
   * for it, so it is kept here rather than invented into a surface that would
   * ignore it — but it is not dropped either, and our own extensions must use
   * keys that cannot collide with an agent's.
   */
  meta?: Record<string, unknown>;
  /** True while a prompt is in flight (drives `turn.wait`/`turn.idle`). */
  busy: boolean;
  /**
   * Set when we ask the agent to stop (`/interrupt`, `/abort`), cleared when the
   * next turn begins. The turn's *outcome* is reported from this rather than from
   * the agent's stop reason alone: an agent that is cancelled mid-permission may
   * still answer `end_turn`, and a turn the user cancelled must not be reported
   * as one that finished on its own.
   */
  interruptRequested?: boolean;
  /**
   * The model this session is on. Reported in `session.step.started` so the
   * client's assistant row carries one — the sidebar's context meter looks it up
   * by providerID/modelID and gives up without it.
   */
  model?: { providerID: string; modelID: string };
  /**
   * Transient mode requested via `POST /api/session/:id/agent` while `ensureAgent`
   * is still starting the ACP session, so startup reconciliation applies it once.
   */
  pendingMode?: string;
  /**
   * A resumed session's tape, read off disk on first use and then frozen. It is
   * kept beside `messages` rather than copied into it: `messages` is the bridge's
   * own append-ordered record of what it watched happen, this is what happened
   * before the bridge was there.
   */
  history?: Array<Record<string, unknown>>;
  /**
   * What the backend calls itself (`initialize`'s `agentInfo.name`).
   *
   * Used wherever opencode wants an agent or provider id. It is read from the
   * backend rather than hardcoded so nothing here assumes which one it is.
   */
  backendName?: string;
}

export class BridgeState {
  private readonly sessions = new Map<string, SessionRecord>();
  private seq = 0;

  newId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}${(++this.seq).toString(36)}`;
  }

  /**
   * Create a session, optionally under an id the caller already chose.
   *
   * opencode creates optimistically: it mints the id client-side, admits a local
   * row, and only then POSTs it. Ignoring that id means the client looks up the
   * session it thinks it made, misses, and follows with
   * `GET /api/session/undefined`.
   */
  createSession(
    location: Location,
    title?: string,
    requestedId?: string,
    time?: { created?: number; updated?: number },
  ): SessionRecord {
    const existing = requestedId ? this.sessions.get(requestedId) : undefined;
    if (existing) return existing;
    const id = requestedId ?? this.newId('ses');
    const now = Date.now();
    const updated = time?.updated ?? now;
    const created = time?.created ?? updated;
    const session: Session = {
      id,
      directory: location.directory,
      time: { created, updated },
      // The client reads session.location.directory directly; see SessionInfo.
      location: { directory: location.directory, workspaceID: location.workspaceID },
      projectID: location.project.id,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...(title ? { title } : {}),
    };
    const record: SessionRecord = {
      session,
      messages: [],
      parts: new Map(),
      busy: false,
    };
    this.sessions.set(id, record);
    return record;
  }

  /** Re-key a session under the id the client chose (see `precreated`). */
  rekey(oldId: string, newId: string): SessionRecord | undefined {
    const record = this.sessions.get(oldId);
    if (!record || this.sessions.has(newId)) return undefined;
    this.sessions.delete(oldId);
    record.session.id = newId;
    this.sessions.set(newId, record);
    return record;
  }

  get(id: string): SessionRecord | undefined {
    const direct = this.sessions.get(id);
    if (direct) return direct;
    // Alias: the ACP agent's own id. The visible id is the bridge's (or whatever a
    // launcher chose — an external launcher may pass the agent's own id straight
    // through), and the agent's id is the other half of that pair. Accepting either
    // is what makes "resume with the id you copied" work without knowing which one
    // it is.
    for (const record of this.sessions.values()) {
      if (record.acpSessionId === id) return record;
    }
    return undefined;
  }

  all(): SessionRecord[] {
    return [...this.sessions.values()].sort((a, b) => {
      // A record with no messages yet (the pre-created one, titled by the
      // directory basename) must never outrank a real conversation as "newest"
      // — that is exactly what made `-c` open a blank session while the
      // imported one sat in the tab row. Emptiness first, then recency.
      const aEmpty = a.messages.length === 0 ? 1 : 0;
      const bEmpty = b.messages.length === 0 ? 1 : 0;
      if (aEmpty !== bEmpty) return aEmpty - bEmpty;
      return b.session.time.updated - a.session.time.updated;
    });
  }

  touch(id: string): void {
    const record = this.sessions.get(id);
    if (record) record.session.time.updated = Date.now();
  }

  addMessage(record: SessionRecord, message: Message): void {
    record.messages.push(message);
    if (!record.parts.has(message.id)) record.parts.set(message.id, []);
    // A bridge-emitted notice is not conversation content and must not
    // re-stamp a restored session's `time.updated` to now.
    if (!message.notice) record.session.time.updated = Date.now();
  }

  getMessage(record: SessionRecord, messageId: string): Message | undefined {
    return record.messages.find((m) => m.id === messageId);
  }

  partsOf(record: SessionRecord, messageId: string): Part[] {
    return record.parts.get(messageId) ?? [];
  }

  /**
   * Append to a part, creating it if needed. Returns the part and whether it
   * was newly created, so the caller can decide between `updated` and `delta`.
   */
  upsertPart(record: SessionRecord, messageId: string, part: Part): { part: Part; created: boolean } {
    const list = record.parts.get(messageId) ?? [];
    const index = list.findIndex((p) => p.id === part.id);
    if (index < 0) {
      list.push(part);
      record.parts.set(messageId, list);
      return { part, created: true };
    }
    list[index] = part;
    return { part, created: false };
  }

  findPart(record: SessionRecord, partId: string): Part | undefined {
    for (const list of record.parts.values()) {
      const hit = list.find((p) => p.id === partId);
      if (hit) return hit;
    }
    return undefined;
  }

  removeSession(id: string): void {
    this.sessions.delete(id);
  }
}
