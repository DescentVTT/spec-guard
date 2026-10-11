// Types for the test that imports scripts/mutation-unmeasured.mjs. A syntax
// tree is Babel's, typed only as far as the script's callers hand it on.

import type { Report } from './mutation-shards.mjs';

export type Parse = (source: string) => { program: unknown };

/** An outermost `as` expression or enum with a site under it. Lines and columns from 1, as a report has them. */
export interface Hidden {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  sites: number;
  text: string;
}

export interface Measured {
  files: { file: string; expressions: number; hidden: Hidden[] }[];
  expressions: number;
  sites: number;
}

export declare const LEFT: number;
export declare class UnmeasuredError extends Error {}
export declare function loadParser(from?: string): Promise<Parse>;
export declare function unmeasured(source: string, parse: Parse): { expressions: number; hidden: Hidden[] };
export declare function treeSources(patterns: string[], root?: string): Record<string, string>;
export declare function measure(sources: Record<string, string>, parse: Parse): Measured;
export declare function verdict(measured: Measured, left?: number, report?: Report): { passed: boolean; lines: string[]; message: string };
export declare function main(argv: string[]): Promise<number>;
