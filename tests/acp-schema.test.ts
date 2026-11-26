/**
 * Every frame this bridge puts on the ACP wire, checked against the published schema.
 *
 * Why this exists next to the unit tests: those prove the bridge *behaves* as intended, which
 * says nothing about whether what it sends is legal per the protocol. A field spelled
 * `configOptions` where the schema says `configId` passes every behavioural assertion here and
 * fails at the first real agent — that is exactly what happened with `session/set_model`, whose
 * spelling differed from `session/set_config_option`'s and cost a day of debugging against
 * codex-acp.
 *
 * The schema is the one the ACP project ships (`agentclientprotocol/typescript-sdk`,
 * `schema/v1/schema.json`), vendored into `tests/fixtures/acp-schema/` so the suite does not
 * need the network. Its `meta.json` lists every method of the protocol, which lets us also
 * check that we only ever name methods that exist.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

// ★ Read from the installed SDK, not a vendored copy. The copy existed because the SDK was
// not a dependency; it is one now, so the schema follows whatever version is installed and
// cannot silently drift from the SDK the runtime actually uses. `require.resolve` is used
// because the package maps these files through `exports`, which `readFileSync` cannot see.
const SCHEMA_DIR = dirname(require.resolve('@agentclientprotocol/sdk/schema/v1/schema.json'));
const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, 'schema.json'), 'utf8')) as Record<string, unknown>;
// The method inventory is NOT in the schema (there `method` is a plain string), so it stays a
// vendored copy — 1 KB, from the protocol release, not from the SDK.
const meta = JSON.parse(readFileSync(new URL('method-inventory.v1.json', import.meta.url), 'utf8')) as {
  version: number;
  agentMethods: Record<string, string>;
  clientMethods: Record<string, string>;
  protocolMethods: Record<string, string>;
};

// `strict: false` because the schema legitimately carries annotations ajv does not model;
// `allErrors` so one run reports every violation instead of the first.
// `logger: false`: the schema carries formats ajv does not ship (`int32` on the error-code
// unions). They are annotations here, not constraints we rely on, and the warning they raise
// per compiled subschema buries the test output.
const ajv = new Ajv2020({ strict: false, allErrors: true, logger: false });
const defs = schema['$defs'] as Record<string, unknown>;
ajv.addSchema({ ...schema, $id: 'acp' });

/** Validate `frame` against `#/$defs/<name>`; returns the messages, empty when valid. */
function violations(name: string, frame: unknown): string[] {
  if (!(name in defs)) throw new Error(`no such schema definition: ${name}`);
  const validate = ajv.compile({ $ref: `acp#/$defs/${name}`, $defs: defs });
  if (validate(frame)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || '<root>'} ${e.message ?? ''}`.trim());
}

/** Every method name the protocol defines, from the shipped `meta.json`. */
const PROTOCOL_METHODS = new Set([
  ...Object.values(meta.agentMethods),
  ...Object.values(meta.clientMethods),
  ...Object.values(meta.protocolMethods),
]);

describe('the vendored schema is the one we think it is', () => {
  it('is ACP v1 and carries a usable method inventory', () => {
    expect(meta.version).toBe(1);
    // A sanity floor: the release this was vendored from defines these.
    expect(PROTOCOL_METHODS.has('session/prompt')).toBe(true);
    expect(PROTOCOL_METHODS.has('session/update')).toBe(true);
    expect(Object.keys(defs).length).toBeGreaterThan(100);
  });
});

/**
 * The requests `AcpClient` sends, built from the shapes in `src/acp/client.ts`.
 *
 * Kept as data rather than by spying on a live client: a spy would only ever capture the frames
 * one particular test path happens to produce, while this covers every method the client can
 * call. When a request body changes, the change lands here and the schema immediately says
 * whether it is still legal.
 */
const OUR_REQUESTS: Record<string, unknown> = {
  InitializeRequest: {
    protocolVersion: 1,
    clientCapabilities: { elicitation: { form: {} }, _meta: { terminal_output: true } },
  },
  NewSessionRequest: { cwd: '/tmp', mcpServers: [] },
  ResumeSessionRequest: { sessionId: 'ses_1', cwd: '/tmp' },
  LoadSessionRequest: { sessionId: 'ses_1', cwd: '/tmp', mcpServers: [] },
  ListSessionsRequest: {},
  DeleteSessionRequest: { sessionId: 'ses_1' },
  CloseSessionRequest: { sessionId: 'ses_1' },
  PromptRequest: {
    sessionId: 'ses_1',
    prompt: [
      { type: 'text', text: 'hello' },
      // The three block types the client can forward when the agent advertises them.
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      { type: 'resource_link', uri: 'file:///tmp/a.txt', name: 'a.txt' },
    ],
  },
  CancelNotification: { sessionId: 'ses_1' },
  SetSessionConfigOptionRequest: { sessionId: 'ses_1', configId: 'model', value: 'deepseek-flash' },
  SetSessionModeRequest: { sessionId: 'ses_1', modeId: 'code' },
};

describe('the requests we send are legal ACP v1', () => {
  for (const [definition, frame] of Object.entries(OUR_REQUESTS)) {
    it(`${definition} validates against #/$defs/${definition}`, () => {
      expect(violations(definition, frame)).toEqual([]);
    });
  }

  it('every method the client calls exists in the protocol', () => {
    // Mirrors the method names used in src/acp/client.ts. A typo or an invented method fails
    // here rather than at a real agent, which is how `session/set_model` reached production.
    const called = [
      'initialize',
      'session/new',
      'session/load',
      'session/resume',
      'session/list',
      'session/delete',
      'session/close',
      'session/prompt',
      'session/cancel',
      'session/set_config_option',
      'session/set_mode',
      'session/set_model',
      'session/update',
      'session/request_permission',
      'elicitation/create',
    ];
    const unknown = called.filter((method) => !PROTOCOL_METHODS.has(method));
    // `session/set_model` is an UNSTABLE method (schema.unstable.json), not part of the stable
    // inventory — the one deliberate exception, and the client gates it on the agent's models
    // field. Everything else must be in the stable list.
    expect(unknown.filter((method) => method !== 'session/set_model')).toEqual([]);
  });
});

describe('the update variants we translate are legal ACP v1', () => {
  const notification = (update: unknown): unknown => ({
    sessionId: 'ses_1',
    update,
  });

  const SAMPLES: Record<string, unknown> = {
    'agent_message_chunk with text': {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hi' },
    },
    'agent_thought_chunk with text': {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'thinking' },
    },
    'user_message_chunk with text': {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'hello' },
    },
    'tool_call (the only row creator)': {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      title: 'Run a command',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'echo hi' },
    },
    'tool_call_update': {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'hi' } }],
    },
    'plan': {
      sessionUpdate: 'plan',
      entries: [{ content: 'step one', priority: 'high', status: 'pending' }],
    },
    'available_commands_update': {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'compact', description: 'Compact the conversation' }],
    },
    'current_mode_update': { sessionUpdate: 'current_mode_update', currentModeId: 'code' },
    'config_option_update': {
      sessionUpdate: 'config_option_update',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'deepseek-flash',
          options: [{ value: 'deepseek-flash', name: 'DeepSeek Flash' }],
        },
      ],
    },
    'session_info_update': { sessionUpdate: 'session_info_update', title: 'A title' },
    'usage_update': { sessionUpdate: 'usage_update', used: 10, size: 100 },
  };

  for (const [label, update] of Object.entries(SAMPLES)) {
    it(`${label} is a valid SessionNotification`, () => {
      expect(violations('SessionNotification', notification(update))).toEqual([]);
    });
  }

  it('a frame with an invented sessionUpdate value is rejected by the schema', () => {
    // Guards the guard: if the schema silently accepted anything, every case above would pass
    // for the wrong reason.
    const bad = notification({ sessionUpdate: 'session_idle', sessionId: 'ses_1' });
    expect(violations('SessionNotification', bad).length).toBeGreaterThan(0);
  });
});
