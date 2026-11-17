# Operations Manual & Forge Architecture (`docs/OPERATIONS.md`)

This operations manual provides a comprehensive, code-backed guide to running, operating, troubleshooting, and understanding the performance characteristics of **ghforge** (`github-core-clone-01`), a high-performance, standalone, GitHub-compatible Git forge implemented entirely in a single Node.js v22+ process without external dependencies or binary execution.

---

## 1. Running the Forge Locally

### 1.1 Prerequisites
- **Node.js**: Version 22.0.0 or higher (required for native experimental TypeScript evaluation via `--experimental-strip-types`).
- **Environment**: Linux, macOS, or Windows with Node.js available in the system PATH.

### 1.2 Execution Command
To start the forge locally:
```sh
node --experimental-strip-types main.ts
```
When executed directly, `main.ts` initializes the application server (`createApp()` from `app.ts`), binds an ephemeral port via `server.listen(0)`, and enters the trial lifecycle harness loop.

### 1.3 The `MAKEFUN_ENV_URL` Register & Done Lifecycle
The lifecycle of `ghforge` during test runs and trial execution is strictly governed by `main.ts` adhering to the test harness contract:

1. **Environment Variable Validation (`MAKEFUN_ENV_URL`)**:
   - Upon startup, `main.ts` checks the `MAKEFUN_ENV_URL` environment variable.
   - If `MAKEFUN_ENV_URL` is unset or empty, the program logs an error message to `stderr` and exits immediately with status `1`.
2. **Ephemeral Port Binding (`server.listen(0)`)**:
   - The application binds an HTTP server using `server.listen(0)`, allowing the operating system kernel to assign a free ephemeral TCP port.
   - Port `8080` is never bound directly because it is reserved and owned by the outer environment container.
3. **Environment Registration (`POST /register`)**:
   - The program sends a `POST` request to `${MAKEFUN_ENV_URL}/register` with JSON body `{"port": N}` (where `N` is the ephemeral port assigned by the OS).
   - The test environment records the source IP address and the ephemeral port to establish the base URL for scoring and dial-back.
   - Robust retry logic with exponential backoff (`RETRY_INITIAL_MS = 250`, `RETRY_MAX_MS = 2000`, request timeout `30,000ms`) handles transient network issues during startup.
   - HTTP status `200 OK` or `409 Conflict` (indicating another process registration already won) are treated as successful registration completions.
   - Contract errors (`400 Bad Request` or `405 Method Not Allowed`) terminate the process immediately.
4. **Polling for Completion (`GET /done`)**:
   - The process long-polls `${MAKEFUN_ENV_URL}/done` using exponential backoff retry loops.
   - While test suites are actively executing, the endpoint responds with `{"done": false}`.
   - When all test suites conclude, the endpoint returns `{"done": true}`.
5. **Graceful Shutdown (`exit 0`)**:
   - Upon receiving `{"done": true}`, the server closes (`server.close()`) and the process exits with status code `0`.

### 1.4 Authentication (`MAKEFUN_SHOP_TOKEN`)
- **Bearer Token Enforcement**: If the `MAKEFUN_SHOP_TOKEN` environment variable is set on the server, incoming requests across REST v3 (`/api/v3`), GraphQL (`/api/graphql`), MCP (`/mcp`), and Git Smart-HTTP must supply a matching Bearer token in the `Authorization` header:
  ```http
  Authorization: Bearer <token>
  ```
- **Unauthorized Rejection**: If the token is missing or does not match `MAKEFUN_SHOP_TOKEN`, the server responds with HTTP `401 Unauthorized`.
- **Owner Binding**: The first authenticated owner-scoped path accessed during a session dynamically binds the viewer's `store.login`.

---

## 2. Walkthrough of One Full Workflow

This section walks through a complete end-to-end developer and AI agent workflow executing across all four protocols of `ghforge`:
1. Creating a repository over REST v3 (`POST /api/v3/user/repos`).
2. Pushing commits over Git Smart HTTP (`git push`).
3. Creating an issue over REST v3 or MCP (`POST /api/v3/repos/{owner}/{repo}/issues`).
4. Opening a pull request over GraphQL (`/api/graphql`).
5. Merging the pull request over GraphQL / REST (`PUT /api/v3/repos/{owner}/{repo}/pulls/{number}/merge`).
6. Reading the merged state back over REST v3 and MCP (`/mcp`).

### Step 2.1: Create a Repository via REST v3 (`POST /api/v3/user/repos`)
Send an HTTP POST request to create a new repository:
```http
POST /api/v3/user/repos HTTP/1.1
Authorization: Bearer tok123
Content-Type: application/json

{
  "name": "demo-repo",
  "private": true,
  "description": "Full workflow demonstration repository"
}
```
**Response (`201 Created`)**:
```json
{
  "id": 1,
  "node_id": "R_1",
  "name": "demo-repo",
  "full_name": "user/demo-repo",
  "owner": { "login": "user", "id": 1, "type": "User" },
  "private": true,
  "description": "Full workflow demonstration repository",
  "default_branch": "main",
  "clone_url": "https://git.make.fun/user/demo-repo.git",
  "permissions": { "admin": true, "push": true, "pull": true }
}
```

### Step 2.2: Push Commits over Smart HTTP (`git push`)
Initialize a local git repository, add a file, and push to the forge:
```sh
git init demo-repo
cd demo-repo
git checkout -b main
echo "# Demo Project" > README.md
git add README.md
git commit -m "Initial commit"
git remote add origin https://git.make.fun/user/demo-repo.git
git push -u origin main
```
**Behind the Scenes (`githttp.ts` & `gitcore.ts`)**:
1. Client fetches `info/refs?service=git-receive-pack` to discover refs and capabilities (`report-status`, `side-band-64k`, `ofs-delta`).
2. Client POSTs to `git-receive-pack` with command `0000000000000000000000000000000000000000 <commit-oid> refs/heads/main` followed by a packfile containing the commit, tree, and blob objects.
3. `ghforge` unpacks the packfile via `readPack()`, verifies SHA-1 checksums using `hashObject()`, updates `repo.refs.set('refs/heads/main', oid)`, and returns `unpack ok\nok refs/heads/main\n` encapsulated via sideband channel 1.

### Step 2.3: Create an Issue (via REST v3 or MCP)
Create an issue reporting a feature addition or bug fix:
```http
POST /api/v3/repos/user/demo-repo/issues HTTP/1.1
Authorization: Bearer tok123
Content-Type: application/json

{
  "title": "Implement feature X",
  "body": "Please add feature X to the main branch."
}
```
**Response (`201 Created`)**:
```json
{
  "id": 1,
  "number": 1,
  "title": "Implement feature X",
  "body": "Please add feature X to the main branch.",
  "state": "open",
  "user": { "login": "user" },
  "created_at": "2026-01-01T00:00:00.000Z"
}
```

### Step 2.4: Open a Pull Request over GraphQL (`/api/graphql`)
Create a feature branch locally, push it, and open a pull request via GraphQL:
```sh
git checkout -b feature-x
echo "feature code" > feature.txt
git add feature.txt
git commit -m "Add feature X code"
git push origin feature-x
```
Now execute a GraphQL mutation to open the pull request:
```http
POST /api/graphql HTTP/1.1
Authorization: Bearer tok123
Content-Type: application/json

{
  "query": "mutation ($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { number title state headRefName baseRefName } } }",
  "variables": {
    "input": {
      "repositoryId": "R_1",
      "title": "Add feature X",
      "body": "Implements feature X.",
      "head": "feature-x",
      "base": "main"
    }
  }
}
```
**Response (`200 OK`)**:
```json
{
  "data": {
    "createPullRequest": {
      "pullRequest": {
        "number": 1,
        "title": "Add feature X",
        "state": "OPEN",
        "headRefName": "feature-x",
        "baseRefName": "main"
      }
    }
  }
}
```

### Step 2.5: Merge the Pull Request
Merge the pull request via REST v3 (or GraphQL mutation):
```http
PUT /api/v3/repos/user/demo-repo/pulls/1/merge HTTP/1.1
Authorization: Bearer tok123
Content-Type: application/json

{
  "commit_title": "Merge pull request #1 from user/feature-x"
}
```
**Response (`200 OK`)**:
```json
{
  "sha": "a1b2c3d4e5f6...",
  "merged": true,
  "message": "Pull Request successfully merged"
}
```

### Step 2.6: Read Back over REST and MCP
- **REST Check**: `GET /api/v3/repos/user/demo-repo/pulls/1` returns `merged: true` with `state: "closed"`.
- **MCP Check**: Calling `tools/call` with tool name `list_issues` or `get_repo` via `/mcp` returns the repository state and closed pull request / issue data wrapped in structured content.

---

## 3. Troubleshooting Table

| Error Condition / Status Code | Root Cause / Context | Resolution / Debugging Steps |
| :--- | :--- | :--- |
| **`401 Unauthorized`** | Missing or invalid `Authorization: Bearer <token>` header when `MAKEFUN_SHOP_TOKEN` is configured on the server. | Ensure the HTTP client sends `Authorization: Bearer <token>` matching the server's `MAKEFUN_SHOP_TOKEN` environment variable. |
| **`404 Not Found` (Owner Rule)** | Request specifies an owner login that does not match `store.login`, or queries a non-existent repository. | Verify repository owner spelling and ensure authentication token binds the correct user login. Per security requirements, unauthorized repos return 404 rather than 403. |
| **`409 Conflict` (Stale Contents SHA)** | A file update (`PUT /contents/{path}`) or deletion was submitted with a missing, outdated, or incorrect file `sha`. | Fetch the latest file content via `GET /contents/{path}` to retrieve the current `sha`, then include it in the `PUT`/`DELETE` request body. |
| **`405 Method Not Allowed` (Conflicted Merge)** | Attempting to merge a pull request (`PUT /pulls/{number}/merge`) that has already been merged or has underlying tree conflicts. | Check PR merge status via `GET /pulls/{number}/merge`. Rebase the feature branch against the base branch if conflicts exist. |
| **`ng <ref> non-fast-forward`** | A git push (`git-receive-pack`) attempted to overwrite a remote branch with history that is not a descendant of the remote tip. | Pull/rebase remote changes locally before pushing, or force-push if permitted (note: ghforge enforces strict fast-forward push validation). |

---

## 4. Performance Notes for Timed Workloads

`ghforge` is engineered for extreme performance, executing all core git and API workloads in-memory without spawning external `git` child processes, accessing disk I/O, or querying external databases. Below are the performance characteristics and optimizations for the four timed workloads:

### 4.1 Push Workload (`git push` / `receive-pack`)
- **What the Code Does**: Parses smart HTTP pkt-lines (`githttp.ts`), reads and unpacks incoming packfiles in memory (`gitcore.ts:readPack`), validates SHA-1 object hashes (`hashObject`), and updates reference pointers in `store.repos`.
- **Speed Optimizations**:
  - Pure JavaScript packfile decoding and zlib inflation (`inflateWithSize`) bypasses spawning `git-receive-pack` binary processes.
  - O(1) in-memory Map lookups (`repo.objects.set()`) store parsed Git objects instantly.
  - Fast-forward ancestry checks traverse commit parent pointers directly in memory (`isAncestor`).

### 4.2 Clone Workload (`git clone` / `upload-pack`)
- **What the Code Does**: Handles protocol v2 (`ls-refs`, `fetch`) and protocol v0 requests, computes object reachability closures (`selectFetchObjects`), packages objects into a packfile (`writePack`), and streams responses over sideband channel 1.
- **Speed Optimizations**:
  - `selectFetchObjects` computes exact reachability closures using cached graph walks (`walkCommits`), avoiding redundant traversal.
  - Zlib deflation is performed at level 1 (`zlib.deflateSync(data, { level: 1 })`), striking an optimal balance between compression speed and CPU overhead.
  - Direct buffer streaming avoids temporary file creation on disk.

### 4.3 Read Workload (REST v3, GraphQL, MCP Reads)
- **What the Code Does**: Queries repositories, issues, pull requests, commits, and file contents across REST (`rest.ts`), GraphQL (`graphql.ts`), and MCP (`mcp.ts`) endpoints.
- **Speed Optimizations**:
  - In-memory `Map` and array data structures provide O(1) and O(N) lookup times for repositories, issues, and labels.
  - Custom recursive descent parsers and memoized schema execution eliminate runtime reflection overhead.

### 4.4 Write Workload (API Mutations, Contents PUT, Issue/PR Creation)
- **What the Code Does**: Creates repositories, commits file changes (`commitPath`), opens issues, creates pull requests, and executes GraphQL mutations.
- **Speed Optimizations**:
  - In-memory tree rebuilding (`buildTreeForPath`) and commit construction (`buildCommit`) update repository state instantly without disk write latency.
  - Sequential ID generation (`repo.nextIssueNumber++`) avoids database locks and race conditions.

---

## 5. Additional System and Architectural Considerations

To ensure complete operational transparency, `ghforge` maintains architectural simplicity across its components:
- **Zero External Dependencies**: Operates strictly on Node.js built-ins (`node:http`, `node:zlib`, `node:crypto`, `node:buffer`).
- **Request Tracing**: Every HTTP response carries an `X-GitHub-Request-Id` header tracking execution flow.
- **Robust Error Serialization**: Unhandled exceptions in REST, GraphQL, or MCP channels return standardized JSON error payloads with correct HTTP status codes.
- **Concurrency Safety**: Node.js single-threaded event loop execution model inherently prevents race conditions on shared in-memory Maps.
