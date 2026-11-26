/**
 * The one file this bridge writes, and why.
 *
 * ACP does not let a client name a new session: `session/new` has no id field — its
 * properties are `{_meta, additionalDirectories, cwd, mcpServers}` — and the id arrives in
 * the response, chosen by the agent. A probe against dsh confirms `_meta.sessionId` is not
 * honoured either. A client that owns its backend can choose the id while creating a session;
 * a generic ACP client has no such call.
 *
 * So a session here has two ids: the one the client is shown and remembers, and the agent's
 * own. Resuming a remembered tab — `session/load` — needs the agent's, and without a record
 * of the pair the client's id is unknown to the agent and the tab comes back empty.
 *
 * Hence this map: ids, directories and optional agent titles only; never message content or
 * credentials. It is read once and rewritten on change. `OPENCODE_ACP_CLIENT_SESSION_MAP` relocates it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export interface AgentBinding {
  command: string;
  args: string[];
}

/** `dsh --profile acp`: the human-readable form of a binding, used for logs and comparisons. */
export function agentBindingLabel(binding: AgentBinding): string {
  return [basename(binding.command), ...binding.args].join(' ');
}

/**
 * Read a stored binding. Older entries (and the first version of this field) held a
 * space-separated string; split it on whitespace as a best effort — arguments with
 * spaces were never representable in that shape anyway.
 */
function parseBinding(value: unknown): AgentBinding | undefined {
  if (typeof value === 'string' && value.trim()) {
    const [command, ...args] = value.trim().split(/\s+/);
    return command ? { command, args } : undefined;
  }
  if (value && typeof value === 'object') {
    const raw = value as { command?: unknown; args?: unknown };
    if (typeof raw.command === 'string' && raw.command.length > 0) {
      return {
        command: raw.command,
        args: Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string') : [],
      };
    }
  }
  return undefined;
}

export interface SessionMapEntry {
  acpSessionId: string;
  directory?: string;
  /** Optional title returned by stable ACP session/list; never message content. */
  title?: string;
  /** Sticky ACP mode id last selected by the user for this session. */
  mode?: string;
  /**
   * The agent command that created the session. ACP has no notion of "which agent owns
   * this session", so without this the bridge would hand a remembered id to whatever
   * agent the current run launched — and a tab from another backend would come up empty
   * with no explanation. With it, the adoption path can spawn the session's OWN agent.
   * Stored as argv, not a shell string: it is spawned without a shell.
   */
  agent?: AgentBinding;
  /**
   * When the conversation was last ADVANCED (a prompt the turn path accepted). This is
   * what `-c` ranks by, so metadata writes deliberately do not move it.
   */
  updatedAt: number;
  /**
   * When the bridge first remembered this conversation.
   *
   * Optional because it was added later: every row written before then has none, and
   * guessing one from `updatedAt` would claim a creation time nobody measured.
   */
  createdAt?: number;
}

type SessionMapData = Record<string, SessionMapEntry>;
/** Ids a bridge forgot, with when. Newer than their entry, a tombstone wins. */
type Tombstones = Record<string, number>;

const TOMBSTONE_KEY = '__tombstones';
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const MAX_ENTRIES = 500;

export function sessionMapPath(): string {
  const override = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
  if (override && override.length > 0) return override;
  // `~/.opencode-acp-client/sessions.json`. It began under `XDG_STATE_HOME`, which is the
  // Linux convention for state rather than configuration — but that variable is unset on
  // macOS, so it landed in `~/.local/state/...`, deeper and less discoverable than anything
  // around it. opencode itself keeps `~/.config/opencode/` and `~/.opencode/`; one dotdir in
  // the home directory is easier to find, back up and delete, and needs no convention.
  return join(homedir(), '.opencode-acp-client', 'sessions.json');
}

export class SessionMap {
  private data: SessionMapData | undefined;
  private tombstones = new Map<string, number>();
  private dirty = false;

  constructor(private readonly log: (line: string) => void) {}

  private readFromDisk(path: string): { data: SessionMapData; tombstones: Tombstones } {
    const data: SessionMapData = {};
    const tombstones: Tombstones = {};
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        const deleted = record[TOMBSTONE_KEY];
        if (deleted && typeof deleted === 'object' && !Array.isArray(deleted)) {
          for (const [id, at] of Object.entries(deleted as Record<string, unknown>)) {
            if (typeof at === 'number') tombstones[id] = at;
          }
        }
        for (const [id, value] of Object.entries(record)) {
          if (id === TOMBSTONE_KEY) continue;
          const entry = value as Partial<SessionMapEntry> | null;
          if (entry && typeof entry.acpSessionId === 'string') {
            const updatedAt = typeof entry.updatedAt === 'number' ? entry.updatedAt : 0;
            // A tombstone at least as new as the entry means it was forgotten after it was
            // written: `forget` is used by the adoption path too, so a stale copy of the
            // file must not bring a renamed-away shell id back.
            if (tombstones[id] !== undefined && tombstones[id]! >= updatedAt) continue;
            data[id] = {
              acpSessionId: entry.acpSessionId,
              ...(typeof entry.createdAt === 'number' ? { createdAt: entry.createdAt } : {}),
              ...(typeof entry.directory === 'string' ? { directory: entry.directory } : {}),
              ...(typeof entry.title === 'string' && entry.title.trim() ? { title: entry.title } : {}),
              ...(typeof entry.mode === 'string' && entry.mode.trim() ? { mode: entry.mode } : {}),
              ...(parseBinding((entry as { agent?: unknown }).agent) ? { agent: parseBinding((entry as { agent?: unknown }).agent) } : {}),
              updatedAt,
            };
          }
        }
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'ENOENT') this.log(`[bridge] session map unreadable (${String(error)}); starting empty`);
    }
    return { data, tombstones };
  }

  private load(): SessionMapData {
    if (this.data) return this.data;
    const read = this.readFromDisk(sessionMapPath());
    this.data = read.data;
    this.tombstones = new Map(Object.entries(read.tombstones));
    if (Object.keys(this.data).length > 0) {
      this.log(`[bridge] session map: ${Object.keys(this.data).length} remembered id(s) from ${sessionMapPath()}`);
    }
    return this.data;
  }

  /** The agent's id for a session the client remembers, if we have ever learned it. */
  acpIdFor(visibleId: string): string | undefined {
    return this.load()[visibleId]?.acpSessionId;
  }

  /** Every remembered visible id and its entry (callers sort/filter as needed). */
  entries(): Array<[string, SessionMapEntry]> {
    return Object.entries(this.load());
  }

  /** A bridge-visible `ses_…` alias already associated with this agent id, if any. */
  visibleIdFor(acpSessionId: string, directory?: string): string | undefined {
    // When a directory is given, an entry WITHOUT one must not match: a session
    // the agent reports under workspace A once picked up a stale map entry
    // written under workspace B (the same agent session had been used in both),
    // and the imported tab then adopted B's visible id — whose map entry named
    // directory B, so resuming it loaded nothing under A. Match the requested
    // directory exactly, or fall back to an entry that truly has none.
    const entries = Object.entries(this.load());
    const strict = directory === undefined ? undefined : entries.filter(([id, e]) => e.directory === directory);
    for (const [visibleId, entry] of strict ?? entries) {
      if (visibleId.startsWith('ses_') && entry.acpSessionId === acpSessionId) {
        return visibleId;
      }
    }
    if (directory === undefined) return undefined;
    // Legacy entries may predate per-entry directories; a directoryless match
    // is still better than inventing a second visible id for one conversation.
    for (const [visibleId, entry] of entries) {
      if (
        visibleId.startsWith('ses_') &&
        entry.acpSessionId === acpSessionId &&
        entry.directory === undefined
      ) {
        return visibleId;
      }
    }
    return undefined;
  }

  titleFor(visibleId: string): string | undefined {
    return this.load()[visibleId]?.title;
  }

  modeFor(visibleId: string): string | undefined {
    return this.load()[visibleId]?.mode;
  }

  /** Remember a session's sticky mode without touching `updatedAt` (preserves `-c` recency). */
  rememberMode(visibleId: string, mode: string): void {
    const existing = this.load()[visibleId];
    if (!existing || existing.mode === mode) return;
    existing.mode = mode;
    this.dirty = true;
  }

  /**
   * The agent binding that created a remembered session, when it was recorded. `undefined`
   * for entries written before the field existed — those keep the launching agent.
   */
  agentFor(visibleId: string): AgentBinding | undefined {
    return this.load()[visibleId]?.agent;
  }

  /**
   * The directory a remembered session lives in — the last one the bridge itself recorded,
   * which a `/cd` move re-pointed. The adoption path needs it: a restarted bridge is launched
   * in its own directory, and without this lookup it would adopt a moved session back into
   * the launch directory, silently un-doing the move (and re-loading the agent there).
   */
  directoryFor(visibleId: string): string | undefined {
    const directory = this.load()[visibleId]?.directory;
    return typeof directory === 'string' && directory.length > 0 ? directory : undefined;
  }

  /** Recorded timestamps for a remembered session, if known. */
  timesFor(visibleId: string): { createdAt?: number; updatedAt: number } | undefined {
    const entry = this.load()[visibleId];
    if (!entry) return undefined;
    return {
      ...(entry.createdAt !== undefined ? { createdAt: entry.createdAt } : {}),
      updatedAt: entry.updatedAt,
    };
  }

  /**
   * Remember a visible id → agent id pair.
   *
   * `used` says whether the CONVERSATION was advanced (a prompt the turn path accepted), as
   * opposed to the bridge merely writing metadata about it. Only `used` moves `updatedAt`,
   * because that field is what `-c` ranks by ("the most recent conversation"): metadata
   * writes — a `session/list` import, a `/cd` move, a restored title — used to re-stamp every
   * row in the directory with the same instant, so `-c` picked whichever the import happened
   * to walk first instead of the conversation the user last worked in (measured 2026-10-27).
   */
  remember(
    visibleId: string,
    acpSessionId: string,
    directory?: string,
    title?: string,
    agent?: AgentBinding,
    used = false,
    mode?: string,
  ): void {
    const data = this.load();
    const existing = data[visibleId];
    const nextTitle = title?.trim() || existing?.title;
    const nextMode = mode?.trim() || existing?.mode;
    const nextAgent = agent || existing?.agent;
    const sameAgent =
      existing?.agent === nextAgent ||
      (existing?.agent !== undefined &&
        nextAgent !== undefined &&
        agentBindingLabel(existing.agent) === agentBindingLabel(nextAgent));
    if (
      existing &&
      existing.acpSessionId === acpSessionId &&
      existing.directory === directory &&
      existing.title === nextTitle &&
      existing.mode === nextMode &&
      sameAgent
    ) {
      // Nothing to write but recency: a prompt still means "this is the conversation I am
      // working in", so it must move the row to the top of `-c`'s ranking.
      if (used) {
        existing.updatedAt = Date.now();
        this.dirty = true;
      }
      return;
    }
    data[visibleId] = {
      acpSessionId,
      // First sighting only: a later metadata write must not restamp it.
      createdAt: existing?.createdAt ?? Date.now(),
      ...(directory ? { directory } : {}),
      ...(nextTitle ? { title: nextTitle } : {}),
      ...(nextMode ? { mode: nextMode } : {}),
      ...(nextAgent ? { agent: nextAgent } : {}),
      // A NEW row has no earlier stamp to keep, so it takes one even for metadata: the cap
      // (`MAX_ENTRIES`, sorted by `updatedAt`) needs every row dated.
      updatedAt: used || existing === undefined ? Date.now() : existing.updatedAt,
    };
    // Remembering an id cancels its tombstone (an adopted session can be re-added).
    this.tombstones.delete(visibleId);
    this.dirty = true;
  }

  /** Forget a session the user deleted, so nothing can hand it back later. */
  forget(...ids: string[]): void {
    const data = this.load();
    for (const id of ids) {
      if (id in data) delete data[id];
      // Record the deletion, not just the absence: another bridge may still hold a copy
      // that was loaded before this call, and its flush must not resurrect the id.
      this.tombstones.set(id, Date.now());
      this.dirty = true;
    }
  }

  /** Also file the agent's own id as a key, so a tab that names it resolves too. */
  /**
   * Remember a visible id → agent id pair.
   *
   * Earlier this also stored the agent id mapped to itself, so a client that asked for the agent's
   * own id would resolve. Nothing asks: every id the client requests comes from the `ses_…` alias
   * the bridge showed it (measured — the TUI requests `ses_ec3718af…` and `ses_acp_…`, never a bare
   * UUID), and the only reverse lookup, `visibleIdFor`, requires `visibleId.startsWith('ses_')`, so
   * a self-mapping could never match it either. The entries were therefore dead weight: they were
   * 79 of 153 rows in the owner's real file (52%), and because `flush()` sorts by `updatedAt` and
   * truncates at `MAX_ENTRIES`, they could push real mappings out of the cap.
   */
  rememberBoth(
    visibleId: string,
    acpSessionId: string,
    directory?: string,
    title?: string,
    agent?: AgentBinding,
    used = false,
    mode?: string,
  ): void {
    this.remember(visibleId, acpSessionId, directory, title, agent, used, mode);
  }

  /** Write if anything changed. Failures are logged, never fatal: the map is an optimisation. */
  flush(): void {
    if (!this.dirty || !this.data) return;
    try {
      const path = sessionMapPath();
      // Merge what other bridges wrote since this one loaded. The file is shared by
      // every running client, and writing our in-memory copy outright dropped their
      // new sessions — measured: a live tab disappeared from the map when another
      // bridge flushed, and `-s <its id>` then answered "unknown session id". Merging
      // without tombstones also undid `forget`, which the adoption path uses.
      const disk = this.readFromDisk(path);
      for (const [id, at] of Object.entries(disk.tombstones)) {
        const mine = this.tombstones.get(id);
        if (mine === undefined || at > mine) this.tombstones.set(id, at);
      }
      const cutoff = Date.now() - TOMBSTONE_TTL_MS;
      for (const [id, at] of this.tombstones) if (at < cutoff) this.tombstones.delete(id);
      for (const [id, entry] of Object.entries(disk.data)) {
        const tombstone = this.tombstones.get(id);
        if (tombstone !== undefined && tombstone >= entry.updatedAt) continue;
        const mine = this.data[id];
        if (!mine || entry.updatedAt > mine.updatedAt) this.data[id] = entry;
      }
      const entries = Object.entries(this.data)
        .filter(([id, entry]) => {
          const tombstone = this.tombstones.get(id);
          return tombstone === undefined || tombstone < entry.updatedAt;
        })
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
        .slice(0, MAX_ENTRIES);
      mkdirSync(dirname(path), { recursive: true });
      // Write-then-rename: a reader (another bridge loading, or `-s`) must never see
      // a half-written map, and a crash mid-write must not truncate it.
      const temporary = `${path}.${process.pid}.tmp`;
      const payload = {
        ...Object.fromEntries(entries),
        ...(this.tombstones.size > 0 ? { [TOMBSTONE_KEY]: Object.fromEntries(this.tombstones) } : {}),
      };
      writeFileSync(temporary, JSON.stringify(payload, null, 2), 'utf8');
      renameSync(temporary, path);
      this.dirty = false;
    } catch (error) {
      this.log(`[bridge] session map not written: ${String(error)}`);
    }
  }
}
