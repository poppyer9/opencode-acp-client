/**
 * Scenario-engine assertions: what the client does when an agent misbehaves,
 * fails, or leaves something unfinished.
 *
 * These drive the **real** stack — the bridge spawns the fake agent over stdio,
 * the assertions read the HTTP surface the TUI reads — so a green run here means
 * the client behaved, not that the agent echoed what it was told. The agents are
 * selected with `FAKE_ACP_SCENARIO`, which is one coherent set of behaviours
 * rather than a pile of flags (see `tests/fake-acp-agent.mjs`).
 */
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { removeDirSync } from './remove-dir.js';
import { basename, dirname} from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { BridgeServer, derivedTitle, markTitle, projectIdFor } from '../src/server.js';
import { resolveSessionId } from '../src/index.js';

const FAKE_AGENT = fileURLToPath(new URL('./fake-acp-agent.mjs', import.meta.url));
/** Helper scripts `writeBytes` creates; removed when the suite exits. */
const SCRIPT_FILES: string[] = [];

/**
 * A shell command that writes `text` with no trailing newline, on any platform.
 *
 * `printf` is POSIX-only: cmd.exe answers "not recognized" and produces no output, which made
 * the shell tests fail on Windows for a missing utility rather than for the behaviour they
 * exercise. `node -e` is guaranteed — the suite itself runs on it — and the bytes are written
 * directly so the UTF-8 case is exact.
 */
/**
 * A command that writes `first`, waits, then writes `second` — the paged-output fixture.
 *
 * Same quoting hazard as `writeBytes`: the code cannot ride on the command line. It is a script
 * file, quoted per platform.
 */
function twoStageWrite(): string {
  const base = join(tmpdir(), `oac-twostage-${process.pid}`);
  const script = `${base}.mjs`;
  writeFileSync(
    script,
    "process.stdout.write('first');\nsetTimeout(() => process.stdout.write('second'), 200);\n",
    'utf8',
  );
  SCRIPT_FILES.push(script);
  return runnable(base);
}

/**
 * A command line that runs `<base>.mjs`, with the shell quoting kept out of it.
 *
 * The bridge runs `!command` through `cmd.exe` on Windows (`shell: true`). A quoted path inside
 * that string loses its quotes and node then received a path it could not open — it exited 0
 * and wrote **zero bytes**, twice, which is what kept two shell tests red through several
 * attempts at the fixtures themselves. POSIX gets the quoting it needs, because `/bin/sh`
 * honours it there; Windows gets a `.cmd` shim instead, so the command line carries no quotes.
 */
function runnable(base: string): string {
  if (process.platform !== 'win32') return `"${process.execPath}" "${base}.mjs"`;
  const shim = `${base}.cmd`;
  writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0${basename(base)}.mjs"\r\n`, 'utf8');
  SCRIPT_FILES.push(shim);
  return shim;
}

function writeBytes(bytes: number[]): string {
  // ★ A script FILE, not `node -e '<code>'`: the shell the bridge spawns is cmd.exe on
  // Windows, which strips the quotes that keep the code together, so the command failed and
  // wrote nothing — measured in CI, where the poll never saw a byte and the test failed for a
  // quoting accident. The path is quoted per platform and holds no spaces (tmpdir), and the
  // script is removed when the suite exits.
  // ★ Windows: the command runs through `cmd.exe` (the bridge spawns with `shell: true`), and
  // a quoted path in that string does not survive — measured in CI: `exit=0` with **0 bytes**,
  // twice, for the same script. So the runnable is a `.cmd` wrapper holding the quoting, and
  // the command line names only that file (which lives in tmpdir and has no spaces).
  const base = join(tmpdir(), `oac-write-${process.pid}-${bytes.join('_')}`);
  const script = `${base}.mjs`;
  writeFileSync(script, `process.stdout.write(Buffer.from([${bytes.join(',')}]));\n`, 'utf8');
  SCRIPT_FILES.push(script);
  return runnable(base);
}


/**
 * The directory a path names, spelled one way, for comparisons across platforms.
 *
 * `realpath` covers two things a plain string comparison does not: macOS turns `/var/…` into
 * `/private/var/…`, and Windows may answer with an 8.3 short name (`RUNNER~1`). Note that
 * `.native` alone is NOT enough there — measured on windows-latest, it returned the short form
 * unchanged, so both sides still disagreed. `realpathSync` (the JS implementation) expands the
 * short name on Windows, which is what makes the comparison work.
 */
function sameDir(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // A path that no longer exists cannot disagree about its spelling; compare as given.
    return p;
  }
}


/** Temp directories to remove once the servers are closed — see `afterEach`. */
const deferredRemovals: string[] = [];

const servers: BridgeServer[] = [];
const logs: string[] = [];

/**
 * Start a bridge the way the single-entry launch does: it resolves the model catalog before the
 * client connects (`waitForCatalog()` in src/index.ts). Tests about restored sessions need this,
 * because a bridge that never warmed the catalog is still serving the `acp/default` placeholder —
 * which is exactly the state the reporter's client is not in.
 */
async function startLaunched(scenario: string, extra: Record<string, string> = {}): Promise<string> {
  const url = await start(scenario, extra);
  const server = servers[servers.length - 1]!;
  await server.waitForCatalog(5_000);
  return url;
}

async function start(scenario: string, extra: Record<string, string> = {}): Promise<string> {
  const server = new BridgeServer({
    command: process.execPath,
    args: [FAKE_AGENT],
    directory: process.cwd(),
    port: 0,
    env: { FAKE_ACP_SCENARIO: scenario, FAKE_ACP_MODELS: '1', ...extra },
    onLog: (line) => logs.push(line),
  });
  servers.push(server);
  const { host, port } = await server.listen();
  return `http://${host}:${port}`;
}

afterAll(() => {
  for (const file of SCRIPT_FILES.splice(0)) {
    try {
      rmSync(file, { force: true });
    } catch {
      /* best effort */
    }
  }
});

afterEach(async () => {
  while (servers.length) await servers.pop()?.close();
  // ★ Temp directories are removed HERE, not in each test's `finally`: the fixture's agent
  // child is only reaped by `close()`, and on Windows a process whose cwd is a directory
  // locks it until it exits. A `finally` runs before this hook, so it raced a live agent and
  // answered EBUSY — six seconds of retries were not enough because the child was still
  // there. Deferred, the removal happens after the child is gone.
  for (const dir of deferredRemovals.splice(0)) deferredRemovals.push(dir);
  logs.length = 0;
});

interface Info {
  id: string;
  time?: { completed?: number };
}

const createSession = async (url: string): Promise<string> => {
  const response = await fetch(`${url}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  return ((await response.json()) as { data: Info }).data.id;
};

/** Run one turn and wait for it to settle, so nothing is asserted mid-flight. */
async function runTurn(url: string, session: string, text = 'go'): Promise<void> {
  await fetch(`${url}/api/session/${session}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const active = (await (await fetch(`${url}/api/session/active`)).json()) as {
      data: Record<string, unknown>;
    };
    if (!(session in (active.data ?? {}))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the turn never settled');
}

const messages = async (url: string, session: string) =>
  (
    (await (await fetch(`${url}/api/session/${session}/message`)).json()) as {
      data: Array<{ type?: string; content?: Array<Record<string, unknown>>; error?: unknown }>;
    }
  ).data;

const toolsOf = (items: Awaited<ReturnType<typeof messages>>) =>
  items
    .flatMap((item) => item.content ?? [])
    .filter((entry) => entry.type === 'tool') as Array<{
    name: string;
    state: { status: string };
  }>;

describe('a tool call whose ACP id looks like a content part', () => {
  it('gets the bridge\'s own row id, so classification never depends on id shape', async () => {
    // The official suite proves the client classifies a live tool row from the *event* and not
    // from the id's shape, by emitting `session.tool.input.started` with the id `reasoning:0`
    // (`cli/tui/data.test.tsx:1069`). That test drives the client with a stubbed transport, so the
    // half it constrains here is the bytes: a bridge that passed the raw ACP call id straight
    // through as the row id would hand the client an id shaped like a content part. Measured, ours
    // maps it to its own `prt_*` — this pins that.
    const url = await start('rich-turn', { FAKE_ACP_ADVERSARIAL_TOOL_ID: '1', FAKE_ACP_REPLY: 'ok' });
    const session = await createSession(url);
    await runTurn(url, session);

    const items = await messages(url, session);
    // `rich-turn` also emits its own tool, so select the adversarial one by name rather than by
    // assuming it is the only row.
    const tools = toolsOf(items).filter((row) => row.name === 'bash');
    expect(tools).toHaveLength(1);
    const tool = tools[0]!;
    expect(tool.state.status).toBe('completed');
    // The row id is the bridge's own, never the ACP call id. Scoped to the id field: an earlier
    // version searched the whole payload, where the call id legitimately appears elsewhere (it is
    // what correlates later updates to this row).
    expect(tool.id).toMatch(/^prt_/);
    expect(tool.id).not.toBe('reasoning:0');
  });
});

describe('a tool whose input arrives after the pending frame (opencode\'s shape)', () => {
  it('creates the row with the command, not the pending cwd-only snapshot', async () => {
    // Measured on opencode v2.0.32: `tool_call` is `{cwd}` with `status: pending`, the
    // command arrives in the `in_progress` update, and completion adds
    // `rawOutput.metadata`. The TUI's shell card reads `input.command` and only leaves
    // "Writing command…" when it exists, so publishing the pending snapshot left every
    // card stuck on that label; the search card had the same problem with `input.query`.
    const url = await start('rich-turn', { FAKE_ACP_TOOL_STAGES: '1', FAKE_ACP_REPLY: 'ok' });
    const session = await createSession(url);
    const stream = await sseDuring(url, () => runTurn(url, session));

    const events = stream
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as { type: string; data: Record<string, unknown> });
    const of = (type: string) => events.filter((event) => event.type === type).map((event) => event.data);

    // The row is created at in_progress, with the stable tool name ("shell", not the
    // later title "echo hello" — the TUI picks its component by this name). `rich-turn`
    // has a tool of its own, so look the two up rather than assume they are the only ones.
    const names = of('session.tool.input.started').map((data) => data['name']);
    expect(names).toContain('shell');
    expect(names).toContain('websearch');
    expect(names.indexOf('shell')).toBeLessThan(names.indexOf('websearch'));
    expect(JSON.stringify(of('session.tool.input.ended'))).toContain('echo hello');

    const called = of('session.tool.called');
    expect(called.find((data) => (data['input'] as Record<string, unknown>)['command'] === 'echo hello')).toMatchObject({
      input: { command: 'echo hello', cwd: '/tmp' },
    });
    expect(called.find((data) => (data['input'] as Record<string, unknown>)['query'] === 'opencode v2')).toBeTruthy();

    // Completion carries the agent's own metadata and output text; failure carries its
    // reason. Both used to be flattened to `{}` / "tool failed".
    const success = of('session.tool.success').find((data) => data['metadata'] && (data['metadata'] as Record<string, unknown>)['exit'] === 0)!;
    expect(success['metadata']).toMatchObject({ exit: 0, status: 'completed' });
    expect(JSON.stringify(success['content'])).toContain('hello');
    // The failure carries a STRUCTURED error, because opencode v2's tool part declares
    // `state.error: {type, message}` and its renderer reads `.message` — a bare string made
    // the real TUI crash with "Expected a `string`, got `undefined`".
    const failed = of('session.tool.failed').find(
      (data) => (data['error'] as { message?: string } | undefined)?.message === 'Web search cancelled',
    )!;
    expect(failed).toBeTruthy();
    expect(failed['error']).toEqual({ type: 'tool', message: 'Web search cancelled' });
    expect(JSON.stringify(failed['content'])).toContain('Web search cancelled');
  });
});

describe('paging a transcript the client keeps asking for', () => {
  it('lets a repeated request for the same cursor succeed after a bad one', async () => {
    const url = await start('rich-turn', { FAKE_ACP_REPLY: 'paged reply' });
    const session = await createSession(url);
    for (const text of ['one', 'two', 'three']) await runTurn(url, session, text);

    // The official suite has a case for this (`cli/tui/session-history.test.ts:33`, "releases the
    // history load after a failed request"): a page that failed must not poison the next request
    // for the same cursor. That test drives the client's own retry gate, so what it constrains
    // here is that the server side stays usable across a failure — the route must not remember a
    // broken attempt, hold a lock, or advance a cursor of its own.
    const first = (await (await fetch(`${url}/api/session/${session}/message?limit=2`)).json()) as {
      data: Array<{ id: string }>;
      cursor: { next: string | null };
    };
    const cursor = first.cursor.next;
    expect(cursor).toBeTruthy();

    // A request the client could not have meant — measured, the route answers 200 and treats it as
    // "start from the top" rather than failing. That is the honest reading of "a failed request
    // must not poison the next one": this route cannot fail on a cursor, so there is nothing to
    // leak into the next attempt.
    const nonsense = await fetch(`${url}/api/session/${session}/message?limit=2&cursor=%00%00nonsense`);
    expect(nonsense.status).toBe(200);
    const nonsensePage = (await nonsense.json()) as { data: unknown[] };
    expect(nonsensePage.data.length).toBeGreaterThan(0);

    // A cursor past the end is a clean empty page with no continuation, not an error.
    const past = (await (
      await fetch(`${url}/api/session/${session}/message?limit=2&cursor=99999`)
    ).json()) as { data: unknown[]; cursor: { next: string | null } };
    expect(past.data).toEqual([]);
    expect(past.cursor.next).toBeNull();

    // And the real cursor still works immediately afterwards.
    const retry = (await (
      await fetch(`${url}/api/session/${session}/message?limit=2&cursor=${encodeURIComponent(cursor!)}`)
    ).json()) as { data: Array<{ id: string }>; cursor: { next: string | null } };
    expect(retry.data).toHaveLength(2);
    // The second page continues from the first rather than repeating it.
    const firstIds = new Set(first.data.map((m) => m.id));
    for (const row of retry.data) expect(firstIds.has(row.id)).toBe(false);
    // And the same cursor asked twice returns the same page, rather than drifting.
    const again = (await (
      await fetch(`${url}/api/session/${session}/message?limit=2&cursor=${encodeURIComponent(cursor!)}`)
    ).json()) as { data: Array<{ id: string }> };
    expect(again.data.map((m) => m.id)).toEqual(retry.data.map((m) => m.id));
  });

  it("keeps two sessions' pagination independent while both are being paged", async () => {
    const url = await start('rich-turn', { FAKE_ACP_REPLY: 'paged reply' });
    const a = await createSession(url);
    const b = await createSession(url);
    for (const text of ['a-one', 'a-two', 'a-three']) await runTurn(url, a, text);
    for (const text of ['b-one', 'b-two']) await runTurn(url, b, text);

    // `cli/tui/session-history.test.ts:55` ("does not move a different session after history
    // loads") guards the client's scroll anchor when the session changes mid-load. The server-side
    // half of that contract is that a cursor belongs to one session and paging them together never
    // mixes rows — so page both, interleaved, and check every row is the right session's.
    const pageOf = async (session: string, cursor: string | null) => {
      const query = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2';
      return (await (await fetch(`${url}/api/session/${session}/message${query}`)).json()) as {
        data: Array<{ id: string; sessionID?: string }>;
        cursor: { next: string | null };
      };
    };

    const a1 = await pageOf(a, null);
    const b1 = await pageOf(b, null);
    const a2 = await pageOf(a, a1.cursor.next);
    const b2 = await pageOf(b, b1.cursor.next);

    for (const [session, pages] of [[a, [a1, a2]], [b, [b1, b2]]] as const) {
      const ids = pages.flatMap((page) => page.data.map((row) => row.id));
      expect(new Set(ids).size, `${session} repeated a row`).toBe(ids.length);
      for (const page of pages) {
        for (const row of page.data) expect(row.sessionID ?? session).toBe(session);
      }
    }
    // Both sessions were really paged: the second page of `a` is not empty.
    expect(a2.data.length).toBeGreaterThan(0);
  });
});

describe('transcript cursor pagination', () => {
  it('returns newest-first pages without duplicates and reaches a null cursor', async () => {
    const url = await start('rich-turn', { FAKE_ACP_REPLY: 'paged reply' });
    const session = await createSession(url);
    const prompts = ['page one', 'page two', 'page three'];
    for (const text of prompts) await runTurn(url, session, text);

    const seen: Array<{ id: string; text?: string; role?: string }> = [];
    let cursor: string | null = null;
    do {
      const query = cursor === null ? '?limit=2' : `?limit=2&cursor=${cursor}`;
      const page = (await (await fetch(`${url}/api/session/${session}/message${query}`)).json()) as {
        data: Array<{ id: string; text?: string; role?: string }>;
        cursor: { next: string | null };
      };
      expect(page.data).toHaveLength(2);
      seen.push(...page.data);
      cursor = page.cursor.next;
    } while (cursor !== null);

    expect(seen).toHaveLength(6); // one user and one assistant message per turn
    expect(new Set(seen.map((message) => message.id)).size).toBe(seen.length);
    expect(seen.filter((message) => message.role === 'user').map((message) => message.text)).toEqual([
      'page three',
      'page two',
      'page one',
    ]);
  });
});

describe('fs/find and image attachments from the TUI', () => {
  it('searches files for the @ autocomplete: substring, type filter, limit', async () => {
    // The TUI's @ attachment menu queries /api/fs/find; an always-empty answer
    // made every attachment search say "No matching files" — the entry point of
    // the whole image path was dead until this was implemented.
    const url = await start('rich-turn');
    const info = (await (await fetch(`${url}/api/info`)).json()) as {
      data?: { project?: { directory?: string } };
      location?: { directory?: string };
    };
    const root = info.data?.project?.directory ?? info.location?.directory ?? process.cwd();
    const find = async (params: string) =>
      (await (await fetch(`${url}/api/fs/find?location%5Bdirectory%5D=${encodeURIComponent(root)}&${params}`)).json()) as {
        data: Array<{ path: string; type: string }>;
      };
    const hit = await find('query=package.json&limit=5');
    expect(hit.data.some((e) => e.path === 'package.json' && e.type === 'file')).toBe(true);
    const dirs = await find('query=src&type=directory');
    expect(dirs.data.every((e) => e.type === 'directory')).toBe(true);
    const none = await find('query=definitely-not-here-xyz');
    expect(none.data).toEqual([]);
  });

  it('forwards a file:// image attachment as an ACP image block', async () => {
    // Measured v2.0.30: the TUI's @file picker sends {uri: "file://…", mime,
    // name} — NOT the base64 the schema's {data} suggests. The bridge reads the
    // file and inlines base64; the fake agent (image-capable) counts what
    // actually crossed the ACP wire in its reply.
    const url = await start('images', { FAKE_ACP_CAPS_IMAGES: '1' });
    const session = await createSession(url);
    const response = await fetch(`${url}/api/session/${session}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'what is this',
        files: [
          {
            uri: `file://${join(process.cwd(), 'tests/fixtures/red.png')}`,
            mime: 'image/png',
            name: 'red.png',
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    // The reply arrives via the turn's events; the transcript read races the
    // turn when a previous test's server shares the process. Poll briefly.
    let text = '';
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const reply = [...(await messages(url, session))].reverse().find((m) => m.type === 'assistant');
      text = JSON.stringify(reply?.content ?? []);
      if (text.includes('images:1')) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(text).toContain('images:1');
  });

  it('forwards a non-image file:// attachment as an ACP resource_link block', async () => {
    const url = await start('rich-turn', { FAKE_ACP_ECHO_PROMPT: '1' });
    const session = await createSession(url);
    const fileUri = `file://${join(process.cwd(), 'package.json')}`;
    const response = await fetch(`${url}/api/session/${session}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'see @package.json',
        files: [{ uri: fileUri, name: 'package.json' }],
      }),
    });
    expect(response.status).toBe(200);
    await runTurn(url, session);
    const reply = [...(await messages(url, session))]
      .reverse()
      .find((m) => m.type === 'assistant' && JSON.stringify(m.content ?? []).includes('ECHO'));
    const text = (reply?.content ?? [])
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('');
    const echoed = JSON.parse(text.slice(text.indexOf('['))) as Array<Record<string, unknown>>;
    expect(echoed).toContainEqual({
      type: 'resource_link',
      uri: fileUri,
      name: 'package.json',
    });
  });

  it('forwards directory file:// URIs (even with trailing slash) and preserves mimeType on resource_link', async () => {
    const url = await start('rich-turn', { FAKE_ACP_ECHO_PROMPT: '1' });
    const session = await createSession(url);
    const dirUri = `file://${join(process.cwd(), 'src')}/`;
    const fileUri = `file://${join(process.cwd(), 'package.json')}`;
    const response = await fetch(`${url}/api/session/${session}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'check @src and @package.json',
        files: [
          { uri: dirUri },
          { uri: fileUri, mime: 'application/json', name: 'package.json' },
        ],
      }),
    });
    expect(response.status).toBe(200);
    await runTurn(url, session);
    const reply = [...(await messages(url, session))]
      .reverse()
      .find((m) => m.type === 'assistant' && JSON.stringify(m.content ?? []).includes('ECHO'));
    const text = (reply?.content ?? [])
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('');
    const echoed = JSON.parse(text.slice(text.indexOf('['))) as Array<Record<string, unknown>>;
    expect(echoed).toContainEqual({
      type: 'resource_link',
      uri: dirUri,
      name: 'src',
    });
    expect(echoed).toContainEqual({
      type: 'resource_link',
      uri: fileUri,
      name: 'package.json',
      mimeType: 'application/json',
    });
  });
});

describe('terminal form reply and cancel races', () => {
  it('cancels via the DELETE spelling the shipped client actually uses', async () => {
    // The v2.0.28+ client's Esc-on-a-form is `DELETE /api/session/:id/form/:fid`
    // (spec-declared 204, optional `message` query) — not the older POST /cancel. The
    // bridge only had the POST spelling, so the DELETE fell through to the generic 404:
    // the form stayed open with a red "Error", and the agent's elicitation hung pending
    // forever (the owner's report: pressing Esc did nothing but show the error).
    const url = await start('elicit-form');
    const session = await createSession(url);
    const promptRequest = fetch(`${url}/api/session/${session}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'ask me' }),
    });

    let form: { id: string } | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      const body = (await (await fetch(`${url}/api/session/${session}/form`)).json()) as {
        data: Array<{ id: string }>;
      };
      form = body.data[0];
      if (form) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(form).toBeDefined();

    // Esc, exactly as the client sends it: DELETE, with the optional message query.
    const cancel = await fetch(
      `${url}/api/session/${session}/form/${form!.id}?message=${encodeURIComponent('dismissed')}`,
      { method: 'DELETE' },
    );
    expect(cancel.status).toBe(204);
    // The form is gone from every list the client reads.
    expect((await (await fetch(`${url}/api/session/${session}/form`)).json()).data).toEqual([]);
    expect((await (await fetch(`${url}/api/form`)).json()).data).toEqual([]);
    // And the agent really got its answer: the turn can only finish once the
    // elicitation is resolved, and the fixture streams what it received.
    expect((await promptRequest).status).toBe(200);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const active = (await (await fetch(`${url}/api/session/active`)).json()) as { data: Record<string, unknown> };
      if (!(session in active.data)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const reply = [...(await messages(url, session))]
      .reverse()
      .find((item) => item.type === 'assistant');
    const text = JSON.stringify(reply?.content ?? []);
    expect(text).toContain('cancel');
  });


  it('settles once, rejects stale reply/cancel with 404, and restores the turn', async () => {
    const url = await start('elicit-form');
    const session = await createSession(url);
    const promptRequest = fetch(`${url}/api/session/${session}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'ask me' }),
    });

    let form: { id: string } | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      const body = (await (await fetch(`${url}/api/session/${session}/form`)).json()) as {
        data: Array<{ id: string }>;
      };
      form = body.data[0];
      if (form) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(form).toBeDefined();
    const globalBefore = (await (await fetch(`${url}/api/form`)).json()) as { data: Array<{ id: string }> };
    const aliasBefore = (await (await fetch(`${url}/api/form/request`)).json()) as { data: Array<{ id: string }> };
    expect(globalBefore.data.map((entry) => entry.id)).toContain(form!.id);
    expect(aliasBefore.data.map((entry) => entry.id)).toContain(form!.id);

    const cancel = await fetch(`${url}/api/session/${session}/form/${form!.id}/cancel`, { method: 'POST' });
    expect(cancel.status).toBe(204);
    const staleCancel = await fetch(`${url}/api/session/${session}/form/${form!.id}/cancel`, { method: 'POST' });
    const staleReply = await fetch(`${url}/api/session/${session}/form/${form!.id}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer: { strategy: 'balanced' } }),
    });
    expect(staleCancel.status).toBe(404);
    expect(staleReply.status).toBe(404);
    expect((await (await fetch(`${url}/api/session/${session}/form`)).json()).data).toEqual([]);
    expect((await (await fetch(`${url}/api/form`)).json()).data).toEqual([]);
    expect((await (await fetch(`${url}/api/form/request`)).json()).data).toEqual([]);

    expect((await promptRequest).status).toBe(200);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const active = (await (await fetch(`${url}/api/session/active`)).json()) as { data: Record<string, unknown> };
      if (!(session in active.data)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const transcript = await messages(url, session);
    expect(JSON.stringify(transcript)).toContain('ELICIT');
    expect(JSON.stringify(transcript)).toContain('cancel');
  });
});

describe('prompt retries with the same client message id', () => {
  it('keeps one user row and one agent turn after a durable retry', async () => {
    const url = await start('rich-turn', { FAKE_ACP_REPLY: 'retry reply' });
    const session = await createSession(url);
    const body = { id: 'msg_retry_same_id', text: 'retry me' };
    const first = await fetch(`${url}/api/session/${session}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(200);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const active = (await (await fetch(`${url}/api/session/active`)).json()) as { data: Record<string, unknown> };
      if (!(session in active.data)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const retry = await fetch(`${url}/api/session/${session}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(retry.status).toBe(200);
    const transcript = await messages(url, session);
    expect(transcript.filter((message) => message.id === body.id)).toHaveLength(1);
    expect(transcript.filter((message) => JSON.stringify(message).includes('retry reply'))).toHaveLength(1);
  });
});

describe('an agent that leaves work unfinished', () => {
  it('closes a tool the agent never finished, instead of spinning forever', async () => {
    const url = await start('tools-many');
    const session = await createSession(url);
    await runTurn(url, session);

    const tools = toolsOf(await messages(url, session));
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['echo-ok', 'echo-fail', 'echo-open']),
    );
    // The failed one is terminal, and visibly so.
    expect(tools.find((tool) => tool.name === 'echo-fail')?.state.status).toBe('error');
    // ★ And the one the agent abandoned must not still be "running": a turn that
    // has ended while a tool claims to be in flight is a spinner that never stops.
    expect(tools.find((tool) => tool.name === 'echo-open')?.state.status).not.toBe('running');
  });
});

describe('an agent whose turn fails', () => {
  it('surfaces the failure and still settles the turn', async () => {
    const url = await start('error-turn');
    const session = await createSession(url);
    await runTurn(url, session);

    const items = await messages(url, session);
    const assistant = items.find((item) => item.type === 'assistant');
    expect(assistant).toBeTruthy();
    // What it managed to say is kept, and the failure is recorded on the turn.
    expect(JSON.stringify(assistant)).toContain('about to fail');
    expect(assistant?.error ?? JSON.stringify(assistant)).toBeTruthy();
  });
});

describe('an agent that breaks the rules', () => {
  it('logs the unknown and unadvertised updates, and still finishes the turn', async () => {
    const url = await start('hostile');
    const session = await createSession(url);
    await runTurn(url, session); // throws if the turn never settles

    // The bridge is still healthy after digesting all of it.
    expect((await fetch(`${url}/api/info`)).status).toBe(200);
    // And it said something about the update it did not understand, rather than
    // dropping it in silence.
    expect(logs.join('\n')).toMatch(/some_unknown_update_v9|unknown/i);
  });
});

describe('an agent that dies, dawdles, or interleaves', () => {
  it('settles the turn when the agent crashes mid-flight', async () => {
    const url = await start('crash');
    const session = await createSession(url);
    // The turn must end: neither a spinner nor a hung request survives it.
    await runTurn(url, session);
    const items = await messages(url, session);
    expect(JSON.stringify(items)).toContain('about to die');
  });

  it('keeps the order an agent interleaves thought, text and tools in', async () => {
    const url = await start('interleaved');
    const session = await createSession(url);
    await runTurn(url, session);
    const items = await messages(url, session);
    // The *assistant message's own* content, in order. (The list route hands the
    // messages over newest-first, because the client reverses them itself — so
    // flattening that list is not emission order.)
    const assistant = items.find((item) => item.type === 'assistant');
    const kinds = (assistant?.content ?? []).map((entry) => entry.type as string);
    // The fake agent emits thought → text → tool → thought → text. The typed history
    // projection must preserve that exact order, not merely retain every kind.
    expect(kinds).toEqual(['reasoning', 'text', 'tool', 'reasoning', 'text']);
  });

  it('reports a slow turn as finished once it is', async () => {
    const url = await start('slow');
    const session = await createSession(url);
    await runTurn(url, session);
  });
});

describe('an agent that answers a request with a JSON-RPC error', () => {
  it('surfaces the failure and settles the turn instead of hanging', async () => {
    const url = await start('error-response');
    const session = await createSession(url);
    // A rejected request must still end the turn: the client's own bookkeeping is
    // what stops the spinner, not the agent's cooperation.
    await runTurn(url, session);
    const items = await messages(url, session);
    expect(JSON.stringify(items)).toMatch(/refused|error/i);
  });
});

describe('an agent that produces a lot at once', () => {
  it('keeps a large tool result in the projection instead of dropping or mangling it', async () => {
    const url = await start('long-output');
    const session = await createSession(url);
    await runTurn(url, session);

    const tools = toolsOf(await messages(url, session));
    const big = tools.find((tool) => tool.name === 'big-output');
    expect(big).toBeTruthy();
    // 400 lines of 80-odd characters: if the projection truncated, dropped or
    // re-encoded this, the size would collapse and that is the failure we want.
    expect(JSON.stringify(big).length).toBeGreaterThan(10_000);
  });
});

describe('an agent that is slow to start', () => {
  it('still gets its models into the catalog, rather than leaving the placeholder', async () => {
    // A slow `session/new` is the case where waitForCatalog's deadline can bite:
    // fall back and /api/model answers with the placeholder provider `acp`, which a
    // length check would happily accept.
    const url = await start('rich-turn', { FAKE_ACP_DELAY_SESSION_NEW_MS: '2500' });
    const session = await createSession(url);
    await runTurn(url, session);

    const body = (await (await fetch(`${url}/api/model`)).json()) as {
      data: Array<{ providerID?: string; id?: string }> | Record<string, unknown>;
    };
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/acp\/default/);
    expect(text).toMatch(/fake/);
  });
});

/**
 * Collect the SSE stream for the duration of `run`. Uses node:http rather than
 * fetch on purpose: under vitest a fetch body buffers, so the read never returns
 * (the reason six tests in this repo used to be skipped).
 */
async function sseDuring(url: string, run: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const request = http.get(`${url}/api/event`, (response) => {
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => chunks.push(chunk));
  });
  // The subscription is established asynchronously; acting before the handshake
  // loses the earliest events.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !chunks.join('').includes('server.connected')) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await run();
  await new Promise((resolve) => setTimeout(resolve, 300));
  request.destroy();
  return chunks.join('');
}

describe('an agent that reports usage only in the prompt result', () => {
  it('feeds per-turn tokens on session.step.ended and accumulates cumulative totals on session.usage.updated and GET /api/session/:id', async () => {
    // opencode's `PromptResponse.usage` is where it reports tokens; it never sends a
    // `usage_update`. Ignoring the result left the context meter and footer empty,
    // and emitting single-turn tokens on `session.usage.updated` overwrote session totals.
    const url = await start('rich-turn', { FAKE_ACP_USAGE: '1', FAKE_ACP_REPLY: 'usage-ok' });
    const session = await createSession(url);
    const stream1 = await sseDuring(url, () => runTurn(url, session));
    const events1 = stream1
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as { type: string; data: Record<string, unknown> });

    const usage1 = events1.find((event) => event.type === 'session.usage.updated')!;
    expect(usage1['data']['tokens']).toMatchObject({
      input: 1234,
      output: 56,
      reasoning: 7,
      cache: { read: 890, write: 12 },
    });
    const step1 = events1.find((event) => event.type === 'session.step.ended')!;
    expect(step1['data']['tokens']).toMatchObject({ input: 1234, output: 56, cache: { read: 890, write: 12 } });

    // Second turn: step.ended stays per-turn while session.usage.updated and GET /api/session/:id accumulate.
    const stream2 = await sseDuring(url, () => runTurn(url, session));
    const events2 = stream2
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as { type: string; data: Record<string, unknown> });

    const step2 = events2.find((event) => event.type === 'session.step.ended')!;
    expect(step2['data']['tokens']).toMatchObject({ input: 1234, output: 56, cache: { read: 890, write: 12 } });
    const usage2 = events2.find((event) => event.type === 'session.usage.updated')!;
    expect(usage2['data']['tokens']).toMatchObject({
      input: 2468,
      output: 112,
      reasoning: 14,
      cache: { read: 1780, write: 24 },
    });
    const fetched = (await (await fetch(`${url}/api/session/${session}`)).json()) as {
      data?: { tokens?: Record<string, unknown> };
    };
    expect(fetched.data?.tokens).toEqual({
      input: 2468,
      output: 112,
      reasoning: 14,
      cache: { read: 1780, write: 24 },
    });
  });
});

describe('an agent that reports a whole-turn aggregate as usage', () => {
  it('preserves PromptResponse.usage even when total exceeds the context window (no separate bridge ledger)', async () => {
    // Rather than maintaining a separate bridge usage ledger, we pass the full
    // `PromptResponse.usage` through on `session.step.ended` and accumulate it into
    // `session.usage.updated` / `GET /api/session/:id` so TUI plugins (e.g. CacheHit
    // and Timeline) do not lose multi-step turns over the context limit. The explicit
    // tradeoff is that the built-in context meter may temporarily show >100% until
    // the next smaller turn settles.
    const url = await start('rich-turn', { FAKE_ACP_USAGE_AGGREGATE: '1', FAKE_ACP_REPLY: 'aggregate-ok' });
    const session = await createSession(url);
    const stream = await sseDuring(url, () => runTurn(url, session));
    const events = stream
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as { type: string; data: Record<string, unknown> });

    const usage = events.filter((event) => event.type === 'session.usage.updated').at(-1)!;
    expect(usage.data['tokens']).toMatchObject({ input: 3_000_000 });
    const step = events.find((event) => event.type === 'session.step.ended')!;
    expect(step.data['tokens']).toMatchObject({ input: 3_000_000 });
  });
});

describe('an agent that reports usage', () => {
  it('turns a usage_update into the event the UI reads, and keeps its size and cost', async () => {
    const url = await start('usage');
    const session = await createSession(url);
    const stream = await sseDuring(url, () => runTurn(url, session));

    const events = stream
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as { type: string; data: Record<string, unknown> });
    const usage = events.find((event) => event.type === 'session.usage.updated')!;
    expect(usage['data']['tokens']).toMatchObject({ input: 50000 });
    expect(usage['data']['cost']).toBe(0.05);
    const step = events.find((event) => event.type === 'session.step.ended')!;
    expect(step['data']['cost']).toBe(0.05);

    // `size` is the window the percentage is drawn against. The TUI reads it off
    // the model's `limit.context`, so the catalog must carry the agent's number
    // instead of the 1M fallback.
    const catalog = (await (await fetch(`${url}/api/model`)).json()) as {
      data: Array<{ limit?: { context?: number } }>;
    };
    expect(catalog.data[0]?.limit?.context).toBe(200000);
  });
});

/** Prompt with a body of our choosing, so attachments can be exercised. */
async function promptWith(url: string, session: string, body: Record<string, unknown>) {
  return fetch(`${url}/api/session/${session}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

describe('attachments', () => {
  it('forwards an image to an agent that advertised image prompts', async () => {
    const url = await start('images');
    const session = await createSession(url);
    const response = await promptWith(url, session, {
      text: 'what is this',
      files: [{ data: PNG, mime: 'image/png', name: 'dot.png' }],
    });
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 800));

    // The fake agent reports how many image blocks it actually received: the whole
    // point is to tell forwarding from a quiet drop.
    expect(JSON.stringify(await messages(url, session))).toContain('images:1');
  });

  it('drops the image, loudly, when the agent never advertised the capability', async () => {
    const url = await start('rich-turn'); // no promptCapabilities.image
    const session = await createSession(url);
    await promptWith(url, session, {
      text: 'what is this',
      files: [{ data: PNG, mime: 'image/png', name: 'dot.png' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(logs.join('\n')).toMatch(/dropped unsupported prompt blocks: image/);
    // And the user is told WHY, naming the agent's capability (not "something failed").
    const listed = (await (await fetch(`${url}/api/session/${session}/message`)).json()) as {
      data: Array<{ type: string; description?: string }>;
    };
    const notice = listed.data.find((message) => message.type === 'system');
    expect(notice?.description).toBe(
      'Image attachment dropped: this agent has no promptCapabilities.image capability',
    );
  });

  it('refuses an attachment it cannot carry instead of dropping it silently', async () => {
    const url = await start('rich-turn');
    const session = await createSession(url);
    const response = await promptWith(url, session, {
      text: 'see attached',
      files: [{ data: 'JVBERi0=', mime: 'application/pdf', name: 'report.pdf' }],
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/attachment not supported: report\.pdf/);
  });
});

// NOT here: a test for the prompt timeout. I tried one (a hanging agent plus
// OPENCODE_ACP_CLIENT_PROMPT_TIMEOUT_MS=400) and the turn did not settle within
// 15s, so either the env knob does not reach the client or the timeout does not
// settle the turn — I could not tell which before running out of budget. The fix
// therefore ships unverified end-to-end, and that is written down here rather than
// papered over with a test that passes for another reason.

describe('what the transcript tells the UI about a tool', () => {
  it('carries the times, at entry level rather than inside state', async () => {
    const url = await start('rich-turn');
    const session = await createSession(url);
    await runTurn(url, session);

    const entries = (await messages(url, session)).flatMap((item) => item.content ?? []);
    const tool = entries.find((entry) => entry.type === 'tool') as
      | { time?: { created?: number; completed?: number } }
      | undefined;
    expect(tool).toBeTruthy();
    // `created`/`ran` are the start and `completed` the end. They live on the entry,
    // NOT inside `state` — reading state.time is the mistake that made me report a
    // missing field that was there all along.
    expect(typeof tool?.time?.created).toBe('number');
    expect(typeof tool?.time?.completed).toBe('number');
  });
});

describe('which session the agent thinks this is', () => {
  it('exposes the agent session id on the session, alongside ours', async () => {
    const url = await start('rich-turn');
    const session = await createSession(url);
    await runTurn(url, session);

    const info = (await (await fetch(`${url}/api/session/${session}`)).json()) as {
      data: { id: string; acpSessionId?: string };
    };
    // Ours must satisfy the published `^ses` pattern; the agent's is reported as-is.
    expect(info.data.id).toMatch(/^ses/);
    expect(info.data.acpSessionId).toBeTruthy();
    expect(info.data.acpSessionId).not.toBe(info.data.id);
  });
});

describe('resuming with whichever id you copied', () => {
  it('finds the session by the agent id as well as by ours', async () => {
    const url = await start('rich-turn');
    const session = await createSession(url);
    await runTurn(url, session);

    const info = (await (await fetch(`${url}/api/session/${session}`)).json()) as {
      data: { acpSessionId?: string };
    };
    const agentId = info.data.acpSessionId;
    expect(agentId).toBeTruthy();

    // The alias is what makes "the id you copied" usable without knowing whose it
    // is — the bridge's (`ses_…`, or a launcher's choice) or the agent's.
    const viaAlias = (await (
      await fetch(`${url}/api/session/${encodeURIComponent(agentId as string)}`)
    ).json()) as { data: { id: string } };
    expect(viaAlias.data.id).toBe(session);
  });
});

describe('resuming on an agent that advertises neither load nor resume', () => {
  it('says exactly that, instead of calling a method the agent never advertised', async () => {
    // ACP forbids `session/resume` without `sessionCapabilities.resume` and
    // `session/load` without `loadSession`. We used to call resume regardless; a
    // strict agent answered method-not-found, the rejection escaped the session
    // startup, and the user got a session that did not exist with no explanation.
    const server = new BridgeServer({
      command: process.execPath,
      args: [FAKE_AGENT],
      directory: process.cwd(),
      port: 0,
      env: { FAKE_ACP_MODELS: '1', FAKE_ACP_CAPS_LOAD_SESSION: '0' },
      resumeSession: 'a-session-this-agent-never-had',
      onLog: (line) => logs.push(line),
    });
    servers.push(server);
    const { host, port } = await server.listen();
    const url = `http://${host}:${port}`;
    // Touch the session so the resume path runs.
    await fetch(`${url}/api/session`).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 600));

    const log = logs.join('\n');
    expect(log).toMatch(/cannot resume 'a-session-this-agent-never-had'/);
    expect(log).toMatch(/neither session\/load nor sessionCapabilities\.resume/);
    // And no forbidden call went out: the fake agent answers -32601 to both, which
    // would show up as a failed request.
    expect(log).not.toMatch(/session\/resume\('a-session-this-agent-never-had'\) failed/);
    // The tab is honest about what it holds, and it holds something usable.
    const info = (await (
      await fetch(`${url}/api/session/a-session-this-agent-never-had`)
    ).json()) as { data: { title?: string; acpSessionId?: string } };
    expect(info.data.title).toMatch(/^\[new conversation\] /);
    expect(info.data.acpSessionId).toBeTruthy();
    expect(info.data.acpSessionId).not.toBe('a-session-this-agent-never-had');

    // And the transcript says why the old conversation is not here (a `system` notice,
    // rendered by the TUI as `◈ …`), rather than leaving an unexplained blank tab.
    const listed = (await (
      await fetch(`${url}/api/session/a-session-this-agent-never-had/message`)
    ).json()) as { data: Array<{ type: string; description?: string }> };
    const notice = listed.data.find((message) => message.type === 'system');
    expect(notice?.description).toBe(
      'Cannot resume: this agent has no session/resume capability, so a new conversation was started here',
    );
  });
});

describe('resuming on an agent that advertises session/resume', () => {
  it('resumes WITHOUT replaying history, and says so instead of "not resumed"', async () => {
    // The backend's plain ACP profile: `session/resume` keeps the agent's context
    // but carries no transcript, so the screen legitimately starts empty. The
    // bridge used to log "NOT resumed … started a new session under that id" here
    // — describing an action it never took — and prefixed the title with
    // `[not resumed]`, which the client persisted into its tab layout.
    const server = new BridgeServer({
      command: process.execPath,
      args: [FAKE_AGENT],
      directory: process.cwd(),
      port: 0,
      env: { FAKE_ACP_MODELS: '1', FAKE_ACP_CAPS_RESUME: '1' },
      resumeSession: 'resume-me',
      onLog: (line) => logs.push(line),
    });
    servers.push(server);
    const { host, port } = await server.listen();
    const url = `http://${host}:${port}`;
    await fetch(`${url}/api/session`).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 600));

    const log = logs.join('\n');
    expect(log).toMatch(/resumed 'resume-me' without replay/);
    // The wording is the contract: it may neither claim the context survived nor claim
    // it was lost — the same profile answered both ways under different models.
    expect(log).not.toMatch(/keeps? the context/);
    expect(log).toMatch(/whether the model still has the earlier conversation is up to the agent/);
    // The lie this replaces: nothing was started, so nothing may say it was.
    expect(log).not.toMatch(/NOT resumed/);
    expect(log).not.toMatch(/started a new session under that id/);

    const info = (await (await fetch(`${url}/api/session/resume-me`)).json()) as {
      data: { title?: string; acpSessionId?: string };
    };
    // It IS the same agent session — that is the whole point of resume.
    expect(info.data.acpSessionId).toBe('resume-me');
    // …and the tab keeps the conversation's real name: no marker, because the notice in
    // the transcript already explains the missing history (owner's call).
    expect(info.data.title).not.toMatch(/no history|not resumed|no transcript/);
    expect(info.data.title?.trim()).not.toBe('');

    // ★ The explanation the user actually reads: a `system` notice (rendered by the TUI
    // as `◈ Notice`), not a fake user/assistant row. It names the missing capability.
    type Projected = { type: string; text?: string; description?: string };
    const listed = (await (await fetch(`${url}/api/session/resume-me/message`)).json()) as {
      data: Projected[];
    };
    const notice = listed.data.find((message) => message.type === 'system');
    // ★ It NAMES the agent. "this agent" left the reader guessing which one — and the answer is
    // the command they typed after `--`, the only part they can act on. The label is the
    // binding's basename plus its arguments (`dsh --profile acp`), which is what this test's
    // agent is: `node <path>/fake-acp-agent.mjs`.
    // The binding is the whole command as it was launched — `agentBindingLabel` takes the
    // command's BASENAME and the arguments verbatim, and the notice prints that.
    //
    // ★ Derived, not hard-coded. This suite starts the bridge with `process.execPath`, whose
    // basename is `node` on macOS/Linux and `node.exe` on Windows — and a literal `"node …"`
    // passed here for exactly as long as CI happened to run on Linux. The assertion is the whole
    // sentence, built from the same rule the bridge applies, so a change to either half still
    // fails here.
    const launched = basename(process.execPath);
    const expected =
      `Resumed without showing history: this agent "${launched} ${FAKE_AGENT}" ` +
      'has no session/load capability';
    expect(notice?.text).toBe(expected);
    // `description` is the field the TUI DRAWS, and an absent one is not "no text":
    // the client falls back to "Instructions updated" (measured in the real TUI).
    expect(notice?.description).toBe(expected);
    // A notice is not conversation content: it must not be projected as a turn.
    expect(listed.data.some((message) => message.type === 'user')).toBe(false);
  });
});

describe('a title the agent announces', () => {
  it('also reaches the map, so a restore shows the agent\'s latest name', async () => {
    // The title is bidirectional: the agent can rename the conversation at any time
    // (`session_info_update`). Whichever source wins in memory, the map must keep the
    // LATEST name — otherwise a restore resurrects a stale one.
    const dir = mkdtempSync(join(tmpdir(), 'oac-agent-title-'));
    const mapPath = join(dir, 'sessions.json');
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    try {
      const server = new BridgeServer({
        command: process.execPath,
        args: [FAKE_AGENT],
        directory: process.cwd(),
        port: 0,
        env: { FAKE_ACP_SCENARIO: 'rich-turn', FAKE_ACP_MODELS: '1', FAKE_ACP_TITLE: 'Named by the agent' },
        onLog: (line) => logs.push(line),
      });
      servers.push(server);
      const { host, port } = await server.listen();
      const url = `http://${host}:${port}`;
      const session = await createSession(url);
      await runTurn(url, session, 'please name this session');
      await new Promise((resolve) => setTimeout(resolve, 400));

      const saved = JSON.parse(readFileSync(mapPath, 'utf8')) as Record<
        string,
        { title?: string }
      >;
      expect(saved[session]?.title).toBe('Named by the agent');
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
      deferredRemovals.push(dir);
    }
  });
});

describe('sharing one agent process between sessions', () => {
  it('runs two sessions over one connection', async () => {
    // ACP sessions are independent on one connection, and one process per tab means every
    // tab pays a cold start. The second session must reuse the first connection — and still
    // get its own transcript and its own catalog, because routing is by session id.
    const url = await start('rich-turn', { FAKE_ACP_REPLY: 'one-connection' });
    const first = await createSession(url);
    await runTurn(url, first, 'first question');
    const second = await createSession(url);
    await runTurn(url, second, 'second question');

    // The fixture numbers its sessions per PROCESS (`fake-session-1`, `-2`, …), so the
    // ids prove one process allocated both: a second process would restart at `-1`.
    expect(logs.some((line) => line.includes('reusing the'))).toBe(true);
    expect(logs.filter((line) => line.includes('-> acp fake-session-1'))).toHaveLength(1);
    expect(logs.filter((line) => line.includes('-> acp fake-session-2'))).toHaveLength(1);

    // Each session saw its own turn, and only its own.
    const firstText = JSON.stringify(await messages(url, first));
    const secondText = JSON.stringify(await messages(url, second));
    expect(firstText).toContain('first question');
    expect(firstText).not.toContain('second question');
    expect(secondText).toContain('second question');
    expect(secondText).not.toContain('first question');
  });
});

describe('concurrent turns on one connection', () => {
  it('holds one session without disturbing the other', async () => {
    // One connection now serves every session, so the property that matters is
    // isolation: a held turn must not block or leak into another session's turn.
    // The hold is a gate file (the shape Intelligent Terminal and KiroCrew use)
    // rather than a sleep — the test releases it only after the other turn settled.
    const dir = mkdtempSync(join(tmpdir(), 'oac-concurrent-'));
    const release = join(dir, 'release');
    try {
      const url = await start('rich-turn', {
        FAKE_ACP_REPLY: 'concurrent-ok',
        FAKE_ACP_HOLD_ON: 'HOLD_ME',
        FAKE_ACP_HOLD_RELEASE: release,
      });
      const active = async (): Promise<Record<string, unknown>> =>
        ((await (await fetch(`${url}/api/session/active`)).json()) as {
          data: Record<string, unknown>;
        }).data;
      const waitUntil = async (predicate: () => Promise<boolean>, ms = 10_000): Promise<boolean> => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          if (await predicate()) return true;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return false;
      };

      const held = await createSession(url);
      const free = await createSession(url);

      // A starts and gets stuck on the gate; the request stays in flight on purpose.
      const heldTurn = fetch(`${url}/api/session/${held}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'HOLD_ME' }),
      });
      expect(await waitUntil(async () => (await active())[held] !== undefined)).toBe(true);

      // B completes while A is still held — same connection, its own turn.
      await runTurn(url, free, 'second question');

      const midflight = await active();
      expect(midflight[held]).toBeDefined();
      expect(midflight[free]).toBeUndefined();

      const freeText = JSON.stringify(await messages(url, free));
      expect(freeText).toContain('second question');
      expect(freeText).not.toContain('HOLD_ME');

      // Release A; it finishes normally and B's transcript is byte-for-byte untouched.
      writeFileSync(release, 'go');
      expect(await waitUntil(async () => (await active())[held] === undefined)).toBe(true);
      await heldTurn;

      const heldText = JSON.stringify(await messages(url, held));
      expect(heldText).toContain('HOLD_ME');
      expect(heldText).toContain('concurrent-ok');
      expect(JSON.stringify(await messages(url, free))).toBe(freeText);
    } finally {
      deferredRemovals.push(dir);
    }
  });
});

describe('a follow-up sent while a turn runs (the TUI sends delivery: steer)', () => {
  it('is queued instead of becoming a second prompt, and runs after the turn', async () => {
    // Reported: typing during a long task showed `Error: Internal error: Session
    // already has an active ACP prompt`, and the running turn's progress indicator
    // vanished while the turn kept streaming. The TUI sends `delivery: "steer"` for
    // that gesture; ACP has no steering, so the bridge must hold the message until
    // the running turn settles.
    const dir = mkdtempSync(join(tmpdir(), 'oac-queue-'));
    const release = join(dir, 'release');
    try {
      const url = await start('rich-turn', {
        FAKE_ACP_REPLY: 'queued-reply',
        FAKE_ACP_HOLD_ON: 'HOLD_ME',
        FAKE_ACP_HOLD_RELEASE: release,
      });
      const session = await createSession(url);
      const active = async (): Promise<Record<string, unknown>> =>
        ((await (await fetch(`${url}/api/session/active`)).json()) as {
          data: Record<string, unknown>;
        }).data;
      const waitUntil = async (predicate: () => Promise<boolean>, ms = 10_000): Promise<boolean> => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          if (await predicate()) return true;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return false;
      };

      const held = fetch(`${url}/api/session/${session}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'HOLD_ME' }),
      });
      expect(await waitUntil(async () => (await active())[session] !== undefined)).toBe(true);

      const stream = await sseDuring(url, async () => {
        const follow = await fetch(`${url}/api/session/${session}/prompt`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: 'msg_followup', text: 'follow up', delivery: 'steer' }),
        });
        expect(follow.status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 500));
        // The running turn is untouched: still busy, no agent error in the transcript.
        expect((await active())[session]).toBeDefined();
        const mid = JSON.stringify(await messages(url, session));
        expect(mid).not.toContain('active ACP prompt');
        writeFileSync(release, 'go');
        await held;
        await waitUntil(async () => (await active())[session] === undefined);
      });

      const events = stream
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)) as { type: string; data: Record<string, unknown> });
      const enqueued = events.filter(
        (event) => event.type === 'session.inbox.enqueued' && event.data['inboxID'] === 'msg_followup',
      );
      expect(enqueued).toHaveLength(1);
      expect((enqueued[0]!.data['item'] as { delivery?: string }).delivery).toBe('queue');
      expect(
        events.some(
          (event) => event.type === 'session.inbox.delivered' && event.data['inboxID'] === 'msg_followup',
        ),
      ).toBe(true);

      const text = JSON.stringify(await messages(url, session));
      expect(text).toContain('follow up');
      expect(text).toContain('queued-reply');
    } finally {
      deferredRemovals.push(dir);
    }
  });
});

describe('an agent that still reports an active prompt', () => {
  it('cancels the stale turn and retries once, instead of ending the reply with the error', async () => {
    // The desync the mid-turn steer used to cause: the bridge thinks the session is
    // idle, the agent still has a prompt registered, and the first attempt comes back
    // as `Session already has an active ACP prompt`. Reported as a red line at the end
    // of an otherwise good reply. The bridge now cancels the stale prompt and retries.
    const url = await start('rich-turn', { FAKE_ACP_STALE_PROMPT: '1', FAKE_ACP_REPLY: 'retried-reply' });
    const session = await createSession(url);
    const stream = await sseDuring(url, () => runTurn(url, session, 'after the long task'));

    const events = stream
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as { type: string; data: Record<string, unknown> });
    expect(events.some((event) => event.type === 'session.execution.failed')).toBe(false);

    const text = JSON.stringify(await messages(url, session));
    expect(text).toContain('retried-reply');
    expect(text).not.toContain('already has an active ACP prompt');
  });
});

describe('protocol edges the official conformance corpus names', () => {
  it('answers an idle interrupt as interrupted:false and keeps the session usable', async () => {
    const url = await start('rich-turn', { FAKE_ACP_REPLY: 'after-idle' });
    const session = await createSession(url);
    // No turn is running: ACP's `session/cancel` must still be accepted quietly
    // (acpx's `acp.v1.session.cancel.idle`).
    const idle = await fetch(`${url}/api/session/${session}/interrupt`, { method: 'POST' });
    expect(idle.status).toBe(200);
    expect(await idle.json()).toEqual({ interrupted: false });
    await runTurn(url, session, 'still works');
    expect(JSON.stringify(await messages(url, session))).toContain('after-idle');
  });

  it('rejects an empty prompt with a readable 400', async () => {
    // acpx's `session.prompt.echo_empty`: an adapter must answer, not hang. For the
    // bridge the honest answer is "nothing to send".
    const url = await start('rich-turn');
    const session = await createSession(url);
    const response = await fetch(`${url}/api/session/${session}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error?: string }).error).toBe('prompt has no parts');
  });

  it('carries a resource_link across the wire and still answers', async () => {
    const url = await start('rich-turn', { FAKE_ACP_ECHO_PROMPT: '1' });
    const session = await createSession(url);
    const response = await fetch(`${url}/api/session/${session}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parts: [
          { type: 'text', text: 'see this' },
          { type: 'resource_link', uri: 'file:///tmp/a.txt', name: 'a.txt' },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const active = (await (await fetch(`${url}/api/session/active`)).json()) as {
        data: Record<string, unknown>;
      };
      if (!(session in (active.data ?? {}))) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(JSON.stringify(await messages(url, session))).toContain('resource_link');
  });

  it('drops an unknown content type instead of failing the turn', async () => {
    // The agent's schema may reject a block type it has never heard of, and then
    // the whole turn is lost. The bridge drops it (and logs it) before sending.
    const url = await start('rich-turn', { FAKE_ACP_ECHO_PROMPT: '1' });
    const session = await createSession(url);
    const response = await fetch(`${url}/api/session/${session}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parts: [
          { type: 'text', text: 'hello' },
          { type: 'mystery', data: 1 },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const active = (await (await fetch(`${url}/api/session/active`)).json()) as {
        data: Record<string, unknown>;
      };
      if (!(session in (active.data ?? {}))) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const transcript = JSON.stringify(await messages(url, session));
    expect(transcript).toContain('hello');
    expect(transcript).not.toContain('"mystery"');
  });

  it('treats a null directory as absent, not as a second workspace', async () => {
    // A malformed body (the TUI never sends this) must not create a session in a
    // guessed directory: null is absent, so the bridge's own directory applies.
    const url = await start('rich-turn');
    const response = await fetch(`${url}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ location: { directory: null } }),
    });
    expect(response.status).toBe(200);
    const created = (await response.json()) as { data: { directory?: string } };
    expect(created.data.directory).toBe(process.cwd());
  });
});

describe('the message list query', () => {
  it('filters by `type` before paging', async () => {
    // The 2.0.32 schema added `?type=`; the projection already carries the type, so
    // a filtered read must return only those rows (not the whole transcript).
    const url = await start('rich-turn');
    const session = await createSession(url);
    await runTurn(url, session, 'Explain the session map');
    await new Promise((resolve) => setTimeout(resolve, 400));

    const read = async (type: string) =>
      ((await (await fetch(`${url}/api/session/${session}/message?type=${type}`)).json()) as {
        data: Array<{ type?: string }>;
      }).data;
    const users = await read('user');
    const assistants = await read('assistant');
    expect(users.length).toBeGreaterThan(0);
    expect(users.every((message) => message.type === 'user')).toBe(true);
    expect(assistants.every((message) => message.type === 'assistant')).toBe(true);
    expect(assistants.length).toBeGreaterThan(0);
  });
});

describe('the inbox delivery switch', () => {
  it('accepts the 2.0.32 PATCH spelling and refuses an invalid delivery', async () => {
    // `POST /inbox/:id/{steer,queue}` became `PATCH /inbox/:id {delivery}`. The TUI
    // does not send it today, but a client that does must not get a silent 204.
    const url = await start('rich-turn');
    const session = await createSession(url);
    const patched = await fetch(`${url}/api/session/${session}/inbox/msg_test`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delivery: 'queue' }),
    });
    expect(patched.status).toBe(204);

    const invalid = await fetch(`${url}/api/session/${session}/inbox/msg_test`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delivery: 'teleport' }),
    });
    expect(invalid.status).toBe(400);
  });
});

describe('the title a restored tab shows', () => {
  it('is the name the conversation got, not the directory the tab opened in', async () => {
    // The owner's flow: prompt once in a plain-ACP session (the agent publishes no
    // titles at all), quit, `-s <id>` — and the tab came back as `tau`, the directory
    // basename, because the derived title never reached the map. The map now keeps the
    // latest name from ANY source (derived / agent / user rename).
    const dir = mkdtempSync(join(tmpdir(), 'oac-title-restore-'));
    const mapPath = join(dir, 'sessions.json');
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    type Entry = { acpSessionId?: string; title?: string };
    try {
      // --- run 1: a turn names the conversation ---------------------------------
      const first = new BridgeServer({
        command: process.execPath,
        args: [FAKE_AGENT],
        directory: process.cwd(),
        port: 0,
        env: { FAKE_ACP_SCENARIO: 'rich-turn', FAKE_ACP_MODELS: '1', FAKE_ACP_CAPS_RESUME: '1' },
        onLog: (line) => logs.push(line),
      });
      servers.push(first);
      const firstUrl = `http://${await first.listen().then((r) => `${r.host}:${r.port}`)}`;
      const visible = await createSession(firstUrl);
      await runTurn(firstUrl, visible, 'Explain the session map');
      await new Promise((resolve) => setTimeout(resolve, 400));
      const acpId = ((await (await fetch(`${firstUrl}/api/session/${visible}`)).json()) as {
        data: { acpSessionId?: string };
      }).data.acpSessionId;
      expect(acpId).toBeTruthy();

      // The map holds the derived name under the visible id — that is what a restore reads.
      const saved = JSON.parse(readFileSync(mapPath, 'utf8')) as Record<string, Entry>;
      expect(saved[visible]?.title).toBe('Explain the session map');
      expect(saved[visible]?.acpSessionId).toBe(acpId);

      // --- run 2: `-s <visible>` on the same map --------------------------------
      const second = new BridgeServer({
        command: process.execPath,
        args: [FAKE_AGENT],
        directory: process.cwd(),
        port: 0,
        env: { FAKE_ACP_MODELS: '1', FAKE_ACP_CAPS_RESUME: '1' },
        resumeSession: acpId,
        resumeVisibleSessionId: visible,
        onLog: (line) => logs.push(line),
      });
      servers.push(second);
      const secondUrl = `http://${await second.listen().then((r) => `${r.host}:${r.port}`)}`;
      // GET /api/session runs the pre-created resume path.
      await fetch(`${secondUrl}/api/session`).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 600));

      const restored = (await (await fetch(`${secondUrl}/api/session/${visible}`)).json()) as {
        data: { title?: string; acpSessionId?: string };
      };
      expect(restored.data.acpSessionId).toBe(acpId);
      // The REAL name — no marker (the notice in the transcript explains the empty
      // history), and not the directory.
      expect(restored.data.title).toBe('Explain the session map');
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
      deferredRemovals.push(dir);
    }
  });
});

describe('a restore whose load is refused', () => {
  it('quotes the agent and names the usual cause (another writer holding it)', async () => {
    // Measured with dsh: `session/load` answers "Internal error" while another
    // process still holds the session, then succeeds once it exits. The tab falls
    // back to a new conversation; the notice must make it obvious that the AGENT
    // refused, and that a lock is the usual reason.
    const server = new BridgeServer({
      command: process.execPath,
      args: [FAKE_AGENT],
      directory: process.cwd(),
      port: 0,
      env: { FAKE_ACP_MODELS: '1', FAKE_ACP_LOAD_FAILS: '1' },
      resumeSession: 'held-by-another-process',
      onLog: (line) => logs.push(line),
    });
    servers.push(server);
    const { host, port } = await server.listen();
    const url = `http://${host}:${port}`;
    await fetch(`${url}/api/session`).catch(() => undefined);
    // The failed load retries once after 2s; wait past that.
    await new Promise((resolve) => setTimeout(resolve, 3200));

    const info = (await (
      await fetch(`${url}/api/session/held-by-another-process`)
    ).json()) as { data: { title?: string } };
    expect(info.data.title).toMatch(/^\[new conversation\] /);

    const listed = (await (
      await fetch(`${url}/api/session/held-by-another-process/message`)
    ).json()) as { data: Array<{ type: string; description?: string }> };
    const notice = listed.data.find((message) => message.type === 'system');
    expect(notice?.description).toMatch(/^Agent could not load this session: /);
    expect(notice?.description).toMatch(/session\/load failed/);
    expect(notice?.description).toMatch(/one writer per session/);
  });
});

describe('a `-c` with nothing to continue', () => {
  it('names the missing capability instead of leaving a blank new tab', async () => {
    // The launcher resolved `-c` to nothing because the agent has no `session/list`.
    // The tab is a new conversation; the notice says the agent is why, not the bridge.
    const server = new BridgeServer({
      command: process.execPath,
      args: [FAKE_AGENT],
      directory: process.cwd(),
      port: 0,
      env: { FAKE_ACP_MODELS: '1' },
      continueMode: true,
      continueModeReason: 'no-list',
      onLog: (line) => logs.push(line),
    });
    servers.push(server);
    const { host, port } = await server.listen();
    const url = `http://${host}:${port}`;
    const list = (await (await fetch(`${url}/api/session`)).json()) as { data: Array<{ id: string }> };
    const session = list.data[0]?.id ?? '';
    expect(session).toBeTruthy();
    const listed = (await (await fetch(`${url}/api/session/${session}/message`)).json()) as {
      data: Array<{ type: string; description?: string }>;
    };
    const notice = listed.data.find((message) => message.type === 'system');
    expect(notice?.description).toBe(
      'Cannot continue: this agent has no sessionCapabilities.list capability, so a new conversation was started here',
    );
  });
});

describe('a restore whose resume is refused', () => {
  it('opens a new conversation and says so in the transcript', async () => {
    // The other failure shape: the agent advertises `resume`, the call still fails (the
    // usual real cause is another process holding the session). The tab is usable but it
    // is a NEW conversation, and the notice must say that instead of leaving a blank.
    const server = new BridgeServer({
      command: process.execPath,
      args: [FAKE_AGENT],
      directory: process.cwd(),
      port: 0,
      env: { FAKE_ACP_MODELS: '1', FAKE_ACP_RESUME_FAILS: '1' },
      resumeSession: 'held-by-another-process',
      onLog: (line) => logs.push(line),
    });
    servers.push(server);
    const { host, port } = await server.listen();
    const url = `http://${host}:${port}`;
    await fetch(`${url}/api/session`).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 600));

    const info = (await (
      await fetch(`${url}/api/session/held-by-another-process`)
    ).json()) as { data: { title?: string; acpSessionId?: string } };
    expect(info.data.title).toMatch(/^\[new conversation\] /);
    // It really is a different agent session — the old one stayed untouched.
    expect(info.data.acpSessionId).toBeTruthy();
    expect(info.data.acpSessionId).not.toBe('held-by-another-process');

    const listed = (await (
      await fetch(`${url}/api/session/held-by-another-process/message`)
    ).json()) as { data: Array<{ type: string; description?: string }> };
    const notice = listed.data.find((message) => message.type === 'system');
    expect(notice?.description).toMatch(/^Agent resume failed: so a new conversation was started here\. The agent said: /);
    // The agent's own error must be quoted: that is what makes it read as "the agent
    // refused" rather than "the bridge is broken".
    expect(notice?.description).toMatch(/session\/resume failed/);
  });
});

describe('the model a restored session already had', () => {
  it('takes it from the resume response instead of the catalog default', async () => {
    // Measured on a real agent: a restored session's first turn was sent with the
    // catalog default (a different model than the conversation used) and failed
    // with "turn failed: Connection error", while the session's own model worked.
    // `session/resume`'s response carries the session's config options, exactly like
    // `session/new`, so that is the truth to adopt.
    const server = new BridgeServer({
      command: process.execPath,
      args: [FAKE_AGENT],
      directory: process.cwd(),
      port: 0,
      env: {
        FAKE_ACP_MODELS: '1',
        FAKE_ACP_CAPS_RESUME: '1',
        // session/new calls this model-1; the resumed session says model-2.
        FAKE_ACP_RESUME_MODEL: '["fake","model-2"]',
      },
      resumeSession: 'resume-own-model',
      onLog: (line) => logs.push(line),
    });
    servers.push(server);
    const { host, port } = await server.listen();
    const url = `http://${host}:${port}`;
    await fetch(`${url}/api/session`).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 600));

    const stream = collectSse(`${url}/api/event`, 6000);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await runTurn(url, 'resume-own-model', 'go');
    await new Promise((resolve) => setTimeout(resolve, 400));
    stream.stop();

    const started = stream.frames
      .map((frame) => JSON.parse(frame) as { type: string; data?: Record<string, unknown> })
      .find((event) => event.type === 'session.step.started');
    const model = started?.data?.model as { id?: string; providerID?: string } | undefined;
    expect(model).toEqual({ id: 'model-2', providerID: 'fake' });
  });
});

describe('a restore that succeeds teaches the session map', () => {
  it('files the pairing a synthesised visible id had no entry for', async () => {
    // `-c` synthesises `ses_acp_<agent id>` from the agent's own session list, so
    // the pair exists only in this process. Without writing it, the exit epilogue
    // handed back a `-s ses_acp_…` line the next run rejected as unknown — the
    // user's "Continue line does not resume" in a different disguise.
    const dir = mkdtempSync(join(tmpdir(), 'oac-pairing-'));
    const mapPath = join(dir, 'sessions.json');
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    try {
      const server = new BridgeServer({
        command: process.execPath,
        args: [FAKE_AGENT],
        directory: process.cwd(),
        port: 0,
        env: { FAKE_ACP_MODELS: '1', FAKE_ACP_CAPS_RESUME: '1' },
        resumeSession: 'the-agent-session',
        resumeVisibleSessionId: 'ses_acp_theagentsession',
        onLog: (line) => logs.push(line),
      });
      servers.push(server);
      const { host, port } = await server.listen();
      const url = `http://${host}:${port}`;
      // `GET /api/session` is the route that calls `ensureSession()`, and that is
      // what runs the pre-created resume path (the singular GET would 404: the id
      // is not in the map yet, which is the point of this test).
      await fetch(`${url}/api/session`).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 800));

      const saved = JSON.parse(readFileSync(mapPath, 'utf8')) as Record<
        string,
        { acpSessionId?: string }
      >;
      expect(saved['ses_acp_theagentsession']?.acpSessionId).toBe('the-agent-session');
      // And the map is the whole point: the id on the Continue line now resolves.
      expect(resolveSessionId('ses_acp_theagentsession')).toBe('the-agent-session');
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
      deferredRemovals.push(dir);
    }
  });
});

describe('an agent that promises a resume and then fails it', () => {
  it('recovers with a working session, without pretending it was the old one', async () => {
    const server = new BridgeServer({
      command: process.execPath,
      args: [FAKE_AGENT],
      directory: process.cwd(),
      port: 0,
      env: { FAKE_ACP_MODELS: '1', FAKE_ACP_RESUME_FAILS: '1' },
      resumeSession: 'resume-promised-but-broken',
      onLog: (line) => logs.push(line),
    });
    servers.push(server);
    const { host, port } = await server.listen();
    await fetch(`http://${host}:${port}/api/session`).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(logs.join('\n')).toMatch(/session\/resume\('resume-promised-but-broken'\) failed/);
    const info = (await (
      await fetch(`http://${host}:${port}/api/session/resume-promised-but-broken`)
    ).json()) as { data: { id: string; title?: string; acpSessionId?: string } };
    expect(info.data.id).toBe('resume-promised-but-broken');
    expect(info.data.title).toMatch(/^\[new conversation\] /);
    expect(info.data.acpSessionId).toBeTruthy();
    expect(info.data.acpSessionId).not.toBe('resume-promised-but-broken');
  });
});


describe('an agent that promises a load and then fails it', () => {
  it('recovers with a working session, and says it did not resume', async () => {
    const server = new BridgeServer({
      command: process.execPath,
      args: [FAKE_AGENT],
      directory: process.cwd(),
      port: 0,
      // Advertises loadSession, then answers session/load with an error.
      env: { FAKE_ACP_MODELS: '1', FAKE_ACP_LOAD_FAILS: '1' },
      resumeSession: 'promised-but-broken',
      onLog: (line) => logs.push(line),
    });
    servers.push(server);
    const { host, port } = await server.listen();
    // `GET /api/session` is the route that calls `ensureSession()`, and that is what
    // runs the resume path in server mode. A `POST` create does not, which is why an
    // earlier version of this test saw no `[bridge]` line at all.
    await fetch(`http://${host}:${port}/api/session`).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 2500));

    expect(logs.join('\n')).toMatch(/could not load 'promised-but-broken'/);
    // And the point of catching it: the session comes up under that id, marked, with
    // a real agent session behind it. Before the catch there was no session at all.
    // The marker says NEW CONVERSATION — the old one was not opened, and claiming
    // "not resumed" made the user think their context was gone when it was intact.
    const info = (await (
      await fetch(`http://${host}:${port}/api/session/promised-but-broken`)
    ).json()) as { data: { id: string; title?: string; acpSessionId?: string } };
    expect(info.data.id).toBe('promised-but-broken');
    expect(info.data.title).toMatch(/^\[new conversation\] /);
    expect(info.data.acpSessionId).toBeTruthy();
  });
});

describe('the transcript export routes', () => {
  it('answers /rename with the declared 204, on both spellings', async () => {
    // `/rename <title>` PATCHes here; the client declares `successStatus: 204, empty: true`.
    // Answering 200 with the session JSON made the command toast `UnexpectedStatus: 200`
    // even though the rename had worked (the tab title had changed) — found by MODE=patrol.
    const url = await start('rich-turn');
    const session = await createSession(url);
    const patch = await fetch(`${url}/api/session/${session}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'renamed-by-test' }),
    });
    expect(patch.status).toBe(204);
    const legacy = await fetch(`${url}/api/session/${session}/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'renamed-again' }),
    });
    expect(legacy.status).toBe(204);
    const info = (await (await fetch(`${url}/api/session/${session}`)).json()) as {
      data: { title?: string };
    };
    expect(info.data.title).toBe('renamed-again');
  });

  it('serves /reload with the declared 204, not the generic 200 array', async () => {
    // `/reload` posts here; the declaration is `successStatus: 204`. The generic fallback
    // answered 200 with an array — outside the declared set — which the client surfaced as
    // UnexpectedStatus right after its "Reloading configuration…" toast.
    const url = await start('rich-turn');
    const response = await fetch(`${url}/api/location/reload`, { method: 'POST' });
    expect(response.status).toBe(204);
  });

  it('exports the transcript as one object so /copy and /export actually work', async () => {
    // `/copy` and `/export` fetch the whole conversation here and feed it to
    // `formatSessionTranscript(data.info, data.messages)`. The route was unimplemented, so
    // the generic array fallback made the client dereference `.info` on an Array and every
    // copy failed with "Failed to copy session transcript".
    const url = await start('rich-turn');
    const session = await createSession(url);
    await runTurn(url, session, 'exported turn');

    const response = await fetch(`${url}/api/experimental/session/${session}/export`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { info: { id: string }; messages: Array<{ type?: string }> };
    };
    expect(body.data.info.id).toBe(session);
    const types = body.data.messages.map((message) => message.type).sort();
    expect(types).toContain('user');
    expect(types).toContain('assistant');
  });
});

describe('the agent slash commands (ACP available_commands_update)', () => {
  it('lists the agent\'s commands so the palette offers them', async () => {
    // dsh advertises ~45 slash commands over ACP (mostly skill runners); the bridge used
    // to log them away, so none could ever be triggered from this TUI while the same
    // agent's own web UI runs them fine. The commands must land in GET /api/command —
    // and a session that exists but has not started yet is started, because the palette
    // opens at startup, before any prompt.
    const url = await start('rich-turn', { FAKE_ACP_COMMANDS: '1' });
    await createSession(url); // creates + starts the agent lazily
    const response = await fetch(`${url}/api/command?location[directory]=${process.cwd()}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Array<{ name: string; description?: string }>;
    };
    const names = body.data.map((command) => command.name);
    expect(names).toContain('greet');
    expect(names).toContain('status');
    const greet = body.data.find((command) => command.name === 'greet');
    expect(greet?.description).toBe('Run the greet skill');
  });

  it('runs a picked command as a slash prompt, the ACP contract way', async () => {
    // "Commands are included as regular user messages in prompt requests … The Agent
    // recognizes the command prefix" (agentclientprotocol.com/protocol/v1/slash-commands).
    // The bridge turns POST /command {name, text} into the prompt `/greet hello` — same
    // turn lifecycle as any message. The echo fixture proves the exact text the agent
    // received, so this pins the contract byte for byte.
    const url = await start('rich-turn', { FAKE_ACP_COMMANDS: '1', FAKE_ACP_ECHO_PROMPT: '1' });
    const session = await createSession(url);
    const response = await fetch(`${url}/api/session/${session}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'greet', text: 'hello', delivery: 'steer' }),
    });
    // The declaration is `successStatus: 204, empty: true` — same placeholder shape as
    // POST /prompt.
    // The declaration is `successStatus: 204, empty: true`, unlike POST /prompt's
    // 200-with-body: answering 200 made every command fail in the client with
    // `UnexpectedStatus: 200 / Failed to set up session`, and the composer then kept
    // its text and concatenated it onto the next command.
    expect(response.status).toBe(204);
    await runTurn(url, session);
    const reply = [...(await messages(url, session))]
      .reverse()
      .find((item) => item.type === 'assistant' && JSON.stringify(item.content ?? []).includes('ECHO'));
    const text = JSON.stringify(reply?.content ?? []);
    expect(text).toContain('/greet hello');
  });
});

describe('the skill attachment path', () => {
  it('lists installed skills so the picker is not forever empty', async () => {
    // The /skills picker reads GET /api/skill; the old always-empty answer meant no skill
    // could ever be attached from the TUI. The scan covers the config skill/skills roots
    // and the workspace's .opencode/skill(s) — the official roots.
    const url = await start('rich-turn');
    const response = await fetch(`${url}/api/skill?location[directory]=${process.cwd()}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Array<{ id: string; name: string; description?: string; path: string; content: string }>;
    };
    expect(Array.isArray(body.data)).toBe(true);
    for (const skill of body.data) {
      expect(skill.id).toBeTruthy();
      expect(skill.name).toBeTruthy();
      expect(skill.path.endsWith('SKILL.md')).toBe(true);
      expect(typeof skill.content).toBe('string');
    }
  });

  it('forwards an attached skill as a resource link the agent must accept', async () => {
    // The picker sends only the id; the bridge resolves it to the skill's file and sends
    // `session/prompt` with a resource_link block. The spec requires every agent to
    // accept resource links (no capability gates them), and the fixture echoes what it
    // received, so the reply proves the block really crossed the ACP wire.
    //
    // ★ The skill lives under the WORKSPACE, not under `~/.config/opencode/skills`. Both are
    // scan roots, but only the workspace one is reliably controllable: `os.homedir()` reads
    // `HOME` on POSIX and `USERPROFILE` on Windows, so a fixture that sets either one works
    // on one platform and silently looks in the real profile on the other — measured on
    // windows-latest, where the skill was never found. The workspace is the directory the
    // test already owns, and `$workspace/.opencode/skills` is the other root the scan uses.
    const home = mkdtempSync(join(tmpdir(), 'oac-skill-home-'));
    const skillDir = join(process.cwd(), '.opencode', 'skills', 'patrol-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: patrol-skill\ndescription: a skill the test controls\n---\nrun the check.\n',
      'utf8',
    );
    // ★ `os.homedir()` reads `HOME` on POSIX but `USERPROFILE` on Windows, so setting only
    // `HOME` left the scan looking in the real profile there and the skill was never found.
    // Both are set (and both restored) so the fixture governs the lookup on either platform.
    try {
      const url = await start('rich-turn', { FAKE_ACP_ECHO_PROMPT: '1' });
      const session = await createSession(url);
      const response = await fetch(`${url}/api/session/${session}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'use the skill',
          skills: [{ id: 'patrol-skill', name: 'patrol-skill' }],
        }),
      });
      expect(response.status).toBe(200);
      await runTurn(url, session);
      // Assert from the bridge's own log, not the transcript: the turn's reply arrives
      // through several part kinds (the fixture's reasoning, the echo text) and the
      // first suite version chased whichever row `messages` happened to surface — two
      // full-suite runs failed on different rows. The log line is emitted exactly where
      // the resource_link blocks are appended, and the fixture's echo (kept below) proves
      // the block crossed the wire: the reply must contain the skill's file.
      expect(
        logs.some((line) => line.includes('prompt mentions: skills forwarded 1')),
      ).toBe(true);
      const reply = [...(await messages(url, session))]
        .reverse()
        .find((item) => item.type === 'assistant' && JSON.stringify(item.content ?? []).includes('ECHO'));
      expect(reply).toBeDefined();
      const text = JSON.stringify(reply?.content ?? []);
      // The official toModelOutput envelope, inlined — not a resource link. A link is
      // spec-legal but measured toothless (the agent treats it as a reference and never
      // applies the skill); inline text is what the official server sends.
      expect(text).toContain('skill_content');
      expect(text).toContain('# Skill: patrol-skill');
      expect(text).toContain('run the check.');
      // ★ The base directory is checked by its tail, not its whole path: on Windows the
      // temp directory arrives in its 8.3 short form (`RUNNER~1`), so the value the bridge
      // reports and the `home` this test holds are the same directory spelled two ways.
      // ★ Both sides through `realpath` before comparing: on Windows the same directory has
      // a short (8.3) and a long spelling, and the bridge reports whichever one its own cwd
      // string carried. `realpathSync.native` canonicalises both to the long form.
      // ★ `text` is `JSON.stringify` of the content, so a Windows path arrives with its
      // separators ESCAPED (`C:\\oac\\...`). Compare the JSON spelling of the expected value
      // rather than the raw path — the assertion is "the skill's base directory reached the
      // agent", not "the JSON escaping looks a particular way". (Measured on Windows: the
      // raw comparison failed there while passing everywhere else.)
      expect(text).toContain(JSON.stringify(`Base directory for this skill: ${sameDir(skillDir)}`).slice(1, -1));
    } finally {
      deferredRemovals.push(join(process.cwd(), '.opencode'));
      deferredRemovals.push(home);
    }
  });

  it('answers a prompt with an unknown skill without pretending it was attached', async () => {
    // skillLink returns undefined for an id no scan root has; the prompt still goes out
    // (the text is real) and the bridge logs the unknown mention — the honest path.
    const url = await start('rich-turn', { FAKE_ACP_ECHO_PROMPT: '1' });
    const session = await createSession(url);
    const response = await fetch(`${url}/api/session/${session}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'go', skills: [{ id: 'no-such-skill-88', name: 'x' }] }),
    });
    expect(response.status).toBe(200);
    await runTurn(url, session);
    expect(logs.some((line) => line.includes('unknown skill: no-such-skill-88'))).toBe(true);
  });
});

describe('the /cd move', () => {
  it('moves the session: the record, the session object and the agent all follow', async () => {
    const target = mkdtempSync(join(tmpdir(), 'oac-move-'));
    const url = await start('rich-turn', {
      FAKE_ACP_CAPS_LOAD_SESSION: '1',
      FAKE_ACP_CWD_IN_REPLY: '1',
      FAKE_ACP_REPLAY_ON_LOAD: '1',
    });
    const session = await createSession(url);
    // One turn first, so a live transcript exists. The re-load replays a frame (the flag
    // makes every session/load replay one), so this regression bites: without the mute,
    // the translator runs the replay through ensureMessage and the history renders twice.
    await runTurn(url, session, 'first turn');
    const before = await messages(url, session);

    const moved = await fetch(`${url}/api/session/${session}/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directory: target }),
    });
    expect(moved.status).toBe(204);

    // The session surface says the new directory: the footer and the sidebar read
    // `session.location.directory`, and the bridge must agree with itself before the
    // client ever sees the event.
    const info = (await (await fetch(`${url}/api/session/${session}`)).json()) as {
      data: { location: { directory: string }; directory: string };
    };
    expect(info.data.location.directory).toBe(target);
    expect(info.data.directory).toBe(target);

    // The transcript gained nothing from the replay the re-load triggered: the row count
    // holds AND the replayed frame's text appears nowhere. Counting rows alone let the
    // first version of this regression pass with the mute removed - the replay had been
    // appended into an existing assistant row, which changes no count.
    const after = await messages(url, session);
    expect(after).toHaveLength(before.length);
    expect(JSON.stringify(after)).not.toContain('replayed-from-agent');

    // The next turn answers from the new directory: the re-load is what makes /cd real,
    // because the agent's own tool calls must follow the directory the UI now claims.
    await runTurn(url, session, 'after the move');
    const reply = (await messages(url, session)).find((item) => item.type === 'assistant');
    const text = JSON.stringify((reply?.content ?? []).filter((entry) => entry.type === 'text'));
    // ★ Compare the directory's own name, not the whole path. On Windows the temp directory
    // comes back in its 8.3 short form (`C:\Users\RUNNER~1\…` while `target` is the long
    // one), so an exact match failed there for a correct answer. The name is the part this
    // asserts — that the turn ran in the directory /cd moved to.
    // ★ Compare the directory, not its spelling. The same path has several: Windows may hand
    // back the 8.3 short form (`RUNNER~1`), and on macOS `/var` is a symlink to
    // `/private/var` so the bridge's cwd and `mkdtempSync`'s answer differ by that prefix.
    // Pulling the bridge's own `cwd: …` value out and canonicalising both sides compares what
    // the assertion is about — that the turn ran in the directory /cd moved to.
    // The reply is JSON, so a Windows path arrives with its separators escaped (`C:\\Users`);
    // match up to the closing quote and put the escapes back before comparing.
    const reported = /cwd: (.*?)\)/.exec(text)?.[1]?.replace(/\\\\/g, '\\');
    expect(reported, `no cwd in the reply: ${text.slice(0, 200)}`).toBeDefined();
    expect(sameDir(reported!)).toBe(sameDir(target));
  });

  it('keeps the replayed config after a restart, so the catalog is not wiped empty', async () => {
    // A `session/load` whose config arrives as a config_option_update NOTIFICATION before
    // the response (the fixture's shape; real agents vary) had it applied by the update
    // listener, then the bare response's `?? []` wiped sessionConfig back to empty —
    // measured end to end: after a restart the catalog served only the placeholder, the
    // client rendered `model-1 (unavailable)` and refused every submission. The response
    // wins when it carries options; notifications already applied stand otherwise.
    const mapPath = join(mkdtempSync(join(tmpdir(), 'oac-cfg-')), 'sessions.json');
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    try {
      const env = {
        OPENCODE_ACP_CLIENT_SESSION_MAP: mapPath,
        FAKE_ACP_MODELS: '1',
        FAKE_ACP_CAPS_LOAD_SESSION: '1',
        FAKE_ACP_REPLAY_ON_LOAD: '1',
      };
      const first = await start('rich-turn', env);
      const session = await createSession(first);
      await runTurn(first, session);
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Reopen over the same map; the load replays the config. The catalog must become
      // real — the user-visible symptom of it not doing so is the locked composer.
      const second = await start('rich-turn', env);
      await fetch(`${second}/api/session/${session}`);
      await fetch(`${second}/api/session/${session}/message`);
      const deadline = Date.now() + 5000;
      let real = 0;
      while (Date.now() < deadline) {
        const catalog = (await (await fetch(`${second}/api/model`)).json()) as {
          data: Array<{ providerID?: string }>;
        };
        real = catalog.data.filter((m) => m.providerID !== 'acp').length;
        if (real > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(real).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
    }
  });

  it('serves a restored transcript even when the message list races the agent startup', async () => {
    // The startup sequence is agents.set() (synchronous) → initialize → session/load → the
    // replay lands in record.history. The /message guard only checked `agents.has()`, so a
    // second request arriving between the set and the load found the half-built agent,
    // skipped the wait, and served an empty transcript — exactly the reopened tab's blank
    // screen, hit when the client's tab prefetch fires both GETs in parallel. The route now
    // awaits ensureAgent unconditionally for a session with an ACP id.
    const mapPath = join(mkdtempSync(join(tmpdir(), 'oac-race-')), 'sessions.json');
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    try {
      const env = {
        OPENCODE_ACP_CLIENT_SESSION_MAP: mapPath,
        FAKE_ACP_CAPS_LOAD_SESSION: '1',
        FAKE_ACP_REPLAY_ON_LOAD: '1',
        FAKE_ACP_DELAY_SESSION_LOAD_MS: '300',
      };
      const first = await start('rich-turn', env);
      const session = await createSession(first);
      await runTurn(first, session);
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Reopen: hit the transcript before anything else has had a chance to start the
      // agent — the prefetch shape, compressed to its racing core. With the load delayed
      // 300ms the first request lands inside the window where the OLD guard
      // (`agents.has()` true, load not finished) served an empty transcript; the route
      // must await ensureAgent and serve the replay instead.
      const second = await start('rich-turn', env);
      // Adopt the session (that request does not start the agent), then reproduce the
      // real racing pair: `/api/model` kicks off the agent startup (its handlers ensureAgent
      // for a session with an ACP id) and the transcript list arrives while that startup is
      // still in flight — `agents.set()` is synchronous, the 300ms load is not. The old
      // guard saw `agents.has() === true` and served an empty transcript; the route must
      // join the in-flight startup and serve the replay it produced.
      await fetch(`${second}/api/session/${session}`);
      const model = fetch(`${second}/api/model`);
      const transcript = await fetch(`${second}/api/session/${session}/message?limit=20&order=desc`);
      await model;
      const body = (await transcript.json()) as { data: Array<{ type?: string }> };
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data.some((item) => item.type === 'assistant')).toBe(true);
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
    }
  });

  it('keeps the moved directory across a restart: the map, not the launch directory, wins', async () => {
    // The owner moved a session with /cd, closed the TUI, reopened it, switched to the tab —
    // and the session was back in the launch directory. The move itself is durable (it is
    // written to the session map), but the adoption path on restart built the record from the
    // bridge's own location and never read the map's directory back: a write without a
    // reader, the same family as the self-mapping bug. Worse than cosmetic — the load's cwd
    // comes from record.directory, so the agent went back to working in the old directory.
    const mapPath = join(mkdtempSync(join(tmpdir(), 'oac-move-map-')), 'sessions.json');
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    try {
      const target = mkdtempSync(join(tmpdir(), 'oac-move-target-'));
      const env = {
        OPENCODE_ACP_CLIENT_SESSION_MAP: mapPath,
        FAKE_ACP_CAPS_LOAD_SESSION: '1',
        FAKE_ACP_CWD_IN_REPLY: '1',
      };
      // Run one: a turn, then the move. The map file now records the pair AND the target.
      const first = await start('rich-turn', env);
      const session = await createSession(first);
      await runTurn(first, session);
      const moved = await fetch(`${first}/api/session/${session}/move`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ directory: target }),
      });
      expect(moved.status).toBe(204);

      // Run two: a fresh bridge, same map — what closing and reopening the TUI does. The
      // client asks for the id it remembers; the adopted session must carry the moved
      // directory, not the new bridge's launch directory (this process's cwd).
      logs.length = 0;
      const second = await start('rich-turn', env);
      const adopted = (await (await fetch(`${second}/api/session/${session}`)).json()) as {
        data: { location: { directory: string } };
      };
      expect(adopted.data.location.directory).toBe(target);

      // And the agent follows: the re-load's cwd is the restored directory, so the next
      // turn reports the session as running in the moved-to directory.
      await runTurn(second, session, 'after the restart');
      const reply = (await messages(second, session)).find((item) => item.type === 'assistant');
      const text = JSON.stringify((reply?.content ?? []).filter((entry) => entry.type === 'text'));
      // Same JSON-escaping trap as the skill test above: `text` is stringified, so a Windows
      // path arrives with `\\` in it and the raw comparison cannot match.
      expect(text).toContain(JSON.stringify(`cwd: ${target}`).slice(1, -1));
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
    }
  });

  it('refuses honestly when the agent cannot re-load a session in a new directory', async () => {
    // The fixture does not advertise `loadSession` by default, so a move would leave the
    // agent working in the old directory while the UI claims the new one — the exact lie
    // this bridge must not tell. The refusal names the real cause.
    const url = await start('rich-turn');
    const session = await createSession(url);
    await runTurn(url, session, 'first turn');
    const target = mkdtempSync(join(tmpdir(), 'oac-move-'));
    const refused = await fetch(`${url}/api/session/${session}/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directory: target }),
    });
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as { _tag?: string; message?: string };
    expect(body._tag).toBe('InvalidRequestError');
    expect(body.message).toContain('cannot change a session directory');
  });

  it('refuses a target that is not a directory, with the official message', async () => {
    const url = await start('rich-turn');
    const session = await createSession(url);
    const missing = join(tmpdir(), 'oac-no-such-dir-9d3f');
    const refused = await fetch(`${url}/api/session/${session}/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directory: missing }),
    });
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as { _tag?: string; message?: string };
    expect(body._tag).toBe('InvalidRequestError');
    expect(body.message).toContain('Directory does not exist');
    // Nothing moved.
    const info = (await (await fetch(`${url}/api/session/${session}`)).json()) as {
      data: { location: { directory: string } };
    };
    expect(info.data.location.directory).not.toBe(missing);
  });
});

describe('the verbs this client cannot perform', () => {
  it('refuses /generate with a declared status instead of an undeclared 204', async () => {
    const url = await start('rich-turn');
    const session = await createSession(url);

    // The TUI's `/btw` posts here and shows the returned `{text}` in a dialog. ACP has no
    // side-question method that leaves the conversation untouched (the unstable `session/fork`
    // would be that method, and dsh does not advertise it), so the answer must be the declared
    // 503 — a 204 from the generic verb fallback shows up as `UnexpectedStatus: 204`.
    const refused = await fetch(`${url}/api/session/${session}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'side question' }),
    });
    expect(refused.status).toBe(503);
    const body = (await refused.json()) as { _tag?: string; message?: string; service?: string };
    expect(body._tag).toBe('ServiceUnavailableError');
    expect(body.message).toBe('side questions (/btw) are not acp supported');
    expect(body.service).toBe('session generation');
  });


  it('refuses every TUI feature ACP has no method for with a declared status', async () => {
    const url = await start('rich-turn');
    const session = await createSession(url);
    await runTurn(url, session, 'first turn');

    // The TUI offers these commands; ACP has no method behind them. Each must answer a
    // status the route *declares*, so the client shows an ordinary toast — the generic 204
    // fallback either threw `UnexpectedStatus` (204 outside declaredStatuses) or, worse,
    // silently did nothing while the UI believed the action succeeded.
    const cases: Array<{
      name: string;
      run: () => Promise<Response>;
      status: number;
      tag: string;
      message: string;
    }> = [
      {
        name: 'undo (revert stage)',
        run: () =>
          fetch(`${url}/api/session/${session}/revert/stage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messageID: 'msg_x', files: [] }),
          }),
        status: 409,
        tag: 'ConflictError',
        message: 'session undo (/undo) is not acp supported',
      },
      {
        name: 'redo (revert clear)',
        run: () => fetch(`${url}/api/session/${session}/revert`, { method: 'DELETE' }),
        status: 409,
        tag: 'ConflictError',
        message: 'session redo (/redo) is not acp supported',
      },
      {
        name: 'background',
        run: () => fetch(`${url}/api/session/${session}/background`, { method: 'POST' }),
        status: 400,
        tag: 'InvalidRequestError',
        message: 'background blocking tools (/background) are not acp supported',
      },
      {
        name: 'synthetic (editor context)',
        run: () =>
          fetch(`${url}/api/session/${session}/synthetic`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: 'ctx_1', text: 'selection', description: 'editor', metadata: {} }),
          }),
        status: 409,
        tag: 'ConflictError',
        message: 'editor context (/synthetic) is not acp supported',
      },
      {
        name: 'fork',
        run: () =>
          fetch(`${url}/api/session/${session}/fork`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ before: 'msg_x' }),
          }),
        status: 400,
        tag: 'InvalidRequestError',
        message: 'session forking (/fork) is not acp supported',
      },
    ];
    for (const item of cases) {
      const response = await item.run();
      expect(`${item.name}: ${response.status}`).toBe(`${item.name}: ${item.status}`);
      const body = (await response.json()) as { _tag?: string; message?: string };
      expect(`${item.name}: ${body._tag}`).toBe(`${item.name}: ${item.tag}`);
      expect(`${item.name}: ${body.message}`).toBe(`${item.name}: ${item.message}`);
    }
  });

  it('answers the experimental wait verb so /undo does not hit the generic fallback', async () => {
    const url = await start('rich-turn');
    const session = await createSession(url);

    // The TUI calls `session.wait` after an interrupt and before staging an undo. The route
    // declares `successStatus: 204`; the generic unmatched-route fallback answered 200 with an
    // array, which the client rejects as UnexpectedStatus. With no turn running the wait
    // returns immediately.
    const response = await fetch(`${url}/api/experimental/session/${session}/wait`, {
      method: 'POST',
    });
    expect(response.status).toBe(204);
  });

  it('refuses /compact with a declared status instead of an undeclared 204', async () => {
    const url = await start('rich-turn');
    const session = await createSession(url);

    // The TUI's `/compact` posts here and shows the failure as a toast. The declaration is
    // `successStatus: 200, empty: false, declaredStatuses: [400,401,404,409]`, and the generated
    // client throws `UnexpectedStatus` for any status outside that set — which is what a 204 from
    // the generic unimplemented-verb fallback produced on screen.
    //
    // We cannot answer 200 with a `SessionInboxCompaction`, and must not invent one: ACP has no
    // method for a client to compact a session. `clientCapabilities.session.compaction` only
    // permits the *agent* to send compaction updates, and this bridge deliberately does not
    // advertise it. So the honest answer is a declared one.
    const refused = await fetch(`${url}/api/session/${session}/compact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(refused.status).toBe(409);
    // The spec declares the 409 body as `ConflictError` (`{_tag, message, resource?}`); the
    // conformance probe rejects anything else, which is how an earlier `{error, detail}` shape was
    // caught.
    const body = (await refused.json()) as { _tag?: string; message?: string; resource?: string };
    expect(body._tag).toBe('ConflictError');
    expect(body.message).toBe('session compaction (/compact) is not acp supported');
    expect(body.resource).toBe('session.compaction');
  });

  it('still answers 204 for the verbs the spec declares empty', async () => {
    const url = await start('rich-turn');
    const session = await createSession(url);
    // `/environment` declares `success: NoContent`, so 204 is correct there — the fallback is only
    // wrong for verbs that declare a body. This guards the distinction.
    const environment = await fetch(`${url}/api/session/${session}/environment`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ variables: {} }),
    });
    expect(environment.status).toBe(204);
  });
});

describe('the two session verbs the current client actually sends', () => {
  it('renames on POST /rename with 204, so the title does not revert', async () => {
    const url = await start('rich-turn');
    const session = await createSession(url);

    // The published spec spells this PATCH on the session; the web/desktop client
    // sends POST to /rename and requires 204 (successStatus in the generated client).
    // A 200 or a 204-from-the-wrong-branch both showed up as "the title reverts".
    const response = await fetch(`${url}/api/session/${session}/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'renamed by the client' }),
    });
    expect(response.status).toBe(204);

    const info = (await (await fetch(`${url}/api/session/${session}`)).json()) as {
      data: { title?: string };
    };
    expect(info.data.title).toBe('renamed by the client');
  });

  it('deletes a session on DELETE with 204 instead of 404', async () => {
    const url = await start('rich-turn');
    const session = await createSession(url);

    // Give it an agent session first, so there is something to release.
    await runTurn(url, session);

    const response = await fetch(`${url}/api/session/${session}`, { method: 'DELETE' });
    expect(response.status).toBe(204);
    // Gone, not merely hidden: reading it back 404s.
    expect((await fetch(`${url}/api/session/${session}`)).status).toBe(404);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(logs.join('\n')).toMatch(/agent released session/);

    // And the agent was told, so its own store does not keep growing. This is the ACP
    // `session/delete`: it is only logged once the request succeeded. It failed before
    // because the request and `dispose()` were fired separately and dispose won —
    // `AcpError: client disposed`, with the agent never hearing anything.
  });
});

describe('what the bridge writes to disk', () => {
  it('does not touch a state directory when renaming, unless asked to', async () => {
    const state = mkdtempSync(join(tmpdir(), 'oac-state-'));
    const previousXdg = process.env['XDG_STATE_HOME'];
    const previousDir = process.env['OPENCODE_ACP_CLIENT_TITLE_REQUESTS'];
    process.env['XDG_STATE_HOME'] = state;
    delete process.env['OPENCODE_ACP_CLIENT_TITLE_REQUESTS'];
    try {
      const url = await start('rich-turn');
      const session = await createSession(url);
      await fetch(`${url}/api/session/${session}/rename`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'still no file' }),
      });
      // The rename works (that is asserted above); the point here is that it left
      // nothing behind. This used to default into $XDG_STATE_HOME/<app>/title-requests.
      expect(existsSync(join(state, 'opencode-acp-client'))).toBe(false);
    } finally {
      if (previousXdg === undefined) delete process.env['XDG_STATE_HOME'];
      else process.env['XDG_STATE_HOME'] = previousXdg;
      if (previousDir !== undefined) process.env['OPENCODE_ACP_CLIENT_TITLE_REQUESTS'] = previousDir;
      deferredRemovals.push(state);
    }
  });
});

// NOT asserted, deliberately: whether `/api/fs/read/:path` should answer 404 instead of
// the generic empty envelope. The route audit of the web/desktop UI recommended 404
// (the client reads that body as *binary*, so it renders our envelope as the file's
// contents — visibly wrong), but `src/server.ts` documents the opposite rule for
// unsupported routes: a well-formed envelope, because clients read `.location` off these
// bodies unconditionally and a bare 404 crashes them. Which one `/fs/read` tolerates is
// not something either of us has measured. Settle it by opening a file in the real
// desktop app against the bridge, then change it with the evidence.

describe('shapes the client indexes into', () => {
  it('answers /api/integration/:id with an object, not an array', async () => {
    const url = await start('rich-turn');
    const response = await fetch(`${url}/api/integration/anything`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data?: { connections?: unknown } };
    // The client calls `.connections.filter(...)`; an array here throws.
    expect(Array.isArray(body.data)).toBe(false);
    expect(Array.isArray(body.data?.connections)).toBe(true);
  });
});

describe('the standard ACP model list', () => {
  it('reads models.availableModels, which the opencode shape does not use', async () => {
    // Only the standard field here — no opencode-shaped config option — which is what
    // qwen (and per the ecosystem survey gemini and kimi) actually send. Before this,
    // /api/model stayed on the acp/default placeholder and the picker was empty.
    const url = await start('rich-turn', { FAKE_ACP_MODELS: '0', FAKE_ACP_MODELS_FIELD: '1' });
    const session = await createSession(url);
    await runTurn(url, session);

    const catalog = JSON.stringify(await (await fetch(`${url}/api/model`)).json());
    expect(catalog).toContain('qwen-like-1');
    expect(catalog).toContain('qwen-like-2');
    expect(catalog).not.toContain('acp/default');
  });
});

describe('an agent whose two model surfaces disagree on spelling', () => {
  // ★ Measured with codex-acp 2.8.0: `configOptions` names `deepseek-flash` while
  // `models.availableModels` names `deepseek-flash[high]`, and `session/set_model`
  // accepts ONLY the suffixed one. Sending the bare id answered
  //   Internal error: Unsupported format of modelId: deepseek-flash.
  //   Expected: modelId[effort]
  // which the TUI showed as "Failed to switch model", so no session ever set up.
  it('switches by the spelling set_model expects, not the one the picker shows', async () => {
    // `rich-turn` presets FAKE_ACP_MODELS (an opencode-shaped option naming `fake/model-1`);
    // the suffixed shape is a different agent, so the fixture has to answer like that
    // one — otherwise the picker shows the preset models and this proves nothing.
    // `start()` defaults `FAKE_ACP_MODELS` to `'1'`; the fixture tests its variables with
    // `=== '1'`, so `'0'` would still count as on. Empty it instead.
    const url = await start('rich-turn', {
      FAKE_ACP_MODELS_SUFFIXED: '1',
      FAKE_ACP_MODELS: '',
      FAKE_ACP_MODELS_FIELD: '',
    });
    const session = await createSession(url);
    await runTurn(url, session);
    const catalog = await (await fetch(`${url}/api/model`)).json();
    const models = (catalog.data ?? []) as Array<{ id?: string; providerID?: string }>;
    // The picker is offered the bare id: that is what a person clicks.
    const bare = models.find((model) => model.id === 'suffixed-1');
    expect(models.map((m) => m.id), 'the bare id must reach the picker').toContain('suffixed-1');
    const reply = await fetch(`${url}/api/session/${session}/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: { providerID: bare?.providerID ?? 'acp', id: 'suffixed-1' } }),
    });
    // The fixture refuses the bare spelling the way codex does; the bridge has to
    // translate it to `suffixed-1[high]` before sending, so this must succeed.
    expect(reply.status).toBeLessThan(400);
  });
});

describe('both model sources at once', () => {
  it('prefers neither: an agent may send config options and the standard list', async () => {
    const url = await start('rich-turn', { FAKE_ACP_MODELS: '1', FAKE_ACP_MODELS_FIELD: '1' });
    const session = await createSession(url);
    await runTurn(url, session);
    const catalog = JSON.stringify(await (await fetch(`${url}/api/model`)).json());
    // The opencode-shaped option and the standard list both land; either alone is enough
    // for a usable picker, which is the point (qwen sends both and only one decodes).
    expect(catalog).toContain('qwen-like-1');
  });
});

describe('the workspace a session belongs to', () => {
  it('runs the agent in the directory the client asked about', async () => {
    const url = await start('rich-turn');
    const asked = mkdtempSync(join(tmpdir(), 'oac-workdir-'));
    try {
      // The desktop is multi-workspace: it names the directory on every request, and
      // the agent has to run there — not in the bridge's own directory.
      const created = (await (
        await fetch(`${url}/api/session?location[directory]=${encodeURIComponent(asked)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).json()) as { data: { id: string } };
      await runTurn(url, created.data.id);

      // The bridge's own line: it names the directory the session runs in, which is
      // the same value it hands the agent as `cwd` on session/new.
      const line = logs.find((entry) => entry.includes('-> acp') && entry.includes(' in '));
      expect(line).toBeDefined();
      expect(line).toContain(asked);
    } finally {
      deferredRemovals.push(asked);
    }
  });
});

describe('the shell the TUI runs with !command', () => {
  it('accepts the session-scoped route and its plain-string command', async () => {
    const url = await start('rich-turn');
    const session = await createSession(url);
    // Exactly what the real TUI sends (read off its own request): a session-scoped path
    // and `{"command": "ls -la"}` — a string, not the global route's nested object.
    // Exactly what the real TUI sends (read off its own request): a session-scoped path and
    // `{"command": "ls -la"}` — a string, not the global route's nested object. The id is the
    // one the client chose, which is how its events are matched.
    const shellId = 'sh_session_scoped_id';
    const created = await fetch(`${url}/api/session/${session}/shell`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: shellId, command: 'echo shell-output-marker' }),
    });
    // The protocol declares `success: NoContent` for this endpoint and the generated
    // client marks it `empty: true` — a 200 here is rejected as `UnexpectedStatus: 200`,
    // which the TUI shows as "Failed to set up session". Nothing may read this body.
    expect(created.status).toBe(204);

    // The output stays readable through the cursor-paged route after the command exits. We do not
    // read it from `/api/shell`: that list holds only in-flight shells (the client's live table),
    // which is deliberate — see the shell-history case in tests.

    let output = '';
    for (let attempt = 0; attempt < 40; attempt++) {
      // The cursor-paged route the TUI's own shell row fetches, not `/api/shell/:id`:
      // the list deliberately carries no output (sending it there made the card skip its
      // fetch and render nothing).
      const polled = (await (await fetch(`${url}/api/shell/${shellId}/output`)).json()) as {
        data: { output?: string; size?: number };
      };
      output = polled.data.output ?? '';
      if ((polled.data.size ?? 0) > 0 && (polled.data.output ?? '') !== '') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(output).toContain('shell-output-marker');
  });

  it('keeps cursor-paged output readable after the shell exits', async () => {
    const url = await start('rich-turn');
    // The global route answers immediately, unlike the session-scoped completion signal. It
    // lets us exercise the viewer contract the official TUI tests: an output cursor can advance,
    // then a final read after exit still supplies the tail.
    const started = (await (
      await fetch(`${url}/api/shell`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          command: {
            // `printf` and `sleep` are POSIX, and `node -e '<code>'` loses its quotes to
            // cmd.exe — so this is a script FILE too, for the same reason as `writeBytes`.
            command: twoStageWrite(),
          },
        }),
      })
    ).json()) as { data: { id: string } };
    const shellId = started.data.id;

    let first: { output: string; cursor: number; size: number; truncated: boolean } | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      const body = (await (await fetch(`${url}/api/shell/${shellId}/output?cursor=0`)).json()) as {
        data: { output: string; cursor: number; size: number; truncated: boolean };
      };
      if (body.data.size > 0) {
        first = body.data;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(first).toBeDefined();
    expect(first!.cursor).toBeGreaterThanOrEqual(0);
    expect(first!.cursor).toBeLessThanOrEqual(first!.size);
    expect(first!.truncated).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 350));
    const tail = (await (await fetch(`${url}/api/shell/${shellId}/output?cursor=${first!.cursor}`)).json()) as {
      data: { output: string; cursor: number; size: number; truncated: boolean };
    };
    expect(tail.data.cursor).toBe(tail.data.size);
    expect(tail.data.cursor).toBeGreaterThanOrEqual(first!.cursor);
    expect(`${first!.output}${tail.data.output}`).toBe('firstsecond');
  });

  it('uses UTF-8 bytes, not JavaScript string units, for cursor and size', async () => {
    const url = await start('rich-turn');
    const started = (await (
      await fetch(`${url}/api/shell`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // ★ `printf` does not exist in cmd.exe, so on Windows the shell produced nothing and
        // `size` stayed 0 — the test then failed on its very first wait, for a missing
        // utility rather than for the byte arithmetic it is about. `node -e` is present
        // wherever this suite runs, and writes the same bytes without a shell builtin.
        body: JSON.stringify({
          command: {
            command: writeBytes([0xc3, 0xa9, 0xf0, 0x9f, 0x99, 0x82, 0x78]), // é🙂x
          },
        }),
      })
    ).json()) as { data: { id: string } };
    const shellId = started.data.id;

    let first: { output: string; cursor: number; size: number; truncated: boolean } | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      const body = (await (await fetch(`${url}/api/shell/${shellId}/output?cursor=0&limit=2`)).json()) as {
        data: { output: string; cursor: number; size: number; truncated: boolean };
      };
      if (body.data.size > 0) {
        first = body.data;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // é is two UTF-8 bytes, 🙂 is four and x is one. The first two-byte page must
    // contain exactly é, then the next four-byte page exactly 🙂 — no UTF-16 offsets.
    expect(first).toEqual({ output: 'é', cursor: 2, size: 7, truncated: false });
    const second = (await (await fetch(`${url}/api/shell/${shellId}/output?cursor=2&limit=4`)).json()) as {
      data: { output: string; cursor: number; size: number; truncated: boolean };
    };
    expect(second.data).toEqual({ output: '🙂', cursor: 6, size: 7, truncated: false });
    const final = (await (await fetch(`${url}/api/shell/${shellId}/output?cursor=6&limit=4`)).json()) as {
      data: { output: string; cursor: number; size: number; truncated: boolean };
    };
    expect(final.data).toEqual({ output: 'x', cursor: 7, size: 7, truncated: false });
    const beyond = (await (await fetch(`${url}/api/shell/${shellId}/output?cursor=${Number.MAX_SAFE_INTEGER}`)).json()) as {
      data: { output: string; cursor: number; size: number; truncated: boolean };
    };
    expect(beyond.data).toEqual({ output: '', cursor: 7, size: 7, truncated: false });
  });

  it('removes a deleted shell from list and output endpoints', async () => {
    const url = await start('rich-turn');
    const started = (await (
      await fetch(`${url}/api/shell`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: { command: 'sleep 5' } }),
      })
    ).json()) as { data: { id: string } };
    const shellId = started.data.id;
    const removed = await fetch(`${url}/api/shell/${shellId}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);
    expect((await fetch(`${url}/api/shell/${shellId}`)).status).toBe(404);
    expect((await fetch(`${url}/api/shell/${shellId}/output`)).status).toBe(404);
    const list = (await (await fetch(`${url}/api/shell`)).json()) as { data: Array<{ id: string }> };
    expect(list.data.map((shell) => shell.id)).not.toContain(shellId);
  });
});

describe('the shell id the client chooses', () => {
  it('keeps the id the client sent, because its events are matched by id', async () => {
    const url = await start('rich-turn');
    const session = await createSession(url);
    const chosen = 'sh_client_chosen_id';
    const response = await fetch(`${url}/api/session/${session}/shell`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: chosen, command: 'echo kept' }),
    });
    // `success: NoContent` — see the other shell test.
    expect(response.status).toBe(204);
    // The id the client chose is the one the shell is filed under: it created its row
    // under that id, and matches the events against it.
    const polled = (await (await fetch(`${url}/api/shell/${chosen}`)).json()) as { data: { id: string } };
    expect(polled.data.id).toBe(chosen);
  });
});

/**
 * Read `/api/event` over a real socket. `fetch` buffers SSE under vitest and never
 * returns (the reason this file imports `node:http`), so the frames are collected here.
 */
function collectSse(url: string, ms: number): { frames: string[]; stop: () => void } {
  const frames: string[] = [];
  const req = http.get(url, (res) => {
    let buffer = '';
    res.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end < 0) break;
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.startsWith('data: ')) frames.push(frame.slice('data: '.length));
      }
    });
  });
  const timer = setTimeout(() => req.destroy(), ms);
  return { frames, stop: () => { clearTimeout(timer); req.destroy(); } };
}

describe('the shapes the two opencode clients index into', () => {
  it('answers /api/config and /api/config/shell with bare arrays', async () => {
    const url = await start('rich-turn');
    // The TUI hydrates its config store from this and calls `config.list(...).findLast`;
    // the desktop's Settings page calls `.reduce` on the shell entry. Both are arrays.
    // An object here crashes one of them, and the TUI crash is reproduced by e2e-real-tui.
    for (const path of ['/api/config', '/api/config/shell']) {
      const response = await fetch(`${url}${path}`);
      expect(response.status).toBe(200);
      expect(Array.isArray(await response.json())).toBe(true);
    }
    // And it must not be the unknown-route fallback any more.
    expect(logs.filter((line) => line.includes('unhandled route') && line.includes('/api/config/shell'))).toEqual([]);
  });

  it('answers a CORS preflight, because one client is a browser page', async () => {
    const url = await start('rich-turn');
    const preflight = await fetch(`${url}/api/session/x/model`, {
      method: 'OPTIONS',
      headers: {
        origin: 'oc://renderer',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('content-type');
    const posted = await fetch(`${url}/api/session/x/model`, {
      method: 'POST',
      headers: { origin: 'oc://renderer', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(posted.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('stamps the workspace the client asked about, and only then', async () => {
    const url = await start('rich-turn');
    const asked = '/tmp/asked-workspace';
    const withDir = (await (
      await fetch(`${url}/api/agent?location[directory]=${encodeURIComponent(asked)}`)
    ).json()) as { location: { directory: string } };
    expect(withDir.location.directory).toBe(asked);
    // No query, as the single-workspace TUI behaves: the bridge's own directory.
    const bare = (await (await fetch(`${url}/api/agent`)).json()) as { location: { directory: string } };
    expect(bare.location.directory).not.toBe(asked);
  });

  it('emits shell events the client can actually correlate and render', async () => {
    const url = await start('rich-turn');
    const session = await createSession(url);
    const chosen = 'sh_correlation_probe';
    const stream = collectSse(`${url}/api/event`, 4000);
    await new Promise((resolve) => setTimeout(resolve, 250));

    await fetch(`${url}/api/session/${session}/shell`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: chosen, command: 'echo rendered-output' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    stream.stop();

    const events = stream.frames.map((frame) => JSON.parse(frame) as {
      id: string; created?: number; metadata?: unknown;
      type: string;
      data: {
        sessionID?: string;
        output?: { output?: string; cursor?: number; size?: number; truncated?: boolean };
        shell?: { id?: string; output?: string };
      };
    });
    const started = events.find((e) => e.type === 'session.shell.started');
    const ended = events.find((e) => e.type === 'session.shell.ended');
    expect(started).toBeDefined();
    expect(ended).toBeDefined();

    for (const event of [started!, ended!]) {
      // The envelope id must name THIS shell (not an internal sequence number), and it
      // must carry the `evt_` prefix: both client generations derive the message id as
      // `event.id.replace(/^evt_/, "msg_")`, while the stored shell message is
      // `msg_<shellId>`. A bare `sh_…` id left the row pointing at `sh_…` — v2.2 resolves
      // the message before rendering and dropped the row, so `!command` showed nothing.
      expect(event.id).toBe(`evt_${chosen}`);
      expect(event.id.replace(/^evt_/, 'msg_')).toBe(`msg_${chosen}`);
      expect(event.created).toEqual(expect.any(Number));
      expect(event.metadata).toBeDefined();
      expect(event.data.sessionID).toBe(session);
      expect(event.data.shell?.id).toBe(chosen);
    }
    // This is the upstream v2 Shell.Output shape. The TUI transport's shellTerminal()
    // reads all four fields; sending the old plain-string shape left its output undefined.
    expect(ended!.data.output).toEqual({
      output: expect.stringContaining('rendered-output'),
      cursor: expect.any(Number),
      size: expect.any(Number),
      truncated: false,
    });
    expect(ended!.data.output!.cursor).toBe(ended!.data.output!.size);
    // And NOT on the shell object: the TUI's shell row skips its own fetch when the part
    // already has an output, so a value here kept the card empty.
    expect((ended!.data.shell as { output?: unknown }).output).toBeUndefined();
  });
});

describe('the model switch the client announces', () => {
  it('names the model, because the client renders "switched to <name>"', async () => {
    // The agent moves the session to a model that is in its own advertised catalog,
    // which is the case where the UI has a name to print.
    const url = await start('rich-turn', { FAKE_ACP_MODEL_UPDATE: '["fake","model-1"]' });
    const session = await createSession(url);

    const stream = collectSse(`${url}/api/event`, 6000);
    await new Promise((resolve) => setTimeout(resolve, 250));
    // The switch is announced from the agent's own `config_option_update`, which the
    // fake agent sends while a turn runs — that is the path the UI sees, not our POST.
    await runTurn(url, session);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    stream.stop();

    const selected = stream.frames
      .map((frame) => JSON.parse(frame) as { type: string; data?: { model?: { name?: unknown; modelID?: unknown } } })
      .find((event) => event.type === 'session.model.selected');
    expect(selected).toBeDefined();
    // `name` is what the line prints; without it the UI says "已切换到 undefined".
    expect(typeof selected!.data?.model?.name).toBe('string');
    expect(selected!.data?.model?.name).toBeTruthy();
  });
});

describe('a model switch to the model already selected', () => {
  it('answers 204 without calling the agent', async () => {
    // Measured on a real agent (both backend profiles): `session/set_config_option`
    // on a session that has already run — or was resumed — makes every later turn
    // fail with the agent's own "turn failed: Connection error", while the same model
    // chosen before the first turn works. The TUI re-posts its selection on mount, so
    // the no-op case is the common one; skipping it keeps the session usable and
    // saves a pointless agent call.
    const server = new BridgeServer({
      command: process.execPath,
      args: [FAKE_AGENT],
      directory: process.cwd(),
      port: 0,
      env: { FAKE_ACP_MODELS: '1' },
      onLog: (line) => logs.push(line),
    });
    servers.push(server);
    const { host, port } = await server.listen();
    const url = `http://${host}:${port}`;
    const created = (await (
      await fetch(`${url}/api/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ location: { directory: process.cwd() } }),
      })
    ).json()) as { data: { id: string } };
    const session = created.data.id;
    // Start the agent so its own config options exist (model-1 is the fixture's).
    await fetch(`${url}/api/session/${session}/message`).catch(() => undefined);

    const response = await fetch(`${url}/api/session/${session}/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: { providerID: 'fake', id: 'model-1' } }),
    });
    expect(response.status).toBe(204);
    expect(logs.join('\n')).toMatch(/already selected; not calling the agent/);
    // Our own "forwarded to the agent" line, not the agent's config_option_update
    // (which is logged as "agent switched the model -> …").
    expect(logs.join('\n')).not.toMatch(/\[bridge\] model -> fake\/model-1/);

    // A real switch still goes to the agent.
    const switched = await fetch(`${url}/api/session/${session}/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: { providerID: 'fake', id: 'model-2' } }),
    });
    expect(switched.status).toBe(204);
    expect(logs.join('\n')).toMatch(/\[bridge\] model -> fake\/model-2/);
  });
});

describe('the model value sent to the agent', () => {
  it('is the value the agent advertised, not a format we assumed', async () => {
    const url = await start('rich-turn');
    const session = await createSession(url);
    await runTurn(url, session); // the agent advertises its options on the first turn
    const catalog = (await (await fetch(`${url}/api/model`)).json()) as {
      data: Array<{ providerID?: string; modelID?: string; name?: string }>;
    };
    // A DIFFERENT model than the session's current one: switching to the one already
    // selected is a no-op the bridge answers without calling the agent.
    const target =
      catalog.data.find((entry) => entry.modelID === 'model-2') ??
      catalog.data.find((entry) => entry.providerID && entry.modelID);
    expect(target).toBeDefined();

    await fetch(`${url}/api/session/${session}/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: { providerID: target!.providerID, modelID: target!.modelID } }),
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    // The agent must have accepted it. Writing the wrong format is an error from the
    // agent ("model value must be a provider/model string"), which the desktop surfaces
    // as "request failed / unknown error" and which leaves the session on the old model.
    expect(logs.filter((line) => line.includes('/model failed'))).toEqual([]);
    expect(logs.some((line) => line.includes(`model -> ${target!.providerID}/${target!.modelID}`))).toBe(true);
  });
});

describe('the workspace a session runs in', () => {
  it('uses the directory the client named, and the bridge\'s own when it names none', async () => {
    const url = await start('rich-turn');
    const named = mkdtempSync(join(tmpdir(), 'oac-workspace-'));
    try {
      // ACP requires `cwd` on session/new, so a per-session directory is the protocol's
      // own model. The desktop names one; the single-workspace TUI names none and must
      // keep the bridge's directory, because it also checks that a session's location
      // matches the directory it is working in.
      const withDir = (await (
        await fetch(`${url}/api/session?location[directory]=${encodeURIComponent(named)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).json()) as { data: { id: string } };
      await runTurn(url, withDir.data.id);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(logs.some((line) => line.includes(`in ${named}`))).toBe(true);

      const bare = await createSession(url);
      await runTurn(url, bare);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const bareLine = logs.find((line) => line.includes(bare) && line.includes('-> acp'));
      expect(bareLine).toBeDefined();
      expect(bareLine).toContain(`in ${process.cwd()}`);
    } finally {
      deferredRemovals.push(named);
    }
  });
});

describe('a session the client remembers but this bridge has never seen', () => {
  it('adopts an agent-native UUID the map never saw — the dsh-web-ui id case', async () => {
    const url = await start('rich-turn');
    // The client keeps its own session list across runs, and a UUID it remembers can be
    // the AGENT's own id (copied from dsh's web UI, or a native run): `session/load` is
    // the stable way to pick those up, so they are adopted with the id as-is.
    const remembered = '9b7f6d52-1c3e-4f8a-9d2b-6e5c8a1b2d34';
    const response = await fetch(`${url}/api/session/${remembered}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data?: { id?: string } };
    expect(body.data?.id).toBe(remembered);
    expect(logs.some((line) => line.includes(`adopting session ${remembered}`))).toBe(true);
    // And it is in the list afterwards, so a reload finds it too.
    const listed = (await (await fetch(`${url}/api/session`)).json()) as { data: Array<{ id: string }> };
    expect(listed.data.some((entry) => entry.id === remembered)).toBe(true);
  });

  it('refuses to adopt a bridge-minted id the map lost — fabricating a session under it lied to the user', async () => {
    const url = await start('rich-turn');
    // A `ses_…` id is bridge-minted; agents mint UUIDs. If the map lost the pairing,
    // loading the visible id as an agent id can only fail — and the NOT-resumed
    // fallback used to start a BRAND-NEW session under that id: a working, empty
    // tab wearing a real conversation's name (the owner's "切过去后也是空的").
    // 404 is the honest answer; the client drops the tab instead of pretending.
    const lost = 'ses_remembered_but_unmapped';
    const response = await fetch(`${url}/api/session/${lost}`);
    expect(response.status).toBe(404);
    expect(logs.some((line) => line.includes(`refusing to adopt '${lost}'`))).toBe(true);
    // Garbage the client remembered gets the same 404.
    const garbage = await fetch(`${url}/api/session/dummy`);
    expect(garbage.status).toBe(404);
  });
});

describe('what the shell list tells the client', () => {
  it('scopes a running shell to its session and says where it ran', async () => {
    const url = await start('rich-turn');
    const session = await createSession(url);
    // The global route answers immediately, unlike the session-scoped one, whose HTTP response is
    // the completion signal and therefore returns only after the command settled. `sleep` keeps
    // the shell in flight, which matters: the list is the client's live table and holds only
    // running shells, so a command that finishes before we read would legitimately be absent.
    const shellId = 'sh_scoped_running';
    await fetch(`${url}/api/shell`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: { command: 'sleep 5', cwd: undefined } }),
    });
    const listed = (await (await fetch(`${url}/api/shell`)).json()) as {
      data: Array<{ id: string; status?: string; metadata?: { sessionID?: string }; location?: { directory?: string; project?: { id?: string } } }>;
    };
    const entry = listed.data.find((row) => row.status === 'running');
    expect(entry).toBeDefined();
    // The TUI draws a shell's card inside a session by `metadata.sessionID`
    // (`data.shell.listBySession`), and opens the output dialog with `entry.location`.
    expect(entry!.metadata?.sessionID).toBe(session);
    expect(entry!.location?.directory).toBeTruthy();
    expect(entry!.location?.project?.id).toMatch(/^proj/);
  });

  it('drops a finished shell from the live list but keeps its output readable', async () => {
    const url = await start('rich-turn');
    const session = await createSession(url);
    const shellId = 'sh_finished_but_readable';
    await fetch(`${url}/api/session/${session}/shell`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: shellId, command: 'echo still-readable' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 400));

    // The client derives `backgroundRunning` from this list, so an exited shell must leave it —
    // otherwise the reopened card spins forever. The record itself survives, because the official
    // viewer's final read after exit is the output route.
    const listed = (await (await fetch(`${url}/api/shell`)).json()) as { data: Array<{ id: string }> };
    expect(listed.data.map((row) => row.id)).not.toContain(shellId);

    const output = (await (await fetch(`${url}/api/shell/${shellId}/output`)).json()) as {
      data: { output?: string; cursor?: number; size?: number };
    };
    // ★ `echo` is the PLATFORM's echo: cmd.exe terminates with CRLF, not LF. Asserting the
    // exact POSIX bytes made a correct capture look wrong on windows-latest.
    expect(output.data.output).toBe(process.platform === 'win32' ? 'still-readable\r\n' : 'still-readable\n');
    expect(output.data.cursor).toBe(output.data.size);
  });
});

describe('the transcript of a session adopted from the client', () => {
  it('loads it before answering, so the history is there and not blank', async () => {
    // The map must know the pairing for a `ses_…` adoption (a bridge-minted id is
    // never an agent id on its own); seed it the way a previous run would have.
    const mapPath = join(mkdtempSync(join(tmpdir(), 'oac-adopt-')), 'sessions.json');
    writeFileSync(
      mapPath,
      JSON.stringify({
        ses_adopted_for_history: {
          acpSessionId: 'adopted-for-history',
          directory: process.cwd(),
          // Every entry a current run writes carries the binding; an entry without it is
          // refused (its owner is unknown), which is a different test.
          agent: { command: process.execPath, args: [FAKE_AGENT] },
          updatedAt: Date.now(),
        },
      }),
    );
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    try {
    const url = await start('rich-turn');
    const remembered = 'ses_adopted_for_history';
    // First the session itself is adopted (that is what a remembered tab does)...
    expect((await fetch(`${url}/api/session/${remembered}`)).status).toBe(200);
    // ...then the transcript is asked for. The agent is lazy, so this is the moment its
    // `session/load` has to happen; without it the answer is an empty list and the tab
    // opens blank.
    const messages = (await (await fetch(`${url}/api/session/${remembered}/message`)).json()) as {
      data: unknown[];
    };
    expect(Array.isArray(messages.data)).toBe(true);
    // The visible id was translated to the agent's, and THAT id was loaded (or
    // honestly refused) — the map is the pairing, the load is the pickup.
    expect(logs.some((line) => line.includes(`session map: ${remembered} is the agent's adopted-for-history`))).toBe(true);
    // The restore branch always names the agent id it took, whatever the outcome:
    // loading (this fixture has no capability, so normally not), resuming without a
    // replay, or an honest "cannot resume". What matters: the AGENT's id is the one
    // on the wire, translated from the map's pairing.
    expect(
      logs.some(
        (line) =>
          line.includes("'adopted-for-history'") &&
          (line.includes('asking the agent to load') ||
            line.includes('without replay') ||
            line.includes('cannot resume')),
      ),
    ).toBe(true);
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
    }
  });
});

describe('the marker a restored tab carries in its title', () => {
  // The title is the only surface that says WHAT a restored tab is, and the client
  // persists it — so it has to be idempotent, and a legacy marker must not nest.
  it('replaces a previous marker instead of stacking one', () => {
    expect(markTitle('tau', 'tau', '[no transcript]')).toBe('[no transcript] tau');
    expect(markTitle('[new conversation] tau', 'tau', '[no transcript]')).toBe('[no transcript] tau');
    expect(markTitle('[not resumed] tau', 'tau', '[new conversation]')).toBe('[new conversation] tau');
  });

  it('strips the legacy `[not resumed]` marker, which the client may still have stored', () => {
    expect(markTitle('[not resumed] [not resumed] tau', 'tau', '[new conversation]')).toBe(
      '[new conversation] tau',
    );
  });

  it('falls back to the id when there is no title at all', () => {
    expect(markTitle(undefined, 'ses_eb6a', '[no transcript]')).toBe('[no transcript] ses_eb6a');
    expect(markTitle('   ', 'ses_eb6a', '[new conversation]')).toBe('[new conversation] ses_eb6a');
  });
});

describe('a model switch the agent refuses', () => {
  it('answers the declared 400 and leaves the session on the old model', async () => {
    const server = new BridgeServer({
      command: process.execPath,
      args: [FAKE_AGENT],
      directory: process.cwd(),
      port: 0,
      env: { FAKE_ACP_MODELS: '1', FAKE_ACP_SET_CONFIG_FAILS: '1' },
      onLog: (line) => logs.push(line),
    });
    servers.push(server);
    const { host, port } = await server.listen();
    const url = `http://${host}:${port}`;
    const created = (await (await fetch(`${url}/api/session`, { method: 'POST', body: '{}' })).json()) as {
      data: { id: string };
    };
    const switched = await fetch(`${url}/api/session/${created.data.id}/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: { providerID: 'fake', id: 'model-2' } }),
    });
    expect(switched.status).toBe(400);
    const body = (await switched.json()) as { _tag?: string; message?: string };
    expect(body._tag).toBe('InvalidRequestError');
    expect(body.message).toContain('refused the model switch');
    expect(logs.join('\n')).toMatch(/\/model failed: Invalid params: model switch refused/);
  });
});

describe('a fresh conversation is one session, not two', () => {
  it('adopts the pre-created shell instead of creating a duplicate', async () => {
    // Measured: a fresh TUI run ended with two sessions (an empty one titled after the
    // directory) and two agent processes — the shell's (warmed for the catalog) and the
    // record the client's POST created. The shell is not a conversation; the client's POST
    // adopts it, re-keyed to the id the client chose, keeping its warm agent.
    const dir = mkdtempSync(join(tmpdir(), 'oac-r7-'));
    const mapPath = join(dir, 'sessions.json');
    const previousMap = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    const server = new BridgeServer({
      command: process.execPath,
      args: [FAKE_AGENT],
      directory: dir,
      port: 0,
      env: { FAKE_ACP_MODELS: '1', FAKE_ACP_SCENARIO: 'rich-turn' },
      onLog: (line) => logs.push(line),
    });
    servers.push(server);
    const { host, port } = await server.listen();
    const url = `http://${host}:${port}`;
    try {

    // What the TUI does before the user types: a session route and the catalog.
    await fetch(`${url}/api/session/active`);
    await fetch(`${url}/api/model`);
    const before = (await (await fetch(`${url}/api/session`)).json()) as { data: Array<{ id: string }> };
    expect(before.data).toHaveLength(1);
    const shell = before.data[0]!.id;

    const created = (await (
      await fetch(`${url}/api/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'ses_clientchosen', location: { directory: dir } }),
      })
    ).json()) as { data: { id: string } };
    expect(created.data.id).toBe('ses_clientchosen');

    await fetch(`${url}/api/session/ses_clientchosen/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello there' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const after = (await (await fetch(`${url}/api/session`)).json()) as { data: Array<{ id: string; title?: string }> };
    expect(after.data).toHaveLength(1);
    expect(after.data[0]!.id).toBe('ses_clientchosen');
    const log = logs.join('\n');
    expect(log).toMatch(new RegExp(`adopted the pre-created session as ses_clientchosen`));
    expect(log).toContain(`pre-created session ${shell}`);
    // The warm agent is reused: no second agent, so no "cannot resume … new conversation".
    expect(log).not.toMatch(/cannot resume/);

      // ★ The map pairing moves with the record, or the id the exit epilogue prints has no
      // entry and `-s <it>` answers "unknown session id" (measured by the owner, 2026-10-18).
      const map = JSON.parse(readFileSync(mapPath, 'utf8')) as Record<string, { acpSessionId: string }>;
      expect(map['ses_clientchosen']).toBeDefined();
      expect(map[shell]).toBeUndefined();
      expect(resolveSessionId('ses_clientchosen')).toBe(map['ses_clientchosen']!.acpSessionId);
    } finally {
      if (previousMap === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previousMap;
      deferredRemovals.push(dir);
    }
  });
});

describe('a session remembers which agent created it', () => {
  const withMap = async (
    makeEntries: (dir: string) => Record<string, unknown>,
    body: (url: string, logs: string[]) => Promise<void>,
  ): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-agent-id-'));
    const mapPath = join(dir, 'sessions.json');
    // The session's directory must exist: the agent is spawned with it as cwd.
    writeFileSync(mapPath, JSON.stringify(makeEntries(dir)));
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    try {
      const logs: string[] = [];
      const server = new BridgeServer({
        command: process.execPath,
        args: [FAKE_AGENT],
        directory: dir,
        port: 0,
        env: {
          FAKE_ACP_MODELS: '1',
          FAKE_ACP_SCENARIO: 'rich-turn',
          // A restored tab's transcript can only come from `session/load`'s replay.
          FAKE_ACP_CAPS_LOAD_SESSION: '1',
          FAKE_ACP_REPLAY_ON_LOAD: '1',
        },
        onLog: (line) => logs.push(line),
      });
      servers.push(server);
      const { host, port } = await server.listen();
      await body(`http://${host}:${port}`, logs);
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
      deferredRemovals.push(dir);
    }
  };

  it("refuses a session created by another agent (one client drives one agent)", async () => {
    // ACP has no "this session belongs to that agent": a remembered id would be handed to
    // whatever agent the current run launched. The map records the binding; the bridge used
    // to spawn THAT agent for the tab, which let an opencode tab live inside a dsh launch
    // and leak its model catalog into the new tab. Owner's decision (2026-10-19): one client
    // drives one agent, so the foreign tab is refused (the TUI's state is per agent too).
    const other = { command: process.execPath, args: [FAKE_AGENT, '--from-map'] };
    await withMap(
      (dir) => ({
        ses_foreign: { acpSessionId: 'other-1', directory: dir, agent: other, updatedAt: 1 },
        ses_legacy: { acpSessionId: 'other-2', directory: dir, updatedAt: 1 },
      }),
      async (url, logs) => {
        const foreign = await fetch(`${url}/api/session/ses_foreign`);
        expect(foreign.status).toBe(404);
        expect(logs.join('\n')).toMatch(/refusing 'ses_foreign': it belongs to/);
        // An entry from before the field existed has no owner: refuse instead of guessing
        // (it may have been created by any agent), and say what to do.
        const legacy = await fetch(`${url}/api/session/ses_legacy`);
        expect(legacy.status).toBe(404);
        expect(logs.join('\n')).toMatch(/its map entry predates the agent binding/);
      },
    );
  });

  it('stamps the identity when a session is created', async () => {
    await withMap(() => ({}), async (url) => {
      const created = await fetch(`${url}/api/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const session = ((await created.json()) as { data: { id: string } }).data.id;
      await fetch(`${url}/api/session/${session}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      const mapPath = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP']!;
      const deadline = Date.now() + 5_000;
      let entry: { agent?: { command: string; args: string[] } } | undefined;
      while (Date.now() < deadline) {
        try {
          const data = JSON.parse(readFileSync(mapPath, 'utf8')) as Record<
            string,
            { agent?: { command: string; args: string[] } }
          >;
          entry = data[session];
          if (entry?.agent) break;
        } catch {
          // The bridge writes the file when the pairing is learned; retry.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(entry?.agent).toEqual({ command: process.execPath, args: [FAKE_AGENT] });
    });
  });
});

describe('hydrating several remembered tabs at once', () => {
  it('loads the first transcript and answers a background tab without a second load', async () => {
    // The client hydrates every remembered tab's messages ~300ms after connect. Native
    // opencode can afford that (one process, SQLite reads); here each load is a whole
    // agent process doing session/load, and a single-writer backend refuses the second.
    // Measured failing shape: N tabs → N agents, and the later loads failed.
    const dir = mkdtempSync(join(tmpdir(), 'oac-lazy-tabs-'));
    const mapPath = join(dir, 'sessions.json');
    writeFileSync(
      mapPath,
      JSON.stringify({
        ses_tab_first: {
          acpSessionId: 'agent-first',
          directory: dir,
          agent: { command: process.execPath, args: [FAKE_AGENT] },
          updatedAt: Date.now(),
        },
        ses_tab_background: {
          acpSessionId: 'agent-background',
          directory: dir,
          agent: { command: process.execPath, args: [FAKE_AGENT] },
          updatedAt: Date.now(),
        },
      }),
    );
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    try {
      const logs: string[] = [];
      const server = new BridgeServer({
        command: process.execPath,
        args: [FAKE_AGENT],
        directory: dir,
        port: 0,
        env: {
          FAKE_ACP_MODELS: '1',
          FAKE_ACP_CAPS_LOAD_SESSION: '1',
          FAKE_ACP_REPLAY_ON_LOAD: '1',
          FAKE_ACP_DELAY_SESSION_LOAD_MS: '700',
        },
        onLog: (line) => logs.push(line),
      });
      servers.push(server);
      const { host, port } = await server.listen();
      const base = `http://${host}:${port}`;

      // The client syncs each tab's METADATA first (cheap: adoption only), then the
      // transcripts. Only the bare session read adopts; a subroute of an unknown session
      // is a 404 by design.
      await fetch(`${base}/api/session/ses_tab_first`);
      await fetch(`${base}/api/session/ses_tab_background`);

      // The visible tab's read starts the one load…
      const first = fetch(`${base}/api/session/ses_tab_first/message`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      // …and the background tab's read, arriving mid-load, must not start another.
      const background = (await (await fetch(`${base}/api/session/ses_tab_background/message`)).json()) as {
        data: unknown[];
      };
      const visible = (await (await first).json()) as { data: unknown[] };

      expect(visible.data.length).toBeGreaterThan(0);
      expect(background.data).toEqual([]);
      expect(logs.join('\n')).toMatch(/lazy: ses_tab_background answered without loading/);

      // Opening that tab later must still load it — lazy, not broken. The client mounts
      // the session when the user switches, which re-reads the transcript.
      const opened = (await (await fetch(`${base}/api/session/ses_tab_background/message`)).json()) as {
        data: unknown[];
      };
      expect(opened.data.length).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
      deferredRemovals.push(dir);
    }
  });

  it('loads the tab on screen when it lost the startup race', async () => {
    // The burst can invert: a background tab's read arrives first and takes the
    // load, leaving the tab the user is looking at with an empty transcript until
    // it is re-mounted. The focus signal (the client's singular GET) must fetch it.
    const dir = mkdtempSync(join(tmpdir(), 'oac-lazy-focus-'));
    const mapPath = join(dir, 'sessions.json');
    const entry = (agent: string) => ({
      acpSessionId: agent,
      directory: dir,
      agent: { command: process.execPath, args: [FAKE_AGENT] },
      updatedAt: Date.now(),
    });
    writeFileSync(
      mapPath,
      JSON.stringify({ ses_on_screen: entry('agent-screen'), ses_off_screen: entry('agent-off') }),
    );
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    try {
      const logs: string[] = [];
      const server = new BridgeServer({
        command: process.execPath,
        args: [FAKE_AGENT],
        directory: dir,
        port: 0,
        env: {
          FAKE_ACP_MODELS: '1',
          FAKE_ACP_CAPS_LOAD_SESSION: '1',
          FAKE_ACP_REPLAY_ON_LOAD: '1',
          FAKE_ACP_DELAY_SESSION_LOAD_MS: '700',
        },
        onLog: (line) => logs.push(line),
      });
      servers.push(server);
      const { host, port } = await server.listen();
      const base = `http://${host}:${port}`;
      // Adopt both (cheap metadata reads), then let the OFF-SCREEN tab win the load.
      await fetch(`${base}/api/session/ses_on_screen`);
      await fetch(`${base}/api/session/ses_off_screen`);
      const off = fetch(`${base}/api/session/ses_off_screen/message`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const onScreen = (await (await fetch(`${base}/api/session/ses_on_screen/message`)).json()) as {
        data: unknown[];
      };
      await (await off).json();
      // It answered empty (lazy) — the race went the wrong way…
      expect(onScreen.data).toEqual([]);
      expect(logs.join('\n')).toMatch(/lazy: ses_on_screen answered without loading/);

      // …and the client now says that IS the tab on screen. It must be loaded then.
      await fetch(`${base}/api/session/ses_on_screen`);
      const after = await (async () => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const listed = (await (await fetch(`${base}/api/session/ses_on_screen/message`)).json()) as {
            data: unknown[];
          };
          if (listed.data.length > 0) return listed;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return { data: [] as unknown[] };
      })();
      expect(after.data.length).toBeGreaterThan(0);
      expect(logs.join('\n')).toMatch(/is the tab on screen, loading it now/);
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
      deferredRemovals.push(dir);
    }
  });
});

describe('a new tab after a restored tab from another agent', () => {
  it("serves the launch agent's models, and ignores the restored tab's stale pick", async () => {
    // Reported: launch with dsh in a directory that had an opencode tab. The TUI restored
    // the opencode tab, the new tab's composer showed opencode's models, and sending a
    // prompt failed with "Failed to set up session" / "Failed to switch model". The model
    // catalog must belong to the tab in front (here: the newly created one), and a stale
    // re-post of the other agent's model must not be forwarded to the new agent.
    const dir = mkdtempSync(join(tmpdir(), 'oac-mixed-'));
    const mapPath = join(dir, 'sessions.json');
    writeFileSync(
      mapPath,
      JSON.stringify({
        ses_old: {
          acpSessionId: 'agent-old',
          directory: dir,
          agent: { command: process.execPath, args: [FAKE_AGENT, '--model-only=model-1'] },
          updatedAt: 1,
        },
      }),
    );
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    try {
      const server = new BridgeServer({
        command: process.execPath,
        args: [FAKE_AGENT, '--model-only=model-2'],
        directory: dir,
        port: 0,
        env: { FAKE_ACP_MODELS: '1' },
        onLog: (line) => logs.push(line),
      });
      servers.push(server);
      const { host, port } = await server.listen();
      const base = `http://${host}:${port}`;
      const catalog = async (): Promise<string[]> =>
        ((await (await fetch(`${base}/api/model`)).json()) as { data: Array<{ modelID?: string }> }).data.map(
          (m) => m.modelID ?? '',
        );

      // The TUI's per-agent state means it should not ask for the other agent's tab at
      // all; if anything still does (a stale tab, a -s, a hand-written map), the bridge
      // refuses instead of spawning the other agent.
      const refused = await fetch(`${base}/api/session/ses_old`);
      expect(refused.status).toBe(404);

      // Then it creates the new tab. Its catalog must be the launch agent's.
      const created = (await (
        await fetch(`${base}/api/session`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: 'ses_new' }),
        })
      ).json()) as { data: { id: string } };
      expect(created.data.id).toBe('ses_new');
      expect(await catalog()).toEqual(['model-2']);

      // A model this client's agent never offered is refused (400). With one client =
      // one agent the other agent's catalog is not live, so the old 204 "belongs to
      // another live agent" path cannot be reached here; the refusal is the honest one.
      const reply = await fetch(`${base}/api/session/ses_new/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: { providerID: 'fake', modelID: 'model-1' } }),
      });
      expect(reply.status).toBe(400);
      expect(await catalog()).toEqual(['model-2']);
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
      deferredRemovals.push(dir);
    }
  });
});

describe('adopting a remembered session whose directory is spelled differently', () => {
  it('reports the workspace the client is showing (macOS /var vs /private/var)', async () => {
    // The map stores what the client sent when it created the session (the physical
    // spelling on macOS); the bridge was launched with the logical one, and that is the
    // workspace the client learns from `/api/project`. Reporting the map's spelling made
    // the client treat the restored session as another workspace and drop the tab —
    // measured: a restart lost the very tab it had just restored.
    const dir = mkdtempSync(join(tmpdir(), 'oac-adopt-spelling-'));
    const physical = realpathSync(dir);
    const mapPath = join(dir, 'sessions.json');
    writeFileSync(
      mapPath,
      JSON.stringify({
        ses_spelling: {
          acpSessionId: 'agent-1',
          directory: physical,
          agent: { command: process.execPath, args: [FAKE_AGENT] },
          updatedAt: Date.now(),
        },
      }),
    );
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    try {
      const server = new BridgeServer({
        command: process.execPath,
        args: [FAKE_AGENT],
        directory: dir,
        port: 0,
        env: { FAKE_ACP_MODELS: '1' },
        onLog: (line) => logs.push(line),
      });
      servers.push(server);
      const { host, port } = await server.listen();
      const info = (await (
        await fetch(`http://${host}:${port}/api/session/ses_spelling`)
      ).json()) as { data: { location?: { directory?: string } } };
      expect(info.data.location?.directory).toBe(dir);
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
      deferredRemovals.push(dir);
    }
  });
});

describe('a workspace keeps one project id', () => {
  it('hashes the canonical path, so /var and /private/var agree', () => {
    // macOS: the bridge's launch directory is the logical spelling while the client's
    // cwd is the physical one. Hashing the raw string split one workspace into two
    // project ids, and the client's session list — filtered by project — could hide the
    // session it had just restored (measured on a TMPDIR workspace).
    const logical = tmpdir();
    const physical = realpathSync(logical);
    expect(projectIdFor(logical)).toBe(projectIdFor(physical));
    // Different directories still differ, and a path that does not exist keeps its text.
    expect(projectIdFor(logical)).not.toBe(projectIdFor(process.cwd()));
    expect(projectIdFor('/no/such/dir/here')).toMatch(/^proj_[0-9a-f]{12}$/);
  });
});

describe('the fallback title from the first message', () => {
  // ACP has no client-side title method, and the plain ACP profile publishes no
  // titles at all — without a fallback every such session is stuck on the client's
  // "New session" (the owner's first report). The first prompt is the only
  // deterministic, local source of a name; an agent title still wins.
  it('flattens to one line, truncates, and refuses an empty prompt', () => {
    expect(derivedTitle('  hello\n\n   world  ')).toBe('hello world');
    expect(derivedTitle('')).toBeUndefined();
    expect(derivedTitle(' \n\t ')).toBeUndefined();
    expect(derivedTitle('x'.repeat(60))).toBe(`${'x'.repeat(48)}…`);
    // Code points, not UTF-16 units: a CJK prompt must not be cut mid-character.
    const cjk = derivedTitle('汉'.repeat(60));
    expect(Array.from(cjk!).length).toBe(49);
    expect(cjk!.endsWith('…')).toBe(true);
  });

  it('titles the session from its first prompt and never re-derives', async () => {
    const url = await start('rich-turn');
    const session = await createSession(url);
    const stream = collectSse(`${url}/api/event`, 6000);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await runTurn(url, session, 'Explain the session map');
    await new Promise((resolve) => setTimeout(resolve, 400));

    const info = (await (await fetch(`${url}/api/session/${session}`)).json()) as {
      data: { title?: string };
    };
    expect(info.data.title).toBe('Explain the session map');
    // The frame that actually moves the tab: the client's store has no case for
    // `session.updated`.
    stream.stop();
    const renamed = stream.frames
      .map((frame) => JSON.parse(frame) as { type: string; data?: { sessionID?: string; title?: string } })
      .filter((event) => event.type === 'session.renamed' && event.data?.sessionID === session);
    expect(renamed.some((event) => event.data?.title === 'Explain the session map')).toBe(true);

    // A later prompt does not rename it again: a title is an identity, not a log.
    await runTurn(url, session, 'Something completely different');
    const after = (await (await fetch(`${url}/api/session/${session}`)).json()) as {
      data: { title?: string };
    };
    expect(after.data.title).toBe('Explain the session map');
  });

  it('does not re-title a session restored from the map (-s)', async () => {
    // Reported 2026-10-20: `-s ses_acp_…` restored the real title, then the FIRST
    // prompt renamed the tab and the sidebar to the prompt text; a restart restored
    // it. The remembered title is not a default, so the derive fallback must not run.
    const dir = mkdtempSync(join(tmpdir(), 'oac-restored-title-'));
    const mapPath = join(dir, 'sessions.json');
    writeFileSync(
      mapPath,
      JSON.stringify({
        ses_keep: {
          acpSessionId: 'agent-keep',
          directory: dir,
          title: 'Original title',
          agent: { command: process.execPath, args: [FAKE_AGENT] },
          updatedAt: 1,
        },
      }),
    );
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    try {
      const server = new BridgeServer({
        command: process.execPath,
        args: [FAKE_AGENT],
        directory: dir,
        port: 0,
        env: { FAKE_ACP_MODELS: '1', FAKE_ACP_CAPS_RESUME: '1' },
        resumeVisibleSessionId: 'ses_keep',
        onLog: (line) => logs.push(line),
      });
      servers.push(server);
      const { host, port } = await server.listen();
      const url = `http://${host}:${port}`;
      await server.waitForCatalog(5_000);

      const stream = collectSse(`${url}/api/event`, 6000);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await runTurn(url, 'ses_keep', 'this prompt must not rename the restored session');
      await new Promise((resolve) => setTimeout(resolve, 400));

      const info = (await (await fetch(`${url}/api/session/ses_keep`)).json()) as {
        data: { title?: string };
      };
      expect(info.data.title).toBe('Original title');
      stream.stop();
      const renamed = stream.frames
        .map((frame) => JSON.parse(frame) as { type: string; data?: { sessionID?: string; title?: string } })
        .filter((event) => event.type === 'session.renamed' && event.data?.sessionID === 'ses_keep');
      expect(renamed.some((event) => event.data?.title?.includes('must not rename'))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
      deferredRemovals.push(dir);
    }
  });

  it('keeps the remembered title when a tab is adopted', async () => {
    // The same protection for the tab path (GET /api/session/<id> adoption): the
    // remembered title is written at creation, so the first prompt cannot replace it.
    const dir = mkdtempSync(join(tmpdir(), 'oac-adopted-title-'));
    const mapPath = join(dir, 'sessions.json');
    writeFileSync(
      mapPath,
      JSON.stringify({
        ses_keep: {
          acpSessionId: 'agent-keep',
          directory: dir,
          title: 'Adopted title',
          agent: { command: process.execPath, args: [FAKE_AGENT] },
          updatedAt: 1,
        },
      }),
    );
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    try {
      const server = new BridgeServer({
        command: process.execPath,
        args: [FAKE_AGENT],
        directory: dir,
        port: 0,
        env: { FAKE_ACP_MODELS: '1', FAKE_ACP_CAPS_RESUME: '1' },
        onLog: (line) => logs.push(line),
      });
      servers.push(server);
      const { host, port } = await server.listen();
      const url = `http://${host}:${port}`;
      expect((await fetch(`${url}/api/session/ses_keep`)).status).toBe(200);
      await runTurn(url, 'ses_keep', 'adoption prompt must not rename');
      const info = (await (await fetch(`${url}/api/session/ses_keep`)).json()) as {
        data: { title?: string };
      };
      expect(info.data.title).toBe('Adopted title');
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
      deferredRemovals.push(dir);
    }
  });

  it('lets the agent title win when it arrives', async () => {
    const url = await start('rich-turn', { FAKE_ACP_TITLE: 'Named by the agent' });
    const session = await createSession(url);
    await runTurn(url, session, 'please name this session');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const info = (await (await fetch(`${url}/api/session/${session}`)).json()) as {
      data: { title?: string };
    };
    expect(info.data.title).toBe('Named by the agent');
  });

  it('lets a user rename win over the fallback', async () => {
    const url = await start('rich-turn');
    const session = await createSession(url);
    await fetch(`${url}/api/session/${session}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'mine' }),
    });
    await runTurn(url, session, 'this prompt must not rename it');
    const info = (await (await fetch(`${url}/api/session/${session}`)).json()) as {
      data: { title?: string };
    };
    expect(info.data.title).toBe('mine');
  });
});

describe('activity after the turn ended', () => {
  it('records late reasoning in history without emitting reasoning UI events', async () => {
    // dsh's background job starts a new internal turn after the prompt result and
    // streams reasoning into the same session. The late part must be in the
    // transcript, but a `reasoning.started` on the completed message made the TUI
    // show a thinking spinner that then vanished (reported 2026-10-20).
    const url = await start('rich-turn', { FAKE_ACP_LATE_REASONING: '1' });
    const session = await createSession(url);
    const stream = collectSse(`${url}/api/event`, 6000);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await runTurn(url, session, 'go');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    stream.stop();

    const events = stream.frames.map((frame) => JSON.parse(frame) as { type: string });
    const stepEnd = events.map((event) => event.type).lastIndexOf('session.step.ended');
    const lateReasoning = events
      .slice(stepEnd + 1)
      .filter((event) => event.type.startsWith('session.reasoning.'));
    expect(lateReasoning).toEqual([]);

    const list = (await (await fetch(`${url}/api/session/${session}/message`)).json()) as {
      data: Array<{ content?: Array<{ type?: string; text?: string; time?: { completed?: number } }> }>;
    };
    const late = list.data
      .flatMap((message) => message.content ?? [])
      .find((content) => content.type === 'reasoning' && content.text?.includes('late thought after the turn'));
    expect(late).toBeDefined();
    expect(typeof late?.time?.completed).toBe('number');
  });
});

describe('a turn whose agent cannot start at all', () => {
  it('renders the failure next to the user row instead of failing silently on the wire', async () => {
    // AGENTS.md §5.1 path ②: spawn / initialize / session/new failing happens BEFORE
    // the turn begins, so there is no message to attach an error to — the request
    // rejected and the screen kept the user's optimistic row followed by nothing
    // forever. Measured to be exactly that shape once the agent command is broken.
    const server = new BridgeServer({
      command: 'oc-acp-client-no-such-agent-binary',
      args: [],
      directory: process.cwd(),
      port: 0,
      env: { FAKE_ACP_MODELS: '1' },
      onLog: (line) => logs.push(line),
    });
    servers.push(server);
    const { host, port } = await server.listen();
    const url = `http://${host}:${port}`;
    const created = (await (
      await fetch(`${url}/api/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ location: { directory: process.cwd() } }),
      })
    ).json()) as { data: { id: string } };
    const session = created.data.id;

    const stream = collectSse(`${url}/api/event`, 5000);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const response = await fetch(`${url}/api/session/${session}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    // The request itself still succeeds: the failure lives in the transcript, where
    // the client renders it, not in an HTTP status the client shows as a toast.
    expect(response.status).toBe(200);
    // Same envelope as a normal prompt response (`{location, data:{info, parts}}`),
    // so the client has nothing unusual to interpret.
    const body = (await response.json()) as {
      data: { info?: { role?: string; error?: { message?: string } } };
    };
    expect(body.data.info?.role).toBe('assistant');
    expect(body.data.info?.error?.message).toMatch(/could not start the agent/);

    await new Promise((resolve) => setTimeout(resolve, 600));
    stream.stop();
    const failed = stream.frames
      .map((frame) => JSON.parse(frame) as { type: string; data?: { error?: { message?: string } } })
      .find((event) => event.type === 'session.step.failed');
    expect(failed).toBeDefined();
    expect(failed?.data?.error?.message).toMatch(/could not start the agent/);

    // And it is a persistent row, not just an event: reading the transcript gives it
    // back with the error the TUI paints.
    const messages = (await (await fetch(`${url}/api/session/${session}/message`)).json()) as {
      data: Array<{ role?: string; error?: { message?: string } }>;
    };
    const assistant = messages.data.find((message) => message.role === 'assistant');
    expect(assistant?.error?.message).toMatch(/could not start the agent/);
  });
});

describe('continue-mode with nothing to continue', () => {
  it('marks the pre-created record as a NEW conversation, not a lost continuation', async () => {
    // `-c` asks for the previous conversation. When the agent cannot list sessions
    // (or lists none for this directory) the launcher resolves nothing and the
    // client's own `-c` lands on an empty record; unmarked, it looks like a
    // continuation whose history silently vanished.
    const server = new BridgeServer({
      command: process.execPath,
      args: [FAKE_AGENT],
      directory: process.cwd(),
      port: 0,
      env: { FAKE_ACP_MODELS: '1' },
      continueMode: true,
      onLog: (line) => logs.push(line),
    });
    servers.push(server);
    const { host, port } = await server.listen();
    const listed = (await (await fetch(`http://${host}:${port}/api/session`)).json()) as {
      data: Array<{ title?: string }>;
    };
    expect(listed.data[0]?.title).toMatch(/^\[new conversation\] /);
    expect(logs.some((line) => line.includes('nothing to continue'))).toBe(true);
  });
});

describe('the tool row a shell expands into', () => {
  it('emits the part the transcript renders a !command in', async () => {
    const url = await start('rich-turn');
    const session = await createSession(url);
    const chosen = 'sh_tool_row_probe';
    const stream = collectSse(`${url}/api/event`, 5000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await fetch(`${url}/api/session/${session}/shell`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: chosen, command: 'echo tool-row' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    stream.stop();
    const events = stream.frames.map((frame) => JSON.parse(frame) as {
      id: string; type: string;
      data: { sessionID?: string; assistantMessageID?: string; id?: string; name?: string; input?: { command?: string }; metadata?: { shellID?: string } };
    });
    const started = events.find((e) => e.type === 'session.tool.input.started');
    const called = events.find((e) => e.type === 'session.tool.called');
    const success = events.find((e) => e.type === 'session.tool.success');
    expect(started).toBeDefined();
    expect(called).toBeDefined();
    expect(success).toBeDefined();
    // The row's message id comes from `event.id.replace(/^evt_/, "msg_")` in rows.ts, and
    // the component reads `metadata.shellID` and `input.command` off the part.
    expect(started!.id).toBe(`evt_${chosen}`);
    expect(started!.data.assistantMessageID).toBe(`msg_${chosen}`);
    expect(called!.data.input?.command).toBe('echo tool-row');
    expect(success!.data.metadata?.shellID).toBe(chosen);
  });
});

describe('the session map, the one file the bridge writes', () => {
  it('turns a remembered id into the agent id, so session/load can find it', async () => {
    const mapPath = join(mkdtempSync(join(tmpdir(), 'oac-map-')), 'sessions.json');
    // The bridge runs inside this process, so the path has to be in process.env — passing it
    // as bridge env reached only the spawned agent, and the first version of this test wrote
    // to the real state directory instead.
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    try {
      // First run: create a session, let the agent answer, and learn the pair.
      const first = await start('rich-turn', {
        OPENCODE_ACP_CLIENT_SESSION_MAP: mapPath,
        FAKE_ACP_CAPS_LOAD_SESSION: '1',
      });
      const visible = await createSession(first);
      await runTurn(first, visible);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(existsSync(mapPath)).toBe(true);
      const stored = JSON.parse(readFileSync(mapPath, 'utf8')) as Record<string, { acpSessionId: string }>;
      expect(stored[visible]?.acpSessionId).toBeTruthy();

      // Second run, fresh server, same map: the client asks for the id it remembers and
      // then reads its transcript. The transcript route is what starts lazy ACP loading.
      logs.length = 0;
      const second = await start('rich-turn', {
        OPENCODE_ACP_CLIENT_SESSION_MAP: mapPath,
        FAKE_ACP_CAPS_LOAD_SESSION: '1',
      });
      await fetch(`${second}/api/session/${visible}`);
      await fetch(`${second}/api/session/${visible}/message`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      // It resolved the remembered id to the agent's, then actually sent session/load using
      // that id. Before the fix ensureAgent looked only at --session, ignored record.acpSessionId
      // from the map, and silently called session/new instead.
      const storedId = stored[visible]!.acpSessionId;
      expect(logs.some((line) => line.includes(`session map: ${visible} is the agent's ${storedId}`))).toBe(true);
      expect(logs.some((line) => line.includes(`history: asking the agent to load '${storedId}'`))).toBe(true);
      expect(logs.some((line) => line.includes('new agent session'))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
      removeDirSync(dirname(mapPath));
    }
  });
});

describe('a transcript rebuilt by an ACP replay', () => {
  it('names a real model on every replayed message, not the placeholder', async () => {
    const mapPath = join(mkdtempSync(join(tmpdir(), 'oac-replay-')), 'sessions.json');
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    try {
      // Run one: a real turn, with the agent advertising both models and session/load.
      const first = await start('rich-turn', {
        OPENCODE_ACP_CLIENT_SESSION_MAP: mapPath,
        FAKE_ACP_MODELS: '1',
        FAKE_ACP_CAPS_LOAD_SESSION: '1',
      });
      const visible = await createSession(first);
      await runTurn(first, visible);
      await new Promise((resolve) => setTimeout(resolve, 300));

      const catalog = (await (await fetch(`${first}/api/model`)).json()) as {
        data: Array<{ id?: string; modelID?: string; providerID?: string }>;
      };
      const real = catalog.data.filter((model) => model.providerID !== 'acp');
      expect(real.length).toBeGreaterThan(0);

      // Run two: a fresh bridge over the same map. Closing and reopening the client does exactly
      // this, and the transcript then comes from the agent's `session/load` replay — where entries
      // carry no per-message model and the session has not adopted one yet. Without a real
      // fallback the card footer resolved to `acp/unknown`, even though the live turn was fine.
      logs.length = 0;
      const second = await startLaunched('rich-turn', {
        OPENCODE_ACP_CLIENT_SESSION_MAP: mapPath,
        FAKE_ACP_MODELS: '1',
        FAKE_ACP_CAPS_LOAD_SESSION: '1',
        FAKE_ACP_REPLAY_ON_LOAD: '1',
      });
      expect((await fetch(`${second}/api/session/${visible}`)).status).toBe(200);
      // A launched client resolves the model catalog before the transcript is read (that is what
      // `waitForCatalog()` does for the single-entry launch). Without it this bridge is still on
      // the `acp/default` placeholder, and the point of the test — that a *replayed* entry names a
      // real model — could not be observed at all.
      const items = (await (await fetch(`${second}/api/session/${visible}/message`)).json()) as {
        data: Array<{ type?: string; model?: { providerID?: string; id?: string } }>;
      };
      const assistants = items.data.filter((item) => item.type === 'assistant');
      // eslint-disable-next-line no-console
      expect(assistants.length).toBeGreaterThan(0);
      const keys = new Set(real.map((model) => `${model.providerID}/${model.modelID ?? model.id}`));
      for (const assistant of assistants) {
        expect(assistant.model?.providerID).not.toBe('acp');
        expect(assistant.model?.id).not.toBe('unknown');
        expect(keys.has(`${assistant.model?.providerID}/${assistant.model?.id}`)).toBe(true);
      }
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
      removeDirSync(dirname(mapPath));
    }
  });
});

describe('the session map file', () => {
  it('holds only visible-id pairs, with no agent-id self-mappings', async () => {
    const mapPath = join(mkdtempSync(join(tmpdir(), 'oac-selfmap-')), 'sessions.json');
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    try {
      const url = await start('rich-turn', {
        OPENCODE_ACP_CLIENT_SESSION_MAP: mapPath,
        FAKE_ACP_MODELS: '1',
      });
      const visible = await createSession(url);
      await runTurn(url, visible);
      await new Promise((resolve) => setTimeout(resolve, 300));

      const stored = JSON.parse(readFileSync(mapPath, 'utf8')) as Record<
        string,
        { acpSessionId?: string }
      >;
      // The pair is what makes `session/load` find the conversation.
      expect(stored[visible]?.acpSessionId).toBeTruthy();
      expect(stored[visible]?.acpSessionId).not.toBe(visible);

      // And nothing maps an id to itself. Measured on the owner's real file: these were 79 of 153
      // rows (52%), dead weight that `flush()`'s `MAX_ENTRIES` truncation could let crowd out real
      // mappings. No client asks for the agent's own id, and the only reverse lookup requires a
      // `ses_` prefix, so a self-mapping could never be read.
      const selfMapped = Object.entries(stored)
        .filter(([key, entry]) => key === entry.acpSessionId)
        .map(([key]) => key);
      expect(selfMapped).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
      removeDirSync(dirname(mapPath));
    }
  });
});


describe('titled sessions discovered from stable ACP session/list', () => {
  it('does not adopt a titled agent session the map has never paired', async () => {
    // The list is still REQUESTED — a resumed session needs it to find its agent id — but
    // nothing is adopted: every launch used to re-import the agent's own sessions as
    // `ses_acp_…` ghosts, so a restore showed tabs nobody opened.
    const url = await start('rich-turn', {
      FAKE_ACP_CAPS_LIST_SESSIONS: '1',
      FAKE_ACP_CAPS_LOAD_SESSION: '1',
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const listed = (await (await fetch(`${url}/api/session`)).json()) as {
      data: Array<{ id: string; title?: string; acpSessionId?: string }>;
    };
    // The title is the fixture's own: `session/list` offered it with that name, and the
    // bridge used to adopt it under a `ses_acp_…` alias.
    expect(listed.data.find((session) => session.title === 'Imported old conversation')).toBeUndefined();
  });

  it('preserves ACP session/list updatedAt on GET /api/session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-list-time-'));
    const mapPath = join(dir, 'sessions.json');
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    const acpUpdatedAt = '2026-01-15T10:00:00Z';
    writeFileSync(
      mapPath,
      JSON.stringify({
        ses_old_listed: {
          acpSessionId: 'listed-agent-session-1',
          directory: process.cwd(),
          title: 'Imported old conversation',
          updatedAt: Date.parse('2026-01-10T08:00:00Z'),
          createdAt: Date.parse('2026-01-09T08:00:00Z'),
        },
      }),
      'utf8',
    );
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    try {
      const url = await start('rich-turn', {
        FAKE_ACP_CAPS_LIST_SESSIONS: '1',
        FAKE_ACP_CAPS_LOAD_SESSION: '1',
        FAKE_ACP_LIST_UPDATED_AT: acpUpdatedAt,
      });
      const listed = (await (await fetch(`${url}/api/session`)).json()) as {
        data: Array<{ id: string; time: { created: number; updated: number } }>;
      };
      const row = listed.data.find((session) => session.id === 'ses_old_listed');
      expect(row).toBeDefined();
      expect(row!.time.updated).toBe(Date.parse(acpUpdatedAt));
      expect(row!.time.created).toBe(Date.parse('2026-01-09T08:00:00Z'));
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
      deferredRemovals.push(dir);
    }
  });

  it('falls back to SessionMap timestamps when ACP session/list omits or sends invalid updatedAt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-list-fallback-time-'));
    const mapPath = join(dir, 'sessions.json');
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    const mapCreated = Date.parse('2026-02-01T09:00:00Z');
    const mapUpdated = Date.parse('2026-02-03T14:30:00Z');
    writeFileSync(
      mapPath,
      JSON.stringify({
        ses_map_dated: {
          acpSessionId: 'listed-agent-session-1',
          directory: process.cwd(),
          title: 'Imported old conversation',
          createdAt: mapCreated,
          updatedAt: mapUpdated,
        },
      }),
      'utf8',
    );
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    try {
      const urlInvalid = await start('rich-turn', {
        FAKE_ACP_CAPS_LIST_SESSIONS: '1',
        FAKE_ACP_CAPS_LOAD_SESSION: '1',
        FAKE_ACP_LIST_UPDATED_AT: 'not-a-date',
      });
      const listedInvalid = (await (await fetch(`${urlInvalid}/api/session`)).json()) as {
        data: Array<{ id: string; time: { created: number; updated: number } }>;
      };
      const rowInvalid = listedInvalid.data.find((session) => session.id === 'ses_map_dated');
      expect(rowInvalid).toBeDefined();
      expect(rowInvalid!.time.created).toBe(mapCreated);
      expect(rowInvalid!.time.updated).toBe(mapUpdated);

      const urlOmitted = await start('rich-turn', {
        FAKE_ACP_CAPS_LIST_SESSIONS: '1',
        FAKE_ACP_CAPS_LOAD_SESSION: '1',
      });
      const listedOmitted = (await (await fetch(`${urlOmitted}/api/session`)).json()) as {
        data: Array<{ id: string; time: { created: number; updated: number } }>;
      };
      const rowOmitted = listedOmitted.data.find((session) => session.id === 'ses_map_dated');
      expect(rowOmitted).toBeDefined();
      expect(rowOmitted!.time.created).toBe(mapCreated);
      expect(rowOmitted!.time.updated).toBe(mapUpdated);
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
      deferredRemovals.push(dir);
    }
  });

  it('clamps created to updated when ACP updatedAt is earlier than SessionMap createdAt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-list-clamp-time-'));
    const mapPath = join(dir, 'sessions.json');
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    const acpUpdatedAt = '2026-01-05T10:00:00Z';
    writeFileSync(
      mapPath,
      JSON.stringify({
        ses_clamped: {
          acpSessionId: 'listed-agent-session-1',
          directory: process.cwd(),
          title: 'Imported old conversation',
          createdAt: Date.parse('2026-02-01T09:00:00Z'),
          updatedAt: Date.parse('2026-02-03T14:30:00Z'),
        },
      }),
      'utf8',
    );
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    try {
      const url = await start('rich-turn', {
        FAKE_ACP_CAPS_LIST_SESSIONS: '1',
        FAKE_ACP_CAPS_LOAD_SESSION: '1',
        FAKE_ACP_LIST_UPDATED_AT: acpUpdatedAt,
      });
      const listed = (await (await fetch(`${url}/api/session`)).json()) as {
        data: Array<{ id: string; time: { created: number; updated: number } }>;
      };
      const row = listed.data.find((session) => session.id === 'ses_clamped');
      expect(row).toBeDefined();
      expect(row!.time.updated).toBe(Date.parse(acpUpdatedAt));
      expect(row!.time.created).toBe(Date.parse(acpUpdatedAt));
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
      deferredRemovals.push(dir);
    }
  });
});

describe('remembered session timestamps on adoption and resume', () => {
  it('preserves SessionMap createdAt and updatedAt on GET /api/session/:id adoption and pre-created resume', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-adopt-time-'));
    const mapPath = join(dir, 'sessions.json');
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    const mapCreated = Date.parse('2026-03-01T10:00:00Z');
    const mapUpdated = Date.parse('2026-03-05T16:00:00Z');
    writeFileSync(
      mapPath,
      JSON.stringify({
        ses_adopted_old: {
          acpSessionId: 'agent-old-1',
          directory: process.cwd(),
          title: 'Old adopted chat',
          agent: { command: process.execPath, args: [FAKE_AGENT] },
          createdAt: mapCreated,
          updatedAt: mapUpdated,
        },
      }),
      'utf8',
    );
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    try {
      const urlAdopt = await start('rich-turn');
      const adopted = (await (await fetch(`${urlAdopt}/api/session/ses_adopted_old`)).json()) as {
        data: { id: string; time: { created: number; updated: number } };
      };
      expect(adopted.data.id).toBe('ses_adopted_old');
      expect(adopted.data.time.created).toBe(mapCreated);
      expect(adopted.data.time.updated).toBe(mapUpdated);

      const resumedServer = new BridgeServer({
        command: process.execPath,
        args: [FAKE_AGENT],
        directory: process.cwd(),
        port: 0,
        env: { FAKE_ACP_SCENARIO: 'rich-turn', FAKE_ACP_MODELS: '1', FAKE_ACP_CAPS_RESUME: '1' },
        resumeSession: 'agent-old-1',
        resumeVisibleSessionId: 'ses_adopted_old',
        onLog: (line) => logs.push(line),
      });
      servers.push(resumedServer);
      const { host, port } = await resumedServer.listen();
      const urlResume = `http://${host}:${port}`;
      await fetch(`${urlResume}/api/session`);
      const resumed = (await (await fetch(`${urlResume}/api/session/ses_adopted_old`)).json()) as {
        data: { id: string; time: { created: number; updated: number } };
      };
      expect(resumed.data.id).toBe('ses_adopted_old');
      expect(resumed.data.time.created).toBe(mapCreated);
      expect(resumed.data.time.updated).toBe(mapUpdated);
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
      deferredRemovals.push(dir);
    }
  });
});

describe('the shell row in stored history', () => {
  it('survives a transcript reload as the shell message the client renders', async () => {
    const url = await start('rich-turn');
    const session = await createSession(url);
    const response = await fetch(`${url}/api/session/${session}/shell`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'sh_history_row', command: 'echo history-shell' }),
    });
    expect(response.status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 400));

    // This is the reload path: the client reads the transcript, not the event stream. A shell is
    // its own message type in the published schema (`Session.Message.Shell`), and the TUI
    // matches `message.type === "shell"` to render it; storing it as an assistant `tool` part
    // brought it back as a generic card whose status and output were both wrong.
    const items = (await (await fetch(`${url}/api/session/${session}/message`)).json()) as {
      data: Array<Record<string, unknown>>;
    };
    const shell = items.data.find((item) => item.type === 'shell') as
      | {
          shellID?: string;
          command?: string;
          status?: string;
          exit?: number;
          output?: { output?: string; cursor?: number; size?: number; truncated?: boolean };
          time?: { created?: number; completed?: number };
        }
      | undefined;
    expect(shell).toBeDefined();
    expect(shell!.shellID).toBe('sh_history_row');
    expect(shell!.command).toBe('echo history-shell');
    expect(shell!.status).toBe('exited');
    expect(shell!.exit).toBe(0);
    // `Shell.Output` is the cursor-paged envelope, and the count is in UTF-8 bytes.
    // ★ The line ending is whatever the platform's own `echo` produced (CRLF on Windows);
    // what this asserts is that cursor and size agree with the bytes actually captured.
    const echoed = process.platform === 'win32' ? 'history-shell\r\n' : 'history-shell\n';
    expect(shell!.output).toEqual({
      output: echoed,
      cursor: Buffer.byteLength(echoed, 'utf8'),
      size: Buffer.byteLength(echoed, 'utf8'),
      truncated: false,
    });
    expect(shell!.time?.completed).toEqual(expect.any(Number));
  });
});

describe('the model an assistant card names', () => {
  it('is a real catalog entry, never the acp/default placeholder', async () => {
    const url = await start('rich-turn', {
      FAKE_ACP_MODELS: '1',
      FAKE_ACP_REPLY: 'model probe reply',
    });
    const session = await createSession(url);
    await runTurn(url, session);
    // Read the catalog after the turn: before the agent has answered, `/api/model` is
    // deliberately the `acp/default` placeholder, which is the very confusion under test.
    const catalog = (await (await fetch(`${url}/api/model`)).json()) as {
      data: Array<{ id?: string; modelID?: string; providerID?: string }>;
    };
    const advertised = catalog.data.filter((model) => model.providerID !== 'acp');
    expect(advertised.length).toBeGreaterThan(0);

    const catalogKeys = new Set(
      advertised.map((model) => `${model.providerID}/${model.modelID ?? model.id}`),
    );
    const items = await messages(url, session);
    const assistant = items.find((item) => item.type === 'assistant') as
      | { model?: { providerID?: string; id?: string } }
      | undefined;
    expect(assistant?.model).toBeDefined();
    const { providerID, id } = assistant!.model!;
    // The card footer resolves the message's model against the catalog and prints
    // `${providerID}/${id}` when it cannot find it — which is how a stored `acp/default`
    // placeholder surfaced on screen as "acp/unknown". Assert it resolves.
    expect(providerID).not.toBe('acp');
    expect(id).not.toBe('unknown');
    expect(catalogKeys.has(`${providerID}/${id}`)).toBe(true);
  });
});

describe('restored from main while resolving the Windows merge', () => {
  it('announces the model catalog after a resume, not just the current model', async () => {
    const server = new BridgeServer({
      command: process.execPath,
      args: [FAKE_AGENT],
      directory: process.cwd(),
      port: 0,
      env: { FAKE_ACP_MODELS: '1', FAKE_ACP_CAPS_RESUME: '1' },
      resumeSession: 'resume-me',
      onLog: (line) => logs.push(line),
    });
    servers.push(server);
    const { host, port } = await server.listen();
    const url = `http://${host}:${port}`;

    // Subscribed BEFORE anything else, exactly as a client is: the startup fetch of the catalog
    // is what leaves it with the placeholder.
    const frames: string[] = [];
    const request = (await import('node:http')).request(`${url}/api/event`, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => frames.push(chunk));
    });
    request.end();
    await new Promise((resolve) => setTimeout(resolve, 250));

    await fetch(`${url}/api/session`).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 800));

    const seen = frames.join('');
    expect(seen).toContain('"type":"model.updated"');
    // And the catalog it points at is real once the client looks again.
    const models = (await (await fetch(`${url}/api/model`)).json()) as {
      data: Array<{ providerID?: string }>;
    };
    expect(models.data.some((model) => model.providerID !== 'acp')).toBe(true);
  })

  it('does not adopt a titled agent session the map has never paired', async () => {
    // The list is still REQUESTED — a resumed session needs it to find its agent id — but
    // nothing is adopted. See the `--continue` block above for why.
    const url = await start('rich-turn', {
      FAKE_ACP_CAPS_LIST_SESSIONS: '1',
      FAKE_ACP_CAPS_LOAD_SESSION: '1',
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const listed = (await (await fetch(`${url}/api/session`)).json()) as {
      data: Array<{ id: string; title?: string; acpSessionId?: string }>;
    };
    // The title is the fixture's own: `session/list` offered it with that name, and the
    // bridge used to adopt it under a `ses_acp_…` alias.
    expect(listed.data.find((session) => session.title === 'Imported old conversation')).toBeUndefined();
  })

  it('leaves a session the map has never paired out of the list the TUI reads', async () => {
    // ★ This used to assert the opposite, and that was the bug.
    //
    // `GET /api/session` — which the TUI issues at startup — ran session discovery and gave
    // every titled session an alias, so `-c` would find the agent's conversations. With an
    // agent that keeps private ones, it adopted those too: measured against
    // a third-party dsh ACP profile, 21 of 22 listed sessions were the agent's own, titled
    // "You are a careful implementer.". They became tabs, `-c` restored them, and cleaning
    // the map did not hold — the next launch wrote them back.
    //
    // `-c` now works off the map alone: the id it needs was recorded when that conversation
    // was actually used.
    const url = await start('rich-turn', {
      FAKE_ACP_CAPS_LIST_SESSIONS: '1',
      FAKE_ACP_CAPS_LOAD_SESSION: '1',
      FAKE_ACP_REPLAY_ON_LOAD: '1',
    });
    const listed = (await (await fetch(`${url}/api/session`)).json()) as {
      data: Array<{ id: string; title?: string }>;
    };
    expect(listed.data.some((row) => row.id === 'ses_acp_listedagentsession1')).toBe(false);
    expect(listed.data.some((row) => row.title === 'Imported old conversation')).toBe(false);
  })

  it('switches the effort option even when the model is unchanged', async () => {
    const server = new BridgeServer({
      command: process.execPath,
      args: [FAKE_AGENT],
      directory: process.cwd(),
      port: 0,
      env: { FAKE_ACP_MODELS: '1', FAKE_ACP_EFFORT: '1' },
      onLog: (line) => logs.push(line),
    });
    servers.push(server);
    const { host, port } = await server.listen();
    const url = `http://${host}:${port}`;
    const created = (await (
      await fetch(`${url}/api/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ location: { directory: process.cwd() } }),
      })
    ).json()) as { data: { id: string } };
    const session = created.data.id;
    await fetch(`${url}/api/session/${session}/message`).catch(() => undefined);

    const response = await fetch(`${url}/api/session/${session}/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: { providerID: 'fake', id: 'model-1', variant: 'max' } }),
    });
    expect(response.status).toBe(204);
    const all = logs.join('\n');
    // The agent itself confirmed it — not just "we sent something".
    expect(all).toMatch(/\[fake\] set effort=max/);
    expect(all).toMatch(/\[bridge\] effort -> max/);

    // A repeat of the same pick is a no-op at the agent.
    logs.length = 0;
    await fetch(`${url}/api/session/${session}/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: { providerID: 'fake', id: 'model-1', variant: 'max' } }),
    });
    expect(logs.join('\n')).not.toMatch(/\[fake\] set effort=/);
  })
});

describe('startup /api/model race and fallback catalog', () => {
  it('awaits an in-flight ensureAgent(focused) when session/load is still running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-inflight-model-'));
    const mapPath = join(dir, 'sessions.json');
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    try {
      const env = {
        OPENCODE_ACP_CLIENT_SESSION_MAP: mapPath,
        FAKE_ACP_MODELS: '1',
        FAKE_ACP_CAPS_LOAD_SESSION: '1',
        FAKE_ACP_DELAY_SESSION_LOAD_MS: '300',
      };
      const first = await start('rich-turn', env);
      const warmup = await createSession(first);
      await runTurn(first, warmup);
      const session = await createSession(first);
      await runTurn(first, session);

      const second = await startLaunched('rich-turn', env);
      await fetch(`${second}/api/session/${session}`);
      // Kick off ensureAgent(focused); with the pooled connection warm from waitForCatalog(),
      // agents.set runs synchronously while session/load takes 300ms.
      const msgReq = fetch(`${second}/api/session/${session}/message`);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const modelRes = (await (await fetch(`${second}/api/model`)).json()) as {
        data: Array<{ providerID?: string; id?: string }>;
      };
      await msgReq;
      expect(modelRes.data.some((m) => m.providerID === 'fake' && m.id !== 'default')).toBe(true);
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
      deferredRemovals.push(dir);
    }
  });

  it('falls back to the same agent warmed catalog when session/load omits models, and still switches models', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-load-nomodels-'));
    const mapPath = join(dir, 'sessions.json');
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    try {
      const baseEnv = {
        OPENCODE_ACP_CLIENT_SESSION_MAP: mapPath,
        FAKE_ACP_MODELS: '1',
        FAKE_ACP_CAPS_LOAD_SESSION: '1',
      };
      const first = await start('rich-turn', baseEnv);
      const warmup = await createSession(first);
      await runTurn(first, warmup);
      const session = await createSession(first);
      await runTurn(first, session);

      const second = await startLaunched('rich-turn', {
        ...baseEnv,
        FAKE_ACP_LOAD_NO_MODELS: '1',
        FAKE_ACP_DELAY_SESSION_LOAD_MS: '300',
      });
      await fetch(`${second}/api/session/${session}`);
      const msgReq = fetch(`${second}/api/session/${session}/message`);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const duringLoad = (await (await fetch(`${second}/api/model`)).json()) as {
        data: Array<{ providerID?: string; id?: string }>;
      };
      await msgReq;
      const afterLoad = (await (await fetch(`${second}/api/model`)).json()) as {
        data: Array<{ providerID?: string; id?: string }>;
      };
      const switched = await fetch(`${second}/api/session/${session}/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: { providerID: 'fake', modelID: 'model-2' } }),
      });

      expect(duringLoad.data.some((m) => m.providerID === 'fake' && m.id !== 'default')).toBe(true);
      expect(afterLoad.data.some((m) => m.providerID === 'fake' && m.id !== 'default')).toBe(true);
      expect(switched.status).toBeLessThan(400);
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
      deferredRemovals.push(dir);
    }
  });

  it('emits model.updated when session/load returns configOptions in its RPC response', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-load-resp-models-'));
    const mapPath = join(dir, 'sessions.json');
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    try {
      const baseEnv = {
        OPENCODE_ACP_CLIENT_SESSION_MAP: mapPath,
        FAKE_ACP_MODELS: '1',
        FAKE_ACP_CAPS_LOAD_SESSION: '1',
      };
      const first = await start('rich-turn', baseEnv);
      const session = await createSession(first);
      await runTurn(first, session);

      const second = await start('rich-turn', {
        ...baseEnv,
        FAKE_ACP_LOAD_MODELS_IN_RESPONSE: '1',
      });
      await fetch(`${second}/api/session/${session}`);
      const sse = await sseDuring(second, () => fetch(`${second}/api/session/${session}/message`));
      expect(sse).toContain('model.updated');
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
      deferredRemovals.push(dir);
    }
  });

  it('adopts a valid non-empty modelID from standardModels (models.availableModels)', async () => {
    const url = await startLaunched('rich-turn', {
      FAKE_ACP_MODELS: '',
      FAKE_ACP_MODELS_FIELD: '1',
    });
    expect(logs.join('\n')).not.toMatch(/adopted model qwen-like-1\/(?:\n|$)/);
    const session = await createSession(url);
    await runTurn(url, session);

    const catalog = (await (await fetch(`${url}/api/model`)).json()) as {
      data: Array<{ id?: string; providerID?: string }>;
    };
    const items = await messages(url, session);
    const assistant = items.find((item) => item.type === 'assistant') as
      | { model?: { providerID?: string; id?: string } }
      | undefined;
    expect(assistant?.model).toEqual({ providerID: 'qwen-like-1', id: 'qwen-like-1' });
    expect(
      catalog.data.some(
        (m) => m.providerID === assistant?.model?.providerID && m.id === assistant?.model?.id,
      ),
    ).toBe(true);
  });

  it('GET /api/command does not eagerly session/load adopted sessions when commands are already known', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-cmd-noload-'));
    const mapPath = join(dir, 'sessions.json');
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    try {
      const env = {
        OPENCODE_ACP_CLIENT_SESSION_MAP: mapPath,
        FAKE_ACP_COMMANDS: '1',
        FAKE_ACP_CAPS_LOAD_SESSION: '1',
      };
      const first = await start('rich-turn', env);
      const warmup = await createSession(first);
      await runTurn(first, warmup);
      const session = await createSession(first);
      await runTurn(first, session);

      const second = await startLaunched('rich-turn', env);
      const before = logs.length;
      await fetch(`${second}/api/session/${session}`);
      const res = await fetch(`${second}/api/command?location[directory]=${encodeURIComponent(process.cwd())}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ name: string }> };
      const names = body.data.map((c) => c.name);
      expect(names).toContain('greet');
      expect(names).toContain('status');
      expect(logs.slice(before).join('\n')).not.toContain('asking the agent to load');
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
      deferredRemovals.push(dir);
    }
  });
});

describe('replayed historical tool calls', () => {
  it('projects completed, unclosed, and failed single-frame replayed tool_calls without status running and timestamps reasoning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-replay-tools-'));
    const mapPath = join(dir, 'sessions.json');
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    try {
      const baseEnv = {
        OPENCODE_ACP_CLIENT_SESSION_MAP: mapPath,
        FAKE_ACP_CAPS_LOAD_SESSION: '1',
      };
      const first = await start('rich-turn', baseEnv);
      const warmup = await createSession(first);
      await runTurn(first, warmup);
      const session = await createSession(first);
      await runTurn(first, session);

      const second = await startLaunched('rich-turn', {
        ...baseEnv,
        FAKE_ACP_REPLAY_TOOLS: '1',
      });
      await fetch(`${second}/api/session/${session}`);
      const items = await messages(second, session);
      const assistant = items.find((item) => item.type === 'assistant') as
        | { content?: Array<Record<string, unknown>> }
        | undefined;
      expect(assistant).toBeDefined();
      const content = assistant!.content ?? [];

      const tools = content.filter((part) => part.type === 'tool') as Array<{
        id?: string;
        state?: { status?: string; input?: unknown; content?: Array<{ text?: string }>; error?: unknown };
        time?: { created?: unknown; completed?: unknown };
      }>;
      expect(tools).toHaveLength(3);
      expect(tools.some((t) => t.state?.status === 'running')).toBe(false);

      const done = tools.find((t) => t.id === 'rep-done');
      expect(done?.state?.status).toBe('completed');
      expect(done?.state?.content?.[0]?.text).toBe('replayed-tool-output');
      expect(typeof done?.time?.completed).toBe('number');

      const open = tools.find((t) => t.id === 'rep-open');
      expect(open?.state?.status).toBe('completed');
      expect(open?.state?.input).toEqual({});
      expect(typeof open?.time?.completed).toBe('number');

      const fail = tools.find((t) => t.id === 'rep-fail');
      expect(fail?.state?.status).toBe('error');
      expect(fail?.state?.error).toEqual({ type: 'tool', message: 'boom' });
      expect(typeof fail?.time?.completed).toBe('number');

      const reasoning = content.find((part) => part.type === 'reasoning') as
        | { time?: { created?: unknown; completed?: unknown } }
        | undefined;
      expect(reasoning?.time).toEqual({
        created: expect.any(Number),
        completed: expect.any(Number),
      });
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
      deferredRemovals.push(dir);
    }
  });
});

describe('post-load session metadata updates', () => {
  it('applies usage and title updates sent after session/load without leaving the session busy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oac-post-load-meta-'));
    const mapPath = join(dir, 'sessions.json');
    const previous = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    try {
      const baseEnv = {
        OPENCODE_ACP_CLIENT_SESSION_MAP: mapPath,
        FAKE_ACP_CAPS_LOAD_SESSION: '1',
      };
      const first = await start('rich-turn', baseEnv);
      const warmup = await createSession(first);
      await runTurn(first, warmup);
      const session = await createSession(first);
      await runTurn(first, session);

      const second = await startLaunched('rich-turn', {
        ...baseEnv,
        FAKE_ACP_REPLAY_TOOLS: '1',
        FAKE_ACP_POST_LOAD_META: '1',
      });

      const stream = await sseDuring(second, async () => {
        await fetch(`${second}/api/session/${session}`);
        await messages(second, session);
      });

      const events = stream
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)) as { type: string; data: Record<string, unknown> });

      const active = (await (await fetch(`${second}/api/session/active`)).json()) as {
        data: Record<string, unknown>;
      };
      expect(active.data).toEqual({});

      expect(events.some((event) => event.type === 'session.usage.updated')).toBe(true);
      expect(
        events.some(
          (event) => event.type === 'session.renamed' && event.data['title'] === 'Today News',
        ),
      ).toBe(true);
      expect(events.some((event) => event.type === 'session.execution.started')).toBe(false);
      expect(events.some((event) => event.type === 'turn.wait')).toBe(false);
      expect(
        events.some(
          (event) => event.type === 'session.status' && event.data['status'] === 'busy',
        ),
      ).toBe(false);

      const items = await messages(second, session);
      expect(items).toHaveLength(2);
      const assistant = items.find((item) => item.type === 'assistant') as
        | { time?: { completed?: unknown } }
        | undefined;
      expect(typeof assistant?.time?.completed).toBe('number');
    } finally {
      if (previous === undefined) delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
      else process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = previous;
      deferredRemovals.push(dir);
    }
  });
});
