/**
 * The options a project keeps in its `package.json`, under `"specGuard"`, or
 * in a `.spec-guard.json` of their own.
 *
 * Validated from a value, never read from a file: the command line reads the
 * file, and every malformed option can then be tested on a plain object. The
 * keys are the options that are a project's policy - which specs, and how
 * strictly to hold them - and nothing that describes one invocation. See
 * ADR-0014.
 */

import type { EnginePreference } from './engine.js';

/** The name the options sit under in `package.json`. */
export const CONFIG_KEY = 'specGuard';

/**
 * The file that holds the options on its own, for a root with no `package.json`
 * to put them in - a Rust, Go or .NET repository, say.
 */
export const CONFIG_FILE = '.spec-guard.json';

/** What a project's configuration can set, each under its own name. */
export interface ProjectConfig {
  specs?: string[];
  exclude?: string[];
  engine?: EnginePreference;
  strict?: boolean;
  allowMissingTargets?: boolean;
  allowEmptyScope?: boolean;
  ignoreStatus?: boolean;
  includeSpecs?: boolean;
  defaultSkips?: boolean;
  maxSnippets?: number;
  concurrency?: number;
}

export type ConfigKey = keyof ProjectConfig;

/** Every key, in the order the documentation lists them. */
export const CONFIG_KEYS: readonly ConfigKey[] = [
  'specs',
  'exclude',
  'engine',
  'strict',
  'allowMissingTargets',
  'allowEmptyScope',
  'ignoreStatus',
  'includeSpecs',
  'defaultSkips',
  'maxSnippets',
  'concurrency',
];

/**
 * Options that exist on the command line and are refused here by name.
 *
 * Each describes one invocation rather than a project. `"format": "sarif"`
 * would make every developer's local run print SARIF, and `root` is where the
 * configuration was found in the first place.
 */
export const INVOCATION_OPTIONS: ReadonlySet<string> = new Set([
  'root',
  'format',
  'json',
  'verbose',
  'color',
  'failFast',
  'printBaseline',
  'allowEmpty',
  'watch',
]);

/** A configuration that cannot be used, with the words to say why. */
export class ConfigError extends Error {}

const ENGINE_ALIASES: Readonly<Record<string, EnginePreference>> = {
  auto: 'auto',
  rg: 'ripgrep',
  ripgrep: 'ripgrep',
  js: 'javascript',
  javascript: 'javascript',
  node: 'javascript',
};

/**
 * The engine a name asks for, whether the name came from a flag or a file.
 *
 * One function, so `--engine rgg` and `"engine": "rgg"` fail with the same
 * words. Case is ignored, as the flag always has.
 */
export function engineNamed(name: string): EnginePreference {
  const engine = ENGINE_ALIASES[name.toLowerCase()];
  if (engine === undefined) throw new ConfigError(`Unknown engine "${name}". Expected auto, rg or js.`);
  return engine;
}

/** A value as a message names it: `"yes"`, `3`, `null`, an array, an object. */
function describe(value: unknown): string {
  if (Array.isArray(value)) return 'an array';
  if (value !== null && typeof value === 'object') return 'an object';
  return JSON.stringify(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Checks one key's value, or says what is wrong with it.
 *
 * A string is not a boolean and a number in a string is not a number. JSON has
 * both types, and accepting `"true"` would be a second grammar for one file.
 */
function checkValue(key: ConfigKey, value: unknown): string | null {
  switch (key) {
    case 'specs':
      return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string' && entry.trim() !== '')
        ? null
        : `must be a non-empty list of spec globs, got ${describe(value)}`;
    case 'exclude':
      return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim() !== '')
        ? null
        : `must be a list of paths or globs to exclude, got ${describe(value)}`;
    case 'engine':
      return typeof value === 'string' ? null : `must be a string, got ${describe(value)}`;
    case 'maxSnippets':
      return Number.isInteger(value) && (value as number) >= 0 ? null : `must be an integer, 0 or more, got ${describe(value)}`;
    case 'concurrency':
      return Number.isInteger(value) && (value as number) >= 1 ? null : `must be an integer, 1 or more, got ${describe(value)}`;
    default:
      return typeof value === 'boolean' ? null : `must be true or false, got ${describe(value)}`;
  }
}

/** Where a configuration came from: the file a report names, and what it said. */
export interface FoundConfig {
  config: ProjectConfig;
  file: string;
}

/**
 * A file's text, or null when it is not there.
 *
 * A file that is not there - or a root that is not a directory - is no
 * configuration. A file that is there and cannot be read is an error, because
 * nobody can tell what it would have said.
 */
async function readIfPresent(read: (file: string) => Promise<string>, path: string, name: string, what: string): Promise<string | null> {
  try {
    return await read(path);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new ConfigError(`${name} could not be read (${(error as Error).message}), so ${what} cannot be read.`);
  }
}

/**
 * The configuration of a root, from `package.json` or `.spec-guard.json`.
 *
 * The reader is a parameter because this module reads nothing itself: the
 * command line passes the filesystem, and a watch session passes the door that
 * records what it read, so an edit to either file reaches the session like an
 * edit to any other file.
 *
 * Options in both files are an error rather than one file winning: whichever
 * lost would be a configuration somebody wrote and nothing reads.
 */
export async function findConfig(root: string, read: (file: string) => Promise<string>): Promise<FoundConfig> {
  // Joined by hand rather than with node:path, which would be this module's
  // only import: a root with either separator at its end is still one root.
  const base = root.replace(/[\\/]+$/, '');
  const manifest = await readIfPresent(read, `${base}/package.json`, 'package.json', `its "${CONFIG_KEY}" options`);
  const standalone = await readIfPresent(read, `${base}/${CONFIG_FILE}`, CONFIG_FILE, 'its options');

  const fromManifest = manifest === null ? undefined : manifestOptions(manifest, 'package.json');
  if (standalone === null) {
    return { config: fromManifest === undefined ? {} : checkOptions(fromManifest, 'package.json', true), file: 'package.json' };
  }
  if (fromManifest !== undefined) {
    throw new ConfigError(
      `Options are set in both package.json ("${CONFIG_KEY}") and ${CONFIG_FILE}. Keep them in one of the two, so that no option is written somewhere nothing reads.`,
    );
  }
  return { config: parseStandaloneConfig(standalone), file: CONFIG_FILE };
}

/** The configuration of a root, wherever it is kept. See `findConfig`. */
export async function loadConfig(root: string, read: (file: string) => Promise<string>): Promise<ProjectConfig> {
  return (await findConfig(root, read)).config;
}

/** The `"specGuard"` value of a `package.json`'s text, unchecked, or undefined when there is none. */
function manifestOptions(text: string, file: string): unknown {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${file} is not valid JSON (${(error as Error).message}), so its "${CONFIG_KEY}" options cannot be read.`);
  }
  return isObject(manifest) ? manifest[CONFIG_KEY] : undefined;
}

/**
 * Checks every option, naming the file and the key of the first that cannot be
 * used. `nested` says the options sit under `"specGuard"`, which the names in a
 * message then include.
 */
function checkOptions(options: unknown, file: string, nested: boolean): ProjectConfig {
  const name = (key: string): string => (nested ? `"${CONFIG_KEY}.${key}"` : `"${key}"`);
  if (!isObject(options)) {
    throw new ConfigError(
      nested ? `${file}: "${CONFIG_KEY}" must be an object, got ${describe(options)}.` : `${file} must hold an object of options, got ${describe(options)}.`,
    );
  }

  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (INVOCATION_OPTIONS.has(key)) {
      throw new ConfigError(`${file}: ${name(key)} is chosen on the command line, not in ${file}.`);
    }
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new ConfigError(`${file}: unknown option "${key}"${nested ? ` in "${CONFIG_KEY}"` : ''}. Options are ${CONFIG_KEYS.join(', ')}.`);
    }
    const issue = checkValue(key as ConfigKey, value);
    if (issue !== null) throw new ConfigError(`${file}: ${name(key)} ${issue}.`);
    try {
      config[key] = key === 'engine' ? engineNamed(value as string) : value;
    } catch (error) {
      throw new ConfigError(`${file}: ${name(key)}: ${(error as Error).message}`);
    }
  }
  return config as ProjectConfig;
}

/**
 * The configuration in a `package.json`'s text, or none.
 *
 * A `package.json` with no `"specGuard"` is no configuration rather than a
 * mistake. Anything else that cannot be used throws a `ConfigError` naming the
 * file and the key, so a run never starts under options nobody meant.
 */
export function parseConfig(text: string, file = 'package.json'): ProjectConfig {
  const options = manifestOptions(text, file);
  return options === undefined ? {} : checkOptions(options, file, true);
}

/** The configuration in a `.spec-guard.json`'s text: the options, at the top level. */
export function parseStandaloneConfig(text: string, file = CONFIG_FILE): ProjectConfig {
  let options: unknown;
  try {
    options = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${file} is not valid JSON (${(error as Error).message}), so its options cannot be read.`);
  }
  return checkOptions(options, file, false);
}
