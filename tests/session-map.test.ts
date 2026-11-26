import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { removeDirSync } from './remove-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SessionMap } from '../src/session-map.js';

const dir = mkdtempSync(join(tmpdir(), 'oac-map-'));
const mapPath = join(dir, 'sessions.json');

afterEach(() => {
  rmSync(mapPath, { force: true });
  delete process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'];
});

describe('the shared session map', () => {
  it('does not resurrect an id another bridge forgot', () => {
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;

    const first = new SessionMap(() => {});
    first.remember('ses_a', 'agent-a', '/a');
    first.flush();

    // Loaded while ses_a still existed; its copy will keep it in memory.
    const second = new SessionMap(() => {});
    second.remember('ses_b', 'agent-b', '/b');
    second.flush();

    // A third bridge forgets ses_a (the adoption path does this when it renames the
    // pre-created shell) and writes the tombstone.
    const third = new SessionMap(() => {});
    third.forget('ses_a');
    third.flush();

    // The stale copy in `second` must not bring it back.
    second.remember('ses_c', 'agent-c', '/c');
    second.flush();

    const disk = JSON.parse(readFileSync(mapPath, 'utf8')) as Record<string, unknown>;
    expect(disk['ses_a']).toBeUndefined();
    expect(disk['ses_b']).toBeDefined();
    expect(disk['ses_c']).toBeDefined();
    expect((disk['__tombstones'] as Record<string, number>)['ses_a']).toBeTypeOf('number');
  });

  it('keeps entries another bridge wrote after this one loaded', () => {
    // Every running client shares `~/.opencode-acp-client/sessions.json`; each used to
    // write its whole in-memory copy, so the last flush dropped the other's new rows.
    // Measured: a live tab vanished from the map, and `-s <its id>` then answered
    // "unknown session id: … absent from the session map".
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;

    const first = new SessionMap(() => {});
    first.remember('ses_a', 'agent-a', '/a');
    first.flush();

    const second = new SessionMap(() => {});
    second.remember('ses_b', 'agent-b', '/b');
    second.flush();

    first.remember('ses_c', 'agent-c', '/c');
    first.flush();

    const disk = JSON.parse(readFileSync(mapPath, 'utf8')) as Record<string, { acpSessionId: string }>;
    expect(Object.keys(disk).sort()).toEqual(['ses_a', 'ses_b', 'ses_c']);
    expect(disk['ses_b']!.acpSessionId).toBe('agent-b');
  });
});

describe('recency for -c', () => {
  // `-c` ranks by `updatedAt`. It used to be re-stamped by EVERY map write, so one
  // `session/list` import (which rewrites a row per discovered conversation) dated the
  // whole directory with the same instant and `-c` resumed whichever row the import
  // walked first — not the conversation the user had just been working in (2026-10-27).
  it('moves a row only when the conversation was used, not when metadata is written', () => {
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    const map = new SessionMap(() => {});
    const agent = { command: 'dsh', args: ['--profile', 'acp'] };

    map.remember('ses_worked', 'agent-worked', '/w', 'worked', agent, true);
    const worked = { ...map.entries().find(([id]) => id === 'ses_worked')! }[1].updatedAt;

    // A metadata write with a new title (what a session/list import does): no re-stamp.
    map.remember('ses_worked', 'agent-worked', '/w', 'renamed by the agent', agent);
    expect(map.entries().find(([id]) => id === 'ses_worked')![1].updatedAt).toBe(worked);

    // A prompt does move it.
    map.remember('ses_worked', 'agent-worked', '/w', 'renamed by the agent', agent, true);
    expect(map.entries().find(([id]) => id === 'ses_worked')![1].updatedAt).toBeGreaterThanOrEqual(worked);
  });

  it('dates a brand-new row so the map cap can still order it', () => {
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    const map = new SessionMap(() => {});
    map.remember('ses_imported', 'agent-imported', '/w', 'imported', { command: 'dsh', args: [] });
    const entry = map.entries().find(([id]) => id === 'ses_imported')![1];
    expect(entry.updatedAt).toBeGreaterThan(0);
  });
});

describe('sticky modes', () => {
  it('persists per-session mode without moving updatedAt and survives metadata remember()', () => {
    process.env['OPENCODE_ACP_CLIENT_SESSION_MAP'] = mapPath;
    const map = new SessionMap(() => {});
    const agy = { command: 'agy', args: ['acp'] };

    map.remember('ses_mode', 'agent-mode', '/w', 'initial', agy, true);
    const initialUpdatedAt = map.entries().find(([id]) => id === 'ses_mode')![1].updatedAt;

    map.rememberMode('ses_mode', 'auto');
    expect(map.modeFor('ses_mode')).toBe('auto');
    expect(map.entries().find(([id]) => id === 'ses_mode')![1].updatedAt).toBe(initialUpdatedAt);

    // Later metadata writes (title, directory) must preserve the saved mode.
    map.remember('ses_mode', 'agent-mode', '/w', 'renamed', agy);
    map.flush();

    const reloaded = new SessionMap(() => {});
    expect(reloaded.modeFor('ses_mode')).toBe('auto');
    expect(reloaded.entries().find(([id]) => id === 'ses_mode')![1].updatedAt).toBe(initialUpdatedAt);
  });
});
