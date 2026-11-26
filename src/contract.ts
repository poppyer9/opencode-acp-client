/**
 * The opencode v2 surface this bridge implements.
 *
 * Two reference points shaped this file:
 *  - `packages/tui/test/fixture/tui-client.ts` in the opencode repo: the
 *    minimal server their own TUI tests accept. Its route list is the floor.
 *  - the backend-oc's bridge: the same surface, proven against the real TUI.
 *
 * Everything here is therefore *observed*, not invented. Where a shape was
 * inferred (part payloads), it is marked with `INFERRED` so the next person
 * knows what to re-check against a new client build.
 */

/** The event envelope every `/api/event` frame carries. */
export interface BridgeEvent<T extends string = string, D = unknown> {
  /**
   * The client's store reads this on some events (the shell ones) and hangs it on the
   * message it inserts; leaving it off meant `metadata: undefined` there.
   */
  metadata?: Record<string, unknown>;
  id: string;
  type: T;
  data: D;
  /**
   * The client stamps `time.created` from this on every row it builds, so an
   * absent value leaves rows with `created: undefined`.
   */
  created: number;
  /** opencode tags events with the location they belong to. */
  location?: Location;
}

export interface Project {
  id: string;
  directory: string;
  canonical: string;
}

export interface Location {
  directory: string;
  /** The client builds a LocationRef from this and dereferences it. */
  workspaceID?: string;
  project: Project;
}

/** Most `/api/*` reads wrap their payload in a location envelope. */
export interface Located<T> {
  location: Location;
  data: T;
}

export interface Session {
  /**
   * The ACP agent's own session id, once `session/new` (or a load/resume) has
   * answered. The client-visible `id` stays ours: the published surface requires
   * `^ses`, the agent id does not exist until the agent answers, and changing a
   * primary id after the client has stored it would break its routing.
   */
  acpSessionId?: string;
  id: string;
  directory: string;
  title?: string;
  /** Active primary agent / ACP mode id for this session, if known. */
  agent?: string;
  parentID?: string;
  outcome?: 'succeeded' | 'failed' | 'interrupted';
  time: { created: number; updated: number; idle?: number; viewed?: number; archived?: number };
  /**
   * Required by the client's `SessionInfo`. It hydrates `session.info[id]`
   * straight from this and later dereferences `session.location.directory`, so
   * omitting it is what takes the TUI down with
   * `undefined is not an object (evaluating 'O().location.directory')`.
   */
  location: LocationRef;
  projectID: string;
  /** MoneyUSD is just a number. */
  cost: number;
  tokens: TokenUsageInfo;
}

/**
 * One shell command the client asked to run via `POST /api/shell`. The TUI polls
 * `/api/shell/:id/output` for the transcript rather than streaming it.
 */
export interface ShellRecord {
  id: string;
  command: string;
  cwd: string;
  shell: string;
  file: string;
  pid?: number;
  exit?: number;
  status: 'running' | 'exited' | 'timeout' | 'killed';
  /** Required by the spec's `Shell.Info`; ACP gives us nothing to fill it with. */
  metadata: Record<string, unknown>;
  /**
   * Deliberately absent from what we serve. The TUI's shell row fetches the text from
   * `/api/shell/:id/output`, and a value on this object makes it skip that fetch while
   * still rendering nothing; `ShellRun` keeps it internally.
   */
  output?: string;
  time: { started: number; completed?: number };
  /** Where it ran. The TUI opens its output dialog with this. */
  location?: { directory: string; project?: { id: string; directory: string } };
}

export interface LocationRef {
  directory: string;
  workspaceID?: string;
}

export interface TokenUsageInfo {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

/** INFERRED: mirrors the backend-oc's `streamPart` shape. */
export interface TextPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'text';
  text: string;
  time: { start: number; end?: number };
}

export interface ReasoningPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'reasoning';
  text: string;
  time: { start: number; end?: number };
}

export interface ToolPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'tool';
  callID: string;
  tool: string;
  state: {
    status: 'pending' | 'running' | 'completed' | 'error';
    input?: unknown;
    output?: string;
    title?: string;
    /**
     * ACP's `ToolKind` (`execute`, `edit`, `read`, `search`, …), from the tool call's first
     * frame. The projection emits it because the client's own ACP adapter does: with
     * `kind: "execute"` the row is a shell card even when the agent never sent a
     * programmatic `name` (dsh sends a title only).
     */
    kind?: string;
    /**
     * Why the call failed, as the agent's own sentence ("[tool error: FS_STALE_VERSION]").
     * Kept apart from `output`: `output` is what the tool *produced* (for a `write`
     * that is the file's content), and the client paints `state.error.message` as the
     * failure. Using `output` for both made a failed write render as a successful
     * card whose "error" was the entire file.
     */
    error?: string;
    /**
     * Per-tool metadata that must survive a reload.
     *
     * The client stores this **inside `state`** (`ToolStateCompleted.metadata` in
     * `packages/schema/src/session-message.ts`) and its shell row reads
     * `props.metadata.shellID` to find the shell behind a `!command` card. Dropping it here
     * meant a reloaded transcript showed the tool row without its shell, so the output could
     * never be fetched again.
     */
    metadata?: Record<string, unknown>;
    time: { start: number; end?: number };
  };
}

export type Part = TextPart | ReasoningPart | ToolPart;

export interface Message {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  parentID?: string;
  time: { created: number; completed?: number };
  error?: { name: string; message: string };
  /**
   * A non-conversation notice shown in the transcript, modelled on the client's
   * `Session.Message.System` (`type: "system"`), which the TUI renders as a
   * `◈ Notice` row — the same surface the official client uses for
   * "Instructions updated". The bridge uses it to say WHY a restored tab is
   * empty: the session resumed, but the agent has no `session/load`, so the
   * earlier conversation is not replayed. It is a notice, not a user or
   * assistant turn, so it never counts as conversation content.
   */
  notice?: { text: string; description?: string };
  /**
   * A `!command` the bridge ran for this session.
   *
   * The client models a shell as its **own top-level message type**, not as an assistant tool
   * part: `packages/schema/src/session-message.ts` declares `type: "shell"` with
   * `{shellID, command, status, exit?, output?}`, and `SessionMessageView` matches
   * `props.message.type === "shell"` to render it with the shell component. Storing a shell as
   * a `tool` part therefore rendered it as a generic tool card after a reload — and, because a
   * generic card has no shell context, it could not resolve `backgroundRunning` either.
   */
  shell?: {
    shellID: string;
    command: string;
    cwd?: string;
    status: 'running' | 'exited' | 'failed';
    exit?: number;
    output?: string;
  };
}

/** `POST /api/session/:id/prompt` request body. */
export interface PromptBody {
  /** The client-generated inbox id; also the id it echoes the user row under. */
  id?: string;
  messageID?: string;
  /** `steer` (default) runs immediately; `queue` waits for the current turn. */
  delivery?: 'steer' | 'queue';
  model?: { providerID?: string; modelID?: string };
  agent?: string;
  parts?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  /** Older clients send a bare `text`. */
  text?: string;
  /**
   * Attachments. Measured on v2.0.30: the real TUI's `@file` picker sends
   * `{uri: "file:///abs/path", mime, name}` — a file URI, NOT base64 (the
   * schema's `{data}` shape is what an API caller would send, and an earlier
   * reading of the schema alone got this wrong: the image path looked dead
   * until the wire was actually inspected). The bridge reads the file from
   * the URI and forwards image attachments as ACP image blocks.
   */
  files?: Array<{ data?: string; uri?: string; mime?: string; name?: string }>;
  /**
   * Skill mentions. The picker sends the chosen id; the bridge inlines the skill's
   * content as the first text block of the ACP prompt, in the official toModelOutput
   * envelope (`<skill_content>`), because that is what makes an agent actually execute
   * the skill — a resource link is spec-legal but measured toothless. Agents have no ACP
   * surface and stay logged only.
   */
  skills?: Array<{ id?: string; name?: string }>;
  agents?: Array<{ name?: string }>;
  noReply?: boolean;
}

/**
 * `Form.Info` — opencode's own shape for a form the user is asked to fill in.
 *
 * Observed from `packages/protocol/src/groups/form.ts` and
 * `packages/schema/src/form.ts` in the opencode checkout, not invented: the id
 * must start with `frm_`, `fields` must be non-empty, and `title` is required.
 * The field union upstream is tagged by `type`; one interface with optional
 * members serialises identically and is easier to build from a JSON Schema.
 */
export interface FormFieldOption {
  value: string;
  label: string;
  description?: string;
}

export interface FormField {
  key: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'multiselect';
  title?: string;
  description?: string;
  required?: boolean;
  format?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  placeholder?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  default?: string | number | boolean | string[];
  options?: FormFieldOption[];
}

export interface FormInfo {
  id: string;
  sessionID: string;
  title: string;
  fields: FormField[];
  metadata?: Record<string, unknown>;
}

/** `Form.Answer` — one value per field, keyed by the field's `key`. */
export type FormAnswer = Record<string, string | number | boolean | string[]>;

/** The event names we emit. Proven against the real TUI via the backend-oc. */
export const EVENT = {
  serverConnected: 'server.connected',
  sessionCreated: 'session.created',
  sessionViewed: 'session.viewed',
  sessionUpdated: 'session.updated',
  /**
   * The event the TUI actually reads for a title change. Verified against the
   * client's store (`packages/client/src/solid/data.ts`): it has a case for
   * `session.renamed` and **none** for `session.updated`, so a title — whether it
   * came from a rename or from the agent's `session_info_update` — only reaches
   * the sidebar through this one. Payload: `{sessionID, title}`.
   */
  sessionRenamed: 'session.renamed',
  /**
   * The session's working directory changed (`/cd`). The client's store has a dedicated
   * case for this one (data.ts `case "session.moved"`) that nothing else can reach: it
   * rewrites the session's `location`/`projectID`/`subpath` — which is what the footer
   * and the sidebar read — and inserts a `location-switched` row into the transcript
   * ("↳ Moved to <dir>") purely from the event. Payload:
   * `{sessionID, location: {directory}, projectID, subpath}`.
   */
  sessionMoved: 'session.moved',
  /**
   * The location's command palette changed. The client's store has a dedicated case
   * (`command.updated`) that invalidates and re-syncs `GET /api/command` — which is
   * exactly how the agent's ACP `available_commands_update` (dsh's slash commands, most
   * of which run its skills) reaches the palette. Payload: `{}` + `location`.
   */
  commandUpdated: 'command.updated',
  /**
   * The location's model catalog changed. The client's store has a dedicated case that
   * invalidates and re-syncs `GET /api/model`. Needed after a restored session's
   * `session/load` applies the agent's config options: the client fetched the catalog
   * *before* the adoption (at startup), saw only the placeholder, and nothing else would
   * tell it to look again — leaving every model `(unavailable)` and the composer locked.
   * Payload: `{}` + `location`.
   */
  modelUpdated: 'model.updated',
  /**
   * The location's agent/mode list changed (ACP `category: "mode"` options arrived or
   * changed). Triggers `location.agent.sync` in the TUI, mirroring `model.updated`.
   */
  agentUpdated: 'agent.updated',
  /**
   * The session's selected model changed — including when the *agent* changed it
   * (a rate-limit fallback, say). Payload `{sessionID, model: {providerID, modelID}, previous?}`;
   * the store writes `model` into the session info, which is what the composer
   * and the context meter read.
   */
  modelSelected: 'session.model.selected',
  /**
   * The session's active agent/mode changed — including via `POST /api/session/:id/agent`
   * or an agent-pushed `config_option_update`. Payload `{sessionID, agent, previous?}`.
   */
  agentSelected: 'session.agent.selected',
  sessionIdle: 'session.idle',
  sessionStatus: 'session.status',
  sessionError: 'session.error',
  messageUpdated: 'message.updated',
  messagePartUpdated: 'message.part.updated',
  messagePartDelta: 'message.part.delta',
  permissionAsked: 'permission.asked',
  permissionReplied: 'permission.replied',
  /**
   * Form lifecycle, as the TUI's data store reads it (`packages/schema/src/form.ts`
   * declares them ephemeral). `form.created` is what makes the form UI appear;
   * the reply and cancel events dismiss it.
   */
  formCreated: 'form.created',
  formReplied: 'form.replied',
  formCancelled: 'form.cancelled',
  sessionUsageUpdated: 'session.usage.updated',
  /**
   * The session's `time.updated`. The client's spinner reads it through
   * `time.now()` to render "Sending · Ns"; without a frame carrying it (and a
   * `message.updated` with `completed`) the counter keeps running after the work
   * stopped. Ephemeral, like `session.usage.updated`.
   */
  sessionTimeUpdated: 'session.time.updated',
  // opencode v2 speaks a different vocabulary than v1's message.part.*. The TUI
  // only renders these, so both are emitted (v1 kept for the smoke harness).
  toolInputStarted: 'session.tool.input.started',
  toolInputDelta: 'session.tool.input.delta',
  toolInputEnded: 'session.tool.input.ended',
  toolCalled: 'session.tool.called',
  toolProgress: 'session.tool.progress',
  toolSuccess: 'session.tool.success',
  toolFailed: 'session.tool.failed',
  inboxEnqueued: 'session.inbox.enqueued',
  inboxDelivered: 'session.inbox.delivered',
  inboxCancelled: 'session.inbox.cancelled',
  inboxDeliveryChanged: 'session.inbox.delivery.changed',
  shellStarted: 'session.shell.started',
  shellEnded: 'session.shell.ended',
  /**
   * The official lifecycle event that takes a finished shell out of the client's **live** shell
   * table (`shell.exited` / `shell.deleted`, both ephemeral in `packages/schema/src/shell.ts`).
   * The client's `data.shell` is what its shell row reads for
   * `backgroundRunning = Boolean(id && data.shell.get(id))`, so without this an exited command
   * kept a spinner on its card after the session was reopened. The `/api/shell` list itself
   * keeps the record, so its output stays readable.
   */
  shellExited: 'shell.exited',
  stepStarted: 'session.step.started',
  stepEnded: 'session.step.ended',
  stepFailed: 'session.step.failed',
  executionStarted: 'session.execution.started',
  executionSucceeded: 'session.execution.succeeded',
  // The client's store maps this one to `outcome: "interrupted"`; it is not
  // in the published OpenAPI (which models no execution events at all), so the
  // client is the authority here.
  executionInterrupted: 'session.execution.interrupted',
  executionFailed: 'session.execution.failed',
  textStarted: 'session.text.started',
  textDelta: 'session.text.delta',
  textEnded: 'session.text.ended',
  reasoningStarted: 'session.reasoning.started',
  reasoningDelta: 'session.reasoning.delta',
  reasoningEnded: 'session.reasoning.ended',
  turnWait: 'turn.wait',
  turnIdle: 'turn.idle',
} as const;
