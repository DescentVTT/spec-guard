// Types for the tests that import scripts/mutation-shards.mjs. Reports are
// Stryker's mutation-testing-report-schema objects, typed only as far as the
// tests read them.

export interface Thresholds {
  high: number;
  low: number;
  break: number | null;
}

export interface Mutant {
  id: string;
  status: string;
  static?: boolean;
  coveredBy?: string[];
  killedBy?: string[];
  [field: string]: unknown;
}

export interface Report {
  files: Record<string, { mutants: Mutant[]; [field: string]: unknown }>;
  testFiles?: Record<string, { tests: { id: string; name: string }[]; [field: string]: unknown }>;
  thresholds?: Thresholds;
  config?: { mutate?: string[]; [field: string]: unknown };
  [field: string]: unknown;
}

export interface Metrics {
  mutationScore: number;
  killed: number;
  timeout: number;
  survived: number;
  noCoverage: number;
  totalMutants: number;
  [field: string]: number;
}

export declare const ASSIGNED: string[][];
export declare const SHARD_COUNT: number;
export declare class ShardError extends Error {}
export declare function checkAssignment(base: string[], assigned?: string[][]): Map<string, number>;
export declare function mutateFor(base: string[], shard: unknown, assigned?: string[][]): string[];
export declare function mergeReports(
  shards: { shard: number; report: Report }[],
  options: { base: string[]; thresholds: Thresholds; assigned?: string[][] },
): Report;
export declare function gate(report: Report, thresholds: Thresholds): { metrics: Metrics; passed: boolean; message: string };
export declare function formatTable(report: Report): string;
export declare function reportHtml(report: Report, elementsScript: string): string;
