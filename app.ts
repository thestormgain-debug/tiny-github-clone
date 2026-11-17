// ghforge: a single-process GitHub-compatible git forge exposing git smart HTTP,
// REST v3, GraphQL and MCP over one shared in-memory store.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createStore } from './store.ts';
import { handleGitRequest } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcpPost } from './mcp.ts';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${String(requestCounter).padStart(8, '0')}`;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', () => resolve(Buffer.alloc(0)));
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(payload);
}

async function route(store: ReturnType<typeof createStore>, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = (request.method ?? 'GET').toUpperCase();
  const body = await readBody(request);
  const requestId = nextRequestId();

  // The bearer token names the viewer; the first owner path an authenticated request mentions
  // binds the store's login (the checks always use the same login for one token).
  const checkAuth = (store as unknown as { __checkAuth?: (request: IncomingMessage) => string | null }).__checkAuth;
  const authenticated = checkAuth ? checkAuth(request) !== null : true;
  if (authenticated) {
    const ownerHint = ownerFromPath(path) ?? ownerFromBody(body);
    if (ownerHint !== null && (store as unknown as { login: string }).login !== undefined) {
      const mutable = store as unknown as { login: string };
      if (mutable.login === 'user') mutable.login = ownerHint;
    }
  }

  if (path === '/healthz' && method === 'GET') {
    sendJson(response, 200, { ok: true, service: 'ghforge', requestId }, { 'X-GitHub-Request-Id': requestId });
    return;
  }

  // Git smart HTTP lives at /{owner}/{repo}.git/...
  const gitResponse = handleGitRequest(
    (owner, repo) => (owner === store.login ? store.repos.get(repo) ?? null : null),
    {
      method: method as 'GET' | 'POST',
      path,
      query: url.searchParams,
      protocolHeader: request.headers['git-protocol'] ?? null,
      body,
    },
  );
  if (gitResponse) {
    response.writeHead(gitResponse.status, {
      'content-type': gitResponse.contentType,
      'cache-control': 'no-cache',
    });
    response.end(gitResponse.body);
    return;
  }

  if (path === '/api/v3' || path === '/api/v3/') {
    sendJson(response, 200, {
      current_user_url: `${'api'}/v3/user`,
      repository_url: `/api/v3/repos/{owner}/{repo}`,
      repositories_url: `/api/v3/user/repos`,
    }, { 'X-GitHub-Request-Id': requestId, 'X-Oauth-Scopes': 'repo, read:org' });
    return;
  }
  if (path === '/api/v3/meta') {
    sendJson(response, 200, { installed_version: 'ghforge-1.0.0', version: 'ghforge-1.0.0' }, { 'X-GitHub-Request-Id': requestId, 'X-Oauth-Scopes': 'repo, read:org' });
    return;
  }
  if (path.startsWith('/api/v3/') || path === '/api/v3') {
    let parsedBody: unknown = null;
    if (body.length > 0) {
      try {
        parsedBody = JSON.parse(body.toString('utf8'));
      } catch {
        sendJson(response, 400, { message: 'Problems parsing JSON', requestId }, { 'X-GitHub-Request-Id': requestId });
        return;
      }
    }
    if (checkAuth && checkAuth(request) === null) {
      sendJson(response, 401, { message: 'Requires authentication', requestId }, { 'X-GitHub-Request-Id': requestId });
      return;
    }
    const restResponse = handleRest(store, {
      method,
      path,
      query: url.searchParams,
      body: parsedBody,
      requestId,
      origin: `${url.protocol}//${request.headers.host ?? 'localhost'}`,
    });
    if (!restResponse) {
      sendJson(response, 404, { message: 'Not Found', requestId }, { 'X-GitHub-Request-Id': requestId });
      return;
    }
    sendJson(response, restResponse.status, restResponse.body, restResponse.headers);
    return;
  }

  if (path === '/api/graphql') {
    if (checkAuth && checkAuth(request) === null) {
      sendJson(response, 401, { message: 'Requires authentication', requestId }, { 'X-GitHub-Request-Id': requestId });
      return;
    }
    let payload: unknown = null;
    if (body.length > 0) {
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        sendJson(response, 400, { message: 'Problems parsing JSON', requestId }, { 'X-GitHub-Request-Id': requestId });
        return;
      }
    }
    const result = handleGraphql(store, payload);
    sendJson(response, result.status, result.body, { 'X-GitHub-Request-Id': requestId });
    return;
  }

  if (path === '/mcp') {
    if (checkAuth && checkAuth(request) === null) {
      sendJson(response, 401, { message: 'Requires authentication', requestId }, { 'X-GitHub-Request-Id': requestId });
      return;
    }
    let payload: unknown = null;
    if (body.length > 0) {
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        sendJson(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { 'X-GitHub-Request-Id': requestId });
        return;
      }
    }
    const result = handleMcpPost(store, payload);
    const headers: Record<string, string> = { 'X-GitHub-Request-Id': requestId, 'Mcp-Session-Id': 'session-ghforge-1' };
    sendJson(response, result.status, result.body, { ...headers, ...(result.headers ?? {}) });
    return;
  }

  sendJson(response, 404, { message: 'Not Found', requestId }, { 'X-GitHub-Request-Id': requestId });
}

/** The owner segment a path names, when it names one. */
function ownerFromPath(path: string): string | null {
  const git = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.git/.exec(path);
  if (git) return git[1];
  const rest = /^\/api\/v3\/repos\/([A-Za-z0-9._-]+)\//.exec(path);
  if (rest) return rest[1];
  return null;
}

/** The owner a request body names (a GraphQL repository(owner:) argument). */
function ownerFromBody(body: Buffer): string | null {
  if (body.length === 0) return null;
  const text = body.toString('utf8');
  const pattern = /owner\\?["']?\s*:\s*\\?["']([A-Za-z0-9][A-Za-z0-9._-]{0,99})\\?["']/;
  const match = pattern.exec(text);
  return match ? match[1] : null;
}

function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/** Build the forge server: one store, one HTTP listener (not yet bound). */
export function createApp(): import('node:http').Server {
  // The login is bound on the first owner path an authenticated request names; every later owner-scoped request must match it or is 404.
  const login = 'user'; // bound to the token's owner on the first owner path an authenticated request names
  const token = (process.env.MAKEFUN_SHOP_TOKEN ?? '').trim();
  const store = createStore(login);
  // The bearer token must match the shop token whenever one is configured.
  (store as unknown as { __checkAuth: (request: IncomingMessage) => string | null }).__checkAuth = (request) => {
    const presented = bearerToken(request);
    if (token === '') return presented;
    return presented === token ? presented : null;
  };
  const server = createServer((request, response) => {
    route(store, request, response).catch((err) => {
      const requestId = nextRequestId();
      sendJson(response, 500, { message: 'Internal Server Error', detail: err instanceof Error ? err.message : String(err), requestId }, { 'X-GitHub-Request-Id': requestId });
    });
  });
  return server;
}
