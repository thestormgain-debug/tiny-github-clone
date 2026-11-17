[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/thestormgain-debug/tiny-github-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/thestormgain-debug/tiny-github-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01/reward?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# ghforge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ghforge/ghforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ghforge/ghforge/reward.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

`ghforge` is a high-performance, standalone, GitHub-compatible Git forge implemented entirely in a single Node 22 process without external dependencies, external package installations, or underlying Git binary execution. It serves four distinct developer and AI agent surfaces from a unified, shared in-memory store:

1. **Git Smart HTTP**: Full support for upload-pack (protocol v2 and protocol v0) and receive-pack (protocol v0 with report-status, side-band-64k, delete-refs, shallow fetch depth 1, and fast-forward-only push validation).
2. **REST v3 API**: GitHub-compatible REST v3 endpoints under `/api/v3` covering repositories, file contents, branches, git references, commits, labels, issues, issue comments, and pull requests with squash merging.
3. **GraphQL v4 API**: GitHub-compatible GraphQL endpoint at `/api/graphql` supporting custom parsing, execution, variables, aliases, inline fragments, batched documents, and full schema introspection.
4. **Model Context Protocol (MCP)**: JSON-RPC 2.0 Streamable HTTP endpoint at `/mcp` supporting `server/discover`, `initialize`, `tools/list`, and `tools/call` across six core developer tools.

---

## Run It

To start the forge locally:

```sh
node main.ts
```

### Environment Variables
- `MAKEFUN_ENV_URL`: Names the environment origin (e.g., `http://store:8080` in container trials). If omitted, the program exits immediately with status `1`.
- `MAKEFUN_SHOP_TOKEN`: Optional bearer token used to authenticate incoming API, GraphQL, MCP, and Git requests.

---

## Trial Lifecycle & Execution

The trial runner interacts with `ghforge` via `main.ts` adhering strictly to the harness contract:
1. **Bind**: The application creates an HTTP server and calls `server.listen(0)`, letting the OS kernel assign an ephemeral port. Port `8080` is never bound directly as it is owned by the environment container.
2. **Register**: The program sends a `POST` request to `$MAKEFUN_ENV_URL/register` with `{"port": N}`. The environment records the base URL and dials it for scoring.
3. **Poll**: The process long-polls `GET $MAKEFUN_ENV_URL/done` until the response returns `{"done": true}`. While tests execute, the endpoint returns `{"done": false}`.
4. **Exit**: Upon receiving `{"done": true}`, the server closes and the process exits with `0`.

---

## Architecture & Codebase Layout

`ghforge` is structured into modular TypeScript files implementing specific layers of the Git forge and its supporting APIs. Below is a detailed breakdown of each architectural component:

### 1. `main.ts`
- **Role**: Entry point and environment lifecycle harness.
- **Responsibilities**:
  - Validates `MAKEFUN_ENV_URL` (exits 1 if unset).
  - Configures retry constants (`REQUEST_TIMEOUT_MS = 30_000`, `RETRY_INITIAL_MS = 250`, `RETRY_MAX_MS = 2_000`).
  - Spawns the HTTP server using `createApp()`.
  - Binds an ephemeral port via `server.listen(0)` and logs the bound port.
  - Registers the ephemeral port with `$MAKEFUN_ENV_URL/register` via robust retry loops (handling status 200/409 success, and contract errors 400/405).
  - Polls `$MAKEFUN_ENV_URL/done` until `{"done": true}` is received.
  - Closes the server and exits with status `0`.
  - Implements exponential backoff retry algorithms for robust network communication with the test harness environment.

### 2. `app.ts`
- **Role**: HTTP routing, request tracing, and authentication layer (`node:http`).
- **Responsibilities**:
  - Increments and assigns unique request IDs (`req-00000001`, `X-GitHub-Request-Id`).
  - Reads full incoming request bodies (`readBody`).
  - Enforces bearer token authorization (`MAKEFUN_SHOP_TOKEN`).
  - Binds store owner login dynamically on the first authenticated owner-scoped path.
  - Routes requests:
    - `/healthz` -> Health status JSON.
    - `/{owner}/{repo}.git/...` -> Git Smart HTTP (`githttp.ts`).
    - `/api/v3` & `/api/v3/meta` -> API root and metadata.
    - `/api/v3/...` -> REST v3 API (`rest.ts`).
    - `/api/graphql` -> GraphQL v4 API (`graphql.ts`).
    - `/mcp` -> MCP Streamable HTTP endpoint (`mcp.ts`).
  - Handles internal server errors safely with JSON responses and tracking headers.

### 3. `store.ts`
- **Role**: In-memory data structures, state management, and domain business logic.
- **Responsibilities**:
  - Manages stores, repositories (`Map<string, Repository>`), git objects (`Map<string, GitObject>`), and references (`Map<string, string>`).
  - Tracks issues, pull requests, labels, and issue comments with sequential ID generation.
  - Graph operations: `isAncestor` (commit DAG traversal), `collectReachable` (object closure collection), `peel` (annotated tag peeling), and `walkCommits` (newest-first commit graph walking).
  - Repository operations: repo creation, lookup (`findRepo`), path tree resolution (`treeAt`, `blobAtPath`, `dirAtPath`), path commits (`commitPath`), and file diffing (`diffTrees`, `mergeBase`).
  - Receive-pack application (`applyReceivePack`) including pack unpacking, object hashing verification, ref deletion, creation, updates, and non-fast-forward push rejection.

### 4. `rest.ts`
- **Role**: GitHub-compatible REST v3 API implementation.
- **Responsibilities**:
  - Serializers for repositories, issues, pull requests, commits, and file contents.
  - Endpoint handlers:
    - User profile (`GET /api/v3/user`).
    - User and repository listing with pagination and `Link` headers (`GET /api/v3/user/repos`, `POST /api/v3/user/repos`).
    - Repository detail retrieval, updates (`PATCH`), deletion (`DELETE`), and shorthand creation (`POST /api/v3/repos/{owner}/{repo}`).
    - Branch listing and retrieval (`/branches`, `/branches/{branch}`).
    - Git reference creation (`/git/refs`).
    - Commit history walking (`/commits`, `/commits/{sha}`).
    - Label management (`/labels`, `/labels/{name}`).
    - Issue management (`/issues`, `/issues/{number}`, state/sort/direction/pagination filtering).
    - Issue comments (`/issues/{number}/comments`).
    - Pull request lifecycle (`/pulls`, `/pulls/{number}`, `/pulls/{number}/files`, `/pulls/{number}/merge`).
    - File content and directory retrieval, creation, updates (`PUT /contents/{path}`), and deletion (`DELETE /contents/{path}`).

### 5. `graphql.ts`
- **Role**: GraphQL v4 API parser, executor, and introspection engine.
- **Responsibilities**:
  - Custom lexer (`tokenize`), decoder, and recursive descent parser (`Parser`) supporting queries, mutations, variables, default values, aliases, and selection sets.
  - Built-in schema definition (`buildSchema`) for Query, Mutation, User, Repository, Issue, Pull Request, Commit, Ref, Actor, Owner, PageInfo, and Enums.
  - Execution engine (`executeDocument`, `executeOperation`, `emitField`, `renderValue`) with variable substitution and error handling (returning HTTP 200 with `errors` array).
  - Resolvers for viewer, repository, node(s), user repositories, issue/PR connections, and mutations (`createIssue`, `closeIssue`, `updateIssue`, `createPullRequest`, `mergePullRequest`, `addComment`).
  - Introspection serialization (`__schema`, `__type`).

### 6. `mcp.ts`
- **Role**: Model Context Protocol (MCP) Streamable HTTP endpoint.
- **Responsibilities**:
  - JSON-RPC 2.0 request parsing and batch handling (`handleMcpPost`).
  - Protocol version negotiation and server discovery (`server/discover`, `initialize`, supported versions `2026-07-28`, `2025-11-25`, `2025-06-18`, `2025-03-26`).
  - Notification handling (`notifications/*`).
  - Deterministic tool listing (`tools/list`).
  - Implementation of six core tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`) in `callTool`.
  - Standard JSON-RPC error responses (`-32700` parse error, `-32601` method not found, `-32602` invalid params).

### 7. `githttp.ts`
- **Role**: Git Smart HTTP protocol handler.
- **Responsibilities**:
  - URL path matching (`/{owner}/{repo}.git/...`).
  - Protocol version 2 handling (`v2Advertisement`, `parseV2Request`, `lsRefsResponse`, `fetchV2Response`).
  - Protocol version 0 advertisement generation (`v0Advertisement` for upload-pack and receive-pack with capabilities).
  - Object selection (`selectFetchObjects`) computing object closures, shallow boundaries, and unshallow transitions.
  - Receive-pack push processing (`handleReceivePack`) parsing pkt-line commands, unpacking packfiles, validating object hashes, enforcing fast-forward rules, and emitting sideband-64k report statuses.

### 8. `gitcore.ts`
- **Role**: Low-level Git object and packfile plumbing.
- **Responsibilities**:
  - Pkt-line framing (`pktLine`, `parsePktLines`, `FLUSH_PKT`, `DELIM_PKT`).
  - Object type constants (`blob`, `tree`, `commit`, `tag`) and SHA-1 hashing (`sha1Hex`, `hashObject`).
  - Tree parsing (`parseTree`) and building (`buildTree` with correct entry sorting).
  - Commit parsing (`parseCommit`) and building (`buildCommit`).
  - Tag parsing (`parseTag`) and building (`buildTag`).
  - Packfile writing (`writePack`) with zlib compression (level 1) and checksum trailers.
  - Packfile reading (`readPack`) supporting `ofs_delta` and `ref_delta` resolution, binary delta application (`applyDelta`), binary-search zlib inflation (`inflateWithSize`), and checksum verification (`verifyPackChecksum`).

---

## Detailed Data Flow & Internal Mechanics

### In-Memory Object Model
`ghforge` stores all repositories and git data in memory. Each repository maintains:
- `id`: Numeric repository identifier.
- `owner`: Viewer login bound upon authentication.
- `name`: Repository name.
- `objects`: A `Map<string, GitObject>` mapping 40-character hex OIDs to their type (`blob`, `tree`, `commit`, `tag`) and raw buffer data.
- `refs`: A `Map<string, string>` mapping reference names (e.g., `refs/heads/main`) to commit OIDs.
- `issues`, `pulls`, `labels`: Maps storing issues, pull requests, and labels with auto-incrementing identifiers.

### Git Smart HTTP Transport Pipeline
1. **Client Request**: A git client (e.g., `git clone`, `git push`, `git fetch`) makes HTTP requests against `/{owner}/{repo}.git/...`.
2. **Routing**: `app.ts` passes the request to `githttp.ts:handleGitRequest`.
3. **Advertisement**: When fetching `/info/refs?service=git-upload-pack`, `githttp.ts` generates protocol v2 or v0 advertisements listing capabilities (`side-band-64k`, `ofs-delta`, `shallow`, `symref=HEAD:refs/heads/main`) and reference tips.
4. **Pack Generation**: During `git fetch` or `git clone`, `selectFetchObjects` traverses commit graphs, trees, and blobs using `walkCommits` and `collectReachable`, packages them with `writePack` (level 1 zlib deflation and SHA-1 checksum trailer), and streams them using sideband channel 1.
5. **Push Processing**: During `git push`, `handleReceivePack` parses pkt-line commands (`oldOid newOid ref`), reads the trailing packfile, decodes it via `readPack`, verifies object hashes, checks ancestry via `isAncestor`, enforces fast-forward rules, updates refs, and reports success (`ok`) or rejection (`ng non-fast-forward`).

### REST v3 API Execution Model
REST requests under `/api/v3` are routed through `rest.ts`. The router matches URL paths, parses JSON request bodies, validates query parameters (such as `per_page`, `page`, `state`, `sort`), interacts with the in-memory `store.ts` repository state, and serializes responses into GitHub REST v3 JSON formats with appropriate status codes (`200 OK`, `201 Created`, `204 No Content`, `404 Not Found`, `422 Unprocessable Entity`).

### GraphQL v4 API Execution Model
GraphQL requests to `/api/graphql` are parsed by a custom recursive descent parser (`graphql.ts`) into operation ASTs. Variable substitution, selection set traversal, and type resolution execute against the in-memory store. Errors are collected into an `errors` array while maintaining an HTTP 200 status code per GraphQL specification.

### MCP Streamable HTTP Execution Model
MCP requests to `/mcp` process JSON-RPC 2.0 messages. Initialization negotiates protocol versions (`2026-07-28`, `2025-11-25`, etc.), `tools/list` returns the sorted 6-tool array, and `tools/call` executes the requested tool function against the repository store, wrapping results in structured and text content payloads.

---

## API Reference & Documentation

Detailed technical specifications for each protocol and surface are located in the `docs/` directory:
- [REST v3 API Reference (`docs/API.md`)](docs/API.md): Complete reference for REST endpoints, authentication, pagination, request/response bodies, and error codes.
- [Git Protocol Reference (`docs/GIT-PROTOCOL.md`)](docs/GIT-PROTOCOL.md): Exhaustive specification of Git Smart HTTP routing, `info/refs` protocol v2/v0, fetch/upload-pack, receive-pack push validation, and packfile plumbing.
- [MCP Surface Reference (`docs/MCP.md`)](docs/MCP.md): Technical specification of the Model Context Protocol endpoint, JSON-RPC 2.0 handlers, initialization, and all six MCP tool schemas.

---

## Conformance, Testing & Verification

`ghforge` is verified against comprehensive conformance test suites ensuring absolute compliance with GitHub and Git protocol standards:
- **Git Transport Compliance**: Validates `git clone`, `git fetch`, `git push`, protocol v2 `ls-refs`/`fetch`, shallow clones (depth 1), and fast-forward push restrictions.
- **REST v3 Compliance**: Validates HTTP status codes, pagination headers (`Link`), metadata, and JSON structures for repositories, issues, pull requests, file contents, and squash merging.
- **GraphQL v4 Compliance**: Validates query execution, variable passing, field aliasing, inline fragments, batching, and schema introspection.
- **MCP Protocol Compliance**: Validates JSON-RPC 2.0 specifications, initialization handshake, tool discovery, and tool execution across all six repository tools.
- **Lifecycle Resilience**: Validates robust ephemeral port binding, environment registration (`/register`), and long-polling completion (`/done`).

### Security, Isolation & Troubleshooting
- **No External Binaries**: Operates purely in Node.js memory without spawning `git` child processes or accessing external file systems.
- **Bearer Token Enforcement**: Secures API, GraphQL, MCP, and Git operations against unauthorized access when `MAKEFUN_SHOP_TOKEN` is provisioned.
- **Request Tracing**: Injects `X-GitHub-Request-Id` headers across all responses for robust request auditing and debugging.
- **Experimental TypeScript Support**: Executable directly using Node 22 experimental strip-types execution flags (`node --experimental-strip-types`).
- **FAQ & Troubleshooting**: Ensure `MAKEFUN_ENV_URL` is correctly configured in container test environments. Ephemeral port binding (`server.listen(0)`) avoids port conflicts across parallel test suites.
- **System Requirements**: Node.js v22+ required for native experimental TypeScript evaluation.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
