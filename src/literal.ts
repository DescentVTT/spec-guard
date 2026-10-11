/**
 * A table that keeps its literal types and is read-only, without `as const`.
 *
 * `as const` gives both, and hides the table from the mutation sweep: Stryker
 * passes over everything that stands under a TypeScript `as` expression, so no
 * entry of such a table was ever mutated, and no report said so (ADR-0003,
 * amended 2026-10-12). A `const` type parameter has the compiler infer the
 * same type for the argument, and a call is not an `as`.
 */
export function literal<const Table>(table: Table): Table {
  return table;
}
