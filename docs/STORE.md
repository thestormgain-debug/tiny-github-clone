# Storage Architecture and Data Model (`docs/STORE.md`)

This document provides a comprehensive, code-backed specification of how `ghforge` stores, manages, and mutates its data graph in memory. Every claim in this document is derived directly from `store.ts`, `app.ts`, and `gitcore.ts`.

---

## 1. Overview and In-Memory Graph Architecture

`ghforge` operates as a single-process, in-memory git forge where a single `Store` object holds all global state, repositories, and request counters. All four interaction surfaces—Git Smart-HTTP, REST v3, GraphQL, and MCP—read and write this shared in-memory object graph.

- **Process Model**: One process, one store instance created via `createStore(login)`.
- **Concurrency Model**: Node.js single-threaded event loop handles concurrent asynchronous requests mutating the shared maps.
- **Root Store Structure**:
  ```ts
  export interface Store {
    login: string;
    nextRepoId: number;
    repos: Map<string, Repository>;
    requestCounter: number;
  }
  ```
- **Creation Function**:
  ```ts
  export function createStore(login: string): Store {
    return { login, nextRepoId: 1, repos: new Map(), requestCounter: 0 };
  }
  ```

---

## 2. Repository, Issue, Pull-Request, and Label Records & ID Allocation

### 2.1 Repository Records & Keying
Repositories are stored in `store.repos` as a `Map<string, Repository>`. 
- **Keying**: Defined by `repoKey(_owner: string, name: string): string`, which returns `name` alone. The owner is bound to the viewer's login per token.
- **Lookup (`findRepo`)**:
  ```ts
  export function findRepo(store: Store, owner: string, name: string): Repository | null {
    const repo = store.repos.get(name) ?? null;
    if (!repo || owner !== store.login) return null;
    repo.owner = store.login;
    return repo;
  }
  ```
- **Creation (`createRepo`)**:
  - Checks if a repository with `name` already exists in `store.repos`. If found, updates `existing.owner = store.login` and returns it.
  - If not found, allocates `id = store.nextRepoId++` (starting at `1`).
  - Initializes a `Repository` record:
    ```ts
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
    ```
  - Epoch timestamp calculation: `EPOCH = 1_735_689_600_000`, `timestamp(id)` returns `new Date(EPOCH + index * 1000).toISOString()`.

### 2.2 Issue Records & ID Allocation
Issues are stored in `repo.issues` (`Map<number, Issue>`).
- **ID Allocation**: `id` and `number` are allocated from `repo.nextIssueNumber++` (starting at `1`).
- **Issue Interface**:
  ```ts
  export interface IssueComment {
    id: number;
    body: string;
    createdAt: string;
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
  ```
- **Comments**: Stored in `issue.comments` array, with IDs allocated from `repo.nextCommentId++` (starting at `1`).

### 2.3 Pull Request Records & ID Allocation
Pull requests are stored in `repo.pulls` (`Map<number, PullRequest>`).
- **ID Allocation**: `id` and `number` are allocated from `repo.nextPullNumber++` (starting at `1`).
- **PullRequest Interface**:
  ```ts
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
  ```

### 2.4 Label Records
Labels are stored in `repo.labels` (`Map<string, Label>`, keyed by label name).
- **Label Interface**:
  ```ts
  export interface Label {
    name: string;
    color: string;
  }
  ```

---

## 3. How Commits, Trees, and Blobs are Keyed

Git objects are stored in `repo.objects` (`Map<string, GitObject>`, where keys are 40-character hex SHA-1 strings).

- **GitObject Interface**:
  ```ts
  export interface GitObject {
    type: ObjType; // 'blob' | 'tree' | 'commit' | 'tag'
    data: Buffer;
  }
  ```
- **Object Keying (`hashObject`)**:
  Objects are keyed by their cryptographic SHA-1 object ID (`oid`), computed over the standard Git object header and payload:
  ```ts
  export function sha1Hex(data: Buffer | string): string {
    return createHash('sha1').update(data).digest('hex');
  }
  export function hashObject(type: ObjType, data: Buffer): string {
    return sha1Hex(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]));
  }
  ```
- **Blobs**: Store raw binary file content `Buffer`.
- **Trees**: Serialized/parsed via `parseTree` and `buildTree`. Tree entries consist of `mode` (e.g. `'100644'`, `'40000'`), `name` (file/directory name), and `oid` (20-byte binary hash rendered as 40-char hex string). Entries are sorted using `treeSort` (appending `/` for directory modes).
- **Commits**: Serialized/parsed via `parseCommit` and `buildCommit`. Headers include `tree`, `parent` (zero or more), `author`, `committer`, followed by a blank line and the commit message text.

---

## 4. Refs and Default Branch Mechanics

- **Refs Map**: `repo.refs` (`Map<string, string>`) maps fully qualified ref names (e.g., `refs/heads/main`, `refs/heads/feature`) to 40-character commit OIDs.
- **Default Branch**: Stored in `repo.defaultBranch` (default value `'main'`).
- **Ref Resolution**: `refTip(repo, branch)` checks `repo.refs.get(refs/heads/${branch})`.
- **Ancestry Checks (`isAncestor`)**:
  Used for fast-forward verification during pushes and merge calculations. Walks parent commit hashes backward from `oid` to determine if `ancestor` is an ancestor of (or equal to) `oid`.
  ```ts
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
  ```

---

## 5. Object Packs from a Push: Parsing and Storage

When clients push via `git-receive-pack`, object packs are processed by `applyReceivePack` and `readPack` (`gitcore.ts`):

1. **Pack Magic Validation**: Checks that the pack buffer begins with `'PACK'` magic bytes and version `2`.
2. **Entry Parsing & Decompression**:
   - Reads declared object count.
   - Iterates through pack entries, reading type and varint size.
   - Handles loose objects, `ofs_delta`, and `ref_delta`.
   - Uses `inflateWithSize` (binary searching zlib stream prefix length) to handle Node.js zlib trailing byte tolerance.
3. **Delta Resolution**:
   - Recursively resolves offset and reference deltas using `applyDelta`.
4. **Hashing & Verification**:
   - Computes `hashObject` for each decoded object and verifies it matches the resolved OID.
   - Stores successfully unpacked objects into `repo.objects`.
5. **Ref Update & Fast-Forward Validation**:
   - Validates push commands against current ref tips (`ZERO_OID` for creation/deletion).
   - Checks for stale info (`command.oldOid !== current`).
   - Verifies fast-forward constraints using `isAncestor(repo, command.oldOid, command.newOid)`.
   - Reports `ok` or `ng` status for each ref in the receive-pack protocol response.

---

## 6. Request-ID Generation

- Managed in `app.ts` via module-level `requestCounter` (or store request counter).
- Incremented on every incoming HTTP request:
  ```ts
  requestCounter += 1;
  const requestId = req-${String(requestCounter).padStart(8, '0')};
  ```
- Returned in HTTP response headers as `X-GitHub-Request-Id: req-00000001`.

---

## 7. Authentication and the 404-vs-403 Owner Rule

- **Bearer Token Extraction**: Extracted from the `Authorization: Bearer <token>` header (`bearerToken`).
- **Token Validation**: If `MAKEFUN_SHOP_TOKEN` environment variable is non-empty, presented tokens must match it exactly.
- **Owner Binding Rule**:
  - The first owner-scoped path an authenticated request mentions binds `store.login`.
- **404-vs-403 Owner Rule**:
  - If a request specifies an owner that does not match `store.login`, or attempts to access a repository not owned by the viewer, `findRepo` returns `null`.
  - Rather than disclosing repository existence or unauthorized access via a `403 Forbidden` response, `ghforge` responds with `404 Not Found`, implementing GitHub-compatible security-by-obscurity for repository access.

---

## 8. Trial Boot Lifecycle (`MAKEFUN_ENV_URL` Register/Done Lifecycle)

The lifecycle of process startup and trial execution is controlled by `main.ts`:

1. **Environment Check**:
   - Reads `MAKEFUN_ENV_URL`. If unset, logs an error to `stderr` and exits `1`.
2. **Ephemeral Port Binding**:
   - Creates the HTTP server via `createApp()` and calls `server.listen(0)` so the OS assigns a free ephemeral port.
3. **Registration (`/register`)**:
   - POSTs `{"port": N}` to `$MAKEFUN_ENV_URL/register` with a 30-second timeout.
   - Uses exponential backoff retry (`RETRY_INITIAL_MS = 250`, `RETRY_MAX_MS = 2000`).
   - Accepts status `200 OK` or `409 Conflict` (another process already won registration). Contract errors (`400`, `405`) terminate the process immediately.
4. **Polling Done (`/done`)**:
   - Periodically polls `GET $MAKEFUN_ENV_URL/done` with exponential backoff.
   - The test harness responds with `{"done": false}` while running, and `{"done": true}` when the trial concludes.
5. **Shutdown**:
   - Upon receiving `{"done": true}`, closes the HTTP server (`server.close()`) and exits with code `0`.

---

## 9. Additional Plumbing and Helper Functions

To ensure complete coverage of data persistence and manipulation, `ghforge` relies on several key helper subsystems:

- **`collectReachable`**: Walks the commit, tree, tag, and blob graph starting from a set of tip OIDs to build a complete closure map of reachable objects for git push/fetch transport operations.
- **`peel`**: Follows annotated tag pointer chains (up to 8 hops) down to the underlying commit object.
- **`walkCommits`**: Traverses commit graphs newest-first up to a maximum depth (default `Infinity`), yielding commit views with parents and metadata.
- **`commitPath` / `buildTreeForPath` / `buildTreeForDeletion`**: Enables direct file mutations (create, update, delete) via the REST contents API by dynamically reconstructing parent tree structures and committing new blobs and trees.
- **`mergeBase`**: Computes the common ancestor between two commit hashes by tracking commit graph ancestry sets.
- **`diffTrees`**: Compares two tree OIDs recursively to produce GitHub-compatible pull request file diff summaries (`added`, `modified`, `removed`, additions, deletions, changes).

---

## 10. Summary of In-Memory Data Boundaries

In summary, `ghforge` maintains strict encapsulation within its in-memory Maps:
- `store.repos` isolates repositories by name.
- `repo.objects` acts as the git object database (ODB) for loose and packed objects.
- `repo.refs` stores branch and tag pointers.
- `repo.issues` and `repo.pulls` manage project tracking state.
- All operations remain thread-safe via single-threaded asynchronous execution in Node.js, guaranteeing reliable conformance across all four protocol surfaces.

---

## 11. Appendix: Detailed Type Definitions and Memory Layouts

For reference, the complete TypeScript type definitions governing data structures in `ghforge` are structured as follows:

```ts
export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

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
```
This data model ensures full compliance with GitHub REST v3, GraphQL v4, Git Smart-HTTP, and MCP specifications without relying on external databases or disk storage.
