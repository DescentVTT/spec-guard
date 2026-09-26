/**
 * `spec-guard mcp`: the rules, served to an agent over the Model Context
 * Protocol on stdio.
 *
 * No SDK. The protocol - framing, the two eras, classifying each request,
 * dispatching it and shaping its result - is spec-core's `jsonrpc` module,
 * copied into `src/vendor` and verified by hash (ADR-0015). It was written
 * here first and moved there so that a second server in the family does not
 * relearn it. What is spec-guard's, and stays here, is what the server says:
 * its instructions, its three tools, and the rules and documents it serves as
 * resources. ADR-0012 has the rest, including what this server deliberately
 * does not implement; ADR-0018 has `get_dependents`.
 */

import { toPosix } from './glob.js';
import { formatImpact, ImpactError, impactDocument, impactOf } from './impact.js';
import { nodeIo, readText } from './io.js';
import { formatReport } from './reporter.js';
import { elapsed, runSpecGuard, type RunOptions } from './runner.js';
import {
  answerQuery,
  formatQuery,
  inQueriedPaths,
  loadRuleSet,
  QueryPathError,
  resolveQueryPath,
  viewDocument,
  type RuleSet,
} from './query.js';
import { governs, viewRule, type QueryPath } from './rules.js';
import { createDocumentMemo, type DocumentMemo } from './specs.js';
import type { ConfigUse, SpecWarning } from './types.js';
import {
  createMcpServer,
  serveLines,
  toolError,
  unknownArguments,
  type ByteSource,
  type JsonObject,
  type OutgoingMessage,
  type ResourceProvider,
  type ToolDefinition,
  type ToolOutcome,
} from './vendor/spec-core/jsonrpc/index.js';

// The protocol's names, re-exported from where they now live, so that a
// caller of the API who imported them from here still finds them.
export {
  classifyRequest,
  envelopeIssue,
  negotiateLegacyVersion,
  CLIENT_CAPABILITIES_KEY,
  CLIENT_INFO_KEY,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  LEGACY_PROTOCOL_VERSIONS,
  LEGACY_RESOURCE_NOT_FOUND,
  METHOD_NOT_FOUND,
  MODERN_PROTOCOL_VERSIONS,
  PARSE_ERROR,
  PROTOCOL_VERSION_KEY,
  SERVER_INFO_KEY,
  UNSUPPORTED_PROTOCOL_VERSION,
} from './vendor/spec-core/jsonrpc/index.js';
export type { Era, ErrorObject, OutgoingMessage, RequestId } from './vendor/spec-core/jsonrpc/index.js';

/* -------------------------------------------------------------- the surface */

export const SERVER_NAME = 'spec-guard';

export const INSTRUCTIONS =
  'spec-guard enforces the architecture decisions written in this project\'s Markdown specs and ADRs. ' +
  'Before creating or changing a file, call get_architectural_rules with its path to learn the rules in force there: ' +
  'imports it must not make, the layer it belongs to, what it must be named and the files it needs beside it, text it must not contain. ' +
  'Before changing a file that other files import - renaming or removing an export, changing what a function takes or returns - ' +
  'call get_dependents with its path to learn every file the change can reach and the rules in force over them. ' +
  'After changing files, call check_architecture with their paths to find violations before CI does. ' +
  'Rules in draft, proposed, rejected, deprecated, superseded or archived documents are not in force and are only counted.';

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };

const GET_RULES = {
  name: 'get_architectural_rules',
  title: 'Architectural rules for a path',
  description:
    'Lists the architecture rules in force for a file or directory, grouped by the ADR or spec that states them: ' +
    'modules it must not import, the layer it belongs to and the layers it must not depend on, import cycles, ' +
    'what it must be named and the partner files it needs, ' +
    'and text or symbols it must not contain, each with the reason the document gives. ' +
    'Answers from the specs without reading the codebase, so it works for a file that does not exist yet. ' +
    'Rules in documents that are not in force are counted and named but not listed unless include_inactive is true.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'A file or directory, relative to the project root or absolute inside it.',
      },
      include_inactive: {
        type: 'boolean',
        description: 'Also list rules from draft, proposed, rejected, deprecated, superseded and archived documents.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
};

const CHECK_ARCHITECTURE = {
  name: 'check_architecture',
  title: 'Check the architecture rules',
  description:
    'Runs the architecture rules in force against the files on disk and reports every violation, as CI would. ' +
    'Given paths, runs only the rules that govern them - each over its whole scope, so a count or a cycle is judged ' +
    'exactly as CI judges it - and marks which violations lie in those paths. Save your edits before calling.',
  inputSchema: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files or directories to check the rules of, relative to the project root. Omit to run every rule.',
      },
    },
    additionalProperties: false,
  },
  annotations: READ_ONLY,
};

const GET_DEPENDENTS = {
  name: 'get_dependents',
  title: 'Files that depend on a path',
  description:
    'Lists the files that import each given file or directory, directly or through other files, ' +
    'each with how many imports away it is and the import that leads there, ' +
    'and the architecture rules in force that govern the paths or any of those files. ' +
    'Call it before changing a file that other files import - renaming or removing an export, changing a signature - ' +
    'to see everything the change can reach. ' +
    'Relative JavaScript, TypeScript and Python imports are followed; an import that cannot be resolved is listed, ' +
    'and Go, Rust, C# and absolute Python imports, which name modules rather than files, are counted, never guessed, ' +
    'so a short list is not mistaken for a complete one. Reads the codebase on disk, so every path must exist.',
  inputSchema: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description: 'Files or directories that exist, relative to the project root or absolute inside it.',
      },
      depth: {
        type: 'integer',
        minimum: 1,
        description: 'Follow dependents at most this many imports away. Omit to follow every one.',
      },
      include_inactive: {
        type: 'boolean',
        description: 'Also list rules from draft, proposed, rejected, deprecated, superseded and archived documents.',
      },
    },
    required: ['paths'],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
};

/** What `tools/list` answers, in the order it lists them. */
export const TOOLS: readonly JsonObject[] = [GET_RULES, CHECK_ARCHITECTURE, GET_DEPENDENTS];

export const RULES_URI = 'spec://rules';
export const DOCUMENT_URI_PREFIX = 'spec://doc/';

export const RESOURCE_TEMPLATES: readonly JsonObject[] = [
  {
    uriTemplate: `${DOCUMENT_URI_PREFIX}{+path}`,
    name: 'spec-document',
    title: 'Spec document',
    description: 'Any spec document by its path relative to the project root, including documents that are not in force.',
    mimeType: 'text/markdown',
  },
];

export function documentUri(relativeFile: string): string {
  return `${DOCUMENT_URI_PREFIX}${relativeFile.split('/').map(encodeURIComponent).join('/')}`;
}

/** The spec path a document URI names, or null for anything else. */
export function documentPath(uri: string): string | null {
  if (!uri.startsWith(DOCUMENT_URI_PREFIX)) return null;
  try {
    return uri.slice(DOCUMENT_URI_PREFIX.length).split('/').map(decodeURIComponent).join('/');
  } catch {
    // Malformed percent-encoding names no document.
    return null;
  }
}

/* ------------------------------------------------------------------ handler */

export interface McpServerOptions {
  /** Absolute project root. */
  root: string;
  /** Spec globs, as on the command line. */
  patterns: readonly string[];
  /** Reported as the server's version. */
  version: string;
  /**
   * Run settings, as the CLI flags set them. `ignoreStatus` also makes
   * `get_architectural_rules` list rules from documents not in force by default.
   */
  run?: Omit<RunOptions, 'patterns' | 'root' | 'select'>;
  /**
   * The specs and run settings for one request, when they can change while the
   * server runs. The command line passes one that reads the project's
   * configuration afresh (ADR-0014); without it, `patterns` and `run` hold for
   * every request. A settings function that throws fails the request with its
   * message. What it took from a configuration is reported with each answer, as
   * the command line reports it, so an agent can see which exclusions a file
   * set.
   */
  settings?: () => Promise<{ patterns: readonly string[]; run: Omit<RunOptions, 'patterns' | 'root' | 'select'>; config?: ConfigUse }>;
  /** Reads a spec document. Injected so an unreadable one can be tested. */
  readFile?: (file: string) => Promise<string>;
  /**
   * Where parsed documents are kept between requests: one of the server's own
   * when not given. Injected so a test can see what the server holds.
   */
  documents?: DocumentMemo;
}

/**
 * One of the server's tools.
 *
 * A path argument outside the root, or one that must exist and does not, is
 * the model's to fix, so it hears the message alone. Anything else a tool
 * throws is caught by the protocol layer and reported after the server's name,
 * "spec-guard failed: ...", which is still better than a protocol failure the
 * model cannot read.
 */
function tool(descriptor: JsonObject & { name: string }, run: (args: JsonObject) => Promise<ToolOutcome>): ToolDefinition {
  return {
    descriptor,
    call: (args) =>
      run(args).catch((error: unknown) => {
        if (error instanceof QueryPathError || error instanceof ImpactError) return toolError(error.message);
        throw error;
      }),
  };
}

/**
 * Builds the function that answers one parsed JSON-RPC message.
 *
 * Returns the message to send back, or null when nothing is owed: a
 * notification, or a response the client should not have sent.
 */
export function createMcpHandler(options: McpServerOptions): (message: unknown) => Promise<OutgoingMessage | null> {
  const readFile = options.readFile ?? ((file: string) => readText(nodeIo, file));
  /** The settings a request is answered under, read when the request arrives. */
  const current = async (): Promise<{ patterns: readonly string[]; run: McpServerOptions['run']; config?: ConfigUse }> =>
    options.settings ? options.settings() : { patterns: options.patterns, run: options.run };
  // Every request reads the specs, and parsing them was most of what a query
  // cost; a document whose bytes have not changed since the last request is
  // not parsed again (ADR-0012's amendment of 2026-09-27). The memo holds the
  // documents of the spec set read last and nothing else: specs.ts says how.
  const documents = options.documents ?? createDocumentMemo();
  const ruleSetOptions = ({ patterns, run }: { patterns: readonly string[]; run: McpServerOptions['run'] }) => ({
    patterns,
    root: options.root,
    documents,
    // No defaults of their own: loadRuleSet has them, and a second copy here
    // could never disagree with it in a way anything could see.
    includeSpecs: run?.includeSpecs,
    defaultSkips: run?.defaultSkips,
    exclude: run?.exclude,
  });

  const noSpecs = (patterns: readonly string[]): ToolOutcome =>
    toolError(
      `No spec files matched ${patterns.map((pattern) => `"${pattern}"`).join(', ')} under ${options.root}. ` +
        'Start the server with --spec <glob> or --root <dir> pointing at the project.',
    );

  async function getRules(args: JsonObject): Promise<ToolOutcome> {
    const unknown = unknownArguments(args, ['path', 'include_inactive']);
    if (unknown) return unknown;
    if (typeof args['path'] !== 'string') return toolError('"path" is required and must be a string.');
    const settings = await current();
    const includeInactive = args['include_inactive'] ?? settings.run?.ignoreStatus ?? false;
    if (typeof includeInactive !== 'boolean') return toolError('"include_inactive" must be true or false.');

    const startedAt = performance.now();
    const query = await resolveQueryPath(args['path'], options.root);
    const ruleSet = await loadRuleSet(ruleSetOptions(settings));
    if (ruleSet.specFiles.length === 0) return noSpecs(settings.patterns);
    const report = { ...answerQuery(ruleSet, [query], includeInactive), durationMs: elapsed(startedAt), config: settings.config };
    return { text: formatQuery(report), structured: { ...report } };
  }

  async function checkArchitecture(args: JsonObject): Promise<ToolOutcome> {
    const unknown = unknownArguments(args, ['paths']);
    if (unknown) return unknown;
    const rawPaths = args['paths'];
    if (rawPaths !== undefined && !(Array.isArray(rawPaths) && rawPaths.every((entry) => typeof entry === 'string'))) {
      return toolError('"paths" must be an array of strings.');
    }
    const paths: QueryPath[] | undefined =
      rawPaths === undefined ? undefined : await Promise.all((rawPaths as string[]).map((entry) => resolveQueryPath(entry, options.root)));

    const settings = await current();
    let inForce = 0;
    const report = await runSpecGuard({
      ...settings.run,
      patterns: settings.patterns,
      root: options.root,
      documents,
      select: (assertion) => {
        inForce += 1;
        return paths === undefined || paths.some((query) => governs(assertion, query));
      },
    });
    if (report.summary.specs === 0) return noSpecs(settings.patterns);

    const scope =
      paths === undefined
        ? `all ${inForce} rules in force`
        : `${report.summary.total} of ${inForce} rules in force - the ones that govern ${paths.map((query) => query.path).join(', ')}`;
    const structured = {
      ok: report.ok,
      engine: report.engine,
      paths: paths?.map((query) => query.path) ?? null,
      rules: { inForce, checked: report.summary.total, passed: report.summary.passed, failed: report.summary.failed },
      failures: report.results
        .filter((result) => !result.ok)
        .map((result) => ({
          document: result.location.relativeFile,
          line: result.location.line,
          kind: result.kind,
          description: result.description,
          reason: result.reason ?? null,
          message: result.message,
          matches: result.matches.map((match) => ({
            ...match,
            inPaths: paths === undefined || inQueriedPaths(match.file, paths),
          })),
          warnings: result.warnings,
        })),
      errors: report.errors.map((error) => ({
        file: error.location.relativeFile,
        line: error.location.line,
        message: error.message,
      })),
      inactiveSpecs: report.inactiveSpecs,
      warnings: report.warnings,
      // A document read differently from how it was written: see ADR-0010 and ADR-0002.
      // A run always reports them; the type leaves them out only for a result a caller built.
      specWarnings: (report.specWarnings as SpecWarning[]).map((warning) => ({
        file: warning.location.relativeFile,
        line: warning.location.line,
        message: warning.message,
      })),
      exclude: report.exclude,
      config: settings.config,
      durationMs: Math.round(report.durationMs * 1000) / 1000,
    };
    const text = `Checked ${scope}.\n\n${formatReport({ ...report, config: settings.config }, { color: false, verbose: false, ascii: true }, settings.run?.maxSnippets)}`;
    return { text, structured };
  }

  /**
   * `spec-guard impact`, answered as `impact --json` answers: the same
   * document, and the human report as the text. Unlike the other two tools it
   * answers without specs, as the command does, since who imports a file does
   * not depend on them; the report says no rules are shown.
   */
  async function getDependents(args: JsonObject): Promise<ToolOutcome> {
    const unknown = unknownArguments(args, ['paths', 'depth', 'include_inactive']);
    if (unknown) return unknown;
    const paths = args['paths'];
    if (!Array.isArray(paths) || paths.length === 0 || !paths.every((entry) => typeof entry === 'string')) {
      return toolError('"paths" is required and must be a non-empty array of strings.');
    }
    const depth = args['depth'];
    if (depth !== undefined && !(Number.isInteger(depth) && (depth as number) >= 1)) {
      return toolError('"depth" must be a whole number of 1 or more: a depth of 0 would follow no import.');
    }
    const settings = await current();
    const includeInactive = args['include_inactive'] ?? settings.run?.ignoreStatus ?? false;
    if (typeof includeInactive !== 'boolean') return toolError('"include_inactive" must be true or false.');

    const report = {
      ...(await impactOf({
        ...ruleSetOptions(settings),
        paths: paths as string[],
        // Absent and undefined are one answer to impactOf: every dependent.
        depth: depth as number | undefined,
        includeInactive,
      })),
      config: settings.config,
    };
    return { text: formatImpact(report), structured: { ...impactDocument(report) } };
  }

  function rulesResource(ruleSet: RuleSet): JsonObject {
    return {
      root: toPosix(options.root),
      specFiles: ruleSet.specFiles,
      rules: ruleSet.rules
        .filter(({ document }) => document.inForce)
        .map(({ assertion, document }) => viewRule(assertion, document)),
      notInForce: ruleSet.documents
        .filter((document) => !document.inForce)
        .map((document) => ({ ...viewDocument(document), rules: document.directives.length })),
      errors: ruleSet.errors.map((error) => ({
        file: error.location.relativeFile,
        line: error.location.line,
        message: error.message,
      })),
    };
  }

  const resources: ResourceProvider = {
    templates: RESOURCE_TEMPLATES,
    async list() {
      const ruleSet = await loadRuleSet(ruleSetOptions(await current()));
      return [
        {
          uri: RULES_URI,
          name: 'rules',
          title: 'Rules in force',
          description: 'Every rule in force, with the document that states it and its scope, as JSON.',
          mimeType: 'application/json',
        },
        // Documents not in force are readable through the template and left out
        // of the list, which a client may put in front of a model wholesale.
        ...ruleSet.documents
          .filter((document) => document.inForce)
          .map((document) => ({
            uri: documentUri(document.relativeFile),
            name: document.relativeFile,
            title: document.title ?? document.relativeFile,
            mimeType: 'text/markdown',
          })),
      ];
    },
    async read(uri) {
      const ruleSet = await loadRuleSet(ruleSetOptions(await current()));
      if (uri === RULES_URI) {
        return [{ uri, mimeType: 'application/json', text: JSON.stringify(rulesResource(ruleSet), null, 2) }];
      }
      // Membership, never a path join: the only files this reads are the ones the
      // spec patterns matched, so no URI can reach anything else on disk.
      const wanted = documentPath(uri);
      const document = ruleSet.documents.find((candidate) => candidate.relativeFile === wanted);
      const text = document === undefined ? undefined : await readFile(document.file).catch(() => undefined);
      return text === undefined ? null : [{ uri, mimeType: 'text/markdown', text }];
    },
  };

  // Every result a modern client may cache is marked stale at once and
  // private, which is the protocol layer's default and the one this server
  // needs: the rules are read fresh on each request, and a client serving an
  // ADR edited a minute ago from its cache would be doing the one thing this
  // tool exists to stop. No prompts are declared, so prompts/list is answered
  // "Method not found", as it is for any method the server does not have.
  return createMcpServer({
    name: SERVER_NAME,
    version: options.version,
    instructions: INSTRUCTIONS,
    tools: [tool(GET_RULES, getRules), tool(CHECK_ARCHITECTURE, checkArchitecture), tool(GET_DEPENDENTS, getDependents)],
    resources,
  });
}

/* -------------------------------------------------------------------- stdio */

/**
 * Serves a handler over newline-delimited JSON-RPC until the input ends.
 *
 * spec-core's `serveLines`, under the name this module has always exported:
 * one message per line, answered concurrently, a cancelled request answered
 * with nothing, and the input's end awaited until the last request finishes.
 */
export function serveStdio(
  input: ByteSource,
  write: (line: string) => void,
  handle: (message: unknown) => Promise<OutgoingMessage | null>,
): Promise<void> {
  return serveLines(input, write, handle);
}
