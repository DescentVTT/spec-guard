/**
 * The options a project keeps in its `package.json`, under `"specGuard"`.
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

/** What a project's configuration can set, each under its own name. */
export interface ProjectConfig {
  specs?: string[];
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

/**
 * The configuration in a root's `package.json`, read by whoever is asking.
 *
 * The reader is a parameter because this module reads nothing itself: the
 * command line passes the filesystem, and a watch session passes the door that
 * records what it read, so an edit to `package.json` reaches the session like
 * an edit to any other file. A file that is not there - or a root that is not a
 * directory - is no configuration. A file that is there and cannot be read is
 * an error, because nobody can tell what it would have said.
 */
export async function loadConfig(root: string, read: (file: string) => Promise<string>): Promise<ProjectConfig> {
  // Joined by hand rather than with node:path, which would be this module's
  // only import: a root with either separator at its end is still one root.
  const file = `${root.replace(/[\\/]+$/, '')}/package.json`;
  let text: string;
  try {
    text = await read(file);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return {};
    throw new ConfigError(`package.json could not be read (${(error as Error).message}), so its "${CONFIG_KEY}" options cannot be read.`);
  }
  return parseConfig(text);
}

/**
 * The configuration in a `package.json`'s text, or none.
 *
 * A `package.json` with no `"specGuard"` is no configuration rather than a
 * mistake. Anything else that cannot be used throws a `ConfigError` naming the
 * file and the key, so a run never starts under options nobody meant.
 */
export function parseConfig(text: string, file = 'package.json'): ProjectConfig {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${file} is not valid JSON (${(error as Error).message}), so its "${CONFIG_KEY}" options cannot be read.`);
  }

  const options = isObject(manifest) ? manifest[CONFIG_KEY] : undefined;
  if (options === undefined) return {};
  if (!isObject(options)) throw new ConfigError(`${file}: "${CONFIG_KEY}" must be an object, got ${describe(options)}.`);

  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (INVOCATION_OPTIONS.has(key)) {
      throw new ConfigError(`${file}: "${CONFIG_KEY}.${key}" is chosen on the command line, not in ${file}.`);
    }
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new ConfigError(`${file}: unknown option "${key}" in "${CONFIG_KEY}". Options are ${CONFIG_KEYS.join(', ')}.`);
    }
    const issue = checkValue(key as ConfigKey, value);
    if (issue !== null) throw new ConfigError(`${file}: "${CONFIG_KEY}.${key}" ${issue}.`);
    try {
      config[key] = key === 'engine' ? engineNamed(value as string) : value;
    } catch (error) {
      throw new ConfigError(`${file}: "${CONFIG_KEY}.${key}": ${(error as Error).message}`);
    }
  }
  return config as ProjectConfig;
}
