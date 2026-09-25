/**
 * The Model Context Protocol over JSON-RPC 2.0, without an SDK.
 *
 * MCP over stdio is JSON-RPC 2.0, one message per line, and what a server must
 * get right fits here: framing, the two eras of the protocol, and the methods
 * that serve tools, resources and prompts. The official SDK brings a schema
 * library and a dependency tree to do the same; every spec-* tool promises no
 * runtime dependencies. Moved here from spec-guard (its ADR-0012), where it
 * was first written and measured, so that a second server does not relearn it.
 *
 * Two eras, served side by side. Revisions up to 2025-11-25 open with an
 * `initialize` handshake; 2026-07-28 has none, and every request carries its
 * protocol version in `_meta`. Clients of both are in use - the newest
 * revision is not yet the one most clients speak - so each request is
 * classified on its own, by the rule the TypeScript SDK's server applies: a
 * request that claims a version in `_meta` is modern and its claim is
 * validated; anything else, `initialize` included, is legacy.
 *
 * Nothing here touches a stream or a file. A server is a function from one
 * parsed message to the message owed back; `serveLines` binds one to any
 * source of bytes with `on('data')`, which on Node is `process.stdin`.
 */

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
export type JsonObject = Record<string, unknown>;

export interface ErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** Everything a server here writes. It never sends a request. */
export type OutgoingMessage =
  | { readonly jsonrpc: '2.0'; readonly id: RequestId; readonly result: JsonObject }
  | { readonly jsonrpc: '2.0'; readonly id?: RequestId; readonly error: ErrorObject };

/** An error that becomes a JSON-RPC error response with its code. */
export class ProtocolError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.data = data;
  }
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON-RPC allows a null id; MCP does not, and wants an integer if a number. */
export function isRequestId(value: unknown): value is RequestId {
  return typeof value === 'string' || Number.isInteger(value);
}

/**
 * What is wrong with a request's `_meta` once it claims a protocol version,
 * or `undefined`. A claim is never ignored: a malformed one is an error, not
 * a reason to fall back to the legacy handling.
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
  return LEGACY_PROTOCOL_VERSIONS.includes(requested as string) ? (requested as string) : (LEGACY_PROTOCOL_VERSIONS[0] as string);
}

/* ------------------------------------------------------------------ servers */

/** What a tool call produced: text for the model, and the same as data. */
export interface ToolOutcome {
  readonly text: string;
  readonly structured?: JsonObject | undefined;
  readonly isError?: boolean | undefined;
}

export interface ToolDefinition {
  /** The descriptor `tools/list` returns: name, title, description, inputSchema, annotations. */
  readonly descriptor: JsonObject & { readonly name: string };
  /** Runs the tool. Arguments arrive as an object, unvalidated beyond that. */
  call(args: JsonObject): Promise<ToolOutcome>;
}

export interface ResourceProvider {
  /** Concrete resources, as `resources/list` returns them. */
  list(): Promise<readonly JsonObject[]>;
  /** URI templates, as `resources/templates/list` returns them. */
  readonly templates?: readonly JsonObject[] | undefined;
  /** The contents of one resource, or `null` when there is no such resource. */
  read(uri: string): Promise<readonly JsonObject[] | null>;
}

export interface PromptDefinition {
  /** The descriptor `prompts/list` returns: name, title, description, arguments. */
  readonly descriptor: JsonObject & { readonly name: string };
  /** The messages the prompt expands to, given its arguments as strings. */
  get(args: Readonly<Record<string, string>>): Promise<JsonObject>;
}

export interface McpServerDefinition {
  readonly name: string;
  readonly version: string;
  /** Sent in the handshake: what the server is for, and when to call what. */
  readonly instructions: string;
  readonly tools?: readonly ToolDefinition[] | undefined;
  readonly resources?: ResourceProvider | undefined;
  readonly prompts?: readonly PromptDefinition[] | undefined;
  /**
   * Whether results other than a tool call's may be cached by a modern
   * client, and for how long. Absent: every result is stale at once and
   * private, which is right for a server that reads the repository afresh
   * on each request.
   */
  readonly cacheTtlMs?: number | undefined;
}

/** A tool's failure, reported to the model rather than as a protocol error it cannot read. */
export function toolError(text: string): ToolOutcome {
  return { text, isError: true };
}

/**
 * Arguments a tool does not declare, which the model should hear about rather
 * than have silently dropped. `undefined` when there are none.
 */
export function unknownArguments(args: JsonObject, allowed: readonly string[]): ToolOutcome | undefined {
  const unknown = Object.keys(args).filter((name) => !allowed.includes(name));
  if (unknown.length === 0) return undefined;
  const list = unknown.map((name) => `"${name}"`).join(', ');
  const takes =
    allowed.length === 0
      ? 'no arguments'
      : allowed.length === 1
        ? (allowed[0] as string)
        : `${allowed.slice(0, -1).join(', ')} and ${allowed[allowed.length - 1] as string}`;
  return toolError(`Unknown argument${unknown.length === 1 ? '' : 's'} ${list}; this tool takes ${takes}.`);
}

/**
 * Builds the function that answers one parsed JSON-RPC message: the message
 * to send back, or `null` when nothing is owed - a notification, or a
 * response the client should not have sent.
 */
export function createMcpServer(definition: McpServerDefinition): (message: unknown) => Promise<OutgoingMessage | null> {
  const serverInfo = { name: definition.name, version: definition.version };
  const tools = definition.tools ?? [];
  const prompts = definition.prompts ?? [];
  const capabilities: JsonObject = {
    ...(tools.length > 0 ? { tools: {} } : {}),
    ...(definition.resources !== undefined ? { resources: {} } : {}),
    ...(prompts.length > 0 ? { prompts: {} } : {}),
  };

  const refuseCursor = (params: JsonObject | undefined): void => {
    if (params?.['cursor'] !== undefined) throw new ProtocolError(INVALID_PARAMS, 'Invalid cursor: this server does not paginate.');
  };

  const callTool = async (params: JsonObject): Promise<JsonObject> => {
    const name = params['name'];
    if (typeof name !== 'string') throw new ProtocolError(INVALID_PARAMS, 'tools/call needs the name of a tool.');
    const tool = tools.find((candidate) => candidate.descriptor.name === name);
    if (tool === undefined) throw new ProtocolError(INVALID_PARAMS, `Unknown tool: ${name}`);
    const args = params['arguments'] ?? {};
    if (!isObject(args)) throw new ProtocolError(INVALID_PARAMS, 'Tool arguments must be an object.');
    let outcome: ToolOutcome;
    try {
      outcome = await tool.call(args);
    } catch (error) {
      outcome = toolError(`${definition.name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      content: [{ type: 'text', text: outcome.text }],
      ...(outcome.structured === undefined ? {} : { structuredContent: outcome.structured }),
      ...(outcome.isError === true ? { isError: true } : {}),
    };
  };

  const readResource = async (params: JsonObject, era: Era): Promise<JsonObject> => {
    const uri = params['uri'];
    if (typeof uri !== 'string') throw new ProtocolError(INVALID_PARAMS, 'resources/read needs a uri.');
    const contents = await (definition.resources as ResourceProvider).read(uri);
    if (contents === null) {
      throw new ProtocolError(era === 'modern' ? INVALID_PARAMS : LEGACY_RESOURCE_NOT_FOUND, 'Resource not found', { uri });
    }
    return { contents: [...contents] };
  };

  const getPrompt = async (params: JsonObject): Promise<JsonObject> => {
    const name = params['name'];
    if (typeof name !== 'string') throw new ProtocolError(INVALID_PARAMS, 'prompts/get needs the name of a prompt.');
    const prompt = prompts.find((candidate) => candidate.descriptor.name === name);
    if (prompt === undefined) throw new ProtocolError(INVALID_PARAMS, `Unknown prompt: ${name}`);
    const args = params['arguments'] ?? {};
    if (!isObject(args) || !Object.values(args).every((value) => typeof value === 'string')) {
      throw new ProtocolError(INVALID_PARAMS, 'Prompt arguments must be an object of strings.');
    }
    return prompt.get(args as Record<string, string>);
  };

  const dispatch = async (method: string, params: JsonObject | undefined, era: Era): Promise<JsonObject> => {
    const given = params ?? {};
    if (era === 'legacy') {
      if (method === 'initialize') {
        return {
          protocolVersion: negotiateLegacyVersion(given['protocolVersion']),
          capabilities,
          serverInfo,
          instructions: definition.instructions,
        };
      }
      if (method === 'ping') return {};
    } else if (method === 'server/discover') {
      return { supportedVersions: [...MODERN_PROTOCOL_VERSIONS], capabilities, instructions: definition.instructions };
    }
    // A method for a capability the server did not declare does not exist on
    // it: the answer is the one for any unknown method, not an empty list that
    // reads as "declared, and empty".
    const family = method.slice(0, method.indexOf('/') + 1);
    if (
      (family === 'tools/' && tools.length === 0) ||
      (family === 'resources/' && definition.resources === undefined) ||
      (family === 'prompts/' && prompts.length === 0)
    ) {
      throw new ProtocolError(METHOD_NOT_FOUND, 'Method not found');
    }
    switch (method) {
      case 'tools/list':
        refuseCursor(params);
        return { tools: tools.map((tool) => tool.descriptor) };
      case 'tools/call':
        return callTool(given);
      case 'resources/list':
        refuseCursor(params);
        return { resources: [...(await (definition.resources as ResourceProvider).list())] };
      case 'resources/templates/list':
        refuseCursor(params);
        return { resourceTemplates: [...((definition.resources as ResourceProvider).templates ?? [])] };
      case 'resources/read':
        return readResource(given, era);
      case 'prompts/list':
        refuseCursor(params);
        return { prompts: prompts.map((prompt) => prompt.descriptor) };
      case 'prompts/get':
        return getPrompt(given);
      default:
        throw new ProtocolError(METHOD_NOT_FOUND, 'Method not found');
    }
  };

  /** The 2026-07-28 shape: a result type, caching hints where required, and identity. */
  const modernResult = (method: string, result: JsonObject): JsonObject => {
    const cacheable = method !== 'tools/call';
    return {
      resultType: 'complete',
      ...result,
      ...(cacheable ? { ttlMs: definition.cacheTtlMs ?? 0, cacheScope: 'private' } : {}),
      _meta: { [SERVER_INFO_KEY]: serverInfo },
    };
  };

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
      const failure: ErrorObject =
        error instanceof ProtocolError
          ? { code: error.code, message: error.message, data: error.data }
          : { code: INTERNAL_ERROR, message: `Internal error: ${error instanceof Error ? error.message : String(error)}` };
      return { jsonrpc: '2.0', id, error: failure };
    }
  };
}

/* -------------------------------------------------------------------- lines */

/** Anything that delivers bytes and says when it has finished: `process.stdin`, or a test's stand-in. */
export interface ByteSource {
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  once(event: 'end', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
}

/** The key a request is tracked under: `1` and `"1"` are different ids. */
function trackingKey(id: RequestId): string {
  return `${typeof id}:${id}`;
}

/**
 * Serves a handler over newline-delimited JSON-RPC until the input ends.
 *
 * Messages are split on `\n`; a CRLF line keeps its `\r`, which JSON reads
 * as whitespace. Blank lines are skipped, and every response is written as a
 * single line - `JSON.stringify` never emits a raw newline, which is what the
 * binding requires. Requests are answered concurrently, in whatever order
 * they finish. A request the client cancels gets no response. When the input
 * closes, requests still running finish and then this resolves.
 */
export function serveLines(
  input: ByteSource,
  write: (line: string) => void,
  handle: (message: unknown) => Promise<OutgoingMessage | null>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder();
    let buffer = '';
    let running = 0;
    let ended = false;
    const inFlight = new Set<string | undefined>();
    const cancelled = new Set<string | undefined>();
    const settle = (): void => {
      if (ended && running === 0) resolve();
    };

    const receive = (line: string): void => {
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
      receive(buffer + decoder.decode());
      settle();
    });
    input.once('error', reject);
  });
}
