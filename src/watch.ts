/**
 * `spec-guard --watch`: the same report, again, whenever the tree changes.
 * ADR-0014.
 *
 * Two parts. A session answers "what does a run say now" and re-executes a
 * rule only when its resolved form or something it read has changed; what may
 * be reused, and why, is in facts.ts and memo.ts. The scheduler around it turns
 * a watcher's events into batches, never runs two at once, redraws the terminal,
 * and stops on Ctrl+C.
 *
 * The session is held to a fresh run of the same tree by
 * tests/watch-equivalence.test.ts, and nothing here is trusted beyond that.
 */

import path from 'node:path';

import { createCachedEngine, createJavaScriptEngine } from './engine.js';
import { createFactCache, type FactKey, type FactPolicy, type WatchEvent } from './facts.js';
import { createImportIndex } from './imports.js';
import { nodeIo, type Io, type TreeWatcher } from './io.js';
import { createMemo, type Memo, type SessionMemo } from './memo.js';
import { formatReport, type ReporterOptions } from './reporter.js';
import {
  createScopeProbe,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_SNIPPETS,
  executeAssertion,
  planRun,
  reportRun,
  type ExecuteOptions,
  type RunOptions,
  type RunResult,
} from './runner.js';
import { readSpecs } from './specs.js';
import { createTreeIndex } from './structure.js';
import type { Assertion, AssertionResult, ConfigUse } from './types.js';

/* ------------------------------------------------------------------ session */

/** The options a session's run takes: a run's, less the engine it never uses. */
export type SessionRunOptions = Pick<
  RunOptions,
  'allowMissingTargets' | 'strictTargets' | 'allowEmptyScope' | 'maxSnippets' | 'includeSpecs' | 'defaultSkips' | 'ignoreStatus' | 'concurrency'
>;

/** What one run of a session is asked to do. */
export interface SessionSettings {
  patterns: readonly string[];
  run: SessionRunOptions;
  /** What those settings took from the project's configuration, for the report. */
  config?: ConfigUse;
}

export interface SessionOptions {
  root: string;
  /** The filesystem underneath the session's cache. */
  io?: Io;
  /**
   * Decides a run's settings, reading whatever it needs through the door it is
   * handed - so an edit to `package.json` reaches the session as a changed fact
   * like any other. Throws to fail the run with its message.
   */
  settings: (io: Io) => Promise<SessionSettings>;
  /*
   * The rest exist for one reason: so tests/watch-equivalence.test.ts can build
   * a session with one deliberate defect and watch the test fail. Each defaults
   * to the only implementation spec-guard uses.
   */
  /** What an event evicts and what counts as a change. */
  policy?: FactPolicy;
  /** Where pure work is remembered. */
  memo?: SessionMemo;
  /** What decides whether a rule's last result can be reused. */
  identify?: (assertion: Assertion, run: SessionRunOptions) => string;
  /** The per-run caches a rule executes with. */
  caches?: (root: string, door: Io, memo: Memo) => RuleCaches;
}

/** The caches one execution of one rule reads through. */
export type RuleCaches = Pick<ExecuteOptions, 'engine' | 'imports' | 'hasFiles' | 'tree'>;

/**
 * A rule's own caches, over its own door.
 *
 * Never shared between rules. Each is keyed by path, which makes it a fact
 * under another name: a second rule served from the first one's walk would skip
 * the reads, and with them the record of what it depends on.
 */
export function ruleCaches(root: string, door: Io, memo: Memo): RuleCaches {
  const scanner = createJavaScriptEngine(door, memo);
  return {
    engine: createCachedEngine(scanner, scanner),
    imports: createImportIndex(door, memo),
    hasFiles: createScopeProbe(door),
    tree: createTreeIndex(root, door),
  };
}

export interface SessionRun {
  report: RunResult;
  /** How many snippets a failure shows, as the run was configured. */
  maxSnippets: number;
  /** Rules executed by this run rather than carried over from the last. */
  executed: number;
}

export interface Session {
  /** What a run says now. */
  run(): Promise<SessionRun>;
  /** Evicts what the events may have changed, and reads it again. Returns how many facts changed. */
  observe(events: readonly WatchEvent[]): Promise<number>;
  /** Forgets every fact, so the next run executes every rule. */
  forget(): void;
  /** Facts held, for the numbers ADR-0014 reports. */
  readonly facts: number;
}

/** A rule's last execution, and every fact it read. */
interface Executed {
  result: AssertionResult;
  reads: Set<FactKey>;
}

/**
 * What decides a rule's result besides the tree: its resolved form, and the run
 * options its execution reads. Two rules with equal identities executed over the
 * same facts give the same result, which is the whole of what reuse relies on.
 *
 * Only the options execution reads. The ones resolution reads - which specs are
 * excluded, which directories skipped - are already in the resolved form, as the
 * spec files it leaves out and the scope it walks, and are held there, where a
 * rule is changed by them, rather than beside it.
 */
export function identity(assertion: Assertion, run: SessionRunOptions): string {
  const { allowMissingTargets, strictTargets, allowEmptyScope, maxSnippets } = run;
  return JSON.stringify([assertion, allowMissingTargets, strictTargets, allowEmptyScope, maxSnippets], (_key, value: unknown) =>
    value instanceof Set ? [...(value as Set<string>)] : value instanceof Map ? [...(value as Map<string, unknown>)] : value,
  );
}

export function createSession(options: SessionOptions): Session {
  const root = path.resolve(options.root);
  const facts = createFactCache(root, options.io ?? nodeIo, options.policy);
  const memo = options.memo ?? createMemo();
  const identify = options.identify ?? identity;
  const cachesFor = options.caches ?? ruleCaches;
  let executed = new Map<string, Executed>();
  /** Facts the settings and the specs were read from. */
  let planned = new Set<FactKey>();
  /** Facts whose value changed since the last run. */
  let changed = new Set<FactKey>();

  const used = (key: FactKey): boolean => planned.has(key) || [...executed.values()].some((entry) => entry.reads.has(key));

  async function execute(assertion: Assertion, run: SessionRunOptions): Promise<Executed> {
    const reads = new Set<FactKey>();
    const door = facts.view(reads);
    const result = await executeAssertion(assertion, {
      ...cachesFor(root, door, memo),
      root,
      io: door,
      allowMissingTargets: run.allowMissingTargets ?? false,
      strictTargets: run.strictTargets ?? false,
      allowEmptyScope: run.allowEmptyScope ?? false,
      maxSnippets: run.maxSnippets ?? DEFAULT_MAX_SNIPPETS,
    });
    return { result, reads };
  }

  return {
    get facts(): number {
      return facts.size;
    },

    async run(): Promise<SessionRun> {
      const startedAt = performance.now();
      const reads = new Set<FactKey>();
      const door = facts.view(reads);
      const settings = await options.settings(door);
      const plan = planRun(await readSpecs(settings.patterns, root, door, memo), root, settings.run);
      planned = reads;

      const before = executed;
      const dirty = changed;
      changed = new Set();
      const next = new Map<string, Executed>();
      const results: AssertionResult[] = [];
      let count = 0;

      const identities = plan.assertions.map((assertion) => identify(assertion, settings.run));
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < plan.assertions.length) {
          const index = cursor++;
          const key = identities[index] as string;
          const last = before.get(key);
          let entry: Executed;
          if (last !== undefined && ![...last.reads].some((read) => dirty.has(read))) {
            entry = last;
          } else {
            entry = await execute(plan.assertions[index] as Assertion, settings.run);
            count += 1;
          }
          next.set(key, entry);
          results[index] = entry.result;
        }
      };
      const workers = Math.max(1, Math.min(settings.run.concurrency ?? DEFAULT_CONCURRENCY, plan.assertions.length));
      await Promise.all(Array.from({ length: workers }, worker));

      executed = next;
      memo.sweep();
      const report = reportRun(plan, results, { name: 'javascript', fallbacks: [] }, startedAt);
      return {
        report: { ...report, config: settings.config },
        maxSnippets: settings.run.maxSnippets ?? DEFAULT_MAX_SNIPPETS,
        executed: count,
      };
    },

    async observe(events: readonly WatchEvent[]): Promise<number> {
      const found = await facts.refresh(facts.evict(events), used);
      for (const key of found) changed.add(key);
      return found.size;
    },

    forget(): void {
      facts.evictAll();
      executed = new Map();
      changed = new Set();
    },
  };
}

/* ---------------------------------------------------------------- scheduler */

/** How long a batch waits for quiet after its last event. */
export const QUIET_MS = 50;
/** How long a batch waits after its first event, however noisy the tree stays. */
export const MAX_WAIT_MS = 500;
/** The exit code of an interrupted command, as a shell reports one: 128 + SIGINT. */
export const EXIT_INTERRUPTED = 130;

/** Timers, injectable so a test can run the scheduler without waiting. */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface WatchOptions {
  root: string;
  session: Session;
  /** Starts watching the root; may throw. */
  watch: (listener: (event: WatchEvent) => void, onError: (error: Error) => void) => TreeWatcher;
  /** Writes text as it is, with no newline added. */
  write: (text: string) => void;
  /** Clear the screen and redraw, rather than append. */
  isTTY: boolean;
  reporter: ReporterOptions;
  /** Registers the handler for Ctrl+C and SIGTERM, and returns how to unregister it. */
  onInterrupt: (handler: () => void) => () => void;
  /** Registers the handler for a line on stdin, and returns how to unregister it. */
  onLine?: (handler: () => void) => () => void;
  clock?: Clock;
}

const CLEAR_SCREEN = '\x1b[2J\x1b[3J\x1b[H';
/** Up one line, and clear it: the status line a quiet batch rewrites. */
const REWRITE_LINE = '\x1b[1A\x1b[2K';

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A report stripped of how long things took, to tell a new report from the last. */
function signature(report: RunResult): string {
  return JSON.stringify(report, (key, value: unknown) => (key === 'durationMs' ? undefined : value));
}

/** Why a first run cannot become a session, or null when it can. */
function outsideRoot(report: RunResult): string | null {
  const outside = report.specFiles.filter((file) => path.isAbsolute(file) || file === '..' || file.startsWith('../'));
  return outside.length === 0
    ? null
    : `--watch watches ${report.root}, and ${outside.length === 1 ? 'this spec is' : 'these specs are'} outside it: ${outside.join(', ')}`;
}

/**
 * Runs a session until it is interrupted, and resolves to the exit code.
 *
 * 130 when stopped, since a session is neither a pass nor a failure. 2 when it
 * cannot start or its watcher fails, including when the root disappears.
 */
export async function runWatch(options: WatchOptions): Promise<number> {
  const clock = options.clock ?? systemClock;
  const { session, write } = options;
  let finish: (code: number) => void = () => {};
  const finished = new Promise<number>((resolve) => {
    finish = resolve;
  });

  let stopped = false;
  // From the start: the first run begins before anything can be queued, and a
  // batch must not begin beside it.
  let running = true;
  let everything = false;
  const pending: WatchEvent[] = [];
  let firstQueuedAt = 0;
  let timer: unknown;
  let lastSignature: string | null = null;

  const status = (run: SessionRun, changes: string, startedAt: number): string =>
    [
      `watching ${plural(run.report.summary.specs, 'spec', 'specs')}`,
      changes,
      `${run.executed} of ${plural(run.report.summary.total, 'rule', 'rules')} ${changes === 'first run' ? 'executed' : 're-executed'}`,
      `${Math.round(clock.now() - startedAt)} ms`,
      'Enter re-runs everything, Ctrl+C stops',
    ].join(' · ');

  const heading = (): string => (options.isTTY ? CLEAR_SCREEN : `--- ${new Date(clock.now()).toTimeString().slice(0, 8)} ---\n`);

  const render = (run: SessionRun, line: string): void => {
    const current = signature(run.report);
    if (current === lastSignature) {
      write(`${options.isTTY ? REWRITE_LINE : ''}${line}\n`);
      return;
    }
    lastSignature = current;
    const body =
      run.report.summary.specs === 0
        ? 'spec-guard: no spec files matched, watching for one to appear'
        : formatReport(run.report, options.reporter, run.maxSnippets);
    write(`${heading()}${body}\n\n${line}\n`);
  };

  const stop = (code: number): void => {
    if (stopped) return;
    stopped = true;
    clock.clearTimeout(timer);
    watcher?.close();
    unregisterInterrupt();
    unregisterLine?.();
    finish(code);
  };

  // Reached only from the timer `schedule` sets, which it sets only while nothing
  // runs and the session has not stopped, and which stopping clears.
  const batch = async (): Promise<void> => {
    running = true;
    const events = pending.splice(0);
    const rerunAll = everything;
    everything = false;
    const startedAt = clock.now();
    try {
      if (rerunAll) session.forget();
      else await session.observe(events);
      const run = await session.run();
      if (stopped) return;
      // A configuration edited to name specs outside the root is refused the
      // way a first run refuses it, without ending a session someone is using.
      const outside = outsideRoot(run.report);
      if (outside !== null) throw new Error(outside);
      const changes = rerunAll ? 'every rule, on request' : plural(new Set(events.map((event) => event.filename)).size, 'change', 'changes');
      render(run, status(run, changes, startedAt));
    } catch (error) {
      if (stopped) return;
      lastSignature = null;
      write(`${heading()}spec-guard: ${error instanceof Error ? error.message : String(error)}\n\nwatching · waiting for a change · Ctrl+C stops\n`);
    } finally {
      running = false;
    }
    schedule();
  };

  /** Sets the timer for the next batch, if there is anything for one to do and it may start. */
  const schedule = (): void => {
    if (stopped || running || (pending.length === 0 && !everything)) return;
    clock.clearTimeout(timer);
    const waited = clock.now() - firstQueuedAt;
    timer = clock.setTimeout(() => void batch(), everything ? 0 : Math.max(0, Math.min(QUIET_MS, MAX_WAIT_MS - waited)));
  };

  const queue = (event: WatchEvent): void => {
    if (pending.length === 0) firstQueuedAt = clock.now();
    pending.push(event);
    schedule();
  };

  let watcher: TreeWatcher | undefined;
  const unregisterInterrupt = options.onInterrupt(() => stop(EXIT_INTERRUPTED));
  const unregisterLine = options.onLine?.(() => {
    everything = true;
    schedule();
  });

  const cannot = (message: string): number => {
    write(`spec-guard: ${message}\n`);
    stop(2);
    return 2;
  };

  // The watcher first, so nothing that changes during the first run is missed.
  try {
    watcher = options.watch(queue, (error) => {
      if (stopped) return;
      write(`spec-guard: the watch on ${options.root} failed: ${describeWatchError(error)}\n`);
      stop(2);
    });
  } catch (error) {
    return cannot(`cannot watch ${options.root}: ${describeWatchError(error as Error)}`);
  }

  const startedAt = clock.now();
  try {
    const first = await session.run();
    if (stopped) return finished;
    const outside = outsideRoot(first.report);
    if (outside !== null) return cannot(outside);
    render(first, status(first, 'first run', startedAt));
  } catch (error) {
    if (stopped) return finished;
    return cannot(error instanceof Error ? error.message : String(error));
  } finally {
    running = false;
  }
  schedule();

  return finished;
}

/** A watcher's error, with what to do about the one a person can fix. */
export function describeWatchError(error: Error): string {
  const code = (error as { code?: unknown }).code;
  return code === 'ENOSPC'
    ? `${error.message} (the system's limit on watched directories was reached; raise fs.inotify.max_user_watches)`
    : error.message;
}
