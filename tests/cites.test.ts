/**
 * `spec-guard cites`: the specs code comments cite. ADR-0017.
 *
 * The scanner first, since everything rests on it: what an id is, where one
 * ends, and every shape that looks like one and is not. Then the documents a
 * family names and the number each file name gives it, the families a
 * project's specs imply, and the scan itself - over every comment syntax the
 * classifier knows, with the same ids in strings beside them to show a string
 * is never read. Then a corpus shaped like a Rust workspace citing its ADRs,
 * the command line, and a tree of thousands of files against a budget.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  citeFilesError,
  citeIdError,
  CitesError,
  deriveFamilies,
  documentNumber,
  findCitations,
  findDocuments,
  inComments,
  isStale,
  numberKey,
  parseFilesTemplate,
  parseIdTemplate,
  qualified,
  scanCitations,
  type CitesOptions,
} from '../src/cites.js';
import { EXIT_ERROR, EXIT_FAILED, EXIT_OK, main, parseArgs, UsageError, type CliIO } from '../src/cli.js';
import { citesAnnotations, formatCites, formatCitesJson, formatCitesSarif, formatGitlab } from '../src/reporter.js';
import type { CitesReport } from '../src/types.js';
import { FIXTURES_DIR, makeTempRepo, memoryIo, removeTempRepo } from './helpers.js';

const ROOT = path.resolve('/virtual/cites');
const ADR = parseIdTemplate('ADR-{n}');

/** What a scan of one text found: the ids as written, with their numbers. */
const ids = (text: string, templates = [ADR]): Array<[string, string]> =>
  scanCitations(text, templates).map((citation) => [citation.written, citation.number]);

/* ---------------------------------------------------------------- templates */

describe('an id template', () => {
  it('is read as the literal text around {n}', () => {
    expect(parseIdTemplate('ADR-{n}')).toEqual({ prefix: 'ADR-', suffix: '' });
    expect(parseIdTemplate('Q-{n}-x')).toEqual({ prefix: 'Q-', suffix: '-x' });
    expect(parseIdTemplate('RFC {n}')).toEqual({ prefix: 'RFC ', suffix: '' });
  });

  it('is refused without {n}, with it twice, with nothing before it, with another brace, or with a digit beside it', () => {
    expect(citeIdError('ADR-{n}')).toBeNull();
    expect(citeIdError('#{n}')).toBeNull();
    expect(citeIdError('ADR-')).toBe('"ADR-" has no {n}: an id template says where the number goes, as in ADR-{n}');
    expect(citeIdError('ADR-{n}-{n}')).toBe('"ADR-{n}-{n}" has {n} more than once, and an id holds one number');
    expect(citeIdError('{n}')).toBe('"{n}" has nothing before {n}, so every number in every comment would be a citation');
    expect(citeIdError(' {n}')).toBe('" {n}" has nothing before {n}, so every number in every comment would be a citation');
    expect(citeIdError('{n}-ADR')).toBe('"{n}-ADR" has nothing before {n}, so every number in every comment would be a citation');
    expect(citeIdError('ADR{x}-{n}')).toBe('"ADR{x}-{n}" holds a brace other than {n}, and the rest of an id is literal');
    expect(citeIdError('ADR-{n}}')).toBe('"ADR-{n}}" holds a brace other than {n}, and the rest of an id is literal');
    expect(citeIdError('A1{n}')).toBe('"A1{n}" has a digit beside {n}, where it would run into the number');
    expect(citeIdError('A-{n}2')).toBe('"A-{n}2" has a digit beside {n}, where it would run into the number');
    expect(citeIdError('A2-{n}')).toBeNull();
  });
});

describe('a files template', () => {
  it('is read as a glob with the number as *, and the file name around the number', () => {
    expect(parseFilesTemplate('docs/adr/{n}-*.md')).toEqual({ glob: 'docs/adr/*-*.md', before: '', after: '-*.md' });
    expect(parseFilesTemplate('docs\\rfcs\\rfc-{n}.md')).toEqual({ glob: 'docs/rfcs/rfc-*.md', before: 'rfc-', after: '.md' });
    expect(parseFilesTemplate('{n}')).toEqual({ glob: '*', before: '', after: '' });
    // A star just after the number is taken in: `**.md` is a glob spec-core refuses.
    expect(parseFilesTemplate('docs/adr/{n}*.md')).toEqual({ glob: 'docs/adr/*.md', before: '', after: '*.md' });
    expect(parseFilesTemplate('docs/**/ADR-{n}*.md')).toEqual({ glob: 'docs/**/ADR-*.md', before: 'ADR-', after: '*.md' });
  });

  it('is refused without {n}, with it twice, with it in a directory, with glob syntax before it, a digit beside it, or a pattern spec-core refuses', () => {
    expect(citeFilesError('docs/adr/{n}-*.md')).toBeNull();
    expect(citeFilesError('docs/**/ADR-{n}*.md')).toBeNull();
    expect(citeFilesError('docs/adr/*.md')).toBe('"docs/adr/*.md" has no {n}: a files template says where the number is, as in docs/adr/{n}-*.md');
    expect(citeFilesError('docs/{n}/{n}.md')).toBe('"docs/{n}/{n}.md" has {n} more than once, and a file name holds one number');
    expect(citeFilesError('docs/{n}/x.md')).toBe('"docs/{n}/x.md" has {n} in a directory, and the number is read from the file name');
    expect(citeFilesError('docs/*-{n}.md')).toBe('"docs/*-{n}.md" has glob syntax before {n} in the file name, which has to be literal to say where the number starts');
    expect(citeFilesError('docs/v2{n}.md')).toBe('"docs/v2{n}.md" has a digit beside {n}, where it would run into the number');
    expect(citeFilesError('docs/{n}1.md')).toBe('"docs/{n}1.md" has a digit beside {n}, where it would run into the number');
    expect(citeFilesError('docs/adr/{n}*.md')).toBeNull();
    expect(citeFilesError('docs/adr/{n}**.md')).toBe(
      '"docs/adr/{n}**.md": invalid glob pattern "docs/adr/**.md": "**" means any number of directories only as a whole segment: write "docs/**/*.md" for any depth, or "*.md" for one level',
    );
    expect(citeFilesError('docs/[a/{n}.md')).toMatch(/^"docs\/\[a\/\{n\}\.md": invalid glob pattern "docs\/\[a\/\*\.md": /);
  });

  it('gives a document the digits of its file name, and nothing to a path that is not one of its documents', () => {
    const adr = documentNumber('docs/adr/{n}-*.md');
    expect(adr('docs/adr/0007-ledger.md')).toBe('0007');
    expect(adr('docs/adr/12-x.md')).toBe('12');
    expect(adr('docs/adr/0007x.md')).toBeNull();
    expect(adr('docs/adr/x-0007.md')).toBeNull();
    expect(adr('docs/adr/0007-x.txt')).toBeNull();
    expect(adr('docs/other/0007-x.md')).toBeNull();
    expect(adr('docs/adr/deep/0007-x.md')).toBeNull();

    const rfc = documentNumber('docs/rfcs/rfc-{n}.md');
    expect(rfc('docs/rfcs/rfc-12.md')).toBe('12');
    expect(rfc('docs/rfcs/rfc-12a.md')).toBeNull();
    expect(rfc('docs/rfcs/rfc-.md')).toBeNull();
    expect(rfc('docs/rfcs/xrfc-12.md')).toBeNull();

    const bare = documentNumber('notes/{n}');
    expect(bare('notes/42')).toBe('42');
    expect(bare('notes/42.md')).toBeNull();

    const anywhere = documentNumber('docs/**/ADR-{n}*.md');
    expect(anywhere('docs/ADR-3.md')).toBe('3');
    expect(anywhere('docs/a/b/ADR-0003-x.md')).toBe('0003');
  });

  it('compares numbers as numbers', () => {
    expect([numberKey('0007'), numberKey('7'), numberKey('007'), numberKey('0'), numberKey('000'), numberKey('10'), numberKey('100'), numberKey('0100')]).toEqual(['7', '7', '7', '0', '0', '10', '100', '100']);
  });
});

/* ------------------------------------------------------------------ scanner */

describe('the scanner', () => {
  it('finds the prefix, a run of digits, and the suffix, reading the number as a number', () => {
    expect(ids('see ADR-7, ADR-007 and ADR-0007.')).toEqual([
      ['ADR-7', '7'],
      ['ADR-007', '7'],
      ['ADR-0007', '7'],
    ]);
    expect(ids('ADR-0 and ADR-10')).toEqual([
      ['ADR-0', '0'],
      ['ADR-10', '10'],
    ]);
    expect(ids('Q-3-x and Q-4-y', [parseIdTemplate('Q-{n}-x')])).toEqual([['Q-3-x', '3']]);
  });

  it('keeps a word boundary on both sides', () => {
    // Must-not-match: a letter, digit or underscore running into either end.
    for (const text of ['XADR-1', 'ADR-12a', 'ADR-1_', '_ADR-1', 'éADR-1', 'ADR-1é', '9ADR-1', 'ADR-', 'ADR-x', 'adr-1']) {
      expect(ids(text), text).toEqual([]);
    }
    // Must-match: punctuation, space, a line's end and the text's ends are boundaries.
    for (const text of ['ADR-12.', '(ADR-12)', 'ADR-12-style', "ADR-12's", 'x/ADR-12', 'ADR-12\n', '"ADR-12"', 'ADR-12']) {
      expect(ids(text), text).toEqual([['ADR-12', '12']]);
    }
  });

  it('needs no boundary before a prefix that does not begin with a word character, and none after a suffix that does not end with one', () => {
    expect(ids('issue#12 and #13', [parseIdTemplate('#{n}')])).toEqual([
      ['#12', '12'],
      ['#13', '13'],
    ]);
    expect(ids('Q-3-!x', [parseIdTemplate('Q-{n}-!')])).toEqual([['Q-3-!', '3']]);
    expect(ids('Q-3-xy', [parseIdTemplate('Q-{n}-x')])).toEqual([]);
  });

  it('reads several families, in order of position, and each only where it is written', () => {
    const templates = [ADR, parseIdTemplate('RFC-{n}')];
    expect(scanCitations('RFC-2 then ADR-1 then RFC-3', templates).map(({ family, written, start, end }) => [family, written, start, end])).toEqual([
      [1, 'RFC-2', 0, 5],
      [0, 'ADR-1', 11, 16],
      [1, 'RFC-3', 22, 27],
    ]);
  });

  it('keeps the order of the templates for ids that begin at one place', () => {
    const templates = [parseIdTemplate('ADR-{n}-x'), ADR];
    expect(scanCitations('ADR-1-x', templates).map(({ family, written }) => [family, written])).toEqual([
      [0, 'ADR-1-x'],
      [1, 'ADR-1'],
    ]);
    expect(scanCitations('ADR-1-x', [...templates].reverse()).map(({ family, written }) => [family, written])).toEqual([
      [0, 'ADR-1'],
      [1, 'ADR-1-x'],
    ]);
  });

  it('reads an id at either end of the text, and a suffix the text ends before', () => {
    expect(ids('ADR-12')).toEqual([['ADR-12', '12']]);
    expect(ids('ADR-3-', [parseIdTemplate('ADR-{n}-x')])).toEqual([]);
  });
});

describe('an id another owner qualifies', () => {
  const at = (text: string): boolean => qualified(text, text.indexOf('ADR-'));

  it('is another project\'s after a possessive, or a name with a hyphen or slash in it', () => {
    for (const text of ["spec-core's ADR-5", 'spec-core’s ADR-5', "graph's ADR-5", 'its ADR-12', 'Its ADR-12', 'their ADR-3', 'spec-graph ADR-17', 'org/repo ADR-9', 'upstream-crate  ADR-1', 'x\tspec-core\tADR-1']) {
      expect(at(text), text).toBe(true);
    }
  });

  it('is this project\'s after an ordinary word, punctuation, or nothing', () => {
    // Must-not-match.
    for (const text of ['see ADR-7', 'per ADR-7', '(ADR-7)', 'e.g. ADR-7', 'ADR-7', 'and ADR-7', 're: ADR-7', 'it ADR-7', 'itself ADR-7', 'cf. ADR-7', 's ADR-7', "' ADR-7", "'s ADR-7", '- ADR-7', 'a- ADR-7', 'spec-core,ADR-7', 'spec-coreADR-7', 'bits ADR-7', "it's ADR-7", "That's ADR-7", 'here’s ADR-7', "let's ADR-7", "this's ADR-7", "there's ADR-7", "what's ADR-7", "who's ADR-7", "where's ADR-7", "how's ADR-7", "when's ADR-7", "why's ADR-7", "he's ADR-7", "she's ADR-7"]) {
      expect(at(text), text).toBe(false);
    }
  });

  it('is another owner\'s in a link: after a slash, an anchor, a query or anywhere past a ://', () => {
    for (const text of [
      'See https://github.com/org/repo/blob/main/docs/adr/ADR-0042.md',
      '.../docs/ADR-0099.html',
      'docs/ADR-0099.html',
      'page.html#ADR-7',
      'https://example.com/?id=ADR-7',
      'https://example.com/search?ADR-7',
      'https://example.com/adr/decision-ADR-7',
      '<https://example.com/(ADR-7)>',
    ]) {
      expect(at(text), text).toBe(true);
    }
    // Must-not-match: a link beside an id, not around it.
    for (const text of ['ADR-7 is at https://example.com/', 'https://example.com ADR-7', 'see: ADR-7', 'x=1; ADR-7', 'a://b\nADR-7']) {
      expect(at(text), text).toBe(false);
    }
  });
});

describe('the citations inside comments', () => {
  it('are those that start and end inside one, whatever lies between', () => {
    const text = 'ADR-1 /* ADR-2 */ ADR-3 // ADR-4\n"ADR-5"';
    const comments: Array<[number, number]> = [
      [6, 17],
      [24, 32],
    ];
    expect(inComments(scanCitations(text, [ADR]), comments).map(({ written }) => written)).toEqual(['ADR-2', 'ADR-4']);
    // One that runs past the comment's end is not inside it.
    expect(inComments(scanCitations('x ADR-12 y', [ADR]), [[0, 7]])).toEqual([]);
    expect(inComments(scanCitations('x ADR-12 y', [ADR]), [])).toEqual([]);
  });

  it('are kept when they start where a comment starts, end where it ends, or start where the comment before ends', () => {
    const kept = (text: string, comments: Array<[number, number]>): string[] => inComments(scanCitations(text, [ADR]), comments).map(({ written }) => written);
    expect(kept('ADR-1', [[0, 5]])).toEqual(['ADR-1']);
    // Two comments touching: the first ends where the id starts.
    expect(kept('/**/ADR-2', [
      [0, 4],
      [4, 9],
    ])).toEqual(['ADR-2']);
  });
});

/* ---------------------------------------------------------------- documents */

describe('which statuses are stale', () => {
  it('are the words that retire a document, not the ones that mean not yet', () => {
    expect(['superseded', 'deprecated', 'rejected', 'archived'].map(isStale)).toEqual([true, true, true, true]);
    expect(['draft', 'proposed', 'accepted', 'done', undefined].map(isStale)).toEqual([false, false, false, false, false]);
  });
});

describe('the documents of a family', () => {
  it('are found below the literal base, by number, with each one\'s title and status, and duplicates kept', async () => {
    const io = memoryIo(ROOT, {
      'docs/adr/0001-a.md': '# ADR-0001: A\n\n## Status\n\nAccepted.\n',
      'docs/adr/0001-b.md': '# ADR-0001: B\n',
      'docs/adr/0002-c.md': '**Status:** Superseded by ADR-0003\n',
      'docs/adr/README.md': '',
      'docs/adr/node_modules/0003-x.md': '',
      'docs/other/0004-d.md': '',
    });
    const documents = await findDocuments({ id: 'ADR-{n}', files: 'docs/adr/{n}-*.md' }, ROOT, io, true);
    expect([...documents].map(([key, list]) => [key, list.map(({ file, spelled, title, status }) => [file, spelled, title, status?.value])])).toEqual([
      [
        '1',
        [
          ['docs/adr/0001-a.md', '0001', 'ADR-0001: A', 'accepted'],
          ['docs/adr/0001-b.md', '0001', 'ADR-0001: B', undefined],
        ],
      ],
      ['2', [['docs/adr/0002-c.md', '0002', undefined, 'superseded']]],
    ]);
    // The default skips apply, and --no-default-skips reads them too.
    expect([...(await findDocuments({ id: 'ADR-{n}', files: 'docs/adr/**/{n}-*.md' }, ROOT, io, false)).keys()]).toEqual(['1', '2', '3']);
    expect([...(await findDocuments({ id: 'ADR-{n}', files: 'docs/adr/**/{n}-*.md' }, ROOT, io, true)).keys()]).toEqual(['1', '2']);
  });

  it('are walked from the root when the template has no literal directory, and an unreadable one has no status', async () => {
    const base = memoryIo(ROOT, { '0001-x.md': '# ADR-0001: X\n\n**Status:** deprecated\n', '0002-y.md': 'x' });
    const io = { ...base, readFile: async (file: string) => (file.endsWith('0002-y.md') ? Promise.reject(new Error('EACCES')) : base.readFile(file)) };
    const documents = await findDocuments({ id: 'ADR-{n}', files: '{n}-*.md' }, ROOT, io, true);
    expect([...documents].map(([key, [first]]) => [key, first?.file, first?.status?.value])).toEqual([
      ['1', '0001-x.md', 'deprecated'],
      ['2', '0002-y.md', undefined],
    ]);
  });
});

describe('the families a project\'s specs imply', () => {
  it('are one per directory of numbered specs titled with one id and their own number', () => {
    expect(
      deriveFamilies([
        { file: 'docs/adr/0001-a.md', title: 'ADR-0001: A' },
        { file: 'docs/adr/0002-b.md', title: 'ADR-2 - B' },
        // A number later in a name is not a series' number.
        { file: 'docs/adr/v2-notes.md', title: 'Notes' },
        { file: 'docs/adr/README.md', title: 'Decisions' },
        { file: 'docs/rfcs/12-x.md', title: 'RFC-12: X' },
        { file: 'README.md' },
      ]),
    ).toEqual({
      families: [
        { id: 'ADR-{n}', files: 'docs/adr/{n}*.md' },
        { id: 'RFC-{n}', files: 'docs/rfcs/{n}*.md' },
      ],
      notes: [],
    });
  });

  it('are not guessed at when a title disagrees with its file, lacks an id, or another prefix is used, or the titles are missing', () => {
    const note = (where: string): string =>
      `${where} holds numbered specs whose titles do not all begin with one id and their own number, such as ADR-0001 in 0001-x.md, so how they are cited is not guessed; name them in "cites" to check citations of them`;
    const cases: Array<Array<{ file: string; title?: string }>> = [
      [{ file: 'docs/adr/0001-a.md', title: 'ADR-0002: wrong number' }],
      [{ file: 'docs/adr/0001-a.md', title: 'Use Postgres' }],
      [
        { file: 'docs/adr/0001-a.md', title: 'ADR-0001: A' },
        { file: 'docs/adr/0002-b.md', title: 'DEC-0002: B' },
      ],
      [{ file: 'docs/adr/0001-a.md' }],
      [{ file: 'docs/adr/0001-a.md', title: 'ADR-0001a: glued' }],
      [{ file: 'docs/adr/0001-a.md', title: 'ADR 0001: spaced' }],
      [{ file: 'docs/adr/0001-a.md', title: 'See ADR-0001: an id, but not first' }],
    ];
    for (const documents of cases) expect(deriveFamilies(documents), JSON.stringify(documents)).toEqual({ families: [], notes: [note('docs/adr')] });
    expect(deriveFamilies([{ file: '0001-a.md', title: 'x' }]).notes).toEqual([note('the root')]);
  });

  it('are named for their directory and their extension, which a mixed series leaves open', () => {
    expect(deriveFamilies([{ file: '0001-a.md', title: 'ADR-1: A' }]).families).toEqual([{ id: 'ADR-{n}', files: '{n}*.md' }]);
    expect(
      deriveFamilies([
        { file: 'd/0001-a.md', title: 'ADR-1: A' },
        { file: 'd/0002-a.markdown', title: 'ADR-2: A' },
      ]).families,
    ).toEqual([{ id: 'ADR-{n}', files: 'd/{n}*' }]);
    // In path order, whatever order the specs came in.
    expect(
      deriveFamilies([
        { file: 'z/1-a.md', title: 'Z-1: A' },
        { file: 'a/1-a.md', title: 'A-1: A' },
      ]).families.map(({ id }) => id),
    ).toEqual(['A-{n}', 'Z-{n}']);
  });
});

/* --------------------------------------------------------------------- scan */

const DOCS = {
  'docs/adr/0001-kept.md': '# ADR-0001: Kept\n\n## Status\n\nAccepted.\n',
  'docs/adr/0002-old.md': '# ADR-0002: Old\n\n## Status\n\nSuperseded by ADR-0003.\n',
  'docs/adr/0003-new.md': '# ADR-0003: New\n\n## Status\n\nAccepted.\n',
  'docs/adr/0004-gone.md': '# ADR-0004: Gone\n\n**Status:** Deprecated\n',
  'docs/adr/0005-maybe.md': '# ADR-0005: Maybe\n\n**Status:** Proposed\n',
  'docs/adr/0006-sketch.md': '# ADR-0006: Sketch\n\n**Status:** draft\n',
  'docs/adr/0009-far.md': '# ADR-0009: Far\n',
};

async function cites(files: Record<string, string | Buffer>, options: Partial<CitesOptions> = {}): Promise<CitesReport> {
  return findCitations({ root: ROOT, patterns: ['docs/**/*.md'], io: memoryIo(ROOT, { ...DOCS, ...files }), ...options });
}

/** Each finding as `file:line rule id`. */
const found = (report: CitesReport): string[] => report.findings.map((finding) => `${finding.file}:${finding.line}:${finding.column} ${finding.rule} ${finding.cited}`);

describe('a scan', () => {
  it('reads citations in every comment syntax the classifier knows, and never in a string beside them', async () => {
    const report = await cites({
      'src/a.ts': '// ADR-0007 line\n/* ADR-0008 block */\n/** ADR-0010 doc */\nconst s = "ADR-0011"; const t = `ADR-0012`; const r = /ADR-0013/;\n',
      'src/b.py': '# ADR-0014 hash\ns = "ADR-0015"\n"""ADR-0016 docstring, a string"""\n',
      'src/c.rs': '//! ADR-0017 inner doc\n/// ADR-0018 outer doc\n/* a /* ADR-0019 nested */ ADR-0020 */\nlet s = r#"ADR-0021"#;\nfn f<\'a>(x: &\'a str) {} // it\'s ADR-0022\n',
      'src/d.go': '// ADR-0023\nvar s = `ADR-0024`\n',
      'src/e.cs': '// ADR-0025\nvar s = @"ADR-0026";\n',
      'src/f.sh': '# ADR-0027\necho "ADR-0028" # ADR-0029\n',
      'src/g.yaml': '# ADR-0030\nname: ADR-0031 # ADR-0032\n',
      'src/h.sql': '-- ADR-0033\nSELECT \'ADR-0034\';\n',
      'src/i.html': '<!-- ADR-0035 -->\n<p>ADR-0036</p>\n',
      'src/j.c': '// ADR-0037\nchar *s = "ADR-0038";\n',
      'src/k.toml': '# ADR-0039\nx = "ADR-0040"\n',
    });
    expect(report.findings.map((finding) => finding.cited)).toEqual([
      'ADR-0007', 'ADR-0008', 'ADR-0010',
      'ADR-0014',
      'ADR-0017', 'ADR-0018', 'ADR-0019', 'ADR-0020', 'ADR-0022',
      'ADR-0023',
      'ADR-0025',
      'ADR-0027', 'ADR-0029',
      'ADR-0030', 'ADR-0032',
      'ADR-0033',
      'ADR-0035',
      'ADR-0037',
      'ADR-0039',
    ]);
    expect(report.findings.every((finding) => finding.rule === 'ghost-citation')).toBe(true);
    expect(report.summary).toEqual({ files: 11, citations: 19, ghosts: 19, stale: 0, qualified: 0, unclassified: 0 });
  });

  it('reports a ghost with the nearest ids on either side, and a stale document with the one that replaced it', async () => {
    const report = await cites({
      'src/a.ts': [
        '// ADR-0007 is not written: 6 and 9 are its neighbours',
        '// ADR-0000 is below them all, and ADR-0010 above',
        '// ADR-0002 was superseded by ADR-0003',
        '// ADR-0004 was deprecated, and nothing replaced it',
        '// ADR-0005 and ADR-0006 are not yet in force, which is not stale',
        '// ADR-0001 holds',
        '',
      ].join('\n'),
    });
    expect(report.findings).toEqual([
      {
        rule: 'ghost-citation',
        severity: 'error',
        file: 'src/a.ts',
        line: 1,
        column: 4,
        cited: 'ADR-0007',
        family: 'ADR-{n}',
        message: 'src/a.ts:1 cites ADR-0007, which no document defines',
        hint: 'no document matching docs/adr/{n}*.md has the number 7; the nearest are ADR-0006 and ADR-0009',
      },
      {
        rule: 'ghost-citation',
        severity: 'error',
        file: 'src/a.ts',
        line: 2,
        column: 4,
        cited: 'ADR-0000',
        family: 'ADR-{n}',
        message: 'src/a.ts:2 cites ADR-0000, which no document defines',
        hint: 'no document matching docs/adr/{n}*.md has the number 0; the nearest is ADR-0001',
      },
      {
        rule: 'ghost-citation',
        severity: 'error',
        file: 'src/a.ts',
        line: 2,
        column: 36,
        cited: 'ADR-0010',
        family: 'ADR-{n}',
        message: 'src/a.ts:2 cites ADR-0010, which no document defines',
        hint: 'no document matching docs/adr/{n}*.md has the number 10; the nearest is ADR-0009',
      },
      {
        rule: 'stale-citation',
        severity: 'warning',
        file: 'src/a.ts',
        line: 3,
        column: 4,
        cited: 'ADR-0002',
        family: 'ADR-{n}',
        document: 'docs/adr/0002-old.md',
        status: 'superseded',
        successor: 'ADR-0003',
        message: 'src/a.ts:3 cites ADR-0002, which is superseded - cite ADR-0003 instead',
        hint: 'docs/adr/0002-old.md says "Superseded by ADR-0003."',
      },
      {
        rule: 'stale-citation',
        severity: 'warning',
        file: 'src/a.ts',
        line: 4,
        column: 4,
        cited: 'ADR-0004',
        family: 'ADR-{n}',
        document: 'docs/adr/0004-gone.md',
        status: 'deprecated',
        message: 'src/a.ts:4 cites ADR-0004, which is deprecated',
        hint: 'docs/adr/0004-gone.md says "Deprecated", and names no successor in force; cite the decision in force instead, or take the citation out',
      },
    ]);
    expect(report.summary).toMatchObject({ citations: 9, ghosts: 3, stale: 2 });
    // A stale citation alone is a warning; the ghosts are what fail it.
    expect(report.ok).toBe(false);
    expect((await cites({ 'src/a.ts': '// ADR-0002\n' })).ok).toBe(true);
  });

  it('follows a successor that is itself replaced, stops at one that is not a document or names nothing new, and survives a loop', async () => {
    const report = await cites(
      { 'src/a.ts': '// ADR-0001\n// ADR-0002\n// ADR-0003\n// ADR-0004\n// ADR-0005\n' },
      {
        io: memoryIo(ROOT, {
          'docs/adr/0001-a.md': '**Status:** superseded by ADR-0002',
          'docs/adr/0002-b.md': '**Status:** superseded by ADR-0003, and ADR-0002 is this one',
          'docs/adr/0003-c.md': '**Status:** accepted',
          'docs/adr/0004-d.md': '**Status:** superseded by ADR-0099',
          'docs/adr/0005-e.md': '**Status:** superseded by ADR-0006',
          'docs/adr/0006-f.md': '**Status:** superseded by ADR-0005',
          'src/a.ts': '// ADR-0001\n// ADR-0002\n// ADR-0003\n// ADR-0004\n// ADR-0005\n',
        }),
        families: [{ id: 'ADR-{n}', files: 'docs/adr/{n}-*.md' }],
      },
    );
    expect(report.findings.map((finding) => [finding.cited, finding.successor, finding.message.split(' - ')[1], finding.hint])).toEqual([
      [
        'ADR-0001',
        'ADR-0003',
        'cite ADR-0003 instead',
        'docs/adr/0001-a.md says "superseded by ADR-0002"; it was followed through ADR-0002, which is not in force either, to ADR-0003',
      ],
      ['ADR-0002', 'ADR-0003', 'cite ADR-0003 instead', 'docs/adr/0002-b.md says "superseded by ADR-0003, and ADR-0002 is this one"'],
      [
        'ADR-0004',
        undefined,
        undefined,
        'docs/adr/0004-d.md says "superseded by ADR-0099", and names no successor in force; cite the decision in force instead, or take the citation out',
      ],
      [
        'ADR-0005',
        undefined,
        undefined,
        'docs/adr/0005-e.md says "superseded by ADR-0006", and names no successor in force; cite the decision in force instead, or take the citation out',
      ],
    ]);
  });

  it('skips the document itself where its status names it, and stops in a loop the chain runs into', async () => {
    const report = await cites(
      { 'src/a.ts': '// ADR-2\n// ADR-5\n' },
      {
        io: memoryIo(ROOT, {
          'd/2-b.md': '**Status:** superseded: ADR-2 gave way to ADR-3',
          'd/3-c.md': '',
          'd/5-e.md': '**Status:** superseded by ADR-6',
          'd/6-f.md': '**Status:** superseded by ADR-7',
          'd/7-g.md': '**Status:** superseded by ADR-6',
          'src/a.ts': '// ADR-2\n// ADR-5\n',
        }),
        families: [{ id: 'ADR-{n}', files: 'd/{n}-*.md' }],
      },
    );
    expect(report.findings.map((finding) => [finding.cited, finding.successor, finding.hint])).toEqual([
      ['ADR-2', 'ADR-3', 'd/2-b.md says "superseded: ADR-2 gave way to ADR-3"'],
      ['ADR-5', undefined, 'd/5-e.md says "superseded by ADR-6", and names no successor in force; cite the decision in force instead, or take the citation out'],
    ]);
  });

  it('names the nearest numbers, not the nearest names, when numbers are not padded', async () => {
    const report = await cites(
      { 'src/a.ts': '// ADR-5\n' },
      { io: memoryIo(ROOT, { 'd/9-a.md': '', 'd/10-b.md': '', 'd/2-c.md': '', 'src/a.ts': '// ADR-5\n' }), families: [{ id: 'ADR-{n}', files: 'd/{n}-*.md' }] },
    );
    expect(report.findings[0]?.hint).toBe('no document matching d/{n}-*.md has the number 5; the nearest are ADR-2 and ADR-9');
  });

  it('says so when a chain of more than one stale successor is followed', async () => {
    const report = await cites(
      { 'src/a.ts': '// ADR-1\n' },
      {
        io: memoryIo(ROOT, {
          'd/1-a.md': '**Status:** superseded by ADR-2',
          'd/2-b.md': '**Status:** superseded by ADR-3',
          'd/3-c.md': '**Status:** deprecated, see ADR-4',
          'd/4-d.md': '',
          'src/a.ts': '// ADR-1\n',
        }),
        families: [{ id: 'ADR-{n}', files: 'd/{n}-*.md' }],
      },
    );
    expect(report.findings[0]?.hint).toBe('d/1-a.md says "superseded by ADR-2"; it was followed through ADR-2, ADR-3, which are not in force either, to ADR-4');
  });

  it('is in force while any document with the number is, and reads a successor in any family', async () => {
    const report = await cites(
      { 'src/a.ts': '// ADR-1 and ADR-2\n' },
      {
        io: memoryIo(ROOT, {
          'd/1-a.md': '**Status:** superseded',
          'd/1-b.md': '**Status:** accepted',
          'd/2-c.md': '**Status:** superseded by RFC-7',
          'r/rfc-7.md': '',
          'src/a.ts': '// ADR-1 and ADR-2\n',
        }),
        families: [
          { id: 'ADR-{n}', files: 'd/{n}-*.md' },
          { id: 'RFC-{n}', files: 'r/rfc-{n}.md' },
        ],
      },
    );
    expect(found(report)).toEqual(['src/a.ts:1:14 stale-citation ADR-2']);
    expect(report.findings[0]?.message).toBe('src/a.ts:1 cites ADR-2, which is superseded - cite RFC-7 instead');
  });

  it('makes one finding of one id on one line, however it is spelled, and one per line and per id', async () => {
    const report = await cites({ 'src/a.ts': '// ADR-7, ADR-007 and ADR-0007\n// ADR-7 again\n// ADR-8, ADR-7\n' });
    expect(found(report)).toEqual([
      'src/a.ts:1:4 ghost-citation ADR-7',
      'src/a.ts:2:4 ghost-citation ADR-7',
      'src/a.ts:3:4 ghost-citation ADR-8',
      'src/a.ts:3:11 ghost-citation ADR-7',
    ]);
    expect(report.summary.citations).toBe(4);
  });

  it('leaves another owner\'s ids unchecked, and counts them', async () => {
    const report = await cites({ 'src/a.ts': "// spec-core's ADR-0042, spec-graph ADR-0017 and its ADR-0099\n// but ADR-0042 is ours\n" });
    expect(found(report)).toEqual(['src/a.ts:2:8 ghost-citation ADR-0042']);
    expect(report.summary).toMatchObject({ citations: 1, qualified: 3 });
  });

  it('leaves an id in a link unchecked, where it was a ghost', async () => {
    // The review's two comments: each named a document no family here finds,
    // and each was a ghost-citation that failed the run.
    const report = await cites({
      'src/a.ts': '// See https://github.com/org/repo/blob/main/docs/adr/ADR-0042.md\n// .../docs/ADR-0099.html\n// and ADR-0099 is ours\n',
    });
    expect(found(report)).toEqual(['src/a.ts:3:8 ghost-citation ADR-0099']);
    expect(report.summary).toMatchObject({ citations: 1, ghosts: 1, qualified: 2 });
  });

  it('reads no Markdown, no spec file, no cited document, nothing excluded, and nothing in a format without comments', async () => {
    const report = await cites(
      {
        'README.md': '<!-- ADR-0099 -->\n',
        'notes/a.markdown': '<!-- ADR-0099 -->\n',
        'notes/b.mdx': '<!-- ADR-0099 -->\n',
        'docs/spec.html': '<!-- ADR-0099 -->',
        'docs/adr/0007-x.html': '<!-- ADR-0099 -->',
        'build/out.js': '// ADR-0099\n',
        'node_modules/pkg/index.js': '// ADR-0099\n',
        'data.json': '{ "a": "ADR-0099" }',
        'logo.png': 'ADR-0099',
        Makefile: '# ADR-0099',
        'src/a.ts': '// ADR-0001\n',
      },
      {
        patterns: ['docs/**/*.md', 'docs/spec.html'],
        families: [
          { id: 'ADR-{n}', files: 'docs/adr/{n}-*.md' },
          { id: 'X-{n}', files: 'docs/adr/{n}-*.html' },
        ],
        exclude: ['build'],
      },
    );
    expect(report.findings).toEqual([]);
    expect(report.summary).toEqual({ files: 1, citations: 1, ghosts: 0, stale: 0, qualified: 0, unclassified: 2 });
    expect(report.unclassified).toEqual([
      { extension: '(none)', files: 1 },
      { extension: '.png', files: 1 },
    ]);
    expect(report.exclude).toEqual(['build']);
    // node_modules is read when the default skips are off.
    const everything = await cites({ 'node_modules/pkg/index.js': '// ADR-0099\n' }, { defaultSkips: false });
    expect(found(everything)).toEqual(['node_modules/pkg/index.js:1:4 ghost-citation ADR-0099']);
  });

  it('counts the unclassified extensions most common first, then by name', async () => {
    const report = await cites({ 'a.png': '', 'b.png': '', 'c.bin': '', 'd.ai': '', 'src/a.ts': '// ADR-0001\n' });
    expect(report.unclassified).toEqual([
      { extension: '.png', files: 2 },
      { extension: '.ai', files: 1 },
      { extension: '.bin', files: 1 },
    ]);
    expect(report.summary.unclassified).toBe(4);
  });

  it('reads only the paths it is given, each once, a file or a directory', async () => {
    const files = { 'src/a.ts': '// ADR-0099\n', 'src/deep/b.ts': '// ADR-0098\n', 'src/deep/c.ts': '// ADR-0096\n', 'lib/c.ts': '// ADR-0097\n' };
    expect(found(await cites(files, { paths: ['src/deep', 'lib/c.ts', 'src/deep/b.ts'] }))).toEqual([
      'lib/c.ts:1:4 ghost-citation ADR-0097',
      'src/deep/b.ts:1:4 ghost-citation ADR-0098',
      'src/deep/c.ts:1:4 ghost-citation ADR-0096',
    ]);
    expect(found(await cites(files, { paths: ['.'] }))).toHaveLength(4);
    // A path that is not there holds nothing, and is not an error to the API;
    // the command line refuses it before it gets here.
    expect(found(await cites(files, { paths: ['nowhere'] }))).toEqual([]);
  });

  it('reads no more than the engine\'s read limit of files at once', async () => {
    const files = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`src/f${index}.ts`, '// ADR-0001\n']));
    const base = memoryIo(ROOT, { ...DOCS, ...files });
    let open = 0;
    let most = 0;
    const io = {
      ...base,
      readFile: async (file: string) => {
        open += 1;
        most = Math.max(most, open);
        await new Promise((resolve) => setTimeout(resolve, 1));
        open -= 1;
        return base.readFile(file);
      },
    };
    const report = await findCitations({ root: ROOT, patterns: ['docs/**/*.md'], io });
    expect(report.summary.files).toBe(40);
    expect(most).toBe(16);
  });

  it('takes as long as it says it took', async () => {
    const before = performance.now();
    const report = await cites({ 'src/a.ts': '// ADR-0001\n' });
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.durationMs).toBeLessThanOrEqual(performance.now() - before);
  });

  it('names each file it could not read in full, and passes under --strict only when there are none', async () => {
    const base = memoryIo(ROOT, {
      ...DOCS,
      'src/a.ts': '// ADR-0001\n',
      'src/bin.ts': Buffer.from('// ADR-0099\u0000'),
      'src/lost.ts': '// ADR-0001\nconst s = "never closed;\n/* ADR-0098',
      'src/locked.ts': '// ADR-0097\n',
      'src/huge.ts': Buffer.alloc(20 * 1024 * 1024 + 1, 32),
    });
    const io = { ...base, readFile: async (file: string) => (file.endsWith('locked.ts') ? Promise.reject(new Error('EACCES: denied')) : base.readFile(file)) };
    const report = await findCitations({ root: ROOT, patterns: ['docs/**/*.md'], io });
    expect(report.gaps).toEqual([
      { file: 'src/bin.ts', reason: 'binary', detail: 'holds a NUL byte, so it is not text' },
      { file: 'src/huge.ts', reason: 'too-large', detail: 'is larger than 20 MB, which no search reads' },
      { file: 'src/locked.ts', reason: 'unreadable', detail: 'could not be read: EACCES: denied' },
      { file: 'src/lost.ts', reason: 'lost-scan', detail: 'a string or comment was never closed, so what follows it may be misread' },
    ]);
    // What was read of the lost file still counts.
    expect(found(report)).toEqual(['src/lost.ts:3:4 ghost-citation ADR-0098']);
    expect(report.summary.files).toBe(2);
    expect((await findCitations({ root: ROOT, patterns: ['docs/**/*.md'], io, paths: ['src/a.ts'], strict: true })).ok).toBe(true);
    expect((await findCitations({ root: ROOT, patterns: ['docs/**/*.md'], io, paths: ['src/a.ts', 'src/bin.ts'], strict: true })).ok).toBe(false);
    expect((await findCitations({ root: ROOT, patterns: ['docs/**/*.md'], io, paths: ['src/a.ts', 'src/bin.ts'] })).ok).toBe(true);
  });

  it('under --strict makes a stale citation an error, and fails on it', async () => {
    const plain = await cites({ 'src/a.ts': '// ADR-0002\n' });
    const strict = await cites({ 'src/a.ts': '// ADR-0002\n' }, { strict: true });
    expect([plain.ok, plain.findings[0]?.severity]).toEqual([true, 'warning']);
    expect([strict.ok, strict.findings[0]?.severity]).toEqual([false, 'error']);
    expect((await cites({ 'src/a.ts': '// ADR-0001\n' }, { strict: true })).ok).toBe(true);
  });

  it('reads the families off the specs when none are given, and says why when it cannot', async () => {
    const derived = await cites({ 'src/a.ts': '// ADR-0099\n' });
    expect(derived.families).toEqual([{ id: 'ADR-{n}', files: 'docs/adr/{n}*.md', source: 'derived', documents: 7 }]);
    expect(derived.notes).toEqual([]);

    const untitled = await findCitations({ root: ROOT, patterns: ['docs/**/*.md'], io: memoryIo(ROOT, { 'docs/adr/0001-a.md': 'no title', 'src/a.ts': '// ADR-0099\n' }) });
    expect(untitled.families).toEqual([]);
    expect(untitled.notes).toEqual([
      'docs/adr holds numbered specs whose titles do not all begin with one id and their own number, such as ADR-0001 in 0001-x.md, so how they are cited is not guessed; name them in "cites" to check citations of them',
      'nothing to look for: "cites" names no documents, and no directory of numbered specs titles them with an id such as ADR-0001, so no citation was read; name them in "cites"',
    ]);
    expect([untitled.ok, untitled.summary.files]).toEqual([true, 0]);
    // Under --strict a check that looked for nothing refuses to be clean.
    expect((await findCitations({ root: ROOT, patterns: ['docs/**/*.md'], io: memoryIo(ROOT, { 'docs/a.md': '' }), strict: true })).ok).toBe(false);
    // And so does one that read no source file.
    expect((await cites({}, { strict: true })).ok).toBe(false);
    expect((await cites({}, { families: [] })).notes).toEqual(['nothing to look for: "cites" is an empty list']);
  });

  it('refuses a family whose files match no document, since every citation of it would be a ghost', async () => {
    await expect(cites({}, { families: [{ id: 'ADR-{n}', files: 'doc/adr/{n}-*.md' }] })).rejects.toThrow(
      new CitesError("no document matches doc/adr/{n}-*.md, so every citation of ADR-{n} would be reported as a ghost; check the files pattern against the documents' names"),
    );
  });

  it('gives the same answer every time, in path order', async () => {
    const files = { 'z.ts': '// ADR-0099\n', 'a/b.ts': '// ADR-0098\n', 'a.ts': '// ADR-0097\n', 'A.ts': '// ADR-0096\n' };
    const first = await cites(files);
    const second = await cites(files);
    expect(found(first)).toEqual(['A.ts:1:4 ghost-citation ADR-0096', 'a.ts:1:4 ghost-citation ADR-0097', 'a/b.ts:1:4 ghost-citation ADR-0098', 'z.ts:1:4 ghost-citation ADR-0099']);
    expect(formatCitesJson({ ...second, durationMs: 0 })).toBe(formatCitesJson({ ...first, durationMs: 0 }));
  });
});

/* ------------------------------------------------------------------- corpus */

describe('a Rust workspace citing its ADRs', () => {
  const CORPUS = path.join(FIXTURES_DIR, 'cites-corpus');

  it('finds each ghost and stale citation, and nothing in its strings, raw strings, lifetimes or Markdown', async () => {
    const report = await findCitations({
      root: CORPUS,
      patterns: ['docs/**/*.md'],
      families: [
        { id: 'ADR-{n}', files: 'docs/adr/{n}-*.md' },
        { id: 'RFC-{n}', files: 'docs/rfcs/rfc-{n}.md' },
      ],
    });
    expect(report.findings.map((finding) => [`${finding.file}:${finding.line}`, finding.rule, finding.cited, finding.successor ?? null])).toEqual([
      ['crates/ledger/src/journal.rs:1', 'stale-citation', 'ADR-0007', 'ADR-0009'],
      ['crates/ledger/src/journal.rs:10', 'stale-citation', 'ADR-0007', 'ADR-0009'],
      ['crates/ledger/src/lib.rs:14', 'stale-citation', 'ADR-0003', 'ADR-0009'],
      ['crates/ledger/src/lib.rs:25', 'stale-citation', 'ADR-0005', null],
      ['crates/ledger/src/lib.rs:28', 'ghost-citation', 'ADR-0011', null],
      ['crates/net/src/wire.rs:3', 'stale-citation', 'ADR-0004', null],
      ['crates/net/src/wire.rs:3', 'stale-citation', 'ADR-0006', 'ADR-0008'],
      ['crates/net/src/wire.rs:8', 'stale-citation', 'RFC-13', null],
      ['crates/net/src/wire.rs:8', 'ghost-citation', 'RFC-14', null],
      ['scripts/release.sh:2', 'ghost-citation', 'ADR-0012', null],
    ]);
    expect(report.summary).toEqual({ files: 6, citations: 21, ghosts: 3, stale: 7, qualified: 2, unclassified: 1 });
    expect(report.gaps).toEqual([]);
    expect(report.notes).toEqual([]);
    expect(report.families.map(({ id, documents, source }) => [id, documents, source])).toEqual([
      ['ADR-{n}', 10, 'config'],
      ['RFC-{n}', 2, 'config'],
    ]);
  });

  it('is read the same from its own configuration by the command line, and exits 1 for its ghosts', async () => {
    const { code, out, err } = await run(['cites', '--root', CORPUS, '--json']);
    expect([code, err]).toEqual([EXIT_FAILED, []]);
    const json = JSON.parse(out.join('\n')) as { formatVersion: number; summary: CitesReport['summary']; config: unknown };
    expect(json.formatVersion).toBe(1);
    expect(json.summary).toEqual({ files: 6, citations: 21, ghosts: 3, stale: 7, qualified: 2, unclassified: 1 });
    expect(json.config).toEqual({ file: '.spec-guard.json', applied: ['specs', 'cites'], overridden: [] });
  });
});

/* ------------------------------------------------------------------ reports */

async function run(argv: string[], cwd = ROOT): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { stdout: (text) => out.push(text), stderr: (text) => err.push(text), env: { NO_COLOR: '1' }, cwd, isTTY: false };
  return { code: await main(argv, io), out, err };
}

describe('the report', () => {
  let report: CitesReport;
  beforeAll(async () => {
    report = await cites({
      'src/a.ts': "// ADR-0007 and ADR-0002\n// spec-core's ADR-0005\n",
      'src/lost.ts': 'const s = "open\n',
      'logo.png': '',
    });
  });

  it('reads, for a person, each finding with its hint, what was not read, and how it ended', () => {
    expect(formatCites({ ...report, durationMs: 12 }, { color: false, verbose: false })).toBe(
      [
        "spec-guard cites ADR-{n} (7 documents matching docs/adr/{n}*.md, read off the specs' titles)",
        '',
        '✖ src/a.ts:1 cites ADR-0007, which no document defines  ghost-citation',
        '    hint: no document matching docs/adr/{n}*.md has the number 7; the nearest are ADR-0006 and ADR-0009',
        '⚠ src/a.ts:1 cites ADR-0002, which is superseded - cite ADR-0003 instead  stale-citation',
        '    hint: docs/adr/0002-old.md says "Superseded by ADR-0003."',
        '',
        '○ 1 file could not be read in full, so a citation in it may have been missed:',
        '    src/lost.ts a string or comment was never closed, so what follows it may be misread',
        '',
        '○ 1 file in no language spec-guard knows the comments of, and not read: .png 1',
        '',
        "○ 1 id names another project's document, as spec-core's ADR-0005 does, and was not checked",
        '',
        '2 citations in 2 files · 1 ghost · 1 stale · 12ms',
        '✖ 1 citation names a document that does not exist',
      ].join('\n'),
    );
  });

  it('ends on what matters most: a ghost, nothing looked for, nothing read, a stale citation, or every one in force', async () => {
    const last = (value: CitesReport): string => formatCites(value, { color: false, verbose: false, ascii: true }).split('\n').at(-1) as string;
    expect(last(report)).toBe('x 1 citation names a document that does not exist');
    expect(last({ ...report, summary: { ...report.summary, ghosts: 2 } })).toBe('x 2 citations name a document that does not exist');
    const clean = { ...report, findings: [], gaps: [], summary: { ...report.summary, ghosts: 0, stale: 0 } };
    expect(last({ ...clean, families: [] })).toBe('! no citation was looked for, so nothing was checked');
    expect(last({ ...clean, summary: { ...clean.summary, files: 0 } })).toBe('! no source file was read, so nothing was checked');
    expect(last({ ...clean, summary: { ...clean.summary, stale: 1 }, ok: true })).toBe('! 1 citation names a document no longer in force');
    expect(last({ ...clean, summary: { ...clean.summary, stale: 3 }, ok: false })).toBe('x 3 citations name a document no longer in force');
    expect(last(clean)).toBe('+ every citation names a document in force');
    // With nothing to say about files or families, those lines are not there at all.
    const bare = formatCites({ ...clean, unclassified: [], summary: { ...clean.summary, unclassified: 0, qualified: 0 }, durationMs: 1 }, { color: false, verbose: false });
    expect(bare.split('\n')).toEqual([
      "spec-guard cites ADR-{n} (7 documents matching docs/adr/{n}*.md, read off the specs' titles)",
      '',
      '2 citations in 2 files · 1ms',
      '✔ every citation names a document in force',
    ]);
    expect(formatCites({ ...clean, families: [], notes: ['why'], durationMs: 1 }, { color: false, verbose: false }).split('\n').slice(0, 3)).toEqual([
      'spec-guard cites no families',
      '',
      '○ 1 file in no language spec-guard knows the comments of, and not read: .png 1',
    ]);
  });

  it('names a configured family without saying where it came from, and counts files and ids in the plural', () => {
    const configured: CitesReport = {
      ...report,
      families: [{ id: 'ADR-{n}', files: 'docs/adr/{n}-*.md', source: 'config', documents: 1 }],
      findings: [],
      gaps: [
        { file: 'a.ts', reason: 'binary', detail: 'holds a NUL byte, so it is not text' },
        { file: 'b.ts', reason: 'lost-scan', detail: 'a string or comment was never closed, so what follows it may be misread' },
      ],
      unclassified: [],
      notes: ['a note'],
      summary: { files: 3, citations: 0, ghosts: 0, stale: 0, qualified: 2, unclassified: 0 },
      config: { file: '.spec-guard.json', applied: ['cites'], overridden: [] },
      durationMs: 1,
    };
    expect(formatCites(configured, { color: false, verbose: false }).split('\n')).toEqual([
      'spec-guard cites ADR-{n} (1 document matching docs/adr/{n}-*.md)',
      '',
      '○ 2 files could not be read in full, so a citation in them may have been missed:',
      '    a.ts holds a NUL byte, so it is not text',
      '    b.ts a string or comment was never closed, so what follows it may be misread',
      '',
      "○ 2 ids name another project's document, as spec-core's ADR-0005 does, and were not checked",
      '',
      '○ a note',
      '',
      'options from .spec-guard.json: cites',
      '',
      '0 citations in 3 files · 1ms',
      '✔ every citation names a document in force',
    ]);
  });

  it('paints a ghost red and a stale citation yellow, when colour is on', () => {
    const painted = formatCites(report, { color: true, verbose: false });
    expect(painted).toContain('\u001b[31m\u001b[1m✖\u001b[0m src/a.ts:1 cites ADR-0007');
    expect(painted).toContain('\u001b[33m\u001b[1m⚠\u001b[0m src/a.ts:1 cites ADR-0002');
  });

  it('is versioned JSON for a script', () => {
    const json = JSON.parse(formatCitesJson({ ...report, durationMs: 1.23456 })) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual(['formatVersion', 'ok', 'root', 'durationMs', 'families', 'summary', 'findings', 'gaps', 'unclassified', 'notes', 'exclude']);
    expect(json['formatVersion']).toBe(1);
    expect(json['durationMs']).toBe(1.235);
    expect(json['findings']).toEqual(report.findings);
  });

  it('is SARIF with each finding on its comment, its hint beneath, and a fingerprint that survives the comment moving', () => {
    const sarif = JSON.parse(formatCitesSarif(report, { version: '9.9.9' })) as {
      runs: Array<{
        invocations?: Array<{ executionSuccessful: boolean; toolExecutionNotifications: Array<{ level: string; message: { text: string } }> }>;
        tool: { driver: { name: string; version: string; rules: Array<{ id: string }> } };
        results: Array<{ ruleId: string; level: string; message: { text: string }; locations: unknown[]; partialFingerprints: { specGuardCitation: string } }>;
      }>;
    };
    const [runOf] = sarif.runs;
    expect(runOf?.tool.driver.name).toBe('spec-guard cites');
    expect(runOf?.tool.driver.version).toBe('9.9.9');
    expect(runOf?.tool.driver.rules.map((rule) => rule.id)).toEqual(['ghost-citation', 'stale-citation']);
    expect(runOf?.results.map(({ ruleId, level, message }) => [ruleId, level, message.text])).toEqual([
      ['ghost-citation', 'error', 'src/a.ts:1 cites ADR-0007, which no document defines\nno document matching docs/adr/{n}*.md has the number 7; the nearest are ADR-0006 and ADR-0009'],
      ['stale-citation', 'warning', 'src/a.ts:1 cites ADR-0002, which is superseded - cite ADR-0003 instead\ndocs/adr/0002-old.md says "Superseded by ADR-0003."'],
    ]);
    expect(runOf?.results[0]?.locations).toEqual([{ physicalLocation: { artifactLocation: { uri: 'src/a.ts' }, region: { startLine: 1, startColumn: 4 } } }]);
    const moved = { ...report, findings: report.findings.map((finding) => ({ ...finding, line: finding.line + 10 })) };
    const fingerprints = (value: CitesReport) =>
      (JSON.parse(formatCitesSarif(value)) as typeof sarif).runs[0]?.results.map((result) => result.partialFingerprints.specGuardCitation);
    expect(fingerprints(moved)).toEqual(fingerprints(report));
    expect(new Set(fingerprints(report)).size).toBe(2);
    expect(runOf?.invocations).toEqual([
      {
        executionSuccessful: false,
        toolExecutionNotifications: [{ level: 'warning', message: { text: 'src/lost.ts a string or comment was never closed, so what follows it may be misread' } }],
      },
    ]);
    const quiet = JSON.parse(formatCitesSarif({ ...report, gaps: [], notes: [] })) as typeof sarif;
    expect(quiet.runs[0]).not.toHaveProperty('invocations');
    const noted = JSON.parse(formatCitesSarif({ ...report, gaps: [], notes: ['a note'] })) as typeof sarif;
    expect(noted.runs[0]?.invocations?.[0]?.toolExecutionNotifications).toEqual([{ level: 'note', message: { text: 'a note' } }]);
  });

  it('places each finding, and each file read in part, for GitLab and GitHub', () => {
    expect(citesAnnotations(report)).toEqual([
      {
        rule: 'ghost-citation',
        identity: ['ghost-citation', 'src/a.ts', 'ADR-{n}', 'ADR-0007'],
        level: 'error',
        severity: 'critical',
        file: 'src/a.ts',
        line: 1,
        message: 'src/a.ts:1 cites ADR-0007, which no document defines. no document matching docs/adr/{n}*.md has the number 7; the nearest are ADR-0006 and ADR-0009',
      },
      {
        rule: 'stale-citation',
        identity: ['stale-citation', 'src/a.ts', 'ADR-{n}', 'ADR-0002'],
        level: 'warning',
        severity: 'minor',
        file: 'src/a.ts',
        line: 1,
        message: 'src/a.ts:1 cites ADR-0002, which is superseded - cite ADR-0003 instead. docs/adr/0002-old.md says "Superseded by ADR-0003."',
      },
      {
        rule: 'unread-comments',
        identity: ['unread-comments', 'src/lost.ts', 'lost-scan'],
        level: 'notice',
        severity: 'info',
        file: 'src/lost.ts',
        line: 1,
        message: 'src/lost.ts a string or comment was never closed, so what follows it may be misread, so a citation in it may have been missed',
      },
    ]);
    const strict = { ...report, findings: report.findings.map((finding) => ({ ...finding, severity: 'error' as const })) };
    expect(citesAnnotations(strict).map(({ level, severity }) => [level, severity])).toEqual([
      ['error', 'critical'],
      ['error', 'critical'],
      ['notice', 'info'],
    ]);
    expect((JSON.parse(formatGitlab(citesAnnotations(report))) as unknown[]).length).toBe(3);
  });
});

/* -------------------------------------------------------------- command line */

describe('spec-guard cites', () => {
  let root: string;
  beforeAll(async () => {
    root = await makeTempRepo({
      'docs/adr/0001-a.md': '# ADR-0001: A\n',
      'docs/adr/0002-b.md': '# ADR-0002: B\n\n**Status:** superseded by ADR-0001\n',
      'src/a.ts': '// ADR-0001\n',
      'src/b.ts': '// ADR-0002\n',
      'src/c.ts': '// ADR-0003\n',
    });
  });
  afterAll(async () => {
    await removeTempRepo(root);
  });

  it('exits 1 for a ghost, 0 for only a stale citation, and 1 for one under --strict', async () => {
    expect((await run(['cites'], root)).code).toBe(EXIT_FAILED);
    expect((await run(['cites', 'src/a.ts', 'src/b.ts'], root)).code).toBe(EXIT_OK);
    expect((await run(['cites', 'src/b.ts', '--strict'], root)).code).toBe(EXIT_FAILED);
    expect((await run(['cites', 'src/a.ts', '--strict'], root)).code).toBe(EXIT_OK);
  });

  it('writes each format', async () => {
    const human = await run(['cites'], root);
    expect(human.out[0]).toMatch(/^spec-guard cites ADR-\{n\} \(2 documents matching docs\/adr\/\{n\}\*\.md, read off the specs' titles\)\n/);
    expect(JSON.parse((await run(['cites', '--json'], root)).out[0] as string)).toMatchObject({ formatVersion: 1, summary: { ghosts: 1, stale: 1 } });
    expect(JSON.parse((await run(['cites', '--format', 'sarif'], root)).out[0] as string)).toMatchObject({ version: '2.1.0' });
    expect((JSON.parse((await run(['cites', '--format', 'gitlab'], root)).out[0] as string) as Array<{ check_name: string }>).map((issue) => issue.check_name)).toEqual([
      'stale-citation',
      'ghost-citation',
    ]);
    expect((await run(['cites', '--format', 'github'], root)).out).toEqual([
      [
        '::warning file=src/b.ts,line=1,title=stale-citation::src/b.ts:1 cites ADR-0002, which is superseded - cite ADR-0001 instead. docs/adr/0002-b.md says "superseded by ADR-0001"',
        '::error file=src/c.ts,line=1,title=ghost-citation::src/c.ts:1 cites ADR-0003, which no document defines. no document matching docs/adr/{n}*.md has the number 3; the nearest is ADR-0002',
      ].join('\n'),
    ]);
    expect((await run(['cites', 'src/a.ts', '--format', 'github'], root)).out).toEqual([]);
  });

  it('exits 2 for a path outside the root or not there, a family with no documents, and a configuration that cannot be used', async () => {
    const outside = await run(['cites', '../elsewhere'], root);
    expect([outside.code, outside.err[0]]).toEqual([EXIT_ERROR, `spec-guard: "../elsewhere" is outside the root ${root.replace(/\\/g, '/')}.`]);
    const missing = await run(['cites', 'src/nope.ts'], root);
    expect([missing.code, missing.err]).toEqual([EXIT_ERROR, ['spec-guard: "src/nope.ts" does not exist, so there are no comments in it to read']]);

    const configured = await makeTempRepo({
      '.spec-guard.json': JSON.stringify({ cites: [{ id: 'ADR-{n}', files: 'decisions/{n}-*.md' }] }),
      'src/a.ts': '// ADR-0001\n',
    });
    const broken = await makeTempRepo({ '.spec-guard.json': JSON.stringify({ cites: [{ id: 'ADR', files: 'd/{n}.md' }] }) });
    try {
      const none = await run(['cites'], configured);
      expect([none.code, none.err]).toEqual([
        EXIT_ERROR,
        ["spec-guard: no document matches decisions/{n}-*.md, so every citation of ADR-{n} would be reported as a ghost; check the files pattern against the documents' names"],
      ]);
      const bad = await run(['cites'], broken);
      expect([bad.code, bad.err]).toEqual([
        EXIT_ERROR,
        ['spec-guard: .spec-guard.json: "cites" entry 1: "ADR" has no {n}: an id template says where the number goes, as in ADR-{n}.'],
      ]);
    } finally {
      await removeTempRepo(configured);
      await removeTempRepo(broken);
    }
  });

  it('exits 0 with a note when nothing says what to look for', async () => {
    const plain = await makeTempRepo({ 'docs/guide.md': '# Guide\n', 'src/a.ts': '// ADR-0001\n' });
    try {
      const { code, out } = await run(['cites'], plain);
      expect(code).toBe(EXIT_OK);
      expect(out[0]).toContain('nothing to look for: "cites" names no documents');
      expect(out[0]).toMatch(/ no citation was looked for, so nothing was checked$/);
      expect((await run(['cites', '--strict'], plain)).code).toBe(EXIT_FAILED);
    } finally {
      await removeTempRepo(plain);
    }
  });

  it('passes the exclusions and the default skips on to the scan', async () => {
    const tree = await makeTempRepo({
      'docs/adr/0001-a.md': '# ADR-0001: A\n',
      'gen/a.ts': '// ADR-0009\n',
      'node_modules/x/i.js': '// ADR-0008\n',
    });
    try {
      const ghosts = async (...argv: string[]) => {
        const { out } = await run(['cites', '--json', ...argv], tree);
        return (JSON.parse(out[0] as string) as CitesReport).findings.map(({ file }) => file);
      };
      expect(await ghosts()).toEqual(['gen/a.ts']);
      expect(await ghosts('--exclude', 'gen')).toEqual([]);
      expect(await ghosts('--no-default-skips')).toEqual(['gen/a.ts', 'node_modules/x/i.js']);
    } finally {
      await removeTempRepo(tree);
    }
  });

  it('takes paths, and the options about what to read and how strictly, and refuses the ones about running rules', () => {
    expect(parseArgs(['cites', 'src', 'lib/a.ts', '--spec', 'd/*.md', '--exclude', 'dist', '--no-default-skips', '--strict'], ROOT)).toMatchObject({
      command: 'cites',
      paths: ['src', 'lib/a.ts'],
      patterns: ['d/*.md'],
      exclude: ['dist'],
      defaultSkips: false,
      strictTargets: true,
    });
    expect(parseArgs(['cites'], ROOT)).toMatchObject({ command: 'cites', paths: [], patterns: ['docs/**/*.md'] });
    for (const option of ['--verbose', '-v', '--watch', '--fail-fast', '--engine=js', '--allow-missing-targets', '--allow-empty-scope', '--print-baseline', '--ignore-status', '--include-specs', '--max-snippets=1', '--concurrency=1', '--allow-empty']) {
      const name = option.split('=')[0] as string;
      expect(() => parseArgs(['cites', option], ROOT), option).toThrow(new UsageError(`Option ${name} does not apply to spec-guard cites.`));
    }
    for (const format of ['human', 'json', 'sarif', 'github', 'gitlab']) expect(parseArgs(['cites', '--format', format], ROOT).format).toBe(format);
    expect(() => parseArgs(['cites', '--format', 'xml'], ROOT)).toThrow(new UsageError('Unknown format "xml". Expected human, json, sarif, github or gitlab.'));
  });
});

/* --------------------------------------------------------------- budget */

/**
 * Whether the code under test is instrumented, by coverage or by Stryker.
 * Instrumented, every statement costs several times more, so a wall-clock
 * budget is a claim about the code as shipped and is checked only there -
 * CI's sweep measured this tree at 10.009 s in Stryker's initial run, and
 * under a second on its own. What a run finds is checked in both.
 */
function instrumented(): boolean {
  const worker = (globalThis as Record<string, unknown>)['__vitest_worker__'] as { config?: { coverage?: { enabled?: boolean } } } | undefined;
  return '__stryker__' in globalThis || worker?.config?.coverage?.enabled === true;
}

describe('a tree of thousands of files', () => {
  let root: string;
  const FILES = 3000;

  beforeAll(async () => {
    root = await makeTempRepo({ 'docs/adr/0001-a.md': '# ADR-0001: A\n', 'docs/adr/0002-b.md': '# ADR-0002: B\n\n**Status:** deprecated\n' });
    // Written here rather than through makeTempRepo's object, so the tree is
    // built in parallel: 3,000 files of about 2 KB, one citation in three,
    // strings and comments that hold none in the rest.
    const body = Array.from({ length: 40 }, (_, line) => `const v${line} = "a string, not ADR-0009"; // a comment, but no id here\n`).join('');
    await Promise.all(
      Array.from({ length: FILES }, async (_, index) => {
        const directory = path.join(root, 'src', `m${index % 50}`);
        await fs.mkdir(directory, { recursive: true });
        const cite = index % 3 === 0 ? `// ADR-000${(index % 2) + 1} governs this\n` : '';
        await fs.writeFile(path.join(directory, `f${index}.ts`), `${cite}${body}`);
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await removeTempRepo(root);
  });

  it('is read within its budget of 10 seconds, finding every citation', async () => {
    const started = performance.now();
    const report = await findCitations({ root, patterns: ['docs/**/*.md'] });
    const took = performance.now() - started;
    expect(report.summary).toMatchObject({ files: FILES, citations: FILES / 3, ghosts: 0, stale: FILES / 6 });
    // Measured at under a second on the development machine; the budget
    // leaves room for a loaded one.
    if (!instrumented()) expect(took).toBeLessThan(10_000);
  }, 60_000);

  it('reads a file of many comments in one pass, not one pass per comment', async () => {
    // 40,000 comments and no citation until the last line. Searched once per
    // comment to the end of the file, as the first version of the scan did,
    // this is 40,000 searches of 1.6 MB; read once, it is one.
    const source = `${'// a comment with no id in it at all, padding\n'.repeat(40_000)}// ADR-0001\n`;
    const started = performance.now();
    const report = await cites({ 'src/big.ts': source }, { paths: ['src/big.ts'] });
    expect(report.summary).toMatchObject({ files: 1, citations: 1, ghosts: 0 });
    if (!instrumented()) expect(performance.now() - started).toBeLessThan(2_000);
  }, 60_000);
});
