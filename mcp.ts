// MCP Streamable HTTP endpoint: JSON-RPC 2.0 with server/discover, initialize,
// notifications/initialized, tools/list and tools/call over the shared store.
import { findRepo, createRepo, type Repository, type Store } from './store.ts';
import { mergePullById } from './graphql.ts';

export interface McpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// Deterministic, sorted tool list so the bytes are identical on every call.
const TOOLS: ToolSpec[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        private: { type: 'boolean', description: 'Whether the repository is private (default true)' },
        description: { type: 'string', description: 'Short description' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get one repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue on a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues on a repository (newest first).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state (default open)' },
        per_page: { type: 'integer', description: 'Page size (default 30)' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request between two branches.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name (default the repository default branch)' },
      },
      required: ['owner', 'repo', 'title', 'head'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

const jsonRpcError = (code: number, message: string, id: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, error: { code, message } });

function repoJson(repo: Repository): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

function issueJson(repo: Repository, issue: import('./store.ts').Issue): Record<string, unknown> {
  return { number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels, created_at: issue.createdAt };
}

function pullJson(repo: Repository, pull: import('./store.ts').PullRequest): Record<string, unknown> {
  return {
    number: pull.number,
    title: pull.title,
    state: pull.merged ? 'closed' : pull.state,
    merged: pull.merged,
    head: pull.head,
    base: pull.base,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
  };
}

export function callTool(store: Store, name: string, args: Record<string, unknown>): { ok: boolean; result: unknown; message?: string } {
  const tool = TOOLS.find((candidate) => candidate.name === name || candidate.name.endsWith(`_${name}`) || name.endsWith(`_${candidate.name}`));
  if (!tool) return { ok: false, result: null, message: `Unknown tool: ${name}` };
  switch (tool.name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' && args.name !== '' ? args.name : typeof args.repo === 'string' ? args.repo : '';
      if (repoName === '') return { ok: false, result: null, message: 'name is required' };
      const repo = createRepo(store, repoName, { private: typeof args.private === 'boolean' ? args.private : true, description: typeof args.description === 'string' ? args.description : '' });
      return { ok: true, result: repoJson(repo) };
    }
    case 'get_repo': {
      const repoName = typeof args.repo === 'string' && args.repo !== '' ? args.repo : typeof args.name === 'string' ? args.name : '';
      if (repoName === '') return { ok: false, result: null, message: 'repo is required' };
      const repo = findRepo(store, store.login, repoName);
      if (!repo) return { ok: false, result: null, message: `Repository ${repoName} not found` };
      return { ok: true, result: repoJson(repo) };
    }
    case 'create_issue': {
      const repoName = typeof args.repo === 'string' && args.repo !== '' ? args.repo : typeof args.name === 'string' ? args.name : '';
      const title = typeof args.title === 'string' ? args.title : '';
      const repo = findRepo(store, store.login, repoName);
      if (!repo) return { ok: false, result: null, message: `Repository ${repoName} not found` };
      if (title === '') return { ok: false, result: null, message: 'title is required' };
      const id = repo.nextIssueNumber;
      const issue = {
        id,
        number: id,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        labels: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        closedAt: null,
        user: store.login,
        comments: [],
      };
      repo.issues.set(id, issue);
      repo.nextIssueNumber += 1;
      return { ok: true, result: issueJson(repo, issue) };
    }
    case 'list_issues': {
      const repoName = typeof args.repo === 'string' && args.repo !== '' ? args.repo : typeof args.name === 'string' ? args.name : '';
      const repo = findRepo(store, store.login, repoName);
      if (!repo) return { ok: false, result: null, message: `Repository ${repoName} not found` };
      const state = typeof args.state === 'string' && args.state !== 'all' ? args.state : null;
      const perPage = typeof args.per_page === 'number' ? args.per_page : 30;
      const issues = [...repo.issues.values()].sort((a, b) => b.number - a.number)
        .filter((issue) => state === null || issue.state === state)
        .slice(0, perPage);
      return { ok: true, result: issues.map((issue) => issueJson(repo, issue)) };
    }
    case 'create_pull_request': {
      const repoName = typeof args.repo === 'string' && args.repo !== '' ? args.repo : typeof args.name === 'string' ? args.name : '';
      const repo = findRepo(store, store.login, repoName);
      if (!repo) return { ok: false, result: null, message: `Repository ${repoName} not found` };
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' && args.base !== '' ? args.base : repo.defaultBranch;
      const headOid = repo.refs.get(`refs/heads/${head}`);
      if (title === '' || head === '' || !headOid || !repo.refs.has(`refs/heads/${base}`)) {
        return { ok: false, result: null, message: 'title, head and base must resolve' };
      }
      const number = repo.nextPullNumber;
      const pull = {
        id: number,
        number,
        title,
        body: '',
        state: 'open' as const,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        head,
        base,
        headSha: headOid,
        baseSha: repo.refs.get(`refs/heads/${base}`)!,
        createdAt: new Date().toISOString(),
        user: store.login,
      };
      repo.pulls.set(number, pull);
      repo.nextPullNumber += 1;
      return { ok: true, result: pullJson(repo, pull) };
    }
    case 'merge_pull_request': {
      const repoName = typeof args.repo === 'string' && args.repo !== '' ? args.repo : typeof args.name === 'string' ? args.name : '';
      const number = typeof args.pull_number === 'number' ? args.pull_number : typeof args.number === 'number' ? args.number : Number.NaN;
      const repo = findRepo(store, store.login, repoName);
      if (!repo) return { ok: false, result: null, message: `Repository ${repoName} not found` };
      if (!Number.isInteger(number)) return { ok: false, result: null, message: 'number must be an integer' };
      const outcome = mergePullById(store, repo.name, number);
      if (!outcome || outcome.status !== 200) return { ok: false, result: null, message: 'merge failed' };
      const pull = repo.pulls.get(number)!;
      return { ok: true, result: pullJson(repo, pull) };
    }
    default:
      return { ok: false, result: null, message: `Unhandled tool: ${tool.name}` };
  }
}

export function handleMcpPost(store: Store, payload: unknown): McpResponse {
  const batch = Array.isArray(payload);
  const messages = batch ? payload as unknown[] : [payload];
  const results: unknown[] = [];
  for (const message of messages) {
    const single = handleMcpMessage(store, message as Record<string, unknown>);
    if (single !== null) results.push(single);
  }
  if (batch) return { status: 200, body: results };
  return { status: 200, body: results[0] ?? null };
}

function handleMcpMessage(store: Store, message: Record<string, unknown>): Record<string, unknown> | null {
  const id = message.id ?? null;
  const method = typeof message.method === 'string' ? message.method : '';
  if (method === 'server/discover') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
        serverInfo: { name: 'ghforge', title: 'ghforge git forge', version: '1.0.0' },
        capabilities: { tools: { listChanged: false } },
      },
    };
  }
  if (method === 'initialize') {
    const params = (message.params ?? {}) as Record<string, unknown>;
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const supported = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: supported.includes(requested) ? requested : supported[supported.length - 1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'ghforge', title: 'ghforge git forge', version: '1.0.0' },
      },
    };
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null;
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS.map((tool) => ({ ...tool })) } };
  }
  if (method === 'tools/call') {
    const params = (message.params ?? {}) as Record<string, unknown>;
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (toolName === '') {
      return jsonRpcError(-32602, 'Invalid params: name is required', id);
    }
    if (!TOOLS.some((tool) => tool.name === toolName)) {
      return jsonRpcError(-32602, `Unknown tool: ${toolName}`, id);
    }
    const outcome = callTool(store, toolName, args);
    if (!outcome.ok) {
      return jsonRpcError(-32602, outcome.message ?? 'Invalid params', id);
    }
    const text = JSON.stringify(outcome.result);
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text }],
        structuredContent: outcome.result,
      },
    };
  }
  return jsonRpcError(-32601, `Method not found: ${method}`, id);
}
