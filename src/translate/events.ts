/**
 * ACP → opencode event translation.
 *
 * This is the layer that decides *how the conversation looks*. ACP speaks in
 * coarse "chunks" and tool calls; opencode renders messages made of typed
 * parts. Getting this wrong does not throw — the agent streams happily and the
 * UI simply stays empty — so it is worth reading carefully.
 *
 * Translation rules, and why:
 *
 *   agent_message_chunk  → append to a `text` part, emit `message.part.delta`
 *                          followed by `message.part.updated` (the TUI uses the
 *                          delta for streaming and the full part on re-render).
 *   agent_thought_chunk  → same, as a `reasoning` part. Closing it matters:
 *                          a never-closed reasoning part is a spinner that
 *                          never stops.
 *   tool_call / _update  → one `tool` part per `toolCallId`, status mapped from
 *                          ACP's free-form status strings.
 *   plan                 → logged only; opencode v2 has no todo surface
 *                          rather than a wall of text.
 *   user_message_chunk   → dropped. The bridge already appended the user's
 *                          message when `/prompt` was called; echoing it again
 *                          duplicates the bubble.
 *
 * Anything unrecognised is ignored *by design* but logged, so a new ACP agent
 * feature shows up as a log line instead of silence.
 */

import type { BridgeEvent, Location, Part, Message } from '../contract.js';
import { EVENT } from '../contract.js';
import type { BridgeState, SessionRecord } from '../state.js';
import { UPDATE, type SessionUpdate } from '../acp/types.js';
import {
  applyChildEvent,
  childCaption,
  isStillRunning,
  type ChildProgress,
  type ChildSessionEvent,
} from '../subagent-sessions.js';

export interface TranslateSink {
  emit(event: Omit<BridgeEvent, 'id' | 'created'> & { created?: number }): BridgeEvent;
}

interface StreamPartState {
  partId: string;
  text: string;
}

/** Mirrors the single agent `/api/agent` advertises (ACP has no agent list). */

export class AcpTranslator {
  /** Per session+message+kind cursor for the currently open streaming part. */
  private readonly openParts = new Map<string, StreamPartState>();
  /** Latest ACP usage per session, replayed on `session.step.ended`. */
  private readonly lastTokens = new Map<string, { input: number; output: number; reasoning: number; cache: { read: number; write: number } }>();
  /** Context window the agent reported (`usage_update.size`), per session. */
  private readonly lastContextSize = new Map<string, number>();
  /** Cumulative session cost, USD only (see applyUsage). */
  private readonly lastCost = new Map<string, number>();
  /** Sessions that have reported per-turn `PromptResponse.usage` (cumulative in `record.session.tokens`). */
  private readonly hasPromptUsage = new Set<string>();
  /** toolCallId → part id, so updates target the same card. */
  private toolNames = new Map<string, string>();
  private toolInputs = new Map<string, unknown>();
  private readonly toolParts = new Map<string, string>();
  /**
   * Delegated runs per root session: the child's progress and the card that reports it.
   * Fed by `opencode/session/child_update`; see `applyChildUpdate`.
   */
  private readonly children = new Map<string, Map<string, ChildProgress>>();
  /** The `task` card each child belongs to, and the description the agent gave it. */
  private readonly childCards = new Map<string, { callId: string; original: string }>();
  /**
   * The metadata a `task` card must keep. `session.tool.success` rewrites a row's metadata
   * from `toolMetadata(update)` — which is `{}` for an ACP frame with no `rawOutput.metadata`
   * — so the delegated run's state would be wiped the moment the card completes, taking the
   * client's `Background` badge with it. Merged back in at that point.
   */
  private readonly childMeta = new Map<string, Record<string, unknown>>();
  /** Provisional assistant message id per session for the current turn. */
  private readonly activeMessage = new Map<string, string>();
  /** Assistant rows whose `session.step.started` has been emitted. */
  private readonly stepEmitted = new Set<string>();
  /** Prompt dispatch time per session, used as the step's `started`. */
  private readonly turnStartedAt = new Map<string, number>();

  constructor(
    private readonly state: BridgeState,
    private readonly sink: TranslateSink,
    private readonly location: Location,
    private readonly log: (line: string) => void = () => {},
    /** `initialize`'s `agentInfo.name`; opencode wants a name, not ours to invent. */
    private agentName: string = 'acp',
    /**
     * Called when the AGENT announces a title (`session_info_update`). The bridge
     * persists it: the title is bidirectional (derived, agent, user), and the map must
     * hold the latest name so a restore shows it. Optional so the translator stays
     * usable without a map (tests).
     */
    private readonly onTitle?: (record: SessionRecord) => void,
  ) {}

  /**
   * Name the agent on rows created from now on.
   *
   * Needed because a translator can be created BEFORE its agent: a turn that could
   * not start still renders its own failure, and it has no `agentInfo.name` to use
   * yet (it reports the placeholder). Without this, every later row in that session
   * — after a retry succeeded — kept saying `acp` in the footer instead of the
   * agent's real name.
   */
  /**
   * Fold one event of a delegated run into the card that reports it.
   *
   * Two slots, both measured against opencode's `Subagent` component:
   *   • the caption — `input.description`, re-sent with `session.tool.called`, because the
   *     row's title is the only free text the client renders;
   *   • the `Background` badge — `metadata.status`, sent with `session.tool.progress`.
   *     The client shows it when the card is `completed` while `metadata.status` is
   *     `running` (`isBackgroundSubagent`), which is exactly a delegated run that
   *     returned its card and kept working.
   *
   * The card is matched by the CHILD's title against a `task` call whose input names it,
   * or — when only one task is open — by that one. An unmatched child keeps accumulating
   * progress and is applied as soon as a card appears.
   */
  applyChildUpdate(record: SessionRecord, event: ChildSessionEvent): void {
    const rootId = record.session.id;
    const byChild = this.children.get(rootId) ?? new Map<string, ChildProgress>();
    this.children.set(rootId, byChild);
    const known = typeof event.childSessionId === 'string' ? byChild.get(event.childSessionId) : undefined;
    const progress = applyChildEvent(known, event);
    if (!progress) return;
    byChild.set(progress.childSessionId, progress);

    const card = this.childCard(rootId, progress);
    if (!card) return;

    const caption = childCaption(progress);
    const text = caption ? `${card.original} (${caption})` : card.original;
    const input = this.toolInputs.get(card.callId);
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      (input as Record<string, unknown>)['description'] = text;
    }
    const partId = this.toolParts.get(card.callId);
    const messageId = this.activeMessage.get(record.session.id);
    if (!partId || !messageId) return;
    this.sink.emit({
      type: EVENT.toolCalled,
      data: {
        sessionID: record.session.id,
        assistantMessageID: messageId,
        id: partId,
        input: input ?? {},
        executed: true,
        state: undefined,
      },
      location: this.location,
    });
    // The `Background` badge. `tool.progress` only rewrites `metadata` while the client
    // thinks the row is running, so this is what keeps a returned card marked as busy.
    const nextMeta = {
      ...(this.childMeta.get(card.callId) ?? {}),
      status: isStillRunning(progress) ? 'running' : 'completed',
      subagent: progress.childSessionId,
    };
    this.childMeta.set(card.callId, nextMeta);
    // The projection reads the STORED part, not the event stream: updating only the sink
    // would leave `/api/session/:id/message` (and a reloaded transcript) without it.
    this.updateToolMetadata(record, card.callId, partId, messageId, nextMeta);
    this.sink.emit({
      type: EVENT.toolProgress,
      data: {
        sessionID: record.session.id,
        assistantMessageID: messageId,
        id: partId,
        metadata: { status: isStillRunning(progress) ? 'running' : 'completed', subagent: progress.childSessionId },
      },
      location: this.location,
    });
  }

  /** Replace the metadata of a stored tool part, keeping everything else. */
  private updateToolMetadata(
    record: SessionRecord,
    callId: string,
    partId: string,
    messageId: string,
    metadata: Record<string, unknown>,
  ): void {
    const part = this.state.partsOf(record, messageId).find((candidate) => candidate.id === partId);
    if (!part || part.type !== 'tool') return;
    const updated: Part = { ...part, state: { ...part.state, metadata } };
    this.state.upsertPart(record, messageId, updated);
    this.emitPartUpdated(record, messageId, updated);
    void callId;
  }

  /** Which `task` card reports this child. */
  private childCard(rootId: string, progress: ChildProgress): { callId: string; original: string } | undefined {
    const mapped = this.childCards.get(`${rootId}:${progress.childSessionId}`);
    if (mapped) return mapped;
    const open: Array<{ callId: string; original: string }> = [];
    for (const [callId, name] of this.toolNames) {
      if (name !== 'task') continue;
      const input = this.toolInputs.get(callId) as { description?: unknown; agent?: unknown } | undefined;
      const original = typeof input?.description === 'string' ? input.description : '';
      // A title the agent put on both the card and the child is the strongest link.
      if (progress.title && original.toLowerCase().includes(progress.title.toLowerCase())) {
        const entry = { callId, original };
        this.childCards.set(`${rootId}:${progress.childSessionId}`, entry);
        return entry;
      }
      open.push({ callId, original });
    }
    // Exactly one open task: it has to be the one. More than one and we would be guessing,
    // so the progress waits for a title match instead of landing on the wrong card.
    if (open.length === 1) {
      const entry = open[0]!;
      this.childCards.set(`${rootId}:${progress.childSessionId}`, entry);
      return entry;
    }
    return undefined;
  }

  setAgentName(name: string | undefined): void {
    // `acp` is this translator's own placeholder and `unknown` is what an agent that
    // reported nothing gets: neither may overwrite a real name.
    if (!name || name === 'acp' || name === 'unknown') return;
    this.agentName = name;
  }

  /**
   * While muted, `apply` drops every update. The one caller is the `/cd` re-load: the
   * agent re-delivers the whole conversation over `session/load`, and those frames are
   * the very rows the live transcript already holds. Without the mute they would pass
   * through `ensureMessage` (apply() creates an assistant row when none is active) and
   * render the entire history a second time.
   */
  private muted = false;

  mute(): void {
    this.muted = true;
  }

  unmute(): void {
    this.muted = false;
  }

  /** Called when a prompt starts: opens the assistant message for the turn. */
  beginTurn(record: SessionRecord): string {
    // A fresh turn is neither cancelled nor interrupted until it says so.
    record.interruptRequested = false;
    const messageId = this.state.newId('msg');
    const message: Message = {
      id: messageId,
      sessionID: record.session.id,
      role: 'assistant',
      time: { created: Date.now() },
    };
    this.state.addMessage(record, message);
    this.activeMessage.set(record.session.id, messageId);
    this.turnStartedAt.set(record.session.id, Date.now());
    this.stepEmitted.delete(messageId);
    record.busy = true;
    this.openParts.clear();
    this.toolParts.clear();

    this.sink.emit({
      type: EVENT.turnWait,
      data: { sessionID: record.session.id },
      location: this.location,
    });
    this.sink.emit({
      type: EVENT.sessionStatus,
      data: { sessionID: record.session.id, status: 'busy' },
      location: this.location,
    });
    this.sink.emit({
      type: EVENT.messageUpdated,
      data: { sessionID: record.session.id, messageID: messageId, role: 'assistant' },
      location: this.location,
    });
    // The assistant row is created by `ensureStep()` on the FIRST visible part,
    // not here: emitting it at prompt acceptance painted an empty row before the
    // agent had produced anything (the extra blank line before the first reply).
    this.sink.emit({
      type: EVENT.executionStarted,
      data: { sessionID: record.session.id },
      location: this.location,
    });
    return messageId;
  }

  /** Emit `session.step.started` exactly once, immediately before the first part. */
  private ensureStep(record: SessionRecord, messageId: string): void {
    if (this.stepEmitted.has(messageId)) return;
    this.stepEmitted.add(messageId);
    this.sink.emit({
      type: EVENT.stepStarted,
      data: {
        sessionID: record.session.id,
        assistantMessageID: messageId,
        agent: this.agentName,
        started: this.turnStartedAt.get(record.session.id) ?? Date.now(),
        model: record.model
          ? { id: record.model.modelID, providerID: record.model.providerID }
          : { id: 'unknown', providerID: 'acp' },
      },
      location: this.location,
    });
  }

  /** Called when the prompt settles (normal or cancelled). */
  endTurn(record: SessionRecord, opts: { error?: string; interrupted?: boolean } = {}): void {
    const messageId = this.activeMessage.get(record.session.id);
    if (messageId) this.ensureStep(record, messageId);
    // A tool the agent never reported on must not outlive the turn: the UI shows
    // a spinner for as long as the row says "running", and nothing else will ever
    // update it once the turn is over.
    this.closeOpenToolCalls(record, 'the turn ended before this tool reported a result');
    // Close any part left open — an unclosed reasoning part is a stuck spinner.
    if (messageId) {
      // Close through the same path a tool boundary uses. The first version of this loop closed
      // the stored part but emitted no `session.text.ended` here; a separate block then sent one
      // `text.ended`/`reasoning.ended` taken from the *first* part of each kind. With more than
      // one text part in a turn (intro, tools, summary) that event carried the intro while the
      // client applies it to the *last* text entry, so the summary was overwritten with the intro
      // and the screen showed the intro twice. Reusing closeOpenTextParts emits the event with the
      // text of the part it actually closes.
      this.closeOpenTextParts(record, messageId);
      const message = this.state.getMessage(record, messageId);
      if (message) {
        if (opts.error) {
          message.error = { name: 'AcpError', message: opts.error };
        }
        message.time = { ...message.time, completed: Date.now() };
        this.sink.emit({
          type: EVENT.messageUpdated,
          data: { sessionID: record.session.id, messageID: messageId, completed: true },
          location: this.location,
        });
      }
    }

    // Close the v2 execution envelope. The text/reasoning `ended` events were emitted by
    // closeOpenTextParts above, each carrying the text of the part it closed.
    const finishing = messageId ? this.state.getMessage(record, messageId) : undefined;
    // `session.step.ended` is what puts cost/tokens on the assistant row; the
    // sidebar's context meter reads them from there and shows nothing without
    // them. `finish` mirrors the ACP stop reason.
    if (messageId) {
      const tokens = this.lastTokens.get(record.session.id) ?? {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      };
      const step = opts.error ? EVENT.stepFailed : EVENT.stepEnded;
      this.sink.emit({
        type: step,
        data: opts.error
          ? {
              sessionID: record.session.id,
              assistantMessageID: messageId,
              error: { name: 'AcpError', message: opts.error },
              finish: 'error',
            }
          : {
              sessionID: record.session.id,
              assistantMessageID: messageId,
              finish: 'stop',
              cost: this.lastCost.get(record.session.id) ?? 0,
              tokens,
            },
        location: this.location,
      });
    }
    if (finishing) {
      // Three outcomes, because the client's store switches on all three: it
      // flips a session from running to idle on any of them, but records the
      // matching `outcome` (`succeeded` / `failed` / `interrupted`). A cancelled
      // turn reported as `succeeded` shows up in the UI as one that finished on
      // its own — so the stop reason, not just "the turn ended", picks the event.
      const outcome = opts.error
        ? EVENT.executionFailed
        : opts.interrupted
          ? EVENT.executionInterrupted
          : EVENT.executionSucceeded;
      // ★ `session.execution.interrupted` REQUIRES a `reason`
      // (`sessionID` + `reason: user | shutdown | superseded | inactivity`).
      //
      // Only `sessionID` was sent, and the event was unusable: the client's handler branches on
      // `event.data.reason === "shutdown"`, so the field is part of the contract, not decoration.
      // Measured on a real session: the bridge logged `prompt settled stopReason="cancelled"`,
      // the turn ended and later Esc presses answered `{interrupted:false}` — all correct — while
      // the screen kept its spinner, so the user's verdict was "cancel does not work".
      //
      // `user` is the right reason for this path: it only fires because someone asked to stop.
      // The other outcomes carry an `error` instead and have no `reason` field.
      this.sink.emit({
        type: outcome,
        data:
          outcome === EVENT.executionInterrupted
            ? { sessionID: record.session.id, reason: 'user' }
            : { sessionID: record.session.id, error: opts.error },
        location: this.location,
      });
    }

    const completedAt = Date.now();
    record.busy = false;
    record.session.time = { ...record.session.time, updated: completedAt, idle: completedAt };
    record.session.outcome = opts.error
      ? 'failed'
      : opts.interrupted
        ? 'interrupted'
        : 'succeeded';
    this.sink.emit({
      type: EVENT.sessionIdle,
      data: { sessionID: record.session.id },
      location: this.location,
    });
    this.sink.emit({
      type: EVENT.turnIdle,
      data: { sessionID: record.session.id },
      location: this.location,
    });
    this.sink.emit({
      type: EVENT.sessionStatus,
      data: { sessionID: record.session.id, status: 'idle' },
      location: this.location,
    });
  }

  /** Handle one ACP `session/update`. */
  apply(record: SessionRecord, update: SessionUpdate): void {
    if (this.muted) return;
    // ACP reserves `_meta` for extensions. Merge it (never overwrite) so an
    // agent's keys survive, and keep it on the session: opencode's HTTP schemas
    // have no field for it, so it is preserved rather than either dropped or
    // invented into a surface that would ignore it.
    const meta = update['_meta'];
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      record.meta = { ...record.meta, ...(meta as Record<string, unknown>) };
    }
    const messageId = () => this.activeMessage.get(record.session.id) ?? this.ensureMessage(record);
    switch (update.sessionUpdate) {
      case UPDATE.agentMessageChunk:
        this.appendText(record, messageId(), update, 'text');
        return;
      case UPDATE.agentThoughtChunk:
        this.appendText(record, messageId(), update, 'reasoning');
        return;
      case UPDATE.userMessageChunk:
        // Already rendered when /prompt was accepted.
        return;
      case UPDATE.toolCall:
      case UPDATE.toolCallUpdate:
        this.applyToolCall(record, messageId(), update);
        return;
      case UPDATE.plan:
        this.applyPlan(record, update);
        return;
      case UPDATE.usageUpdate:
        this.applyUsage(record, update);
        return;
      case UPDATE.sessionInfoUpdate: {
        // The standard way a backend announces a session's title. It is the only
        // title source left now that the the backend projection store is not read; a
        // backend that never sends it leaves the directory basename in place.
        const title = typeof update['title'] === 'string' ? update['title'].trim() : '';
        if (!title || title === record.session.title) return;
        record.session.title = title;
        // Marks the title as the agent's: the derived fallback must never replace
        // it, and a later `session/list` lookup may refine it.
        record.titleFromAgent = true;
        this.onTitle?.(record);
        this.log(`title from the backend: ${title}`);
        this.sink.emit({
          type: EVENT.sessionUpdated,
          data: { session: record.session },
          location: this.location,
        });
        // The TUI's store has a case for `session.renamed` and none for
        // `session.updated`, so this is the frame that actually moves the title.
        this.sink.emit({
          type: EVENT.sessionRenamed,
          data: { sessionID: record.session.id, title },
          location: this.location,
        });
        return;
      }
      case UPDATE.availableCommandsUpdate:
      case UPDATE.currentModeUpdate:
        // Not surfaced yet; log so it is visible rather than silent.
        this.log(`ignoring ${update.sessionUpdate}`);
        return;
      default:
        this.log(`unknown session/update: ${update.sessionUpdate}`);
    }
  }

  /**
   * Mark every tool call of this session that has not finished as cancelled.
   *
   * ACP: "The Client **SHOULD** preemptively mark all non-finished tool calls
   * pertaining to the current turn as `cancelled` as soon as it sends the
   * `session/cancel` notification."
   *
   * opencode has no `cancelled` tool state, so the terminal state it does have is
   * used, carrying the reason as the tool's output. The point is the same either
   * way: a row must not be left spinning while it waits for an update that the
   * aborted turn will never send. Returns how many rows were closed.
   */
  /**
   * Close every tool call the agent left unfinished.
   *
   * Called on abort *and* at normal turn end: an agent may simply stop reporting
   * on a call, and a tool row that still says "running" after the turn is over is
   * a spinner that never stops. `reason` lands in the row's output, so the UI says
   * why rather than just going red.
   */
  closeOpenToolCalls(record: SessionRecord, reason: string): number {
    let cancelled = 0;
    for (const [messageId, parts] of record.parts) {
      for (const part of parts) {
        if (part.type !== 'tool') continue;
        if (part.state.status !== 'pending' && part.state.status !== 'running') continue;
        const output = reason;
        const updated: Part = {
          ...part,
          state: {
            ...part.state,
            status: 'error',
            // The reason goes in `error` (what the client paints), not `output`
            // (what the tool produced) — a cancelled `write` would otherwise show
            // the file's content as the reason.
            error: reason,
            output: part.state.output,
            time: { ...part.state.time, end: Date.now() },
          },
        };
        this.state.upsertPart(record, messageId, updated);
        this.emitPartUpdated(record, messageId, updated);
        this.sink.emit({
          type: EVENT.toolFailed,
          data: {
            sessionID: record.session.id,
            assistantMessageID: messageId,
            id: updated.id,
            executed: true,
            // Structured for the same reason as the failure event above.
            error: { type: 'tool', message: reason },
            metadata: {},
            // ★ No `content` at all — never `[]`. See `toolFailedContent`.
          },
          location: this.location,
        });
        cancelled += 1;
      }
    }
    return cancelled;
  }

  /**
   * ACP reports context usage as `{used, size}`. opencode tracks input/output
   * separately, so map `used` onto `input` and keep the rest zeroed rather than
   * inventing a split the agent never sent.
   */
  private applyUsage(record: SessionRecord, update: SessionUpdate): void {
    const used = typeof update.used === 'number' ? update.used : 0;
    const tokens = { input: used, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
    // `used` is tokens in context; `size` is the window the percentage is drawn
    // against. The TUI reads the window off the model's `limit.context`, so it is
    // kept per session for `modelCatalog()` to serve.
    if (typeof update.size === 'number' && update.size > 0) {
      this.lastContextSize.set(record.session.id, update.size);
    }
    // ★ A context count cannot exceed its window. opencode's ACP adapter sends
    // `used = input+output+reasoning+cache` for the whole agentic turn, which can
    // be several times the window; treating it as "context" made the TUI show
    // e.g. 3.0M (304%) for a 1M model. Keep the previous (plausible) row instead.
    const size = this.lastContextSize.get(record.session.id);
    if (size !== undefined && used > size) {
      this.log(
        `[bridge] usage_update used=${used} exceeds size=${size}; not a context count, keeping the previous usage`,
      );
      return;
    }
    // The cost travels as `{amount, currency}` and is CUMULATIVE for the session.
    // Our event field is a plain number; an amount in another currency would be a
    // wrong number, so only USD is carried (the honest part of a currency-blind field).
    const rawCost = update.cost;
    let cost = 0;
    if (rawCost && typeof rawCost === 'object' && !Array.isArray(rawCost)) {
      const amount = (rawCost as { amount?: unknown }).amount;
      const currency = (rawCost as { currency?: unknown }).currency;
      if (typeof amount === 'number' && (currency === undefined || String(currency).toUpperCase() === 'USD')) {
        cost = amount;
      }
    }
    this.lastCost.set(record.session.id, cost);
    record.session.cost = cost;
    // Remembered so `session.step.ended` can carry the same numbers when the agent
    // does not report `PromptResponse.usage`: the sidebar's context meter reads them
    // off the assistant row, not off `session.usage.updated`.
    this.lastTokens.set(record.session.id, tokens);
    // Once a session has accumulated real per-turn `PromptResponse.usage`, keep those
    // cumulative totals on `session.usage.updated` instead of letting a mid-turn
    // context snapshot (`used`, with `output`/`cache` zeroed) wipe `session.tokens`.
    const sessionTokens = this.hasPromptUsage.has(record.session.id)
      ? {
          input: record.session.tokens.input,
          output: record.session.tokens.output,
          reasoning: record.session.tokens.reasoning,
          cache: { read: record.session.tokens.cache.read, write: record.session.tokens.cache.write },
        }
      : tokens;
    if (!this.hasPromptUsage.has(record.session.id)) {
      record.session.tokens = {
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cache: { read: tokens.cache.read, write: tokens.cache.write },
      };
    }
    this.sink.emit({
      type: EVENT.sessionUsageUpdated,
      data: { sessionID: record.session.id, cost, tokens: sessionTokens },
      location: this.location,
    });
  }

  /** The context window the agent reported for this session, if it sent one. */
  contextWindowFor(sessionId: string): number | undefined {
    return this.lastContextSize.get(sessionId);
  }

  /**
   * Usage from the prompt RESULT rather than a `usage_update` frame.
   *
   * opencode reports `{inputTokens, outputTokens, thoughtTokens, cachedReadTokens}` in the
   * `session/prompt` response and never sends a `usage_update`; leaving the result's usage
   * unread made the sidebar's context meter (which reads tokens off `session.step.ended`)
   * and the footer show nothing. Call this before `endTurn`.
   */
  recordPromptUsage(record: SessionRecord, usage: unknown): void {
    if (!usage || typeof usage !== 'object') return;
    const raw = usage as {
      inputTokens?: unknown;
      outputTokens?: unknown;
      thoughtTokens?: unknown;
      cachedReadTokens?: unknown;
      cachedWriteTokens?: unknown;
    };
    const number = (value: unknown): number =>
      typeof value === 'number' && Number.isFinite(value) ? value : 0;
    const tokens = {
      input: number(raw.inputTokens),
      output: number(raw.outputTokens),
      reasoning: number(raw.thoughtTokens),
      cache: { read: number(raw.cachedReadTokens), write: number((raw as { cachedWriteTokens?: unknown }).cachedWriteTokens) },
    };
    if (
      tokens.input === 0 &&
      tokens.output === 0 &&
      tokens.reasoning === 0 &&
      tokens.cache.read === 0 &&
      tokens.cache.write === 0
    ) {
      return;
    }
    // Deliberate tradeoff (no separate bridge usage ledger): keep the agent's full
    // per-turn `PromptResponse.usage` on `session.step.ended` even when a multi-step
    // agentic turn's total exceeds the context window `size`. Dropping `total > size`
    // silently lost the heaviest turns from TUI usage plugins (e.g. CacheHit / Timeline);
    // the explicit tradeoff is that the built-in sidebar context meter may temporarily
    // show >100% until the next smaller turn settles.
    this.lastTokens.set(record.session.id, tokens);
    this.hasPromptUsage.add(record.session.id);
    // `session.usage.updated` carries the cumulative session aggregate (which TUI plugins
    // like CacheHit read via `session.get()`), while `session.step.ended` carries this turn.
    const nextSessionTokens = {
      input: record.session.tokens.input + tokens.input,
      output: record.session.tokens.output + tokens.output,
      reasoning: record.session.tokens.reasoning + tokens.reasoning,
      cache: {
        read: record.session.tokens.cache.read + tokens.cache.read,
        write: record.session.tokens.cache.write + tokens.cache.write,
      },
    };
    record.session.tokens = nextSessionTokens;
    this.sink.emit({
      type: EVENT.sessionUsageUpdated,
      data: {
        sessionID: record.session.id,
        cost: this.lastCost.get(record.session.id) ?? 0,
        tokens: {
          input: nextSessionTokens.input,
          output: nextSessionTokens.output,
          reasoning: nextSessionTokens.reasoning,
          cache: { read: nextSessionTokens.cache.read, write: nextSessionTokens.cache.write },
        },
      },
      location: this.location,
    });
  }

  // ---------------------------------------------------------------- internals

  private ensureMessage(record: SessionRecord): string {
    return this.beginTurn(record);
  }

  private textOf(update: SessionUpdate): string {
    const content = update['content'];
    if (typeof content === 'string') return content;
    // ★ 真实 ACP 形状：content 是【单个块对象】{type:'text', text} ✓
    //   少了这条就会静默返回空串 ✗ → part 永远不产生 ✗ → 界面一片空白 ✓
    //   （单元测试抓到的 ✓）
    if (content && typeof content === 'object' && !Array.isArray(content)) {
      const block = content as { type?: string; text?: string };
      if (typeof block.text === 'string') return block.text;
    }
    if (Array.isArray(content)) {
      return content
        .map((block) => {
          const b = block as { type?: string; text?: string };
          return b.type === 'text' && typeof b.text === 'string' ? b.text : '';
        })
        .join('');
    }
    if (typeof update['text'] === 'string') return update['text'];
    return '';
  }

  private closeOpenTextParts(
    record: SessionRecord,
    messageId: string,
    except?: 'text' | 'reasoning',
  ): void {
    const prefix = `${record.session.id}/${messageId}/`;
    for (const [key, open] of [...this.openParts]) {
      if (!key.startsWith(prefix)) continue;
      const kind = key.slice(prefix.length) as 'text' | 'reasoning';
      if (kind === except) continue;
      const existing = this.state.findPart(record, open.partId);
      if (existing && (existing.type === 'text' || existing.type === 'reasoning')) {
        existing.time = { ...existing.time, end: Date.now() };
        this.emitPartUpdated(record, messageId, existing);
        this.sink.emit({
          type: existing.type === 'text' ? EVENT.textEnded : EVENT.reasoningEnded,
          data:
            existing.type === 'text'
              ? { sessionID: record.session.id, assistantMessageID: messageId, text: existing.text }
              : { sessionID: record.session.id, assistantMessageID: messageId, text: existing.text },
          location: this.location,
        });
      }
      this.openParts.delete(key);
    }
  }

  private appendText(
    record: SessionRecord,
    messageId: string,
    update: SessionUpdate,
    kind: 'text' | 'reasoning',
  ): void {
    const text = this.textOf(update);
    if (!text) return;
    this.ensureStep(record, messageId);
    // A turn can end (prompt result) while the agent keeps streaming — dsh's
    // background jobs do exactly that. The late part belongs in the history, but
    // its `reasoning.started` would make the TUI show a "thinking" spinner on a
    // completed message, which then vanishes (reported 2026-10-20). Record it with
    // an end time and emit no reasoning UI events; late tool/text keep their
    // static-history behaviour.
    const late = !record.busy;
    this.closeOpenTextParts(record, messageId, kind);
    const key = `${record.session.id}/${messageId}/${kind}`;
    let open = this.openParts.get(key);
    if (!open) {
      open = { partId: this.state.newId('prt'), text: '' };
      this.openParts.set(key, open);
    }
    open.text += text;

    const part: Part =
      kind === 'text'
        ? {
            id: open.partId,
            sessionID: record.session.id,
            messageID: messageId,
            type: 'text',
            text: open.text,
            time: { start: Date.now() },
          }
        : {
            id: open.partId,
            sessionID: record.session.id,
            messageID: messageId,
            type: 'reasoning',
            text: open.text,
            // `late`: closed on arrival, so a reload renders it as static history
            // instead of an active Thought row.
            time: late ? { start: Date.now(), end: Date.now() } : { start: Date.now() },
          };

    const { created } = this.state.upsertPart(record, messageId, part);
    if (late && kind === 'reasoning') {
      if (created) this.log('[bridge] late reasoning recorded without a UI event (the turn has ended)');
      return;
    }
    if (!created) {
      // Delta first: the TUI appends from it and uses the full part to re-render.
      this.sink.emit({
        type: EVENT.messagePartDelta,
        data: {
          sessionID: record.session.id,
          messageID: messageId,
          partID: open.partId,
          field: kind === 'text' ? 'text' : 'reasoning',
          delta: text,
          time: Date.now(),
        },
        location: this.location,
      });
    }

    // opencode v2 events. `started` only on first sighting so the client
    // creates the assistant content block exactly once.
    if (created) {
      this.sink.emit({
        type: kind === 'text' ? EVENT.textStarted : EVENT.reasoningStarted,
        data: {
          sessionID: record.session.id,
          assistantMessageID: messageId,
          ...(kind === 'reasoning' ? { state: {} } : {}),
        },
        location: this.location,
      });
    }
    this.sink.emit({
      type: kind === 'text' ? EVENT.textDelta : EVENT.reasoningDelta,
      data: { sessionID: record.session.id, assistantMessageID: messageId, delta: text },
      location: this.location,
    });

    this.emitPartUpdated(record, messageId, part);
  }

  private applyToolCall(record: SessionRecord, messageId: string, update: SessionUpdate): void {
    this.ensureStep(record, messageId);
    const callId = String(update['toolCallId'] ?? '');
    if (!callId) return;

    // The tool NAME is fixed at first sighting ("shell", "websearch"): the TUI picks
    // the row component by it. A later title is the tool's argument ("echo hello"),
    // so letting it overwrite the name turned a shell card into an unknown tool.
    const knownName = this.toolNames.get(callId);
    // ACP's `name` is "the optional programmatic name of the invoked tool"
    // (`read_file`); `title` is prose ("Reading configuration file") and `kind` is the
    // category. The client picks the row component from this, so a bridge that sends
    // the title makes a `shell` row render as an unknown tool — "Writing command…".
    const reported = update['name'];
    const reportedName =
      typeof reported === 'string' && reported.length > 0
        ? reported
        : String(update['title'] ?? update['kind'] ?? 'tool');
    // ★ A delegated agent's card has to be recognisable as one.
    //
    // opencode's TUI renders a dedicated `Subagent` row — with a "Delegating…" pending
    // label and a click that opens the child — only when the tool name is `task`
    // (`canonicalToolName`: `if (name === "task") return "subagent"`). Everything else,
    // including ACP's own `kind: "think"`, falls through to the generic card, so a user
    // cannot tell a subagent from a shell command.
    //
    // Measured on every agent in our matrix, the word is the agent's OWN tool name:
    //   `dsh --profile acp`   no `name`, `title: "subagent"` (title falls back to the tool
    //                         name when there is no prose)
    //   `<profile>`          `name: "subagent"`
    //   `opencode acp`        no `name`, title falls back to its tool name (`"task"`)
    //   `claude-agent-acp`    `name: "Agent"` / `"Task"` (its renderer checks exactly these
    //                         two — `renderer.ts`, `toolUse.name === "Agent" || "Task"`)
    //   `codex-acp`           titles its subagent activity `Start subagent <name>` /
    //                         `Interact with subagent <name>` / `Interrupt …` / `Complete …`
    //                         (`SubagentActivityReporter.ts`), while `name` stays the
    //                         underlying tool (`exec_command`)
    // Everything else is a bare noun and is matched as such. `codex-acp` is the one shape
    // that has to be read out of the TITLE, and it is the ONE agent-gated branch in this
    // file: `title` is prose everywhere else, and another adapter writing
    // "Start subagent …" as a caption is not far-fetched. The gate uses the name the
    // agent reported in `initialize` — not the launch command — so it survives `npx`,
    // a local checkout path, or a wrapper script, and an adapter that renames itself is
    // still matched by the `codex` stem.
    const isCodex = /codex/i.test(this.agentName);
    // The title is checked on its own, not only when `name` is missing: `codex-acp`
    // sends `name: "exec_command"` WITH a subagent title, so a name-first chain would
    // never look at it. Gated on the agent name so no other adapter's prose is read.
    const title = typeof update['title'] === 'string' ? update['title'] : '';
    const looksLikeSubagent =
      SUBAGENT_NAME.test(reportedName) || (isCodex && SUBAGENT_VERB_TITLE.test(title));
    const name = knownName ?? (looksLikeSubagent ? 'task' : reportedName);
    if (knownName === undefined) this.toolNames.set(callId, name);

    // Merge the input instead of replacing it. opencode's pending frame often carries
    // only `{cwd}` and the command/query arrives with `in_progress`; publishing the
    // pending snapshot made the TUI show "Writing command…" / "Searching web…" even
    // after the tool finished (its row is only "complete" once input.command/query
    // exists).
    const raw = update['rawInput'];
    const previous = this.toolInputs.get(callId);
    const merged =
      raw === null || raw === undefined
        ? previous
        : typeof raw === 'object' && !Array.isArray(raw) && previous && typeof previous === 'object' && !Array.isArray(previous)
          ? { ...(previous as Record<string, unknown>), ...(raw as Record<string, unknown>) }
          : raw;
    // ACP's `rawInput` is free-form ("Any JSON value is accepted"), and the ACP `kind` is
    // what names the category — but opencode's TUI renders a tool from ITS OWN input field
    // names (`input.path` for read/edit, `input.command` for execute). An agent that says
    // `kind: "read"` with `{file_path: …}` is perfectly conformant and still rendered as an
    // empty "Preparing edit…"/"Reading file…" row, because `input.path` does not exist.
    // So: when `kind` tells us the category, add the key the client reads, taking the value
    // from whatever the agent did send. This looks at the AGENT'S KIND, never at a
    // particular agent's field names — `file_path`, `filePath`, `path` all work.
    const normalized =
      merged === undefined ? undefined : withClientInputKey(merged, update['kind'], update['title']);
    if (merged !== undefined) this.toolInputs.set(callId, merged);

    const partId = this.toolParts.get(callId);
    const existing = partId ? this.state.findPart(record, partId) : undefined;
    const lastInput = existing?.type === 'tool' ? existing.state.input : undefined;
    // ACP: "All fields except `toolCallId` are optional in updates. Only the fields being
    // changed need to be included", and its own example is that an omitted `name` leaves the
    // existing one unchanged. `status` on a `tool_call_update` is the same: omission means
    // "unchanged", NOT the `pending` default that applies to the initial `tool_call`.
    // Measured with `dsh --profile <profile>`, which sends the completed `rawInput` in a
    // frame with no `status` at all: resetting there moved every finished tool backwards,
    // back to the "Writing command…" placeholder with nothing to open.
    // ★ "absent" and "null" are different things in ACP. The spec's rule that
    // "omission and null are equivalent" is stated ONLY for `rawInput`/`rawOutput`; for every
    // other field an update means "only the fields being changed need to be included", so an
    // ABSENT key leaves the value alone while a present one — even `null` — replaces it.
    // Zed models this explicitly (`MaybeUndefined::{Undefined, Null, Value}` in
    // `acp/terminal_updates.rs`, pinned by `patch_preserves_omission_and_null`).
    // Testing `=== undefined` conflated the two.
    const namesStatus = Object.prototype.hasOwnProperty.call(update, 'status');
    const status =
      !namesStatus && existing?.type === 'tool' ? existing.state.status : mapToolStatus(update['status']);

    // A `pending` frame whose input is obviously partial (`{}` or only `cwd`) is a
    // placeholder: opencode fills in the command/query with the next update. Creating
    // the row now would freeze that placeholder into the TUI's card. Everything else
    // creates immediately — including a pending tool with no input at all, which has
    // nothing more to wait for.
    if (!existing && status === 'pending' && isPartialToolInput(merged)) return;

    let id = partId;
    if (!id) {
      this.closeOpenTextParts(record, messageId);
      id = this.state.newId('prt');
      this.toolParts.set(callId, id);
    }
    const part: Part = {
      id,
      sessionID: record.session.id,
      messageID: messageId,
      type: 'tool',
      callID: callId,
      tool: name,
      state: {
        status,
        input: merged,
        output: existing?.type === 'tool' ? existing.state.output : undefined,
        // A result frame says whether the call produced output or failed. ACP's
        // `rawOutput.error` is the failure sentence; keeping it apart from `output` is
        // what lets a reloaded failed call render as a failure (see `toolState`).
        ...(status === 'completed' ? { ...pickOutput(update) } : {}),
        ...(status === 'error' ? { error: toolError(update) ?? toolOutput(update) ?? 'tool failed' } : {}),
        // A delegated run's state rides on the card (`metadata.status` is what the client's
        // `Background` badge reads). Stored here so the projection and a reload keep it:
        // `session.tool.success` rewrites the row's metadata from `toolMetadata(update)`,
        // which is `{}` for an ACP frame, so it would otherwise be wiped on completion.
        metadata: {
          ...toolMetadata(update),
          ...(this.childMeta.get(callId) ?? {}),
          ...(existing?.type === 'tool' ? (existing.state.metadata ?? {}) : {}),
        },
        // The LATEST title, not the first: dsh's early frames carry a generic one
        // ("bash all commands") and the in_progress frame carries the real command.
        // Keeping the first froze the generic caption into the card and into the
        // reloaded projection.
        title:
          typeof update['title'] === 'string'
            ? update['title']
            : existing?.type === 'tool'
              ? existing.state.title
              : undefined,
        // ACP's `kind` decides the row's presentation for agents that never name the tool
        // (`execute` → shell card). Recorded once, from the first frame that has it.
        kind:
          typeof update['kind'] === 'string'
            ? update['kind']
            : existing?.type === 'tool'
              ? existing.state.kind
              : undefined,
        time: {
          start: existing?.type === 'tool' ? existing.state.time.start : Date.now(),
          ...(status === 'completed' || status === 'error' ? { end: Date.now() } : {}),
        },
      },
    };
    this.state.upsertPart(record, messageId, part);
    this.emitPartUpdated(record, messageId, part);

    // ---- opencode v2 tool events -------------------------------------------
    // The TUI builds tool rows exclusively from these. `input.started` is the
    // only one that creates the row, so it must be first and exactly once.
    if (!existing) {
      this.sink.emit({
        type: EVENT.toolInputStarted,
        data: { sessionID: record.session.id, assistantMessageID: messageId, id, name },
        location: this.location,
      });
      this.sink.emit({
        type: EVENT.toolInputEnded,
        data: {
          sessionID: record.session.id,
          assistantMessageID: messageId,
          id,
          text: typeof normalized === 'string' ? normalized : JSON.stringify(normalized ?? {}),
        },
        location: this.location,
      });
      this.sink.emit({
        type: EVENT.toolCalled,
        data: {
          sessionID: record.session.id,
          assistantMessageID: messageId,
          id,
          // The client stores `running`/`completed` inputs as a record and runs
          // `Object.entries` over it; `null`/`undefined` crashes the whole TUI
          // ("Object.entries requires that input parameter not be null or undefined").
          // A tool whose first frame carries no input still gets an empty record, and
          // the real input arrives (and replaces it) with the next update.
          input: normalized === undefined ? {} : normalized,
          executed: true,
          state: undefined,
        },
        location: this.location,
      });
    } else if (JSON.stringify(normalized ?? null) !== JSON.stringify(lastInput)) {
      // ★ The row was created with the input of its FIRST frame — and agents stream that
      // input. `dsh --profile <profile>` announces a bash call with
      // `rawInput: {arguments: '{"'}` and fills the command in over the following frames;
      // because `tool.called` was only ever sent for a NEW part, the client kept the empty
      // snapshot and showed "Writing command…" for a call that had long since finished
      // (measured: one `tool.called` per call, carrying `{"arguments": "{\""`).
      // Re-send it whenever the input actually changed: that is what the client re-reads.
      this.sink.emit({
        type: EVENT.toolCalled,
        data: {
          sessionID: record.session.id,
          assistantMessageID: messageId,
          id,
          input: normalized === undefined ? {} : normalized,
          executed: true,
          state: undefined,
        },
        location: this.location,
      });
    }
    // A finished call must end EVERY progress indicator, and the client's activity
    // summary ("Sending", the per-turn spinner and its "Sending · Ns" counter) only
    // goes quiet when `message.updated` says the message is completed. A failed tool is
    // finished exactly like a successful one: dsh's `Write` answers
    // `[tool error: FS_STALE_VERSION]`, and that turn then showed a spinner forever.
    // This does not excuse the turn — `executionStarted` already marked the session
    // busy, and `endTurn` sets the real end time and the outcome.
    if (status === 'completed' || status === 'error') {
      const message = this.state.getMessage(record, messageId);
      if (message && message.time.completed === undefined) {
        message.time = { ...message.time, completed: Date.now() };
        this.sink.emit({
          type: EVENT.messageUpdated,
          data: { sessionID: record.session.id, messageID: messageId, completed: true },
          location: this.location,
        });
      }
    }

    const toolResult = part.type === 'tool' ? part.state.output : undefined;
    if (status === 'completed') {
      this.sink.emit({
        type: EVENT.toolSuccess,
        data: {
          sessionID: record.session.id,
          assistantMessageID: messageId,
          id,
          executed: true,
          metadata: { ...toolMetadata(update), ...(this.childMeta.get(String(update['toolCallId'] ?? '')) ?? {}) },
          // `content` is REQUIRED here and must be non-empty (`Schema.NonEmptyArray`), so a tool
          // that produced nothing still gets one empty text entry instead of `[]`.
          content: [{ type: 'text', text: displayText(toolResult) ?? '' }],
          resultState: undefined,
        },
        location: this.location,
      });
    } else if (status === 'error') {
      this.sink.emit({
        type: EVENT.toolFailed,
        data: {
          sessionID: record.session.id,
          assistantMessageID: messageId,
          id,
          executed: true,
          // A STRUCTURED error, not a string: opencode v2's tool part declares
          // `state.error: SessionError.Error` = `{type, message}`, and its `InlineTool`
          // renders `stripAnsi(props.part.state.error.message)`. A bare string there made
          // that read `undefined` and the whole TUI died with
          // "Expected a `string`, got `undefined`" the moment any tool failed.
          // ★ Never `String(anObject)`. `part.state.output` is the tool's RAW output, which
          // is frequently a record (`{formatted_output, exit_code}` from a shell, a JSON error
          // body from a backend), and `String({})` is the literal text "[object Object]" —
          // which is what a user saw on a failed tool card. `displayText` keeps a string as it
          // is and serialises anything else; the fallback only applies when there is nothing.
          error: { type: 'tool', message: toolError(update) ?? displayText(toolResult) ?? 'tool failed' },
          metadata: toolMetadata(update),
          ...toolFailedContent(part.type === 'tool' ? part.state.error : undefined),
        },
        location: this.location,
      });
    }
  }

  /**
   * ACP `plan` updates have nowhere to go. opencode v2 removed todo entirely
   * (PR #35989: tool, sidebar panel, events and the persisted table, with no
   * stated replacement), so there is no event to emit and no route to serve. The
   * entries are logged rather than dropped silently.
   */
  private applyPlan(record: SessionRecord, update: SessionUpdate): void {
    const entries = update['entries'];
    if (!Array.isArray(entries)) return;
    const todos = entries.map((entry) => {
      const e = entry as { content?: string; status?: string };
      return `${String(e.status ?? 'pending')}:${String(e.content ?? '')}`;
    });
    this.log(
      `[bridge] ACP plan update (${todos.length} entries) has no opencode v2 surface: ${todos.join(' | ')}`,
    );
  }

  private emitPartUpdated(record: SessionRecord, messageId: string, part: Part): void {
    const time = Date.now();
    this.sink.emit({
      type: EVENT.messagePartUpdated,
      data: { sessionID: record.session.id, messageID: messageId, part, time },
      location: this.location,
    });
    // Frames stamped `time.now()` are what fill the client's "Sending · Ns" counter.
    // Every part update is a frame, so an unstamped one leaves that counter spinning
    // at whatever it last read; the stale-tool case below depends on it stopping.
    this.sink.emit({ type: EVENT.sessionTimeUpdated, data: { sessionID: record.session.id, time }, location: this.location });
    this.state.touch(record.session.id);
  }
}

/**
 * ACP statuses are free-form strings in practice. Map conservatively: an
 * unknown status becomes `running`, never `completed`, so the UI keeps showing
 * activity instead of claiming a tool finished when it did not.
 */
/**
 * Is this input obviously a placeholder? opencode's pending frame carries `{}` (or
 * only `{cwd}`) and the command/query arrives with `in_progress`; publishing the
 * placeholder is what pinned every shell card to "Writing command…".
 *
 * `undefined` is NOT partial: a tool that never sends an input has nothing to wait
 * for.
 */
export function isPartialToolInput(input: unknown): boolean {
  if (input === undefined || input === null) return false;
  if (typeof input === 'string') return input.trim() === '';
  if (Array.isArray(input)) return false;
  if (typeof input === 'object') {
    const keys = Object.keys(input as Record<string, unknown>);
    if (keys.length === 0) return true;
    return keys.every((key) => key === 'cwd' || key === 'workdir');
  }
  return false;
}

/** `rawOutput.metadata` is where the agent puts `{exit, truncated, status}`. */
export function toolMetadata(update: SessionUpdate): Record<string, unknown> {
  const raw = update['rawOutput'];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const meta = (raw as { metadata?: unknown }).metadata;
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) return meta as Record<string, unknown>;
  }
  return {};
}

/** `rawOutput.error` is the agent's own reason a tool failed. */
/** The text a completed call produced, if this frame carries it. */
function pickOutput(update: SessionUpdate): { output?: string } {
  const output = toolOutput(update);
  return output === undefined ? {} : { output };
}

/**
 * The `content` field of a `session.tool.failed` event: present only when there is something
 * to put in it.
 *
 * ★ `[]` is not a legal value. The spec declares `content` a `NonEmptyArray(Tool.Content)`
 * (`minItems: 1`; optional on `failed`, required on `success`), and opencode v2.3's client
 * acts on that: with image preview off — the default — it rewrites tool content through
 * `[r(n[0]), ...n.slice(1).map(r)]`, and `r` reads `n[0].type`. On `[]` that is
 * `undefined.type`, the handler throws (`TypeError: undefined is not an object (evaluating
 * 'd.type')`, logged by the TUI as an uncaught exception), and every later event in the
 * same dispatch — including `session.execution.interrupted`, which is what clears the
 * spinner — is lost. Measured: double-Esc on a turn with a shell tool in flight left the
 * prompt footer on `esc interrupt` and the tool row spinning, while the bridge had closed
 * the turn and `/api/session/active` was empty.
 */
function toolFailedContent(text: string | undefined): { content?: Array<{ type: 'text'; text: string }> } {
  return text ? { content: [{ type: 'text', text }] } : {};
}

/**
 * A human-readable string for a tool's raw output.
 *
 * `String(value)` is wrong for anything but a primitive: the bridge's tool output is often an
 * object (`{formatted_output, exit_code}`), and the user saw exactly `[object Object]` on a
 * failed card. JSON keeps the fields visible; an empty object yields undefined so the caller's
 * own fallback applies instead of a meaningless `{}`.
 */
function displayText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const text = JSON.stringify(value);
    if (text && text !== '{}' && text !== '[]') return text;
  } catch {
    /* a cyclic record cannot be rendered */
  }
  return undefined;
}

export function toolError(update: SessionUpdate): string | undefined {
  const raw = update['rawOutput'];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const error = (raw as { error?: unknown }).error;
    if (typeof error === 'string' && error.length > 0) return error;
  }
  return undefined;
}

/**
 * Add the input key the opencode TUI reads, using ACP's `kind` to decide which one.
 *
 * ACP declares `rawInput` as "any JSON value" and gives `kind` as the display category, so
 * an agent may name its file argument anything. The TUI, meanwhile, renders `read`/`edit`
 * rows from `input.path` and a shell row from `input.command`. Without this bridge an agent
 * that follows the spec shows up as an empty "Reading file…" / "Preparing edit…" row, which
 * is exactly what a `{file_path}`-shaped agent produced (measured on v2.2.0).
 *
 * Only ADDS keys; never overwrites what the agent sent, and never guesses without a `kind`.
 */
export function withClientInputKey(input: unknown, kind: unknown, title: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  const k = typeof kind === 'string' ? kind.toLowerCase() : '';
  const t = typeof title === 'string' ? title.toLowerCase() : '';
  const wantsPath = ['read', 'edit', 'delete', 'move', 'write'].includes(k) || ['read', 'edit'].includes(t);
  if (wantsPath && typeof record['path'] !== 'string') {
    const path = firstPathLike(record);
    if (path) return { ...record, path };
  }
  if ((k === 'execute' || t === 'bash' || t === 'shell') && typeof record['command'] !== 'string') {
    const command = firstCommand(record);
    if (command) return { ...record, command };
  }
  return input;
}

/**
 * The value that can stand in for `input.command`, or undefined while it is still streaming.
 *
 * An agent may announce a tool with its arguments half-arrived — measured with
 * `dsh --profile <profile>`, whose first `tool_call` for a bash tool carried
 * `rawInput: {arguments: '{"'}` and filled the rest in on the following update. Taking the
 * first string there put `{"` on screen as the command, which is the `$ {` the owner saw.
 * So a value that is an unfinished JSON fragment (`{`, `[`, or a string that will not parse
 * as an object of arguments) is skipped rather than displayed.
 */
function firstCommand(record: Record<string, unknown>): string | undefined {
  for (const value of Object.values(record)) {
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    if (looksLikeJsonFragment(value)) continue;
    return value;
  }
  return undefined;
}

/** A string that is (or may still become) a serialized argument object, not a command. */
function looksLikeJsonFragment(value: string): boolean {
  const head = value.trimStart();
  if (head.startsWith('{') || head.startsWith('[')) return true;
  return false;
}

/** The first value that looks like a filesystem path, whatever key the agent used. */
function firstPathLike(record: Record<string, unknown>): string | undefined {
  for (const value of Object.values(record)) {
    if (typeof value === 'string' && /^(?:\/|~\/|\.{1,2}\/)/.test(value) && value.length > 1) return value;
  }
  return undefined;
}

/**
 * ACP: a `tool_call`'s status "defaults to `pending`", while on a `tool_call_update` an
 * omitted field means "unchanged" (the caller keeps the previous state and never asks here).
 */
export function mapToolStatus(status: unknown): 'pending' | 'running' | 'completed' | 'error' {
  switch (String(status ?? '').toLowerCase()) {
    case 'pending':
      return 'pending';
    case 'completed':
    case 'success':
      return 'completed';
    case 'failed':
    case 'error':
      return 'error';
    case 'in_progress':
    case 'running':
      return 'running';
    // Not a status ACP defines on the wire (tool calls are pending / in_progress /
    // completed / failed), but agents do send it, and the old default made it
    // 'running' — a spinner that never stops.
    case 'cancelled':
    case 'canceled':
      return 'error';
    // ACP's stated default for a `tool_call` that names no status.
    default:
      return 'pending';
  }
}

/** Best-effort extraction of a tool's textual result from an ACP update. */
/** The tool names agents use for a delegated agent, as measured (see `applyToolCall`). */
const SUBAGENT_NAME = /^(subagents?|task|agent)$/i;
/** `codex-acp` verb-prefixes its subagent activity instead of naming the tool. */
const SUBAGENT_VERB_TITLE = /^(start|interact with|interrupt|complete) subagent\b/i;

export function toolOutput(update: SessionUpdate): string | undefined {
  // ★ Order and shape follow Zed, which is what the ecosystem is actually debugged
  // against (`crates/acp_thread/src/acp_thread.rs`):
  //
  //   1. the negotiated `_meta.terminal_output` dialect — the only place a *finished*
  //      command's text arrives from agents that use it (`CLIENT_CAPABILITIES` announces
  //      the key; the agent switches dialect on it), and
  //   2. `content`, because ACP defines it as the blocks shown to the user — Zed stops
  //      looking at `rawOutput` entirely once any `content` exists, and
  //   3. `rawOutput` last, pretty-printed when it is a record. Zed's `raw_output_text`
  //      does exactly that (`to_string_pretty`) instead of guessing at field names, so an
  //      agent that only sends `{output, isError}` still renders something legible
  //      without this bridge having to know any agent's private shape.
  const meta = update['_meta'] as
    | { terminal_output?: { data?: unknown }; terminal_output_delta?: { data?: unknown } }
    | undefined;
  const negotiated = meta?.terminal_output?.data ?? meta?.terminal_output_delta?.data;
  if (typeof negotiated === 'string' && negotiated.length > 0) return negotiated;

  const content = update['content'];
  if (Array.isArray(content)) {
    const text = content
      .map((block) => {
        const b = block as { type?: string; text?: string; content?: { text?: string } };
        if (typeof b.text === 'string') return b.text;
        if (b.content && typeof b.content.text === 'string') return b.content.text;
        return '';
      })
      .join('');
    if (text) return text;
  }

  const raw = update['rawOutput'];
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    // Indented, not one line: the TUI collapses a card's output to a handful of rows, so
    // structure costs nothing on screen and a single 300-character line is unreadable.
    try {
      return JSON.stringify(raw, null, 2);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
