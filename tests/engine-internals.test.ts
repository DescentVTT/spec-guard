/**
 * The ripgrep command line, asserted as data.
 *
 * These flags are load-bearing. spec-guard once reported a clean pass on a
 * repository whose forbidden symbol sat in `.github/workflows/ci.yml`, because
 * ripgrep skips hidden directories by default and nobody had said otherwise;
 * it also gave different answers for the same tree depending on whether a
 * `.git` directory happened to exist above it, because .gitignore applies only
 * inside a repository. Each flag below switches off one of those opinions, and
 * a flag that quietly goes missing is a silent false green - so the argv is
 * pinned exactly rather than sampled.
 *
 * The stderr parser is here for the same reason: ripgrep reports a file it
 * could not open on stderr and nowhere else, and `--no-messages` used to throw
 * that away, which made an unreadable file indistinguishable from a clean one.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildRipgrepArgs, parseRipgrepErrors, type SearchRequest } from '../src/engine.js';
import { SCAN_EVERYTHING } from '../src/scope.js';
import { searchOptions } from './helpers.js';

const ROOT = path.resolve('C:/repo');

function request(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return { root: ROOT, symbol: 'Alpha', targets: ['src'], options: searchOptions(), ...overrides };
}

describe('buildRipgrepArgs', () => {
  it('turns off every ripgrep default that would hide a file', () => {
    const args = buildRipgrepArgs(request());

    // --hidden: .github, .husky and .claude-rules hold real code.
    expect(args).toContain('--hidden');
    // --no-ignore: .gitignore describes what git carries, not what a rule covers.
    expect(args).toContain('--no-ignore');
    // --text: ripgrep otherwise treats a walked binary differently from a named
    // one, so the same bytes were reported or not depending on how they were
    // reached. The scanner decides what is binary, for both engines.
    expect(args).toContain('--text');
    // Never re-introduce this: it discards the per-file errors that are the
    // only evidence a file could not be read.
    expect(args).not.toContain('--no-messages');
  });

  it('asks only which files matched, not for the matches themselves', () => {
    const args = buildRipgrepArgs(request());
    expect(args).toContain('--files-with-matches');
    // NUL is the one separator a filename cannot contain.
    expect(args).toContain('--null');
    expect(args).not.toContain('--json');
  });

  it('excludes the scope policy directories by name', () => {
    const args = buildRipgrepArgs(request()).join(' ');
    expect(args).toContain('--glob !.git/');
    expect(args).toContain('--glob !.hg/');
    expect(args).toContain('--glob !.svn/');
    expect(args).toContain('--glob !node_modules/');
  });

  it('excludes nothing when the policy skips nothing', () => {
    const options = searchOptions({ scope: SCAN_EVERYTHING });
    const args = buildRipgrepArgs(request({ options })).join(' ');
    expect(args).not.toContain('!node_modules/');
    expect(args).not.toContain('!.git/');
  });

  it('puts the policy exclusions after the user globs, so they cannot be undone', () => {
    // ripgrep lets a later glob override an earlier one. A user asking for
    // "*.ts" must not thereby pull node_modules back into scope.
    const options = searchOptions({ globs: ['*.ts'] });
    const args = buildRipgrepArgs(request({ options }));
    expect(args.indexOf('*.ts')).toBeLessThan(args.indexOf('!node_modules/'));
  });

  it('passes the search flags an assertion asked for', () => {
    const options = searchOptions({ regex: true, word: true, ignoreCase: true });
    const args = buildRipgrepArgs(request({ options }));

    expect(args).toContain('--word-regexp');
    expect(args).toContain('--ignore-case');
    // A regex pattern must not be forced into literal matching.
    expect(args).not.toContain('--fixed-strings');
  });

  it('treats a plain symbol as a literal', () => {
    expect(buildRipgrepArgs(request())).toContain('--fixed-strings');
  });

  it('passes every pattern and ends with the targets after a separator', () => {
    const args = buildRipgrepArgs(request({ targets: ['src', 'lib'] }), ['Alpha', 'Beta']);
    const separator = args.indexOf('--');

    expect(args.slice(separator + 1)).toEqual(['src', 'lib']);
    expect(args.filter((argument) => argument === '--regexp')).toHaveLength(2);
    expect(args).toContain('Alpha');
    expect(args).toContain('Beta');
  });

  it('searches the root when an assertion names no target', () => {
    expect(buildRipgrepArgs(request({ targets: [] })).at(-1)).toBe('.');
  });

  it('carries the shared file size limit', () => {
    expect(buildRipgrepArgs(request()).some((argument) => argument.startsWith('--max-filesize='))).toBe(true);
  });
});

describe('parseRipgrepErrors', () => {
  it('takes the path out of a per-file failure', () => {
    expect(parseRipgrepErrors('src/secret.txt: Permission denied (os error 13)')).toEqual(['src/secret.txt']);
  });

  it('strips ripgrep\'s own prefix', () => {
    expect(parseRipgrepErrors('rg: src/gone.txt: No such file or directory')).toEqual(['src/gone.txt']);
  });

  it('reads several lines, and ignores blank ones', () => {
    const stderr = 'a.txt: Permission denied\n\nb.txt: Permission denied\n';
    expect(parseRipgrepErrors(stderr)).toEqual(['a.txt', 'b.txt']);
  });

  it('handles CRLF, because Windows', () => {
    expect(parseRipgrepErrors('a.txt: denied\r\nb.txt: denied\r\n')).toEqual(['a.txt', 'b.txt']);
  });

  it('keeps a line it cannot parse rather than dropping it', () => {
    // An unexplained line from a subprocess is still evidence that something
    // went wrong, and silence is the failure mode being designed out.
    expect(parseRipgrepErrors('something unexpected')).toEqual(['something unexpected']);
  });

  it('reports nothing when ripgrep said nothing', () => {
    expect(parseRipgrepErrors('')).toEqual([]);
    expect(parseRipgrepErrors('\n\n')).toEqual([]);
  });
});
