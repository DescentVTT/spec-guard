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

import { CONFIG_KEYS, ConfigError, engineNamed, loadConfig, type ConfigKey, type ProjectConfig } from './config.js';
import { nodeIo, readText } from './io.js';
import { createMcpHandler, serveStdio } from './mcp.js';
import { formatQuery, formatQueryJson, queryRules } from './query.js';
import { formatBaselines, formatJson, formatReport, formatSarif, shouldUseAscii, shouldUseColor } from './reporter.js';
import { DEFAULT_CONCURRENCY, DEFAULT_MAX_SNIPPETS, runSpecGuard, type RunOptions } from './runner.js';
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
  /** Where `spec-guard mcp` reads its messages. Only that command reads input. */
  stdin?: Readable;
}

/** What the command line asked for: a run, a query, or a server. */
export type Command = 'check' | 'query' | 'mcp';

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
  ignoreStatus: boolean;
  strictTargets: boolean;
  allowEmptyScope: boolean;
  printBaseline: boolean;
  includeSpecs: boolean;
  allowEmpty: boolean;
  maxSnippets: number;
  concurrency: number;
  color?: boolean;
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

Patterns
  Globs or paths to the Markdown specs to execute. A directory expands to the
  Markdown files inside it. Defaults to "docs/**/*.md" when omitted. query and
  mcp take theirs from --spec.

Options
  -r, --root <path>       Codebase root that assertions are resolved against (default: cwd)
      --spec <pattern>    A spec glob or path; repeatable (default: "docs/**/*.md")
  -v, --verbose           Print passing assertions too
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
      --ignore-status     Execute directives in draft, proposed and superseded documents too
      --include-specs     Also count matches inside the spec files themselves
      --max-snippets <n>  Failure snippets per assertion (default: ${DEFAULT_MAX_SNIPPETS})
      --concurrency <n>   Assertions executed in parallel (default: ${DEFAULT_CONCURRENCY})
      --allow-empty       Exit 0 when no spec files matched (about the run, not an assertion)
      --color/--no-color  Force colour on or off (NO_COLOR is honoured)
  -h, --help              Show this help
      --version           Print the version

Configuration
  package.json in the root can hold specs, engine, strict, allowMissingTargets,
  allowEmptyScope, ignoreStatus, includeSpecs, defaultSkips, maxSnippets and
  concurrency under "specGuard". A flag wins over the file, and every on/off
  option there also takes its opposite (--no-strict, --default-skips, ...).

Directives
  <!-- @assert-absence target="src/" symbol="LegacyGateway" exclude="src/legacy/**" -->
  <!-- @assert-count   target="src/" symbol="SessionManager" expected="1" -->
  <!-- @assert-present file="SECURITY.md" -->
  <!-- @assert-import-cycle target="src/" types="ignore" -->
  <!-- @assert-layers target="src/" order="domain, application, infrastructure" -->
  <!-- @assert-structure target="src/" exclude="*.test.ts" partner="[name].test.ts" -->

  Matches inside comments do not count; add comments="include" to count them.
  An assertion whose scope holds no files fails; add allow-empty="true" to allow it.
  A document whose status is draft, proposed, rejected, deprecated or superseded
  is reported and not executed; --ignore-status runs it anyway.

query answers from the specs alone, without reading the codebase, so it works
for a file that does not exist yet. mcp offers the same answer, and a check,
as the tools get_architectural_rules and check_architecture.

Exit codes
  0 all assertions passed   1 an assertion failed   2 spec-guard could not run`;

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
 * and doing nothing with it would tell someone their query was strict.
 */
const NOT_FOR: Record<Exclude<Command, 'check'>, ReadonlySet<string>> = {
  query: new Set([
    '--verbose',
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
    '--no-color',
  ]),
  mcp: new Set(['--verbose', '--fail-fast', '--json', '--format', '--print-baseline', '--allow-empty', '--color', '--no-color']),
};


/** The long name of an option, whichever way it was spelled. */
const LONG_NAMES: Readonly<Record<string, string>> = { '-v': '--verbose' };

/** Minimal, dependency-free argv parser. Supports `--flag value` and `--flag=value`. */
export function parseArgs(argv: readonly string[], cwd: string): CliOptions {
  const command: Command = argv[0] === 'query' || argv[0] === 'mcp' ? argv[0] : 'check';
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
    ignoreStatus: false,
    strictTargets: false,
    allowEmptyScope: false,
    printBaseline: false,
    includeSpecs: false,
    allowEmpty: false,
    maxSnippets: DEFAULT_MAX_SNIPPETS,
    concurrency: DEFAULT_CONCURRENCY,
    help: false,
    version: false,
    fromCommandLine: new Set(),
  };
  const set = options.fromCommandLine;

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

  options.patterns.push(...specs);
  if (options.patterns.length > 0) set.add('specs');
  if (options.patterns.length === 0) options.patterns = ['docs/**/*.md'];
  if (command === 'query' && options.paths.length === 0 && !options.help && !options.version) {
    throw new UsageError('spec-guard query needs a path to ask about, e.g. spec-guard query src/domain/user.ts.');
  }
  return options;
}

/** The configurable options a query reads; the rest are about running rules. */
const QUERY_KEYS: ReadonlySet<ConfigKey> = new Set<ConfigKey>(['specs', 'ignoreStatus', 'includeSpecs', 'defaultSkips']);

/** Where each key of a configuration lands on the command line's options. */
const SETTERS: { [Key in ConfigKey]-?: (options: CliOptions, value: NonNullable<ProjectConfig[Key]>) => void } = {
  specs: (options, value) => {
    options.patterns = [...value];
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
 * anything about strictness. Returns nothing when the configuration had
 * nothing to say to this command, so a report says nothing about it.
 */
export function applyConfig(options: CliOptions, config: ProjectConfig, file = 'package.json'): ConfigUse | undefined {
  const applied: ConfigKey[] = [];
  const overridden: ConfigKey[] = [];
  for (const key of CONFIG_KEYS) {
    const value = config[key];
    if (value === undefined) continue;
    if (options.command === 'query' && !QUERY_KEYS.has(key)) continue;
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
    return { use: applyConfig(options, await loadConfig(options.root, (file) => readText(nodeIo, file))) };
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
    ignoreStatus: options.ignoreStatus,
    strictTargets: options.strictTargets,
    includeSpecs: options.includeSpecs,
    concurrency: options.concurrency,
    maxSnippets: options.maxSnippets,
  };
}

function defaultIO(): CliIO {
  return {
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
    env: process.env,
    cwd: process.cwd(),
    isTTY: Boolean(process.stdout.isTTY),
    stdin: process.stdin,
  };
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
      applyConfig(fresh, await loadConfig(options.root, (file) => readText(nodeIo, file)));
      return { patterns: fresh.patterns, run: runOptionsOf(fresh) };
    },
  });
  // stderr is the one channel the stdio binding leaves free for people.
  const from = use === undefined || use.applied.length === 0 ? '' : `, options from ${use.file}: ${use.applied.join(', ')}`;
  io.stderr(`spec-guard ${version()}: MCP server on stdio, rules from ${options.patterns.join(', ')} under ${options.root}${from}`);
  await serveStdio(io.stdin, io.stdout, handler);
  return EXIT_OK;
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
