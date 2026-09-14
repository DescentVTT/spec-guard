// @ts-check
/**
 * One shard of the full mutation sweep: the base configuration, with three
 * differences. See scripts/mutation-shards.mjs and ADR-0003.
 *
 *   MUTATION_SHARD=2 npx stryker run stryker.shard.config.mjs
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
import base from './stryker.config.mjs';
import { mutateFor } from './scripts/mutation-shards.mjs';

const shard = process.env.MUTATION_SHARD;

export default {
  ...base,

  // The files this shard holds. An unset or unknown shard is an error here,
  // not a run over everything.
  mutate: mutateFor(base.mutate, shard),

  // A shard is not a score. One holding the hardest files can sit below the
  // gate while the sweep as a whole clears it, so the gate is applied once, by
  // the merge, to the merged report.
  thresholds: { ...base.thresholds, break: null },

  // The merge reads the JSON and writes the HTML page for the whole sweep.
  reporters: ['json', 'clear-text', 'progress'],
  jsonReporter: { fileName: `reports/mutation/shard-${shard}.json` },
};
