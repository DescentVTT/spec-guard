/**
 * `spec-guard mcp`: the rules, served to an agent over the Model Context
 * Protocol on stdio.
 *
 * No SDK. MCP over stdio is JSON-RPC 2.0, one message per line, and what a
 * server has to get right fits in this file: framing, the two eras of the
 * protocol, and four methods' worth of results. The official SDK brings a
 * schema library and a dependency tree to do the same, and spec-guard's first
 * invariant is that it has no runtime dependencies at all. ADR-0012 has the
 * rest, including what this file deliberately does not implement.
 *
 * Two eras, served side by side. Revisions up to 2025-11-25 open with an
 * `initialize` handshake; 2026-07-28 has none, and every request carries its
 * protocol version in `_meta`. Clients of both are in use, so each request is
 * classified on its own - by the rule the TypeScript SDK's server applies, not
 * by one invented here: a request that claims a version in `_meta` is modern
 * and its claim is validated; anything else, `initialize` included, is legacy.
 */

import type { Readable } from 'node:stream';

import { toPosix } from './glob.js';
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

/* ----------------------------------------------------------------- protocol */

/** Revisions that carry their version on every request. Newest first. */
export const MODERN_PROTOCOL_VERSIONS: readonly string[] = ['2026-07-28'];

/** Revisions negotiated by `initialize`, newest first - the SDK's own list. */
export const LEGACY_PROTOCOL_VERSIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];

export const PROTOCOL_VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
export const CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';
export const CLIENT_INFO_KEY = 'io.modelcontextprotocol/clientInfo';
export const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo';

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
/** Resource not found before 2026-07-28, which forbids it in favour of -32602. */
export const LEGACY_RESOURCE_NOT_FOUND = -32002;
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;

export type RequestId = string | number;
export type Era = 'legacy' | 'modern';

export interface ErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** Everything this server ever writes. It never sends a request. */
export type OutgoingMessage =
  | { jsonrpc: '2.0'; id: RequestId; result: Record<string, unknown> }
  | { jsonrpc: '2.0'; id?: RequestId; error: ErrorObject };

class ProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON-RPC allows a null id; MCP does not, and requires an integer if a number. */
function isRequestId(value: unknown): value is RequestId {
  return typeof value === 'string' || Number.isInteger(value);
}

/**
 * What is wrong with a request's `_meta`, once it claims a protocol version.
 *
 * Only what the server depends on or the revision requires: a version that is a
 * string, capabilities that are an object, and client info shaped as client info
 * when it is sent. A claim is never silently ignored - a malformed one is an
 * error, not a reason to fall back to legacy handling.
 */
export function envelopeIssue(meta: JsonObject): string | undefined {
  if (!(CLIENT_CAPABILITIES_KEY in meta)) return `${CLIENT_CAPABILITIES_KEY}: missing`;
  if (typeof meta[PROTOCOL_VERSION_KEY] !== 'string') return `${PROTOCOL_VERSION_KEY}: expected a string`;
  if (!isObject(meta[CLIENT_CAPABILITIES_KEY])) return `${CLIENT_CAPABILITIES_KEY}: expected an object`;
  const info = meta[CLIENT_INFO_KEY];
  if (info !== undefined && !(isObject(info) && typeof info['name'] === 'string' && typeof info['version'] === 'string')) {
    return `${CLIENT_INFO_KEY}: expected an object with a string name and version`;
  }
  return undefined;
}

/**
 * The era a request belongs to, or the error that answers it instead.
 *
 * `initialize` is the legacy handshake unless it carries a valid modern claim.
 * Any other request is modern exactly when `_meta` holds the version key - its
 * presence is the claim, whatever its value - and legacy otherwise.
 */
export function classifyRequest(method: string, params: JsonObject | undefined): Era {
  const meta = params?.['_meta'];
  const claimed = isObject(meta) && PROTOCOL_VERSION_KEY in meta;
  if (!claimed) return 'legacy';
  const issue = envelopeIssue(meta);
  const version = meta[PROTOCOL_VERSION_KEY] as string;
  const supported = issue === undefined && MODERN_PROTOCOL_VERSIONS.includes(version);
  if (method === 'initialize' && !supported) return 'legacy';
  if (issue !== undefined) throw new ProtocolError(INVALID_PARAMS, `Invalid _meta envelope: ${issue}`);
  if (!supported) {
    throw new ProtocolError(UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
      supported: [...MODERN_PROTOCOL_VERSIONS],
      requested: version,
    });
  }
  return 'modern';
}

/** The version `initialize` settles on: the one asked for, or the newest legacy one. */
export function negotiateLegacyVersion(requested: unknown): string {
  // No typeof check: a list of strings includes nothing that is not one.
  return LEGACY_PROTOCOL_VERSIONS.includes(requested as string) ? (requested as string) : (LEGACY_PROTOCOL_VERSIONS[0] as string);
}

/* -------------------------------------------------------------- the surface */

export const SERVER_NAME = 'spec-guard';

export const INSTRUCTIONS =
  'spec-guard enforces the architecture decisions written in this project\'s Markdown specs and ADRs. ' +
  'Before creating or changing a file, call get_architectural_rules with its path to learn the rules in force there: ' +
  'imports it must not make, the layer it belongs to, what it must be named and the files it needs beside it, text it must not contain. ' +
  'After changing files, call check_architecture with their paths to find violations before CI does. ' +
  'Rules in draft, proposed, rejected, deprecated or superseded documents are not in force and are only counted.';

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };

export const TOOLS: readonly JsonObject[] = [
  {
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
          description: 'Also list rules from draft, proposed, rejected, deprecated and superseded documents.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
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
  },
];

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
   * message.
   */
  settings?: () => Promise<{ patterns: readonly string[]; run: Omit<RunOptions, 'patterns' | 'root' | 'select'> }>;
  /** Reads a spec document. Injected so an unreadable one can be tested. */
  readFile?: (file: string) => Promise<string>;
}

interface ToolOutcome {
  text: string;
  structured?: JsonObject;
  isError?: boolean;
}

function toolError(text: string): ToolOutcome {
  return { text, isError: true };
}

/** Arguments a tool does not declare, which the model should hear about. */
function unknownArguments(args: JsonObject, allowed: readonly string[]): ToolOutcome | undefined {
  const unknown = Object.keys(args).filter((name) => !allowed.includes(name));
  return unknown.length === 0
    ? undefined
    : toolError(`Unknown argument${unknown.length === 1 ? '' : 's'} ${unknown.map((name) => `"${name}"`).join(', ')}; this tool takes ${allowed.join(' and ')}.`);
}

/**
 * Builds the function that answers one parsed JSON-RPC message.
 *
 * Returns the message to send back, or null when nothing is owed: a
 * notification, or a response the client should not have sent.
 */
export function createMcpHandler(options: McpServerOptions): (message: unknown) => Promise<OutgoingMessage | null> {
  const serverInfo = { name: SERVER_NAME, version: options.version };
  const capabilities = { tools: {}, resources: {} };
  const readFile = options.readFile ?? ((file: string) => readText(nodeIo, file));
  /** The settings a request is answered under, read when the request arrives. */
  const current = async (): Promise<{ patterns: readonly string[]; run: McpServerOptions['run'] }> =>
    options.settings ? options.settings() : { patterns: options.patterns, run: options.run };
  const ruleSetOptions = ({ patterns, run }: { patterns: readonly string[]; run: McpServerOptions['run'] }) => ({
    patterns,
    root: options.root,
    // No defaults of their own: loadRuleSet has them, and a second copy here
    // could never disagree with it in a way anything could see.
    includeSpecs: run?.includeSpecs,
    defaultSkips: run?.defaultSkips,
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
    const report = { ...answerQuery(ruleSet, [query], includeInactive), durationMs: elapsed(startedAt) };
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
      durationMs: Math.round(report.durationMs * 1000) / 1000,
    };
    const text = `Checked ${scope}.\n\n${formatReport(report, { color: false, verbose: false, ascii: true }, settings.run?.maxSnippets)}`;
    return { text, structured };
  }

  async function callTool(params: JsonObject): Promise<JsonObject> {
    const name = params['name'];
    if (typeof name !== 'string') throw new ProtocolError(INVALID_PARAMS, 'tools/call needs the name of a tool.');
    const tool = name === 'get_architectural_rules' ? getRules : name === 'check_architecture' ? checkArchitecture : undefined;
    if (tool === undefined) throw new ProtocolError(INVALID_PARAMS, `Unknown tool: ${name}`);
    const args = params['arguments'] ?? {};
    if (!isObject(args)) throw new ProtocolError(INVALID_PARAMS, 'Tool arguments must be an object.');

    let outcome: ToolOutcome;
    try {
      outcome = await tool(args);
    } catch (error) {
      // A path outside the root is the model's to fix; anything else is still
      // better reported to the model than turned into a protocol failure it
      // cannot read.
      outcome = toolError(error instanceof QueryPathError ? error.message : `spec-guard failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      content: [{ type: 'text', text: outcome.text }],
      ...(outcome.structured === undefined ? {} : { structuredContent: outcome.structured }),
      ...(outcome.isError ? { isError: true } : {}),
    };
  }

  async function listResources(): Promise<JsonObject> {
    const ruleSet = await loadRuleSet(ruleSetOptions(await current()));
    return {
      resources: [
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
      ],
    };
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

  async function readResource(params: JsonObject, era: Era): Promise<JsonObject> {
    const uri = params['uri'];
    if (typeof uri !== 'string') throw new ProtocolError(INVALID_PARAMS, 'resources/read needs a uri.');
    const ruleSet = await loadRuleSet(ruleSetOptions(await current()));
    if (uri === RULES_URI) {
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(rulesResource(ruleSet), null, 2) }] };
    }
    // Membership, never a path join: the only files this reads are the ones the
    // spec patterns matched, so no URI can reach anything else on disk.
    const wanted = documentPath(uri);
    const document = ruleSet.documents.find((candidate) => candidate.relativeFile === wanted);
    const text = document === undefined ? undefined : await readFile(document.file).catch(() => undefined);
    if (text === undefined) {
      throw new ProtocolError(era === 'modern' ? INVALID_PARAMS : LEGACY_RESOURCE_NOT_FOUND, 'Resource not found', { uri });
    }
    return { contents: [{ uri, mimeType: 'text/markdown', text }] };
  }

  /** A list request's cursor. This server never issues one, so any is invalid. */
  function refuseCursor(params: JsonObject | undefined): void {
    if (params?.['cursor'] !== undefined) throw new ProtocolError(INVALID_PARAMS, 'Invalid cursor: this server does not paginate.');
  }

  async function dispatch(method: string, params: JsonObject | undefined, era: Era): Promise<JsonObject> {
    const given = params ?? {};
    if (era === 'legacy') {
      if (method === 'initialize') {
        return {
          protocolVersion: negotiateLegacyVersion(given['protocolVersion']),
          capabilities,
          serverInfo,
          instructions: INSTRUCTIONS,
        };
      }
      if (method === 'ping') return {};
    } else if (method === 'server/discover') {
      return { supportedVersions: [...MODERN_PROTOCOL_VERSIONS], capabilities, instructions: INSTRUCTIONS };
    }

    switch (method) {
      case 'tools/list':
        refuseCursor(params);
        return { tools: TOOLS };
      case 'tools/call':
        return callTool(given);
      case 'resources/list':
        refuseCursor(params);
        return listResources();
      case 'resources/templates/list':
        refuseCursor(params);
        return { resourceTemplates: RESOURCE_TEMPLATES };
      case 'resources/read':
        return readResource(given, era);
      default:
        throw new ProtocolError(METHOD_NOT_FOUND, 'Method not found');
    }
  }

  /** The 2026-07-28 shape: a result type, caching hints where required, and identity. */
  function modernResult(method: string, result: JsonObject): JsonObject {
    // Every cacheable result is marked stale at once and private. The rules are
    // read fresh on each request, and a client serving an ADR edited a minute ago
    // from cache would be doing the one thing this tool exists to stop.
    const cacheable = method !== 'tools/call';
    return {
      resultType: 'complete',
      ...result,
      ...(cacheable ? { ttlMs: 0, cacheScope: 'private' } : {}),
      _meta: { [SERVER_INFO_KEY]: serverInfo },
    };
  }

  return async (message: unknown): Promise<OutgoingMessage | null> => {
    if (!isObject(message)) {
      return {
        jsonrpc: '2.0',
        error: {
          code: INVALID_REQUEST,
          message: Array.isArray(message) ? 'Invalid Request: batches are not supported' : 'Invalid Request',
        },
      };
    }
    const { id, method, params } = message;
    if (message['jsonrpc'] === '2.0' && method === undefined && isRequestId(id) && ('result' in message || 'error' in message)) {
      return null;
    }
    if (message['jsonrpc'] !== '2.0' || typeof method !== 'string' || (id !== undefined && !isRequestId(id))) {
      return { jsonrpc: '2.0', ...(isRequestId(id) ? { id } : {}), error: { code: INVALID_REQUEST, message: 'Invalid Request' } };
    }
    if (id === undefined) return null;

    try {
      if (params !== undefined && !isObject(params)) throw new ProtocolError(INVALID_PARAMS, 'params must be an object.');
      const era = classifyRequest(method, params);
      const result = await dispatch(method, params, era);
      return { jsonrpc: '2.0', id, result: era === 'modern' ? modernResult(method, result) : result };
    } catch (error) {
      const failure =
        error instanceof ProtocolError
          ? { code: error.code, message: error.message, data: error.data }
          : { code: INTERNAL_ERROR, message: `Internal error: ${error instanceof Error ? error.message : String(error)}` };
      return { jsonrpc: '2.0', id, error: failure };
    }
  };
}

/* -------------------------------------------------------------------- stdio */

/** The key a request is tracked under: `1` and `"1"` are different ids. */
function trackingKey(id: RequestId): string {
  return `${typeof id}:${id}`;
}

/**
 * Serves a handler over newline-delimited JSON-RPC until the input ends.
 *
 * The whole stdio binding. Messages are split on `\n` with a trailing `\r`
 * dropped, blank lines are skipped, and every response is written as a single
 * line - `JSON.stringify` never emits a raw newline, which is what the binding
 * requires. Requests are answered concurrently and in whatever order they
 * finish. A request the client cancels gets no response at all. When the input
 * closes, requests still running are allowed to finish and then this resolves.
 */
export function serveStdio(
  input: Readable,
  write: (line: string) => void,
  handle: (message: unknown) => Promise<OutgoingMessage | null>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Decoded here rather than with setEncoding, which cannot be told apart
    // from not setting one: Node reads an empty encoding name as UTF-8 too.
    const decoder = new TextDecoder();
    let buffer = '';
    let running = 0;
    let ended = false;
    const inFlight = new Set<string | undefined>();
    const cancelled = new Set<string | undefined>();
    // Resolves once the input has ended and the last request has answered. A
    // count rather than a set of promises, so that getting it wrong either hangs
    // or ends early - both of which a test sees.
    const settle = (): void => {
      if (ended && running === 0) resolve();
    };

    const receive = (line: string): void => {
      // A CRLF line keeps its \r: JSON allows it as whitespace, and a line of
      // nothing else is blank.
      if (line.trim() === '') return;

      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        write(JSON.stringify({ jsonrpc: '2.0', error: { code: PARSE_ERROR, message: 'Parse error' } }));
        return;
      }

      if (isObject(message) && message['method'] === 'notifications/cancelled') {
        const requestId = isObject(message['params']) ? message['params']['requestId'] : undefined;
        if (isRequestId(requestId) && inFlight.has(trackingKey(requestId))) cancelled.add(trackingKey(requestId));
        return;
      }

      const key = isObject(message) && typeof message['method'] === 'string' ? trackingKey(message['id'] as RequestId) : undefined;
      inFlight.add(key);
      running += 1;
      void handle(message).then((response) => {
        running -= 1;
        inFlight.delete(key);
        if (!cancelled.delete(key) && response !== null) write(JSON.stringify(response));
        settle();
      });
    };

    input.on('data', (chunk: Uint8Array) => {
      buffer += decoder.decode(chunk, { stream: true });
      for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        receive(line);
      }
    });
    input.once('end', () => {
      ended = true;
      receive(buffer);
      settle();
    });
    input.once('error', reject);
  });
}
