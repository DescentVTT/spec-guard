/**
 * Globs on spec-core's automaton. ADR-0015.
 *
 * What each kind of pattern is read as, what is refused and in which words,
 * what ripgrep is handed for a pattern, and how long a match may take. The
 * readings themselves are spec-core's and tested there; what is tested here is
 * the choice of reading for each attribute, and the one piece of syntax this
 * repository still spells for itself - the globs handed to ripgrep - which is
 * held to spec-core's reading by brute force over a universe of paths.
 */

import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  createExcludeMatcher,
  createGlobMatcher,
  createPathMatcher,
  excludeListError,
  excludePatternError,
  expandSpecPatterns,
  globPatternError,
  globPredicate,
  globToRegExp,
  modulePatternError,
  moduleWitness,
  normalizeExclude,
  normalizeGlob,
  pathPatternError,
  patternListError,
  patternShape,
  ripgrepGlobs,
  type PatternShape,
} from '../src/glob.js';
import { EXIT_ERROR, EXIT_OK, main, type CliIO } from '../src/cli.js';
import { parseDirectives } from '../src/parser.js';
import { resolveDirective, runSpecGuard } from '../src/runner.js';
import { compileGlob } from '../src/vendor/spec-core/pattern/index.js';
import { makeTempRepo, memoryIo, removeTempRepo } from './helpers.js';

/* ------------------------------------------------------------ what is refused */

describe('a pattern spec-core cannot read', () => {
  it.each([
    ['src/[a.ts', 'a "[" is never closed'],
    ['*.{ts', 'a "{" is never closed'],
    ['+(a|b).ts', 'extended globs such as "+(a|b)" are not supported'],
    ['src/@(a|b)', 'extended globs such as "+(a|b)" are not supported'],
    ['!*.ts', 'a negated pattern is a list entry, not a glob; narrow the positive pattern'],
    ['../x/*.ts', 'a pattern cannot climb out of its root with ".."'],
    ['[z-a].ts', 'the range "z-a" runs backwards'],
    ['{a,}', 'the pattern names no path'],
  ])('is refused as a glob: %s', (pattern, reason) => {
    expect(globPatternError(pattern)).toBe(`invalid glob pattern "${pattern}": ${reason}`);
  });

  it.each([['*.ts'], ['}a.ts'], ['a,b'], ['**/x'], ['/src/*.ts'], ['src/'], ['x[}]y'], ['{a,{b,c}}'], ['[!a]*'], ['src\\*.ts']])(
    'is read as a glob: %s',
    (pattern) => {
      expect(globPatternError(pattern)).toBeNull();
    },
  );

  it('is refused as an exclusion, after the four shapes spec-guard refuses in its own words', () => {
    expect(excludePatternError('src/[a')).toBe('invalid exclude pattern "src/[a": a "[" is never closed');
    expect(excludePatternError('+(a|b)')).toBe('invalid exclude pattern "+(a|b)": extended globs such as "+(a|b)" are not supported');
    // spec-core refuses `!` and `..` too, in words that do not say what exclude
    // does with them: these keep the ones ADR-0014 wrote.
    expect(excludePatternError('!a')).toBe('invalid exclude pattern "!a": negation patterns are not supported in exclude');
    expect(excludePatternError('a/..')).toBe('invalid exclude pattern "a/..": ".." leads out of the root, and only paths inside it are searched');
    expect(excludeListError(['build', '{x'])).toBe('invalid exclude pattern "{x": a "{" is never closed');
  });

  it('is refused as a module or a layer, each in its own name', () => {
    expect(modulePatternError('[x')).toBe('invalid module pattern "[x": a "[" is never closed');
    expect(modulePatternError('[x', 'layer')).toBe('invalid layer pattern "[x": a "[" is never closed');
    expect(modulePatternError('node:fs')).toBeNull();
    expect(modulePatternError('@app/db/**')).toBeNull();
  });

  it('is refused as a whole-path pattern', () => {
    expect(pathPatternError('*/[a')).toBe('invalid glob pattern "*/[a": a "[" is never closed');
    expect(pathPatternError('**')).toBeNull();
  });

  it('is named first in a list, or nothing is', () => {
    expect(patternListError(['*.ts', '[a', '{b'], globPatternError)).toBe('invalid glob pattern "[a": a "[" is never closed');
    expect(patternListError(['*.ts', '*.js'], globPatternError)).toBeNull();
    expect(patternListError([], globPatternError)).toBeNull();
  });
});

/* ---------------------------------------------------- what each kind reads as */

describe('a whole-path pattern', () => {
  it('reads * as one segment and ** as any number of them', () => {
    expect(createPathMatcher('*')('api')).toBe(true);
    expect(createPathMatcher('*')('api/v1')).toBe(false);
    expect(createPathMatcher('**')('api/v1')).toBe(true);
    expect(createPathMatcher('*/v1')('api/v1')).toBe(true);
  });

  it('reads a literal as the one path it names, never a directory and its contents', () => {
    expect(createPathMatcher('packages')('packages')).toBe(true);
    expect(createPathMatcher('packages')('packages/api')).toBe(false);
    expect(createPathMatcher('README.md')('readme.md')).toBe(false);
  });

  it('reads a backslash as a separator', () => {
    expect(createPathMatcher('api\\*')('api/v1')).toBe(true);
  });

  it('throws for a pattern it cannot read', () => {
    expect(() => createPathMatcher('[a')).toThrow('invalid glob pattern "[a": a "[" is never closed');
  });
});

describe('a name a module pattern matches', () => {
  it('is the pattern itself for a literal, one just below it for a glob, and none for what is not a pattern', () => {
    expect(moduleWitness('node:fs')).toBe('node:fs');
    expect(moduleWitness('src/db')).toBe('src/db');
    expect(moduleWitness('@app/db/**')).toMatch(/^@app\/db\/[^/]+$/);
    expect(moduleWitness('[x')).toBeNull();
    // A path never holds a NUL, so nothing matches this.
    expect(moduleWitness('db\u0000')).toBeNull();
  });
});

describe('a module pattern', () => {
  it('covers what sits beneath it, and nothing that only starts the same way', () => {
    const matches = createExcludeMatcher(['node:fs']);
    expect(matches('node:fs')).toBe(true);
    expect(matches('node:fs/promises')).toBe(true);
    expect(matches('node:fsx')).toBe(false);
    expect(createExcludeMatcher(['App.Db'])('App.Db/Client')).toBe(true);
  });
});

/* ------------------------------------------------ how often the glob is asked */

describe('a predicate over one compiled glob', () => {
  /** A glob that answers from a set, and counts what it was asked. */
  const counting = (bases: string[], yes: string[]) => {
    const asked: string[] = [];
    return {
      asked,
      glob: {
        bases,
        match: (subject: string): boolean => {
          asked.push(subject);
          return yes.includes(subject);
        },
      },
    };
  };

  it('asks a one-segment glob about each last segment once, however many paths end in it', () => {
    const { glob, asked } = counting([''], ['a.ts']);
    const matches = globPredicate(glob, 'last');
    expect(['src/a.ts', 'lib/a.ts', 'a.ts', 'src/b.ts', 'lib/b.ts'].map(matches)).toEqual([true, true, true, false, false]);
    expect(asked).toEqual(['a.ts', 'b.ts']);
  });

  it('asks a one-segment exclusion about each segment once, and stops at the first that matches', () => {
    const { glob, asked } = counting([''], ['tests']);
    const excluded = globPredicate(glob, 'any');
    expect(['src/tests/a.ts', 'src/tests/b.ts', 'src/lib/a.ts', 'tests'].map(excluded)).toEqual([true, true, false, true]);
    expect(asked).toEqual(['src', 'tests', 'lib', 'a.ts']);
  });

  it('answers a path outside every base of an anchored glob without asking it', () => {
    const { glob, asked } = counting(['src/config', 'lib'], ['src/config/a.ts', 'lib/b.ts']);
    const matches = globPredicate(glob, 'whole');
    expect(['src/config/a.ts', 'src/configs/a.ts', 'src/a.ts', 'lib/b.ts', 'lib'].map(matches)).toEqual([true, false, false, true, false]);
    // `src/configs` starts with the letters of a base and is not below it.
    expect(asked).toEqual(['src/config/a.ts', 'lib/b.ts']);
  });

  it('asks about every path when a base is the root', () => {
    const { glob, asked } = counting(['src', ''], ['a/b']);
    expect(globPredicate(glob, 'whole')('a/b')).toBe(true);
    expect(asked).toEqual(['a/b']);
  });

  it.each<[string, 'include' | 'exclude', PatternShape]>([
    ['*.ts', 'include', 'last'],
    ['{a,b}.ts', 'include', 'last'],
    ['./*.ts', 'include', 'last'],
    ['**', 'include', 'last'],
    ['src/*.ts', 'include', 'whole'],
    ['src/', 'include', 'whole'],
    ['/*.ts', 'include', 'whole'],
    ['{src/*.ts,*.md}', 'include', 'whole'],
    ['tests', 'exclude', 'any'],
    ['tests/', 'exclude', 'any'],
    ['*.test.ts', 'exclude', 'any'],
    ['{tests,dist}', 'exclude', 'any'],
    ['/tests', 'exclude', 'whole'],
    ['src/tests', 'exclude', 'whole'],
    ['**/dist/**', 'exclude', 'whole'],
  ])('reads %s as an %s decided by %s of a path', (pattern, kind, shape) => {
    expect(patternShape(pattern, kind)).toBe(shape);
  });
});

/* ------------------------------------------------------ what ripgrep is handed */

describe('the globs ripgrep is handed', () => {
  it.each<[string, 'include' | 'exclude', string[]]>([
    ['*.ts', 'include', ['*.ts']],
    ['src/*.ts', 'include', ['src/*.ts']],
    ['./src/*.ts', 'include', ['src/*.ts']],
    ['src/', 'include', ['src/**']],
    ['src\\*.ts', 'include', ['src/*.ts']],
    [' *.ts ', 'include', ['*.ts']],
    // A leading slash anchors, for each alternative.
    ['/src/*.ts', 'include', ['/src/*.ts']],
    ['//src/*.ts', 'include', ['/src/*.ts']],
    ['/{a,b/c}', 'include', ['/a', '/b/c']],
    // Each alternative is anchored or not by its own shape.
    ['{src/*.ts,*.md}', 'include', ['src/*.ts', '*.md']],
    ['{a/b,c}/d', 'include', ['a/b/d', 'c/d']],
    ['{,src/}a.ts', 'include', ['a.ts', 'src/a.ts']],
    ['{./a,b}', 'include', ['a', 'b']],
    // `.` and empty segments are no segments.
    ['src/./a.ts', 'include', ['src/a.ts']],
    ['src//a.ts', 'include', ['src/a.ts']],
    // Groups nest, repeat once, and may be empty.
    ['{a,{b,c}}.ts', 'include', ['a.ts', 'b.ts', 'c.ts']],
    ['{a,a}.ts', 'include', ['a.ts']],
    ['a{}b', 'include', ['ab']],
    // A class hides what it holds from the braces, and keeps it.
    ['{[,]x,y}', 'include', ['[,]x', 'y']],
    ['x[}]y', 'include', ['x[}]y']],
    ['[]}]x', 'include', ['[]}]x']],
    ['[!}]x', 'include', ['[!}]x']],
    ['[^}]x', 'include', ['[^}]x']],
    // A negated class whose first member is `]` holds a comma, a brace, or both.
    ['{[!],]x,y}', 'include', ['[!],]x', 'y']],
    ['{[^],]x,y}', 'include', ['[^],]x', 'y']],
    ['{[]{]x,y}', 'include', ['[]{]x', 'y']],
    ['[[}]x', 'include', ['[[}]x']],
    // A `}` that closes nothing is a character.
    ['}a.ts', 'include', ['[}]a.ts']],
    ['a}{b,c}', 'include', ['a[}]b', 'a[}]c']],
    ['{a,b}}', 'include', ['a[}]', 'b[}]']],
    // An alternative that starts with `!` is a name, not a negation.
    ['{!a,b}', 'include', ['**/!a', 'b']],
    ['{!a,b}/c', 'include', ['/!a/c', 'b/c']],
    ['tests', 'exclude', ['tests']],
    ['/target', 'exclude', ['/target']],
    ['build/', 'exclude', ['build']],
    ['./src/config', 'exclude', ['src/config']],
    ['{src/tests,*.log}', 'exclude', ['src/tests', '*.log']],
    ['{!keep,tmp}', 'exclude', ['**/!keep', 'tmp']],
    [' tests/ ', 'exclude', ['tests']],
    ['//build', 'exclude', ['/build']],
  ])('%s as an %s is %j', (pattern, kind, globs) => {
    expect(ripgrepGlobs(kind === 'include' ? normalizeGlob(pattern) : normalizeExclude(pattern))).toEqual(globs);
  });

  // The paths every pattern below is tried against: every path of one to three
  // segments over names chosen to meet each piece of syntax, 3,615 of them.
  const NAMES = ['a', 'b', 'c', 'd', 'src', 'a.ts', 'a.md', '}a.ts', 'a}', 'x}y', '!a', '[a]', '{a}', 'tests', ',x'];
  const UNIVERSE: string[] = [];
  const grow = (prefix: string, depth: number): void => {
    for (const name of NAMES) {
      const next = prefix === '' ? name : `${prefix}/${name}`;
      UNIVERSE.push(next);
      if (depth > 1) grow(next, depth - 1);
    }
  };
  grow('', 3);

  const PATTERNS = [
    '*.ts',
    'src/*',
    '{src/*.ts,*.md}',
    '{,src/}a.ts',
    'src/./a.ts',
    'src//a.ts',
    '}a.ts',
    'a}',
    'x[}]y',
    '[]}]a.ts',
    '{a,{b,c}}',
    '{!a,b}',
    '{!a,b}/c',
    '/{a,src/a}.ts',
    '/*',
    '[{]a}',
    '{[,]x,y}',
    'a{}.ts',
    'x}{y,z}',
    '{a/b,c}/d',
    '**',
    'src/**',
    '{**,a}/b',
    '[!}]*',
    '{[!],]*,x}y',
    '{[]{]*,b}',
    '**/{tests,a}',
    '{src,tests}/**/*.ts',
  ];

  /**
   * What ripgrep reads one glob it is handed as, spelled for spec-core: a glob
   * with a leading `/` or any other `/` is anchored, and one without is a name
   * at any depth. tests/glob-parity.test.ts holds ripgrep itself to this
   * reading on a real tree. A `!` that follows the anchoring is a name to
   * both, but spec-core refuses one that starts a pattern, so it is escaped.
   */
  const asRipgrep = (glob: string, kind: 'include' | 'exclude'): ((candidate: string) => boolean) => {
    const spelled = glob.replace(/^(\/|\*\*\/)?!/, '$1\\!');
    const rooted = spelled.startsWith('/');
    const compiled =
      kind === 'exclude'
        ? compileGlob(spelled, { dialect: 'gitignore', caseSensitive: true })
        : rooted
          ? compileGlob(spelled.slice(1), { dialect: 'path', caseSensitive: true, literal: 'file' })
          : compileGlob(spelled, { dialect: 'ripgrep', caseSensitive: true });
    return (candidate) => compiled.match(candidate);
  };

  it.each(PATTERNS)('reads %s as spec-core does, on every path, as an inclusion and as an exclusion', (pattern) => {
    const include = createGlobMatcher([pattern]);
    const includes = ripgrepGlobs(normalizeGlob(pattern)).map((glob) => asRipgrep(glob, 'include'));
    const exclude = createExcludeMatcher([pattern]);
    const excludes = ripgrepGlobs(normalizeExclude(pattern)).map((glob) => asRipgrep(glob, 'exclude'));
    const disagreements = UNIVERSE.filter(
      (candidate) =>
        include(candidate) !== includes.some((matches) => matches(candidate)) ||
        exclude(candidate) !== excludes.some((matches) => matches(candidate)),
    );
    expect(disagreements).toEqual([]);
    // A pattern that matched nothing in the universe would prove nothing.
    expect(UNIVERSE.some((candidate) => include(candidate) || exclude(candidate))).toBe(true);
  });
});

/* -------------------------------------------------------- the oracle it replaced */

describe('against the RegExp it replaced', () => {
  // globToRegExp stays exported, and here it is the oracle: rebuilt into the
  // two matchers it used to drive, it must agree with spec-core on every
  // pattern both read the same way, and disagree exactly where ADR-0015 says.
  const oldInclude = (pattern: string) => {
    const regexp = globToRegExp(pattern);
    const byName = !pattern.includes('/');
    return (candidate: string): boolean => regexp.test(byName ? path.posix.basename(candidate) : candidate);
  };
  const oldExclude = (pattern: string) => {
    const regexp = globToRegExp(pattern);
    return (candidate: string): boolean => {
      const segments = candidate.split('/');
      if (!pattern.includes('/')) return segments.some((segment) => regexp.test(segment));
      return segments.some((_, at) => regexp.test(segments.slice(0, at + 1).join('/')));
    };
  };
  const NAMES = ['a', 'b', 'src', 'lib', 'a.ts', 'b.js', 'a.test.ts', 'x-y.md', 'tests', 'c.d.ts', '.hidden', 'a+b'];
  const UNIVERSE: string[] = [];
  const grow = (prefix: string, depth: number): void => {
    for (const name of NAMES) {
      const next = prefix === '' ? name : `${prefix}/${name}`;
      UNIVERSE.push(next);
      if (depth > 1) grow(next, depth - 1);
    }
  };
  grow('', 3);

  it.each([
    '*.ts',
    'src/*.ts',
    '**/*.ts',
    'src/**/*.ts',
    'src/**',
    '**/tests',
    'a?ts',
    '[ab].ts',
    '[!ab].ts',
    '{a,b}.ts',
    '{src,lib}/*.ts',
    '{*.ts,*.js}',
    '*.test.ts',
    'a+b',
    'c.d.ts',
    '.hidden',
    '[a-c]*',
    'tests',
    'src/a.ts',
  ])('agrees on %s', (pattern) => {
    const [include, exclude] = [createGlobMatcher([pattern]), createExcludeMatcher([pattern])];
    const [before, beforeExclude] = [oldInclude(pattern), oldExclude(pattern)];
    expect(UNIVERSE.filter((candidate) => include(candidate) !== before(candidate))).toEqual([]);
    expect(UNIVERSE.filter((candidate) => exclude(candidate) !== beforeExclude(candidate))).toEqual([]);
  });

  it('disagrees where ** sits inside a segment, which no longer crosses directories', () => {
    expect(oldInclude('src/**.ts')('src/lib/a.ts')).toBe(true);
    expect(createGlobMatcher(['src/**.ts'])('src/lib/a.ts')).toBe(false);
    expect(oldExclude('src/**.ts')('src/lib/a.ts')).toBe(true);
    expect(createExcludeMatcher(['src/**.ts'])('src/lib/a.ts')).toBe(false);
  });

  it('disagrees where a negated class met a separator, which no class matches', () => {
    expect(oldInclude('src[!a]lib/*.ts')('src/lib/a.ts')).toBe(true);
    expect(createGlobMatcher(['src[!a]lib/*.ts'])('src/lib/a.ts')).toBe(false);
  });

  it('disagrees where a malformed pattern was read as a literal, which is refused', () => {
    expect(oldInclude('a[b')('a[b')).toBe(true);
    expect(() => createGlobMatcher(['a[b'])).toThrow('invalid glob pattern "a[b"');
  });
});

/* ------------------------------------------------------------- how long it takes */

describe('a pattern that made the RegExp backtrack', () => {
  // `*-*-*-*-*-*x` compiled to six [^/]* groups, and against a 121-character
  // name of dashes V8 tries every way of dividing the name between them: 55
  // seconds, measured for ADR-0015. The automaton keeps a set of live
  // states, so its cost is the pattern's size times the name's length. The
  // bound is a thousand times what it takes, so that a loaded runner does not
  // fail it; the RegExp would take fifty-five of them.
  const NAME = '-'.repeat(121);

  it('fails a 121-character name in milliseconds, as an inclusion and as an exclusion', () => {
    expect(NAME).toHaveLength(121);
    const started = performance.now();
    expect(createGlobMatcher(['*-*-*-*-*-*x'])(`src/${NAME}`)).toBe(false);
    expect(createExcludeMatcher(['*-*-*-*-*-*x'])(`src/${NAME}`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('fails it in milliseconds inside a run, too', async () => {
    const root = path.resolve('/virtual/pathological');
    const io = memoryIo(root, {
      'docs/rules.md': '<!-- @assert-absence target="src" symbol="Legacy" glob="*-*-*-*-*-*x" allow-empty="true" -->\n',
      [`src/${NAME}`]: 'Legacy\n',
      'src/a-b-c-d-e-fx': 'Legacy\n',
    });
    const started = performance.now();
    const report = await runSpecGuard({ patterns: ['docs/rules.md'], root, io });
    expect(performance.now() - started).toBeLessThan(2000);
    // The name that ends in x is the one the glob reaches.
    expect(report.results[0]?.matches.map((match) => match.file)).toEqual(['src/a-b-c-d-e-fx']);
  });
});

/* ------------------------------------------------------------- the spec patterns */

describe('spec patterns', () => {
  const root = path.resolve('/virtual/specs');
  const io = memoryIo(root, {
    'repo/README.md': '',
    'repo/docs/a.md': '',
    'repo/docs/adr/b.md': '',
    'shared/docs/c.md': '',
    'shared/docs/deep/d.md': '',
  });
  const repo = path.join(root, 'repo');
  const expand = (patterns: string[]) => expandSpecPatterns(patterns, repo, undefined, io);
  const inRepo = (...files: string[]) => files.map((file) => path.join(repo, file)).sort();

  it('reads a pattern with no slash by name at any depth, as glob= does', async () => {
    expect(await expand(['*.md'])).toEqual(inRepo('README.md', 'docs/a.md', 'docs/adr/b.md'));
    expect(await expand(['./*.md'])).toEqual(inRepo('README.md', 'docs/a.md', 'docs/adr/b.md'));
  });

  it('reads a pattern with a slash as the whole path', async () => {
    expect(await expand(['docs/*.md'])).toEqual(inRepo('docs/a.md'));
    expect(await expand(['docs/**/*.md'])).toEqual(inRepo('docs/a.md', 'docs/adr/b.md'));
    expect(await expand(['{docs/*.md,README.md}'])).toEqual(inRepo('README.md', 'docs/a.md'));
  });

  it('walks from a base outside the root, which a glob may not name', async () => {
    expect(await expand(['../shared/docs/*.md'])).toEqual([path.join(root, 'shared/docs/c.md')]);
    expect(await expand([`${root}/shared/docs/**/*.md`.split(path.sep).join('/')])).toEqual(
      [path.join(root, 'shared/docs/c.md'), path.join(root, 'shared/docs/deep/d.md')].sort(),
    );
  });

  it('refuses a pattern spec-core cannot read, naming it as written', async () => {
    await expect(expand(['docs/[a.md'])).rejects.toThrow('invalid spec pattern "docs/[a.md": a "[" is never closed');
    await expect(expand(['docs/*/../*.md'])).rejects.toThrow('invalid spec pattern "docs/*/../*.md": a pattern cannot climb out of its root with ".."');
  });
});

/* -------------------------------------------------------------- in a directive */

describe('a directive with a pattern that cannot be read', () => {
  const LOCATION = { file: path.resolve('/virtual/docs/a.md'), relativeFile: 'docs/a.md' };
  const errorOf = (source: string): string => {
    const { directives, errors } = parseDirectives(source, LOCATION);
    expect(errors).toEqual([]);
    const resolved = resolveDirective(directives[0] as NonNullable<(typeof directives)[0]>, {
      root: path.resolve('/virtual'),
      excludeFiles: new Set(),
    });
    if (!('error' in resolved)) throw new Error('expected an error');
    return resolved.error.message;
  };

  it.each([
    [
      '<!-- @assert-absence target="src" symbol="X" glob="src/[a.ts" -->',
      'Attribute "glob" has an invalid glob pattern "src/[a.ts": a "[" is never closed.',
    ],
    [
      '<!-- @assert-count target="src" symbol="X" min="1" glob="*.ts, +(a|b).ts" -->',
      'Attribute "glob" has an invalid glob pattern "+(a|b).ts": extended globs such as "+(a|b)" are not supported.',
    ],
    [
      '<!-- @assert-absence target="src" symbol="X" exclude="gen/{a" -->',
      'Attribute "exclude" has an invalid exclude pattern "gen/{a": a "{" is never closed.',
    ],
    [
      '<!-- @assert-import-absence target="src" module="db, [x" -->',
      'Attribute "module" has an invalid module pattern "[x": a "[" is never closed.',
    ],
    [
      '<!-- @assert-layers target="src" order="domain, @(a|b)" -->',
      'Attribute "order" has an invalid layer pattern "@(a|b)": extended globs such as "+(a|b)" are not supported.',
    ],
    [
      '<!-- @assert-structure target="packages" dirs="[a" required="package.json" -->',
      'Attribute "dirs" has an invalid glob pattern "[a": a "[" is never closed.',
    ],
    [
      '<!-- @assert-structure target="packages" required="*.{csproj" -->',
      'Required entry "*.{csproj" has an invalid glob pattern "*.{csproj": a "{" is never closed.',
    ],
  ])('%s', (source, message) => {
    expect(errorOf(source)).toBe(message);
  });

  it('says what went wrong when a brace group was split at its comma', () => {
    // A list attribute splits on commas, so this was always `*.{ts` and `tsx}`:
    // two literals to the scanner, and a failed ripgrep.
    expect(errorOf('<!-- @assert-absence target="src" symbol="X" glob="*.{ts,tsx}" -->')).toBe(
      'Attribute "glob" has an invalid glob pattern "*.{ts": a "{" is never closed. A list attribute splits on commas, so a {a,b} group cannot be written in one: list each pattern instead.',
    );
    expect(errorOf('<!-- @assert-absence target="src" symbol="X" exclude="{gen,dist}" -->')).toContain('A list attribute splits on commas');
    // Without a comma inside braces, the reason is the whole story.
    expect(errorOf('<!-- @assert-absence target="src" symbol="X" glob="a,{b" -->')).not.toContain('splits on commas');
  });
});

/* --------------------------------------------------------- on the command line */

describe('the command line', () => {
  const temporary: string[] = [];
  afterAll(async () => {
    await Promise.all(temporary.splice(0).map(removeTempRepo));
  });

  async function run(files: Record<string, string>, argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
    const root = await makeTempRepo(files);
    temporary.push(root);
    const out: string[] = [];
    const err: string[] = [];
    const cli: CliIO = { stdout: (text) => out.push(text), stderr: (text) => err.push(text), env: { NO_COLOR: '1' }, cwd: root, isTTY: false };
    return { code: await main(argv, cli), out, err };
  }

  const PROJECT = {
    'docs/rules.md': '<!-- @assert-absence target="src" symbol="LegacyClient" -->\n',
    'src/main.ts': 'export {};\n',
    'src/gen/a.ts': 'LegacyClient;\n',
    'src/gen/b.ts': 'LegacyClient;\n',
  };

  it('exits 2 for a spec pattern it cannot read, naming the pattern', async () => {
    const { code, out, err } = await run(PROJECT, ['docs/[rules.md', '--engine', 'js']);
    expect(code).toBe(EXIT_ERROR);
    expect(out).toEqual([]);
    expect(err).toEqual(['spec-guard: invalid spec pattern "docs/[rules.md": a "[" is never closed']);
  });

  it('exits 2 for an exclusion it cannot read, given as an option or in the configuration', async () => {
    const option = await run(PROJECT, ['--exclude', 'src/[gen', '--engine', 'js']);
    expect(option.code).toBe(EXIT_ERROR);
    expect(option.err[0]).toBe('Option --exclude has an invalid exclude pattern "src/[gen": a "[" is never closed.');

    const configured = await run({ ...PROJECT, '.spec-guard.json': JSON.stringify({ exclude: ['+(gen|out)'] }) }, ['--engine', 'js']);
    expect(configured.code).toBe(EXIT_ERROR);
    expect(configured.err).toEqual([
      'spec-guard: .spec-guard.json: "exclude" has an invalid exclude pattern "+(gen|out)": extended globs such as "+(a|b)" are not supported.',
    ]);
  });

  it('reads a brace group in the configuration, where a comma does not split it', async () => {
    const { code, out } = await run({ ...PROJECT, '.spec-guard.json': JSON.stringify({ exclude: ['src/{gen,out}'] }) }, ['--engine', 'js']);
    expect(code).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('options from .spec-guard.json: exclude (src/{gen,out})');
  });
});
