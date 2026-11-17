# Conformance Test Suite Surface (`docs/CHECKS.md`)

This document lists the conformance test suite surface driven by the test harness, detailing expected responses, HTTP status codes, and protocol rules across REST v3, Git Smart-HTTP (v0/v2), GraphQL, and MCP.

---

## 1. REST v3 API Conformance Checklist

| Endpoint / Method | Description / Query Parameters | Expected Status Code | Expected Response Structure / Behavior |
| :--- | :--- | :--- | :--- |
| `GET /healthz` | Health check probe | `200 OK` | JSON `{ok: true, service: 'ghforge', requestId}` with header `X-GitHub-Request-Id` |
| `GET /api/v3` | API root discovery | `200 OK` | JSON with `current_user_url`, `repository_url`, `repositories_url` |
| `GET /api/v3/meta` | API metadata | `200 OK` | JSON `{installed_version: 'ghforge-1.0.0', version: 'ghforge-1.0.0'}` |
| `GET /api/v3/user` | Authenticated user profile | `200 OK` | JSON user object `{login, id, type, name}` |
| `GET /api/v3/user/repos` | List user repositories | `200 OK` | JSON array of repository objects; supports pagination (`Link` header) |
| `POST /api/v3/user/repos` | Create repository | `201 Created` | JSON repository object (or `422` if name is invalid) |
| `GET /api/v3/repos/{owner}/{repo}` | Get repository | `200 OK` | JSON repository object (or `404 Not Found` if missing/unauthorized) |
| `PATCH /api/v3/repos/{owner}/{repo}` | Update repository settings | `200 OK` | JSON updated repository object |
| `DELETE /api/v3/repos/{owner}/{repo}` | Delete repository | `204 No Content` | Empty body (subsequent GET returns `404`) |
| `GET /api/v3/repos/{owner}/{repo}/branches` | List branches | `200 OK` | JSON array of branch objects |
| `GET /api/v3/repos/{owner}/{repo}/branches/{branch}` | Get branch details | `200 OK` | JSON branch object with commit sha (or `404`) |
| `GET /api/v3/repos/{owner}/{repo}/git/refs/{ref}` | Get git reference | `200 OK` | JSON reference object pointing to commit OID |
| `POST /api/v3/repos/{owner}/{repo}/git/refs` | Create git reference | `201 Created` | JSON created ref object (or `422` if invalid/exists) |
| `GET /api/v3/repos/{owner}/{repo}/commits` | List commits on branch | `200 OK` | JSON array of commit objects (or `409` if empty repo) |
| `GET /api/v3/repos/{owner}/{repo}/commits/{sha}` | Get commit by SHA | `200 OK` | JSON commit object (or `404`/`422`) |
| `GET /api/v3/repos/{owner}/{repo}/labels` | List repository labels | `200 OK` | JSON array of label objects |
| `POST /api/v3/repos/{owner}/{repo}/labels` | Create label | `201 Created` | JSON label object |
| `GET /api/v3/repos/{owner}/{repo}/labels/{name}` | Get label by name | `200 OK` | JSON label object (or `404`) |
| `PATCH /api/v3/repos/{owner}/{repo}/labels/{name}` | Update label | `200 OK` | JSON updated label object |
| `DELETE /api/v3/repos/{owner}/{repo}/labels/{name}` | Delete label | `204 No Content` | Empty body |
| `GET /api/v3/repos/{owner}/{repo}/issues` | List repository issues | `200 OK` | JSON array of issue objects (filterable by state) |
| `POST /api/v3/repos/{owner}/{repo}/issues` | Create issue | `201 Created` | JSON issue object (or `422` on validation failure) |
| `GET /api/v3/repos/{owner}/{repo}/issues/{number}` | Get issue by number | `200 OK` | JSON issue object (or `404`) |
| `PATCH /api/v3/repos/{owner}/{repo}/issues/{number}` | Update/close issue | `200 OK` | JSON updated issue object |
| `GET /api/v3/repos/{owner}/{repo}/issues/{number}/comments` | List issue comments | `200 OK` | JSON array of comment objects |
| `POST /api/v3/repos/{owner}/{repo}/issues/{number}/comments` | Add issue comment | `201 Created` | JSON created comment object |
| `GET /api/v3/repos/{owner}/{repo}/pulls` | List pull requests | `200 OK` | JSON array of pull request objects |
| `POST /api/v3/repos/{owner}/{repo}/pulls` | Create pull request | `201 Created` | JSON pull request object (or `422`) |
| `GET /api/v3/repos/{owner}/{repo}/pulls/{number}` | Get pull request | `200 OK` | JSON pull request object (or `404`) |
| `PATCH /api/v3/repos/{owner}/{repo}/pulls/{number}` | Update pull request | `200 OK` | JSON updated pull request object |
| `GET /api/v3/repos/{owner}/{repo}/pulls/{number}/files` | List PR changed files | `200 OK` | JSON array of file diff summary objects |
| `GET /api/v3/repos/{owner}/{repo}/pulls/{number}/merge` | Check merge status | `204 No Content` (if merged) or `404`/`405` |
| `PUT /api/v3/repos/{owner}/{repo}/pulls/{number}/merge` | Merge pull request | `200 OK` | JSON merge result object `{sha, merged, message}` (or `405`/`422`) |
| `GET /api/v3/repos/{owner}/{repo}/contents/{path}` | Get file content or directory listing | `200 OK` | JSON base64 file content or directory array (or `404`) |
| `PUT /api/v3/repos/{owner}/{repo}/contents/{path}` | Create or update file content | `201 Created` / `200 OK` | JSON commit and content payload (or `409`/`422`) |
| `DELETE /api/v3/repos/{owner}/{repo}/contents/{path}` | Delete file content | `200 OK` | JSON commit payload with `content: null` (or `404`/`409`) |

---

## 2. Git Smart-HTTP Protocol (v0 / v2) Rules Checklist

| Endpoint / Protocol | Request Specification | Expected Status Code & Content-Type | Expected Behavior / Response Payload |
| :--- | :--- | :--- | :--- |
| `GET /{owner}/{repo}.git/info/refs?service=git-upload-pack` (v2) | `Git-Protocol: version=2` header | `200 OK`<br>`application/x-git-upload-pack-advertisement` | `# service=git-upload-pack\n`, flush pkt, `version 2`, capabilities (`agent=ghforge/1.0`, `ls-refs=unborn`, `fetch=shallow filter ofs-delta`, `object-format=sha1`), flush pkt. |
| `GET /{owner}/{repo}.git/info/refs?service=git-upload-pack` (v0) | Standard git client request | `200 OK`<br>`application/x-git-upload-pack-advertisement` | Pkt-lines of HEAD and refs with upload-pack capabilities (`symref=HEAD:refs/heads/main`, `ofs-delta`, etc.), flush pkt. |
| `GET /{owner}/{repo}.git/info/refs?service=git-receive-pack` (v0) | Push discovery | `200 OK`<br>`application/x-git-receive-pack-advertisement` | Pkt-lines of refs with receive-pack capabilities (`report-status`, `report-status-v2`, `delete-refs`, `side-band-64k`, `ofs-delta`), flush pkt. |
| `POST /{owner}/{repo}.git/git-upload-pack` (v2) | `ls-refs` or `fetch` command payload | `200 OK`<br>`application/x-git-upload-pack-result` | Protocol v2 command response (ref listing or sideband packfile stream). |
| `POST /{owner}/{repo}.git/git-upload-pack` (v0) | `want`, `have`, `done` pkt-lines | `200 OK`<br>`application/x-git-upload-pack-result` | `NAK`, optional shallow/unshallow lines, sideband packfile stream, flush pkt. |
| `POST /{owner}/{repo}.git/git-receive-pack` (v0) | Push commands + packfile | `200 OK`<br>`application/x-git-receive-pack-result` | Report status (`unpack ok` / `ok <ref>` or `ng <ref> <reason>`), sideband-64k encapsulated if requested. |

---

## 3. GraphQL API and Introspection Types Checklist

| Query / Mutation / Feature | Expected Response / Behavior |
| :--- | :--- |
| **Introspection (`__schema`, `__type`)** | Returns full schema introspection covering all types, fields, inputs, and enums. |
| **Root Query: `viewer`** | Returns authenticated user object (`User`). |
| **Root Query: `repository(owner, name)`** | Returns `Repository` object (or `null` if not found). |
| **Root Query: `node(id)` / `nodes(ids)`** | Resolves global node IDs (Base64 `${typeName}:${id}`) to `Issue`, `PullRequest`, or `Repository`. |
| **Mutation: `createIssue`** | Creates issue, returns `CreateIssuePayload` with issue object. |
| **Mutation: `closeIssue` / `updateIssue`** | Updates issue state/title/body, returns payload object. |
| **Mutation: `createPullRequest`** | Opens pull request, returns `CreatePullRequestPayload`. |
| **Mutation: `mergePullRequest`** | Squash-merges pull request, returns `MergePullRequestPayload` (or errors if conflicting). |
| **Mutation: `addComment`** | Adds comment to issue, returns `AddCommentPayload` with comment edge. |

### Core GraphQL Types Defined in Schema
- **Object Types**: `Query`, `Mutation`, `User`, `Repository`, `Ref`, `Commit`, `Issue`, `PullRequest`, `IssueConnection`, `IssueEdge`, `PullRequestConnection`, `PullRequestFileConnection`, `PullRequestFile`, `PullRequestCommitConnection`, `IssueCommentConnection`, `IssueComment`, `Comment`, `PageInfo`, `RepositoryConnection`, `CreateIssuePayload`, `CloseIssuePayload`, `UpdateIssuePayload`, `CreatePullRequestPayload`, `MergePullRequestPayload`, `AddCommentPayload`, `IssueCommentEdge`.
- **Interfaces**: `Node`, `GitObject`, `Actor`, `Owner`.
- **Enums**: `IssueState`, `PullRequestState`, `MergeableState`, `PullRequestMergeStateStatus`, `IssueOrderField`, `RepositoryPermission`, `SearchType`.

---

## 4. Model Context Protocol (MCP) Revision and Tools Checklist

| MCP Feature / Method | Expected Protocol Behavior / Response |
| :--- | :--- |
| **Supported Protocol Revisions** | `2026-07-28`, `2025-11-25`, `2025-06-18`, `2025-03-26` |
| **Transport / Endpoint** | JSON-RPC 2.0 over HTTP POST at `/mcp` (returns `Mcp-Session-Id` header). |
| **Method: `server/discover`** | Returns supported versions, server info (`ghforge`), and tool capabilities. |
| **Method: `initialize`** | Negotiates protocol version and returns server capabilities. |
| **Method: `notifications/initialized`** | Acknowledges initialization (returns `null`). |
| **Method: `tools/list`** | Returns deterministic, sorted list of all 6 forge tools, identical byte-for-byte on every call. |
| **Method: `tools/call`** | Executes requested tool and returns JSON-RPC result containing `content` and `structuredContent`. |

### MCP Tools (6 Tools)
1. `create_repo`: Creates a repository owned by the authenticated user.
2. `get_repo`: Retrieves repository details by owner and repo name.
3. `create_issue`: Opens an issue on a repository.
4. `list_issues`: Lists issues on a repository (newest first, supports state and page size filters).
5. `create_pull_request`: Opens a pull request between head and base branches.
6. `merge_pull_request`: Squash-merges an open pull request.

---

## 5. Conformance Test Verification and Error Scenarios

To ensure 100% compliance with the test harness requirements, conformance checks also validate negative test paths and error handling:
- **Authentication Failures (`401 Unauthorized`)**: Requests without valid bearer tokens (when `MAKEFUN_SHOP_TOKEN` is set) on REST, GraphQL, or MCP endpoints return `401 Unauthorized`.
- **Not Found vs Forbidden (`404 Not Found`)**: Accessing repositories or resources belonging to non-matching owners returns `404` rather than `403` to enforce the owner rule security policy.
- **Validation Failures (`422 Unprocessable Entity`)**: Malformed payloads, missing required fields, or non-existent branch/head references return `422` with descriptive error messages.
- **Conflict Handling (`409 Conflict`)**: Concurrent updates, content SHA mismatches, or non-fast-forward push conflicts return `409` status codes.

---

## 6. Detailed Conformance Harness Interaction Flow

The conformance test runner (`sdk/run.ts`) executes the following sequence during test verification:
1. **Health Probe**: Performs `GET /healthz` expecting `200 OK` and `{ok: true}`.
2. **Suite Discovery**: Loads all manifest checks (`GIT_CHECKS`, `restChecks`, `restProtocolChecks`, `GRAPHQL_CHECKS`, `MCP_CHECKS`).
3. **Sequential Check Execution**: Executes each conformance check sequentially with its own timeout and abort controller.
4. **Scoring & Output**: Computes feature points, agent points, and performance points, outputting either a formatted table or JSON summary.
