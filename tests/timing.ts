/**
 * Timing for the tests that hold work to cost linear in what it reads.
 *
 * A test of cost states a ratio, not a number of milliseconds, as spec-core's
 * ADR-0007 has it: a slow or busy machine slows every run, and can push one
 * past any fixed bound - a tree of 3,000 files, read in under a second here,
 * took 24.7 seconds against a budget of ten on a machine running five suites.
 * So the same work is timed at two sizes, taken in turn, so that a stretch
 * when the machine is busy slows both, and the larger is held to a small
 * multiple of what linear work would take.
 */

/**
 * Whether the code under test is instrumented, by coverage or by Stryker.
 * Instrumented, every statement costs several times more; a ratio survives
 * that, since it slows both sizes alike, but a test that reads a large tree
 * several times over for each mutant costs a sweep more than it tells it.
 */
export function instrumented(): boolean {
  const worker = (globalThis as Record<string, unknown>)['__vitest_worker__'] as { config?: { coverage?: { enabled?: boolean } } } | undefined;
  return '__stryker__' in globalThis || worker?.config?.coverage?.enabled === true;
}

/**
 * The fastest of a few runs of each piece of work, the pieces taken in turn,
 * so that a stretch when the machine is busy slows every one of them and not
 * only whichever was running; each run is awaited before the next starts.
 * Instrumented, one run is all the time there is.
 */
export async function fastestInTurnAsync(runs: number, ...work: (() => Promise<unknown>)[]): Promise<number[]> {
  const best = work.map(() => Number.POSITIVE_INFINITY);
  for (let i = 0; i < (instrumented() ? 1 : runs); i += 1) {
    for (const [k, run] of work.entries()) {
      const started = performance.now();
      await run();
      best[k] = Math.min(best[k] as number, performance.now() - started);
    }
  }
  return best;
}

/**
 * The time one run of `work` takes, in milliseconds, over as many runs as
 * fill `span` milliseconds. A stretch holds at least one run, so work grown
 * to take seconds is timed once and not thousands of times over.
 */
function perRun(span: number, work: () => unknown): number {
  let runs = 0;
  let elapsed = 0;
  const started = performance.now();
  do {
    work();
    runs += 1;
    elapsed = performance.now() - started;
  } while (elapsed < span && runs < 100_000);
  return elapsed / runs;
}

/**
 * For work too quick to time once, at two sizes: how many times as long a
 * run of the larger takes as a run of the smaller, the fastest stretch of
 * each, over `stretches` stretches of each taken in turn, after one of each
 * that is not counted.
 *
 * A busy machine only ever adds time, so the fastest stretch is the one
 * nearest what the work costs, and a reading is spoiled only where every
 * stretch of one size was slowed and one of the other was not. Measured on
 * GitHub's runners on 2026-10-19, every image and Node of the suite's
 * matrix, with the suite running beside it: a stretch of ten milliseconds
 * was now and then slowed whole, by up to a thousand times, and the fastest
 * of seven such of each size read up to 8.3 times apart for work four times
 * as large. The fastest of 21 of three milliseconds read at most 6.1 times
 * apart in 6,240 readings, and 7.3 in another 5,040: short stretches are
 * slowed less often, and more of them leave fewer readings with none of one
 * size spared. One stretch of each is run first and not counted, as it was
 * where that was measured, so that no reading holds the first runs of
 * either size.
 */
export function fastestRatioInTurn(stretches: number, span: number, smaller: () => unknown, larger: () => unknown): number {
  perRun(span, smaller);
  perRun(span, larger);
  let small = Number.POSITIVE_INFINITY;
  let large = Number.POSITIVE_INFINITY;
  for (let i = 0; i < stretches; i += 1) {
    small = Math.min(small, perRun(span, smaller));
    large = Math.min(large, perRun(span, larger));
  }
  return large / small;
}
