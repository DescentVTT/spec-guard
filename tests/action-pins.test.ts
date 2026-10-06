/**
 * The workflow a guide shows is held to the workflows this repository runs.
 *
 * The README pins the actions of its workflows by commit, as the workflows
 * here are pinned, and a pin copied by hand stays where it was copied:
 * Dependabot moves .github/workflows and reads no Markdown. A week after the
 * examples were pinned, upload-sarif had moved here and not there. So each
 * action a guide shows must carry the commit and the version a workflow here
 * has for it, and the next bump fails here until the example follows
 * (.github/dependabot.yml says what to do then).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Not PROJECT_ROOT from the helpers: they load src/, and nothing here does.
const ROOT = join(import.meta.dirname, '..');

interface Use {
  readonly where: string;
  /** What follows `uses:`, comment and all, as written. */
  readonly written: string;
}

/** Every `uses:` in `text` that names an action; a workflow called by its path is not one. */
function usesOf(text: string, file: string): Use[] {
  return text.split(/\r?\n/).flatMap((line, index) => {
    const written = /^\s*(?:-\s+)?uses:\s+(\S.*?)\s*$/.exec(line)?.[1];
    return written === undefined || written.startsWith('./') ? [] : [{ where: `${file}:${index + 1}`, written }];
  });
}

/** `owner/action@commit # version`: the action, and the pin a reader copies. */
function pinOf(written: string): { action: string; pin: string } | null {
  const match = /^([\w.-]+(?:\/[\w.-]+)+)@([0-9a-f]{40} # v\d+\.\d+\.\d+)$/.exec(written);
  return match === null ? null : { action: match[1] as string, pin: match[2] as string };
}

/** Whether pin `a` carries a later version than pin `b`. */
function newer(a: string, b: string): boolean {
  const parts = (pin: string): number[] => pin.slice(pin.indexOf('# v') + 3).split('.').map(Number);
  const [x, y] = [parts(a), parts(b)];
  const at = x.findIndex((part, index) => part !== y[index]);
  return at !== -1 && (x[at] as number) > (y[at] as number);
}

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/**
 * The Markdown a reader copies from: every file but the records. The
 * changelog and the ADRs say what was so on their date, and a pin quoted
 * there is not an example to keep current.
 */
function guides(): string[] {
  const below = (directory: string): string[] =>
    readdirSync(join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
      if (entry.isDirectory()) return entry.name === 'adr' ? [] : below(`${directory}/${entry.name}`);
      return entry.name.endsWith('.md') ? [`${directory}/${entry.name}`] : [];
    });
  const top = readdirSync(ROOT).filter((name) => name.endsWith('.md') && name !== 'CHANGELOG.md');
  return [...top, ...below('docs')].sort();
}

describe('the workflows the guides show', () => {
  const shown = guides().flatMap((file) => usesOf(read(file), file));
  const run = readdirSync(join(ROOT, '.github/workflows'))
    .filter((name) => /\.ya?ml$/.test(name))
    .flatMap((name) => usesOf(read(`.github/workflows/${name}`), name));

  /**
   * Each action the workflows here run, with the newest pin they have for it.
   * Dependabot moves every workflow at once, so there is one; where a hand
   * has moved a single workflow, that one is where the rest are going.
   */
  const pinned = new Map<string, string>();
  for (const { written } of run) {
    const use = pinOf(written);
    const held = use === null ? undefined : pinned.get(use.action);
    if (use !== null && (held === undefined || newer(use.pin, held))) pinned.set(use.action, use.pin);
  }

  it('are found, and so are the workflows they are held to', () => {
    // A guide that moved, or a line this file no longer reads, would leave
    // the checks below nothing to fail on.
    expect(shown.map((use) => use.where.split(':')[0])).toContain('README.md');
    expect([...pinned.keys()]).toEqual(expect.arrayContaining(['actions/checkout', 'actions/setup-node', 'github/codeql-action/upload-sarif']));
  });

  it('pin every action to a commit, with its version beside it', () => {
    expect(shown.filter((use) => pinOf(use.written) === null).map((use) => `${use.where}: ${use.written}`)).toEqual([]);
  });

  it('pin each action as the workflows here pin it', () => {
    const behind = shown.flatMap((use) => {
      const { action, pin } = pinOf(use.written) ?? { action: '', pin: '' };
      const here = pinned.get(action);
      return here === undefined || here === pin ? [] : [`${use.where}: ${action}@${pin}, where the workflows have ${here}`];
    });
    expect(behind).toEqual([]);
  });

  it('show no action that no workflow here runs', () => {
    // No bump would reach its pin, and nothing would say when it fell behind.
    const unheld = shown.flatMap((use) => {
      // One written without a commit is the test before last's to report.
      const action = pinOf(use.written)?.action;
      return action === undefined || pinned.has(action) ? [] : [`${use.where}: ${use.written}`];
    });
    expect(unheld).toEqual([]);
  });
});
