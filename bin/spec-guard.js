#!/usr/bin/env node
/**
 * Thin launcher. All logic lives in dist/cli.js so the published binary stays
 * a two-line shim that is trivially auditable.
 */
import { pathToFileURL } from 'node:url';

const entry = new URL('../dist/cli.js', import.meta.url);

let cli;
try {
  cli = await import(entry.href);
} catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') {
    process.stderr.write(
      `spec-guard: build output missing at ${pathToFileURL(entry.pathname).pathname}\n` +
        'Run "npm run build" first (or install the published package).\n',
    );
    process.exit(2);
  }
  throw error;
}

process.exitCode = await cli.main();
