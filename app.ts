// The HTTP shell: one Node http server that routes every surface of the forge — /healthz for
// the harness, the git smart-HTTP routes, /api/v3 (REST), /api/graphql and /mcp — over a
// single Forge store built from the process's MAKEFUN_SHOP_TOKEN. Cross-cutting rules live
// here so the surfaces cannot drift apart: every reply carries a non-empty
// X-GitHub-Request-Id, every API reply is application/json (never HTML), a malformed JSON
// body is a 400 with a `message`, and an unauthenticated API call is a 401 with a `message`.
// A handler that throws answers 500 and the server keeps serving: one bad request must never
// take the forge down.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { advertise, gitPost } from './protocol.ts';
import { routeRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { Forge } from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

interface Reply {
  status: number;
  contentType?: string;
  body?: Buffer;
  headers?: Record<string, string>;
}

function jsonReply(status: number, value: unknown, headers?: Record<string, string>): Reply {
  return { status, contentType: 'application/json', body: Buffer.from(JSON.stringify(value), 'utf8'), headers };
}

function message(status: number, text: string): Reply {
  return jsonReply(status, { message: text });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Route one request. `forge` is the process's single store; `requestId` is already stamped. */
async function route(forge: Forge, req: IncomingMessage, body: Buffer): Promise<Reply> {
  const url = new URL(req.url ?? '/', 'http://forge.internal');
  const pathname = url.pathname;
  const method = req.method ?? 'GET';
  const authorized = forge.authorized(req.headers.authorization);

  // The harness's liveness probe: no auth, always the same small answer.
  if (pathname === '/healthz') {
    return method === 'GET' ? jsonReply(200, { ok: true }) : message(404, 'Not Found');
  }

  // Git smart HTTP: /{owner}/{repo}.git/info/refs|git-upload-pack|git-receive-pack
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
  if (gitMatch !== null) {
    if (!authorized) return message(401, 'Bad credentials');
    const owner = decodeSegment(gitMatch[1]!);
    const name = decodeSegment(gitMatch[2]!);
    const tail = gitMatch[3] ?? '';
    if (tail === '/info/refs' && method === 'GET') {
      const service = url.searchParams.get('service') ?? '';
      const version2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      const answer = advertise(forge, owner, name, service, version2);
      return { status: answer.status, contentType: answer.contentType, body: answer.body };
    }
    if ((tail === '/git-upload-pack' || tail === '/git-receive-pack') && method === 'POST') {
      try {
        const answer = gitPost(forge, owner, name, tail.slice(1), body);
        return { status: answer.status, contentType: answer.contentType, body: answer.body };
      } catch (err) {
        // A malformed protocol body (random bytes, a truncated pkt-line) is a 400, never a crash.
        process.stderr.write(`[forge] git ${tail} rejected: ${err instanceof Error ? err.message : String(err)}\n`);
        return { status: 400, contentType: 'text/plain', body: Buffer.from('bad request\n', 'utf8') };
      }
    }
    return message(404, 'Not Found');
  }

  // GraphQL v4.
  if (pathname === '/api/graphql') {
    if (method !== 'POST') return message(404, 'Not Found');
    if (!authorized) return message(401, 'Bad credentials');
    const answer = handleGraphQL(forge, body);
    return jsonReply(answer.status, answer.json);
  }

  // MCP (Streamable HTTP).
  if (pathname === '/mcp') {
    if (method === 'DELETE') return { status: 204 };
    if (method !== 'POST') return message(405, 'Method Not Allowed');
    if (!authorized) return message(401, 'Bad credentials');
    const answer = handleMcp(forge, body);
    if (answer.json === null) return { status: answer.status };
    return jsonReply(answer.status, answer.json);
  }

  // REST v3.
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    let parsedBody: unknown;
    if (body.length > 0 && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
      try {
        parsedBody = JSON.parse(body.toString('utf8'));
      } catch {
        return message(400, 'Problems parsing JSON');
      }
    }
    if (!authorized) return message(401, 'Bad credentials');
    const segments = pathname
      .slice('/api/v3'.length)
      .split('/')
      .filter((segment) => segment !== '')
      .map(decodeSegment);
    const origin = `http://${req.headers.host ?? 'localhost'}`;
    const result = routeRest({ forge, method, segments, query: url.searchParams, body: parsedBody, origin });
    if (result.status === 204) return { status: 204 };
    return jsonReply(result.status, result.json ?? {}, result.headers);
  }

  return message(404, 'Not Found');
}

/** Build the forge's HTTP server (unbound; main.ts binds it to an ephemeral port). */
export function createApp(): Server {
  const forge = new Forge(process.env.MAKEFUN_SHOP_TOKEN ?? '');
  let requestSeq = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requestSeq += 1;
    const requestId = `forge-${requestSeq.toString(36)}-${Date.now().toString(36)}`;
    void (async (): Promise<void> => {
      let reply: Reply;
      try {
        const body = await readBody(req);
        reply = await route(forge, req, body);
      } catch (err) {
        process.stderr.write(`[forge] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
        reply = message(500, 'Internal Server Error');
      }
      try {
        const headers: Record<string, string> = { 'x-github-request-id': requestId, ...(reply.headers ?? {}) };
        if (reply.contentType !== undefined) headers['content-type'] = reply.contentType;
        if (reply.body !== undefined) headers['content-length'] = String(reply.body.length);
        res.writeHead(reply.status, headers);
        res.end(reply.body);
      } catch {
        // The peer went away mid-answer; nothing useful remains to do.
      }
    })();
  });
  return server;
}
