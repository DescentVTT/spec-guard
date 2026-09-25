/**
 * The MCP server's answers, message by message.
 *
 * The shapes pinned here are not this project's invention. The legacy results
 * follow the golden tests of the official TypeScript SDK's server - an
 * `initialize` answered with exactly protocolVersion, capabilities, serverInfo
 * and instructions, and not one word of 2026-07-28 vocabulary anywhere on a
 * legacy session - and the modern ones follow the 2026-07-28 schema: a
 * `resultType`, caching hints on the results that must carry them, identity in
 * `_meta`, and -32022 naming only modern revisions. ADR-0012 cites both.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  classifyRequest,
  createMcpHandler,
  documentPath,
  documentUri,
  envelopeIssue,
  negotiateLegacyVersion,
  INSTRUCTIONS,
  LEGACY_PROTOCOL_VERSIONS,
  MODERN_PROTOCOL_VERSIONS,
  RESOURCE_TEMPLATES,
  TOOLS,
  type McpServerOptions,
  type OutgoingMessage,
} from '../src/mcp.js';
import { makeTempRepo, removeTempRepo } from './helpers.js';

const MODERN = '2026-07-28';
const SERVER_INFO = { name: 'spec-guard', version: '9.9.9' };
const CAPABILITIES = { tools: {}, resources: {} };
const META = {
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
};

const LAYERS_ADR = [
  '# ADR-0001: Layers',
  '',
  '## Status',
  '',
  'Accepted',
  '',
  '<!-- @assert-layers target="src" order="src/domain, src/app, src/infra" reason="dependencies point inward" -->',
  '<!-- @assert-import-absence target="src/domain" module="pg" reason="the domain knows no database" -->',
  '<!-- @assert-absence target="src" symbol="console.log" -->',
  '',
].join('\n');

const DRAFT_ADR = ['# ADR-0002: Clocks', '', '**Status:** proposed', '', '<!-- @assert-absence target="src/domain" symbol="Date.now" -->', ''].join('\n');

let root: string;

beforeAll(async () => {
  root = await makeTempRepo({
    'docs/adr/0001-layers.md': LAYERS_ADR,
    'docs/adr/0002-clocks.md': DRAFT_ADR,
    'docs/notes on style.md': 'No title here, and no directives.\n',
    'src/domain/user.ts': 'export const user = 1;\n',
    'src/app/service.ts': "import { user } from '../domain/user.js';\nexport const service = user;\n",
    'src/infra/db.ts': "import pg from 'pg';\nconsole.log(pg);\n",
    'README.md': 'readme\n',
  });
});

afterAll(async () => {
  await removeTempRepo(root);
});

function handler(overrides: Partial<McpServerOptions> = {}) {
  return createMcpHandler({ root, patterns: ['docs/**/*.md'], version: '9.9.9', run: { engine: 'javascript' }, ...overrides });
}

async function request(method: string, params?: Record<string, unknown>, overrides: Partial<McpServerOptions> = {}): Promise<OutgoingMessage> {
  const response = await handler(overrides)({ jsonrpc: '2.0', id: 7, method, ...(params === undefined ? {} : { params }) });
  expect(response).not.toBeNull();
  return response as OutgoingMessage;
}

async function result(method: string, params?: Record<string, unknown>, overrides: Partial<McpServerOptions> = {}): Promise<Record<string, unknown>> {
  const response = await request(method, params, overrides);
  expect(response).not.toHaveProperty('error');
  expect(response).toMatchObject({ jsonrpc: '2.0', id: 7 });
  return (response as { result: Record<string, unknown> }).result;
}

async function failure(method: string, params?: Record<string, unknown>, overrides: Partial<McpServerOptions> = {}): Promise<unknown> {
  const response = await request(method, params, overrides);
  expect(response).not.toHaveProperty('result');
  expect(response).toMatchObject({ jsonrpc: '2.0', id: 7 });
  return (response as { error: unknown }).error;
}

const modern = (params: Record<string, unknown> = {}): Record<string, unknown> => ({ ...params, _meta: META });

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function tool(name: string, args?: unknown, overrides: Partial<McpServerOptions> = {}): Promise<ToolResult> {
  return (await result('tools/call', { name, ...(args === undefined ? {} : { arguments: args }) }, overrides)) as unknown as ToolResult;
}

/* ------------------------------------------------------------------ JSON-RPC */

describe('a message that is not a request the server can answer', () => {
  it('is an invalid request when it is not an object, with no id to answer to', async () => {
    const handle = handler();
    for (const message of ['ping', 42, null, true]) {
      expect(await handle(message)).toEqual({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' } });
    }
  });

  it('is refused as a batch when it is an array', async () => {
    expect(await handler()([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).toEqual({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Invalid Request: batches are not supported' },
    });
  });

  it('is an invalid request without jsonrpc "2.0" or a string method, answered to its id when it has one', async () => {
    const handle = handler();
    expect(await handle({ jsonrpc: '1.0', id: 1, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Invalid Request' } });
    expect(await handle({ id: 'x', method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 'x', error: { code: -32600, message: 'Invalid Request' } });
    expect(await handle({ jsonrpc: '2.0', id: 2, method: 5 })).toEqual({ jsonrpc: '2.0', id: 2, error: { code: -32600, message: 'Invalid Request' } });
    expect(await handle({ jsonrpc: '2.0', method: 5 })).toEqual({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' } });
  });

  it('is an invalid request when its id is null, fractional or not a primitive, and the id is not echoed', async () => {
    const handle = handler();
    for (const id of [null, 1.5, { n: 1 }, [1]]) {
      expect(await handle({ jsonrpc: '2.0', id, method: 'ping' })).toEqual({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' } });
    }
  });

  it('accepts a string id, an integer id and zero', async () => {
    const handle = handler();
    expect(await handle({ jsonrpc: '2.0', id: 'abc', method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 'abc', result: {} });
    expect(await handle({ jsonrpc: '2.0', id: 0, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 0, result: {} });
    expect(await handle({ jsonrpc: '2.0', id: -3, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: -3, result: {} });
  });

  it('owes nothing to a notification, known or not', async () => {
    const handle = handler();
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/whatever', params: { x: 1 } })).toBeNull();
    expect(await handle({ jsonrpc: '2.0', method: 'tools/list' })).toBeNull();
  });

  it('answers a message with a method as a request, whatever else it carries', async () => {
    expect(await handler()({ jsonrpc: '2.0', id: 5, method: 'ping', result: {} })).toEqual({ jsonrpc: '2.0', id: 5, result: {} });
  });

  it('owes nothing to a response, which a client should not send', async () => {
    const handle = handler();
    expect(await handle({ jsonrpc: '2.0', id: 3, result: {} })).toBeNull();
    expect(await handle({ jsonrpc: '2.0', id: 'r', error: { code: 1, message: 'no' } })).toBeNull();
  });

  it('answers a response-shaped message with a null id or no result as invalid', async () => {
    const handle = handler();
    expect(await handle({ jsonrpc: '2.0', id: null, result: {} })).toEqual({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' } });
    expect(await handle({ jsonrpc: '2.0', id: 4 })).toEqual({ jsonrpc: '2.0', id: 4, error: { code: -32600, message: 'Invalid Request' } });
    expect(await handle({ jsonrpc: '1.0', id: 4, result: {} })).toEqual({ jsonrpc: '2.0', id: 4, error: { code: -32600, message: 'Invalid Request' } });
  });

  it('refuses params that are not an object', async () => {
    expect(await handler()({ jsonrpc: '2.0', id: 1, method: 'ping', params: [1, 2] })).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'params must be an object.' },
    });
  });

  it('does not know a method it does not implement, in either era', async () => {
    expect(await failure('prompts/list')).toEqual({ code: -32601, message: 'Method not found' });
    expect(await failure('prompts/list', modern())).toEqual({ code: -32601, message: 'Method not found' });
    expect(await failure('subscriptions/listen', modern())).toEqual({ code: -32601, message: 'Method not found' });
  });

  it('reports a failure it did not expect as an internal error, not as silence', async () => {
    const broken = { patterns: ['docs/[z-a]*.md'] };
    const error = (await failure('resources/list', undefined, broken)) as { code: number; message: string };
    // A spec pattern with a range that runs backwards, which is not a request
    // the protocol could have refused. It was V8's error about the RegExp the
    // pattern compiled to, and is spec-core's refusal now (ADR-0015).
    expect(Object.keys(error).sort()).toEqual(['code', 'message']);
    expect(error.code).toBe(-32603);
    expect(error.message).toBe('Internal error: invalid spec pattern "docs/[z-a]*.md": the range "z-a" runs backwards');
  });
});

/* ---------------------------------------------------------------------- eras */

describe('the legacy era: initialize, then requests with no version on them', () => {
  it('answers initialize with exactly what the SDK golden answers with', async () => {
    expect(await result('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c', version: '1' } })).toEqual({
      protocolVersion: '2025-11-25',
      capabilities: CAPABILITIES,
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    });
  });

  it('settles on the version asked for when it is a legacy one', async () => {
    for (const version of LEGACY_PROTOCOL_VERSIONS) {
      expect((await result('initialize', { protocolVersion: version, capabilities: {} }))['protocolVersion']).toBe(version);
    }
  });

  it('counters anything else with the newest legacy version - a modern one included', async () => {
    for (const requested of [MODERN, '1999-01-01', 20251125, undefined]) {
      expect((await result('initialize', { protocolVersion: requested, capabilities: {} }))['protocolVersion']).toBe('2025-11-25');
    }
    expect((await result('initialize'))['protocolVersion']).toBe('2025-11-25');
  });

  it('answers ping with an empty result', async () => {
    expect(await result('ping')).toEqual({});
  });

  it('does not offer server/discover, which does not exist before 2026-07-28', async () => {
    expect(await failure('server/discover')).toEqual({ code: -32601, message: 'Method not found' });
    expect(await failure('server/discover', {})).toEqual({ code: -32601, message: 'Method not found' });
  });

  it('puts no 2026-07-28 vocabulary on the wire', async () => {
    const responses = [
      await request('initialize', { protocolVersion: '2025-06-18', capabilities: {} }),
      await request('tools/list'),
      await request('tools/call', { name: 'get_architectural_rules', arguments: { path: 'src/app/service.ts' } }),
      await request('tools/call', { name: 'check_architecture', arguments: { paths: ['src/domain'] } }),
      await request('resources/list'),
      await request('resources/templates/list'),
      await request('resources/read', { uri: 'spec://rules' }),
      await request('resources/read', { uri: 'spec://nothing' }),
      await request('ping'),
    ];
    const wire = JSON.stringify(responses);
    for (const word of ['"resultType"', '"ttlMs"', '"cacheScope"', 'io.modelcontextprotocol/', `"${MODERN}"`]) {
      expect(wire).not.toContain(word);
    }
  });
});

describe('the modern era: a protocol version on every request', () => {
  it('answers server/discover with modern versions only, identity in _meta and caching hints', async () => {
    expect(await result('server/discover', modern())).toEqual({
      resultType: 'complete',
      supportedVersions: [MODERN],
      capabilities: CAPABILITIES,
      instructions: INSTRUCTIONS,
      ttlMs: 0,
      cacheScope: 'private',
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
  });

  it('marks every cacheable result stale and private, and a tool result not at all', async () => {
    for (const [method, params] of [
      ['tools/list', modern()],
      ['resources/list', modern()],
      ['resources/templates/list', modern()],
      ['resources/read', modern({ uri: 'spec://rules' })],
    ] as const) {
      expect(await result(method, params)).toMatchObject({ resultType: 'complete', ttlMs: 0, cacheScope: 'private', _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO } });
    }
    const call = await result('tools/call', modern({ name: 'get_architectural_rules', arguments: { path: 'README.md' } }));
    expect(call).toMatchObject({ resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO } });
    expect(call).not.toHaveProperty('ttlMs');
    expect(call).not.toHaveProperty('cacheScope');
  });

  it('does not answer ping, which 2026-07-28 removed', async () => {
    expect(await failure('ping', modern())).toEqual({ code: -32601, message: 'Method not found' });
  });

  it('does not run the legacy handshake for an initialize that validly claims a modern version', async () => {
    expect(await failure('initialize', modern({ protocolVersion: '2025-11-25' }))).toEqual({ code: -32601, message: 'Method not found' });
  });

  it('refuses a version it does not serve with -32022, naming only the modern versions it does', async () => {
    for (const requested of ['2025-11-25', '2027-01-01']) {
      const params = { _meta: { ...META, 'io.modelcontextprotocol/protocolVersion': requested } };
      expect(await failure('tools/list', params)).toEqual({
        code: -32022,
        message: 'Unsupported protocol version',
        data: { supported: [MODERN], requested },
      });
    }
  });

  it('refuses a malformed claim with -32602 rather than falling back to legacy', async () => {
    const without = (key: string): Record<string, unknown> => Object.fromEntries(Object.entries(META).filter(([name]) => name !== key));
    const cases: Array<[Record<string, unknown>, string]> = [
      [without('io.modelcontextprotocol/clientCapabilities'), 'io.modelcontextprotocol/clientCapabilities: missing'],
      [{ ...META, 'io.modelcontextprotocol/protocolVersion': 20260728 }, 'io.modelcontextprotocol/protocolVersion: expected a string'],
      [{ ...META, 'io.modelcontextprotocol/clientCapabilities': [] }, 'io.modelcontextprotocol/clientCapabilities: expected an object'],
      [{ ...META, 'io.modelcontextprotocol/clientCapabilities': null }, 'io.modelcontextprotocol/clientCapabilities: expected an object'],
      [{ ...META, 'io.modelcontextprotocol/clientInfo': 'c' }, 'io.modelcontextprotocol/clientInfo: expected an object with a string name and version'],
      [{ ...META, 'io.modelcontextprotocol/clientInfo': { name: 'c' } }, 'io.modelcontextprotocol/clientInfo: expected an object with a string name and version'],
      [{ ...META, 'io.modelcontextprotocol/clientInfo': { version: '1' } }, 'io.modelcontextprotocol/clientInfo: expected an object with a string name and version'],
    ];
    for (const [meta, issue] of cases) {
      expect(await failure('tools/list', { _meta: meta })).toEqual({ code: -32602, message: `Invalid _meta envelope: ${issue}` });
    }
  });

  it('serves a claim without client info, which is only recommended', async () => {
    const meta = { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {} };
    expect(await result('tools/list', { _meta: meta })).toMatchObject({ resultType: 'complete' });
  });

  it('runs the legacy handshake for an initialize whose claim is malformed or legacy', async () => {
    const malformed = { protocolVersion: '2025-06-18', _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } };
    expect((await result('initialize', malformed))['protocolVersion']).toBe('2025-06-18');
    const legacyClaim = { protocolVersion: '2025-06-18', _meta: { ...META, 'io.modelcontextprotocol/protocolVersion': '2025-06-18' } };
    expect((await result('initialize', legacyClaim))['protocolVersion']).toBe('2025-06-18');
  });

  it('treats _meta without the version key as no claim at all', async () => {
    expect(await result('ping', { _meta: { progressToken: 1 } })).toEqual({});
    expect(await result('ping', { _meta: 'nonsense' })).toEqual({});
  });
});

describe('the era helpers', () => {
  it('classify by the presence of the version key, validating what is claimed', () => {
    expect(classifyRequest('tools/list', undefined)).toBe('legacy');
    expect(classifyRequest('tools/list', {})).toBe('legacy');
    expect(classifyRequest('tools/list', { _meta: META })).toBe('modern');
    expect(() => classifyRequest('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } })).toThrow(
      'Invalid _meta envelope: io.modelcontextprotocol/clientCapabilities: missing',
    );
  });

  it('report the first envelope issue, missing keys before malformed ones', () => {
    expect(envelopeIssue({ 'io.modelcontextprotocol/protocolVersion': 1 })).toBe('io.modelcontextprotocol/clientCapabilities: missing');
    expect(envelopeIssue(META)).toBeUndefined();
  });

  it('negotiate a legacy version', () => {
    expect(negotiateLegacyVersion('2024-11-05')).toBe('2024-11-05');
    expect(negotiateLegacyVersion('2026-07-28')).toBe('2025-11-25');
    expect(negotiateLegacyVersion(null)).toBe('2025-11-25');
  });

  it('list the versions, newest first', () => {
    expect(MODERN_PROTOCOL_VERSIONS).toEqual(['2026-07-28']);
    expect(LEGACY_PROTOCOL_VERSIONS).toEqual(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']);
  });
});

/* --------------------------------------------------------------------- tools */

describe('tools/list', () => {
  it('lists the two tools, read-only and closed-world, with schemas that refuse extra arguments', async () => {
    const listed = (await result('tools/list')) as { tools: Array<Record<string, unknown>> };
    expect(listed).toEqual({ tools: TOOLS });
    expect(listed.tools.map((entry) => entry['name'])).toEqual(['get_architectural_rules', 'check_architecture']);
    for (const entry of listed.tools) {
      expect(entry['annotations']).toEqual({ readOnlyHint: true, idempotentHint: true, openWorldHint: false });
      expect(entry['inputSchema']).toMatchObject({ type: 'object', additionalProperties: false });
    }
    // The words a model decides by. Pinned whole, because a description that
    // lost a clause would still be a string of plausible length.
    expect(listed.tools.map((entry) => [entry['title'], entry['description']])).toEqual([
      [
        'Architectural rules for a path',
        'Lists the architecture rules in force for a file or directory, grouped by the ADR or spec that states them: ' +
          'modules it must not import, the layer it belongs to and the layers it must not depend on, import cycles, ' +
          'what it must be named and the partner files it needs, ' +
          'and text or symbols it must not contain, each with the reason the document gives. ' +
          'Answers from the specs without reading the codebase, so it works for a file that does not exist yet. ' +
          'Rules in documents that are not in force are counted and named but not listed unless include_inactive is true.',
      ],
      [
        'Check the architecture rules',
        'Runs the architecture rules in force against the files on disk and reports every violation, as CI would. ' +
          'Given paths, runs only the rules that govern them - each over its whole scope, so a count or a cycle is judged ' +
          'exactly as CI judges it - and marks which violations lie in those paths. Save your edits before calling.',
      ],
    ]);
    expect(INSTRUCTIONS).toBe(
      "spec-guard enforces the architecture decisions written in this project's Markdown specs and ADRs. " +
        'Before creating or changing a file, call get_architectural_rules with its path to learn the rules in force there: ' +
        'imports it must not make, the layer it belongs to, what it must be named and the files it needs beside it, text it must not contain. ' +
        'After changing files, call check_architecture with their paths to find violations before CI does. ' +
        'Rules in draft, proposed, rejected, deprecated, superseded or archived documents are not in force and are only counted.',
    );
    expect(listed.tools[0]?.['inputSchema']).toEqual({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'A file or directory, relative to the project root or absolute inside it.' },
        include_inactive: { type: 'boolean', description: 'Also list rules from draft, proposed, rejected, deprecated, superseded and archived documents.' },
      },
      required: ['path'],
      additionalProperties: false,
    });
    expect(listed.tools[1]?.['inputSchema']).toEqual({
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files or directories to check the rules of, relative to the project root. Omit to run every rule.',
        },
      },
      additionalProperties: false,
    });
  });

  it('refuses a cursor, since it never hands one out', async () => {
    expect(await failure('tools/list', { cursor: 'abc' })).toEqual({ code: -32602, message: 'Invalid cursor: this server does not paginate.' });
  });
});

describe('tools/call, as a request', () => {
  it('needs a tool name, a known tool and object arguments', async () => {
    expect(await failure('tools/call', {})).toEqual({ code: -32602, message: 'tools/call needs the name of a tool.' });
    expect(await failure('tools/call', { name: 42 })).toEqual({ code: -32602, message: 'tools/call needs the name of a tool.' });
    expect(await failure('tools/call', { name: 'nope' })).toEqual({ code: -32602, message: 'Unknown tool: nope' });
    expect(await failure('tools/call', { name: 'check_architecture', arguments: ['src'] })).toEqual({ code: -32602, message: 'Tool arguments must be an object.' });
    expect(await failure('tools/call', { name: 'check_architecture', arguments: 'src' })).toEqual({ code: -32602, message: 'Tool arguments must be an object.' });
  });
});

describe('get_architectural_rules', () => {
  it('lists the rules governing a file, with its layer, as text and as structure', async () => {
    const called = await tool('get_architectural_rules', { path: 'src/app/service.ts' });
    expect(called).not.toHaveProperty('isError');
    expect(called.content).toHaveLength(1);
    expect(called.content[0]?.type).toBe('text');

    const structured = called.structuredContent as { results: Array<{ path: string; rules: Array<Record<string, unknown>>; withheld: unknown }>; specFiles: string[] };
    expect(structured.specFiles).toEqual(['docs/adr/0001-layers.md', 'docs/adr/0002-clocks.md', 'docs/notes on style.md']);
    const [only] = structured.results;
    expect(only?.path).toBe('src/app/service.ts');
    expect(only?.rules.map((rule) => rule['kind'])).toEqual(['assert-layers', 'assert-absence']);
    expect(only?.rules[0]?.['position']).toEqual({
      layer: 'src/app',
      position: 2,
      matches: ['src/app'],
      mayImport: ['src/domain', 'src/app'],
      mustNotImport: ['src/infra'],
    });
    expect(only?.withheld).toEqual({ rules: 0, documents: [] });

    expect(called.content[0]?.text).toContain('src/app/service.ts\n  2 rules from 1 document');
    expect(called.content[0]?.text).toContain('layer: src/app (2 of 3)');
    expect(called.content[0]?.text).toContain('must not import: src/infra');
  });

  it('counts and names a draft that would govern the path, and lists it only when asked', async () => {
    const quiet = (await tool('get_architectural_rules', { path: 'src/domain/user.ts' })).structuredContent as {
      results: Array<{ rules: Array<Record<string, unknown>>; withheld: unknown }>;
    };
    expect(quiet.results[0]?.rules.map((rule) => rule['kind'])).toEqual(['assert-layers', 'assert-import-absence', 'assert-absence']);
    expect(quiet.results[0]?.withheld).toEqual({ rules: 1, documents: ['docs/adr/0002-clocks.md'] });

    const asked = (await tool('get_architectural_rules', { path: 'src/domain/user.ts', include_inactive: true })).structuredContent as {
      results: Array<{ rules: Array<Record<string, unknown>> }>;
    };
    expect(asked.results[0]?.rules.map((rule) => [rule['document'], rule['inForce']])).toEqual([
      ['docs/adr/0001-layers.md', true],
      ['docs/adr/0001-layers.md', true],
      ['docs/adr/0001-layers.md', true],
      ['docs/adr/0002-clocks.md', false],
    ]);

    const explicitNo = (await tool('get_architectural_rules', { path: 'src/domain/user.ts', include_inactive: false }, { run: { ignoreStatus: true } }))
      .structuredContent as { results: Array<{ rules: unknown[] }> };
    expect(explicitNo.results[0]?.rules).toHaveLength(3);
  });

  it('works with no run settings at all, and applies --include-specs and --no-default-skips when given', async () => {
    const bare = createMcpHandler({ root, patterns: ['docs/**/*.md'], version: '1' });
    const ask = async (options: Partial<McpServerOptions>, target: string): Promise<number> => {
      const response = (await createMcpHandler({ root, patterns: ['docs/**/*.md'], version: '1', ...options })({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_architectural_rules', arguments: { path: target } },
      })) as unknown as { result: { structuredContent: { results: Array<{ rules: unknown[] }> } } };
      return response.result.structuredContent.results[0]?.rules.length as number;
    };

    const call = (await bare({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_architectural_rules', arguments: { path: 'src/domain/user.ts' } } })) as unknown as {
      result: ToolResult;
    };
    expect(call.result.structuredContent).toMatchObject({ results: [{ rules: [{}, {}, {}], withheld: { rules: 1 } }] });
    const check = (await bare({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'check_architecture', arguments: {} } })) as unknown as { result: ToolResult };
    expect(check.result.structuredContent).toMatchObject({ rules: { inForce: 3, failed: 1 } });
    expect(check.result.content[0]?.text).toContain('src/infra/db.ts:2:1');

    expect(await ask({}, 'src/node_modules/x.ts')).toBe(0);
    expect(await ask({ run: { defaultSkips: false } }, 'src/node_modules/x.ts')).toBe(2);
    const everywhere = await makeTempRepo({ 'docs/a.md': '<!-- @assert-absence symbol="X" -->\n' });
    try {
      const spec = { root: everywhere, patterns: ['docs/*.md'] };
      expect(await ask(spec, 'docs/a.md')).toBe(0);
      expect(await ask({ ...spec, run: { includeSpecs: true } }, 'docs/a.md')).toBe(1);
    } finally {
      await removeTempRepo(everywhere);
    }
  });

  it('lists inactive rules by default when the server was started with --ignore-status', async () => {
    const structured = (await tool('get_architectural_rules', { path: 'src/domain/user.ts' }, { run: { ignoreStatus: true } })).structuredContent as {
      results: Array<{ rules: unknown[] }>;
    };
    expect(structured.results[0]?.rules).toHaveLength(4);
  });

  it('accepts an absolute path inside the root and a path that does not exist yet', async () => {
    const absolute = (await tool('get_architectural_rules', { path: path.join(root, 'src', 'infra', 'cache.ts') })).structuredContent as {
      results: Array<{ path: string; exists: boolean; rules: Array<Record<string, unknown>> }>;
    };
    expect(absolute.results[0]).toMatchObject({ path: 'src/infra/cache.ts', exists: false });
    expect((absolute.results[0]?.rules[0]?.['position'] as { layer: string }).layer).toBe('src/infra');
  });

  it('tells the model what to fix about its arguments, as a tool error it can read', async () => {
    const cases: Array<[unknown, string]> = [
      [{}, '"path" is required and must be a string.'],
      [{ path: 3 }, '"path" is required and must be a string.'],
      [{ path: 'src', include_inactive: 'yes' }, '"include_inactive" must be true or false.'],
      [{ path: 'src', paths: ['a'] }, 'Unknown argument "paths"; this tool takes path and include_inactive.'],
      [{ path: 'src', a: 1, b: 2 }, 'Unknown arguments "a", "b"; this tool takes path and include_inactive.'],
      [{ path: '' }, 'A path to query must not be empty.'],
      [{ path: '../elsewhere' }, `"../elsewhere" is outside the root ${root.replace(/\\/g, '/')}.`],
    ];
    for (const [args, message] of cases) {
      expect(await tool('get_architectural_rules', args)).toEqual({ content: [{ type: 'text', text: message }], isError: true });
    }
    expect(await tool('get_architectural_rules')).toEqual({ content: [{ type: 'text', text: '"path" is required and must be a string.' }], isError: true });
  });

  it('says how to point the server at the specs when there are none', async () => {
    expect(await tool('get_architectural_rules', { path: 'src' }, { patterns: ['nowhere/*.md', 'x.md'] })).toEqual({
      content: [
        {
          type: 'text',
          text: `No spec files matched "nowhere/*.md", "x.md" under ${root}. Start the server with --spec <glob> or --root <dir> pointing at the project.`,
        },
      ],
      isError: true,
    });
  });

  it('reports a failure inside spec-guard to the model rather than as a protocol error', async () => {
    const called = await tool('get_architectural_rules', { path: 'src' }, { patterns: ['docs/[z-a]*.md'] });
    expect(Object.keys(called).sort()).toEqual(['content', 'isError']);
    expect(called.isError).toBe(true);
    expect(called.content[0]?.text).toBe('spec-guard failed: invalid spec pattern "docs/[z-a]*.md": the range "z-a" runs backwards');
  });
});

describe('check_architecture', () => {
  it('runs every rule in force when given no paths, and marks every violation as in scope', async () => {
    const called = await tool('check_architecture');
    const structured = called.structuredContent as Record<string, unknown>;
    expect(called).not.toHaveProperty('isError');
    expect(structured).toMatchObject({
      ok: false,
      paths: null,
      rules: { inForce: 3, checked: 3, passed: 2, failed: 1 },
      errors: [],
      inactiveSpecs: [{ file: 'docs/adr/0002-clocks.md', status: 'proposed', label: 'proposed', directives: 1 }],
      warnings: [],
    });
    expect(structured['failures']).toEqual([
      {
        document: 'docs/adr/0001-layers.md',
        line: 9,
        kind: 'assert-absence',
        description: '"console.log" must not appear in src',
        reason: null,
        message: 'expected no matches, found 1',
        matches: [{ file: 'src/infra/db.ts', line: 2, column: 1, text: 'console.log(pg);', count: 1, inPaths: true }],
        warnings: [],
      },
    ]);
    expect(structured['engine']).toBe('javascript');
    expect(called.content[0]?.text).toMatch(
      /^Checked all 3 rules in force\.\n\nspec-guard 3 specs · 3 assertions · javascript\n\nx docs\/adr\/0001-layers\.md:9 {2}@assert-absence\n {4}"console\.log" must not appear in src\n {4}expected no matches, found 1\n {6}src\/infra\/db\.ts:2:1 {2}console\.log\(pg\);\n\no docs\/adr\/0002-clocks\.md is proposed - 1 assertion not executed\n\n2 passed · 1 failed · 1 not in force · \d+m?s$/,
    );
  });

  it('writes its text the way a model can read it: no colour, no passing rules, ASCII marks', async () => {
    const text = (await tool('check_architecture')).content[0]?.text as string;
    expect(text).not.toContain(String.fromCharCode(27));
    expect(text).not.toMatch(/[✔✖⚠○…]/);
    expect(text).not.toContain('@assert-layers');
    const capped = (await tool('check_architecture', {}, { run: { engine: 'javascript', maxSnippets: 0 } })).content[0]?.text as string;
    expect(capped).toContain('expected no matches, found 1');
    expect(capped).not.toContain('src/infra/db.ts:2:1');
  });

  it('reports how long it took, rounded to microseconds and no longer than the call', async () => {
    const before = performance.now();
    const check = (await tool('check_architecture')).structuredContent?.['durationMs'] as number;
    const between = performance.now();
    const rules = (await tool('get_architectural_rules', { path: 'src' })).structuredContent?.['durationMs'] as number;
    const after = performance.now();

    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThanOrEqual(between - before);
    // Rounded to microseconds means rounding again changes nothing. Comparing
    // `check * 1000` with its own rounding was the test's arithmetic, not the
    // server's: 4.057 * 1000 is 4057.0000000000005 in floating point.
    expect(Math.round(check * 1000) / 1000).toBe(check);
    expect(rules).toBeGreaterThan(0);
    expect(rules).toBeLessThanOrEqual(after - between);
  });

  it('reports directives that do not resolve, since they fail the run it answers for', async () => {
    const broken = await makeTempRepo({
      'docs/a.md': '# A\n\n<!-- @assert-absence target="src" symbol="X" -->\n<!-- @assert-count target="src" symbol="Y" -->\n',
      'src/a.ts': 'export {};\n',
    });
    try {
      const called = await tool('check_architecture', { paths: ['src/a.ts'] }, { root: broken });
      expect(called.structuredContent).toMatchObject({
        ok: false,
        rules: { inForce: 1, checked: 1, passed: 1, failed: 0 },
        failures: [],
        errors: [{ file: 'docs/a.md', line: 4, message: '@assert-count requires expected="...", min="..." or max="...".' }],
      });
    } finally {
      await removeTempRepo(broken);
    }
  });

  it('runs only the rules governing the paths given, and says which violations lie elsewhere', async () => {
    const domain = await tool('check_architecture', { paths: ['src/domain'] });
    expect(domain.structuredContent).toMatchObject({ paths: ['src/domain'], rules: { inForce: 3, checked: 3, failed: 1 } });
    expect((domain.structuredContent?.['failures'] as Array<{ matches: Array<{ inPaths: boolean }> }>)[0]?.matches[0]?.inPaths).toBe(false);
    expect(domain.content[0]?.text.startsWith('Checked 3 of 3 rules in force - the ones that govern src/domain.\n\n')).toBe(true);

    const db = await tool('check_architecture', { paths: ['src/infra/db.ts', 'README.md'] });
    expect((db.structuredContent?.['failures'] as Array<{ matches: Array<{ inPaths: boolean }> }>)[0]?.matches[0]?.inPaths).toBe(true);
    expect(db.structuredContent).toMatchObject({ rules: { inForce: 3, checked: 2 } });
    expect(db.content[0]?.text.startsWith('Checked 2 of 3 rules in force - the ones that govern src/infra/db.ts, README.md.\n\n')).toBe(true);

    const readme = await tool('check_architecture', { paths: ['README.md'] });
    expect(readme.structuredContent).toMatchObject({ ok: true, paths: ['README.md'], rules: { inForce: 3, checked: 0, passed: 0, failed: 0 }, failures: [] });
    expect(readme.content[0]?.text.startsWith('Checked 0 of 3 rules in force - the ones that govern README.md.\n\n')).toBe(true);
  });

  it('passes the run settings it was started with to the run', async () => {
    const strictlyEmpty = await tool('check_architecture', { paths: ['src/app'] }, { run: { engine: 'javascript', ignoreStatus: true } });
    expect(strictlyEmpty.structuredContent).toMatchObject({ rules: { inForce: 4 }, inactiveSpecs: [] });
    const capped = await tool('check_architecture', {}, { run: { engine: 'javascript', maxSnippets: 0 } });
    expect((capped.structuredContent?.['failures'] as Array<{ matches: unknown[] }>)[0]?.matches).toEqual([]);
  });

  it('tells the model what is wrong with its arguments', async () => {
    const cases: Array<[unknown, string]> = [
      [{ paths: 'src' }, '"paths" must be an array of strings.'],
      [{ paths: ['src', 3] }, '"paths" must be an array of strings.'],
      [{ path: 'src' }, 'Unknown argument "path"; this tool takes paths.'],
      [{ paths: ['/../../..'] }, `"/../../.." is outside the root ${root.replace(/\\/g, '/')}.`],
    ];
    for (const [args, message] of cases) {
      const called = await tool('check_architecture', args);
      if (message.startsWith('"/../')) {
        // An absolute path resolves against the filesystem root, whichever it is.
        expect(called).toMatchObject({ isError: true });
        expect(called.content[0]?.text).toMatch(/is outside the root/);
        expect(called).not.toHaveProperty('structuredContent');
      } else {
        expect(called).toEqual({ content: [{ type: 'text', text: message }], isError: true });
      }
    }
  });

  it('says how to point the server at the specs when there are none', async () => {
    const called = await tool('check_architecture', {}, { patterns: ['nowhere/*.md'] });
    expect(called).toMatchObject({ isError: true });
    expect(called.content[0]?.text).toBe(`No spec files matched "nowhere/*.md" under ${root}. Start the server with --spec <glob> or --root <dir> pointing at the project.`);
  });
});

/* ----------------------------------------------------------------- resources */

describe('resources', () => {
  it('lists the rules and the documents in force, leaving out the draft', async () => {
    expect(await result('resources/list')).toEqual({
      resources: [
        {
          uri: 'spec://rules',
          name: 'rules',
          title: 'Rules in force',
          description: 'Every rule in force, with the document that states it and its scope, as JSON.',
          mimeType: 'application/json',
        },
        { uri: 'spec://doc/docs/adr/0001-layers.md', name: 'docs/adr/0001-layers.md', title: 'ADR-0001: Layers', mimeType: 'text/markdown' },
        { uri: 'spec://doc/docs/notes%20on%20style.md', name: 'docs/notes on style.md', title: 'docs/notes on style.md', mimeType: 'text/markdown' },
      ],
    });
    expect(await failure('resources/list', { cursor: 'x' })).toEqual({ code: -32602, message: 'Invalid cursor: this server does not paginate.' });
  });

  it('offers one template, for any document by path', async () => {
    expect(await result('resources/templates/list')).toEqual({ resourceTemplates: RESOURCE_TEMPLATES });
    expect(RESOURCE_TEMPLATES).toEqual([
      {
        uriTemplate: 'spec://doc/{+path}',
        name: 'spec-document',
        title: 'Spec document',
        description: 'Any spec document by its path relative to the project root, including documents that are not in force.',
        mimeType: 'text/markdown',
      },
    ]);
    expect(await failure('resources/templates/list', { cursor: 'x' })).toEqual({ code: -32602, message: 'Invalid cursor: this server does not paginate.' });
  });

  it('reads the rules in force as JSON, with the documents that are not in force named', async () => {
    const read = (await result('resources/read', { uri: 'spec://rules' })) as { contents: Array<{ uri: string; mimeType: string; text: string }> };
    expect(read.contents).toHaveLength(1);
    expect(read.contents[0]).toMatchObject({ uri: 'spec://rules', mimeType: 'application/json' });
    const body = JSON.parse(read.contents[0]?.text as string) as Record<string, unknown>;
    expect(body['root']).toBe(root.replace(/\\/g, '/'));
    expect(body['specFiles']).toEqual(['docs/adr/0001-layers.md', 'docs/adr/0002-clocks.md', 'docs/notes on style.md']);
    expect((body['rules'] as Array<Record<string, unknown>>).map((rule) => [rule['kind'], rule['line'], rule['inForce']])).toEqual([
      ['assert-layers', 7, true],
      ['assert-import-absence', 8, true],
      ['assert-absence', 9, true],
    ]);
    expect((body['rules'] as Array<Record<string, unknown>>)[0]).not.toHaveProperty('position');
    expect(body['notInForce']).toEqual([
      { file: 'docs/adr/0002-clocks.md', title: 'ADR-0002: Clocks', status: 'proposed', label: 'proposed', inForce: false, rules: 1 },
    ]);
    expect(body['errors']).toEqual([]);
  });

  it('reads the rules resource with the errors of directives that do not resolve', async () => {
    const broken = await makeTempRepo({ 'docs/a.md': '<!-- @assert-count target="src" symbol="X" -->\n' });
    try {
      const read = (await result('resources/read', { uri: 'spec://rules' }, { root: broken })) as { contents: Array<{ text: string }> };
      expect(JSON.parse(read.contents[0]?.text as string)['errors']).toEqual([
        { file: 'docs/a.md', line: 1, message: '@assert-count requires expected="...", min="..." or max="...".' },
      ]);
    } finally {
      await removeTempRepo(broken);
    }
  });

  it('reads any document, in force or not, including one whose path needs encoding', async () => {
    expect(await result('resources/read', { uri: 'spec://doc/docs/adr/0002-clocks.md' })).toEqual({
      contents: [{ uri: 'spec://doc/docs/adr/0002-clocks.md', mimeType: 'text/markdown', text: DRAFT_ADR }],
    });
    const spaced = (await result('resources/read', { uri: 'spec://doc/docs/notes%20on%20style.md' })) as { contents: Array<{ text: string }> };
    expect(spaced.contents[0]?.text).toBe('No title here, and no directives.\n');
  });

  it('reads nothing that is not a spec document, whatever the URI says', async () => {
    for (const uri of ['spec://doc/README.md', 'spec://doc/src/infra/db.ts', 'spec://doc/../package.json', 'spec://doc/docs/adr/../../README.md', 'spec://doc/%E0%A4%A', 'file:///etc/passwd', 'spec://rules/']) {
      expect(await failure('resources/read', { uri })).toEqual({ code: -32002, message: 'Resource not found', data: { uri } });
      expect(await failure('resources/read', modern({ uri }))).toEqual({ code: -32602, message: 'Resource not found', data: { uri } });
    }
  });

  it('reports a document that disappears between listing and reading as not found', async () => {
    const readFile = async (): Promise<string> => {
      throw new Error('ENOENT');
    };
    expect(await failure('resources/read', { uri: 'spec://doc/docs/adr/0001-layers.md' }, { readFile })).toEqual({
      code: -32002,
      message: 'Resource not found',
      data: { uri: 'spec://doc/docs/adr/0001-layers.md' },
    });
  });

  it('needs a uri', async () => {
    expect(await failure('resources/read', {})).toEqual({ code: -32602, message: 'resources/read needs a uri.' });
    expect(await failure('resources/read')).toEqual({ code: -32602, message: 'resources/read needs a uri.' });
  });

  it('reads documents from disk each time, so an edited ADR is never served stale', async () => {
    const file = path.join(root, 'docs/notes on style.md');
    const before = await fs.readFile(file, 'utf8');
    try {
      await fs.writeFile(file, 'edited\n');
      const read = (await result('resources/read', { uri: 'spec://doc/docs/notes%20on%20style.md' })) as { contents: Array<{ text: string }> };
      expect(read.contents[0]?.text).toBe('edited\n');
    } finally {
      await fs.writeFile(file, before);
    }
  });
});

describe('document URIs', () => {
  it('encode each segment and keep the slashes', () => {
    expect(documentUri('docs/adr/0001 a#b?.md')).toBe('spec://doc/docs/adr/0001%20a%23b%3F.md');
    expect(documentPath('spec://doc/docs/adr/0001%20a%23b%3F.md')).toBe('docs/adr/0001 a#b?.md');
  });

  it('name nothing outside their scheme, and nothing when malformed', () => {
    expect(documentPath('spec://rules')).toBeNull();
    expect(documentPath('file:///docs/a.md')).toBeNull();
    expect(documentPath('spec://doc/%E0%A4%A')).toBeNull();
    expect(documentPath('spec://doc/')).toBe('');
  });
});
