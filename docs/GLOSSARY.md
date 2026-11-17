# Forge and Git Protocol Glossary (`docs/GLOSSARY.md`)

This glossary provides precise, code-backed definitions for every technical term, protocol command, API property, and data structure referenced in the documentation and codebase of **ghforge** (`github-core-clone-01`).

---

## 1. Git Transport and Protocol Terms

### `upload-pack`
- **Definition**: The server-side Git service (and command endpoint `git-upload-pack`) responsible for negotiating object availability with a client during `git clone` or `git fetch`, selecting the required object closure, packing them into a packfile, and streaming them back to the client.
- **Code Reference**: `githttp.ts`, `gitcore.ts:selectFetchObjects`.

### `receive-pack`
- **Definition**: The server-side Git service (and command endpoint `git-receive-pack`) responsible for receiving a `git push` from a client, parsing push commands (`oldOid newOid ref`), unpacking and verifying uploaded packfiles, enforcing fast-forward push restrictions, updating references, and reporting status.
- **Code Reference**: `githttp.ts:handleReceivePack`, `store.ts:applyReceivePack`.

### `side-band-64k`
- **Definition**: A Git Smart HTTP capability negotiated during protocol handshakes that allows multiplexing data streams over a single HTTP connection into separate channels (channel 1 for packfile/output data, channel 2 for progress messages, channel 3 for error messages) with packet payloads up to 65,519 bytes.
- **Code Reference**: `githttp.ts:sideband`.

### `report-status`
- **Definition**: A protocol v0 Git push capability where the server returns an explicit status report after processing push commands, indicating whether each reference update succeeded (`ok <ref>`) or failed (`ng <ref> <reason>`), preceded by `unpack ok` or error details.
- **Code Reference**: `store.ts:applyReceivePack`.

### `delete-refs`
- **Definition**: A Git capability advertised by servers indicating support for deleting remote references during a push by specifying a `newOid` of all zeros (`0000000000000000000000000000000000000000`).
- **Code Reference**: `githttp.ts:v0Advertisement`, `store.ts:applyReceivePack`.

### `ls-refs`
- **Definition**: A Git protocol v2 command sent by clients to request a filtered listing of repository references (branches, tags) from the server, supporting arguments such as `symrefs`, `peel`, `unborn`, and `ref-prefix`.
- **Code Reference**: `githttp.ts:lsRefsResponse`.

### protocol v2
- **Definition**: The modern Git wire protocol introduced to improve fetch and clone negotiation efficiency, utilizing command-based pkt-line request framing (`command=ls-refs` or `command=fetch`) rather than protocol v0 capability negotiation lines.
- **Code Reference**: `githttp.ts:parseV2Request`, `v2Advertisement`.

### packfile
- **Definition**: The compressed binary format (`PACK` magic, version 2, object count, zlib-compressed objects with delta encoding, and trailing SHA-1 checksum) used by Git to store and transmit collections of Git objects efficiently.
- **Code Reference**: `gitcore.ts:writePack`, `readPack`.

### ref
- **Definition**: A pointer to a Git commit object, stored in a reference namespace (e.g., `refs/heads/main` for branches, `refs/tags/v1.0` for tags). In `ghforge`, refs are mapped in `repo.refs`.
- **Code Reference**: `store.ts:Repository.refs`.

### fast-forward
- **Definition**: A linear Git update where the target commit is a direct descendant of the current commit (i.e., the current commit is an ancestor of the new commit). `ghforge` strictly rejects pushes and updates that are not fast-forward unless explicitly permitted.
- **Code Reference**: `store.ts:isAncestor`, `applyReceivePack`.

---

## 2. API and GraphQL Property Terms

### contents API sha
- **Definition**: The 40-character hexadecimal SHA-1 hash of a file blob or tree object returned by the REST contents API (`GET /contents/{path}`), which must be provided back in subsequent `PUT` or `DELETE` requests to prevent concurrent update conflicts.
- **Code Reference**: `rest.ts`, `store.ts:commitPath`.

### databaseId
- **Definition**: The numeric identifier (`id`) of a record (repository, issue, pull request, user) exposed in the GitHub GraphQL v4 API schema, distinct from string-based global relay `node_id` strings.
- **Code Reference**: `graphql.ts`.

### nameWithOwner
- **Definition**: A combined string identifier representing a repository in the format `{owner}/{name}` (e.g., `user/hello-world`), commonly used in GraphQL queries and mutations to reference repositories.
- **Code Reference**: `graphql.ts`.

### viewerPermission
- **Definition**: An authorization property indicating the authenticated user's permission level on a repository (`ADMIN`, `WRITE`, `READ`, or boolean permission maps like `{admin: true, push: true, pull: true}`).
- **Code Reference**: `rest.ts`, `graphql.ts`.

### mergeable
- **Definition**: A pull request status indicator (`MERGEABLE` or `CONFLICTING`) evaluated by the server to determine whether a pull request can be cleanly merged into its base branch without code conflicts.
- **Code Reference**: `graphql.ts`, `rest.ts`.

---

## 3. Model Context Protocol (MCP) Terms

### JSON-RPC id
- **Definition**: An identifier (`string`, `number`, or `null`) included in JSON-RPC 2.0 request and response messages to correlate asynchronous responses with their corresponding outgoing requests.
- **Code Reference**: `mcp.ts`, `app.ts`.

### Streamable HTTP
- **Definition**: An HTTP-based transport mechanism used by the Model Context Protocol (`/mcp`) to transmit JSON-RPC 2.0 messages bidirectional with session tracking headers (`Mcp-Session-Id`).
- **Code Reference**: `mcp.ts`, `app.ts`.

### inputSchema
- **Definition**: A JSON Schema object defining the expected properties, data types, and required fields for parameters accepted by an MCP tool during `tools/call`.
- **Code Reference**: `mcp.ts:TOOLS`.

---

## 4. Supplementary Architectural Terms

### ephemeral port
- **Definition**: A dynamically assigned TCP port allocated by the OS kernel when binding a server to port `0`, used by `main.ts` to prevent port conflicts across test runs.
- **Code Reference**: `main.ts:server.listen(0)`.

### MAKEFUN_ENV_URL
- **Definition**: The environment origin URL used for harness communication (registering ephemeral ports and polling trial completion).
- **Code Reference**: `main.ts`.

### MAKEFUN_SHOP_TOKEN
- **Definition**: The bearer token string provisioned to authenticate API, GraphQL, MCP, and Git requests.
- **Code Reference**: `app.ts:checkAuth`.

### experimental-strip-types
- **Definition**: Node.js v22+ runtime execution flag enabling native execution of TypeScript files by stripping type annotations on the fly.
- **Code Reference**: Node 22 runtime specification.
