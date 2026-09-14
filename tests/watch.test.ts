/**
 * The watch scheduler, and `spec-guard --watch` in-process. ADR-0014.
 *
 * The scheduler is timing and terminal handling, and timing is where a test
 * that waits for real clocks lies: it passes on a fast machine and flakes on a
 * loaded one. So its clock, watcher, session and interrupt are all fakes a
 * test drives step by step. What a session answers is held to a fresh run in
 * tests/watch-equivalence.test.ts; here it is scripted.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';

import { defaultIO, main, type CliIO } from '../src/cli.js';
import type { WatchEvent } from '../src/facts.js';
import { watchTree, type TreeListener, type TreeWatcher } from '../src/io.js';
import { formatReport } from '../src/reporter.js';
import type { RunResult } from '../src/runner.js';
import {
  describeWatchError,
  EXIT_INTERRUPTED,
  MAX_WAIT_MS,
  QUIET_MS,
  runWatch,
  systemClock,
  type Clock,
  type Session,
  type SessionRun,
  type WatchOptions,
} from '../src/watch.js';
import { makeTempRepo, removeTempRepo } from './helpers.js';

const temporary: string[] = [];
afterAll(async () => {
  await Promise.all(temporary.splice(0).map(removeTempRepo));
});

/** Lets every settled promise and pending callback run. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
}

function fakeClock(): Clock & { advance(ms: number): Promise<void>; readonly pending: number } {
  let time = Date.UTC(2026, 8, 14, 10, 30, 15);
  let timers: Array<{ at: number; callback: () => void; id: number }> = [];
  let ids = 0;
  return {
    now: () => time,
    setTimeout: (callback, ms) => {
      ids += 1;
      timers.push({ at: time + ms, callback, id: ids });
      return ids;
    },
    clearTimeout: (handle) => {
      timers = timers.filter((timer) => timer.id !== handle);
    },
    get pending(): number {
      return timers.length;
    },
    async advance(ms: number): Promise<void> {
      const until = time + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const due = timers[0];
        if (due === undefined || due.at > until) break;
        timers.shift();
        time = due.at;
        due.callback();
        await settle();
      }
      time = until;
      await settle();
    },
  };
}

function report(options: { passed?: number; failed?: number; specs?: number; specFiles?: string[]; root?: string } = {}): RunResult {
  const passed = options.passed ?? 1;
  const failed = options.failed ?? 0;
  const specs = options.specs ?? 1;
  return {
    ok: failed === 0,
    root: options.root ?? '/repo',
    engine: 'javascript',
    durationMs: 3,
    summary: { specs, total: passed + failed, passed, failed, skipped: 0, inactive: 0 },
    results: [],
    errors: [],
    warnings: [],
    inactiveSpecs: [],
    exclude: [],
    specFiles: options.specFiles ?? Array.from({ length: specs }, (_, index) => `docs/${index}.md`),
  };
}

const run = (result: RunResult, executed = result.summary.total): SessionRun => ({ report: result, executed, maxSnippets: 5 });

interface Harness {
  clock: ReturnType<typeof fakeClock>;
  calls: string[];
  output: string[];
  emit(event: WatchEvent): void;
  fail(error: Error): void;
  interrupt(): void;
  line(): void;
  closed: () => boolean;
  unregistered: () => string[];
  exit: Promise<number>;
  /** Resolves the run the session is waiting on, when it was scripted to wait. */
  release(): void;
}

type Script = SessionRun | Error | 'wait';

function start(script: Script[], overrides: Partial<WatchOptions> = {}, watchThrows?: Error): Harness {
  const clock = fakeClock();
  const calls: string[] = [];
  const output: string[] = [];
  let listener: ((event: WatchEvent) => void) | undefined;
  let onError: ((error: Error) => void) | undefined;
  let interrupt: (() => void) | undefined;
  let line: (() => void) | undefined;
  let closed = false;
  const unregistered: string[] = [];
  let release: () => void = () => {};
  let index = 0;

  const session: Session = {
    async run(): Promise<SessionRun> {
      calls.push('run');
      const next = script[Math.min(index, script.length - 1)] as Script;
      index += 1;
      if (next === 'wait') {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return run(report());
      }
      if (next instanceof Error) throw next;
      return next;
    },
    async observe(events: readonly WatchEvent[]): Promise<number> {
      calls.push(`observe ${events.map((event) => `${event.type} ${event.filename}`).join(', ')}`);
      return events.length;
    },
    forget(): void {
      calls.push('forget');
    },
    facts: 0,
  };

  const exit = runWatch({
    root: '/repo',
    session,
    watch: (given, failed): TreeWatcher => {
      calls.push('watch');
      if (watchThrows) throw watchThrows;
      listener = given;
      onError = failed;
      return {
        close: () => {
          closed = true;
        },
      };
    },
    write: (text) => output.push(text),
    isTTY: false,
    reporter: { color: false, verbose: false, ascii: true },
    onInterrupt: (handler) => {
      interrupt = handler;
      return () => unregistered.push('interrupt');
    },
    onLine: (handler) => {
      line = handler;
      return () => unregistered.push('line');
    },
    clock,
    ...overrides,
  });

  return {
    clock,
    calls,
    output,
    emit: (event) => listener?.(event),
    fail: (error) => onError?.(error),
    interrupt: () => interrupt?.(),
    line: () => line?.(),
    closed: () => closed,
    unregistered: () => unregistered,
    exit,
    release: () => release(),
  };
}

const heading = (clock: Clock): string => `--- ${new Date(clock.now()).toTimeString().slice(0, 8)} ---\n`;
const REPORTER = { color: false, verbose: false, ascii: true };
const status = (parts: string[]): string => `${parts.join(' · ')} · Enter re-runs everything, Ctrl+C stops\n`;

describe('runWatch', () => {
  it('starts watching before the first run, then prints its report under the time and a status line', async () => {
    const first = report({ passed: 2, specs: 1 });
    const watch = start([run(first)]);
    await settle();
    expect(watch.calls).toEqual(['watch', 'run']);
    expect(watch.output).toEqual([
      `${heading(watch.clock)}${formatReport(first, REPORTER, 5)}\n\n${status(['watching 1 spec', 'first run', '2 of 2 rules executed', '0 ms'])}`,
    ]);
    watch.interrupt();
    expect(await watch.exit).toBe(EXIT_INTERRUPTED);
  });

  it('clears the screen instead of heading the report on a terminal, and uses the session\'s snippet count', async () => {
    const failing = { ...report({ passed: 0, failed: 1 }), results: [] };
    const watch = start([{ report: failing, executed: 1, maxSnippets: 2 }], { isTTY: true });
    await settle();
    expect(watch.output).toEqual([`\x1b[2J\x1b[3J\x1b[H${formatReport(failing, REPORTER, 2)}\n\n${status(['watching 1 spec', 'first run', '1 of 1 rule executed', '0 ms'])}`]);
    watch.interrupt();
    await watch.exit;
  });

  it('waits for quiet before a batch, and hands the session every event of it at once', async () => {
    const watch = start([run(report()), run(report({ passed: 3 }), 1)]);
    await settle();
    watch.emit({ type: 'change', filename: 'src/a.ts' });
    await watch.clock.advance(QUIET_MS - 10);
    watch.emit({ type: 'rename', filename: 'src/b.ts' });
    await watch.clock.advance(QUIET_MS - 1);
    expect(watch.calls).toEqual(['watch', 'run']);
    await watch.clock.advance(1);
    expect(watch.calls).toEqual(['watch', 'run', 'observe change src/a.ts, rename src/b.ts', 'run']);
    expect(watch.output[1]).toContain(status(['watching 1 spec', '2 changes', '1 of 3 rules re-executed', '0 ms']));
    watch.interrupt();
    await watch.exit;
  });

  it('runs a batch at most a set time after its first event, however noisy the tree stays', async () => {
    const watch = start([run(report())]);
    await settle();
    // An event every 40 ms never leaves 50 ms of quiet, so only the cap can start a batch.
    const gap = QUIET_MS - 10;
    const runs = (): number => watch.calls.filter((call) => call === 'run').length;
    let elapsed = 0;
    for (; runs() === 1 && elapsed < MAX_WAIT_MS * 3; elapsed += gap) {
      watch.emit({ type: 'change', filename: `f${elapsed}` });
      await watch.clock.advance(gap);
    }
    expect(runs()).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(MAX_WAIT_MS);
    expect(elapsed).toBeLessThanOrEqual(MAX_WAIT_MS + gap);
    watch.interrupt();
    await watch.exit;
  });

  it('starts nothing during the first run, then takes up what was queued during it', async () => {
    const watch = start(['wait', run(report({ passed: 2 }))]);
    await settle();
    watch.emit({ type: 'change', filename: 'early' });
    await watch.clock.advance(MAX_WAIT_MS * 2);
    expect(watch.calls).toEqual(['watch', 'run']);
    watch.release();
    await settle();
    await watch.clock.advance(QUIET_MS);
    expect(watch.calls).toEqual(['watch', 'run', 'observe change early', 'run']);
    watch.interrupt();
    await watch.exit;
  });

  it('takes up an Enter pressed during the first run once it is done', async () => {
    const watch = start(['wait', run(report({ passed: 2 }))]);
    await settle();
    watch.line();
    await watch.clock.advance(MAX_WAIT_MS);
    expect(watch.calls).toEqual(['watch', 'run']);
    watch.release();
    await settle();
    await watch.clock.advance(0);
    expect(watch.calls).toEqual(['watch', 'run', 'forget', 'run']);
    watch.interrupt();
    await watch.exit;
  });

  it('prints nothing for a batch that was stopped while it ran, whether it succeeded or failed', async () => {
    for (const outcome of [run(report({ passed: 7 })), new Error('broken')]) {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      const watch = start([run(report())], {
        session: {
          run: async () => {
            calls += 1;
            if (calls === 1) return run(report());
            await gate;
            if (outcome instanceof Error) throw outcome;
            return outcome;
          },
          observe: async () => 0,
          forget: () => {},
          facts: 0,
        },
      });
      await settle();
      watch.emit({ type: 'change', filename: 'a' });
      await watch.clock.advance(QUIET_MS);
      watch.interrupt();
      release();
      await settle();
      expect(await watch.exit).toBe(130);
      expect(watch.output).toHaveLength(1);
    }
  });

  it('works without Enter, when there is no stdin to read it from', async () => {
    const watch = start([run(report())], { onLine: undefined });
    await settle();
    watch.interrupt();
    expect(await watch.exit).toBe(130);
    expect(watch.unregistered()).toEqual(['interrupt']);
  });

  it('says nothing about a watch that fails after the session stopped', async () => {
    const watch = start([run(report())]);
    await settle();
    watch.interrupt();
    watch.fail(new Error('late'));
    expect(await watch.exit).toBe(130);
    expect(watch.output).toHaveLength(1);
  });

  it('clears a batch that was waiting to start when the session stops', async () => {
    const watch = start([run(report())]);
    await settle();
    watch.emit({ type: 'change', filename: 'a' });
    expect(watch.clock.pending).toBe(1);
    watch.interrupt();
    expect(watch.clock.pending).toBe(0);
    expect(await watch.exit).toBe(130);
  });

  it('stops without printing when interrupted during a first run that then fails', async () => {
    let fail: (error: Error) => void = () => {};
    const watch = start([run(report())], {
      session: {
        run: () =>
          new Promise<SessionRun>((_resolve, reject) => {
            fail = reject;
          }),
        observe: async () => 0,
        forget: () => {},
        facts: 0,
      },
    });
    await settle();
    watch.interrupt();
    fail(new Error('too late to matter'));
    expect(await watch.exit).toBe(130);
    expect(watch.output).toEqual([]);
  });

  it('counts a path named twice in a batch as one change', async () => {
    const watch = start([run(report()), run(report({ passed: 2 }))]);
    await settle();
    watch.emit({ type: 'change', filename: 'a' });
    watch.emit({ type: 'change', filename: 'a' });
    watch.emit({ type: 'rename', filename: 'a' });
    await watch.clock.advance(QUIET_MS);
    expect(watch.output[1]).toContain('· 1 change ·');
    watch.interrupt();
    await watch.exit;
  });

  it('never runs two batches at once: events during a batch wait for it', async () => {
    const watch = start([run(report()), 'wait', run(report({ passed: 5 }))]);
    await settle();
    watch.emit({ type: 'change', filename: 'a' });
    await watch.clock.advance(QUIET_MS);
    expect(watch.calls).toEqual(['watch', 'run', 'observe change a', 'run']);

    watch.emit({ type: 'change', filename: 'b' });
    await watch.clock.advance(MAX_WAIT_MS * 2);
    expect(watch.calls).toEqual(['watch', 'run', 'observe change a', 'run']);

    watch.release();
    await settle();
    await watch.clock.advance(QUIET_MS);
    expect(watch.calls).toEqual(['watch', 'run', 'observe change a', 'run', 'observe change b', 'run']);
    watch.interrupt();
    await watch.exit;
  });

  it('rewrites only the status line when a batch reports what the last one did', async () => {
    const same = report({ passed: 2 });
    const watch = start([run(same), run({ ...same, durationMs: 99 }, 0)], { isTTY: true });
    await settle();
    watch.emit({ type: 'change', filename: 'notes.txt' });
    await watch.clock.advance(QUIET_MS);
    expect(watch.output[1]).toBe(`\x1b[1A\x1b[2K${status(['watching 1 spec', '1 change', '0 of 2 rules re-executed', '0 ms'])}`);
    watch.interrupt();
    await watch.exit;
  });

  it('appends a status line, without escape codes, when stdout is not a terminal', async () => {
    const same = report();
    const watch = start([run(same), run(same, 0)]);
    await settle();
    watch.emit({ type: 'change', filename: 'x' });
    await watch.clock.advance(QUIET_MS);
    expect(watch.output[1]).toBe(status(['watching 1 spec', '1 change', '0 of 1 rule re-executed', '0 ms']));
    watch.interrupt();
    await watch.exit;
  });

  it('forgets everything and runs every rule on Enter', async () => {
    const watch = start([run(report()), run(report({ passed: 4 }))]);
    await settle();
    watch.line();
    await watch.clock.advance(0);
    expect(watch.calls).toEqual(['watch', 'run', 'forget', 'run']);
    expect(watch.output[1]).toContain(status(['watching 1 spec', 'every rule, on request', '4 of 4 rules re-executed', '0 ms']));
    watch.interrupt();
    await watch.exit;
  });

  it('stops on interrupt: exit 130, the watcher closed, every handler unregistered, and nothing after', async () => {
    const watch = start([run(report())]);
    await settle();
    watch.interrupt();
    expect(await watch.exit).toBe(130);
    expect(watch.closed()).toBe(true);
    watch.emit({ type: 'change', filename: 'late' });
    watch.line();
    watch.interrupt();
    await watch.clock.advance(MAX_WAIT_MS);
    expect(watch.calls).toEqual(['watch', 'run']);
    expect(watch.clock.pending).toBe(0);
    // Stopped once, however often it was asked to stop.
    expect(watch.unregistered()).toEqual(['interrupt', 'line']);
  });

  it('stops without printing when interrupted during a run', async () => {
    const watch = start(['wait']);
    await settle();
    watch.interrupt();
    watch.release();
    expect(await watch.exit).toBe(130);
    expect(watch.output).toEqual([]);
  });

  it('exits 2 when the root cannot be watched, and says what to do about a full watch table', async () => {
    const full = Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), { code: 'ENOSPC' });
    const watch = start([run(report())], {}, full);
    expect(await watch.exit).toBe(2);
    expect(watch.calls).toEqual(['watch']);
    expect(watch.output).toEqual([
      "spec-guard: cannot watch /repo: ENOSPC: System limit for number of file watchers reached (the system's limit on watched directories was reached; raise fs.inotify.max_user_watches)\n",
    ]);
    expect(watch.unregistered()).toEqual(['interrupt', 'line']);
    expect(describeWatchError(new Error('EPERM: nope'))).toBe('EPERM: nope');
  });

  it('exits 2 when the watch fails later, as when the root is deleted', async () => {
    const watch = start([run(report())]);
    await settle();
    watch.fail(new Error('EPERM: operation not permitted'));
    expect(await watch.exit).toBe(2);
    expect(watch.output.at(-1)).toBe('spec-guard: the watch on /repo failed: EPERM: operation not permitted\n');
    expect(watch.closed()).toBe(true);
  });

  it('exits 2 when the first run cannot be made, as for a broken package.json', async () => {
    const watch = start([new Error('package.json: "specGuard.strict" must be true or false, got "yes".')]);
    expect(await watch.exit).toBe(2);
    expect(watch.output).toEqual(['spec-guard: package.json: "specGuard.strict" must be true or false, got "yes".\n']);
    expect(watch.closed()).toBe(true);
  });

  it('refuses specs outside the root it watches, naming them', async () => {
    // A spec outside the root keeps its absolute path in a report, spelled with
    // forward slashes on every platform.
    const absolute = path.resolve('/elsewhere/x.md').split(path.sep).join('/');
    const outside = report({ specs: 3, specFiles: ['docs/in.md', '../shared/adr.md', absolute] });
    const watch = start([run(outside)]);
    expect(await watch.exit).toBe(2);
    const named = outside.specFiles.slice(1).join(', ');
    expect(watch.output).toEqual([`spec-guard: --watch watches /repo, and these specs are outside it: ${named}\n`]);
    const one = start([run(report({ specFiles: ['..'] }))]);
    expect(await one.exit).toBe(2);
    expect(one.output).toEqual(['spec-guard: --watch watches /repo, and this spec is outside it: ..\n']);
  });

  it('refuses specs outside the root on a later run too, and keeps watching', async () => {
    const watch = start([run(report()), run(report({ specFiles: ['../elsewhere.md'] })), run(report())]);
    await settle();
    watch.emit({ type: 'change', filename: 'package.json' });
    await watch.clock.advance(QUIET_MS);
    expect(watch.output[1]).toBe(`${heading(watch.clock)}spec-guard: --watch watches /repo, and this spec is outside it: ../elsewhere.md\n\nwatching · waiting for a change · Ctrl+C stops\n`);
    watch.emit({ type: 'change', filename: 'package.json' });
    await watch.clock.advance(QUIET_MS);
    expect(watch.output[2]).toContain('· 1 change ·');
    watch.interrupt();
    expect(await watch.exit).toBe(130);
  });

  it('shows a later failure in place of the report, keeps watching, and recovers', async () => {
    const watch = start([run(report()), new Error('package.json is not valid JSON (x), so its "specGuard" options cannot be read.'), run(report())]);
    await settle();
    watch.emit({ type: 'change', filename: 'package.json' });
    await watch.clock.advance(QUIET_MS);
    expect(watch.output[1]).toBe(`${heading(watch.clock)}spec-guard: package.json is not valid JSON (x), so its "specGuard" options cannot be read.\n\nwatching · waiting for a change · Ctrl+C stops\n`);
    watch.emit({ type: 'change', filename: 'package.json' });
    await watch.clock.advance(QUIET_MS);
    // The same report as before the failure is drawn again in full, since the
    // failure replaced it on screen.
    expect(watch.output[2]).toContain(formatReport(report(), REPORTER, 5));
    watch.interrupt();
    expect(await watch.exit).toBe(130);
  });

  it('says it is waiting for a spec when none matched, rather than exiting', async () => {
    const watch = start([run(report({ specs: 0, passed: 0 }))]);
    await settle();
    expect(watch.output[0]).toContain('spec-guard: no spec files matched, watching for one to appear\n\nwatching 0 specs · first run');
    watch.interrupt();
    expect(await watch.exit).toBe(130);
  });
});

/* ------------------------------------------------- spec-guard --watch itself */

describe('spec-guard --watch', () => {
  /** A CLI whose watcher, interrupt and stdin a test drives. */
  function cli(root: string): { io: CliIO; output: string[]; emit: TreeListener; interrupt: () => void; stdin: PassThrough; watched: () => string | null } {
    const output: string[] = [];
    let listener: TreeListener = () => {};
    let interrupt = (): void => {};
    let watched: string | null = null;
    const stdin = new PassThrough();
    const io: CliIO = {
      stdout: (text) => output.push(`${text}\n`),
      stderr: (text) => output.push(`stderr: ${text}\n`),
      env: { NO_COLOR: '1' },
      cwd: root,
      isTTY: false,
      stdin,
      watch: (target, given) => {
        watched = target;
        listener = given;
        return { close: () => {} };
      },
      onInterrupt: (handler) => {
        interrupt = handler;
        return () => {};
      },
    };
    return { io, output, emit: (type, filename) => listener(type, filename), interrupt: () => interrupt(), stdin, watched: () => watched };
  }

  async function until(output: string[], text: string, count = 1): Promise<void> {
    for (let waited = 0; output.join('').split(text).length - 1 < count; waited++) {
      if (waited > 4000) throw new Error(`never printed ${JSON.stringify(text)}:\n${output.join('')}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it('reports, re-runs what a change affects, re-runs everything on Enter, and exits 130', async () => {
    const root = await makeTempRepo({
      'package.json': JSON.stringify({ specGuard: { specs: ['rules/*.md'], strict: false } }),
      'rules/a.md': '# A\n\n<!-- @assert-absence target="src" symbol="Legacy" -->\n<!-- @assert-present file="README.md" -->\n',
      'src/a.ts': 'export const a = 1;\n',
      'README.md': '',
    });
    temporary.push(root);
    const { io, output, emit, interrupt, stdin, watched } = cli(root);
    const exit = main(['--watch', '--root', root], io);

    await until(output, 'first run');
    expect(watched()).toBe(root);
    expect(output.join('')).toContain('2 passed');
    expect(output.join('')).toContain('options from package.json: specs, strict');
    expect(output.join('')).toContain('watching 1 spec · first run · 2 of 2 rules executed');

    await fs.writeFile(path.join(root, 'src/a.ts'), 'export const a = Legacy;\n');
    emit('change', path.join('src', 'a.ts'));
    await until(output, 're-executed');
    expect(output.join('')).toContain('1 passed · 1 failed');
    expect(output.join('')).toContain('1 change · 1 of 2 rules re-executed');

    stdin.write('\n');
    await until(output, 'every rule, on request');
    expect(output.join('')).toContain('every rule, on request · 2 of 2 rules re-executed');

    interrupt();
    expect(await exit).toBe(130);
    expect(stdin.isPaused()).toBe(true);
  });

  it('reads .spec-guard.json again for each run, so an edit to its exclusions re-runs what they cover', async () => {
    const root = await makeTempRepo({
      '.spec-guard.json': JSON.stringify({ specs: ['rules/*.md'], exclude: ['target'] }),
      'rules/a.md': '# A\n\n<!-- @assert-absence symbol="Legacy" -->\n',
      'target/gen.ts': 'export const a = Legacy;\n',
    });
    temporary.push(root);
    const { io, output, emit, interrupt } = cli(root);
    const exit = main(['--watch', '--root', root], io);

    await until(output, 'first run');
    expect(output.join('')).toContain('1 passed');
    expect(output.join('')).toContain('options from .spec-guard.json: specs, exclude');

    await fs.writeFile(path.join(root, '.spec-guard.json'), JSON.stringify({ specs: ['rules/*.md'] }));
    emit('change', '.spec-guard.json');
    await until(output, 're-executed');
    expect(output.join('')).toContain('0 passed · 1 failed');
    expect(output.join('')).toContain('options from .spec-guard.json: specs\n');

    interrupt();
    expect(await exit).toBe(130);
  });

  it('refuses a broken package.json before it starts watching', async () => {
    const root = await makeTempRepo({ 'package.json': '{"specGuard": {"watch": true}}' });
    temporary.push(root);
    const { io, output, watched } = cli(root);
    expect(await main(['--watch', '--root', root], io)).toBe(2);
    expect(watched()).toBeNull();
    expect(output).toEqual(['stderr: spec-guard: package.json: "specGuard.watch" is chosen on the command line, not in package.json.\n']);
  });
});

describe('spec-guard --watch, as the command line wires it', () => {
  async function project(files: Record<string, string>): Promise<string> {
    const root = await makeTempRepo(files);
    temporary.push(root);
    return root;
  }

  /** Waits until a condition holds, briefly, for work that runs on real timers. */
  async function until(what: string, condition: () => boolean): Promise<void> {
    for (let waited = 0; !condition(); waited++) {
      if (waited > 4000) throw new Error(`never: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  function driven(root: string, overrides: Partial<CliIO> = {}): { io: CliIO; lines: string[]; stop: () => void; emit: TreeListener } {
    const lines: string[] = [];
    let interrupt = (): void => {};
    let listener: TreeListener = () => {};
    const io: CliIO = {
      stdout: (text) => lines.push(text),
      stderr: (text) => lines.push(`stderr: ${text}`),
      env: { NO_COLOR: '1' },
      cwd: root,
      isTTY: false,
      watch: (_root, given) => {
        listener = given;
        return { close: () => {} };
      },
      onInterrupt: (handler) => {
        interrupt = handler;
        return () => {};
      },
      ...overrides,
    };
    return { io, lines, stop: () => interrupt(), emit: (type, filename) => listener(type, filename) };
  }

  it('takes its specs from the command line, and writes each report as one piece of stdout', async () => {
    const root = await project({ 'rules/a.md': '# A\n\n<!-- @assert-present file="README.md" -->\n', 'README.md': '' });
    const { io, lines, stop } = driven(root);
    const exit = main(['--watch', '--root', root, 'rules/a.md'], io);
    await until('the first report', () => lines.length > 0);
    stop();
    expect(await exit).toBe(130);

    // Written through stdout, which adds a newline, so the one the session ends
    // each report with is taken off first - and only that one.
    const [first] = lines as [string];
    expect(first.split('\n')[0]).toMatch(/^--- \d\d:\d\d:\d\d ---$/);
    expect(first.split('\n')[1]).toBe('spec-guard 1 spec · 1 assertion');
    expect(first.endsWith('watching 1 spec · first run · 1 of 1 rule executed · ')).toBe(false);
    expect(first).toMatch(/· Enter re-runs everything, Ctrl\+C stops$/);
  });

  it('redraws in colour on a terminal', async () => {
    const root = await project({ 'docs/a.md': '<!-- @assert-present file="README.md" -->\n', 'README.md': '' });
    const written: string[] = [];
    const { io, stop } = driven(root, { isTTY: true, env: {}, write: (text) => written.push(text) });
    const exit = main(['--watch', '--root', root], io);
    await until('the first report', () => written.length > 0);
    stop();
    expect(await exit).toBe(130);
    expect(written[0]?.startsWith('\x1b[2J\x1b[3J\x1b[H')).toBe(true);
    expect(written[0]).toContain('\x1b[32m');
  });

  it('lists passing rules with --verbose', async () => {
    const root = await project({ 'docs/a.md': '<!-- @assert-present file="README.md" -->\n', 'README.md': '' });
    const { io, lines, stop } = driven(root);
    const exit = main(['--watch', '--root', root, '--verbose'], io);
    await until('the first report', () => lines.length > 0);
    stop();
    await exit;
    expect(lines[0]).toContain('docs/a.md:1  @assert-present README.md');
  });

  it('runs without an interrupt to register, and still stops when its watch fails', async () => {
    const root = await project({ 'docs/a.md': '<!-- @assert-present file="README.md" -->\n', 'README.md': '' });
    const lines: string[] = [];
    let fail: (error: Error) => void = () => {};
    const io: CliIO = {
      stdout: (text) => lines.push(text),
      stderr: (text) => lines.push(text),
      env: { NO_COLOR: '1' },
      cwd: root,
      isTTY: false,
      watch: (_root, _listener, onError) => {
        fail = onError;
        return { close: () => {} };
      },
    };
    const exit = main(['--watch', '--root', root], io);
    await until('the first report', () => lines.length > 0);
    expect(() => fail(new Error('the root is gone'))).not.toThrow();
    expect(await exit).toBe(2);
    expect(lines.at(-1)).toBe(`spec-guard: the watch on ${root} failed: the root is gone`);
  });

  it('runs without a stdin, with no Enter to hear', async () => {
    const root = await project({ 'docs/a.md': '<!-- @assert-present file="README.md" -->\n', 'README.md': '' });
    const { io, lines, stop } = driven(root);
    const exit = main(['--watch', '--root', root], io);
    await until('the first report', () => lines.length > 0);
    stop();
    expect(await exit).toBe(130);
  });

  it('re-runs everything on a line from stdin, not on any input, and lets go of stdin when stopped', async () => {
    const root = await project({ 'docs/a.md': '<!-- @assert-present file="README.md" -->\n', 'README.md': '' });
    const stdin = new PassThrough();
    const { io, lines, stop } = driven(root, { stdin });
    const exit = main(['--watch', '--root', root], io);
    await until('the first report', () => lines.length > 0);

    stdin.write('half a line');
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS * 3));
    expect(lines).toHaveLength(1);
    stdin.write(' and the rest\n');
    await until('a run on request', () => lines.some((line) => line.includes('every rule, on request')));

    stop();
    expect(await exit).toBe(130);
    expect(stdin.listenerCount('data')).toBe(0);
    expect(stdin.isPaused()).toBe(true);
  });
});

describe('defaultIO', () => {
  it('writes to stdout as it is, watches with watchTree, and turns SIGINT and SIGTERM into one handler until told not to', () => {
    const io = defaultIO();
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      io.write?.('no newline added');
    } finally {
      process.stdout.write = original;
    }
    expect(written).toEqual(['no newline added']);
    expect(io.watch).toBe(watchTree);

    const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };
    let heard = 0;
    const unregister = (io.onInterrupt as NonNullable<CliIO['onInterrupt']>)(() => {
      heard += 1;
    });
    expect({ int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') }).toEqual({ int: before.int + 1, term: before.term + 1 });
    process.emit('SIGINT', 'SIGINT');
    process.emit('SIGTERM', 'SIGTERM');
    expect(heard).toBe(2);
    unregister();
    expect({ int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') }).toEqual(before);
  });
});

describe('systemClock', () => {
  it('reads the time, sets a timer, and clears one before it fires', async () => {
    const before = Date.now();
    expect(systemClock.now()).toBeGreaterThanOrEqual(before);
    let fired = 0;
    systemClock.clearTimeout(systemClock.setTimeout(() => (fired += 10), 5));
    systemClock.setTimeout(() => (fired += 1), 5);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fired).toBe(1);
  });
});
