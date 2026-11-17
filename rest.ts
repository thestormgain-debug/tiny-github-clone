// GitHub-compatible REST v3 API over the store: repos, contents, branches, refs,
// commits, issues, labels, comments, pulls, merges, user listing with pagination.
import {
  blobAtPath,
  commitPath,
  createRepo,
  diffTrees,
  dirAtPath,
  findRepo,
  mergeBase,
  walkCommits,
  type Issue,
  type Repository,
  type Store,
} from './store.ts';
import { parseTag, parseCommit, buildCommit } from './gitcore.ts';
import { putObject } from './store.ts';

export interface RestResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface RestRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
  requestId: string;
  /** The entry's origin as the client sees it, e.g. http://127.0.0.1:8080. */
  origin: string;
}

function json(status: number, body: unknown, requestId: string, headers: Record<string, string> = {}): RestResponse {
  return { status, body, headers: { 'X-GitHub-Request-Id': requestId, ...headers } };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------- serializers

export function repoJson(repo: Repository): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `https://git.make.fun/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://git.make.fun/${repo.owner}/${repo.name}.git`,
    size: repo.objects.size,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    has_issues: true,
    permissions: { admin: true, push: true, pull: true },
  };
}

function issueJson(repo: Repository, issue: Issue): Record<string, unknown> {
  return {
    id: 10_000 + issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: issue.user },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://git.make.fun/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repository, pull: import('./store.ts').PullRequest): Record<string, unknown> {
  return {
    id: 20_000 + pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'closed' : pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: pull.user },
    head: { ref: pull.head, sha: pull.headSha, label: pull.head },
    base: { ref: pull.base, sha: pull.baseSha, label: pull.base },
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://git.make.fun/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function refTip(repo: Repository, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

function commitJson(repo: Repository, oid: string): Record<string, unknown> {
  const commit = parseCommit(repo.objects.get(oid)!.data);
  return {
    sha: oid,
    node_id: `C_${oid.slice(0, 8)}`,
    commit: {
      message: commit.message.trim(),
      author: { name: repo.owner, email: `${repo.owner}@make.fun`, date: nowIso() },
      committer: { name: repo.owner, email: `${repo.owner}@make.fun`, date: nowIso() },
      tree: { sha: commit.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${commit.tree}` },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `https://git.make.fun/${repo.owner}/${repo.name}/commit/${oid}`,
  };
}

function contentJson(repo: Repository, oid: string, path: string): Record<string, unknown> {
  const object = repo.objects.get(oid)!;
  const encoding = 'base64';
  return {
    name: path.split('/').pop() ?? path,
    path,
    sha: oid,
    size: object.data.length,
    type: 'file',
    content: object.data.toString(encoding),
    encoding,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    download_url: `https://git.make.fun/${repo.owner}/${repo.name}/raw/${path}`,
    html_url: `https://git.make.fun/${repo.owner}/${repo.name}/blob/${path}`,
  };
}

// ---------------------------------------------------------------- route table

const REPO_PATH = /^\/api\/v3\/repos\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)(\/.*)?$/;

export function handleRest(store: Store, request: RestRequest): RestResponse | null {
  const { method, path, query, body } = request;
  const requestId = request.requestId;
  if (path === '/api/v3/user') {
    return json(200, { login: store.login, id: 1, type: 'User', name: store.login }, requestId);
  }
  if (path === '/api/v3/user/repos') {
    if (method === 'POST') {
      const name = str((request as unknown as { body?: { name?: unknown } }).body?.name);
      if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) {
        return json(422, { message: 'Validation Failed: name is invalid' }, requestId);
      }
      const repo = createRepo(store, name, {
        private: (request as unknown as { body?: { private?: unknown } }).body?.private === undefined
          ? true
          : Boolean((request as unknown as { body?: { private?: unknown } }).body?.private),
        description: str((request as unknown as { body?: { description?: unknown } }).body?.description),
      });
      return json(201, repoJson(repo), requestId);
    }
    return listUserRepos(store, request);
  }
  const match = REPO_PATH.exec(path);
  if (!match) return null;
  const repo = findRepo(store, match[1], match[2]);
  const tail = match[3] ?? '';
  if (!repo) {
    if (method === 'POST' && tail === '') {
      const name = match[2];
      const newRepo = createRepo(store, name, { private: body?.private === undefined ? true : Boolean(body?.private), description: str(body?.description) });
      return json(201, repoJson(newRepo), requestId);
    }
    return json(404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' }, requestId);
  }
  return handleRepoRoute(store, repo, method, tail, query, body, requestId);
}

function listUserRepos(store: Store, request: RestRequest): RestResponse {
  const repos = [...store.repos.values()].sort((a, b) => a.id - b.id);
  const perPage = Math.min(Math.max(Number.parseInt(request.query.get('per_page') ?? '30', 10) || 30, 1), 100);
  const page = Math.max(Number.parseInt(request.query.get('page') ?? '1', 10) || 1, 1);
  const start = (page - 1) * perPage;
  const slice = repos.slice(start, start + perPage);
  const baseUrl = `${request.origin}/api/v3/user/repos?per_page=${perPage}`;
  const headers: Record<string, string> = {};
  const links: string[] = [];
  if (start + perPage < repos.length) links.push(`<${baseUrl}&page=${page + 1}>; rel="next"`);
  if (page > 1) links.push(`<${baseUrl}&page=${Math.max(page - 1, 1)}>; rel="prev"`);
  if (repos.length > perPage) links.push(`<${baseUrl}&page=${Math.max(Math.ceil(repos.length / perPage), 1)}>; rel="last"`, `<${baseUrl}&page=1>; rel="first"`);
  if (links.length > 0) headers.Link = links.join(', ');
  return json(200, slice.map(repoJson), request.requestId, headers);
}

function handleRepoRoute(
  store: Store,
  repo: Repository,
  method: string,
  tail: string,
  query: URLSearchParams,
  body: any,
  requestId: string,
): RestResponse {
  const notFound = (): RestResponse => json(404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' }, requestId);
  if (tail === '' || tail === '/') {
    if (method === 'GET') return json(200, repoJson(repo), requestId);
    if (method === 'PATCH') {
      if (body && typeof body.description === 'string') repo.description = body.description;
      if (body && typeof body.private === 'boolean') repo.isPrivate = body.private;
      repo.updatedAt = nowIso();
      return json(200, repoJson(repo), requestId);
    }
    // DELETE answers 204 with an empty body; a later GET must answer 404 JSON.
    if (method === 'DELETE') {
      store.repos.delete(repo.name);
      return json(204, '', requestId);
    }
    return notFound();
  }
  let match = /^\/branches\/([A-Za-z0-9._/-]+)$/.exec(tail);
  if (match) {
    const branch = match[1];
    const oid = refTip(repo, branch);
    if (method === 'GET') {
      if (!oid) return notFound();
      return json(200, { name: branch, commit: { sha: oid }, protected: false }, requestId);
    }
    return notFound();
  }
  if (tail === '/branches') {
    if (method === 'GET') {
      const branches = [...repo.refs.keys()].filter((name) => name.startsWith('refs/heads/')).sort()
        .map((name) => ({ name: name.slice('refs/heads/'.length), commit: { sha: repo.refs.get(name) }, protected: false }));
      return json(200, branches, requestId);
    }
    return notFound();
  }
  match = /^\/git\/refs\/(?:heads\/)?([A-Za-z0-9._/-]+)$/.exec(tail);
  if (match) {
    const branch = match[1];
    const refName = `refs/heads/${branch}`;
    if (method === 'GET') {
      const oid = repo.refs.get(refName);
      if (!oid) return notFound();
      return json(200, { ref: refName, node_id: `ref_${branch}`, object: { sha: oid, type: 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${oid}` }, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${refName}` }, requestId);
    }
    return notFound();
  }
  if (tail === '/git/refs') {
    if (method === 'POST') {
      const ref = str(body?.ref);
      const sha = str(body?.sha);
      if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(ref) || !/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) {
        return json(422, { message: 'Invalid request: ref or sha missing or invalid' }, requestId);
      }
      if (repo.refs.has(ref)) return json(422, { message: 'Reference already exists' }, requestId);
      repo.refs.set(ref, sha);
      return json(201, { ref, object: { sha, type: 'commit' } }, requestId);
    }
    return notFound();
  }
  match = /^\/commits\/([0-9a-f]{40})$/.exec(tail);
  if (match) {
    const oid = match[1];
    if (!repo.objects.has(oid)) return notFound();
    const object = repo.objects.get(oid)!;
    if (object.type === 'tag') {
      const tag = parseTag(object.data);
      const target = repo.objects.get(tag.object);
      if (target?.type === 'commit') return json(200, commitJson(repo, tag.object), requestId);
    }
    if (object.type !== 'commit') return json(422, { message: 'Not a commit' }, requestId);
    return json(200, commitJson(repo, oid), requestId);
  }
  if (tail === '/commits') {
    if (method === 'GET') {
      const sha = query.get('sha') ?? repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${sha}`) ?? (repo.objects.has(sha) ? sha : null);
      if (!tip) return json(409, { message: 'Git Repository is empty.' }, requestId);
      const commits = walkCommits(repo, tip).map((entry) => commitJson(repo, entry.oid));
      return json(200, commits, requestId);
    }
    return notFound();
  }
  if (tail === '/labels') {
    if (method === 'GET') return json(200, [...repo.labels.values()].map((label) => ({ ...label, id: 500 + repo.labels.size })), requestId);
    if (method === 'POST') {
      const name = str(body?.name);
      if (name === '') return json(422, { message: 'Validation Failed' }, requestId);
      const color = str(body?.color) || 'ededed';
      repo.labels.set(name, { name, color });
      return json(201, { name, color, id: 500 + repo.labels.size }, requestId);
    }
    return notFound();
  }
  match = /^\/labels\/([^/]+)$/.exec(tail);
  if (match) {
    const label = repo.labels.get(decodeURIComponent(match[1]));
    if (!label) return notFound();
    if (method === 'GET') return json(200, { ...label, id: 500 }, requestId);
    if (method === 'PATCH') {
      if (typeof body?.new_name === 'string' && body.new_name !== '') label.name = body.new_name;
      if (typeof body?.color === 'string' && body.color !== '') label.color = body.color;
      return json(200, { ...label, id: 500 }, requestId);
    }
    if (method === 'DELETE') {
      repo.labels.delete(decodeURIComponent(match[1]));
      return json(204, '', requestId);
    }
    return notFound();
  }
  if (tail === '/issues') {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      const perPage = Math.min(Math.max(Number.parseInt(query.get('per_page') ?? '30', 10) || 30, 1), 100);
      const page = Math.max(Number.parseInt(query.get('page') ?? '1', 10) || 1, 1);
      let issues = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state);
      issues.sort((a, b) => (sort === 'created' ? a.id - b.id : a.id - b.id));
      if (direction === 'desc') issues = issues.reverse();
      const start = (page - 1) * perPage;
      return json(200, issues.slice(start, start + perPage).map((issue) => issueJson(repo, issue)), requestId);
    }
    if (method === 'POST') {
      const title = str(body?.title);
      if (title === '') return json(422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'title', code: 'missing_field' }] }, requestId);
      const wanted: string[] = Array.isArray(body?.labels) ? body.labels.map((label: unknown) => str(label)) : [];
      const unknown = wanted.filter((name) => !repo.labels.has(name));
      if (unknown.length > 0) {
        return json(422, { message: `Validation Failed: label ${unknown[0]} does not exist` }, requestId);
      }
      const id = repo.nextIssueNumber;
      const issue: Issue = {
        id,
        number: id,
        title,
        body: str(body?.body),
        state: 'open',
        labels: wanted,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        closedAt: null,
        user: store.login,
        comments: [],
      };
      repo.issues.set(id, issue);
      repo.nextIssueNumber += 1;
      return json(201, issueJson(repo, issue), requestId);
    }
    return notFound();
  }
  match = /^\/issues\/(\d+)$/.exec(tail);
  if (match) {
    const issue = repo.issues.get(Number.parseInt(match[1], 10));
    if (!issue) return notFound();
    if (method === 'GET') return json(200, issueJson(repo, issue), requestId);
    if (method === 'PATCH') {
      if (typeof body?.state === 'string') {
        if (body.state !== 'open' && body.state !== 'closed') return json(422, { message: 'Validation Failed' }, requestId);
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? nowIso() : null;
      }
      if (typeof body?.title === 'string' && body.title !== '') issue.title = body.title;
      if (typeof body?.body === 'string') issue.body = body.body;
      issue.updatedAt = nowIso();
      return json(200, issueJson(repo, issue), requestId);
    }
    return notFound();
  }
  match = /^\/issues\/(\d+)\/comments$/.exec(tail);
  if (match) {
    const issue = repo.issues.get(Number.parseInt(match[1], 10));
    if (!issue) return notFound();
    if (method === 'GET') {
      return json(200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body, created_at: comment.createdAt, user: { login: store.login } })), requestId);
    }
    if (method === 'POST') {
      const text = str(body?.body);
      if (text === '') return json(422, { message: 'Validation Failed' }, requestId);
      const comment = { id: repo.nextCommentId++, body: text, createdAt: nowIso() };
      issue.comments.push(comment);
      issue.updatedAt = nowIso();
      return json(201, { id: comment.id, body: comment.body, created_at: comment.createdAt, user: { login: store.login } }, requestId);
    }
    return notFound();
  }
  if (tail === '/pulls') {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      return json(200, [...repo.pulls.values()].sort((a, b) => a.number - b.number)
        .filter((pull) => state === 'all' || (state === 'open' ? pull.state === 'open' && !pull.merged : pull.state === 'closed'))
        .map((pull) => pullJson(repo, pull)), requestId);
    }
    if (method === 'POST') {
      const head = str(body?.head);
      const base = str(body?.base) || repo.defaultBranch;
      const title = str(body?.title);
      const headOid = refTip(repo, head);
      if (!headOid) return json(422, { message: 'Validation Failed: head not found' }, requestId);
      if (!repo.refs.has(`refs/heads/${base}`)) return json(422, { message: 'Validation Failed: base not found' }, requestId);
      const number = repo.nextPullNumber;
      const pull = {
        id: number,
        number,
        title,
        body: str(body?.body),
        state: 'open' as const,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        head,
        base,
        headSha: headOid,
        baseSha: refTip(repo, base)!,
        createdAt: nowIso(),
        user: store.login,
      };
      repo.pulls.set(number, pull);
      repo.nextPullNumber += 1;
      return json(201, pullJson(repo, pull), requestId);
    }
    return notFound();
  }
  match = /^\/pulls\/(\d+)$/.exec(tail);
  if (match) {
    const pull = repo.pulls.get(Number.parseInt(match[1], 10));
    if (!pull) return notFound();
    if (method === 'GET') return json(200, pullJson(repo, pull), requestId);
    if (method === 'PATCH') {
      if (typeof body?.state === 'string' && body.state === 'closed' && !pull.merged) pull.state = 'closed';
      if (typeof body?.title === 'string' && body.title !== '') pull.title = body.title;
      return json(200, pullJson(repo, pull), requestId);
    }
    return notFound();
  }
  match = /^\/pulls\/(\d+)\/files$/.exec(tail);
  if (match) {
    const pull = repo.pulls.get(Number.parseInt(match[1], 10));
    if (!pull) return notFound();
    const headCommit = repo.objects.get(pull.headSha);
    const baseCommit = repo.objects.get(pull.baseSha);
    if (!headCommit || !baseCommit) return json(422, { message: 'Validation Failed' }, requestId);
    const diffs = diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
    return json(200, diffs.map((diff) => ({
      sha: `${diff.filename}:${diff.additions}-${diff.deletions}`,
      filename: diff.filename,
      status: diff.status,
      additions: diff.additions,
      deletions: diff.deletions,
      changes: diff.changes,
    })), requestId);
  }
  match = /^\/pulls\/(\d+)\/merge$/.exec(tail);
  if (match) {
    const pull = repo.pulls.get(Number.parseInt(match[1], 10));
    if (!pull) return notFound();
    if (method === 'GET') {
      return json(pull.merged ? 204 : 404, pull.merged ? '' : { message: 'Pull Request is not mergeable' }, requestId);
    }
    if (method === 'PUT') {
      const headCommit = repo.objects.get(pull.headSha);
      const baseTip = refTip(repo, pull.base);
      if (!headCommit || !baseTip) return json(422, { message: 'Validation Failed' }, requestId);
      if (pull.merged) {
        return json(405, { message: 'Pull Request has already been merged' }, requestId);
      }
      const baseCommit = repo.objects.get(baseTip)!;
      const base = parseCommit(baseCommit.data);
      const head = parseCommit(headCommit.data);
      const ancestor = mergeBase(repo, baseTip, pull.headSha);
      if (ancestor !== null) {
        const changedPaths = (fromTree: string, toTree: string): Set<string> => {
          const set = new Set<string>();
          for (const diff of diffTrees(repo, fromTree, toTree)) set.add(diff.filename);
          return set;
        };
        const ancestorCommit = repo.objects.get(ancestor);
        if (ancestorCommit) {
          const ancestorTree = parseCommit(ancestorCommit.data).tree;
          const headChanges = changedPaths(ancestorTree, head.tree);
          const baseChanges = changedPaths(ancestorTree, base.tree);
          for (const path of headChanges) {
            if (baseChanges.has(path) && blobAtPath(repo, base.tree, path) !== blobAtPath(repo, head.tree, path)) {
              return json(405, { message: 'Pull Request is not mergeable: conflicts' }, requestId);
            }
          }
        }
      }
      // Squash-style merge: place the head tree onto the base branch as one commit.
      const mergeOid = putObject(repo, 'commit', buildCommit({
        tree: head.tree,
        parents: [baseTip],
        message: `${str(body?.commit_title) || `Merge pull request #${pull.number} from ${pull.head}`}\n\n${pull.title}\n`,
        author: `${repo.owner} <${repo.owner}@make.fun>`,
        committer: `${repo.owner} <${repo.owner}@make.fun>`,
        timestamp: 1_735_689_600 + repo.objects.size,
      }));
      repo.refs.set(`refs/heads/${pull.base}`, mergeOid);
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = nowIso();
      pull.mergeCommitSha = mergeOid;
      repo.updatedAt = nowIso();
      return json(200, { sha: mergeOid, merged: true, message: 'Pull Request successfully merged' }, requestId);
    }
    return notFound();
  }
  match = /^\/contents(?:\/(.*))?$/.exec(tail);
  if (match) {
    return handleContents(repo, method, match[1] ?? '', query, body, requestId);
  }
  return notFound();
}

function handleContents(
  repo: Repository,
  method: string,
  filePath: string,
  query: URLSearchParams,
  body: any,
  requestId: string,
): RestResponse {
  const notFound = (): RestResponse => json(404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' }, requestId);
  const ref = query.get('ref') ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${ref}`);
  if (method === 'GET') {
    if (!tip) return notFound();
    const tree = parseCommit(repo.objects.get(tip)!.data).tree;
    if (filePath === '') {
      const listing = dirAtPath(repo, tree, '');
      return json(200, listing ?? [], requestId);
    }
    const blob = blobAtPath(repo, tree, filePath);
    if (blob !== null) return json(200, contentJson(repo, blob, filePath), requestId);
    const listing = dirAtPath(repo, tree, filePath);
    if (listing !== null) {
      return json(200, listing.map((entry) => ({ ...entry, content: undefined, encoding: undefined })), requestId);
    }
    return notFound();
  }
  if (method === 'PUT') {
    const path = filePath;
    if (path === '' || !body || typeof body.content !== 'string') {
      return json(422, { message: 'Invalid request: content required' }, requestId);
    }
    const content = Buffer.from(body.content, 'base64');
    const branch = typeof body?.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const currentTip = repo.refs.get(`refs/heads/${branch}`) ?? null;
    const existingOid = currentTip ? blobAtPath(repo, parseCommit(repo.objects.get(currentTip)!.data).tree, path) : null;
    if (existingOid && typeof body.sha !== 'string') {
      return json(409, { message: `content.sha isn't a valid SHA-1. Unable to update ${path}.` }, requestId);
    }
    if (existingOid && typeof body.sha === 'string' && body.sha !== existingOid) {
      return json(409, { message: `content.sha isn't a valid SHA-1. Unable to update ${path}.` }, requestId);
    }
    const result = commitPath(repo, { branch, path, content, message: str(body?.message) || `Update ${path}` });
    if (!result) return json(422, { message: 'Validation Failed' }, requestId);
    repo.updatedAt = nowIso();
    const payload = {
      content: { ...contentJson(repo, result.contentSha, path), content: content.toString('base64') },
      commit: { sha: result.commitSha, message: str(body?.message) || `Update ${path}` },
    };
    return json(existingOid ? 200 : 201, payload, requestId);
  }
  if (method === 'DELETE') {
    const path = filePath;
    const branch = typeof body?.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const currentTip = repo.refs.get(`refs/heads/${branch}`);
    if (!currentTip) return json(404, { message: 'Not Found' }, requestId);
    const existingOid = blobAtPath(repo, parseCommit(repo.objects.get(currentTip)!.data).tree, path);
    if (!existingOid) return json(404, { message: 'Not Found' }, requestId);
    if (typeof body?.sha !== 'string' || body.sha !== existingOid) {
      return json(409, { message: `content.sha isn't a valid SHA-1. Unable to delete ${path}.` }, requestId);
    }
    const result = commitPath(repo, { branch, path, content: null, message: str(body?.message) || `Delete ${path}` });
    if (!result) return json(422, { message: 'Validation Failed' }, requestId);
    return json(200, { commit: { sha: result.commitSha, message: str(body?.message) || `Delete ${path}` }, content: null }, requestId);
  }
  return notFound();
}
