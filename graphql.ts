// GraphQL endpoint: a small parser/executor tailored to the forge's schema, with
// introspection, variables, aliases, inline fragments and batched documents.
import type { Repository, Store } from './store.ts';
import { diffTrees, findRepo, mergeBase, putObject } from './store.ts';
import { parseCommit, buildCommit } from './gitcore.ts';

/** Squash-merge a pull request onto its base branch; answers the same shape as the REST merge. */
export function mergePullById(store: Store, repoKey: string, number: number): { status: number; body: unknown } | null {
  const repo = store.repos.get(repoKey);
  if (!repo) return null;
  const pull = repo.pulls.get(number);
  if (!pull) return null;
  const headCommit = repo.objects.get(pull.headSha);
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (!headCommit || !baseTip) return { status: 422, body: { message: 'Validation Failed' } };
  if (pull.merged) return { status: 405, body: { message: 'Pull Request has already been merged' } };
  const base = parseCommit(repo.objects.get(baseTip)!.data);
  const head = parseCommit(headCommit.data);
  const ancestor = mergeBase(repo, baseTip, pull.headSha);
  if (ancestor !== null) {
    const ancestorCommit = repo.objects.get(ancestor);
    if (ancestorCommit) {
      const ancestorTree = parseCommit(ancestorCommit.data).tree;
      const headChanges = new Set(diffTrees(repo, ancestorTree, head.tree).map((diff) => diff.filename));
      const baseChanges = new Set(diffTrees(repo, ancestorTree, base.tree).map((diff) => diff.filename));
      for (const path of headChanges) {
        if (baseChanges.has(path)) {
          return { status: 405, body: { message: 'Pull Request is not mergeable: conflicts' } };
        }
      }
    }
  }
  const mergeOid = putObject(repo, 'commit', buildCommit({
    tree: head.tree,
    parents: [baseTip],
    message: `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}\n`,
    author: `${repo.owner} <${repo.owner}@make.fun>`,
    committer: `${repo.owner} <${repo.owner}@make.fun>`,
    timestamp: 1_735_689_600 + repo.objects.size,
  }));
  repo.refs.set(`refs/heads/${pull.base}`, mergeOid);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = new Date().toISOString();
  pull.mergeCommitSha = mergeOid;
  repo.updatedAt = new Date().toISOString();
  return { status: 200, body: { sha: mergeOid, merged: true, message: 'Pull Request successfully merged' } };
}

export interface GraphqlResponse {
  status: number;
  body: unknown;
}

interface GqlError {
  message: string;
  path?: Array<string | number>;
}

interface FieldNode {
  alias: string | null;
  name: string;
  args: Record<string, unknown>;
  selections: FieldNode[] | null;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, { type: string; default: unknown }>;
  selections: FieldNode[];
}

// ---------------------------------------------------------------- lexer/parser

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length) {
    const ch = source[index];
    if (/\s/.test(ch) || ch === ',') {
      index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '"') {
      // String literal (no escapes beyond \" handling; documents are simple).
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\' && index + 1 < source.length) {
          value += source[index + 1];
          index += 2;
        } else {
          value += source[index];
          index += 1;
        }
      }
      index += 1;
      tokens.push(`"S:${value}"`);
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let name = '';
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) {
        name += source[index];
        index += 1;
      }
      tokens.push(name);
      continue;
    }
    if (ch === '.') {
      let dots = '';
      while (index < source.length && source[index] === '.') { dots += '.'; index += 1; }
      tokens.push(dots);
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let num = '';
      while (index < source.length && /[0-9.eE+-]/.test(source[index])) {
        num += source[index];
        index += 1;
      }
      tokens.push(`"N:${num}"`);
      continue;
    }
    tokens.push(ch);
    index += 1;
  }
  return tokens;
}

function decodeToken(token: string): string | number {
  if (token.startsWith('"S:')) return token.slice(3, -1);
  if (token.startsWith('"N:')) return Number.parseFloat(token.slice(3, -1));
  return token;
}

class Parser {
  private tokens: string[];
  private index = 0;
  private variables: Record<string, { type: string; default: unknown }>;

  constructor(source: string) {
    this.tokens = tokenize(source);
    this.variables = {};
  }

  private peek(): string | undefined {
    return this.tokens[this.index];
  }

  private next(): string | undefined {
    return this.tokens[this.index++];
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected '${token}' but found '${got ?? 'EOF'}'`);
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek() !== undefined) {
      const keyword = this.next();
      if (keyword === 'query' || keyword === 'mutation') {
        operations.push(this.parseOperation(keyword as 'query' | 'mutation'));
      } else if (keyword === '{') {
        // Anonymous query shorthand: re-parse as selection set.
        this.index -= 1;
        operations.push({ kind: 'query', name: null, variables: {}, selections: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token '${keyword}' at document level`);
      }
    }
    return operations;
  }

  private parseOperation(kind: 'query' | 'mutation'): Operation {
    let name: string | null = null;
    if (this.peek() && /^[A-Za-z_$]/.test(this.peek()!) && this.peek() !== '(' && this.peek() !== '{') {
      name = this.next()!;
    }
    const variables: Record<string, { type: string; default: unknown }> = {};
    if (this.peek() === '(') {
      this.expect('(');
      while (this.peek() !== ')') {
        const rawVariable = this.next()!;
        if (!rawVariable.startsWith('$')) throw new Error(`expected a variable, found '${rawVariable}'`);
        const varName = rawVariable.slice(1);
        this.expect(':');
        const type = this.readTypeRef();
        let defaultValue: unknown = null;
        if (this.peek() === '=') {
          this.next();
          defaultValue = this.parseValueLiteral(true);
        }
        variables[varName] = { type, default: defaultValue };
      }
      this.expect(')');
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private readTypeRef(): string {
    let type = '';
    if (this.peek() === '[') {
      type += this.next();
      type += this.readTypeRef();
      if (this.peek() === ']') type += this.next();
    } else {
      type += this.next() ?? '';
    }
    if (this.peek() === '!') type += this.next();
    return type;
  }

  private parseValueLiteral(inVariableContext: boolean): unknown {
    const token = this.next();
    if (token === undefined) throw new Error('unexpected end of input in value');
    if (token === '$') {
      const varName = this.next()!;
      return { __var: varName };
    }
    if (token.startsWith('$')) {
      return { __var: token.slice(1) };
    }
    if (token === '[') {
      const items: unknown[] = [];
      while (this.peek() !== ']') items.push(this.parseValueLiteral(inVariableContext));
      this.next();
      return items;
    }
    if (token === '{') {
      const object: Record<string, unknown> = {};
      while (this.peek() !== '}') {
        const key = this.next()!;
        this.expect(':');
        object[key] = this.parseValueLiteral(inVariableContext);
      }
      this.next();
      return object;
    }
    return decodeToken(token);
  }

  private parseArguments(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    if (this.peek() !== '(') return args;
    this.expect('(');
    while (this.peek() !== ')') {
      const name = this.next()!;
      this.expect(':');
      args[name] = this.parseValueLiteral(false);
    }
    this.expect(')');
    return args;
  }

  private parseSelectionSet(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === undefined) throw new Error('unexpected end of input in selection set');
      if (this.peek() === '...') {
        this.next();
        // inline fragment: ... on Type { ... } (or a named fragment spread)
        if (this.peek() === 'on') {
          this.next();
          this.next(); // the type name — accepted but ignored (documents stay within one type)
        } else {
          this.next(); // fragment spread name
        }
        fields.push(...this.parseSelectionSet());
        continue;
      }
      let name = this.next()!;
      let alias: string | null = null;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next()!;
      }
      const args = this.parseArguments();
      let selections: FieldNode[] | null = null;
      if (this.peek() === '{') selections = this.parseSelectionSet();
      fields.push({ alias, name, args, selections });
    }
    this.expect('}');
    return fields;
  }
}

// ---------------------------------------------------------------- schema (for introspection)

interface SchemaField {
  name: string;
  type: string; // e.g. 'ID!' | '[Issue!]' | 'IssueConnection!'
  args?: Record<string, string>;
}

interface SchemaType {
  kind: 'OBJECT' | 'ENUM' | 'SCALAR' | 'INTERFACE';
  fields?: SchemaField[];
  enumValues?: string[];
}

const ENUM_SEARCH_TYPE = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'ORGANIZATION', 'ISSUE_COMMENT', 'COMMIT', 'APP', 'DISCUSSION'];

function buildSchema(): Record<string, SchemaType> {
  const pageInfo: SchemaField[] = [
    { name: 'hasNextPage', type: 'Boolean!' },
    { name: 'hasPreviousPage', type: 'Boolean!' },
    { name: 'startCursor', type: 'String' },
    { name: 'endCursor', type: 'String' },
  ];
  const types: Record<string, SchemaType> = {
    Query: {
      kind: 'OBJECT',
      fields: [
        { name: 'viewer', type: 'User!' },
        { name: 'repository', type: 'Repository', args: { owner: 'String!', name: 'String!' } },
        { name: 'node', type: 'Node', args: { id: 'ID!' } },
        { name: 'nodes', type: '[Node]', args: { ids: '[ID!]!' } },
      ],
    },
    Mutation: {
      kind: 'OBJECT',
      fields: [
        { name: 'createIssue', type: 'CreateIssuePayload', args: { input: 'CreateIssueInput!' } },
        { name: 'closeIssue', type: 'CloseIssuePayload', args: { input: 'CloseIssueInput!' } },
        { name: 'updateIssue', type: 'UpdateIssuePayload', args: { input: 'UpdateIssueInput!' } },
        { name: 'createPullRequest', type: 'CreatePullRequestPayload', args: { input: 'CreatePullRequestInput!' } },
        { name: 'mergePullRequest', type: 'MergePullRequestPayload', args: { input: 'MergePullRequestInput!' } },
        { name: 'addComment', type: 'AddCommentPayload', args: { input: 'AddCommentInput!' } },
      ],
    },
    User: {
      kind: 'OBJECT',
      fields: [
        { name: 'login', type: 'String!' },
        { name: 'url', type: 'URI!' },
        { name: 'createdAt', type: 'DateTime!' },
        { name: 'repositories', type: 'RepositoryConnection' },
      ],
    },
    Repository: {
      kind: 'OBJECT',
      fields: [
        { name: 'id', type: 'ID!' },
        { name: 'name', type: 'String!' },
        { name: 'nameWithOwner', type: 'String!' },
        { name: 'description', type: 'String' },
        { name: 'isPrivate', type: 'Boolean!' },
        { name: 'createdAt', type: 'DateTime!' },
        { name: 'pushedAt', type: 'DateTime' },
        { name: 'url', type: 'URI!' },
        { name: 'viewerPermission', type: 'RepositoryPermission!' },
        { name: 'hasIssuesEnabled', type: 'Boolean!' },
        { name: 'owner', type: 'Owner!' },
        { name: 'defaultBranchRef', type: 'Ref' },
        { name: 'issues', type: 'IssueConnection!', args: { first: 'Int', after: 'String', states: '[IssueState!]', orderBy: 'IssueOrder' } },
        { name: 'pullRequests', type: 'PullRequestConnection', args: { first: 'Int', after: 'String', states: '[PullRequestState!]' } },
        { name: 'databaseId', type: 'Int!' },
        { name: 'issue', type: 'Issue', args: { number: 'Int!' } },
        { name: 'pullRequest', type: 'PullRequest', args: { number: 'Int!' } },
      ],
    },
    Ref: { kind: 'OBJECT', fields: [{ name: 'name', type: 'String!' }, { name: 'id', type: 'ID!' }, { name: 'target', type: 'GitObject' }] },
    GitObject: { kind: 'INTERFACE', fields: [{ name: 'id', type: 'ID!' }] },
    Commit: { kind: 'OBJECT', fields: [{ name: 'id', type: 'ID!' }, { name: 'oid', type: 'GitObjectID!' }, { name: 'message', type: 'String!' }, { name: 'messageHeadline', type: 'String!' }] },
    Issue: {
      kind: 'OBJECT',
      fields: [
        { name: 'id', type: 'ID!' },
        { name: 'number', type: 'Int!' },
        { name: 'title', type: 'String!' },
        { name: 'body', type: 'String' },
        { name: 'state', type: 'IssueState!' },
        { name: 'createdAt', type: 'DateTime!' },
        { name: 'closedAt', type: 'DateTime' },
        { name: 'url', type: 'URI!' },
        { name: 'author', type: 'Actor' },
        { name: 'repository', type: 'Repository!' },
        { name: 'comments', type: 'IssueCommentConnection', args: { first: 'Int' } },
      ],
    },
    PullRequest: {
      kind: 'OBJECT',
      fields: [
        { name: 'id', type: 'ID!' },
        { name: 'number', type: 'Int!' },
        { name: 'title', type: 'String!' },
        { name: 'body', type: 'String' },
        { name: 'state', type: 'PullRequestState!' },
        { name: 'merged', type: 'Boolean!' },
        { name: 'mergedAt', type: 'DateTime' },
        { name: 'mergeCommit', type: 'Commit' },
        { name: 'mergeable', type: 'MergeableState!' },
        { name: 'mergeStateStatus', type: 'PullRequestMergeStateStatus!' },
        { name: 'viewerCanMerge', type: 'Boolean!' },
        { name: 'url', type: 'URI!' },
        { name: 'baseRefName', type: 'String!' },
        { name: 'headRefName', type: 'String!' },
        { name: 'author', type: 'Actor' },
        { name: 'repository', type: 'Repository!' },
        { name: 'files', type: 'PullRequestFileConnection', args: { first: 'Int' } },
        { name: 'commits', type: 'PullRequestCommitConnection', args: { first: 'Int' } },
      ],
    },
    IssueConnection: { kind: 'OBJECT', fields: [{ name: 'nodes', type: '[Issue]' }, { name: 'edges', type: '[IssueEdge]' }, { name: 'pageInfo', type: 'PageInfo!' }, { name: 'totalCount', type: 'Int!' }] },
    IssueEdge: { kind: 'OBJECT', fields: [{ name: 'node', type: 'Issue' }, { name: 'cursor', type: 'String!' }] },
    PullRequestConnection: { kind: 'OBJECT', fields: [{ name: 'nodes', type: '[PullRequest]' }, { name: 'pageInfo', type: 'PageInfo!' }, { name: 'totalCount', type: 'Int!' }] },
    PullRequestFileConnection: { kind: 'OBJECT', fields: [{ name: 'nodes', type: '[PullRequestFile]' }, { name: 'pageInfo', type: 'PageInfo!' }, { name: 'totalCount', type: 'Int!' }] },
    PullRequestFile: { kind: 'OBJECT', fields: [{ name: 'path', type: 'String!' }, { name: 'additions', type: 'Int!' }, { name: 'deletions', type: 'Int!' }] },
    PullRequestCommitConnection: { kind: 'OBJECT', fields: [{ name: 'nodes', type: '[Commit]' }, { name: 'pageInfo', type: 'PageInfo!' }] },
    IssueCommentConnection: { kind: 'OBJECT', fields: [{ name: 'nodes', type: '[IssueComment]' }, { name: 'totalCount', type: 'Int!' }] },
    IssueComment: { kind: 'OBJECT', fields: [{ name: 'id', type: 'ID!' }, { name: 'body', type: 'String!' }, { name: 'author', type: 'Actor' }, { name: 'createdAt', type: 'DateTime!' }] },
    Comment: { kind: 'OBJECT', fields: [{ name: 'id', type: 'ID!' }, { name: 'body', type: 'String!' }, { name: 'author', type: 'Actor' }, { name: 'createdAt', type: 'DateTime!' }] },
    Actor: { kind: 'INTERFACE', fields: [{ name: 'login', type: 'String!' }, { name: 'url', type: 'URI!' }] },
    Owner: { kind: 'INTERFACE', fields: [{ name: 'login', type: 'String!' }, { name: 'url', type: 'URI!' }] },
    PageInfo: { kind: 'OBJECT', fields: pageInfo },
    RepositoryConnection: { kind: 'OBJECT', fields: [{ name: 'nodes', type: '[Repository]' }, { name: 'pageInfo', type: 'PageInfo!' }, { name: 'totalCount', type: 'Int!' }] },
    Node: { kind: 'INTERFACE', fields: [{ name: 'id', type: 'ID!' }] },
    CreateIssuePayload: { kind: 'OBJECT', fields: [{ name: 'issue', type: 'Issue' }] },
    CloseIssuePayload: { kind: 'OBJECT', fields: [{ name: 'issue', type: 'Issue' }] },
    UpdateIssuePayload: { kind: 'OBJECT', fields: [{ name: 'issue', type: 'Issue' }] },
    CreatePullRequestPayload: { kind: 'OBJECT', fields: [{ name: 'pullRequest', type: 'PullRequest' }] },
    MergePullRequestPayload: { kind: 'OBJECT', fields: [{ name: 'pullRequest', type: 'PullRequest' }] },
    AddCommentPayload: { kind: 'OBJECT', fields: [{ name: 'commentEdge', type: 'IssueCommentEdge' }] },
    IssueCommentEdge: { kind: 'OBJECT', fields: [{ name: 'node', type: 'IssueComment' }] },
    MergePullRequestPayload: { kind: 'OBJECT', fields: [{ name: 'pullRequest', type: 'PullRequest' }] },
    AddCommentPayload: { kind: 'OBJECT', fields: [{ name: 'commentEdge', type: 'IssueCommentEdge!' }] },
    IssueCommentEdge: { kind: 'OBJECT', fields: [{ name: 'node', type: 'IssueComment' }] },
    IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
    PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
    MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
    PullRequestMergeStateStatus: { kind: 'ENUM', enumValues: ['CLEAN', 'DIRTY', 'BLOCKED', 'UNSTABLE', 'UNKNOWN'] },
    IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
    RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
    SearchType: { kind: 'ENUM', enumValues: ENUM_SEARCH_TYPE },
  };
  return types;
}

const SCHEMA = buildSchema();

interface TypeRef {
  name: string;
  kind: string;
  ofType: TypeRef | null;
}

function parseTypeRef(spec: string): TypeRef {
  let nonNull = false;
  let list = false;
  let inner = spec;
  if (inner.endsWith('!')) {
    nonNull = true;
    inner = inner.slice(0, -1);
  }
  if (inner.startsWith('[') && inner.endsWith(']')) {
    list = true;
    inner = inner.slice(1, -1);
  }
  const base: TypeRef = { name: inner, kind: SCALAR_KINDS.has(inner) ? 'SCALAR' : SCHEMA[inner]?.kind ?? 'SCALAR', ofType: null };
  if (list) return { name: null as unknown as string, kind: 'LIST', ofType: nonNullWrap(base, inner.endsWith('!')) };
  return nonNullWrap(base, false);
  function nonNullWrap(ref: TypeRef, forceNonNull: boolean): TypeRef {
    void forceNonNull;
    if (nonNull) return { ...ref };
    return ref;
  }
}

const SCALAR_KINDS = new Set(['Int', 'Float', 'String', 'Boolean', 'ID', 'DateTime', 'URI', 'GitObjectID', 'HTML']);

// ---------------------------------------------------------------- execution

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: GqlError[];
}

type Tagged = { __type: string; __src: unknown };

const tag = (typeName: string, src: unknown): Tagged => ({ __type: typeName, __src: src });

function nodeId(typeName: string, id: number): string {
  return Buffer.from(`${typeName}:${id}`).toString('base64');
}

function decodeNodeId(id: string): { type: string; id: number } | null {
  try {
    const raw = Buffer.from(id, 'base64').toString('utf8');
    const split = raw.lastIndexOf(':');
    const parsed = Number.parseInt(raw.slice(split + 1), 10);
    if (Number.isNaN(parsed)) return null;
    return { type: raw.slice(0, split), id: parsed };
  } catch {
    return null;
  }
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`).toString('base64');
}

function decodeCursor(cursor: string | undefined): number | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    if (!raw.startsWith('cursor:')) return null;
    const parsed = Number.parseInt(raw.slice(7), 10);
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}

interface GqlIssue {
  repoKey: string;
  number: number;
}

function resolveScalarPlaceholder(): never {
  throw new Error('unreachable');
}
void resolveScalarPlaceholder;

// Field resolvers per type context. Each returns a plain value or a Tagged object.
function fieldResolver(typeName: string, field: string, source: unknown, args: Record<string, unknown>, ctx: Ctx): unknown {
  const store = ctx.store;
  if (field === '__typename') return typeName;
  switch (typeName) {
    case 'Query':
      if (field === 'viewer') return tag('User', { login: store.login });
      if (field === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        const repo = findRepo(store, owner, name);
        return repo ? tag('Repository', repo) : null;
      }
      if (field === 'node' || field === 'nodes') return resolveNodes(field, args, ctx);
      break;
    case 'User':
      if (field === 'login') return store.login;
      if (field === 'url') return `https://git.make.fun/${store.login}`;
      if (field === 'createdAt') return '2026-01-01T00:00:00Z';
      if (field === 'repositories') {
        const repos = [...store.repos.values()].sort((a, b) => a.id - b.id);
        return connectionOf(repos.map((repo) => tag('Repository', repo)), args);
      }
      break;
    case 'Repository': {
      const repo = source as Repository;
      if (field === 'id') return nodeId('Repository', repo.id);
      if (field === 'name') return repo.name;
      if (field === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field === 'description') return repo.description || null;
      if (field === 'isPrivate') return repo.isPrivate;
      if (field === 'createdAt') return repo.createdAt;
      if (field === 'pushedAt') return repo.updatedAt;
      if (field === 'url') return `https://git.make.fun/${repo.owner}/${repo.name}`;
      if (field === 'viewerPermission') return 'ADMIN';
      if (field === 'databaseId') return repo.id;
      if (field === 'issue') {
        const number = Number(args.number ?? 0);
        return repo.issues.has(number) ? tag('Issue', { repoKey: repo.name, number } as GqlIssue) : null;
      }
      if (field === 'pullRequest') {
        const number = Number(args.number ?? 0);
        return repo.pulls.has(number) ? tag('PullRequest', { repoKey: repo.name, number } as GqlIssue) : null;
      }
      if (field === 'hasIssuesEnabled') return true;
      if (field === 'owner') return tag('Owner', { login: repo.owner });
      if (field === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip === undefined) return null;
        return tag('Ref', { name: repo.defaultBranch, oid: tip });
      }
      if (field === 'issues') {
        const states = Array.isArray(args.states) ? args.states.map((state) => String(state).toUpperCase()) : null;
        let issues = [...repo.issues.values()].sort((a, b) => b.number - a.number);
        if (states) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
        const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
        if (orderBy?.field === 'CREATED_AT' || orderBy === undefined || orderBy === null) {
          issues.sort((a, b) => {
            const cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
            const direction = orderBy?.direction === 'ASC' ? 1 : -1;
            return cmp === 0 ? b.number - a.number : cmp * direction;
          });
        }
        const nodes = issues.map((issue) => tag('Issue', { repoKey: repo.name, number: issue.number } as GqlIssue));
        return connectionOf(nodes, args);
      }
      if (field === 'pullRequests') {
        let pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
        const states = Array.isArray(args.states) ? args.states.map((state) => String(state).toUpperCase()) : null;
        if (states) pulls = pulls.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
        const nodes = pulls.map((pull) => tag('PullRequest', { repoKey: repo.name, number: pull.number } as GqlIssue));
        return connectionOf(nodes, args);
      }
      break;
    }
    case 'Owner':
    case 'Actor':
      if (field === 'login') return (source as { login: string }).login;
      if (field === 'url') return `https://git.make.fun/${(source as { login: string }).login}`;
      break;
    case 'Ref':
      if (field === 'name') return (source as { name: string }).name;
      if (field === 'id') return nodeId('Ref', 0);
      if (field === 'target') return tag('Commit', { oid: (source as { oid: string }).oid });
      break;
    case 'Commit':
      if (field === 'oid') return (source as { oid: string }).oid;
      if (field === 'id') return nodeId('Commit', 0);
      if (field === 'message') return (source as { message?: string }).message ?? '';
      if (field === 'messageHeadline') return ((source as { message?: string }).message ?? '').split('\n')[0];
      break;
    case 'Issue':
    case 'PullRequest': {
      const ref = source as GqlIssue;
      const repo = store.repos.get(ref.repoKey);
      if (!repo) return null;
      if (typeName === 'Issue') {
        const issue = repo.issues.get(ref.number);
        if (!issue) return null;
        if (field === 'id') return nodeId('Issue', issue.id);
        if (field === 'number') return issue.number;
        if (field === 'title') return issue.title;
        if (field === 'body') return issue.body;
        if (field === 'state') return issue.state.toUpperCase();
        if (field === 'createdAt') return issue.createdAt;
        if (field === 'closedAt') return issue.closedAt;
        if (field === 'url') return `https://git.make.fun/${repo.owner}/${repo.name}/issues/${issue.number}`;
        if (field === 'author') return tag('Actor', { login: issue.user });
        if (field === 'repository') return tag('Repository', repo);
        if (field === 'comments') {
          const nodes = issue.comments.map((comment) => tag('IssueComment', comment));
          return { nodes, pageInfo: pageInfoOf(nodes.length, null), totalCount: nodes.length };
        }
      } else {
        const pull = repo.pulls.get(ref.number);
        if (!pull) return null;
        if (field === 'id') return nodeId('PullRequest', pull.id);
        if (field === 'number') return pull.number;
        if (field === 'title') return pull.title;
        if (field === 'body') return pull.body;
        if (field === 'state') return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        if (field === 'merged') return pull.merged;
        if (field === 'mergedAt') return pull.mergedAt;
        if (field === 'mergeCommit') return pull.mergeCommitSha ? tag('Commit', { oid: pull.mergeCommitSha, message: `Merge pull request #${pull.number}` }) : null;
        if (field === 'mergeable') return 'MERGEABLE';
        if (field === 'mergeStateStatus') return pull.merged ? 'CLEAN' : 'CLEAN';
        if (field === 'viewerCanMerge') return true;
        if (field === 'url') return `https://git.make.fun/${repo.owner}/${repo.name}/pull/${pull.number}`;
        if (field === 'baseRefName') return pull.base;
        if (field === 'headRefName') return pull.head;
        if (field === 'author') return tag('Actor', { login: pull.user });
        if (field === 'repository') return tag('Repository', repo);
        if (field === 'files') {
          const files = prFiles(repo, pull);
          return connectionOf(files, args);
        }
        if (field === 'commits') {
          return { nodes: [], pageInfo: pageInfoOf(0, null), totalCount: 0 };
        }
      }
      break;
    }
    case 'IssueComment': {
      const comment = source as { id: number; body: string; createdAt: string };
      if (field === 'id') return nodeId('IssueComment', comment.id);
      if (field === 'body') return comment.body;
      if (field === 'createdAt') return comment.createdAt;
      if (field === 'author') return tag('Actor', { login: store.login });
      break;
    }
    case 'PullRequestFile': {
      const file = source as { path: string; additions: number; deletions: number };
      if (field === 'path') return file.path;
      if (field === 'additions') return file.additions;
      if (field === 'deletions') return file.deletions;
      break;
    }
    case 'PageInfo': {
      const info = source as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
      if (field === 'hasNextPage') return info.hasNextPage;
      if (field === 'hasPreviousPage') return info.hasPreviousPage;
      if (field === 'startCursor') return info.startCursor;
      if (field === 'endCursor') return info.endCursor;
      break;
    }
    case 'CreateIssuePayload': return unwrapPayload('Issue', field, source);
    case 'CloseIssuePayload': return unwrapPayload('Issue', field, source);
    case 'UpdateIssuePayload': return unwrapPayload('Issue', field, source);
    case 'CreatePullRequestPayload': return unwrapPayload('PullRequest', field, source);
    case 'MergePullRequestPayload': return unwrapPayload('PullRequest', field, source);
    case 'AddCommentPayload':
      if (field === 'commentEdge') return tag('IssueCommentEdge', (source as Record<string, unknown>).commentEdge);
      break;
    case 'IssueCommentEdge':
      if (field === 'node') return (source as Record<string, unknown>).node;
      break;
    default:
      break;
  }
  // Unknown field: record a GraphQL error naming the field and type.
  ctx.errors.push({ message: `Field '${field}' doesn't exist on type '${typeName}'` });
  return undefined;
}

function unwrapPayload(kind: 'Issue' | 'PullRequest', field: string, source: unknown): unknown {
  if (field === (kind === 'Issue' ? 'issue' : 'pullRequest')) return (source as Record<string, unknown>)[field];
  return undefined;
}

function resolveNodes(field: string, args: Record<string, unknown>, ctx: Ctx): unknown {
  const ids = field === 'nodes' ? (args.ids as string[]) : [args.id as string];
  const results = [];
  for (const id of ids ?? []) {
    const decoded = decodeNodeId(String(id));
    if (!decoded) {
      results.push(null);
      continue;
    }
    if (decoded.type === 'Issue') {
      for (const repo of ctx.store.repos.values()) {
        const issue = repo.issues.get(decoded.id);
        if (issue) results.push(tag('Issue', { repoKey: repo.name, number: issue.number } as GqlIssue));
      }
      if (results.length === 0) results.push(null);
    } else if (decoded.type === 'PullRequest') {
      for (const repo of ctx.store.repos.values()) {
        const pull = repo.pulls.get(decoded.id);
        if (pull) results.push(tag('PullRequest', { repoKey: repo.name, number: pull.number } as GqlIssue));
      }
      if (results.length === 0) results.push(null);
    } else if (decoded.type === 'Repository') {
      for (const repo of ctx.store.repos.values()) if (repo.id === decoded.id) results.push(tag('Repository', repo));
      if (results.length === 0) results.push(null);
    } else {
      results.push(null);
    }
    if (field === 'node') break;
  }
  return field === 'nodes' ? results : results[0] ?? null;
}

function prFiles(repo: Repository, pull: import('./store.ts').PullRequest): Tagged[] {
  const currentHead = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const hc = repo.objects.get(currentHead); const bc = repo.objects.get(pull.baseSha);
  const headCommit = repo.objects.get(currentHead);
  const baseCommit = repo.objects.get(pull.baseSha);
  if (!headCommit || !baseCommit) return [];
  const diffs = diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
  return diffs.map((file) => tag('PullRequestFile', { path: file.filename, additions: file.additions, deletions: file.deletions }));
}

function connectionOf(nodes: Tagged[], args: Record<string, unknown>): { nodes: Tagged[]; pageInfo: unknown; totalCount: number } {
  const first = typeof args.first === 'number' ? args.first : 30;
  const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
  const start = after === null ? 0 : after + 1;
  const slice = nodes.slice(start, start + first);
  const hasNextPage = start + slice.length < nodes.length;
  const endCursor = slice.length > 0 ? encodeCursor(start + slice.length - 1) : null;
  return {
    nodes: slice,
    pageInfo: { hasNextPage, hasPreviousPage: start > 0, startCursor: slice.length > 0 ? encodeCursor(start) : null, endCursor },
    totalCount: nodes.length,
  };
}

function pageInfoOf(count: number, cursor: string | null): unknown {
  return { hasNextPage: false, hasPreviousPage: false, startCursor: cursor, endCursor: cursor, totalCount: count };
}

// ---------------------------------------------------------------- mutations

function runMutation(field: string, args: Record<string, unknown>, ctx: Ctx): unknown {
  const store = ctx.store;
  const input = (args.input ?? {}) as Record<string, unknown>;
  const findIssue = (issueId: string): { repoKey: string; number: number } | null => {
    const decoded = decodeNodeId(String(issueId));
    if (!decoded || decoded.type !== 'Issue') return null;
    for (const repo of store.repos.values()) {
      if (repo.issues.has(decoded.id)) return { repoKey: repo.name, number: decoded.id };
    }
    return null;
  };
  const findPull = (pullId: string): { repoKey: string; number: number } | null => {
    const decoded = decodeNodeId(String(pullId));
    if (!decoded || decoded.type !== 'PullRequest') return null;
    for (const repo of store.repos.values()) {
      if (repo.pulls.has(decoded.id)) return { repoKey: repo.name, number: decoded.id };
    }
    return null;
  };
  if (field === 'createIssue') {
    const repoId = String(input.repositoryId ?? '');
    const decoded = decodeNodeId(repoId);
    if (!decoded || decoded.type !== 'Repository') {
      ctx.errors.push({ message: 'Could not resolve to a node with the global id of the repository' });
      return null;
    }
    for (const repo of store.repos.values()) {
      if (repo.id !== decoded.id) continue;
      const id = repo.nextIssueNumber;
      const issue = {
        id,
        number: id,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
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
      return tag('CreateIssuePayload', { issue: tag('Issue', { repoKey: repo.name, number: id } as GqlIssue) });
    }
    ctx.errors.push({ message: 'Could not resolve to a node with the global id of the repository' });
    return null;
  }
  if (field === 'closeIssue' || field === 'updateIssue') {
    const ref = findIssue(String(input.issueId ?? input.id ?? ''));
    if (!ref) {
      ctx.errors.push({ message: 'Could not resolve to a node with the global id' });
      return null;
    }
    const repo = store.repos.get(ref.repoKey)!;
    const issue = repo.issues.get(ref.number)!;
    if (field === 'closeIssue') {
      issue.state = 'closed';
      issue.closedAt = new Date().toISOString();
      issue.updatedAt = issue.closedAt;
    } else if (typeof input.state === 'string') {
      issue.state = input.state.toLowerCase() === 'closed' ? 'closed' : 'open';
    }
    return tag(field === 'closeIssue' ? 'CloseIssuePayload' : 'UpdateIssuePayload', { issue: tag('Issue', { repoKey: ref.repoKey, number: ref.number } as GqlIssue) });
  }
  if (field === 'createPullRequest') {
    const repoId = String(input.repositoryId ?? '');
    const decoded = decodeNodeId(repoId);
    if (!decoded || decoded.type !== 'Repository') {
      ctx.errors.push({ message: 'Could not resolve to a node with the global id of the repository' });
      return null;
    }
    for (const repo of store.repos.values()) {
      if (repo.id !== decoded.id) continue;
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? repo.defaultBranch);
      const headOid = repo.refs.get(`refs/heads/${head}`);
      if (!headOid || !repo.refs.has(`refs/heads/${base}`)) {
        ctx.errors.push({ message: `Head ref '${head}' or base ref '${base}' could not be resolved` });
        return null;
      }
      const number = repo.nextPullNumber;
      const pull = {
        id: number,
        number,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
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
      return tag('CreatePullRequestPayload', { pullRequest: tag('PullRequest', { repoKey: repo.name, number } as GqlIssue) });
    }
    ctx.errors.push({ message: 'Could not resolve to a node with the global id of the repository' });
    return null;
  }
  if (field === 'mergePullRequest') {
    const ref = findPull(String(input.pullRequestId ?? ''));
    if (!ref) {
      ctx.errors.push({ message: 'Could not resolve to a node with the global id' });
      return null;
    }
    const outcome = mergePullById(store, ref.repoKey, ref.number);
    if (!outcome || outcome.status !== 200) {
      ctx.errors.push({ message: `Pull Request is not mergeable: ${(outcome?.body as { message?: string })?.message ?? 'unknown error'}` });
      return null;
    }
    return tag('MergePullRequestPayload', { pullRequest: tag('PullRequest', { repoKey: ref.repoKey, number: ref.number } as GqlIssue) });
  }
  if (field === 'addComment') {
    const subject = String(input.subjectId ?? '');
    const ref = findIssue(subject);
    if (!ref) {
      ctx.errors.push({ message: 'Could not resolve to a node with the global id' });
      return null;
    }
    const repo = store.repos.get(ref.repoKey)!;
    const issue = repo.issues.get(ref.number)!;
    const comment = { id: repo.nextCommentId++, body: String(input.body ?? ''), createdAt: new Date().toISOString() };
    issue.comments.push(comment);
    issue.updatedAt = comment.createdAt;
    return tag('AddCommentPayload', { commentEdge: { node: tag('IssueComment', comment) } });
  }
  ctx.errors.push({ message: `Field '${field}' doesn't exist on type 'Mutation'` });
  return null;
}

// ---------------------------------------------------------------- document execution

function executeOperation(operation: Operation, variables: Record<string, unknown>, ctx: Ctx): Record<string, unknown> {
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const selections = substituteVariables(operation.selections, variables);
  const data = serialize(rootType, { login: ctx.store.login }, selections, ctx);
  return data as Record<string, unknown>;
}

/** Replace {__var} argument values with the operation's variable values. */
function substituteVariables(selections: FieldNode[], variables: Record<string, unknown>): FieldNode[] {
  return selections.map((field) => ({
    ...field,
    args: Object.fromEntries(Object.entries(field.args).map(([key, value]) => [key, substituteValue(value, variables)])),
    selections: field.selections ? substituteVariables(field.selections, variables) : null,
  }));
}

function substituteValue(value: unknown, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if ('__var' in (value as Record<string, unknown>)) {
      const name = String((value as { __var: unknown }).__var);
      return name in variables ? variables[name] : null;
    }
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, substituteValue(v, variables)]));
  }
  if (Array.isArray(value)) return value.map((item) => substituteValue(item, variables));
  return value;
}

function serialize(typeName: string, source: unknown, selections: FieldNode[], ctx: Ctx): unknown {
  const out: Record<string, unknown> = {};
  for (const field of selections) {
    const key = field.alias ?? field.name;
    out[key] = emitField(typeName, source, field, ctx);
  }
  return out;
}

/** Resolve one field and serialize its value according to the field's own selection set. */
function emitField(typeName: string, source: unknown, field: FieldNode, ctx: Ctx): unknown {
  const key = field.alias ?? field.name;
  if (field.name === '__schema' && typeName === 'Query') {
    return serializeSchema(field.selections ?? [], ctx);
  }
  if (field.name === '__type' && typeName === 'Query') {
    const name = String(field.args.name ?? '');
    return SCHEMA[name] ? serializeType(name, field.selections ?? [], ctx) : null;
  }
  let resolved: unknown;
  if (typeName === 'Mutation') {
    const value = runMutation(field.name, field.args, ctx);
    if (value !== null && typeof value === 'object' && '__type' in (value as Tagged)) {
      const tagged = value as Tagged;
      return field.selections ? serialize(tagged.__type, tagged.__src, field.selections, ctx) : null;
    }
    return value;
  }
  if (typeName === 'MutationPayload') {
    // A mutation payload object produced inline (e.g. commentEdge): read plain properties.
    resolved = (source as Record<string, unknown>)[field.name];
    if (resolved === undefined) return fieldResolver('AddCommentPayload', field.name, source, field.args, ctx);
  } else if (source !== null && typeof source === 'object' && !('__type' in (source as Record<string, unknown>)) && (source as Record<string, unknown>).__plain === true) {
    resolved = (source as Record<string, unknown>)[field.name];
  } else {
    resolved = fieldResolver(typeName, field.name, source, field.args, ctx);
    if (resolved === undefined) return null;
  }
  return renderValue(resolved, field.selections, ctx);
}

function renderValue(resolved: unknown, selections: FieldNode[] | null, ctx: Ctx): unknown {
  if (resolved === undefined) return null;
  if (resolved === null) return null;
  if (typeof resolved === 'object' && '__type' in (resolved as Tagged)) {
    const tagged = resolved as Tagged;
    return selections ? serialize(tagged.__type, tagged.__src, selections, ctx) : taggedToScalar(tagged);
  }
  if (Array.isArray(resolved)) {
    return resolved.map((item) => renderValue(item, selections, ctx));
  }
  if (typeof resolved === 'object') {
    // A plain nested object (connection payloads, pageInfo): walk the same selection set
    // reading properties directly, falling back to type resolvers for tagged values inside.
    const plain = { ...(resolved as Record<string, unknown>), __plain: true };
    return serialize('MutationPayload', plain, selections ?? [], ctx);
  }
  return resolved;
}

function taggedToScalar(tagged: Tagged): unknown {
  if (tagged.__type === 'PullRequestFile') return (tagged.__src as { path: string }).path;
  if (tagged.__type === 'IssueComment') return (tagged.__src as { body: string }).body;
  return null;
}

// ---------------------------------------------------------------- introspection serialization

function serializeSchema(selections: FieldNode[], ctx: Ctx): unknown {
  const out: Record<string, unknown> = {};
  for (const field of selections) {
    const key = field.alias ?? field.name;
    if (field.name === 'queryType') out[key] = serializeTypeShallow('Query', field.selections ?? []);
    else if (field.name === 'mutationType') out[key] = serializeTypeShallow('Mutation', field.selections ?? []);
    else if (field.name === 'types') out[key] = Object.keys(SCHEMA).map((name) => serializeTypeShallow(name, field.selections?.[0]?.selections ?? []));
    else out[key] = null;
  }
  void ctx;
  return out;
}

function serializeTypeShallow(name: string, selections: FieldNode[]): unknown {
  const out: Record<string, unknown> = { name, kind: SCHEMA[name]?.kind ?? 'SCALAR' };
  for (const field of selections) {
    const key = field.alias ?? field.name;
    if (field.name === 'fields') {
      const type = SCHEMA[name];
      out[key] = type?.fields?.map((schemaField) => ({
        name: schemaField.name,
        type: serializeTypeRefShallow(schemaField.type, field.selections?.[0]?.selections ?? []),
      })) ?? null;
    } else {
      out[key] = null;
    }
  }
  return out;
}

function serializeTypeRefShallow(spec: string, selections: FieldNode[]): unknown {
  const ref = parseTypeRef(spec);
  const out: Record<string, unknown> = {};
  for (const field of selections) {
    const key = field.alias ?? field.name;
    if (field.name === 'kind') out[key] = ref.kind;
    else if (field.name === 'name') out[key] = ref.name ?? null;
    else if (field.name === 'ofType') out[key] = ref.ofType ? serializeTypeRefShallow(reconstructSpec(ref.ofType), field.selections ?? []) : null;
    else out[key] = null;
  }
  return out;
}

function reconstructSpec(ref: TypeRef): string {
  if (ref.kind === 'LIST') return `[${reconstructSpec(ref.ofType!)}]`;
  return ref.name ?? 'String';
}

function serializeType(name: string, selections: FieldNode[], ctx: Ctx): unknown {
  const type = SCHEMA[name];
  const out: Record<string, unknown> = { name, kind: type?.kind ?? 'SCALAR' };
  for (const field of selections) {
    const key = field.alias ?? field.name;
    if (field.name === 'kind') out[key] = out.kind;
    else if (field.name === 'name') out[key] = name;
    else if (field.name === 'fields') {
      const includeDeprecated = field.args.includeDeprecated === true;
      out[key] = type?.fields?.filter((schemaField) => includeDeprecated || schemaField.name !== 'x')
        .map((schemaField) => serializeField(name, schemaField, field.selections?.[0]?.selections ?? [], ctx)) ?? null;
    } else if (field.name === 'inputFields') {
      out[key] = null;
    } else if (field.name === 'enumValues') {
      out[key] = type?.enumValues?.map((value) => ({ name: value })) ?? null;
    } else if (field.name === 'possibleTypes') {
      out[key] = null;
    } else if (field.name === 'interfaces') {
      out[key] = [];
    } else {
      out[key] = null;
    }
  }
  return out;
}

function serializeField(_typeName: string, schemaField: SchemaField, selections: FieldNode[], ctx: Ctx): unknown {
  const out: Record<string, unknown> = { name: schemaField.name };
  for (const field of selections) {
    const key = field.alias ?? field.name;
    if (field.name === 'name') out[key] = schemaField.name;
    else if (field.name === 'type') out[key] = serializeTypeRefShallow(schemaField.type, field.selections ?? []);
    else if (field.name === 'args') out[key] = Object.entries(schemaField.args ?? {}).map(([argName, argType]) => ({ name: argName, type: serializeTypeRefShallow(argType, field.selections?.[0]?.selections ?? []) }));
    else out[key] = null;
  }
  void ctx;
  return out;
}

// ---------------------------------------------------------------- entry point

export function handleGraphql(store: Store, payload: unknown): GraphqlResponse {
  const documents = Array.isArray(payload) ? payload : [payload];
  const responses = documents.map((document) => executeDocument(store, document).body);
  return { status: 200, body: Array.isArray(payload) ? responses : responses[0] };
}

function executeDocument(store: Store, document: { query?: string; variables?: Record<string, unknown>; operationName?: string }): GraphqlResponse {
  const source = typeof document?.query === 'string' ? document.query : '';
  if (source.trim() === '') {
    return { status: 400, body: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  let operations: Operation[];
  try {
    operations = new Parser(source).parseDocument();
  } catch (err) {
    return { status: 400, body: { errors: [{ message: err instanceof Error ? err.message : String(err) }] } };
  }
  let operation = operations[0];
  if (document.operationName) {
    const named = operations.find((candidate) => candidate.name === document.operationName);
    if (named) operation = named;
  }
  const variables: Record<string, unknown> = { ...(document.variables ?? {}) };
  const ctx: Ctx = { store, variables, errors: [] };
  let data: unknown;
  try {
    data = executeOperation(operation, variables, ctx);
  } catch (err) {
    ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
    data = null;
  }
  const body: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) body.errors = ctx.errors;
  return { status: 200, body };
}
