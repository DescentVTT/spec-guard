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

import { formatJson, formatReport, shouldUseAscii, shouldUseColor } from './reporter.js';
import { DEFAULT_CONCURRENCY, DEFAULT_MAX_SNIPPETS, runSpecGuard } from './runner.js';
import type { EnginePreference } from './engine.js';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_ERROR = 2;

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  isTTY: boolean;
}

export interface CliOptions {
  patterns: string[];
  root: string;
  verbose: boolean;
  failFast: boolean;
  json: boolean;
  engine: EnginePreference;
  strictTargets: boolean;
  includeSpecs: boolean;
  allowEmpty: boolean;
  maxSnippets: number;
  concurrency: number;
  color?: boolean;
  help: boolean;
  version: boolean;
}

export class UsageError extends Error {}

function version(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    /* c8 ignore next 2 -- only reachable from a broken install */
    return '0.0.0';
  }
}

export const HELP = `spec-guard - Executable architecture assertions for Markdown specs & ADRs

Usage
  spec-guard [patterns...] [options]

Patterns
  Globs or paths to the Markdown specs to execute. A directory expands to the
  Markdown files inside it. Defaults to "docs/**/*.md" when omitted.

Options
  -r, --root <path>       Codebase root that assertions are resolved against (default: cwd)
  -v, --verbose           Print passing assertions too
      --fail-fast         Stop at the first failing assertion
      --json              Emit a machine-readable JSON report
      --engine <name>     auto | rg | js  (default: auto - ripgrep when available)
      --strict            Treat a target path that does not exist as a failure
      --include-specs     Also count matches inside the spec files themselves
      --max-snippets <n>  Failure snippets per assertion (default: ${DEFAULT_MAX_SNIPPETS})
      --concurrency <n>   Assertions executed in parallel (default: ${DEFAULT_CONCURRENCY})
      --allow-empty       Exit 0 when no spec files matched
      --color/--no-color  Force colour on or off (NO_COLOR is honoured)
  -h, --help              Show this help
      --version           Print the version

Directives
  <!-- @assert-absence target="src/" symbol="LegacyGateway" -->
  <!-- @assert-count   target="src/" symbol="SessionManager" expected="1" -->
  <!-- @assert-present file="SECURITY.md" -->

Exit codes
  0 all assertions passed   1 an assertion failed   2 spec-guard could not run`;

const ENGINE_ALIASES: Record<string, EnginePreference> = {
  auto: 'auto',
  rg: 'ripgrep',
  ripgrep: 'ripgrep',
  js: 'javascript',
  javascript: 'javascript',
  node: 'javascript',
};

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

/** Minimal, dependency-free argv parser. Supports `--flag value` and `--flag=value`. */
export function parseArgs(argv: readonly string[], cwd: string): CliOptions {
  const options: CliOptions = {
    patterns: [],
    root: cwd,
    verbose: false,
    failFast: false,
    json: false,
    engine: 'auto',
    strictTargets: false,
    includeSpecs: false,
    allowEmpty: false,
    maxSnippets: DEFAULT_MAX_SNIPPETS,
    concurrency: DEFAULT_CONCURRENCY,
    help: false,
    version: false,
  };

  let onlyPositional = false;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] as string;

    if (onlyPositional || !argument.startsWith('-') || argument === '-') {
      options.patterns.push(argument);
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
      if (inlineValue !== undefined) return requireValue(name, inlineValue);
      index += 1;
      return requireValue(name, argv[index]);
    };

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
        break;
      case '--strict':
        options.strictTargets = true;
        break;
      case '--include-specs':
        options.includeSpecs = true;
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
      case '--engine': {
        const value = nextValue().toLowerCase();
        const engine = ENGINE_ALIASES[value];
        if (!engine) {
          throw new UsageError(`Unknown engine "${value}". Expected auto, rg or js.`);
        }
        options.engine = engine;
        break;
      }
      case '--max-snippets':
        options.maxSnippets = positiveInteger(name, nextValue());
        break;
      case '--concurrency':
        options.concurrency = Math.max(1, positiveInteger(name, nextValue()));
        break;
      default:
        throw new UsageError(`Unknown option "${name}". Run spec-guard --help.`);
    }
  }

  if (options.patterns.length === 0) options.patterns = ['docs/**/*.md'];
  return options;
}

function defaultIO(): CliIO {
  return {
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
    env: process.env,
    cwd: process.cwd(),
    isTTY: Boolean(process.stdout.isTTY),
  };
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

  let report;
  try {
    report = await runSpecGuard({
      patterns: options.patterns,
      root: options.root,
      engine: options.engine,
      failFast: options.failFast,
      strictTargets: options.strictTargets,
      includeSpecs: options.includeSpecs,
      concurrency: options.concurrency,
      maxSnippets: options.maxSnippets,
    });
  } catch (error) {
    io.stderr(`spec-guard: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_ERROR;
  }

  if (report.summary.specs === 0) {
    if (options.json) {
      io.stdout(formatJson(report));
    } else {
      io.stderr(`spec-guard: no spec files matched ${options.patterns.map((p) => `"${p}"`).join(', ')}`);
    }
    return options.allowEmpty ? EXIT_OK : EXIT_ERROR;
  }

  if (options.json) {
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
