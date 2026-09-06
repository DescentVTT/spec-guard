import { describe, expect, it } from 'vitest';

import { maskCode, parseAttributes, parseDirectives } from '../src/parser.js';

const context = { file: 'C:/repo/docs/adr/0001.md', relativeFile: 'docs/adr/0001.md' };
const fence = '`'.repeat(3);

describe('parseAttributes', () => {
  it('reads double, single and unquoted values', () => {
    expect(parseAttributes(' target="src/" symbol=\'Foo\' expected=2 ')).toEqual({
      target: 'src/',
      symbol: 'Foo',
      expected: '2',
    });
  });

  it('treats a bare attribute as true', () => {
    expect(parseAttributes(' regex word ')).toEqual({ regex: 'true', word: 'true' });
  });

  it('unescapes escaped quotes inside values', () => {
    expect(parseAttributes(' symbol="say \\"hi\\"" ')).toEqual({ symbol: 'say "hi"' });
  });

  it('lowercases attribute names', () => {
    expect(parseAttributes(' TARGET="src" ')).toEqual({ target: 'src' });
  });
});

describe('parseDirectives', () => {
  it('extracts every supported directive with its location', () => {
    const source = [
      '# Title',
      '',
      '<!-- @assert-absence target="src/" symbol="Legacy" -->',
      '<!-- @assert-count target="src/" symbol="Session" expected="1" -->',
      '<!-- @assert-present file="SECURITY.md" -->',
    ].join('\n');

    const { directives, errors } = parseDirectives(source, context);

    expect(errors).toEqual([]);
    expect(directives.map((directive) => directive.kind)).toEqual([
      'assert-absence',
      'assert-count',
      'assert-present',
    ]);
    expect(directives.map((directive) => directive.location.line)).toEqual([3, 4, 5]);
    expect(directives[0]?.location.column).toBe(1);
    expect(directives[0]?.attributes).toEqual({ target: 'src/', symbol: 'Legacy' });
    expect(directives[0]?.location.relativeFile).toBe('docs/adr/0001.md');
  });

  it('supports directives spanning several lines', () => {
    const source = ['intro', '', '<!--', '  @assert-count', '  target="src/"', '  symbol="A"', '  min="1"', '-->'].join(
      '\n',
    );

    const { directives } = parseDirectives(source, context);

    expect(directives).toHaveLength(1);
    expect(directives[0]?.location.line).toBe(3);
    expect(directives[0]?.attributes).toEqual({ target: 'src/', symbol: 'A', min: '1' });
  });

  it('ignores directives inside fenced code blocks', () => {
    const source = [
      '<!-- @assert-count target="src/" symbol="Real" expected="1" -->',
      '',
      `${fence}md`,
      '<!-- @assert-count target="src/" symbol="Documented" expected="99" -->',
      fence,
      '',
      '~~~',
      '<!-- @assert-absence target="src/" symbol="AlsoDocumented" -->',
      '~~~',
    ].join('\n');

    const { directives } = parseDirectives(source, context);

    expect(directives).toHaveLength(1);
    expect(directives[0]?.attributes['symbol']).toBe('Real');
  });

  it('ignores directives inside inline code spans', () => {
    const source = 'Use `<!-- @assert-absence target="src/" symbol="Doc" -->` in your ADR.';
    expect(parseDirectives(source, context).directives).toEqual([]);
  });

  it('does not let a stray backtick run desynchronise later code spans', () => {
    // A run of three backticks mid-sentence has no partner. CommonMark skips
    // it; a naive scanner pairs it with the next single backtick and un-masks
    // every span that follows.
    const source = [
      `A custom fenced block (\` ${fence}spec-guard \`) was rejected.`,
      '',
      'The format is `<!-- @assert-count target="src/" symbol="Documented" expected="9" -->`.',
      '',
      '<!-- @assert-present file="real.md" -->',
    ].join('\n');

    const { directives, errors } = parseDirectives(source, context);

    expect(errors).toEqual([]);
    expect(directives).toHaveLength(1);
    expect(directives[0]?.kind).toBe('assert-present');
  });

  it('handles an unterminated fence by masking to end of file', () => {
    const source = [`${fence}ts`, '<!-- @assert-absence target="src/" symbol="Doc" -->'].join('\n');
    expect(parseDirectives(source, context).directives).toEqual([]);
  });

  it('reports unknown assert directives but ignores unrelated comments', () => {
    const source = ['<!-- @assert-typo target="src/" -->', '<!-- @todo something -->', '<!-- plain comment -->'].join(
      '\n',
    );

    const { directives, errors } = parseDirectives(source, context);

    expect(directives).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('Unknown directive "@assert-typo"');
    expect(errors[0]?.location.line).toBe(1);
  });

  it('reports unknown attributes instead of silently ignoring them', () => {
    const source = '<!-- @assert-count target="src/" symbol="A" expct="1" -->';

    const { directives, errors } = parseDirectives(source, context);

    expect(directives).toEqual([]);
    expect(errors[0]?.message).toContain('Unknown attribute "expct"');
  });

  it('lists every unknown attribute at once', () => {
    const source = '<!-- @assert-present file="a.md" nope="1" alsonope="2" -->';
    const { errors } = parseDirectives(source, context);
    expect(errors[0]?.message).toContain('Unknown attributes "nope", "alsonope"');
  });

  it('keeps line numbers correct with CRLF endings', () => {
    const source = ['# Title', '', '<!-- @assert-present file="a.md" -->'].join('\r\n');
    expect(parseDirectives(source, context).directives[0]?.location.line).toBe(3);
  });

  it('keeps offsets aligned when the file contains astral characters', () => {
    const source = ['# 🚀 Rocket 🚀', '', '<!-- @assert-present file="a.md" -->'].join('\n');
    const parsed = parseDirectives(source, context);
    expect(parsed.directives[0]?.location.line).toBe(3);
    expect(parsed.directives[0]?.raw).toBe('<!-- @assert-present file="a.md" -->');
  });

  it('is case-insensitive about the directive name', () => {
    const { directives } = parseDirectives('<!-- @ASSERT-PRESENT file="a.md" -->', context);
    expect(directives[0]?.kind).toBe('assert-present');
  });
});

describe('maskCode', () => {
  it('preserves length and newlines', () => {
    const source = [`${fence}js`, 'const a = 1;', fence, 'text'].join('\n');
    const masked = maskCode(source);
    expect(masked).toHaveLength(source.length);
    expect(masked.split('\n')).toHaveLength(source.split('\n').length);
    expect(masked).toContain('text');
    expect(masked).not.toContain('const a = 1;');
  });

  it('leaves an unmatched backtick run alone', () => {
    const source = 'a ` b';
    expect(maskCode(source)).toBe(source);
  });
});
