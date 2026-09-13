/**
 * The stdio binding: newline-delimited JSON-RPC, and nothing else on stdout.
 *
 * Framing is where a hand-written server goes wrong without any test of its
 * logic noticing: a message split across two reads, two messages in one read, a
 * CRLF from a Windows client, a character whose UTF-8 bytes straddle a chunk
 * boundary. Each is fed here as the bytes a pipe would really deliver.
 */

import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EXIT_ERROR, EXIT_OK, main, version, type CliIO } from '../src/cli.js';
import { serveStdio, type OutgoingMessage } from '../src/mcp.js';
import { findTestRipgrep, makeTempRepo, removeTempRepo } from './helpers.js';

/** A handler that answers every request with its own method and params. */
const echo = async (message: unknown): Promise<OutgoingMessage | null> => {
  const { id, method, params } = message as { id?: number | string; method?: string; params?: unknown };
  return id === undefined ? null : { jsonrpc: '2.0', id, result: { method, params } };
};

function serve(handle = echo) {
  const input = new PassThrough();
  const lines: string[] = [];
  const done = serveStdio(input, (line) => lines.push(line), handle);
  return { input, lines, done };
}

const parsed = (lines: readonly string[]): unknown[] => lines.map((line) => JSON.parse(line) as unknown);

describe('framing', () => {
  it('reads a message split across reads, and several in one read', async () => {
    const { input, lines, done } = serve();
    input.write('{"jsonrpc":"2.0","id":1,"me');
    input.write('thod":"a"}\n{"jsonrpc":"2.0","id":2,"method":"b"}\n{"jsonrpc":"2.0",');
    input.write('"id":3,"method":"c"}\n');
    input.end();
    await done;
    expect(parsed(lines)).toEqual([
      { jsonrpc: '2.0', id: 1, result: { method: 'a' } },
      { jsonrpc: '2.0', id: 2, result: { method: 'b' } },
      { jsonrpc: '2.0', id: 3, result: { method: 'c' } },
    ]);
  });

  it('drops the carriage return of a CRLF line and skips blank lines', async () => {
    const { input, lines, done } = serve();
    input.end('\r\n\n   \n{"jsonrpc":"2.0","id":1,"method":"a"}\r\n\t\r\n');
    await done;
    expect(parsed(lines)).toEqual([{ jsonrpc: '2.0', id: 1, result: { method: 'a' } }]);
  });

  it('keeps a character whose bytes arrive in two reads', async () => {
    const { input, lines, done } = serve();
    const bytes = Buffer.from('{"jsonrpc":"2.0","id":"é😀","method":"a","params":{"t":"日本"}}\n', 'utf8');
    const cut = bytes.indexOf(Buffer.from('😀')) + 2;
    input.write(bytes.subarray(0, cut));
    input.write(bytes.subarray(cut));
    input.end();
    await done;
    expect(parsed(lines)).toEqual([{ jsonrpc: '2.0', id: 'é😀', result: { method: 'a', params: { t: '日本' } } }]);
  });

  it('answers a line that is not JSON with a parse error, and carries on', async () => {
    const { input, lines, done } = serve();
    input.end('not json\n{"jsonrpc":"2.0","id":1,"method":"a"}\n');
    await done;
    expect(lines[0]).toBe('{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error"}}');
    expect(parsed(lines.slice(1))).toEqual([{ jsonrpc: '2.0', id: 1, result: { method: 'a' } }]);
  });

  it('hands JSON that is not an object to the handler, which is where it is refused', async () => {
    const seen: unknown[] = [];
    const { input, lines, done } = serve(async (message) => {
      seen.push(message);
      return { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' } };
    });
    input.end('null\n42\n"text"\n');
    await done;
    expect(seen).toEqual([null, 42, 'text']);
    expect(lines).toHaveLength(3);
  });

  it('reads a last message the client ended without a newline', async () => {
    const { input, lines, done } = serve();
    input.end('{"jsonrpc":"2.0","id":9,"method":"last"}');
    await done;
    expect(parsed(lines)).toEqual([{ jsonrpc: '2.0', id: 9, result: { method: 'last' } }]);
  });

  it('writes every response as one line, whatever newlines its strings hold', async () => {
    const { input, lines, done } = serve();
    input.end('{"jsonrpc":"2.0","id":1,"method":"a","params":{"text":"one\\ntwo\\r\\nthree\\u2028"}}\n');
    await done;
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/[\r\n]/);
    expect(parsed(lines)).toEqual([{ jsonrpc: '2.0', id: 1, result: { method: 'a', params: { text: 'one\ntwo\r\nthree ' } } }]);
  });

  it('writes nothing for a notification', async () => {
    const { input, lines, done } = serve();
    input.end('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await done;
    expect(lines).toEqual([]);
  });

  it('rejects when the input stream fails', async () => {
    const { input, done } = serve();
    input.destroy(new Error('pipe broke'));
    await expect(done).rejects.toThrow('pipe broke');
  });
});

describe('concurrency and cancellation', () => {
  function gated() {
    const gates = new Map<string, () => void>();
    const handle = async (message: unknown): Promise<OutgoingMessage | null> => {
      const { id, method } = message as { id: number | string; method: string };
      if (method === 'slow') await new Promise<void>((resolve) => gates.set(`${typeof id}:${id}`, resolve));
      return { jsonrpc: '2.0', id, result: { method } };
    };
    const open = async (id: number | string): Promise<void> => {
      const key = `${typeof id}:${id}`;
      for (let tries = 0; tries < 100 && !gates.has(key); tries++) await new Promise((resolve) => setImmediate(resolve));
      (gates.get(key) as () => void)();
    };
    return { handle, open };
  }

  it('answers in the order requests finish, not the order they arrived', async () => {
    const { handle, open } = gated();
    const { input, lines, done } = serve(handle);
    input.write('{"jsonrpc":"2.0","id":1,"method":"slow"}\n{"jsonrpc":"2.0","id":2,"method":"fast"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    await open(1);
    input.end();
    await done;
    expect(parsed(lines)).toEqual([
      { jsonrpc: '2.0', id: 2, result: { method: 'fast' } },
      { jsonrpc: '2.0', id: 1, result: { method: 'slow' } },
    ]);
  });

  it('waits for requests still running when the input ends', async () => {
    const { handle, open } = gated();
    const { input, lines, done } = serve(handle);
    input.end('{"jsonrpc":"2.0","id":1,"method":"slow"}\n');
    let settled = false;
    void done.then(() => (settled = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    await open(1);
    await done;
    expect(parsed(lines)).toEqual([{ jsonrpc: '2.0', id: 1, result: { method: 'slow' } }]);
  });

  it('sends nothing at all for a request the client cancels', async () => {
    const { handle, open } = gated();
    const { input, lines, done } = serve(handle);
    input.write('{"jsonrpc":"2.0","id":1,"method":"slow"}\n{"jsonrpc":"2.0","id":"1","method":"slow"}\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1,"reason":"user"}}\n');
    // The one not cancelled finishes first, so a cancellation filed under the
    // wrong key would silence it instead.
    await open('1');
    await new Promise((resolve) => setImmediate(resolve));
    await open(1);
    input.end();
    await done;
    // Only the string id "1" is answered: the number 1 was cancelled, and they are different ids.
    expect(parsed(lines)).toEqual([{ jsonrpc: '2.0', id: '1', result: { method: 'slow' } }]);
  });

  it('keeps serving after answering everything it has been sent', async () => {
    const { input, lines, done } = serve();
    let settled = false;
    void done.then(() => (settled = true));
    input.write('{"jsonrpc":"2.0","id":1,"method":"a"}\n');
    for (let tries = 0; tries < 100 && lines.length === 0; tries++) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines).toHaveLength(1);
    expect(settled).toBe(false);
    input.end('{"jsonrpc":"2.0","id":2,"method":"b"}\n');
    await done;
    expect(lines).toHaveLength(2);
  });

  it('ignores a cancellation for a request that is unknown, finished or malformed', async () => {
    const { input, lines, done } = serve();
    input.write('{"jsonrpc":"2.0","id":1,"method":"a"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    input.write('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":2}}\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":null}}\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/cancelled","params":"1"}\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/cancelled"}\n');
    input.end('{"jsonrpc":"2.0","id":2,"method":"b"}\n');
    await done;
    expect(parsed(lines)).toEqual([
      { jsonrpc: '2.0', id: 1, result: { method: 'a' } },
      { jsonrpc: '2.0', id: 2, result: { method: 'b' } },
    ]);
  });

  it('does not let a cancellation that arrived too late suppress a later request reusing the id', async () => {
    const { handle, open } = gated();
    const { input, lines, done } = serve(handle);
    input.write('{"jsonrpc":"2.0","id":5,"method":"fast"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    input.write('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":5}}\n');
    input.write('{"jsonrpc":"2.0","id":5,"method":"slow"}\n');
    await open(5);
    input.end();
    await done;
    expect(parsed(lines)).toEqual([
      { jsonrpc: '2.0', id: 5, result: { method: 'fast' } },
      { jsonrpc: '2.0', id: 5, result: { method: 'slow' } },
    ]);
  });

  it('does not let a cancellation silence the answer to something that was not a request', async () => {
    const seen: unknown[] = [];
    const { input, lines, done } = serve(async (message) => {
      seen.push(message);
      return { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' } };
    });
    // One read, so the cancellation is handled before either answer is ready.
    input.end(
      '{"jsonrpc":"2.0","id":1}\n{"jsonrpc":"2.0","id":3,"method":7}\n[1]\n' +
        '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}\n' +
        '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":3}}\n',
    );
    await done;
    expect(seen).toEqual([{ jsonrpc: '2.0', id: 1 }, { jsonrpc: '2.0', id: 3, method: 7 }, [1]]);
    expect(lines).toHaveLength(3);
  });

  it('tracks a request by its id even when something else about it is wrong', async () => {
    const { input, lines, done } = serve(async (message) => {
      const { id } = message as { id: number };
      return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };
    });
    input.end('{"jsonrpc":"1.0","id":1,"method":"x"}\n{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}\n');
    await done;
    expect(lines).toEqual([]);
  });
});

describe('spec-guard mcp', () => {
  let root: string;

  beforeAll(async () => {
    root = await makeTempRepo({
      'docs/adr/0001.md': '# ADR-0001: No legacy\n\n<!-- @assert-absence target="src" symbol="Legacy" -->\n',
      'specs/extra.md': '# Extra\n\n<!-- @assert-present file="src/a.ts" -->\n',
      'src/a.ts': 'export const a = 1;\n',
    });
  });

  afterAll(async () => {
    await removeTempRepo(root);
  });

  function io(stdin?: PassThrough) {
    const out: string[] = [];
    const err: string[] = [];
    const cli: CliIO = { stdout: (text) => out.push(text), stderr: (text) => err.push(text), env: { NO_COLOR: '1' }, cwd: root, isTTY: false, ...(stdin ? { stdin } : {}) };
    return { cli, out, err };
  }

  it('serves on stdin and stdout until stdin closes, then exits 0', async () => {
    const stdin = new PassThrough();
    const { cli, out, err } = io(stdin);
    const exit = main(['mcp', '--root', root, '--engine', 'js'], cli);
    stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}\n');
    stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    stdin.end('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"check_architecture"}}\n');

    expect(await exit).toBe(EXIT_OK);
    const responses = out.map((line) => JSON.parse(line) as { id: number; result: Record<string, unknown> });
    expect(responses.map((response) => response.id).sort()).toEqual([1, 2]);
    const initialize = responses.find((response) => response.id === 1);
    expect(initialize?.result['protocolVersion']).toBe('2025-06-18');
    const check = responses.find((response) => response.id === 2)?.result['structuredContent'] as Record<string, unknown>;
    expect(check).toMatchObject({ ok: true, rules: { inForce: 1, checked: 1, passed: 1, failed: 0 } });
    expect(initialize?.result['serverInfo']).toEqual({ name: 'spec-guard', version: version() });
    expect(version()).toMatch(/^\d+\.\d+\.\d+/);
    // stderr is for people, and says what the server is serving.
    expect(err).toEqual([`spec-guard ${version()}: MCP server on stdio, rules from docs/**/*.md under ${root}`]);
  });

  it('takes its specs from --spec, as many as given', async () => {
    const stdin = new PassThrough();
    const { cli, out } = io(stdin);
    const err: string[] = [];
    cli.stderr = (text) => err.push(text);
    const exit = main(['mcp', '--root', root, '--spec', 'docs/**/*.md', '--spec=specs/*.md', '--engine', 'js'], cli);
    stdin.end('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check_architecture"}}\n');
    expect(await exit).toBe(EXIT_OK);
    expect(err).toEqual([`spec-guard ${version()}: MCP server on stdio, rules from docs/**/*.md, specs/*.md under ${root}`]);
    const check = (JSON.parse(out[0] as string) as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent;
    expect(check).toMatchObject({ rules: { inForce: 2, checked: 2 } });
  });

  it('cannot serve without a stdin', async () => {
    const { cli, out, err } = io();
    expect(await main(['mcp', '--root', root], cli)).toBe(EXIT_ERROR);
    expect(out).toEqual([]);
    expect(err).toEqual(['spec-guard: mcp needs a readable stdin.']);
  });
});

describe('spec-guard mcp, with the run flags it passes on', () => {
  let root: string;

  beforeAll(async () => {
    root = await makeTempRepo({
      'docs/a.md': [
        '# A',
        '<!-- @assert-absence target="gone" symbol="Nothing" -->',
        '<!-- @assert-absence target="src" symbol="Vendored" -->',
        '<!-- @assert-absence target="docs" symbol="SpecWord" comments="include" -->',
        '<!-- @assert-import-absence target="src" module="nothing" -->',
        '<!-- @assert-absence target="src" symbol="Hit" -->',
        '',
      ].join('\n'),
      'docs/b.md': '**Status:** draft\n\n<!-- @assert-absence target="src" symbol="Hit" -->\n',
      'docs/notes.txt': 'notes\n',
      'src/node_modules/x.js': 'Vendored\n',
      'src/dyn.ts': 'export const load = (name: string) => import(name);\n',
      'src/hit.ts': 'Hit;\n',
    });
  });

  afterAll(async () => {
    await removeTempRepo(root);
  });

  interface Failure {
    document: string;
    line: number;
    message: string;
    matches: unknown[];
  }

  async function check(flags: string[]): Promise<{ engine: string; failures: Failure[]; inForce: number }> {
    const stdin = new PassThrough();
    const out: string[] = [];
    const cli: CliIO = { stdout: (text) => out.push(text), stderr: () => {}, env: {}, cwd: root, isTTY: false, stdin };
    const exit = main(['mcp', '--root', root, '--spec', 'docs/a.md', '--spec', 'docs/b.md', ...flags], cli);
    stdin.end('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check_architecture"}}\n');
    expect(await exit).toBe(EXIT_OK);
    const structured = (JSON.parse(out[0] as string) as { result: { structuredContent: { engine: string; failures: Failure[]; rules: { inForce: number } } } }).result.structuredContent;
    return { engine: structured.engine, failures: structured.failures, inForce: structured.rules.inForce };
  }

  const failing = (failures: readonly Failure[]): string[] => failures.map((failure) => `${failure.document}:${failure.line}`);

  it('fails the missing target and the forbidden symbol by default', async () => {
    const { failures, inForce, engine } = await check(['--engine', 'js']);
    expect(engine).toBe('javascript');
    expect(inForce).toBe(5);
    expect(failing(failures)).toEqual(['docs/a.md:2', 'docs/a.md:6']);
    expect(failures[0]?.message).toBe('target path does not exist: gone');
    expect(failures[1]?.matches).toHaveLength(1);
  });

  it('passes --allow-missing-targets and --allow-empty-scope on, each doing its own part', async () => {
    const missing = await check(['--engine', 'js', '--allow-missing-targets']);
    expect(missing.failures[0]?.message).toBe('no files were inspected, so this assertion verified nothing (add allow-empty="true" if that is expected)');
    const both = await check(['--engine', 'js', '--allow-missing-targets', '--allow-empty-scope']);
    expect(failing(both.failures)).toEqual(['docs/a.md:6']);
  });

  it('passes --no-default-skips, --include-specs and --strict on', async () => {
    expect(failing((await check(['--engine', 'js', '--no-default-skips'])).failures)).toEqual(['docs/a.md:2', 'docs/a.md:3', 'docs/a.md:6']);
    expect(failing((await check(['--engine', 'js', '--include-specs'])).failures)).toEqual(['docs/a.md:2', 'docs/a.md:4', 'docs/a.md:6']);
    expect(failing((await check(['--engine', 'js', '--strict'])).failures)).toEqual(['docs/a.md:2', 'docs/a.md:5', 'docs/a.md:6']);
  });

  it('passes --ignore-status and --max-snippets on', async () => {
    const all = await check(['--engine', 'js', '--ignore-status']);
    expect(all.inForce).toBe(6);
    expect(failing(all.failures)).toEqual(['docs/a.md:2', 'docs/a.md:6', 'docs/b.md:3']);
    expect((await check(['--engine', 'js', '--max-snippets', '0'])).failures[1]?.matches).toEqual([]);
  });

  it.skipIf(findTestRipgrep() === null)('passes --engine on', async () => {
    const previous = process.env.SPEC_GUARD_RG;
    process.env.SPEC_GUARD_RG = findTestRipgrep() as string;
    try {
      expect((await check(['--engine', 'rg'])).engine).toBe('ripgrep');
    } finally {
      if (previous === undefined) delete process.env.SPEC_GUARD_RG;
      else process.env.SPEC_GUARD_RG = previous;
    }
  });
});
