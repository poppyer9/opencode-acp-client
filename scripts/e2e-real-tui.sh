#!/usr/bin/env bash
#
# Acceptance test with the REAL opencode TUI.
#
# Contract/trigger: the shipped opencode v2 TUI, driven by keystrokes in tmux,
#   against the bridge and the fake agent. Run for every change that can reach
#   the rendering path (translator, projection, routes, SSE vocabulary).
# Boundary: packaged TUI binary -> HTTP/SSE -> bridge -> ACP stdio -> fake agent.
#   Nothing here mocks the bridge: the screen is the oracle.
# Oracles: `tmux capture-pane` text (not JSON), plus the bridge log for what the
#   TUI actually sent, plus the HTTP endpoints the TUI reads back (active,
#   pending permission/form). A step passes only when the screen shows it.
# Negative controls: no `UnexpectedStatus` in the pane, no form or permission
#   left pending, no stale row after reopen, and "not offered" is a skip with
#   the captured pane as evidence — never counted as a pass.
#
# The one path that has no live events to help is **history**: opening a session
# again reads `GET /api/session/:id/message` and nothing else. That is where our
# legacy `{info, parts}` projection rendered an empty transcript, so this script
# measures exactly that:
#
#   1. start the adapter server-only (starting the TUI here would tie our own
#      lifetime to it)
#   2. drive the real TUI to send one prompt, and check it rendered
#   3. kill that TUI, start a second one with `--session <id>`
#   4. PASS = the second pane shows the earlier exchange (user line + reply)
#
# Usage:
#   bash scripts/e2e-real-tui.sh
#   OC=/path/to/opencode PORT=4811 bash scripts/e2e-real-tui.sh
#   MODE=cancel ... bash scripts/e2e-real-tui.sh     # the cancel gesture instead
#
# Needs tmux and the opencode TUI (v2+). No model tokens are spent: the agent is
# the fake one in tests/, and the turn it drives is deliberately a *rich* one —
# reasoning, a tool call with input and output, and a reply — because that is what
# the interface has to survive, and because a new opencode release is exactly when
# the rendering layer is most likely to break.
#
# It asserts what is **on the screen**, not what we sent: the user's row, the
# reasoning block, the tool card, the reply, and the agent/model we project into
# the footer. Each captured pane is also written to `$ARTIFACTS_DIR` (default
# `.artifacts/`) so a human can look at what a given opencode version actually
# rendered, and so the release watcher leaves the evidence behind.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OC="${OC:-$HOME/.opencode/bin/opencode}"
# ★ Pick a FREE port instead of a fixed 4811. A stale bridge from an earlier run that was
# killed before its cleanup (or a crashed run) keeps 4811 listening; the new bridge then dies
# with EADDRINUSE, `/api/info` answers from the OLD bridge, and every symptom points at this
# run: "adapter is up" passes, the TUI connects to something, and the pane shows a session
# from another workspace while `bridge.log` in ours stays 0 bytes. Measured repeatedly — it is
# the single most confusing failure this script can produce.
if [ -z "${PORT:-}" ]; then
  for _try in $(seq 1 50); do
    PORT=$((4800 + RANDOM % 400))
    lsof -i ":$PORT" >/dev/null 2>&1 || break
  done
fi
PORT="${PORT:-4811}"
MODE="${MODE:-history}"
# Cancel mode needs a turn that never ends by itself, or the client's interrupt
# command is disabled and no gesture can produce a request. (Getting this wrong is
# how an earlier version of this script "proved" that Escape does nothing.)
if [ "$MODE" = "cancel" ]; then
  # ★ FAKE_ACP_HANG_TOOL=1: a shell tool is in flight when the turn is cancelled, and its own
  # `failed` update arrives AFTER the cancel — what dsh does. Without the tool this mode passed
  # while the real session's spinner never stopped: an empty `content: []` on the tool event
  # threw inside opencode v2.3's client and swallowed `session.execution.interrupted`.
  FAKE_ENV="${FAKE_ENV:-FAKE_ACP_HANG=1 FAKE_ACP_HANG_TOOL=1 FAKE_ACP_MODELS=1}"
elif [ "$MODE" = "form" ]; then
  # The agent asks for structured input and waits; the turn can only finish if
  # the answer really got back to it.
  FAKE_ENV="${FAKE_ENV:-FAKE_ACP_SCENARIO=elicit-form FAKE_ACP_MODELS=1}"
elif [ "$MODE" = "permission" ]; then
  # The agent asks and *waits*, so the turn can only finish if the keystrokes
  # actually reached it — that is what makes this a test of the dialog rather
  # than of our own event stream.
  FAKE_ENV="${FAKE_ENV:-FAKE_ACP_PERMISSION=allow FAKE_ACP_MODELS=1}"
elif [ "$MODE" = "restore-turn" ]; then
  # Same prerequisite as restore-tab (the agent must be able to load and replay), plus a tool the
  # second turn can run. `FAKE_ACP_TOOL=1` makes the fixture emit a `tool_call` + update for the
  # prompt, which is what must survive onto the screen after a restart.
  FAKE_ENV="${FAKE_ENV:-FAKE_ACP_MODELS=1 FAKE_ACP_CAPS_LOAD_SESSION=1 FAKE_ACP_REPLAY_ON_LOAD=1 FAKE_ACP_REPLY=PONG_FROM_AGENT FAKE_ACP_TOOL=1}"
  # The fixture's load replays the assistant text only, not the user row (measured on screen);
  # a real agent replays the conversation it recorded, so override with REPLAY_TEXT= for AGENT=.
  REPLAY_TEXT="${REPLAY_TEXT:-replayed-from-agent}"
elif [ "$MODE" = "restore-tab" ]; then
  # Restoring through the session list is only possible when the agent advertises
  # `session/load` *and* replays something on it. Measured both ways: with the plain fixture the
  # bridge answered `NOT resumed: agent does not advertise session/load` and the reopened tab was
  # blank, so a test that forgot this would assert "the transcript is empty" and call it a pass.
  # An explicit reply, distinct from the prompt: the default echoes the prompt back, so an
  # assertion on it could be satisfied by the user's own row.
  FAKE_ENV="${FAKE_ENV:-FAKE_ACP_MODELS=1 FAKE_ACP_CAPS_LOAD_SESSION=1 FAKE_ACP_REPLAY_ON_LOAD=1 FAKE_ACP_REPLY=RESTORED_REPLY}"
  # The reply the first run must render. `REPLY_TEXT` defaults to the generic fixture reply used by
  # the other modes, so pin it to this mode's own unless the caller set it (AGENT= runs do).
  REPLY_TEXT="${REPLY_TEXT:-RESTORED_REPLY}"
  # What the reopened tab must show. The fixture replays a fixed string; a real agent replays the
  # conversation it recorded, so override with REPLAY_TEXT= when driving AGENT=.
  REPLAY_TEXT="${REPLAY_TEXT:-replayed-from-agent}"
elif [ "$MODE" = "unsupported-verb" ]; then
  FAKE_ENV="${FAKE_ENV:-FAKE_ACP_MODELS=1 FAKE_ACP_REPLY=VERB_REPLY}"
  REPLY_TEXT="${REPLY_TEXT:-VERB_REPLY}"
elif [ "$MODE" = "patrol" ]; then
  # The full sweep: every slash command the shipped TUI offers, driven once, each checked
  # against the same contract. Runs against a fixture session with one turn. The reply is
  # pinned here so the sweep's opening wait is self-contained (verify.sh passes these too;
  # a missing FAKE_ACP_REPLY once made the first-turn wait look for a string the fixture
  # never produced, and every session-route command was then skipped as "not offered"
  # because the TUI never left the home screen).
  FAKE_ENV="${FAKE_ENV:-FAKE_ACP_MODELS=1 FAKE_ACP_REPLY=PONG_FROM_AGENT}"
  REPLY_TEXT="${REPLY_TEXT:-PONG_FROM_AGENT}"
elif [ "$MODE" = "cd" ]; then
  # /cd needs the fixture to accept a re-load in a new cwd and to report the cwd it runs
  # in, so the screen can prove the agent followed the directory the UI now claims.
  FAKE_ENV="${FAKE_ENV:-FAKE_ACP_MODELS=1 FAKE_ACP_CAPS_LOAD_SESSION=1 FAKE_ACP_CWD_IN_REPLY=1 FAKE_ACP_REPLAY_ON_LOAD=1}"
elif [ "$MODE" = "stale-prompt" ]; then
  # The agent still reports a prompt as active although the bridge believes the
  # session is idle (the desync a mid-turn steer used to cause). The bridge must
  # cancel the stale prompt, retry, and show the reply — not the agent's error.
  FAKE_ENV="${FAKE_ENV:-FAKE_ACP_MODELS=1 FAKE_ACP_STALE_PROMPT=1 FAKE_ACP_REPLY=STALE_RETRY_OK}"
  REPLY_TEXT="${REPLY_TEXT:-STALE_RETRY_OK}"
elif [ "$MODE" = "queue" ]; then
  # A long turn is held by the agent (gate file), a follow-up is typed during it, and
  # the gate is opened by the script. The follow-up must show as queued — not as the
  # agent's "already has an active ACP prompt" error — and must run after the turn.
  FAKE_ENV="${FAKE_ENV:-FAKE_ACP_MODELS=1 FAKE_ACP_HOLD_ON=QUEUE_HOLD FAKE_ACP_HOLD_RELEASE=/tmp/oac-queue-release-$$}"
elif [ "$MODE" = "tool-stages" ]; then
  # opencode's real shape: the pending frame carries `{cwd}` (or `{}`), the command/query
  # arrives with `in_progress`. The rows must render the command and the query; publishing
  # the pending snapshot as the row's input pinned them to "Writing command…"/"Searching
  # web…" forever (measured on v2.0.32).
  FAKE_ENV="${FAKE_ENV:-FAKE_ACP_MODELS=1 FAKE_ACP_SCENARIO=rich-turn FAKE_ACP_TOOL_STAGES=1 FAKE_ACP_REPLY=TOOL_STAGES_DONE}"
  REPLY_TEXT="${REPLY_TEXT:-TOOL_STAGES_DONE}"
elif [ "$MODE" = "todo" ]; then
  FAKE_ENV="${FAKE_ENV:-FAKE_ACP_MODELS=1 FAKE_ACP_SCENARIO=rich-turn FAKE_ACP_TODO=1 FAKE_ACP_REPLY=TODO_OK}"
  REPLY_TEXT="${REPLY_TEXT:-TODO_OK}"
elif [ "$MODE" = "shell" ] || [ "$MODE" = "shell-history" ]; then
  FAKE_ENV="${FAKE_ENV:-FAKE_ACP_MODELS=1}"
elif [ "$MODE" = "mode" ]; then
  FAKE_ENV="${FAKE_ENV:-FAKE_ACP_MODELS=1 FAKE_ACP_MODES=1 FAKE_ACP_CAPS_LOAD_SESSION=1 FAKE_ACP_MODE_IN_REPLY=1}"
else
  # The default history run uses the interleaved scenario on purpose: text before a tool and
  # text after it is the shape that once made the turn-end event overwrite the final text with
  # the first one, so the screen showed the same sentence twice. A plain rich turn has only one
  # text block and cannot catch it.
  FAKE_ENV="${FAKE_ENV:-FAKE_ACP_MODELS=1 FAKE_ACP_SCENARIO=interleaved FAKE_ACP_REPLY=PONG_FROM_AGENT}"
fi
KEEP="${KEEP:-0}"
URL="http://127.0.0.1:$PORT"
PROMPT_TEXT="${PROMPT_TEXT:-remember this line}"
# `MODE=restore-turn` sends a second prompt whose reply the fixture builds from a tool call.
TOOL_PROMPT="${TOOL_PROMPT:-run the echo tool}"
REPLY_TEXT="${REPLY_TEXT:-PONG_FROM_AGENT}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-$REPO/.artifacts}"
WORK="$(mktemp -d)"
LOG="$WORK/bridge.log"
# ★ From v2.3.0 the TUI summarises a run of tool calls into ONE collapsed activity row by
# default (`session.verbosity: "low"`, measured in `packages/tui/src/component/dialog-config.tsx`).
# Every assertion here is about the tool row being RENDERED — command, input, no stuck pending
# label — and a collapsed row cannot answer any of them. Pin the setting for the harness so
# the same screens are compared across releases.
#
# This is a choice about the HARNESS, not about what we ship: a user who prefers the summary
# keeps it. `OPENCODE_CONFIG_DIR` is honoured by the TUI on its own, so no bridge change is
# involved.
TUI_CONFIG_DIR="$WORK/tui-config"
mkdir -p "$TUI_CONFIG_DIR"
# v2.3.0 moved CLI config from `tui.json` to `cli.json` (packages/cli/src/config/config.ts:
# `path.join(global.config, "cli.json")`); `tui.json` is read only to MIGRATE. Write both so
# the pin holds on releases either side of that change.
# ★ v2.4 opens a RELEASE HIGHLIGHTS screen once after an update ("Release highlights",
# `app.highlights`, default on — packages/tui/src/app.tsx: it renders while the home screen is
# idle and waits for `enter`). It sits on top of the composer, so a harness that waits for the
# composer's placeholder hangs until its timeout and reports "the TUI never became ready" —
# measured on v2.4.1 on both macOS and Linux. Turn it off for the harness (a user who wants it
# keeps it): the same `highlights` key, at the top level of the config.
printf '{"highlights":false,"session":{"verbosity":"high"}}\n' > "$TUI_CONFIG_DIR/cli.json"
printf '{"highlights":false,"session":{"verbosity":"high"}}\n' > "$TUI_CONFIG_DIR/tui.json"
export OPENCODE_CONFIG_DIR="$TUI_CONFIG_DIR"
# The bridge writes a durable session-id map. This test uses fake agents and temporary
# workspaces, so its map must not pollute the operator's ~/.opencode-acp-client state.
export OPENCODE_ACP_CLIENT_SESSION_MAP="$WORK/sessions.json"
BRIDGE="oac-bridge-$$"
CLIENT="oac-client-$$"

# ★ A private tmux server for this run.
#
# The script used to share the default server with everything else on the machine.
# Session names carry `$$`, which is constant for the whole run, so a mode that
# reused a name while the previous `kill-session` was still completing made
# `new-session` fail silently — `capture-pane` then showed the OLD pane (or nothing)
# and the wait reported "the TUI never became ready for input" while the bridge log
# proved it had launched and handshaken. Seen twice against opencode v2.2.3, at a
# different mode each time, which is the signature of a collision rather than a
# version bug.
TMUX_SOCKET="oac-e2e-$$"
tmux() { command tmux -L "$TMUX_SOCKET" "$@"; }
FAILED=0

fail() { echo "  ✗ $1" >&2; FAILED=1; }
ok() { echo "  ✓ $1"; }
# A fact worth printing that is NOT this bridge's promise — e.g. the client's own grouping
# rule differing between releases. Never fails the run; still shows up in the log.
note() { echo "  ! $1"; }

# Poll the pane for a marker instead of sleeping a fixed amount. The client's
# startup time is not ours to guess — a release that takes a second longer made
# every keystroke arrive before the composer was ready, and the run then asserted
# against a screen that had never received the prompt.
# ★ v2.3.0 opens a "What's new in this release" dialog the first time a TUI sees a version
# (measured: the pane sits at `scroll ↑/↓    ok` and the composer never takes input, so every
# mode waiting for `Ask anything` times out). It is a real user-facing screen, not a bug, and
# it does NOT appear on later launches — which is exactly the shape that makes it dangerous
# here: a fresh workspace per run means every run is a first run.
#
# Dismissed from inside the wait, so it is covered where it matters (any wait, any mode)
# rather than at nineteen separate call sites. Enter is what the dialog's `ok` button takes;
# it is sent at most a few times, and only while a dialog is actually on screen.
# 0 = nothing dismissed yet; see the cap inside `dismiss_announcements`.
ANNOUNCEMENTS=0

dismiss_announcements() {
  local pane
  pane="$(tmux capture-pane -p -t "$CLIENT" 2>/dev/null || true)"
  # The dialog's footer is `scroll ↑/↓   ok` plus a boxed body. Match the footer, not a
  # specific release's words: the content changes every version.
  # ★ Bounded. A mode that is itself testing a dialog could show the same footer, and a wait
  # that kept pressing Enter there would fight the mode under test instead of helping it.
  # Two dismissals is enough for any release announcement; after that this stays out of the way.
  [ "${ANNOUNCEMENTS:-0}" -ge 2 ] && return 1
  if printf '%s' "$pane" | grep -qE 'scroll ↑/↓.*ok'; then
    tmux send-keys -t "$CLIENT" Enter 2>/dev/null || true
    ANNOUNCEMENTS="$(( ${ANNOUNCEMENTS:-0} + 1 ))"
    return 0
  fi
  return 1
}

wait_for_pane() {  # $1 = extended regex, $2 = what we are waiting for, $3 = seconds
  local deadline=$(( $(date +%s) + ${3:-45} ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if tmux capture-pane -p -t "$CLIENT" 2>/dev/null | grep -qE "$1"; then
      return 0
    fi
    dismiss_announcements >/dev/null 2>&1 || true
    sleep 0.5
  done
  # ★ On timeout, say what the screen ACTUALLY held. Two gate runs failed in different
  # modes with "the TUI never became ready" while the bridge log proved the TUI had
  # finished its whole start-up handshake — and the saved pane came from AFTER the wait,
  # so it showed a screen that had clearly been fine. Without this line the only way to
  # learn what the wait was looking at was to reproduce it by hand, which is what made
  # the same symptom look like three different bugs.
  echo "  ! timed out waiting for $2" >&2
  echo "  ! screen at timeout ($(tmux display-message -p -t "$CLIENT" '#{session_name}:#{window_index}.#{pane_index} #{pane_width}x#{pane_height} dead=#{pane_dead}' 2>&1)):" >&2
  tmux capture-pane -p -t "$CLIENT" 2>&1 | sed 's/^/  │ /' >&2
  return 1
}

# Wait for a line in the bridge log, the same way we wait for a pane. A keypress
# posts asynchronously: on a slower machine the POST lands after the keystroke
# returns, so an immediate grep is a race (found by the Linux gate — the reply was
# in the log 200 ms after the false failure).
wait_for_log() {  # $1 = extended regex, $2 = what we are waiting for, $3 = seconds
  local deadline=$(( $(date +%s) + ${3:-15} ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if grep -qE "$1" "$LOG" 2>/dev/null; then
      return 0
    fi
    sleep 0.25
  done
  echo "  ! timed out waiting for $2" >&2
  return 1
}

# Case-insensitive wait: the client title-cases session titles, so matching the raw prompt text
# exactly misses rows that are actually there.
wait_for_pane_ci() {  # $1 = extended regex, $2 = what we are waiting for, $3 = seconds
  local deadline=$(( $(date +%s) + ${3:-45} ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if tmux capture-pane -p -t "$CLIENT" 2>/dev/null | grep -qiE "$1"; then
      return 0
    fi
    sleep 0.5
  done
  echo "  ! timed out waiting for $2" >&2
  return 1
}

wait_for_pane_absent() {  # $1 = extended regex, $2 = seconds
  local deadline=$(( $(date +%s) + ${2:-30} ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    tmux capture-pane -p -t "$CLIENT" 2>/dev/null | grep -qE "$1" || return 0
    sleep 0.5
  done
  return 1
}

send_prompt() {  # $1 = text
  # ★ Confirm the SUBMISSION, not a screen string. Two earlier versions of this helper guessed:
  # first a fixed 1.6s sleep, then "wait until the text appears anywhere on screen". The
  # second is wrong for a subtle reason — once a prompt has been sent before, its text is
  # ALREADY on screen (in the user row), so the wait returns instantly whether or not this
  # keystroke landed anywhere. Measured on v2.0.0: composer never took the keys, Enter went
  # nowhere, zero `/prompt` in the bridge log, empty transcript — which reads as a rendering
  # regression.
  #
  # The only honest signal is the request the client makes. `send_prompt` is only called when
  # a bridge log exists, so: type, Enter, and retry the whole thing until the log shows a
  # prompt that was not there before.
  local before after attempt
  # ★ `grep -c` prints 0 AND exits 1 when nothing matches, so `|| echo 0` appended a SECOND
  # `0` and the two counts compared as strings ("0\n0" vs "0"), never as a number. Measured:
  # the turn had actually run and its reply was on screen, while this helper reported "no new
  # /prompt after 3 attempts".
  before="$(grep -c 'POST /api/session/[^/]*/prompt' "$LOG" 2>/dev/null)"; before="${before:-0}"
  for attempt in 1 2 3; do
    tmux send-keys -t "$CLIENT" "$1"
    sleep 1.0
    tmux send-keys -t "$CLIENT" Enter
    sleep 1.5
    after="$(grep -c 'POST /api/session/[^/]*/prompt' "$LOG" 2>/dev/null)"; after="${after:-0}"
    [ "$after" -gt "$before" ] && return 0
    # Nothing arrived: clear whatever may be sitting in the composer and try again. A stale
    # half-typed line would concatenate with the next attempt.
    tmux send-keys -t "$CLIENT" C-u 2>/dev/null || true
    sleep 0.5
  done
  fail "the prompt never reached the bridge (no new /prompt after $attempt attempts)"
  return 1
}

# One assertion per layer the adapter is responsible for, applied to whatever is on
# screen. A missing reply means the event vocabulary broke; a missing tool card means
# the tool_call translation did; a missing footer means the model/agent projection
# did; a still-running hint means the turn never closed.
assert_layers() {  # $1 = captured pane, $2 = what to call this screen
  local pane="$1" label="$2" missing=""
  printf '%s' "$pane" | grep -q "$PROMPT_TEXT" || missing="$missing user-row"
  printf '%s' "$pane" | grep -q "$REPLY_TEXT" || missing="$missing reply"
  printf '%s' "$pane" | grep -qi "thought" || missing="$missing reasoning-block"
  printf '%s' "$pane" | grep -q "echo" || missing="$missing tool-card"
  # The interleaved scenario's tool input is `{step:1}` rather than the prompt text, and the
  # client renders it as `[step=1]`; accept either shape.
  printf '%s' "$pane" | grep -qE "(text=${PROMPT_TEXT}|\[step=1\])" || missing="$missing tool-input"
  printf '%s' "$pane" | grep -q "Fake-Acp" || missing="$missing agent-footer"
  # The card footer resolves the message's model against the catalog and prints
  # `${providerID}/${id}` when it cannot. Storing the pre-ACP `acp/default` placeholder as a
  # model made that read "acp/unknown" on screen, so it is asserted here, not in JSON.
  printf '%s' "$pane" | grep -q "Fake-Acp" || missing="$missing agent-footer"
  # Exactly one copy of the pre-tool text. The turn-end path once emitted `session.text.ended`
  # with the first text block while the client applies it to the last one, so the post-tool text
  # was overwritten and this string appeared twice on screen.
  TEXT_ONE_COPIES="$(printf '%s\n' "$pane" | grep -o 'text one' | wc -l | tr -d '[:space:]')"
  [ "$TEXT_ONE_COPIES" = "1" ] || missing="$missing duplicated-pre-tool-text"
  if printf '%s' "$pane" | grep -q "esc interrupt"; then
    missing="$missing turn-still-running"
  fi
  if [ -z "$missing" ]; then
    ok "$label"
  else
    fail "$label is missing:$missing"
    printf '%s\n' "$pane" | sed -n '1,22p'
  fi
}

# Keep what a version actually rendered: a green run is the assertion, the file is
# the evidence, and a diff between two versions is often the fastest explanation.
save_pane() {
  mkdir -p "$ARTIFACTS_DIR"
  local version
  version="$("$OC" --version 2>/dev/null | sed 's/[^0-9A-Za-z._-]/_/g' | head -1)"
  local target="$ARTIFACTS_DIR/tui-${version:-unknown}-$1.txt"
  printf '%s\n' "$2" > "$target"
  echo "  · saved $target"
}

cleanup() {
  tmux kill-session -t "$CLIENT" 2>/dev/null || true
  tmux kill-session -t "$BRIDGE" 2>/dev/null || true
  # Our own server, so nothing it holds can outlive this run.
  tmux kill-server 2>/dev/null || true
  if [ "$FAILED" = "0" ] && [ "$KEEP" = "0" ]; then
    rm -rf "$WORK"
  else
    echo "  (kept for post-mortem: $WORK — pane1-live.txt, pane2-reload.txt, bridge.log)"
  fi
}
trap cleanup EXIT

[ -x "$OC" ] || { echo "no opencode TUI at $OC (set OC=)"; exit 1; }
command -v tmux >/dev/null || { echo "tmux is required"; exit 1; }

# Read the version once and use it everywhere: a label that claims a version the
# run is not using is worse than no label, because it becomes "evidence" later.
TUI_VERSION="$("$OC" --version 2>&1 | head -1 | sed 's/.*\(v[0-9][0-9.]*\).*/\1/')"
echo "▸ tui: $OC (${TUI_VERSION:-version unknown})"

# ENTRY=1 is deliberately narrow: it exercises the product's actual one-command launch
# instead of the normal server-only setup below. The shell-output defect existed only in this
# path: the same bridge/TUI/agent rendered when the bridge and TUI were started separately.
# Keep it as a regression guard with the fake agent; AGENT= also works for the measured dsh
# profile when a manual real-agent acceptance is wanted.
if [ "${ENTRY:-0}" = "1" ]; then
  [ "$MODE" = "shell" ] || { echo "ENTRY=1 currently supports MODE=shell only" >&2; exit 2; }
  echo "▸ single-entry TUI in tmux:$CLIENT, workspace $WORK"
  if [ -n "${AGENT:-}" ]; then
    tmux new-session -d -s "$CLIENT" -x 110 -y 34 \
      "cd $WORK && zsh -lic 'cd $WORK && OPENCODE_ACP_CLIENT_SESSION_MAP=$WORK/sessions.json OPENCODE_BIN=$OC node $REPO/dist/index.js $WORK --bridge-log $LOG -- ${AGENT}'"
  else
    tmux new-session -d -s "$CLIENT" -x 110 -y 34 \
      "cd $WORK && env $FAKE_ENV OPENCODE_ACP_CLIENT_SESSION_MAP=$WORK/sessions.json OPENCODE_BIN=$OC node $REPO/dist/index.js $WORK --bridge-log $LOG -- node $REPO/tests/fake-acp-agent.mjs"
  fi
  # 120s, not 60: measured on opencode v2.0.32 the TUI performs one more round of
  # server reads before its composer appears (/api/provider, /api/reference,
  # /api/skill, /api/shell, /api/experimental/migration/v1 — all seen arriving
  # just before the screen settles), and under the full gate's load 60s was not
  # enough. The pane waits for a MARKER, never a duration, so the longer ceiling
  # only ever costs time when the TUI is genuinely broken.
  wait_for_pane 'Ask anything|Fake-Acp' 'the single-entry composer' 240 \
    || fail "the single-entry TUI never became ready for input"
  # The delay matters: it is the interaction rhythm the real TUI receives from a human.
  tmux send-keys -t "$CLIENT" "!echo SHELLIN | tr A-Z a-z"
  # ★ Confirm the text LANDED before pressing Enter: the composer is ready the moment its
  # placeholder shows, but a keystroke sent into that first frame can be dropped — the pane
  # then proved it, showing `Ask anything…` with no `!echo` anywhere and the shell card
  # never appearing. Waiting for our own text on screen makes the Enter mean "submit what
  # is there", which is what a person does.
  wait_for_pane '!echo SHELLIN' 'the shell line in the composer' 15 || true
  sleep 1.2
  tmux send-keys -t "$CLIENT" Enter
  if wait_for_pane 'shellin' 'the single-entry shell output on screen' 30; then
    ok "single-entry !command rendered its output"
  else
    fail "single-entry !command showed no output"
  fi
  save_pane shell-entry "$(tmux capture-pane -p -t "$CLIENT" 2>/dev/null)"
  exit "$FAILED"
fi

echo "▸ bridge in tmux:$BRIDGE (server-only), workspace $WORK"
# AGENT=<command> drives a real agent instead of the fixture. Same interaction, same
# assertions — which is the only way to check the real TUI against a real agent without
# relying on hand-typed keys, whose submission timing is not reproducible.
if [ -n "${AGENT:-}" ]; then
  tmux new-session -d -s "$BRIDGE" -x 110 -y 34 \
    "cd $REPO && zsh -lic 'cd $REPO && OPENCODE_BIN="$OC" OPENCODE_ACP_CLIENT_SESSION_MAP=$WORK/sessions.json node dist/index.js --no-tui --bridge-port $PORT $WORK \
     --bridge-log $LOG -- ${AGENT}'"
else
  tmux new-session -d -s "$BRIDGE" -x 110 -y 34 \
    "cd $REPO && $FAKE_ENV OPENCODE_BIN="$OC" OPENCODE_ACP_CLIENT_SESSION_MAP=$WORK/sessions.json node dist/index.js --no-tui --bridge-port $PORT $WORK \
     --bridge-log $LOG -- node $REPO/tests/fake-acp-agent.mjs"
fi

for _ in $(seq 1 40); do
  sleep 0.5
  curl -s -m 2 -o /dev/null "$URL/api/info" && break
done
curl -s -m 2 -o /dev/null "$URL/api/info" || { fail "the adapter never came up"; exit 1; }
ok "adapter is up"

# ---------------------------------------------------------------------------
# `MODE=stale-prompt` — the agent disagrees that the session is idle.
#
# Reported after a mid-turn steer was rejected: the next prompt ran, but the reply
# ended with `Error: Internal error: Session already has an active ACP prompt`. The
# bridge now cancels the agent's stale prompt and retries once; the screen must show
# the reply and no such error.
# ---------------------------------------------------------------------------
if [ "$MODE" = "stale-prompt" ]; then
  tmux new-session -d -s "$CLIENT" -x 120 -y 40 "cd $WORK && OPENCODE_DISABLE_AUTOUPDATE=1 $OC --server $URL"
  wait_for_pane 'Ask anything' 'the composer' 180 || fail "the TUI never became ready for input"
  send_prompt "after the long task"
  wait_for_pane "$REPLY_TEXT" 'the reply' 60 || fail "the retried prompt never produced a reply"
  sleep 2
  PANE="$(tmux capture-pane -p -S -200 -t "$CLIENT")"
  save_pane stale-prompt "$PANE"
  printf '%s' "$PANE" | grep -q 'already has an active ACP prompt' \
    && fail "the stale-prompt error reached the screen" \
    || ok "no 'already has an active ACP prompt' on screen"
  exit "$FAILED"
fi

# ---------------------------------------------------------------------------
# `MODE=queue` — a follow-up typed during a running turn.
#
# The TUI sends `delivery: "steer"` for that gesture; ACP has no steering, so the
# bridge holds the message until the running turn settles. Measured bug: it was
# forwarded as a second `session/prompt`, the agent answered "Session already has an
# active ACP prompt", the red error ended the turn's progress indicator while the
# turn kept streaming, and nothing was queued. The gate file (`FAKE_ACP_HOLD_ON`)
# keeps the first turn open deterministically; the script opens it afterwards and
# the queued prompt must run.
# ---------------------------------------------------------------------------
if [ "$MODE" = "queue" ]; then
  RELEASE="/tmp/oac-queue-release-$$"
  rm -f "$RELEASE"
  tmux new-session -d -s "$CLIENT" -x 120 -y 40 "cd $WORK && OPENCODE_DISABLE_AUTOUPDATE=1 $OC --server $URL"
  wait_for_pane 'Ask anything|Fake-Acp' 'the composer' 180 || fail "the TUI never became ready for input"
  send_prompt "QUEUE_HOLD"
  sleep 3
  send_prompt "queued follow up"
  if wait_for_pane '1 queued' 'the queued follow-up row' 20; then
    ok "the follow-up is shown as queued"
  else
    fail "the follow-up was not queued"
  fi
  PANE="$(tmux capture-pane -p -S -200 -t "$CLIENT")"
  printf '%s' "$PANE" | grep -q 'Internal error'     && fail "the follow-up became an agent error (a second session/prompt was forwarded)"     || ok "no 'Internal error' reached the screen"
  save_pane queue-queued "$PANE"
  : > "$RELEASE"
  if wait_for_pane 'you said: queued follow up' 'the delivered follow-up reply' 40; then
    ok "the queued follow-up ran after the held turn"
  else
    fail "the queued follow-up never ran"
  fi
  save_pane queue-delivered "$(tmux capture-pane -p -S -200 -t "$CLIENT")"
  rm -f "$RELEASE"
  exit "$FAILED"
fi

# ---------------------------------------------------------------------------
# `MODE=tool-stages` — a tool whose input arrives after the pending frame.
#
# opencode sends `tool_call` with `{cwd}` only, then `in_progress` with the command,
# then `completed` with `content` + `rawOutput.metadata`. The TUI's shell row reads
# `input.command` and treats the row as "complete" once it exists; a bridge that
# published the pending snapshot left every card on "Writing command…" (and the
# search row on "Searching web…") even after the turn ended. Asserted on screen:
# the command, the output, the grouped search summary — and the absence of both
# pending labels.
# ---------------------------------------------------------------------------
if [ "$MODE" = "tool-stages" ]; then
  tmux new-session -d -s "$CLIENT" -x 120 -y 40 "cd $WORK && OPENCODE_DISABLE_AUTOUPDATE=1 $OC --server $URL"
  wait_for_pane 'Ask anything|Fake-Acp' 'the composer' 180 || fail "the TUI never became ready for input"
  send_prompt "go"
  wait_for_pane "$REPLY_TEXT" 'the reply' 60 || fail "the turn never finished"
  sleep 2
  PANE="$(tmux capture-pane -p -S -400 -t "$CLIENT")"
  save_pane tool-stages "$PANE"
  printf '%s' "$PANE" | grep -q '\$ echo hello' && ok "the shell row names its command" \
    || fail "the shell row does not show \`echo hello\`"
  printf '%s' "$PANE" | grep -q 'Writing command' && fail "the shell row still shows the pending label" \
    || ok "the shell row is not stuck on 'Writing command…'"
  # ★ The grouping row is NOT a promise of every release. Measured on v2.0.0: its
  # `groupExploration()` is on by default, but `grouped()` only collects grep/glob-shaped
  # calls, so a lone `websearch` renders as a plain `◈ Web Search` row and no "Explored"
  # line exists at all. v2.2.7 widened what counts as exploration and does group it.
  #
  # This mode exists to prove a tool row does not stay on its pending label — that is the
  # assertion above, and it holds on both. Whether the client GROUPS is the client's own
  # feature, not something this bridge can cause or fix, so it is a note, not a failure.
  if printf '%s' "$PANE" | grep -qE 'Explored[^a-zA-Z0-9]*[0-9]+[^a-zA-Z0-9]*search'; then
    ok "the search row is grouped"
  else
    note "no grouping row on this release (its own grouping rule; the pending-label check above is what this mode is for)"
  fi
  printf '%s' "$PANE" | grep -q 'Searching web' && fail "the search row still shows the pending label" \
    || ok "the search row is not stuck on 'Searching web…'"
  exit "$FAILED"
fi

# ---------------------------------------------------------------------------
# `MODE=todo` — v2.1's todo list, fed by a completed `todowrite` tool call.
#
# v2.1 derives the list from the latest completed `todowrite` tool's
# `state.input.todos`; the bridge only has to forward a tool whose name is exactly
# `todowrite` and whose input carries the list. The sidebar is the screen contract.
# ---------------------------------------------------------------------------
if [ "$MODE" = "todo" ]; then
  # v2.1 introduced the todo surface; a v2.0 TUI cannot render it, so the version
  # gate skips this mode rather than failing a supported release.
  case "$TUI_VERSION" in
    v2.0*) echo "  ! MODE=todo: this TUI ($TUI_VERSION) has no todo surface, skipping" >&2; exit 0 ;;
  esac
  tmux new-session -d -s "$CLIENT" -x 160 -y 42 "cd $WORK && OPENCODE_DISABLE_AUTOUPDATE=1 $OC --server $URL"
  wait_for_pane 'Ask anything|Fake-Acp' 'the composer' 180 || fail "the TUI never became ready for input"
  send_prompt "go"
  wait_for_pane "$REPLY_TEXT" 'the reply' 60 || fail "the turn never finished"
  sleep 2
  PANE="$(tmux capture-pane -p -S -400 -t "$CLIENT")"
  save_pane todo "$PANE"
  printf '%s' "$PANE" | grep -q 'Todo' && ok "the sidebar shows the todo heading" \
    || fail "the sidebar has no Todo section"
  printf '%s' "$PANE" | grep -q 'write the parser' && ok "the completed todo is rendered" \
    || fail "the completed todo is missing"
  printf '%s' "$PANE" | grep -q 'run the tests' && ok "the in-progress todo is rendered" \
    || fail "the in-progress todo is missing"
  printf '%s' "$PANE" | grep -q 'ship it' && ok "the pending todo is rendered" \
    || fail "the pending todo is missing"
  exit "$FAILED"
fi

# ---------------------------------------------------------------------------
# `MODE=shell` — `!command`, on the real screen.
#
# The assertion is on a *transformed* output on purpose: asserting "SHELLIN" would
# pass from the typed command alone. `tr A-Z a-z` cannot appear unless the command
# really ran and its output really rendered. The required `session.shell.ended`
# payload is the v2 `Shell.Output` envelope (`{output,cursor,size,truncated}`), not a
# plain string: the TUI transport's shellTerminal() reads those four fields directly.
# ENTRY=1 below exercises this same check through the product's single-entry launch.
# ---------------------------------------------------------------------------
if [ "$MODE" = "shell" ]; then
  tmux new-session -d -s "$CLIENT" -x 110 -y 34 "cd $WORK && OPENCODE_DISABLE_AUTOUPDATE=1 $OC --server $URL"
  wait_for_pane 'Ask anything|Fake-Acp' 'the composer' 180 || fail "the TUI never became ready for input"
  tmux send-keys -t "$CLIENT" "!echo SHELLIN | tr A-Z a-z"
  tmux send-keys -t "$CLIENT" Enter
  if wait_for_pane 'shellin' 'the shell output on screen' 30; then
    ok "!command rendered its output"
  else
    fail "!command showed no output (the row appears, the output does not — see docs/SCENARIOS.md)"
  fi
  save_pane shell "$(tmux capture-pane -p -t "$CLIENT" 2>/dev/null)"
  exit "$FAILED"
fi

# ---------------------------------------------------------------------------
# `MODE=form` — the elicitation form, on the real screen.
#
# Shape captured by hand on v2.0.28 first (the same discipline as the permission
# dialog, and for the same reason: the first hand-capture there stopped at row 20
# and wrongly concluded the dialog never rendered). What it showed: the form's
# title, one tab per field, the field's title, its options as a numbered list, and
# the hint `⇆ tab  ↑↓ select  enter confirm  esc dismiss`.
# ---------------------------------------------------------------------------
if [ "$MODE" = "form" ]; then
  tmux new-session -d -s "$CLIENT" -x 110 -y 34 "cd $WORK && OPENCODE_DISABLE_AUTOUPDATE=1 $OC --server $URL"
  wait_for_pane 'Ask anything|Fake-Acp' 'the composer' 180 || fail "the TUI never became ready for input"
  send_prompt "ask me something"

  # `conservative` and `balanced` are the options the agent put in the form, so
  # seeing them means our Form.Info reached the screen rather than a placeholder.
  wait_for_pane 'conservative' 'the form' 45 || fail "the agent asked a question and the TUI never showed the form"
  PANE_FORM="$(tmux capture-pane -p -t "$CLIENT")"
  save_pane form-asked "$PANE_FORM"
  ok "the form rendered"
  printf '%s' "$PANE_FORM" | grep -q 'balanced' && ok "both options are on screen" \
    || fail "the option list is incomplete on screen"

  # The submit gesture, established by pressing keys one at a time and reading the
  # hint line after each (the form is a small state machine):
  #   Tab -> the `Notes` text field        hint: enter confirm
  #   Tab -> the `Extras` multi-select     hint: enter toggle   (enter toggles, it
  #                                                              does not submit)
  #   Tab -> a summary view                hint: enter submit   <-- the one that sends
  #   Tab -> back to `Strategy`
  # So: three Tabs land on the summary, and Enter submits. Sending `Down` first (as
  # an earlier version of this did) changes what the following Tabs mean, which is
  # why that attempt produced no reply at all.
  tmux send-keys -t "$CLIENT" Tab
  sleep 1.6
  tmux send-keys -t "$CLIENT" Tab
  sleep 1.6
  tmux send-keys -t "$CLIENT" Tab
  sleep 1.6
  # NOT asserted: the submit gesture. Established by pressing one key at a time and
  # reading the hint after each:
  #
  #   Down            hint: enter confirm   -> picks the second option
  #   Enter           hint: enter confirm   -> confirms the field, and does NOT
  #                                            advance (counting Tabs after it is
  #                                            what made three attempts overshoot)
  #   Tab             hint: enter toggle    -> the Extras multi-select
  #   Enter           hint: enter toggle    -> toggles a checkbox
  #   Tab             hint: enter submit    -> the summary, the one that sends
  #   Enter                                 -> form/<id>/reply lands
  #
  # That sequence submits in a standalone script that mirrors this one's setup
  # exactly (same `env $FAKE_ENV node dist/index.js --log …`, same send_prompt, same
  # 1.6s between keys). Inside this script it produces no reply at all, and the
  # per-key diagnostics added here showed replies=0 at every step. So the gesture is
  # right and something about THIS script's own start-up differs — compare its bridge
  # and TUI start lines against a working standalone reproduction before touching
  # the keys again. Until then this mode proves the form RENDERS with the agent's
  # title, tabs and options, and says the rest is open.
  # Two hypotheses checked and eliminated, so nobody re-checks them:
  #   ✗ "the TUI posts to a route we do not serve" — it posts to
  #     /api/session/<sid>/form/<fid>/reply, exactly what we serve.
  #   ✗ "the body shape differs" — the generated client sends `{answer: {...}}`
  #     (Form.Reply), and our handler reads `body.answer` as an object and answers 204.
  # A standalone script with this script's exact setup submits and logs the reply;
  # here nothing is logged at all, which means the keys never produced a request.
  # Next check, one line: press Tab once and capture the hint — `enter confirm`
  # becomes `enter toggle`. If the hint does not change, the keys are not reaching
  # this TUI at all (focus, or the pane this script is typing into), and the gesture
  # was never the problem.
  # Keystrokes must reach the TUI before any of this means anything: the hint line
  # tracks the current field (enter confirm / enter toggle / enter submit).
  hint() { tmux capture-pane -p -t "$CLIENT" | grep -oE 'enter (confirm|toggle|submit)' | head -1; }

  # ★ The form's STARTING view is racy. The Enter that submits the prompt can land
  # after the form has appeared and advance it: I measured the same script open the
  # form on `enter confirm` (Strategy) one run and on `enter submit` (the summary)
  # the next. Counting keys from an assumed start is what made three earlier
  # attempts submit nothing — and what made a standalone reproduction succeed while
  # this script did not. So: read the hint, walk back to the field, answer it, walk
  # forward to the summary, submit.
  for _ in 1 2 3 4; do
    [ "$(hint)" = "enter confirm" ] && break
    tmux send-keys -t "$CLIENT" Tab
    sleep 1.2
  done
  [ "$(hint)" = "enter confirm" ] && ok "the form is on its first field" \
    || fail "could not reach the form's first field (hint: $(hint))"

  tmux send-keys -t "$CLIENT" Down
  sleep 1.2
  tmux send-keys -t "$CLIENT" Enter
  sleep 1.2

  for _ in 1 2 3 4; do
    [ "$(hint)" = "enter submit" ] && break
    tmux send-keys -t "$CLIENT" Tab
    sleep 1.2
  done
  [ "$(hint)" = "enter submit" ] && ok "the form is on its submit view" \
    || fail "could not reach the form's submit view (hint: $(hint))"

  tmux send-keys -t "$CLIENT" Enter
  sleep 1.5

  wait_for_log 'form/[^ ]*/reply' 'the form answer' 15     && ok "the TUI posted the answer" \
    || fail "submitting the form sent no answer to the bridge"
  wait_for_pane_absent 'Which strategy should I use' 20 && ok "the form closed" \
    || fail "the form stayed up after being submitted"
  PENDING="$(curl -s -m 5 "$URL/api/form" \
    | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("data") or []))' 2>/dev/null || echo '?')"
  [ "$PENDING" = "0" ] && ok "no form is left pending" || fail "a form is still pending (count=$PENDING)"
  save_pane form-answered "$(tmux capture-pane -p -t "$CLIENT")"

  # ★ The dismiss gesture: Esc. The shipped client (v2.0.28+, measured again on
  # 2.0.29/2.0.30) cancels with `DELETE /api/session/:id/form/:fid` — a spelling this
  # bridge did not serve, so the DELETE fell through to the generic 404, the form
  # stayed open with a red "Error", and the agent's elicitation hung pending forever
  # (the owner's report). A second form, one Escape, and four assertions.
  send_prompt "ask me again"
  wait_for_pane 'conservative' 'the second form' 45 || fail "the second form never rendered"
  tmux send-keys -t "$CLIENT" Escape
  sleep 3
  PANE="$(tmux capture-pane -p -t "$CLIENT")"
  save_pane form-cancelled "$PANE"
  printf '%s' "$PANE" | grep -q 'Error' \
    && fail "the form dismiss showed a red Error (the DELETE was not served)"
  wait_for_pane_absent 'Which strategy should I use' 20 && ok "Esc closed the form" \
    || fail "Esc did not close the form"
  # Which spelling the client uses is the client's business: v2.0.28+ sends
  # `DELETE /api/session/:id/form/:fid`, 2.0.0 sends `POST …/form/:fid/cancel`. The
  # bridge serves both; requiring one made 2.0.0 look broken (measured: 2 ✗ while the
  # bridge answered 204 and cancelled the agent's elicitation). Assert the dismiss
  # reached the bridge and was answered, not which verb it chose.
  if grep -qE 'DELETE /api/session/[^ ]*/form/[^ ]*' "$LOG"; then
    ok "the client dismissed with the DELETE spelling"
  elif grep -qE 'POST /api/session/[^ ]*/form/[^ ]*/cancel' "$LOG"; then
    ok "the client dismissed with the POST .../cancel spelling"
  else
    fail "no form-dismiss request reached the bridge"
  fi
  if grep -qE '\-> 204 (DELETE /api/session/[^ ]*/form/[^ ]*|POST /api/session/[^ ]*/form/[^ ]*/cancel)' "$LOG"; then
    ok "the dismiss was answered 204"
  else
    fail "the form-dismiss request was not answered 204"
  fi
  wait_for_log 'form frm_[^ ]* cancelled' 'the cancelled elicitation' 15 \
    && ok "the agent's elicitation was answered cancelled" \
    || fail "the cancel never reached the agent"
  PENDING="$(curl -s -m 5 "$URL/api/form" \
    | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("data") or []))' 2>/dev/null || echo '?')"
  [ "$PENDING" = "0" ] && ok "no form is left pending after Esc" || fail "a form is still pending after Esc (count=$PENDING)"
  exit "$FAILED"
fi

# ---------------------------------------------------------------------------
# `MODE=permission` — the permission dialog, on the real screen.
#
# Verified by hand on v2.0.28 before automating it: the dialog is a FOOTER
# (`△ Permission required`, the tool line, `Allow once  Reject`, and the hint
# `select  enter confirm`), keys are left/right to select, enter to confirm, esc
# to reject. It sits at the BOTTOM of the screen — a capture that stops early
# misses it entirely, which is exactly how I first concluded it did not render.
# ---------------------------------------------------------------------------
if [ "$MODE" = "permission" ]; then
  tmux new-session -d -s "$CLIENT" -x 110 -y 34 "cd $WORK && OPENCODE_DISABLE_AUTOUPDATE=1 $OC --server $URL"
  wait_for_pane 'Ask anything|Fake-Acp' 'the composer' 180 || fail "the TUI never became ready for input"
  send_prompt "do something risky"

  wait_for_pane 'Permission required' 'the permission dialog' 45 \
    || fail "the agent asked for permission and the TUI never showed it"
  PANE_ASK="$(tmux capture-pane -p -t "$CLIENT")"
  save_pane permission-asked "$PANE_ASK"
  ok "the permission dialog rendered"
  printf '%s' "$PANE_ASK" | grep -q 'Allow once' && ok "the options are on screen" \
    || fail "the dialog has no options"

  # Answer it: right to move off the default, then enter.
  tmux send-keys -t "$CLIENT" Right
  sleep 1.6
  tmux send-keys -t "$CLIENT" Enter

  wait_for_log 'permission/[^ ]*/reply' 'the permission reply' 15     && ok "the TUI posted the reply" \
    || fail "answering the dialog sent no reply to the bridge"
  wait_for_pane_absent 'Permission required' 20 && ok "the dialog closed" \
    || fail "the dialog stayed up after being answered"
  PENDING="$(curl -s -m 5 "$URL/api/permission/request" \
    | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("data") or []))' 2>/dev/null || echo '?')"
  [ "$PENDING" = "0" ] && ok "nothing is left pending" \
    || fail "the permission is still pending (count=$PENDING)"
  save_pane permission-answered "$(tmux capture-pane -p -t "$CLIENT")"
  exit "$FAILED"
fi

# ---------------------------------------------------------------------------
# `MODE=cancel` — the other half of the acceptance: what does the real TUI send
# to stop a running turn? The agent hangs, so the turn never ends by itself and
# any request that appears can only have come from the user's gesture.
# ---------------------------------------------------------------------------
if [ "$MODE" = "cancel" ]; then
  echo "▸ cancel mode: the agent never answers, so the turn stays running"
  tmux new-session -d -s "$CLIENT" -x 110 -y 34 "cd $WORK && OPENCODE_DISABLE_AUTOUPDATE=1 $OC --server $URL"
  wait_for_pane 'Ask anything|Fake-Acp' 'the composer' 180 || fail "the TUI never became ready for input"
  send_prompt "hang on purpose"
  # The prompt echoes into the transcript; wait for that rather than a duration.
  wait_for_pane "hang on purpose" 'the echoed prompt' 30 || true
  if ! tmux capture-pane -p -t "$CLIENT" | grep -q "hang on purpose"; then
    fail "the prompt never reached the TUI"
  else
    ok "the turn is running (spinner up)"
  fi

  step() {
    local label="$1"; shift
    local before; before="$(wc -l < "$LOG")"
    tmux send-keys -t "$CLIENT" "$@"
    sleep 3
    local seen; seen="$(tail -n +$((before + 1)) "$LOG" | grep -o '\[http\] [A-Z]* [^ ]*' | sed 's/\[http\] //' | tr '\n' ' ')"
    printf '  %-16s -> %s\n' "$label" "${seen:-(no request)}"
    # The last gesture (Ctrl-C) closes the client, so a missing pane is expected there and
    # must not print `can't find pane` into the gate log.
    tmux capture-pane -p -t "$CLIENT" > "$WORK/pane-$label.txt" 2>/dev/null || true
  }

  echo "▸ gestures (${TUI_VERSION:-the client} arms on the first Escape and interrupts on the second, within 5s)"
  step escape Escape
  tmux capture-pane -p -t "$CLIENT" | grep -q "esc again" && echo "  (armed: footer says 'esc again to interrupt')" || echo "  (NOT armed — is the turn running?)"
  step escape-twice Escape
  # ★ Assert what the mode is named for: the client keeps running after an interrupt (the
  # `/view` POST right after `/interrupt` in the line above is it re-rendering the session).
  # The gesture list used to send Ctrl-C and then two more keys; Ctrl-C is the EXIT gesture,
  # so those probes ran against a closed pane and printed `can't find pane` — noise that read
  # like "the TUI died on interrupt".
  # What survives is checked, not assumed: the pane must still exist and the running-turn
  # footer (`esc interrupt`) must be gone. The composer's placeholder text is not asserted —
  # after an interrupt the client re-renders the transcript and the hint can differ.
  PANE_AFTER_INTERRUPT="$(tmux capture-pane -p -t "$CLIENT" 2>/dev/null || true)"
  printf '%s' "$PANE_AFTER_INTERRUPT" > "$WORK/pane-after-interrupt.txt"
  if [ -z "$PANE_AFTER_INTERRUPT" ]; then
    fail "the client exited when the turn was interrupted (pane gone)"
  elif printf '%s' "$PANE_AFTER_INTERRUPT" | grep -qi 'esc interrupt'; then
    fail "the turn still looks like it is running after the interrupt (footer: esc interrupt)"
  else
    ok "the client survived the interrupt and the turn is no longer running"
  fi
  SID="$(grep -o 'POST /api/session/[^/]*/prompt' "$LOG" | tail -1 | sed 's|POST /api/session/||; s|/prompt||')"
  echo "▸ positive control (proves the bridge side works, whatever the TUI does)"
  if [ -n "$SID" ]; then
    CODE_INTERRUPT="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/api/session/$SID/interrupt")"
    CODE_ABORT="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/api/session/$SID/abort")"
    printf '  POST /interrupt   -> HTTP %s\n' "$CODE_INTERRUPT"
    printf '  POST /abort       -> HTTP %s\n' "$CODE_ABORT"
    # 204 is what the real client logs as an unhandled rejection: it decodes a body.
    [ "$CODE_INTERRUPT" = "200" ] && [ "$CODE_ABORT" = "200" ] \
      || fail "cancel must answer 200 {interrupted}, got $CODE_INTERRUPT / $CODE_ABORT"
    sleep 3
    tmux capture-pane -p -t "$CLIENT" > "$WORK/pane-after-our-own-cancel.txt"
    grep -c 'abort:' "$LOG" >/dev/null 2>&1 && echo "  (bridge closed the turn — see pane-after-our-own-cancel.txt)"
  else
    fail "no session id in the bridge log"
  fi
  # ★ Last, and only now: Ctrl-C is the EXIT gesture, so every pane read has to happen before
  # it. Sending it earlier made the probes below print `can't find pane` — which read like
  # "the client died on interrupt" when it was this script closing it.
  step ctrl-c C-c
  echo "▸ panes kept in $WORK"
  exit "$FAILED"
fi

# ---------------------------------------------------------------------------
# `MODE=shell-history` — the reload path for a `!command`.
#
# The owner's report: `!ls` works, but after restarting and reopening the session the shell
# command is missing from the transcript. The bridge's `/message` JSON containing the row is NOT
# evidence that the TUI renders it — that is exactly the mistake this mode exists to prevent. So
# it drives the real TUI, restarts it, and asserts the card is on the screen.
# ---------------------------------------------------------------------------
if [ "$MODE" = "shell-history" ]; then
  tmux new-session -d -s "$CLIENT" -x 110 -y 34 "cd $WORK && OPENCODE_DISABLE_AUTOUPDATE=1 $OC --server $URL"
  wait_for_pane 'Ask anything|Fake-Acp' 'the composer' 180 || fail "the TUI never became ready for input"
  tmux send-keys -t "$CLIENT" "!echo SHELLIN | tr A-Z a-z"
  sleep 1.2
  tmux send-keys -t "$CLIENT" Enter
  wait_for_pane 'shellin' 'the live shell output' 30 || fail "the live !command showed no output"
  save_pane shell-history-live "$(tmux capture-pane -p -t "$CLIENT")"
  ok "live !command rendered"

  SID="$(grep -o 'POST /api/session/[^/]*/shell' "$LOG" 2>/dev/null | tail -1 | sed 's|POST /api/session/||; s|/shell||')"
  [ -n "$SID" ] && ok "shell session $SID" || fail "no session id in the bridge log for the shell"
  [ -n "$SID" ] || exit 1

  tmux kill-session -t "$CLIENT" 2>/dev/null || true
  sleep 1
  # The transcript a reopened client rebuilds comes from stored state, not from the event stream.
  tmux new-session -d -s "$CLIENT" -x 110 -y 34 "cd $WORK && $OC --server $URL --session $SID"
  if wait_for_pane 'echo SHELLIN' 'the reloaded shell row' 60; then
    ok "the shell row is present in the reloaded transcript"
  else
    fail "the reloaded transcript lost the !command row (see docs/SCENARIOS.md)"
  fi
  wait_for_pane 'shellin' 'the reloaded shell output' 30 \
    && ok "the reloaded shell card still shows its output" \
    || fail "the reloaded shell row rendered without its output"

  # A finished command must not come back as still-running. The client computes
  # `backgroundRunning` from its live shell list, and the bridge listed exited shells there, so
  # every reopened `!command` span a spinner forever. The shell card renders `$ <command>` once
  # it is complete and a braille spinner glyph (`⠋`…`⠿`) while it is running — assert the former
  # so this cannot silently regress.
  RELOAD_PANE="$(tmux capture-pane -p -t "$CLIENT")"
  save_pane shell-history-reload "$RELOAD_PANE"
  if printf '%s' "$RELOAD_PANE" | grep -qE '[$] echo SHELLIN'; then
    ok "the reloaded shell card renders as finished (no spinner)"
  else
    fail "the reloaded !command still renders as running (expected a '\$ command' card)"
  fi
  # Braille spinner glyphs are multi-byte, and this script runs with `LC_CTYPE=C`, where a
  # bracket character class matches single *bytes* — it flagged a clean pane. Match the code
  # points in Python instead, which has no locale-dependent character classes.
  SPINNER="$(printf '%s' "$RELOAD_PANE" | python3 -c '
import sys
spinners = set(chr(c) for c in range(0x2800, 0x2900))  # U+2800..U+28FF braille patterns
found = sorted({ch for ch in sys.stdin.read() if ch in spinners})
print(" ".join(found))
')"
  if [ -n "$SPINNER" ]; then
    fail "the reloaded !command card shows a running spinner ($SPINNER)"
  else
    ok "no running spinner on the reloaded shell card"
  fi
  exit "$FAILED"
fi

# ---------------------------------------------------------------------------
# `MODE=unsupported-verb` — verbs we cannot perform must fail in a way the client accepts.
#
# Two owner reports, one cause: `/compact` and `/btw` both hit the generic "unimplemented session
# verb" fallback, which answers 204, while each route declares `successStatus: 200` and a body.
# The generated client throws `UnexpectedStatus` for any status outside `declaredStatuses`.
# ACP has no compaction method and no side-question method that leaves the conversation
# untouched, so the honest answers are the declared 409 and 503 — and the point of this mode is
# the *screen*: the TUI must show a readable failure rather than a protocol error.
# ---------------------------------------------------------------------------
if [ "$MODE" = "unsupported-verb" ]; then
  tmux new-session -d -s "$CLIENT" -x 120 -y 36 "cd $WORK && OPENCODE_DISABLE_AUTOUPDATE=1 $OC --server $URL"
  wait_for_pane 'Ask anything|Fake-Acp' 'the composer' 180 || fail "the TUI never became ready for input"
  # Give the session something to compact; a session with a turn is the realistic case.
  send_prompt "$PROMPT_TEXT"
  wait_for_pane "$REPLY_TEXT" 'the reply' 60 || fail "the turn never rendered"

  tmux send-keys -t "$CLIENT" "/compact"
  # Let the slash autocomplete appear so Enter submits the command rather than completing it —
  # pressing it too early produced "No matching commands" instead of running anything.
  sleep 3
  tmux send-keys -t "$CLIENT" Enter
  sleep 5
  PANE="$(tmux capture-pane -p -t "$CLIENT")"
  save_pane unsupported-verb "$PANE"

  printf '%s' "$PANE" | grep -q 'UnexpectedStatus' \
    && fail "the TUI showed UnexpectedStatus for /compact (an undeclared status was answered)"
  ok "no UnexpectedStatus after /compact"

  # `/btw` is the same defect with a different route: `session.generate` declares
  # `successStatus: 200` and `[400,401,404,503]`, so the 204 fallback showed up as
  # `UnexpectedStatus: 204` in the owner's toast. ACP has no side-question method that leaves
  # the conversation untouched, so the bridge answers the declared 503 with a readable
  # message; assert that message on screen, not just the status in the log.
  # ★ Not every release offers every verb. 2.0.0 has no `/btw`: the TUI sends the
  # line to the agent as an ordinary prompt (the pane then shows its reply), so
  # there is no readable rejection to assert. The autocomplete banner is not a
  # reliable signal here (it depends on typing the lone word), so the evidence is
  # the bridge log: a NEW prompt whose text is this command means the TUI did not
  # intercept it, and the honest verdict is a skip, not a failure.
  TURNS_BEFORE_BTW="$(grep -c 'POST /api/session/[^/]*/prompt' "$LOG" 2>/dev/null || true)"
  tmux send-keys -t "$CLIENT" "/btw side question"
  sleep 3
  tmux send-keys -t "$CLIENT" Enter
  if wait_for_pane 'side questions \(/btw\) are not acp supported' 'the readable /btw failure' 20; then
    ok "the /btw failure is readable on screen"
  elif [ "$(grep -c 'POST /api/session/[^/]*/prompt' "$LOG" 2>/dev/null || true)" -gt "${TURNS_BEFORE_BTW:-0}" ]; then
    echo "  ! unsupported-verb /btw: this TUI sent it as an ordinary prompt (verb not offered), skipping" >&2
  else
    fail "the /btw failure never showed a readable message"
  fi
  PANE="$(tmux capture-pane -p -t "$CLIENT")"
  save_pane unsupported-verb-btw "$PANE"
  printf '%s' "$PANE" | grep -q 'UnexpectedStatus' \
    && fail "the TUI showed UnexpectedStatus for /btw (an undeclared status was answered)"
  ok "no UnexpectedStatus after /btw"

  # `/undo` is the same defect on a route the generic fallback silently answers with 204:
  # `revert.stage` declares `successStatus: 200` and `[400,401,404,409,500]`, so the toast the
  # owner saw for /btw would appear here too. The declared 409 surfaces as a readable message.
  tmux send-keys -t "$CLIENT" "/undo"
  sleep 3
  tmux send-keys -t "$CLIENT" Enter
  if wait_for_pane 'session undo \(/undo\) is not acp supported' 'the readable /undo failure' 20; then
    ok "the /undo failure is readable on screen"
  else
    fail "the /undo failure never showed a readable message"
  fi
  PANE="$(tmux capture-pane -p -t "$CLIENT")"
  save_pane unsupported-verb-undo "$PANE"
  printf '%s' "$PANE" | grep -q 'UnexpectedStatus' \
    && fail "the TUI showed UnexpectedStatus for /undo (an undeclared status was answered)"

  # And the verbs that genuinely are empty still get their 204.
  SID="$(grep -o 'POST /api/session/[^/]*/prompt' "$LOG" 2>/dev/null | tail -1 | sed 's|POST /api/session/||; s|/prompt||')"
  env_status="$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'content-type: application/json' \
    -d '{"variables":{}}' "$URL/api/session/$SID/environment" 2>/dev/null)"
  [ "$env_status" = "204" ] \
    && ok "a verb declared empty still gets 204" \
    || fail "PUT /environment answered $env_status, expected 204"
  exit "$FAILED"
fi

# ---------------------------------------------------------------------------
# `MODE=patrol` — every slash command, driven once in a real TUI.
#
# The owner's point, made after three bugs found by simply *using* the TUI: reactive
# fixing scales badly, because the person finding the bugs is the one who paid for the
# tool. The command set below is enumerated from the shipped TUI itself
# (git grep 'slash: {' on v2.0.28 — the same list its own palette offers), not guessed.
# Each command gets the same three-part contract:
#   1. the pane process is still alive (no crash),
#   2. no `UnexpectedStatus` anywhere on screen,
#   3. a per-command screen snapshot lands in .artifacts for human review.
# Commands whose behaviour is already gated by a dedicated mode (/cd, permission, form,
# cancel, shell, restore) are excluded here — they have deeper assertions than "did not
# explode"; /exit is covered by the entry suite, and /editor needs a real terminal editor.
# ---------------------------------------------------------------------------
if [ "$MODE" = "patrol" ]; then
  tmux new-session -d -s "$CLIENT" -x 130 -y 40 "cd $WORK && OPENCODE_DISABLE_AUTOUPDATE=1 $OC --server $URL"
  wait_for_pane 'Ask anything|Fake-Acp' 'the composer' 180 || fail "the TUI never became ready for input"
  # One turn, so dialogs that read the transcript (/timeline, /copy, /export) have content.
  send_prompt "$PROMPT_TEXT"
  wait_for_pane "$REPLY_TEXT" 'the first reply' 60 || fail "the patrol session never got its first turn"

  # Patrol drives commands, never messages: any prompt POST that lands during the sweep
  # means a command's keystrokes leaked into the composer and were submitted as text —
  # measured happening: /terminal opens a real PTY panel that steals focus, and the next
  # command's Enters typed into that shell, which then surfaced as a prompt whose text
  # was the leftover "/terminal/diff". The count below is the detector.
  PATROL_PROMPT_BASE="$(grep -c 'POST /api/session/.*/prompt' "$LOG" 2>/dev/null || echo 0)"
  SID="$(grep -o 'POST /api/session/[^/]*/prompt' "$LOG" 2>/dev/null | tail -1 | sed 's|POST /api/session/||; s|/prompt||')"

  PATROL_COMMANDS="
    help
    themes
    debug
    status
    settings
    models
    agents
    variants
    mcps
    plugins
    skills
    worktrees
    terminal
    diff
    timeline
    stats
    share
    connect
    highlights
    rename patrol-renamed
    copy
    export
    btw patrol side question
    compact
    undo
    redo
    fork
    clear
    new
    pair
    reload
  "
  # Ordering is load-bearing, measured twice over: /pair opens the web-pairing screen and
  # /update its dialog, and both leave the session route — afterwards every session-route
  # command reads "No matching commands" (correctly: the session page is gone). So the
  # session commands run first, the route-leaving trio last, and this comment lives
  # OUTSIDE the quoted list — inside it a `#` is just another word the sweep would type.
  # ★ /update is deliberately absent: its dialog confirms an install by default and
  # would replace the user's opencode binary mid-gate (measured 2026-10-20: Left→Skip
  # did not take on v2.1.0, the next mode got the new binary and timed out).
  # /reload is late in the list on purpose: it re-fetches the client configuration and
  # leaves the TUI in a state where session-route commands stop being offered (measured:
  # /rename showed "No matching commands" right after it, and fine without it), so it runs
  # after every session command, and the comment lives outside the quoted list — inside it,
  # a `#` is just another word the sweep would type.

  # ★ Commands whose rendering depends on data THIS bridge supplies: the transcript, the
  # model/agent catalog, the tool rows, the session list. A crash there is ours to answer for.
  # Everything else in the sweep (`/timeline`, `/stats`, `/diff`, `/export`, …) reads the
  # client's own stores and never touches the bridge, so a crash there is the client's bug —
  # recorded as a note rather than failing a gate about our compatibility.
  PATROL_OURS=" /compact /btw /undo /redo /model /agents /sessions /new /fork"

  while read -r CMD; do
    [ -z "$CMD" ] && continue
    # State-driven, not count-driven (the form-mode lesson, applied to commands): type the
    # command and read the pane BEFORE pressing anything. The TUI only offers commands its
    # current context registers — /terminal needs a real terminal backend and showed
    # "No matching commands" here — and Enter with no matching command submits the typed
    # text as a prompt (measured: the leftover "/terminal" leaked, then "/diff" concatenated
    # onto it). If the command is not offered, skip it with a note; leftover text is always
    # cleared before the next command, so nothing can leak into a submitted prompt.
    WORD="${CMD%% *}"
    if [ "$WORD" = "update" ]; then
      echo "  ! patrol /update: skipped by policy (it would install and mutate the user's binary)" >&2
      continue
    fi
    tmux send-keys -t "$CLIENT" "/$WORD"
    # The one reliable skip signal is the popup's own "No matching commands" banner: the
    # composer echoes the typed word, so word-matching cannot tell offered from unoffered,
    # and column-layout regexes proved brittle across commands (/share has no title in the
    # same column, session-route commands list differently). Give the popup 10s to render
    # its verdict; anything else is treated as offered and driven.
    OFFERED="yes"
    for _ in $(seq 1 20); do
      PANE_NOW="$(tmux capture-pane -p -t "$CLIENT" 2>/dev/null || true)"
      if printf '%s' "$PANE_NOW" | grep -q 'No matching commands'; then OFFERED="no"; break; fi
      sleep 0.5
    done
    if [ "$OFFERED" = "no" ]; then
      echo "  ! patrol /$WORD: not offered by this TUI context, skipping" >&2
      # Keep the pane that justified the skip: a skip is only honest if the banner really
      # was on screen, and the snapshot is the evidence.
      SKIPSAFE="$(printf '%s' "$WORD" | tr ' /' '__')"
      save_pane "patrol-skip-$SKIPSAFE" "$PANE_NOW"
      tmux send-keys -t "$CLIENT" C-c
      sleep 0.5
      tmux send-keys -t "$CLIENT" C-u
      sleep 0.5
      continue
    fi
    # Two Enters, measured: while the command autocomplete is visible, the first Enter
    # completes/inserts and the second submits; when no popup appeared the second Enter is
    # a no-op on an already-submitted (or empty) composer. /export additionally confirms
    # its options dialog with the second one.
    for ARG in ${CMD#"$WORD"}; do tmux send-keys -t "$CLIENT" " $ARG"; sleep 0.3; done
    tmux send-keys -t "$CLIENT" Enter
    sleep 1
    tmux send-keys -t "$CLIENT" Enter
    sleep 3

    DEAD="$(tmux display-message -p -t "$CLIENT" '#{pane_dead}' 2>/dev/null || echo 1)"
    PANE="$(tmux capture-pane -p -t "$CLIENT" 2>/dev/null || true)"
    SAFE="$(printf '%s' "$CMD" | tr ' /' '__')"
    save_pane "patrol-$SAFE" "$PANE"

    if [ "$DEAD" != "0" ]; then
      # ★ The client crashing on its own command is the CLIENT's bug, not a rendering
      # failure for us to fix — the same call this suite already makes for an agent's
      # credential errors. Recorded, not failed. Measured on v2.0.0: `/timeline` kills the
      # TUI, and every command after it then fails for lack of a session.
      #
      # ★ It ends the patrol run: with the pane dead there is nothing left to drive, and
      # letting the loop continue produced a dozen "the TUI process died" lines that read
      # like a dozen bugs.
      # ★ But do NOT blanket-pardon: a crash on a command that exercises OUR data would be
      # ours. The distinction used here is deliberate — the bridge feeds the transcript, the
      # model list and the tool rows; it feeds nothing that `/timeline`, `/stats`, `/diff`
      # and the like render, because those read the client's own stores. A crash there is
      # the client's. A crash on a session-facing command stays a failure.
      case " $PATROL_OURS " in
        *" $CMD "*)
          fail "patrol /$CMD: the TUI died on a command that renders data from this bridge"
          ;;
        *)
          note "patrol: the TUI died on /$CMD (the client's own crash; the rest of the sweep is skipped)"
          PATROL_DIED_ON="$CMD"
          ;;
      esac
      break
    fi
    if printf '%s' "$PANE" | grep -q 'UnexpectedStatus'; then
      fail "patrol /$CMD: UnexpectedStatus on screen (an undeclared status was answered)"
      continue
    fi
    ok "patrol /$CMD"
    # Close whatever dialog or picker the command opened. Escape is the default, and a
    # stray extra one on the composer only arms the interrupt gesture; C-u clears
    # anything left typed.
    tmux send-keys -t "$CLIENT" Escape
    sleep 0.5
    tmux send-keys -t "$CLIENT" C-u
    sleep 0.5
    # /update's DialogUpdate binds no Escape, and Enter confirms the *active* button,
    # which starts on Confirm — pressing Enter outright would install the update. Move
    # left to Skip first, then confirm to dismiss.
    if [ "$WORD" = "update" ]; then
      tmux send-keys -t "$CLIENT" Left
      sleep 0.5
      tmux send-keys -t "$CLIENT" Enter
      sleep 1
      tmux send-keys -t "$CLIENT" Escape
      sleep 0.5
    fi
    # Re-enter the session whenever a command left it. Measured across three commands:
    # /pair opens web pairing, /update its dialog, /highlights its view — each replaces
    # the route, and every session-route command after reads "No matching commands"
    # (correctly: the session page is gone). Instead of enumerating route-leaving
    # commands forever, detect it — the first turn's prompt text is only visible on the
    # session page — and navigate back (C-x l → Enter, the verified session-list path).
    if ! printf '%s' "$(tmux capture-pane -p -t "$CLIENT")" | grep -q "$PROMPT_TEXT"; then
      tmux send-keys -t "$CLIENT" Escape
      sleep 1
      tmux send-keys -t "$CLIENT" C-x
      sleep 1
      tmux send-keys -t "$CLIENT" l
      wait_for_pane_ci "(${SID}|${PROMPT_TEXT})" 'the session back in the list' 20 || true
      tmux send-keys -t "$CLIENT" Enter
      wait_for_pane "$PROMPT_TEXT" 'the session page again' 20 || true
    fi
  done <<PATROL_LIST
$(printf '%s\n' "$PATROL_COMMANDS")
PATROL_LIST

  # /terminal opened a real PTY panel that holds the input focus; without closing it every
  # later command types into the shell. Close the panel (Escape dismisses it) and give the
  # composer back its focus before the next command runs.
  tmux send-keys -t "$CLIENT" Escape
  sleep 1
  tmux send-keys -t "$CLIENT" Escape
  sleep 1

  # After the sweep the TUI must still be usable. The last commands (/reload et al.)
  # leave the home screen, so navigate back to the session first, then prove it works by
  # sending one more real turn end to end — the composer accepting and the reply arriving
  # is the alive-and-well proof.
  tmux send-keys -t "$CLIENT" C-x
  sleep 1
  tmux send-keys -t "$CLIENT" l
  wait_for_pane_ci "(${SID}|${PROMPT_TEXT})" 'the session back in the list' 30 || true
  tmux send-keys -t "$CLIENT" Enter
  if wait_for_pane "$PROMPT_TEXT" 'the session page after the patrol' 30; then
    ok "the session page is still reachable after the patrol"
  else
    fail "the session page was gone after the patrol"
  fi

  # The leak detector: commands never submit prompts. A POST /prompt during the sweep means
  # keystrokes escaped into a focused surface (the /terminal PTY being the measured one)
  # and the "command" the pane showed was really a submitted message.
  PATROL_PROMPT_NOW="$(grep -c 'POST /api/session/.*/prompt' "$LOG" 2>/dev/null || echo 0)"
  [ "$PATROL_PROMPT_NOW" = "$PATROL_PROMPT_BASE" ] \
    && ok "no command leaked into a submitted prompt" \
    || fail "$((PATROL_PROMPT_NOW - PATROL_PROMPT_BASE)) command(s) leaked into submitted prompts"
  exit "$FAILED"
fi

# ---------------------------------------------------------------------------
# `MODE=cd` — the working-directory switch.
#
# The owner ran `/cd ../webapp/` from a session started in another directory and observed
# four symptoms: no toast, no new row, the footer unchanged, and `!pwd` still naming the old
# directory — while the autocomplete already offered the new one (that is a client-side
# recents list, touched because the old generic 204 fallback counted as success). /cd maps to
# `POST /api/session/:id/move`; the official server validates the target, answers 204, and
# emits `session.moved`, which is what renders the "↳ Moved to" row and re-points the footer.
# The ACP side is a re-load of the same session id with the new `cwd` (the stable
# `session/load` takes one), with the translator muted so the replay it produces cannot
# re-render the history this session already holds as live rows.
# ---------------------------------------------------------------------------
if [ "$MODE" = "cd" ]; then
  TARGET="$WORK/nested"
  mkdir -p "$TARGET"

  tmux new-session -d -s "$CLIENT" -x 130 -y 40 "cd $WORK && OPENCODE_DISABLE_AUTOUPDATE=1 $OC --server $URL"
  wait_for_pane 'Ask anything|Fake-Acp' 'the composer' 180 || fail "the TUI never became ready for input"
  # Turn one, so the session has a live transcript the re-load would double if the mute failed.
  send_prompt "$PROMPT_TEXT"
  wait_for_pane 'cwd:' 'the first reply naming its working directory' 60 \
    || fail "the first turn never rendered its reply"
  PANE_ONE="$(tmux capture-pane -p -t "$CLIENT")"
  save_pane cd-before "$PANE_ONE"
  ROWS_BEFORE="$(printf '%s\n' "$PANE_ONE" | grep -c 'you said' || true)"

  # The switch itself. `/cd <absolute path>` — the client sends the raw argument and the
  # bridge resolves it, exactly like the official server does. Two Enters, measured: while
  # the directory popup is visible, Enter is `prompt.autocomplete.select` and only completes
  # the argument (appending the slash); the second Enter submits. If the popup never
  # appeared, the first Enter submits directly and the second lands on an empty composer.
  tmux send-keys -t "$CLIENT" "/cd $TARGET"
  sleep 3
  tmux send-keys -t "$CLIENT" Enter
  sleep 2
  tmux send-keys -t "$CLIENT" Enter
  if wait_for_pane 'Moved to' 'the location-switched row' 30; then
    ok "the move rendered its row"
  else
    fail "the move never rendered a location-switched row"
  fi
  PANE="$(tmux capture-pane -p -t "$CLIENT")"
  save_pane cd-moved "$PANE"
  printf '%s' "$PANE" | grep -q 'UnexpectedStatus' \
    && fail "the TUI showed UnexpectedStatus for /cd (an undeclared status was answered)"
  # The footer follows the moved session's location — one of the four symptoms the owner
  # reported was that it did not.
  printf '%s' "$PANE" | grep -q 'nested:main' \
    && ok "the footer names the new directory" \
    || fail "the footer did not follow the move"

  # The shell is the bridge's own: `!pwd` must name the new directory, because the user
  # checks exactly this after a switch. The Moved row also names it, so match the output
  # line: an absolute path, not the row.
  tmux send-keys -t "$CLIENT" '!pwd'
  sleep 1.6
  tmux send-keys -t "$CLIENT" Enter
  # ★ Wait for the OUTPUT, not the typed text: `wait_for_pane 'pwd'` matched the
  # composer's own echo of `!pwd` and passed instantly, then the capture raced
  # the shell card's rendering — the assertion failed on runs where the card
  # was milliseconds late (only under the full gate's load; a solo rerun always
  # passed, which is what made this look flaky). The output feature is the
  # absolute path line that is NOT the Moved row, so poll for exactly that.
  # The path here used to be a macOS temp prefix (`/var/folders/…`), so the Linux
  # gate could never match it. Use the workspace the script actually created, in
  # both spellings macOS can report (logical and `/private`-prefixed), and exclude
  # the two places the path also appears without the shell having run: the Moved
  # row and the footer.
  WORK_REAL="$(realpath "$WORK" 2>/dev/null || printf '%s' "$WORK")"
  pwd_rendered=0
  for _ in $(seq 1 60); do
    PANE="$(tmux capture-pane -p -t "$CLIENT")"
    if printf '%s\n' "$PANE" \
      | grep -F -e "$WORK/nested" -e "$WORK_REAL/nested" \
      | grep -v 'Moved to' | grep -v 'shift+tab' | grep -v ':main' | grep -q .; then
      pwd_rendered=1
      break
    fi
    sleep 0.5
  done
  save_pane cd-pwd "$PANE"
  [ "$pwd_rendered" = "1" ] \
    && ok "!pwd named the new directory" \
    || fail "!pwd did not name the new directory"

  # The next turn must answer from the new directory — the re-load is what makes /cd real,
  # because the agent's own tool calls have to follow the directory the UI now claims. The
  # reply wraps on a 130-column pane, so assert the tail pair rather than the whole path;
  # the workspace basename is `tmp.*`, so a `nested)` tail can only come from the target.
  # This also proves the mute: the re-load replays a frame, and a second "you said" beyond
  # the two real turns would mean the history rendered twice.
  send_prompt "after the move"
  if ! wait_for_pane 'after the move \(cwd:' 'the reply from the new directory' 60; then
    # Under full-gate load the restored tab's event path can lag the turn itself
    # (measured twice: the bridge log shows the prompt settled while the pane has no
    # row yet — the same client hydration the restore modes widened their windows for).
    # The gate of record is the transcript the bridge itself serves, read below, so a
    # slow pane does not fail a switch that verifiably happened.
    echo "  ! the post-move reply was not on screen in 60s; asserting from the transcript" >&2
  fi
  PANE="$(tmux capture-pane -p -t "$CLIENT")"
  save_pane cd-after "$PANE"
  if printf '%s\n' "$PANE" | grep -q 'nested)'; then
    ok "the agent answered from the new directory"
  else
    # The pane may still be hydrating; the transcript is the durable record of what the
    # agent actually said, and it is what a reopened tab will render from anyway.
    SID2="$(grep -o 'POST /api/session/[^/]*/prompt' "$LOG" | tail -1 | sed 's|POST /api/session/||; s|/prompt||')"
    TRANS="$(curl -s "$URL/api/session/$SID2/message?limit=5&order=desc")"
    printf '%s' "$TRANS" | grep -q 'nested)' \
      && ok "the agent answered from the new directory (from the transcript)" \
      || fail "the agent still runs in the old directory"
  fi
  ROWS_AFTER="$(printf '%s\n' "$PANE" | grep -c 'you said' || true)"
  [ "$ROWS_AFTER" -le $((ROWS_BEFORE + 1)) ] \
    && ok "the replayed history did not render a second time ($ROWS_AFTER reply rows)" \
    || fail "the history rendered twice after the move ($ROWS_AFTER reply rows)"

  # ★ The restart phase — the owner's report: /cd worked, the TUI was closed and reopened,
  # and the session was back in the launch directory, as if the move had been temporary.
  # The move itself is durable (it writes the session map); what was missing was the reader:
  # the adoption path built the record from the bridge's launch directory. Reopen the way the
  # owner did — close everything, start again, switch to the session — and require the
  # directory to still be the moved-to one, both in the footer and in the shell's cwd.
  SID="$(grep -o 'POST /api/session/[^/]*/prompt' "$LOG" 2>/dev/null | tail -1 | sed 's|POST /api/session/||; s|/prompt||')"
  [ -n "$SID" ] && ok "moved session $SID" || fail "no session id for the restart phase"
  tmux kill-session -t "$CLIENT" 2>/dev/null || true
  tmux kill-session -t "$BRIDGE" 2>/dev/null || true
  sleep 1
  tmux new-session -d -s "$BRIDGE" -x 110 -y 34 \
    "cd $REPO && env $FAKE_ENV OPENCODE_BIN="$OC" OPENCODE_ACP_CLIENT_SESSION_MAP=$WORK/sessions.json node dist/index.js --no-tui --bridge-port $PORT $WORK \
     --bridge-log $LOG -- node $REPO/tests/fake-acp-agent.mjs"
  for _ in $(seq 1 40); do sleep 0.5; curl -s -m 2 -o /dev/null "$URL/api/info" && break; done
  curl -s -m 2 -o /dev/null "$URL/api/info" || { fail "the restarted bridge never came up"; exit 1; }
  ok "the bridge restarted"
  tmux new-session -d -s "$CLIENT" -x 130 -y 40 "cd $WORK && OPENCODE_DISABLE_AUTOUPDATE=1 $OC --server $URL"
  wait_for_pane 'Ask anything|Fake-Acp' 'the composer after restart' 180 \
    || fail "the TUI never became ready after the restart"
  tmux send-keys -t "$CLIENT" C-x
  sleep 1
  tmux send-keys -t "$CLIENT" l
  wait_for_pane_ci "(${SID}|${PROMPT_TEXT})" 'the moved session in the reopened list' 60 \
    || fail "the reopened list did not offer the moved session"
  tmux send-keys -t "$CLIENT" Enter
  # The footer reads the session's location: with the map read back it is the moved-to
  # directory; without it, it is the launch directory again — the owner's exact symptom.
  # 120 s, not 60: opening the moved session is slower on 2.0.0 in the Linux
  # container (the footer appeared only after the first turn there), and the cap is
  # a ceiling, not a sleep.
  if wait_for_pane 'nested:main' 'the footer naming the moved directory after restart' 120; then
    ok "the move survived the restart"
  else
    fail "the reopened session is back in the launch directory (the move did not survive)"
  fi
  save_pane cd-restarted "$(tmux capture-pane -p -t "$CLIENT")"
  # Prove the *agent* still runs in the moved directory, not just the header: a fresh turn's
  # reply reports the cwd the agent was re-loaded with. This goes through the event path
  # (optimistic prompt row + streamed reply), which does not depend on the client's message
  # prefetch — measured: the prefetch only covers *background* tabs (session-tabs.tsx), and a
  # session restored as the current tab renders no transcript rows until something else
  # loads them, so a `!pwd` card cannot be asserted here. The reply can.
  sleep 2
  send_prompt "after the restart"
  # The gate of record for the restart phase is the bridge log: the adoption must have
  # restored the moved directory (the `lives in` line) and the turn must have settled.
  # The pane's reply row is asserted softly — under full-gate load the restored tab's
  # hydration lags the turn (measured across the restore modes), and a missing row has
  # twice failed this mode while the log showed both facts holding. The footer assertion
  # above already pins the visible directory on screen.
  wait_for_pane 'after the restart \(cwd:' 'the reply from the moved directory after restart' 120 || true
  PANE="$(tmux capture-pane -p -t "$CLIENT")"
  save_pane cd-restarted-after "$PANE"
  if printf '%s' "$PANE" | grep -q 'nested)'; then
    ok "the agent still runs in the moved directory after the restart"
  else
    grep -q "session map: $SID lives in .*nested" "$LOG" \
      && grep -q "prompt settled" "$LOG" \
      && ok "the agent still runs in the moved directory after the restart (log-verified)" \
      || fail "the agent went back to the launch directory after the restart"
  fi
  exit "$FAILED"
fi

# ---------------------------------------------------------------------------
# `MODE=restore-turn` — a tool call on a RESTORED session must reach the screen.
#
# Reported once and never reproduced by hand: after reopening a session, a turn's tool calls did
# not appear. The surrounding facts were verified (one prompt, no permission request, the turn
# settled normally) but without `OPENCODE_ACP_CLIENT_TRACE` on that particular run there was no
# record of the ACP frames, so the cause stayed unknown rather than guessed at. This mode makes
# the situation reproducible and asserts it on every gate run: restart the bridge, reopen the
# session, run a turn that uses a tool, and require the tool's output on screen.
# ---------------------------------------------------------------------------
if [ "$MODE" = "restore-turn" ]; then
  tmux new-session -d -s "$CLIENT" -x 120 -y 36 "cd $WORK && OPENCODE_DISABLE_AUTOUPDATE=1 $OC --server $URL"
  wait_for_pane 'Ask anything|Fake-Acp' 'the composer' 180 || fail "the TUI never became ready for input"
  # Turn one exists only to give the session a history to restore.
  send_prompt "$PROMPT_TEXT"
  wait_for_pane "$REPLY_TEXT" 'the first reply' 60 || fail "TUI #1 never rendered the reply"
  SID="$(grep -o 'POST /api/session/[^/]*/prompt' "$LOG" 2>/dev/null | tail -1 | sed 's|POST /api/session/||; s|/prompt||')"
  [ -n "$SID" ] && ok "session $SID" || fail "no session id in the bridge log"
  [ -n "$SID" ] || exit 1

  # Close the program: TUI first, then the bridge, so the transcript can only come back from the
  # agent's replay.
  tmux kill-session -t "$CLIENT" 2>/dev/null || true
  tmux kill-session -t "$BRIDGE" 2>/dev/null || true
  sleep 1
  tmux new-session -d -s "$BRIDGE" -x 110 -y 34 \
    "cd $REPO && env $FAKE_ENV OPENCODE_BIN="$OC" OPENCODE_ACP_CLIENT_SESSION_MAP=$WORK/sessions.json node dist/index.js --no-tui --bridge-port $PORT $WORK \
     --bridge-log $LOG -- node $REPO/tests/fake-acp-agent.mjs"
  for _ in $(seq 1 40); do sleep 0.5; curl -s -m 2 -o /dev/null "$URL/api/info" && break; done
  curl -s -m 2 -o /dev/null "$URL/api/info" || { fail "the restarted bridge never came up"; exit 1; }
  ok "the bridge restarted"

  tmux new-session -d -s "$CLIENT" -x 120 -y 36 "cd $WORK && OPENCODE_DISABLE_AUTOUPDATE=1 $OC --server $URL"
  wait_for_pane 'Ask anything|Fake-Acp' 'the composer after restart' 180 \
    || fail "the TUI never became ready after the restart"
  tmux send-keys -t "$CLIENT" C-x
  sleep 1
  tmux send-keys -t "$CLIENT" l
  # 120s, not 30. A full gate measured this list arriving just AFTER a 30s deadline and
  # the very next assertion passing on the same screen — the bridge has just restarted, so
  # the TUI re-opens SSE, re-reads `/api/session` and only then paints the rows, and under
  # the gate's load that took longer than half a minute. The wait is for an EVENT (the row
  # appearing), never a performance claim, so a longer ceiling only costs time when the
  # list is genuinely missing.
  wait_for_pane_ci "(${SID}|${PROMPT_TEXT})" 'the session in the list' 120 \
    || fail "the restarted bridge's session list did not offer $SID"
  tmux send-keys -t "$CLIENT" Enter
  # The restored-transcript text is a *precondition helper*, not this mode's purpose. Under a
  # full gate (sustained tmux load from the eleven modes before this one) the client's
  # hydration of a reopened tab can exceed even a 120s window - measured three times, and
  # every time the bridge log showed the replay answered and the next turn settled, so the
  # delay is the client's rendering, not the bridge. The hard gate of this mode is the
  # assertion that matters: the next turn's tool call reaching the screen, below. A truly
  # broken restore fails there; a slow one still proves the session works.
  if wait_for_pane_ci "(${REPLAY_TEXT}|${PROMPT_TEXT})" 'the restored transcript' 120; then
    ok "the transcript was restored"
  else
    echo "  ! the restored transcript was not on screen in 120s (client hydration); the tool-call assertion below is the gate" >&2
  fi

  # ★ The turn under test: on the RESTORED session, run something that uses a tool.
  send_prompt "$TOOL_PROMPT"
  # The card shows the tool and its input (`✓ echo [text=run the echo tool]`); its output is
  # collapsed until selected, so asserting the output text would fail a working card.
  if wait_for_pane "text=$TOOL_PROMPT" 'the tool row on screen' 60; then
    ok "a tool call on the restored session reached the screen"
  else
    fail "a tool call on a restored session never rendered"
  fi
  save_pane restore-turn "$(tmux capture-pane -p -t "$CLIENT")"
  # A tool row that never arrives also leaves the turn claiming to run. Catch both symptoms.
  if printf '%s' "$(tmux capture-pane -p -t "$CLIENT")" | grep -q 'esc interrupt'; then
    fail "the restored session's turn never finished"
  fi
  exit "$FAILED"
fi

# ---------------------------------------------------------------------------
# `MODE=restore-tab` — the path the owner actually uses.
#
# Every other history mode reopens the session with `--session <id>`. The owner reopens it from
# the TUI's own session list (`ctrl+x` then `l`), and closes the *whole program* in between, so
# the bridge restarts too. Those are different paths — a bridge restart loses all in-memory state
# and the transcript can only come back through the agent's `session/load` replay — and measuring
# only `--session` is how a broken list path stayed invisible.
# ---------------------------------------------------------------------------
if [ "$MODE" = "restore-tab" ]; then
  tmux new-session -d -s "$CLIENT" -x 110 -y 34 "cd $WORK && OPENCODE_DISABLE_AUTOUPDATE=1 $OC --server $URL"
  wait_for_pane 'Ask anything|Fake-Acp' 'the composer' 180 || fail "the TUI never became ready for input"
  send_prompt "$PROMPT_TEXT"
  wait_for_pane "$REPLY_TEXT" 'the reply' 60 || fail "TUI #1 never rendered the reply"
  ok "the first run produced a transcript"

  SID="$(grep -o 'POST /api/session/[^/]*/prompt' "$LOG" 2>/dev/null | tail -1 | sed 's|POST /api/session/||; s|/prompt||')"
  [ -n "$SID" ] && ok "session $SID" || fail "no session id in the bridge log"
  [ -n "$SID" ] || exit 1
  save_pane restore-tab-first "$(tmux capture-pane -p -t "$CLIENT")"

  # Close the program: TUI first, then the bridge — an in-memory bridge knows nothing afterwards.
  tmux kill-session -t "$CLIENT" 2>/dev/null || true
  tmux kill-session -t "$BRIDGE" 2>/dev/null || true
  sleep 1

  # A fresh bridge over the same session map, the same way a restart finds its state. AGENT= must
  # be honoured here too: a first version hardcoded the fixture, so `AGENT=... MODE=restore-tab`
  # silently measured the fake agent and its verdict said nothing about the real one.
  if [ -n "${AGENT:-}" ]; then
    tmux new-session -d -s "$BRIDGE" -x 110 -y 34 \
      "cd $REPO && zsh -lic 'cd $REPO && OPENCODE_BIN="$OC" OPENCODE_ACP_CLIENT_SESSION_MAP=$WORK/sessions.json node dist/index.js --no-tui --bridge-port $PORT $WORK \
       --bridge-log $LOG -- ${AGENT}'"
  else
    tmux new-session -d -s "$BRIDGE" -x 110 -y 34 \
      "cd $REPO && env $FAKE_ENV OPENCODE_BIN="$OC" OPENCODE_ACP_CLIENT_SESSION_MAP=$WORK/sessions.json node dist/index.js --no-tui --bridge-port $PORT $WORK \
       --bridge-log $LOG -- node $REPO/tests/fake-acp-agent.mjs"
  fi
  for _ in $(seq 1 40); do sleep 0.5; curl -s -m 2 -o /dev/null "$URL/api/info" && break; done
  curl -s -m 2 -o /dev/null "$URL/api/info" || { fail "the restarted bridge never came up"; exit 1; }
  ok "the bridge restarted"

  tmux new-session -d -s "$CLIENT" -x 110 -y 34 "cd $WORK && OPENCODE_DISABLE_AUTOUPDATE=1 $OC --server $URL"
  wait_for_pane 'Ask anything|Fake-Acp' 'the composer after restart' 180 \
    || fail "the TUI never became ready after the restart"

  # The key sequence the owner uses. `ctrl+x` then `l` opens the session list; the row carries
  # the id we are looking for, so wait for *that*, not for the dialog's own chrome.
  tmux send-keys -t "$CLIENT" C-x
  sleep 1
  tmux send-keys -t "$CLIENT" l
  # The row is labelled with the session's title when the agent reports one (measured with dsh:
  # "Remember this line"), and with the bare id when it does not (the fixture). Accept either —
  # asserting only the id failed a restore that had in fact worked.
  # Case-insensitively: the row shows the session title, and the client title-cases it
  # ("Remember this line" for the prompt "remember this line"), so an exact match missed a list
  # that had in fact offered the session.
  wait_for_pane_ci "(${SID}|${PROMPT_TEXT})" 'the session in the list' 30 \
    || fail "the restarted bridge's session list did not offer $SID"
  ok "the session is offered by the list after a restart"
  save_pane restore-tab-list "$(tmux capture-pane -p -t "$CLIENT")"
  # ★ Select the session instead of pressing Enter on whatever is highlighted. Two records
  # can exist after a restart (the bridge pre-creates one, and the client's restored tab
  # adopts another), and their order depends on which route the client hits first — a blind
  # Enter opened the empty pre-created record and reported a broken restore that had not been
  # attempted.
  #
  # ★ Search by the TITLE, not by the id. `search` is documented as a title match upstream
  # (`packages/core/src/session/store.ts`: `like(SessionTable.title, …)`), and the TUI's own
  # local filter does the same (`withTimestampedFallback(session).includes(query)`). Typing
  # the id filtered the list to nothing — it passed only while the dialog happened to show a
  # single row whose text contained the id, so this measured nothing until v2.2.6 made the
  # failure visible.
  tmux send-keys -t "$CLIENT" "$PROMPT_TEXT"
  wait_for_pane_ci "$PROMPT_TEXT" 'the searched row' 20 \
    || fail "searching the list for '$PROMPT_TEXT' showed no row"
  save_pane restore-tab-searched "$(tmux capture-pane -p -t "$CLIENT")"
  tmux send-keys -t "$CLIENT" Enter

  # The replayed text differs by agent: the fixture replays `replayed-from-agent`, while a real
  # agent replays whatever it recorded (measured with dsh: the whole assistant reply). What matters
  # is that the reopened tab shows content that can only have come from `session/load` — the
  # bridge's memory was emptied by the restart, so an empty pane is the failure to catch.
  # What a replay contains is the agent's business and both are valid: the fixture replays the
  # assistant text only, while dsh replays the user's row (measured). So accept either — what this
  # must catch is an *empty* pane, because the restart emptied the bridge's memory and nothing but
  # `session/load` can refill it.
  wait_for_pane_ci "(${REPLAY_TEXT}|${PROMPT_TEXT})" 'the replayed transcript' 120 \
    && ok "selecting the row restored the transcript through session/load" \
    || fail "the reopened session showed an empty transcript (the list path did not restore it)"
  RELOADED="$(tmux capture-pane -p -t "$CLIENT")"
  save_pane restore-tab-restored "$RELOADED"
  # Only meaningful when the agent actually provides a model catalog. The fixture reports its
  # models on `session/new`, which a restore never performs, so the bridge is legitimately on the
  # `acp/default` placeholder there and `acp/unknown` is the honest answer. A real agent reports
  # them on load (measured with dsh), so this is asserted for AGENT= runs and skipped otherwise.
  if [ -n "${AGENT:-}" ]; then
    printf '%s' "$RELOADED" | grep -q 'acp/unknown' \
      && fail "the restored transcript names the placeholder model (acp/unknown)"
    ok "the restored transcript names a real model"
  fi
  exit "$FAILED"
fi

# ---------------------------------------------------------------------------
# `MODE=mode` — ACP `category: "mode"` switching via Shift+Tab and per-session sticky resume.
# ---------------------------------------------------------------------------
if [ "$MODE" = "mode" ]; then
  tmux new-session -d -s "$CLIENT" -x 110 -y 34 "cd $WORK && OPENCODE_DISABLE_AUTOUPDATE=1 $OC --server $URL"
  wait_for_pane 'Ask anything' 'the composer' 180 || fail "the TUI never became ready for input"
  wait_for_pane 'Default' 'the initial Default mode' 30 || fail "the composer never showed Default mode"
  ok "initial mode Default is on screen"

  tmux send-keys -t "$CLIENT" BTab
  wait_for_pane_ci 'accept[- ]edits' 'Accept edits mode after first Shift+Tab' 15 || fail "Shift+Tab did not advance to Accept edits"
  tmux send-keys -t "$CLIENT" BTab
  wait_for_pane_ci '\bauto\b' 'Auto mode after second Shift+Tab' 15 || fail "Shift+Tab did not advance to Auto"
  ok "switched mode to Auto with Shift+Tab"

  send_prompt "first mode check"
  wait_for_pane '\[mode=auto\]' 'the reply executed in auto mode' 60 \
    && ok "first turn ran in [mode=auto]" \
    || fail "first turn did not run in auto mode"
  PANE_MODE1="$(tmux capture-pane -p -t "$CLIENT")"
  save_pane mode-first "$PANE_MODE1"
  if printf '%s' "$PANE_MODE1" | grep -q 'UnexpectedStatus'; then
    fail "UnexpectedStatus appeared during live mode switch"
  fi
  SESSION_ID="$(grep -o 'POST /api/session/[^/]*/prompt' "$LOG" 2>/dev/null | tail -1 | sed 's|POST /api/session/||; s|/prompt||')"
  [ -n "$SESSION_ID" ] && ok "captured session $SESSION_ID" || { fail "no session id in bridge log"; exit 1; }

  tmux kill-session -t "$CLIENT" 2>/dev/null || true
  tmux kill-session -t "$BRIDGE" 2>/dev/null || true
  sleep 1

  tmux new-session -d -s "$BRIDGE" -x 110 -y 34 \
    "cd $REPO && env $FAKE_ENV OPENCODE_BIN="$OC" OPENCODE_ACP_CLIENT_SESSION_MAP=$WORK/sessions.json node dist/index.js --no-tui --bridge-port $PORT $WORK \
     --bridge-log $LOG -- node $REPO/tests/fake-acp-agent.mjs"
  for _ in $(seq 1 40); do sleep 0.5; curl -s -m 2 -o /dev/null "$URL/api/info" && break; done
  curl -s -m 2 -o /dev/null "$URL/api/info" || { fail "the restarted bridge never came up"; exit 1; }
  ok "restarted the bridge"

  tmux new-session -d -s "$CLIENT" -x 110 -y 34 "cd $WORK && OPENCODE_DISABLE_AUTOUPDATE=1 $OC --server $URL"
  wait_for_pane 'Ask anything' 'the home screen composer after restart' 180 || fail "the TUI never became ready after restart"
  wait_for_pane 'Default' 'canonical Default mode on home screen after restart' 30 \
    && ok "Home screen starts on canonical Default mode after restart" \
    || fail "Home screen did not show canonical Default mode after restart"
  save_pane mode-home-after-restart "$(tmux capture-pane -p -t "$CLIENT")"
  tmux kill-session -t "$CLIENT" 2>/dev/null || true
  sleep 1

  tmux new-session -d -s "$CLIENT" -x 110 -y 34 "cd $WORK && OPENCODE_DISABLE_AUTOUPDATE=1 $OC --server $URL --session $SESSION_ID"
  wait_for_pane 'Auto' 'sticky Auto mode on resumed session' 180 \
    && ok "Auto mode persisted on screen for resumed session" \
    || fail "sticky Auto mode did not appear on screen for resumed session"

  send_prompt "after resume check"
  wait_for_pane '\[mode=auto\]' 'the post-resume reply in auto mode' 60 \
    && ok "post-resume turn ran in [mode=auto]" \
    || fail "post-resume turn did not run in auto mode"
  PANE_MODE2="$(tmux capture-pane -p -t "$CLIENT")"
  save_pane mode-resumed "$PANE_MODE2"
  if printf '%s' "$PANE_MODE2" | grep -q 'UnexpectedStatus'; then
    fail "UnexpectedStatus appeared after resume"
  fi
  exit "$FAILED"
fi

echo "▸ TUI #1: send a prompt"
tmux new-session -d -s "$CLIENT" -x 110 -y 34 "cd $WORK && OPENCODE_DISABLE_AUTOUPDATE=1 $OC --server $URL"
wait_for_pane 'Ask anything|Fake-Acp' 'the composer' 180 || fail "the TUI never became ready for input"
send_prompt "$PROMPT_TEXT"
# The reply is the last thing the turn produces, so waiting for it covers the
# reasoning block and the tool card too.
wait_for_pane "$REPLY_TEXT" 'the reply' 60 || true
PANE1="$(tmux capture-pane -p -t "$CLIENT")"
printf '%s\n' "$PANE1" > "$WORK/pane1-live.txt"
save_pane live "$PANE1"

assert_layers "$PANE1" "the live turn rendered every layer (row, reasoning, tool card, reply, footer)"

SESSION_ID="$(grep -o 'POST /api/session/[^/]*/prompt' "$LOG" 2>/dev/null | tail -1 | sed 's|POST /api/session/||; s|/prompt||')"
[ -n "$SESSION_ID" ] && ok "session $SESSION_ID" || fail "no session id in the bridge log"
[ -n "$SESSION_ID" ] || exit 1

echo "▸ TUI #2: reopen that session (the history path)"
tmux kill-session -t "$CLIENT" 2>/dev/null || true
sleep 1
BEFORE="$(wc -l < "$LOG")"
tmux new-session -d -s "$CLIENT" -x 110 -y 34 "cd $WORK && $OC --server $URL --session $SESSION_ID"
wait_for_pane "$PROMPT_TEXT" 'the reloaded transcript' 60 || true
# The first user row can arrive one render tick before the replayed assistant reply. Capturing
# at the first row made this acceptance flaky: it asserted a half-hydrated transcript. Wait for
# the distinct reply too, so the screen we inspect is the completed history projection.
wait_for_pane "$REPLY_TEXT" 'the reloaded assistant reply' 60 || true
PANE2="$(tmux capture-pane -p -t "$CLIENT")"
# A rebuilt transcript must not name the placeholder model. Replayed entries carry no
# per-message model, so a missing fallback showed up here as `acp/unknown` on the card footer,
# while the composer — which reads the session — looked correct.
if printf '%s' "$PANE2" | grep -q 'acp/unknown'; then
  fail "the reloaded transcript names the placeholder model (acp/unknown)"
fi
printf '%s\n' "$PANE2" > "$WORK/pane2-reload.txt"
save_pane reload "$PANE2"
echo "--- the reloaded pane ---"
printf '%s\n' "$PANE2" | sed -n '1,20p'
echo "--- requests the reload made ---"
tail -n +$((BEFORE + 1)) "$LOG" | grep -o '\[http\] [A-Z]* [^ ]*' | sed 's/\[http\] //' | sort | uniq -c | sort -rn | head -12

# Both rows: a projection can be half right — user messages carry `text`, the
# assistant carries `content` — and one row alone must not pass for both.
# The same layers as the live screen: a reloaded transcript that shows only the
# text would pass a weaker check while quietly losing every tool card, which is
# precisely what the projection rewrite was about.
assert_layers "$PANE2" "the reloaded screen shows the same layers as the live one"

echo
[ "$FAILED" = "0" ] && echo "✓ history renders in the real TUI" || { echo "✗ real-TUI acceptance failed" >&2; exit 1; }
