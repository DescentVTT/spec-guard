/**
 * `literal` (src/literal.ts): a table with the types `as const` gives it,
 * where a mutation sweep can read it.
 *
 * What it promises is a type, so the type is what is held: `npm run lint`
 * compiles this file, and fails it when the table is given a wider type than
 * `as const` gives the same literal.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import { literal } from '../src/literal.js';

describe('literal', () => {
  it('hands back the table it was given, and not a copy', () => {
    const table = { refused: ', or give --allow-empty', final: '' };
    expect(literal(table)).toBe(table);
    expect(literal(['survived', 'killed'])).toEqual(['survived', 'killed']);
  });

  it('types a table as `as const` types it: every entry its own literal, and none to be written', () => {
    const cast = { refused: ', or give --allow-empty', final: '', order: ['survived', 'killed'], depth: 2 } as const;
    const called = literal({ refused: ', or give --allow-empty', final: '', order: ['survived', 'killed'], depth: 2 });
    expectTypeOf(called).toEqualTypeOf(cast);
    expectTypeOf(called).toEqualTypeOf<{ readonly refused: ', or give --allow-empty'; readonly final: ''; readonly order: readonly ['survived', 'killed']; readonly depth: 2 }>();
    expectTypeOf<keyof typeof called>().toEqualTypeOf<'refused' | 'final' | 'order' | 'depth'>();
  });

  it('types a template as `as const` types it, by its fixed part', () => {
    const escape = String.fromCharCode(27);
    const cast = { reset: `${escape}[0m` } as const;
    const called = literal({ reset: `${escape}[0m` });
    expectTypeOf(called).toEqualTypeOf(cast);
    expectTypeOf(called.reset).toEqualTypeOf<`${string}[0m`>();
  });

  it('is wider for a table that is not written at the call, which is why the table is', () => {
    const table = { final: '' };
    expectTypeOf(literal(table)).toEqualTypeOf<{ final: string }>();
  });
});
