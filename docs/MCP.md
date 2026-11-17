# Model Context Protocol (MCP) Surface Reference

This document provides a comprehensive technical specification of the Model Context Protocol (MCP) Streamable HTTP endpoint (`mcp.ts` and `app.ts`) implemented in **ghforge**.

---

## 1. Endpoint, Transport, and Authentication

### 1.1 HTTP Route and Headers
- **Route**: `POST /mcp`
- **Session Header**: Responses from `/mcp` include the header `Mcp-Session-Id: session-ghforge-1`.
- **Request ID Header**: Includes `X-GitHub-Request-Id` for tracing and debugging.

### 1.2 Authentication (`401 Unauthorized`)
When a request hits `/mcp`, authentication is verified via `checkAuth(request)`:
- If no token or an invalid bearer token is presented (when a server shop token is configured via `MAKEFUN_SHOP_TOKEN`), ghforge rejects the request with HTTP status `401 Unauthorized`.
- **Response Status**: `401`
- **Response Body**:
  ```json
  {
    "message": "Requires authentication",
    "requestId": "<request-id>"
  }
  ```
- **Response Header**: `X-GitHub-Request-Id: <request-id>`

---

## 2. JSON-RPC 2.0 Protocol & Revisions

The `/mcp` endpoint implements JSON-RPC 2.0 message handling over HTTP, supporting both single message objects and batch requests (JSON arrays).

### 2.1 Protocol Versions and Discovery (`server/discover`)
Clients can discover server capabilities and supported protocol revisions via the `server/discover` method.
- **Supported Versions**:
  ```json
  ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"]
  ```
- **Server Info**:
  - `name`: `ghforge`
  - `title`: `ghforge git forge`
  - `version`: `1.0.0`
- **Capabilities**: `tools: { listChanged: false }`

### 2.2 Initialization (`initialize`)
The `initialize` method negotiates the protocol version between client and server:
- **Request Parameters**: Accepts `protocolVersion` (string). Default fallback is `'2025-11-25'`.
- **Version Negotiation**: If the requested version is in the supported list (`['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26']`), it echoes the requested version; otherwise, it falls back to the latest supported version (`'2026-07-28'`).
- **Response Result**:
  ```json
  {
    "protocolVersion": "2026-07-28",
    "capabilities": { "tools": { "listChanged": false } },
    "serverInfo": { "name": "ghforge", "title": "ghforge git forge", "version": "1.0.0" }
  }
  ```

### 2.3 Notifications
- Methods starting with `notifications/` (such as `notifications/initialized`) are acknowledged silently by returning `null` (no JSON-RPC response message emitted).

---

## 3. Tool Listing (`tools/list`)

The `tools/list` method returns the deterministic, sorted list of available tool specifications (`TOOLS`).
- **Idempotency**: Two successive calls to `tools/list` are guaranteed to return identical tool arrays byte-for-byte.
- **Tools Count**: Exactly 6 tools.

---

## 4. The Six Tools and Their Schemas

Below are the definitions, descriptions, input schemas, and execution behaviors for all six MCP tools exposed by ghforge.

### 4.1 `create_repo`
- **Description**: Create a repository owned by the authenticated user.
- **Input Schema**:
  ```json
  {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Repository name" },
      "private": { "type": "boolean", "description": "Whether the repository is private (default true)" },
      "description": { "type": "string", "description": "Short description" }
    },
    "required": ["name"],
    "additionalProperties": false
  }
  ```
- **Behavior**: Creates or retrieves a repository in the store with the specified name, privacy setting (defaulting to true), and description, returning repository JSON.

### 4.2 `get_repo`
- **Description**: Get one repository owned by the authenticated user.
- **Input Schema**:
  ```json
  {
    "type": "object",
    "properties": {
      "owner": { "type": "string", "description": "Repository owner login" },
      "repo": { "type": "string", "description": "Repository name" }
    },
    "required": ["owner", "repo"],
    "additionalProperties": false
  }
  ```
- **Behavior**: Looks up the repository by owner and name. Returns repository JSON or an error if not found.

### 4.3 `create_issue`
- **Description**: Open an issue on a repository.
- **Input Schema**:
  ```json
  {
    "type": "object",
    "properties": {
      "owner": { "type": "string", "description": "Repository owner login" },
      "repo": { "type": "string", "description": "Repository name" },
      "title": { "type": "string", "description": "Issue title" },
      "body": { "type": "string", "description": "Issue body" }
    },
    "required": ["owner", "repo", "title"],
    "additionalProperties": false
  }
  ```
- **Behavior**: Adds a new issue to the repository's issue map, incrementing `nextIssueNumber`, and returns the created issue object.

### 4.4 `list_issues`
- **Description**: List issues on a repository (newest first).
- **Input Schema**:
  ```json
  {
    "type": "object",
    "properties": {
      "owner": { "type": "string", "description": "Repository owner login" },
      "repo": { "type": "string", "description": "Repository name" },
      "state": { "type": "string", "enum": ["open", "closed", "all"], "description": "Filter by state (default open)" },
      "per_page": { "type": "integer", "description": "Page size (default 30)" }
    },
    "required": ["owner", "repo"],
    "additionalProperties": false
  }
  ```
- **Behavior**: Retrieves issues sorted by number descending, filtered by state and capped by `per_page`.

### 4.5 `create_pull_request`
- **Description**: Open a pull request between two branches.
- **Input Schema**:
  ```json
  {
    "type": "object",
    "properties": {
      "owner": { "type": "string", "description": "Repository owner login" },
      "repo": { "type": "string", "description": "Repository name" },
      "title": { "type": "string", "description": "Pull request title" },
      "body": { "type": "string", "description": "Pull request body" },
      "head": { "type": "string", "description": "Head branch name" },
      "base": { "type": "string", "description": "Base branch name (default the repository default branch)" }
    },
    "required": ["owner", "repo", "title", "head"],
    "additionalProperties": false
  }
  ```
- **Behavior**: Validates that head and base branches resolve to valid refs, creates a pull request, and returns its details.

### 4.6 `merge_pull_request`
- **Description**: Merge an open pull request (squash).
- **Input Schema**:
  ```json
  {
    "type": "object",
    "properties": {
      "owner": { "type": "string", "description": "Repository owner login" },
      "repo": { "type": "string", "description": "Repository name" },
      "pull_number": { "type": "integer", "description": "Pull request number" }
    },
    "required": ["owner", "repo", "pull_number"],
    "additionalProperties": false
  }
  ```
- **Behavior**: Invokes `mergePullById` to perform a squash merge of the pull request into the base branch.

---

## 5. Tool Execution (`tools/call`)

When a client calls `tools/call`, ghforge:
1. Extracts `params.name` (tool name) and `params.arguments`.
2. Validates that the tool name is provided and exists in `TOOLS`.
3. Executes `callTool(store, toolName, args)`.
4. If execution fails or parameters are invalid, returns JSON-RPC error `-32602`.
5. On success, serializes the result into text content and structured content:
   ```json
   {
     "jsonrpc": "2.0",
     "id": "<id>",
     "result": {
       "content": [{ "type": "text", "text": "<json-stringified-result>" }],
       "structuredContent": "<result-object>"
     }
   }
   ```

---

## 6. JSON-RPC Error Codes and Error Handling

ghforge adheres strictly to standard JSON-RPC 2.0 error codes across the MCP surface:

- **`-32700` (Parse Error)**:
  - Triggered when the request body sent to `/mcp` cannot be parsed as valid JSON.
  - Handled in `app.ts`: returns HTTP 400 with body:
    ```json
    {
      "jsonrpc": "2.0",
      "id": null,
      "error": { "code": -32700, "message": "Parse error" }
    }
    ```

- **`-32601` (Method Not Found)**:
  - Triggered when an unrecognized JSON-RPC method name is requested.
  - Response object:
    ```json
    {
      "jsonrpc": "2.0",
      "id": "<id>",
      "error": { "code": -32601, "message": "Method not found: <method>" }
    }
    ```

- **`-32602` (Invalid Params)**:
  - Triggered when required parameters (such as `name` in `tools/call`), unknown tool names, or validation checks fail during tool execution.
  - Response object:
    ```json
    {
      "jsonrpc": "2.0",
      "id": "<id>",
      "error": { "code": -32602, "message": "<detailed-error-message>" }
    }
    ```
