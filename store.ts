// The forge's in-memory store: repositories, git objects, refs, issues, pull requests,
// labels and comments. One process, one store; every surface (git, REST, GraphQL, MCP)
// reads and writes this object graph.
import {
  applyDelta,
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTree,
  readPack,
  sha1Hex,
  ZERO_OID,
  type ObjType,
  type TreeEntry,
} from './gitcore.ts';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  user: string;
  comments: IssueComment[];
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  createdAt: string;
  user: string;
}

export interface Repository {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  nextIssueNumber: number;
  nextPullNumber: number;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  labels: Map<string, Label>;
  nextCommentId: number;
}

export interface Store {
  login: string;
  nextRepoId: number;
  repos: Map<string, Repository>;
  requestCounter: number;
}

export function createStore(login: string): Store {
  return { login, nextRepoId: 1, repos: new Map(), requestCounter: 0 };
}

const EPOCH = 1_735_689_600_000;

function timestamp(index: number): string {
  return new Date(EPOCH + index * 1000).toISOString().replace('Z', 'Z');
}

/** Repositories are keyed by name alone; the owner is the viewer's login, bound per token. */
export function repoKey(_owner: string, name: string): string {
  return name;
}

export function findRepo(store: Store, owner: string, name: string): Repository | null {
  const repo = store.repos.get(name) ?? null;
  if (!repo || owner !== store.login) return null;
  repo.owner = store.login;
  return repo;
}

export function createRepo(store: Store, name: string, options: { private?: boolean; description?: string } = {}): Repository {
  const key = name;
  const existing = store.repos.get(key);
  if (existing) {
    existing.owner = store.login;
    return existing;
  }
  const id = store.nextRepoId++;
  const repo: Repository = {
    id,
    owner: store.login,
    name,
    description: options.description ?? '',
    isPrivate: options.private ?? true,
    defaultBranch: 'main',
    createdAt: timestamp(id),
    updatedAt: timestamp(id),
    objects: new Map(),
    refs: new Map(),
    nextIssueNumber: 1,
    nextPullNumber: 1,
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    nextCommentId: 1,
  };
  store.repos.set(key, repo);
  return repo;
}

export function putObject(repo: Repository, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repository, oid: string): GitObject | null {
  return repo.objects.get(oid) ?? null;
}

/** Whether `ancestor` is an ancestor of (or equal to) `oid` over the commit graph. */
export function isAncestor(repo: Repository, ancestor: string, oid: string): boolean {
  if (ancestor === oid) return true;
  const seen = new Set<string>();
  const queue = [oid];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (current === ancestor) return true;
    const object = repo.objects.get(current);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/** Every object reachable from `tips` (commits, trees, blobs, tags). */
export function collectReachable(repo: Repository, tips: Iterable<string>): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const seen = new Set<string>();
  const queue: string[] = [...tips];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object) continue;
    out.set(oid, object);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      const text = object.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})/m.exec(text);
      if (match) queue.push(match[1]);
    }
  }
  return out;
}

/** Peel an annotated tag (or chain) down to a commit; answers the input otherwise. */
export function peel(repo: Repository, oid: string): string {
  let current = oid;
  for (let hops = 0; hops < 8; hops += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tag') return current;
    const match = /^object ([0-9a-f]{40})/m.exec(object.data.toString('utf8'));
    if (!match) return current;
    current = match[1];
  }
  return current;
}

export interface CommitWalkEntry {
  oid: string;
  commit: ReturnType<typeof parseCommit>;
  depth: number;
}

/** Walk commits from `tip` newest-first, at most `maxDepth` generations (Infinity for all history). */
export function walkCommits(repo: Repository, tip: string, maxDepth = Number.POSITIVE_INFINITY): CommitWalkEntry[] {
  const out: CommitWalkEntry[] = [];
  const seen = new Set<string>();
  let frontier: string[] = [tip];
  let depth = 0;
  while (frontier.length > 0 && depth < maxDepth) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      out.push({ oid, commit, depth });
      next.push(...commit.parents);
    }
    frontier = next;
    depth += 1;
  }
  return out;
}

// ---------------------------------------------------------------- contents / commits via REST

/** Read the tree entries at a path prefix; answers the containing tree's entries and the rest of the path. */
function treeAt(repo: Repository, treeOid: string, segments: readonly string[]): { entries: TreeEntry[]; oid: string } | null {
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entries = parseTree(object.data);
    const entry = entries.find((candidate) => candidate.name === segments[index]);
    if (!entry) return null;
    if (index === segments.length - 1) return { entries, oid: entry.oid };
    current = entry.oid;
  }
  return { entries: parseTree(repo.objects.get(current)?.data ?? Buffer.alloc(0)), oid: current };
}

/** Build a tree with `path` replaced by `blobOid` (a nested create/update), rooted at `baseTreeOid`. */
function buildTreeForPath(repo: Repository, baseTreeOid: string | null, segments: readonly string[], blobOid: string): string {
  if (segments.length === 0) return baseTreeOid ?? '';
  const entries: TreeEntry[] = [];
  if (baseTreeOid) {
    const object = repo.objects.get(baseTreeOid);
    if (object && object.type === 'tree') entries.push(...parseTree(object.data));
  }
  const head = segments[0];
  if (segments.length === 1) {
    const kept = entries.filter((entry) => entry.name !== head);
    kept.push({ mode: '100644', name: head, oid: blobOid });
    return putObject(repo, 'tree', buildTree(kept));
  }
  const existing = entries.find((entry) => entry.name === head && (entry.mode === '40000' || entry.mode === '040000'));
  const childOid = buildTreeForPath(repo, existing?.oid ?? null, segments.slice(1), blobOid);
  const kept = entries.filter((entry) => entry.name !== head);
  kept.push({ mode: '40000', name: head, oid: childOid });
  return putObject(repo, 'tree', buildTree(kept));
}

/** Commit a change to one path on a branch; answers the new commit sha (or null when the ref is broken). */
export function commitPath(
  repo: Repository,
  options: { branch: string; path: string; content: Buffer | null; message: string },
): { commitSha: string; contentSha: string } | null {
  const ref = `refs/heads/${options.branch}`;
  const parentOid = repo.refs.get(ref) ?? null;
  let baseTreeOid: string | null = null;
  if (parentOid) {
    const parent = repo.objects.get(parentOid);
    if (!parent || parent.type !== 'commit') return null;
    baseTreeOid = parseCommit(parent.data).tree;
  }
  let blobOid: string | null = null;
  if (options.content !== null) blobOid = putObject(repo, 'blob', options.content);
  const segments = options.path.split('/').filter((segment) => segment !== '');
  let treeOid = baseTreeOid;
  if (options.content === null) {
    // A deletion: rebuild the tree without the path.
    treeOid = buildTreeForDeletion(repo, baseTreeOid, segments);
  } else {
    treeOid = buildTreeForPath(repo, baseTreeOid, segments, blobOid!);
  }
  if (!treeOid) return null;
  const commitOid = putObject(repo, 'commit', buildCommit({
    tree: treeOid,
    parents: parentOid ? [parentOid] : [],
    message: `${options.message}\n`,
    author: `${repo.owner} <${repo.owner}@make.fun>`,
    committer: `${repo.owner} <${repo.owner}@make.fun>`,
    timestamp: 1_735_689_600 + repo.nextIssueNumber + repo.nextPullNumber + repo.objects.size % 100000,
  }));
  repo.refs.set(ref, commitOid);
  return { commitSha: commitOid, contentSha: blobOid ?? '' };
}

function buildTreeForDeletion(repo: Repository, baseTreeOid: string | null, segments: readonly string[]): string | null {
  if (!baseTreeOid) return null;
  if (segments.length === 0) return baseTreeOid;
  const object = repo.objects.get(baseTreeOid);
  if (!object || object.type !== 'tree') return null;
  const entries = parseTree(object.data);
  const head = segments[0];
  if (segments.length === 1) {
    return putObject(repo, 'tree', buildTree(entries.filter((entry) => entry.name !== head)));
  }
  const existing = entries.find((entry) => entry.name === head && (entry.mode === '40000' || entry.mode === '040000'));
  if (!existing) return baseTreeOid;
  const child = buildTreeForDeletion(repo, existing.oid, segments.slice(1));
  const kept = entries.filter((entry) => entry.name !== head);
  if (child) kept.push({ mode: '40000', name: head, oid: child });
  return putObject(repo, 'tree', buildTree(kept));
}

/** The blob oid a tree holds at `path`, or null. */
export function blobAtPath(repo: Repository, treeOid: string, path: string): string | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  const found = treeAt(repo, treeOid, segments);
  if (!found) return null;
  const object = repo.objects.get(found.oid);
  return object && object.type === 'blob' ? found.oid : null;
}

/** The directory listing entries at `path` (a dir), or null when it is not a directory. */
export function dirAtPath(repo: Repository, treeOid: string, path: string): Array<{ name: string; path: string; sha: string; type: 'file' | 'dir'; size: number }> | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  let current = treeOid;
  for (const segment of segments) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
    if (!entry) return null;
    current = entry.oid;
  }
  const object = repo.objects.get(current);
  if (!object || object.type !== 'tree') return null;
  return parseTree(object.data).map((entry) => ({
    name: entry.name,
    path: [...segments, entry.name].join('/'),
    sha: entry.oid,
    type: entry.mode === '40000' || entry.mode === '040000' ? 'dir' : 'file',
    size: entry.mode === '40000' || entry.mode === '040000' ? 0 : repo.objects.get(entry.oid)?.data.length ?? 0,
  }));
}

// ---------------------------------------------------------------- diffs

export interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function listPaths(repo: Repository, treeOid: string, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000' || entry.mode === '040000') {
      for (const [nested, oid] of listPaths(repo, entry.oid, path)) out.set(nested, oid);
    } else {
      out.set(path, entry.oid);
    }
  }
  return out;
}

export function mergeBase(repo: Repository, a: string, b: string): string | null {
  const ancestors = new Set<string>();
  const queue = [a];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (ancestors.has(current)) continue;
    ancestors.add(current);
    const object = repo.objects.get(current);
    if (object?.type === 'commit') queue.push(...parseCommit(object.data).parents);
  }
  const other: string[] = [b];
  const seen = new Set<string>();
  while (other.length > 0) {
    const current = other.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (ancestors.has(current)) return current;
    const object = repo.objects.get(current);
    if (object?.type === 'commit') other.push(...parseCommit(object.data).parents);
  }
  return null;
}

/** Diff two trees into GitHub's pull-request file list. */
export function diffTrees(repo: Repository, baseTree: string, headTree: string): FileDiff[] {
  const base = listPaths(repo, baseTree);
  const head = listPaths(repo, headTree);
  const diffs: FileDiff[] = [];
  for (const [path, headOid] of head) {
    const baseOid = base.get(path);
    if (baseOid === headOid) continue;
    const headData = repo.objects.get(headOid)?.data ?? Buffer.alloc(0);
    if (baseOid === undefined) {
      const lines = headData.toString('utf8').split('\n').length;
      diffs.push({ filename: path, status: 'added', additions: Math.max(1, lines), deletions: 0, changes: Math.max(1, lines) });
    } else {
      const baseData = repo.objects.get(baseOid)?.data ?? Buffer.alloc(0);
      const additions = Math.max(1, headData.toString('utf8').split('\n').length);
      const deletions = baseData.toString('utf8').split('\n').length;
      diffs.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  for (const path of base.keys()) {
    if (!head.has(path)) {
      diffs.push({ filename: path, status: 'removed', additions: 0, deletions: 1, changes: 1 });
    }
  }
  return diffs.sort((a, b) => (a.filename < b.filename ? -1 : 1));
}

// ---------------------------------------------------------------- receive-pack

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushOutcome {
  unpackOk: boolean;
  reports: Array<{ ref: string; ok: boolean; reason: string }>;
}

/** Apply a receive-pack request: unpack, then update refs with fast-forward checks. */
export function applyReceivePack(repo: Repository, commands: readonly PushCommand[], pack: Buffer | null): PushOutcome {
  let unpackOk = true;
  const unpackDetail: string[] = [];
  if (pack !== null && pack.length > 0) {
    try {
      const parsed = readPack(pack);
      for (const [oid, object] of parsed.objects) {
        if (hashObject(object.type, object.data) !== oid) {
          unpackOk = false;
          unpackDetail.push(`object ${oid} does not hash to its id`);
        } else {
          repo.objects.set(oid, { type: object.type, data: object.data });
        }
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail.push(err instanceof Error ? err.message : String(err));
    }
  }
  const reports: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      if (command.newOid === ZERO_OID) {
        if (!repo.refs.has(command.ref)) reports.push({ ref: command.ref, ok: false, reason: 'no such ref' });
        else if (command.oldOid !== current) reports.push({ ref: command.ref, ok: false, reason: 'stale info' });
        else {
          repo.refs.delete(command.ref);
          reports.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        reports.push({ ref: command.ref, ok: false, reason: 'missing objects' });
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        if (repo.refs.has(command.ref)) reports.push({ ref: command.ref, ok: false, reason: 'ref already exists' });
        else {
          repo.refs.set(command.ref, command.newOid);
          reports.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (command.oldOid !== current) {
        reports.push({ ref: command.ref, ok: false, reason: 'stale info' });
        continue;
      }
      if (!isAncestor(repo, command.oldOid, command.newOid)) {
        reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      reports.push({ ref: command.ref, ok: true, reason: '' });
    }
  }
  return { unpackOk, unpackDetail: unpackDetail.join('; '), reports };
}

/** Apply a delta onto its base (re-exported for tests). */
export { applyDelta, sha1Hex };
