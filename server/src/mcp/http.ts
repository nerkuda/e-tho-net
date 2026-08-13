/**
 * MCP HTTP endpoint — StreamableHTTP transport (task F1, docs/05-mcp-server.md §2).
 *
 * A stateful per-session StreamableHTTP implementation, following the SDK
 * reference pattern:
 *
 *   * a client sends `initialize` (POST, `Authorization: Bearer <key>`);
 *   * the server creates a session (fresh transport + a per-session
 *     {@link McpServer} bound to the authenticated key) and returns the
 *     session id in the `Mcp-Session-Id` response header;
 *   * every following request carries `Mcp-Session-Id` and is routed to the
 *     session's transport; GET is served for SSE event streams.
 *
 * Auth (F2): the bearer key is resolved through the injected
 * {@link McpAuthProvider} — `null` means missing/unknown/disabled key or
 * disabled owner → 401. The key is **re-validated on every request**, so
 * revoking/disabling a key cuts the session off mid-flight. Sessions idle for
 * {@link MCP_SESSION_IDLE_TTL_MS} are closed and swept.
 *
 * The endpoint is transport-agnostic at the bottom: {@link prepareRequest}
 * returns a decision, and the caller (Fastify route or the dedicated
 * `ETN_MCP_PORT` node server) either sends the rejection or hands the raw
 * request to the session transport.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createMcpServer } from './index.js';
import type { McpAuthContext, McpBaseDeps } from './types.js';

/** How long an idle session stays alive before being swept (05 §2, MVP). */
export const MCP_SESSION_IDLE_TTL_MS = 10 * 60 * 1000;

/** Upper bound on a single POST body (protects the dedicated listener). */
const MAX_MCP_BODY_BYTES = 10 * 1024 * 1024;

/** One authenticated StreamableHTTP session. */
interface McpSession {
  transport: StreamableHTTPServerTransport;
  mcp: McpServer;
  /** Key id + principal the session is bound to (re-checked per request). */
  keyId: string;
  auth: McpAuthContext;
  /** Wall-clock ms of the last request routed to this session. */
  lastUsed: number;
}

/**
 * Outcome of {@link McpHttpEndpoint.prepareRequest}: either the request is
 * rejected (caller sends the canonical JSON error) or it belongs to a session
 * and must be handed to `transport.handleRequest`.
 */
export type McpHttpOutcome =
  | { kind: 'reject'; status: number; code: string; message: string }
  | { kind: 'handle'; session: McpSession };

/** StreamableHTTP endpoint for the MCP facade. */
export interface McpHttpEndpoint {
  /** Register `GET|POST /mcp` on a Fastify instance. */
  register(app: FastifyInstance): Promise<void>;
  /**
   * Auth/session resolution without any response writes. On `handle` the
   * session is fully connected; the caller must pass the original
   * request/response (and parsed JSON body for POST) to {@link handleSession}.
   */
  prepareRequest(req: IncomingMessage, body: unknown): Promise<McpHttpOutcome>;
  /** Delegate a prepared request to the session transport (writes the reply). */
  handleSession(
    session: McpSession,
    req: IncomingMessage,
    res: ServerResponse,
    body?: unknown,
  ): Promise<void>;
  /** Close all sessions (server shutdown). */
  close(): Promise<void>;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** MCP StreamableHTTP endpoint (mounted when `ETN_MCP_ENABLED=1`). */
    mcpHttp: McpHttpEndpoint;
  }
}

/** Extract the bearer token from the Authorization header, or `null`. */
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

/** True when `body` carries an `initialize` JSON-RPC request. */
function isInitializeRequest(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) {
    return false;
  }
  if (Array.isArray(body)) {
    return body.some(
      (m) =>
        typeof m === 'object' && m !== null && (m as { method?: unknown }).method === 'initialize',
    );
  }
  return (body as { method?: unknown }).method === 'initialize';
}

/** Build the endpoint over shared deps (auth resolved per session). */
export function createMcpHttpEndpoint(deps: McpBaseDeps): McpHttpEndpoint {
  const sessions = new Map<string, McpSession>();

  /** Drop sessions idle for longer than the TTL. */
  function sweep(): void {
    const cutoff = Date.now() - MCP_SESSION_IDLE_TTL_MS;
    for (const [sessionId, session] of sessions) {
      if (session.lastUsed <= cutoff) {
        void session.transport.close().catch(() => undefined);
        sessions.delete(sessionId);
      }
    }
  }

  /** Create a connected session for a freshly authenticated initialize request. */
  async function createSession(auth: McpAuthContext): Promise<McpSession> {
    // The SDK assigns the session id only while processing the initialize
    // request, so the session is first registered under a placeholder key and
    // re-keyed from `onsessioninitialized`. The placeholder guarantees idle
    // cleanup even when the client never completes initialization.
    const placeholderId = `pending:${randomUUID()}`;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // JSON responses for POST (SSE streams remain for GET notifications).
      enableJsonResponse: true,
      onsessioninitialized: (sessionId: string) => {
        sessions.delete(placeholderId);
        session.lastUsed = Date.now();
        sessions.set(sessionId, session);
      },
      onsessionclosed: (sessionId: string) => {
        sessions.delete(sessionId);
      },
    });
    const session: McpSession = {
      transport,
      mcp: createMcpServer({ ...deps, auth }),
      keyId: auth.keyId,
      auth,
      lastUsed: Date.now(),
    };
    sessions.set(placeholderId, session);
    // Connect first so the request handlers are wired before the first
    // handleRequest call (the SDK example does the same).
    await session.mcp.connect(transport);
    return session;
  }

  async function prepareRequest(req: IncomingMessage, body: unknown): Promise<McpHttpOutcome> {
    sweep();
    const token = bearerToken(req);
    const headerSessionId = req.headers['mcp-session-id'];
    const sessionId =
      typeof headerSessionId === 'string' && headerSessionId !== '' ? headerSessionId : null;

    if (sessionId !== null) {
      const session = sessions.get(sessionId);
      if (session === undefined) {
        return {
          kind: 'reject',
          status: 404,
          code: 'NOT_FOUND',
          message: 'Unknown or expired MCP session; re-run initialize.',
        };
      }
      if (token === null) {
        return {
          kind: 'reject',
          status: 401,
          code: 'UNAUTHORIZED',
          message: 'Missing Bearer API key.',
        };
      }
      const auth = deps.authProvider(token);
      if (auth === null) {
        sessions.delete(sessionId);
        void session.transport.close().catch(() => undefined);
        return {
          kind: 'reject',
          status: 401,
          code: 'UNAUTHORIZED',
          message: 'Invalid or disabled API key.',
        };
      }
      if (auth.keyId !== session.keyId) {
        return {
          kind: 'reject',
          status: 403,
          code: 'FORBIDDEN',
          message: 'Session was authenticated with a different API key.',
        };
      }
      session.lastUsed = Date.now();
      return { kind: 'handle', session };
    }

    // No session id: only `initialize` may open a session.
    if (!isInitializeRequest(body)) {
      return {
        kind: 'reject',
        status: 400,
        code: 'BAD_REQUEST',
        message: 'Missing Mcp-Session-Id header; send initialize first.',
      };
    }
    if (token === null) {
      return {
        kind: 'reject',
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Missing Bearer API key.',
      };
    }
    const auth = deps.authProvider(token);
    if (auth === null) {
      return {
        kind: 'reject',
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Invalid or disabled API key.',
      };
    }
    return { kind: 'handle', session: await createSession(auth) };
  }

  const endpoint: McpHttpEndpoint = {
    async register(app: FastifyInstance): Promise<void> {
      const route = async (
        req: FastifyRequest,
        reply: FastifyReply,
        body: unknown,
      ): Promise<void> => {
        const outcome = await prepareRequest(req.raw, body);
        if (outcome.kind === 'reject') {
          reply
            .code(outcome.status)
            .send({ error: { code: outcome.code, message: outcome.message } });
          return;
        }
        reply.hijack();
        await endpoint.handleSession(outcome.session, req.raw, reply.raw, body);
      };
      app.post('/mcp', async (req, reply) => {
        const body = (req as FastifyRequest & { body?: unknown }).body;
        await route(req, reply, body);
      });
      app.get('/mcp', async (req, reply) => {
        await route(req, reply, undefined);
      });
    },

    prepareRequest,

    async handleSession(session, req, res, body) {
      await session.transport.handleRequest(req, res, body);
    },

    async close() {
      const open = [...sessions.values()];
      sessions.clear();
      for (const session of open) {
        await session.transport.close().catch(() => undefined);
        await session.mcp.close().catch(() => undefined);
      }
    },
  };

  return endpoint;
}

/** Send a canonical JSON error through a raw node response. */
function sendNodeError(res: ServerResponse, status: number, code: string, message: string): void {
  if (!res.headersSent) {
    res.writeHead(status, { 'content-type': 'application/json' });
  }
  res.end(JSON.stringify({ error: { code, message } }));
}

/** Read a JSON POST body with a size cap; `undefined` for non-POST. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method !== 'POST') {
    return undefined;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_MCP_BODY_BYTES) {
      throw new Error('MCP request body exceeds 10 MiB');
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return null; // malformed JSON — prepareRequest rejects it
  }
}

/**
 * Raw node HTTP handler serving only `/mcp` — used by the dedicated
 * `ETN_MCP_PORT` listener (05 §2: endpoint isolated from REST traffic).
 */
export async function handleMcpNodeRequest(
  endpoint: McpHttpEndpoint,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if ((req.url ?? '').split('?')[0] !== '/mcp') {
    sendNodeError(res, 404, 'NOT_FOUND', 'Only /mcp is served on this port.');
    return;
  }
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendNodeError(res, 413, 'VALIDATION_ERROR', 'Request body too large.');
    return;
  }
  const outcome = await endpoint.prepareRequest(req, body);
  if (outcome.kind === 'reject') {
    sendNodeError(res, outcome.status, outcome.code, outcome.message);
    return;
  }
  await endpoint.handleSession(outcome.session, req, res, body);
}
