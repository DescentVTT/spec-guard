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
 * For work too quick to time once: the time one run takes, in milliseconds,
 * over as many runs as fill `span` milliseconds, the fastest of a few such
 * stretches of each piece of work, taken in turn. A stretch holds at least
 * one run, so work grown to take seconds is timed once and not thousands of
 * times over.
 */
export function perRunInTurn(stretches: number, span: number, ...work: (() => unknown)[]): number[] {
  const best = work.map(() => Number.POSITIVE_INFINITY);
  for (let i = 0; i < stretches; i += 1) {
    work.forEach((run, k) => {
      let runs = 0;
      let elapsed = 0;
      const started = performance.now();
      do {
        run();
        runs += 1;
        elapsed = performance.now() - started;
      } while (elapsed < span && runs < 100_000);
      best[k] = Math.min(best[k] as number, elapsed / runs);
    });
  }
  return best;
}
