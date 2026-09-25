/**
 * Command line entrypoint.
 *
 * Exit codes are the contract CI depends on:
 *   0 - every assertion held
 *   1 - an assertion failed, or a directive was invalid
 *   2 - spec-guard could not run (bad usage, no spec files, missing engine)
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import type { Readable } from 'node:stream';

import { CONFIG_KEYS, ConfigError, engineNamed, findConfig, type ConfigKey, type ProjectConfig } from './config.js';
import { excludeListError } from './glob.js';
import { nodeIo, readText, watchTree } from './io.js';
import { createMcpHandler, serveStdio } from './mcp.js';
import { formatQuery, formatQueryJson, queryRules } from './query.js';
import { proveSpecGuard } from './prove.js';
import {
  formatBaselines,
  formatConfigUse,
  formatJson,
  formatProve,
  formatProveJson,
  formatProveSarif,
  formatReport,
  formatSarif,
  shouldUseAscii,
  shouldUseColor,
} from './reporter.js';
import { DEFAULT_CONCURRENCY, DEFAULT_MAX_SNIPPETS, runSpecGuard, splitList, type RunOptions } from './runner.js';
import { createSession, runWatch } from './watch.js';
import type { EnginePreference } from './engine.js';
import type { ConfigUse } from './types.js';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_ERROR = 2;

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  isTTY: boolean;
  /**
   * Where `spec-guard mcp` reads its messages, and where a watch session hears
   * Enter. Nothing else reads input.
   */
  stdin?: Readable;
  /** Writes to stdout as it is, with no newline added: a watch session redraws. */
  write?: (text: string) => void;
  /** Starts a recursive watch on a directory; a test passes one it drives itself. */
  watch?: typeof watchTree;
  /** Registers what Ctrl+C and SIGTERM do, and returns how to unregister it. */
  onInterrupt?: (handler: () => void) => () => void;
}

/** What the command line asked for: a run, a query, a server, or a proof that the rules can fail. */
export type Command = 'check' | 'query' | 'mcp' | 'prove';

/** How a finished run is written out. */
export type OutputFormat = 'human' | 'json' | 'sarif';

export interface CliOptions {
  command: Command;
  patterns: string[];
  /** The paths `spec-guard query` asks about. */
  paths: string[];
  root: string;
  verbose: boolean;
  failFast: boolean;
  format: OutputFormat;
  /** Kept as its own field so `--json` remains exactly what it always was. */
  json: boolean;
  engine: EnginePreference;
  allowMissingTargets: boolean;
  defaultSkips: boolean;
  /** Paths no assertion looks at, beside each directive's own exclude. */
  exclude: string[];
  ignoreStatus: boolean;
  strictTargets: boolean;
  allowEmptyScope: boolean;
  printBaseline: boolean;
  includeSpecs: boolean;
  allowEmpty: boolean;
  maxSnippets: number;
  concurrency: number;
  color?: boolean;
  /** Re-run as the tree changes, until stopped. ADR-0014. */
  watch: boolean;
  help: boolean;
  version: boolean;
  /**
   * The configurable options the command line set, either way.
   *
   * A configuration fills in only what is not here, so a flag always wins - and
   * `--strict` given alongside `"strict": true` is still reported as the command
   * line's doing, not the file's.
   */
  fromCommandLine: Set<ConfigKey>;
}

export class UsageError extends Error {}

/**
 * The installed version, or `0.0.0` when the manifest cannot say.
 *
 * The manifest is a parameter so the fallback can be tested: it is what a
 * broken install reports instead of crashing, and a fallback nothing runs is a
 * fallback nobody knows still works.
 */
export function version(manifest = '../package.json'): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require(manifest) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const HELP = `spec-guard - Executable architecture assertions for Markdown specs & ADRs

Usage
  spec-guard [patterns...] [options]     execute the directives in the specs
  spec-guard query <paths...> [options]  list the rules in force for files or directories
  spec-guard mcp [options]               serve the rules to an AI agent over MCP on stdio
  spec-guard prove [patterns...] [options]
                                         show each rule a violation of itself, in memory, and report any that pass

Patterns
  Globs or paths to the Markdown specs to execute. A directory expands to the
  Markdown files inside it. Defaults to "docs/**/*.md" when omitted. query and
  mcp take theirs from --spec.

Options
  -r, --root <path>       Codebase root that assertions are resolved against (default: cwd)
      --spec <pattern>    A spec glob or path; repeatable (default: "docs/**/*.md")
  -v, --verbose           Print passing assertions too
      --watch             Run again as the tree changes, until Ctrl+C (human output only)
      --fail-fast         Stop at the first failing assertion
      --json              Emit a machine-readable JSON report (same as --format json)
      --format <name>     human | json | sarif  (sarif uploads to GitHub code scanning)
      --engine <name>     auto | rg | js  (default: auto - scanner for small trees, ripgrep for big ones)
      --strict            Treat analysis that could not be completed as a failure
      --allow-missing-targets
                          Tolerate target paths that do not exist (they fail by default)
      --allow-empty-scope Tolerate assertions whose scope holds no files (they fail by default)
      --print-baseline    Print the baseline="..." that would exempt today's violations, and exit
      --no-default-skips  Search .git, .hg, .svn and node_modules too
      --exclude <globs>   Paths no assertion looks at, beside each directive's exclude; repeatable
      --ignore-status     Execute directives in draft, proposed and superseded documents too
      --include-specs     Also count matches inside the spec files themselves
      --max-snippets <n>  Failure snippets per assertion (default: ${DEFAULT_MAX_SNIPPETS})
      --concurrency <n>   Assertions executed in parallel (default: ${DEFAULT_CONCURRENCY})
      --allow-empty       Exit 0 when no spec files matched (about the run, not an assertion)
      --color/--no-color  Force colour on or off (NO_COLOR is honoured)
  -h, --help              Show this help
      --version           Print the version

Configuration
  package.json in the root can hold specs, exclude, engine, strict,
  allowMissingTargets, allowEmptyScope, ignoreStatus, includeSpecs, defaultSkips,
  maxSnippets and concurrency under "specGuard"; a root with no package.json can
  keep them in .spec-guard.json instead, but not in both. A flag wins over the
  file, every on/off option there also takes its opposite (--no-strict,
  --default-skips, ...), and --exclude= with nothing clears exclude.

Directives
  <!-- @assert-absence target="src/" symbol="LegacyGateway" exclude="src/legacy/**" -->
  <!-- @assert-count   target="src/" symbol="SessionManager" expected="1" -->
  <!-- @assert-present file="SECURITY.md" -->
  <!-- @assert-import-cycle target="src/" types="ignore" -->
  <!-- @assert-layers target="src/" order="domain, application, infrastructure" -->
  <!-- @assert-structure target="src/" exclude="*.test.ts" partner="[name].test.ts" -->

  Matches inside comments do not count; add comments="include" to count them.
  An assertion whose scope holds no files fails; add allow-empty="true" to allow it.
  A document whose status is draft, proposed, rejected, deprecated, superseded
  or archived is reported and not executed; --ignore-status runs it anyway.

prove adds, changes or removes files in memory only - never on disk - to make
the violation each rule forbids, and runs the rule over that tree. A rule that
still passes survived, and exits 1; one no violation could be made for is
unprovable, and exits 1 under --strict.

query answers from the specs alone, without reading the codebase, so it works
for a file that does not exist yet. mcp offers the same answer, and a check,
as the tools get_architectural_rules and check_architecture.

Exit codes
  0 all assertions passed   1 an assertion failed   2 spec-guard could not run
  130 a --watch session was stopped`;

/**
 * Takes the next argv element as a value.
 *
 * A leading dash means the value was omitted and the next option got swallowed
 * ("--root --verbose"). That heuristic only applies here: in the `--opt=value`
 * form there is nothing ambiguous about a leading dash, so "--max-snippets=-1"
 * should be told it wants a non-negative integer rather than that it is missing
 * a value.
 */
function requireValue(name: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('-')) {
    throw new UsageError(`Option ${name} requires a value.`);
  }
  return value;
}

function positiveInteger(name: string, value: string): number {
  if (!/^\d+$/.test(value)) throw new UsageError(`Option ${name} expects a non-negative integer, got "${value}".`);
  return Number.parseInt(value, 10);
}

/**
 * Options that mean nothing to a command, by command.
 *
 * Refused rather than ignored: `spec-guard query --strict` accepting the flag
 * and doing nothing with it would tell someone their query was strict. A query
 * takes `--no-color`, which is true of its output already and is what a script
 * passes to every command it runs; `--color` it refuses, since it would promise
 * colour a query never prints.
 */
const NOT_FOR: Record<Exclude<Command, 'check'>, ReadonlySet<string>> = {
  query: new Set([
    '--verbose',
    '--watch',
    '--fail-fast',
    '--engine',
    '--strict',
    '--no-strict',
    '--allow-missing-targets',
    '--no-allow-missing-targets',
    '--allow-empty-scope',
    '--no-allow-empty-scope',
    '--print-baseline',
    '--allow-empty',
    '--max-snippets',
    '--concurrency',
    '--color',
  ]),
  mcp: new Set(['--verbose', '--watch', '--fail-fast', '--json', '--format', '--print-baseline', '--allow-empty', '--color', '--no-color']),
  // A proof runs every rule, one at a time, with the scanner reading through a
  // door ripgrep cannot see through, and prints no snippets.
  prove: new Set(['--watch', '--fail-fast', '--print-baseline', '--engine', '--concurrency', '--max-snippets']),
};

/**
 * Options a watch session refuses, and why.
 *
 * Each makes sense only for one run whose output or exit code something reads:
 * a session prints for a person, never exits on its own, and scans in-process
 * so it can see what each rule read (ADR-0014).
 */
const NOT_WITH_WATCH: ReadonlyArray<[option: string, reason: string]> = [
  ['--json', 'a session prints reports for a person, not one document'],
  ['--format', 'a session prints reports for a person, not one document'],
  ['--print-baseline', 'it prints once and exits'],
  ['--fail-fast', 'a session runs every rule, so each report can be compared with the last'],
  ['--allow-empty', 'a session has no exit code to relax'],
  ['--engine', 'a session always scans in-process, where it can see what each rule reads'],
];

/** The long name of an option, whichever way it was spelled. */
const LONG_NAMES: Readonly<Record<string, string>> = { '-v': '--verbose' };

/** Minimal, dependency-free argv parser. Supports `--flag value` and `--flag=value`. */
export function parseArgs(argv: readonly string[], cwd: string): CliOptions {
  const command: Command = argv[0] === 'query' || argv[0] === 'mcp' || argv[0] === 'prove' ? argv[0] : 'check';
  const specs: string[] = [];
  const options: CliOptions = {
    command,
    patterns: [],
    paths: [],
    root: cwd,
    verbose: false,
    failFast: false,
    format: 'human',
    json: false,
    engine: 'auto',
    allowMissingTargets: false,
    defaultSkips: true,
    exclude: [],
    ignoreStatus: false,
    strictTargets: false,
    allowEmptyScope: false,
    printBaseline: false,
    includeSpecs: false,
    allowEmpty: false,
    maxSnippets: DEFAULT_MAX_SNIPPETS,
    concurrency: DEFAULT_CONCURRENCY,
    watch: false,
    help: false,
    version: false,
    fromCommandLine: new Set(),
  };
  const set = options.fromCommandLine;
  /** Every option given, by its long name, for the refusals that depend on another option. */
  const given = new Set<string>();

  let onlyPositional = false;

  for (let index = command === 'check' ? 0 : 1; index < argv.length; index++) {
    const argument = argv[index] as string;

    if (onlyPositional || !argument.startsWith('-') || argument === '-') {
      if (command === 'mcp') throw new UsageError(`spec-guard mcp takes no arguments, got "${argument}". Name specs with --spec.`);
      (command === 'query' ? options.paths : options.patterns).push(argument);
      continue;
    }
    if (argument === '--') {
      onlyPositional = true;
      continue;
    }

    const equals = argument.indexOf('=');
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : argument.slice(equals + 1);
    const nextValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      index += 1;
      return requireValue(name, argv[index]);
    };

    if (command !== 'check' && NOT_FOR[command].has(LONG_NAMES[name] ?? name)) {
      throw new UsageError(`Option ${name} does not apply to spec-guard ${command}.`);
    }
    given.add(LONG_NAMES[name] ?? name);

    switch (name) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '--version':
        options.version = true;
        break;
      case '-v':
      case '--verbose':
        options.verbose = true;
        break;
      case '--watch':
        options.watch = true;
        break;
      case '--fail-fast':
        options.failFast = true;
        break;
      case '--json':
        options.json = true;
        options.format = 'json';
        break;
      case '--format': {
        const value = nextValue().toLowerCase();
        if (command === 'query' && value === 'sarif') {
          throw new UsageError('spec-guard query has no sarif format: it lists rules, not results. Expected human or json.');
        }
        if (value !== 'human' && value !== 'json' && value !== 'sarif') {
          throw new UsageError(`Unknown format "${value}". Expected human, json or sarif.`);
        }
        options.format = value;
        options.json = value === 'json';
        break;
      }
      case '--strict':
      case '--no-strict':
        options.strictTargets = name === '--strict';
        set.add('strict');
        break;
      case '--allow-missing-targets':
      case '--no-allow-missing-targets':
        options.allowMissingTargets = name === '--allow-missing-targets';
        set.add('allowMissingTargets');
        break;
      case '--allow-empty-scope':
      case '--no-allow-empty-scope':
        options.allowEmptyScope = name === '--allow-empty-scope';
        set.add('allowEmptyScope');
        break;
      case '--print-baseline':
        options.printBaseline = true;
        break;
      case '--default-skips':
      case '--no-default-skips':
        options.defaultSkips = name === '--default-skips';
        set.add('defaultSkips');
        break;
      // Repeatable, each value a list as exclude="..." takes one. Given at all, it
      // replaces the configuration's list, and --exclude= with nothing clears it.
      case '--exclude': {
        const patterns = splitList(nextValue());
        const error = excludeListError(patterns);
        if (error !== null) throw new UsageError(`Option --exclude has an ${error}.`);
        options.exclude.push(...patterns);
        set.add('exclude');
        break;
      }
      case '--ignore-status':
      case '--no-ignore-status':
        options.ignoreStatus = name === '--ignore-status';
        set.add('ignoreStatus');
        break;
      case '--include-specs':
      case '--no-include-specs':
        options.includeSpecs = name === '--include-specs';
        set.add('includeSpecs');
        break;
      case '--allow-empty':
        options.allowEmpty = true;
        break;
      case '--color':
        options.color = true;
        break;
      case '--no-color':
        options.color = false;
        break;
      case '-r':
      case '--root':
        options.root = path.resolve(cwd, nextValue());
        break;
      case '--spec':
        specs.push(nextValue());
        break;
      case '--engine': {
        const value = nextValue().toLowerCase();
        try {
          options.engine = engineNamed(value);
        } catch (error) {
          throw new UsageError((error as ConfigError).message);
        }
        set.add('engine');
        break;
      }
      case '--max-snippets':
        options.maxSnippets = positiveInteger(name, nextValue());
        set.add('maxSnippets');
        break;
      case '--concurrency':
        options.concurrency = Math.max(1, positiveInteger(name, nextValue()));
        set.add('concurrency');
        break;
      default:
        throw new UsageError(`Unknown option "${name}". Run spec-guard --help.`);
    }
  }

  if (options.watch) {
    for (const [option, reason] of NOT_WITH_WATCH) {
      if (given.has(option) && !(option === '--format' && options.format === 'human')) {
        throw new UsageError(`Option ${option} does not apply to spec-guard --watch: ${reason}.`);
      }
    }
  }

  options.patterns.push(...specs);
  if (options.patterns.length > 0) set.add('specs');
  if (options.patterns.length === 0) options.patterns = ['docs/**/*.md'];
  if (command === 'query' && options.paths.length === 0 && !options.help && !options.version) {
    throw new UsageError('spec-guard query needs a path to ask about, e.g. spec-guard query src/domain/user.ts.');
  }
  return options;
}

/** The configurable options a query reads; the rest are about running rules. */
const QUERY_KEYS: ReadonlySet<ConfigKey> = new Set<ConfigKey>(['specs', 'exclude', 'ignoreStatus', 'includeSpecs', 'defaultSkips']);

/** The configurable options a proof reads: what decides whether a rule passes, and not how a run is scheduled. */
const PROVE_KEYS: ReadonlySet<ConfigKey> = new Set<ConfigKey>([
  'specs',
  'exclude',
  'strict',
  'allowMissingTargets',
  'allowEmptyScope',
  'ignoreStatus',
  'includeSpecs',
  'defaultSkips',
]);

/** Where each key of a configuration lands on the command line's options. */
const SETTERS: { [Key in ConfigKey]-?: (options: CliOptions, value: NonNullable<ProjectConfig[Key]>) => void } = {
  specs: (options, value) => {
    options.patterns = [...value];
  },
  exclude: (options, value) => {
    options.exclude = [...value];
  },
  engine: (options, value) => {
    options.engine = value;
  },
  strict: (options, value) => {
    options.strictTargets = value;
  },
  allowMissingTargets: (options, value) => {
    options.allowMissingTargets = value;
  },
  allowEmptyScope: (options, value) => {
    options.allowEmptyScope = value;
  },
  ignoreStatus: (options, value) => {
    options.ignoreStatus = value;
  },
  includeSpecs: (options, value) => {
    options.includeSpecs = value;
  },
  defaultSkips: (options, value) => {
    options.defaultSkips = value;
  },
  maxSnippets: (options, value) => {
    options.maxSnippets = value;
  },
  concurrency: (options, value) => {
    options.concurrency = value;
  },
};

/**
 * Fills in what the command line left unset from a configuration, and says what
 * it took.
 *
 * A key the command does not read is neither applied nor overridden: `strict`
 * is written for the runs, and a query that ignores it has not been told
 * anything about strictness. A watch session scans in-process, so `engine` is
 * not one of its keys either. Returns nothing when the configuration had
 * nothing to say to this command, so a report says nothing about it.
 */
export function applyConfig(options: CliOptions, config: ProjectConfig, file = 'package.json'): ConfigUse | undefined {
  const applied: ConfigKey[] = [];
  const overridden: ConfigKey[] = [];
  for (const key of CONFIG_KEYS) {
    const value = config[key];
    if (value === undefined) continue;
    const reads =
      options.command === 'query' ? QUERY_KEYS.has(key) : options.command === 'prove' ? PROVE_KEYS.has(key) : !(options.watch && key === 'engine');
    if (!reads) continue;
    if (options.fromCommandLine.has(key)) {
      overridden.push(key);
      continue;
    }
    (SETTERS[key] as (target: CliOptions, given: unknown) => void)(options, value);
    applied.push(key);
  }
  return applied.length + overridden.length === 0 ? undefined : { file, applied, overridden };
}

/** Reads the root's configuration from disk and applies it, or says why it cannot. */
async function configure(options: CliOptions, io: CliIO): Promise<{ use: ConfigUse | undefined } | null> {
  try {
    const found = await findConfig(options.root, (file) => readText(nodeIo, file));
    return { use: applyConfig(options, found.config, found.file) };
  } catch (error) {
    // Everything loadConfig throws is a ConfigError: a read that fails is turned
    // into one, and parsing throws nothing else. A test for any other kind of
    // error would be a test of a branch no input can reach.
    io.stderr(`spec-guard: ${(error as Error).message}`);
    return null;
  }
}

/** The run a set of command-line options asks for. */
function runOptionsOf(options: CliOptions): Omit<RunOptions, 'patterns' | 'root' | 'select'> {
  return {
    engine: options.engine,
    failFast: options.failFast,
    allowMissingTargets: options.allowMissingTargets,
    allowEmptyScope: options.allowEmptyScope,
    defaultSkips: options.defaultSkips,
    exclude: options.exclude,
    ignoreStatus: options.ignoreStatus,
    strictTargets: options.strictTargets,
    includeSpecs: options.includeSpecs,
    concurrency: options.concurrency,
    maxSnippets: options.maxSnippets,
  };
}

/** The process's own streams, signals and filesystem watcher. */
export function defaultIO(): CliIO {
  return {
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
    env: process.env,
    cwd: process.cwd(),
    isTTY: Boolean(process.stdout.isTTY),
    stdin: process.stdin,
    write: (text) => process.stdout.write(text),
    watch: watchTree,
    // Unregistered as soon as a session starts to stop, so a second Ctrl+C
    // meets Node's own handler and ends the process at once.
    onInterrupt: (handler) => {
      process.on('SIGINT', handler);
      process.on('SIGTERM', handler);
      return () => {
        process.off('SIGINT', handler);
        process.off('SIGTERM', handler);
      };
    },
  };
}

/**
 * `spec-guard --watch`: a session over the root until Ctrl+C. ADR-0014.
 *
 * Each run reads the configuration again, through the session's door, from the
 * options as the command line left them - so an edit to package.json is a
 * changed fact like any other, and the command line still wins.
 */
async function runWatchSession(commandLine: CliOptions, io: CliIO): Promise<number> {
  const session = createSession({
    root: commandLine.root,
    settings: async (door) => {
      const options: CliOptions = { ...commandLine, patterns: [...commandLine.patterns] };
      const found = await findConfig(commandLine.root, (file) => readText(door, file));
      const config = applyConfig(options, found.config, found.file);
      return { patterns: options.patterns, run: runOptionsOf(options), config };
    },
  });
  const stdin = io.stdin;
  return runWatch({
    root: commandLine.root,
    session,
    watch: (listener, onError) => (io.watch ?? watchTree)(commandLine.root, (type, filename) => listener({ type, filename }), onError),
    write: io.write ?? ((text) => io.stdout(text.replace(/\n$/, ''))),
    isTTY: io.isTTY,
    reporter: {
      color: shouldUseColor({ isTTY: io.isTTY }, commandLine.color, io.env),
      verbose: commandLine.verbose,
      ascii: shouldUseAscii(io.env),
    },
    onInterrupt: io.onInterrupt ?? (() => () => {}),
    ...(stdin === undefined
      ? {}
      : {
          onLine: (handler: () => void) => {
            const listener = (chunk: Buffer | string): void => {
              if (String(chunk).includes('\n')) handler();
            };
            stdin.on('data', listener);
            return () => {
              stdin.off('data', listener);
              // Paused, so a stdin that is a terminal stops holding the process
              // open once the session is over.
              stdin.pause();
            };
          },
        }),
  });
}

/** `spec-guard query`: prints the rules governing each path. */
async function runQuery(options: CliOptions, io: CliIO, use: ConfigUse | undefined): Promise<number> {
  let report;
  try {
    report = {
      ...(await queryRules({
        patterns: options.patterns,
        root: options.root,
        paths: options.paths,
        includeInactive: options.ignoreStatus,
        includeSpecs: options.includeSpecs,
        defaultSkips: options.defaultSkips,
        exclude: options.exclude,
      })),
      config: use,
    };
  } catch (error) {
    io.stderr(`spec-guard: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_ERROR;
  }

  if (report.specFiles.length === 0) {
    if (options.format === 'json') io.stdout(formatQueryJson(report));
    else io.stderr(`spec-guard: no spec files matched ${options.patterns.map((p) => `"${p}"`).join(', ')}`);
    return EXIT_ERROR;
  }

  io.stdout(options.format === 'json' ? formatQueryJson(report) : formatQuery(report));
  return EXIT_OK;
}

/**
 * `spec-guard mcp`: serves until the client closes stdin.
 *
 * The configuration is read again for every request, from the options as the
 * command line left them. ADR-0012 refused to cache the rules in the server,
 * and a cached configuration is a cached rule: `"ignoreStatus": true` added
 * while an agent's session is open has to reach the next answer it gets.
 */
async function runMcp(options: CliOptions, commandLine: CliOptions, io: CliIO, use: ConfigUse | undefined): Promise<number> {
  if (!io.stdin) {
    io.stderr('spec-guard: mcp needs a readable stdin.');
    return EXIT_ERROR;
  }
  const handler = createMcpHandler({
    root: options.root,
    patterns: options.patterns,
    version: version(),
    run: runOptionsOf(options),
    settings: async () => {
      const fresh: CliOptions = { ...commandLine, patterns: [...commandLine.patterns] };
      const found = await findConfig(options.root, (file) => readText(nodeIo, file));
      const config = applyConfig(fresh, found.config, found.file);
      return { patterns: fresh.patterns, run: runOptionsOf(fresh), config };
    },
  });
  // stderr is the one channel the stdio binding leaves free for people.
  const from = use === undefined || use.applied.length === 0 ? '' : `, ${formatConfigUse({ ...use, overridden: [] }, options.exclude)}`;
  io.stderr(`spec-guard ${version()}: MCP server on stdio, rules from ${options.patterns.join(', ')} under ${options.root}${from}`);
  await serveStdio(io.stdin, io.stdout, handler);
  return EXIT_OK;
}

/**
 * `spec-guard prove`: each rule shown a violation of itself, in memory. ADR-0016.
 *
 * Exit 1 when a rule survived, or a directive could not be read; under
 * `--strict`, when a rule is unprovable too, since a rule nobody can show
 * failing is analysis that could not be completed.
 */
async function runProve(options: CliOptions, io: CliIO, use: ConfigUse | undefined): Promise<number> {
  let report;
  try {
    report = {
      ...(await proveSpecGuard({
        patterns: options.patterns,
        root: options.root,
        allowMissingTargets: options.allowMissingTargets,
        strictTargets: options.strictTargets,
        allowEmptyScope: options.allowEmptyScope,
        includeSpecs: options.includeSpecs,
        defaultSkips: options.defaultSkips,
        exclude: options.exclude,
        ignoreStatus: options.ignoreStatus,
      })),
      config: use,
    };
  } catch (error) {
    io.stderr(`spec-guard: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_ERROR;
  }

  if (report.summary.specs === 0 && options.format === 'human') {
    io.stderr(`spec-guard: no spec files matched ${options.patterns.map((p) => `"${p}"`).join(', ')}`);
    return options.allowEmpty ? EXIT_OK : EXIT_ERROR;
  }
  io.stdout(
    options.format === 'sarif'
      ? formatProveSarif(report, { version: version() })
      : options.format === 'json'
        ? formatProveJson(report)
        : formatProve(report, {
            color: shouldUseColor({ isTTY: io.isTTY }, options.color, io.env),
            verbose: options.verbose,
            ascii: shouldUseAscii(io.env),
          }),
  );
  if (report.summary.specs === 0) return options.allowEmpty ? EXIT_OK : EXIT_ERROR;
  return report.ok && !(options.strictTargets && report.summary.unprovable > 0) ? EXIT_OK : EXIT_FAILED;
}

/** Runs the CLI and resolves to the process exit code. */
export async function main(argv: readonly string[] = process.argv.slice(2), io: CliIO = defaultIO()): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv, io.cwd);
  } catch (error) {
    io.stderr(error instanceof UsageError ? error.message : String(error));
    io.stderr('');
    io.stderr(HELP);
    return EXIT_ERROR;
  }

  if (options.help) {
    io.stdout(HELP);
    return EXIT_OK;
  }
  if (options.version) {
    io.stdout(version());
    return EXIT_OK;
  }
  // Read after --help and --version, which must work in a project whose
  // package.json is broken, and before anything that runs a rule.
  const commandLine: CliOptions = { ...options, patterns: [...options.patterns] };
  const configured = await configure(options, io);
  if (configured === null) return EXIT_ERROR;
  const { use } = configured;

  if (options.command === 'query') return runQuery(options, io, use);
  if (options.command === 'mcp') return runMcp(options, commandLine, io, use);
  if (options.command === 'prove') return runProve(options, io, use);
  if (options.watch) return runWatchSession(commandLine, io);

  let report;
  try {
    report = {
      ...(await runSpecGuard({ ...runOptionsOf(options), patterns: options.patterns, root: options.root })),
      // Undefined when nothing came from a configuration, which every report
      // reads as "say nothing" and JSON leaves out.
      config: use,
    };
  } catch (error) {
    io.stderr(`spec-guard: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_ERROR;
  }

  if (report.summary.specs === 0) {
    if (options.format !== 'human') {
      io.stdout(options.format === 'sarif' ? formatSarif(report, { version: version() }) : formatJson(report));
    } else {
      io.stderr(`spec-guard: no spec files matched ${options.patterns.map((p) => `"${p}"`).join(', ')}`);
    }
    return options.allowEmpty ? EXIT_OK : EXIT_ERROR;
  }

  if (options.printBaseline) {
    // Printed, never written. See formatBaselines for why that distinction is
    // the whole design and not a missing feature.
    io.stdout(formatBaselines(report));
    return report.ok ? EXIT_OK : EXIT_FAILED;
  }

  if (options.format === 'sarif') {
    io.stdout(formatSarif(report, { version: version() }));
  } else if (options.format === 'json') {
    io.stdout(formatJson(report));
  } else {
    io.stdout(
      formatReport(
        report,
        {
          color: shouldUseColor({ isTTY: io.isTTY }, options.color, io.env),
          verbose: options.verbose,
          ascii: shouldUseAscii(io.env),
        },
        options.maxSnippets,
      ),
    );
  }

  return report.ok ? EXIT_OK : EXIT_FAILED;
}
