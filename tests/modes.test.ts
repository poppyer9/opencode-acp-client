import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { get as httpGet, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { BridgeServer } from '../src/server.js';

const FAKE_AGENT = fileURLToPath(new URL('./fake-acp-agent.mjs', import.meta.url));
const servers: BridgeServer[] = [];
const tempDirs: string[] = [];
const originalMapEnv = process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];

interface StreamEvent {
  id: string;
  type: string;
  data: unknown;
}

function subscribe(url: string): {
  events: StreamEvent[];
  ready: Promise<void>;
  until: (predicate: (events: StreamEvent[]) => boolean, timeoutMs?: number) => Promise<StreamEvent[]>;
  close: () => void;
} {
  const events: StreamEvent[] = [];
  const waiters: Array<() => void> = [];
  let buffer = '';
  let response: IncomingMessage | undefined;
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  const request = httpGet(`${url}/api/event`, {}, (incoming) => {
    response = incoming;
    markReady();
    incoming.setEncoding('utf8');
    incoming.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (line) {
          try {
            events.push(JSON.parse(line.slice(6)) as StreamEvent);
          } catch {
            /* split frame */
          }
        }
        for (const wake of waiters.splice(0)) wake();
        index = buffer.indexOf('\n\n');
      }
    });
  });
  request.on('error', () => {});

  return {
    events,
    ready,
    async until(predicate, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(events) && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 25);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      return events;
    },
    close() {
      response?.destroy();
      request.destroy();
    },
  };
}

async function createSession(url: string): Promise<string> {
  const response = await fetch(`${url}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: { id: string } }).data.id;
}

async function promptAndWaitReply(url: string, sessionId: string, text: string): Promise<string> {
  const before = (await (await fetch(`${url}/api/session/${sessionId}/message`)).json()) as {
    data: Array<{ type?: string }>;
  };
  const prevAssistants = before.data.filter((m) => m.type === 'assistant').length;
  const resp = await fetch(`${url}/api/session/${sessionId}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  expect(resp.status).toBe(200);

  for (let i = 0; i < 100; i += 1) {
    const body = (await (await fetch(`${url}/api/session/${sessionId}/message`)).json()) as {
      data: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
    };
    const assistants = body.data.filter((m) => m.type === 'assistant');
    if (assistants.length > prevAssistants) {
      const latest = assistants[0];
      const textPart = latest?.content?.find((c) => c.type === 'text')?.text;
      if (textPart) return textPart;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for assistant reply');
}

function isolatedMapEnv(extra: Record<string, string> = {}, existingMapPath?: string): {
  env: Record<string, string>;
  mapPath: string;
} {
  let mapPath = existingMapPath;
  if (!mapPath) {
    const dir = mkdtempSync(join(tmpdir(), 'oac-modes-'));
    tempDirs.push(dir);
    mapPath = join(dir, 'sessions.json');
  }
  process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
  return {
    mapPath,
    env: {
      OPENCODE_ACP_CLIENT_SESSION_MAP: mapPath,
      ...extra,
    },
  };
}

async function start(
  env: Record<string, string> = {},
  options: { resumeSession?: string; resumeVisibleSessionId?: string; mapPath?: string } = {},
): Promise<{ url: string; server: BridgeServer; mapPath: string }> {
  const { env: mergedEnv, mapPath } = isolatedMapEnv(env, options.mapPath);
  const server = new BridgeServer({
    command: process.execPath,
    args: [FAKE_AGENT],
    directory: process.cwd(),
    port: 0,
    env: mergedEnv,
    ...(options.resumeSession ? { resumeSession: options.resumeSession } : {}),
    ...(options.resumeVisibleSessionId ? { resumeVisibleSessionId: options.resumeVisibleSessionId } : {}),
    onLog: () => {},
  });
  servers.push(server);
  const { host, port } = await server.listen();
  await server.waitForCatalog();
  return { url: `http://${host}:${port}`, server, mapPath };
}

afterEach(async () => {
  while (servers.length) await servers.pop()?.close();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  if (originalMapEnv !== undefined) process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = originalMapEnv;
  else delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
});

describe('ACP category: mode projection onto /api/agent', () => {
  it('keeps the single primary agent fallback when the agent exposes no mode config option', async () => {
    const { url } = await start({ FAKE_ACP_MODELS: '1' });
    const response = await fetch(`${url}/api/agent`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Array<{ id: string; mode: string; hidden: boolean; color?: string }>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.mode).toBe('primary');
    expect(body.data[0]?.hidden).toBe(false);
    expect(body.data[0]?.color).toBeUndefined();
  });

  it('projects ACP mode options onto GET /api/agent and GET /api/agent/:agentID', async () => {
    const { url } = await start({ FAKE_ACP_MODELS: '1', FAKE_ACP_MODES: '1' });

    const listResp = await fetch(`${url}/api/agent`);
    expect(listResp.status).toBe(200);
    const listBody = (await listResp.json()) as {
      data: Array<{
        id: string;
        name: string;
        description?: string;
        mode: string;
        hidden: boolean;
        color?: string;
        request: unknown;
        permissions: unknown[];
      }>;
    };
    expect(listBody.data.map((entry) => entry.id)).toEqual(['default', 'accept-edits', 'auto', 'plan']);
    for (const entry of listBody.data) {
      expect(entry.color).toBeUndefined();
    }
    const auto = listBody.data.find((entry) => entry.id === 'auto');
    expect(auto).toMatchObject({
      id: 'auto',
      name: 'Auto',
      description: 'Approve edits and safe commands; ask before irreversible actions.',
      mode: 'primary',
      hidden: false,
      request: { settings: {}, headers: {}, body: {} },
      permissions: [],
    });

    const singleResp = await fetch(`${url}/api/agent/auto`);
    expect(singleResp.status).toBe(200);
    const singleBody = (await singleResp.json()) as { data: { id: string; name: string } };
    expect(singleBody.data).toMatchObject({ id: 'auto', name: 'Auto' });

    const missingResp = await fetch(`${url}/api/agent/unknown`);
    expect(missingResp.status).toBe(404);
  });
});

describe('POST /api/session/:id/agent mode switching', () => {
  it('switches the ACP mode, emits session.agent.selected, and avoids duplicate no-op events', async () => {
    const { url } = await start({
      FAKE_ACP_MODELS: '1',
      FAKE_ACP_MODES: '1',
      FAKE_ACP_MODE_IN_REPLY: '1',
    });
    const sessionId = await createSession(url);
    const stream = subscribe(url);
    await stream.ready;

    try {
      const switchResp = await fetch(`${url}/api/session/${sessionId}/agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'auto' }),
      });
      expect(switchResp.status).toBe(204);

      await stream.until((evts) => evts.some((e) => e.type === 'session.agent.selected'));
      const selectedEvents = stream.events.filter((e) => e.type === 'session.agent.selected');
      expect(selectedEvents).toHaveLength(1);
      expect(selectedEvents[0]?.data).toEqual({
        sessionID: sessionId,
        agent: 'auto',
        previous: 'default',
      });
      // Must NOT emit agent.updated on live switch (keeps Tab list order stable).
      expect(stream.events.some((e) => e.type === 'agent.updated')).toBe(false);

      const sessionResp = await fetch(`${url}/api/session/${sessionId}`);
      expect(sessionResp.status).toBe(200);
      const sessionBody = (await sessionResp.json()) as { data: { agent?: string } };
      expect(sessionBody.data.agent).toBe('auto');

      const reply = await promptAndWaitReply(url, sessionId, 'check mode');
      expect(reply).toContain('[mode=auto]');

      // Re-posting the already active mode must be a silent 204 no-op.
      const noopResp = await fetch(`${url}/api/session/${sessionId}/agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'auto' }),
      });
      expect(noopResp.status).toBe(204);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(stream.events.filter((e) => e.type === 'session.agent.selected')).toHaveLength(1);
    } finally {
      stream.close();
    }
  });

  it('returns 400 when switching to an unknown mode or when the agent refuses', async () => {
    const { url } = await start({
      FAKE_ACP_MODELS: '1',
      FAKE_ACP_MODES: '1',
    });
    const sessionId = await createSession(url);

    const badResp = await fetch(`${url}/api/session/${sessionId}/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'nonexistent-mode' }),
    });
    expect(badResp.status).toBe(400);
    const badBody = (await badResp.json()) as { _tag?: string; message?: string };
    expect(badBody._tag).toBe('InvalidRequestError');

    const refused = await start({
      FAKE_ACP_MODELS: '1',
      FAKE_ACP_MODES: '1',
      FAKE_ACP_SET_CONFIG_FAILS: '1',
    });
    const refusedSession = await createSession(refused.url);
    const refuseResp = await fetch(`${refused.url}/api/session/${refusedSession}/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'auto' }),
    });
    expect(refuseResp.status).toBe(400);
    const refuseBody = (await refuseResp.json()) as { _tag?: string; message?: string };
    expect(refuseBody._tag).toBe('InvalidRequestError');
    expect(refuseBody.message).toContain('refused');
  });

  it('keeps answering 204 when the agent exposes no mode config option', async () => {
    const { url } = await start({ FAKE_ACP_MODELS: '1' });
    const sessionId = await createSession(url);
    const resp = await fetch(`${url}/api/session/${sessionId}/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'fake-acp' }),
    });
    expect(resp.status).toBe(204);
  });
});

describe('agent-driven config_option_update for mode', () => {
  it('updates session.agent and emits session.agent.selected without writing sticky mode', async () => {
    const { url, mapPath } = await start({
      FAKE_ACP_MODELS: '1',
      FAKE_ACP_MODES: '1',
      FAKE_ACP_MODE_UPDATE: 'plan',
      FAKE_ACP_MODE_IN_REPLY: '1',
    });
    const sessionId = await createSession(url);
    const stream = subscribe(url);
    await stream.ready;

    try {
      const switchResp = await fetch(`${url}/api/session/${sessionId}/agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'auto' }),
      });
      expect(switchResp.status).toBe(204);

      const reply = await promptAndWaitReply(url, sessionId, 'trigger agent mode update');
      expect(reply).toContain('[mode=plan]');

      await stream.until(
        (evts) =>
          evts.filter((e) => e.type === 'session.agent.selected').length >= 2,
      );
      const selected = stream.events.filter((e) => e.type === 'session.agent.selected');
      expect(selected[1]?.data).toEqual({
        sessionID: sessionId,
        agent: 'plan',
        previous: 'auto',
      });

      const sessionBody = (await (await fetch(`${url}/api/session/${sessionId}`)).json()) as {
        data: { agent?: string };
      };
      expect(sessionBody.data.agent).toBe('plan');

      if (existsSync(mapPath)) {
        const disk = JSON.parse(readFileSync(mapPath, 'utf8')) as Record<
          string,
          { mode?: string } | undefined
        >;
        expect(disk[sessionId]?.mode).not.toBe('plan');
      }
    } finally {
      stream.close();
    }
  });
});

describe('sticky mode across restarts, resume, and /cd', () => {
  it('keeps canonical /api/agent order and default mode for fresh sessions after restart, while restoring sticky mode on resumed/adopted sessions', async () => {
    const first = await start({
      FAKE_ACP_MODELS: '1',
      FAKE_ACP_MODES: '1',
      FAKE_ACP_CAPS_LOAD_SESSION: '1',
      FAKE_ACP_MODE_IN_REPLY: '1',
    });
    const sessionId = await createSession(first.url);
    const switchResp = await fetch(`${first.url}/api/session/${sessionId}/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'auto' }),
    });
    expect(switchResp.status).toBe(204);
    await first.server.close();

    // Fresh BridgeServer + fresh fake agent (starts in 'default'), sharing only the session map.
    const second = await start(
      {
        FAKE_ACP_MODELS: '1',
        FAKE_ACP_MODES: '1',
        FAKE_ACP_CAPS_LOAD_SESSION: '1',
        FAKE_ACP_MODE_IN_REPLY: '1',
      },
      { mapPath: first.mapPath },
    );

    const agentsResp = await fetch(`${second.url}/api/agent`);
    expect(agentsResp.status).toBe(200);
    const agentsBody = (await agentsResp.json()) as { data: Array<{ id: string; color?: string }> };
    expect(agentsBody.data.map((entry) => entry.id)).toEqual(['default', 'accept-edits', 'auto', 'plan']);
    for (const entry of agentsBody.data) {
      expect(entry.color).toBeUndefined();
    }

    // Fresh Home-screen session starts in canonical default mode.
    const freshSession = await createSession(second.url);
    const freshResp = await fetch(`${second.url}/api/session/${freshSession}`);
    const freshBody = (await freshResp.json()) as { data: { agent?: string } };
    expect(freshBody.data.agent).toBe('default');
    const freshReply = await promptAndWaitReply(second.url, freshSession, 'fresh home session');
    expect(freshReply).toContain('[mode=default]');

    // Adopting the saved session immediately hydrates its sticky mode and restores it on prompt.
    const adoptedResp = await fetch(`${second.url}/api/session/${sessionId}`);
    expect(adoptedResp.status).toBe(200);
    const adoptedBody = (await adoptedResp.json()) as { data: { agent?: string } };
    expect(adoptedBody.data.agent).toBe('auto');

    const reply = await promptAndWaitReply(second.url, sessionId, 'after restart');
    expect(reply).toContain('[mode=auto]');
  });

  it('restores sticky mode when resuming via session/load or session/resume', async () => {
    for (const capEnv of [
      { FAKE_ACP_CAPS_LOAD_SESSION: '1' },
      { FAKE_ACP_CAPS_RESUME: '1' },
    ]) {
      const first = await start({
        FAKE_ACP_MODELS: '1',
        FAKE_ACP_MODES: '1',
        FAKE_ACP_MODE_IN_REPLY: '1',
        ...capEnv,
      });
      const sessionId = await createSession(first.url);
      expect(
        (
          await fetch(`${first.url}/api/session/${sessionId}/agent`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ agent: 'auto' }),
          })
        ).status,
      ).toBe(204);
      const firstSession = (await (await fetch(`${first.url}/api/session/${sessionId}`)).json()) as {
        data: { acpSessionId?: string };
      };
      await first.server.close();

      const second = await start(
        {
          FAKE_ACP_MODELS: '1',
          FAKE_ACP_MODES: '1',
          FAKE_ACP_MODE_IN_REPLY: '1',
          ...capEnv,
        },
        {
          mapPath: first.mapPath,
          resumeSession: firstSession.data.acpSessionId,
          resumeVisibleSessionId: sessionId,
        },
      );

      const resumedReply = await promptAndWaitReply(second.url, sessionId, 'after resume');
      expect(resumedReply).toContain('[mode=auto]');
      await second.server.close();
    }
  });

  it('preserves active mode after /cd (POST /api/session/:id/move)', async () => {
    const { url } = await start({
      FAKE_ACP_MODELS: '1',
      FAKE_ACP_MODES: '1',
      FAKE_ACP_CAPS_LOAD_SESSION: '1',
      FAKE_ACP_MODE_IN_REPLY: '1',
      FAKE_ACP_CWD_IN_REPLY: '1',
    });
    const sessionId = await createSession(url);
    expect(
      (
        await fetch(`${url}/api/session/${sessionId}/agent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agent: 'auto' }),
        })
      ).status,
    ).toBe(204);

    const movedDir = mkdtempSync(join(tmpdir(), 'oac-modes-cd-'));
    tempDirs.push(movedDir);
    const moveResp = await fetch(`${url}/api/session/${sessionId}/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directory: movedDir }),
    });
    expect(moveResp.status).toBe(204);

    const reply = await promptAndWaitReply(url, sessionId, 'after cd');
    expect(reply).toContain('[mode=auto]');
    expect(reply).toContain(`(cwd: ${movedDir})`);
  });

  it('applies and persists agent selected in POST /api/session (home-screen Shift+Tab flow)', async () => {
    const first = await start({
      FAKE_ACP_MODELS: '1',
      FAKE_ACP_MODES: '1',
      FAKE_ACP_MODE_IN_REPLY: '1',
    });

    // Opencode TUI on the home screen sets agent in POST /api/session instead of /session/:id/agent.
    const createResp = await fetch(`${first.url}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'auto' }),
    });
    expect(createResp.status).toBe(200);
    const created = (await createResp.json()) as { data: { id: string; agent?: string } };
    expect(created.data.agent).toBe('auto');

    const reply = await promptAndWaitReply(first.url, created.data.id, 'from home screen');
    expect(reply).toContain('[mode=auto]');
    await first.server.close();

    // Restart over the same session map: Home-screen catalog stays canonical, while the
    // saved session preserves its sticky 'auto' mode when restored/adopted.
    const second = await start(
      {
        FAKE_ACP_MODELS: '1',
        FAKE_ACP_MODES: '1',
        FAKE_ACP_CAPS_LOAD_SESSION: '1',
        FAKE_ACP_MODE_IN_REPLY: '1',
      },
      { mapPath: first.mapPath },
    );
    const agentsBody = (await (await fetch(`${second.url}/api/agent`)).json()) as {
      data: Array<{ id: string }>;
    };
    expect(agentsBody.data.map((entry) => entry.id)).toEqual(['default', 'accept-edits', 'auto', 'plan']);

    const restoredSession = (await (await fetch(`${second.url}/api/session/${created.data.id}`)).json()) as {
      data: { agent?: string };
    };
    expect(restoredSession.data.agent).toBe('auto');
    const restoredReply = await promptAndWaitReply(second.url, created.data.id, 'resumed home session');
    expect(restoredReply).toContain('[mode=auto]');
  });
});

describe('ACP v1 SessionModeState (modes + session/set_mode + current_mode_update)', () => {
  it('projects legacy SessionModeState onto /api/agent without hardcoded colors', async () => {
    const { url } = await start({ FAKE_ACP_MODELS: '1', FAKE_ACP_LEGACY_MODES: '1' });
    const listResp = await fetch(`${url}/api/agent`);
    expect(listResp.status).toBe(200);
    const listBody = (await listResp.json()) as {
      data: Array<{ id: string; name: string; description?: string; color?: string }>;
    };
    expect(listBody.data.map((entry) => entry.id)).toEqual(['code', 'architect', 'ask']);
    for (const entry of listBody.data) {
      expect(entry.color).toBeUndefined();
    }
    expect(listBody.data[1]).toMatchObject({
      id: 'architect',
      name: 'Architect',
      description: 'Design and plan changes.',
    });
  });

  it('switches legacy modes via session/set_mode, handles agent rejections, and emits session.agent.selected', async () => {
    const { url } = await start({
      FAKE_ACP_MODELS: '1',
      FAKE_ACP_LEGACY_MODES: '1',
      FAKE_ACP_MODE_IN_REPLY: '1',
    });
    const sessionId = await createSession(url);
    const stream = subscribe(url);
    await stream.ready;

    try {
      const switchResp = await fetch(`${url}/api/session/${sessionId}/agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'architect' }),
      });
      expect(switchResp.status).toBe(204);

      await stream.until((evts) => evts.some((e) => e.type === 'session.agent.selected'));
      const selected = stream.events.filter((e) => e.type === 'session.agent.selected');
      expect(selected).toHaveLength(1);
      expect(selected[0]?.data).toEqual({
        sessionID: sessionId,
        agent: 'architect',
        previous: 'code',
      });

      const reply = await promptAndWaitReply(url, sessionId, 'legacy switch');
      expect(reply).toContain('[mode=architect]');

      const badResp = await fetch(`${url}/api/session/${sessionId}/agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'invalid-legacy-mode' }),
      });
      expect(badResp.status).toBe(400);
    } finally {
      stream.close();
    }

    const refused = await start({
      FAKE_ACP_MODELS: '1',
      FAKE_ACP_LEGACY_MODES: '1',
      FAKE_ACP_SET_CONFIG_FAILS: '1',
    });
    const refusedSession = await createSession(refused.url);
    const refuseResp = await fetch(`${refused.url}/api/session/${refusedSession}/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'architect' }),
    });
    expect(refuseResp.status).toBe(400);
  });

  it('reflects agent-pushed current_mode_update without overwriting saved sticky mode', async () => {
    const { url, mapPath } = await start({
      FAKE_ACP_MODELS: '1',
      FAKE_ACP_LEGACY_MODES: '1',
      FAKE_ACP_CURRENT_MODE_UPDATE: 'ask',
      FAKE_ACP_MODE_IN_REPLY: '1',
    });
    const sessionId = await createSession(url);
    const stream = subscribe(url);
    await stream.ready;

    try {
      expect(
        (
          await fetch(`${url}/api/session/${sessionId}/agent`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ agent: 'architect' }),
          })
        ).status,
      ).toBe(204);

      const reply = await promptAndWaitReply(url, sessionId, 'trigger current_mode_update');
      expect(reply).toContain('[mode=ask]');

      await stream.until((evts) => evts.filter((e) => e.type === 'session.agent.selected').length >= 2);
      const selected = stream.events.filter((e) => e.type === 'session.agent.selected');
      expect(selected[1]?.data).toEqual({
        sessionID: sessionId,
        agent: 'ask',
        previous: 'architect',
      });

      const sessionBody = (await (await fetch(`${url}/api/session/${sessionId}`)).json()) as {
        data: { agent?: string };
      };
      expect(sessionBody.data.agent).toBe('ask');

      const disk = JSON.parse(readFileSync(mapPath, 'utf8')) as Record<string, { mode?: string } | undefined>;
      expect(disk[sessionId]?.mode).toBe('architect');
    } finally {
      stream.close();
    }
  });

  it('restores sticky legacy mode across session/load and session/resume', async () => {
    for (const capEnv of [
      { FAKE_ACP_CAPS_LOAD_SESSION: '1' },
      { FAKE_ACP_CAPS_RESUME: '1' },
    ]) {
      const first = await start({
        FAKE_ACP_MODELS: '1',
        FAKE_ACP_LEGACY_MODES: '1',
        FAKE_ACP_MODE_IN_REPLY: '1',
        ...capEnv,
      });
      const sessionId = await createSession(first.url);
      expect(
        (
          await fetch(`${first.url}/api/session/${sessionId}/agent`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ agent: 'architect' }),
          })
        ).status,
      ).toBe(204);
      const firstSession = (await (await fetch(`${first.url}/api/session/${sessionId}`)).json()) as {
        data: { acpSessionId?: string };
      };
      await first.server.close();

      const second = await start(
        {
          FAKE_ACP_MODELS: '1',
          FAKE_ACP_LEGACY_MODES: '1',
          FAKE_ACP_MODE_IN_REPLY: '1',
          ...capEnv,
        },
        {
          mapPath: first.mapPath,
          resumeSession: firstSession.data.acpSessionId,
          resumeVisibleSessionId: sessionId,
        },
      );

      const resumedReply = await promptAndWaitReply(second.url, sessionId, 'after legacy resume');
      expect(resumedReply).toContain('[mode=architect]');
      await second.server.close();
    }
  });

  it('prefers configOptions category:mode without duplicates when an agent advertises both surfaces', async () => {
    const { url } = await start({
      FAKE_ACP_MODELS: '1',
      FAKE_ACP_MODES: '1',
      FAKE_ACP_LEGACY_MODES: '1',
      FAKE_ACP_MODE_IN_REPLY: '1',
    });
    const listResp = await fetch(`${url}/api/agent`);
    expect(listResp.status).toBe(200);
    const listBody = (await listResp.json()) as { data: Array<{ id: string }> };
    expect(listBody.data.map((entry) => entry.id)).toEqual(['default', 'accept-edits', 'auto', 'plan']);

    const sessionId = await createSession(url);
    expect(
      (
        await fetch(`${url}/api/session/${sessionId}/agent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agent: 'auto' }),
        })
      ).status,
    ).toBe(204);
    const reply = await promptAndWaitReply(url, sessionId, 'dual surface');
    expect(reply).toContain('[mode=auto]');
  });
});
