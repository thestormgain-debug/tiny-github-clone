# ghforge REST API Reference (v3)

This document provides a thorough reference for the GitHub-compatible REST v3 API implemented by `ghforge` in `rest.ts` and `app.ts`.

## Overview & Authentication

- **Base URL**: `/api/v3`
- **Authentication**: Bearer Token via `Authorization: Bearer <token>` header. If `MAKEFUN_SHOP_TOKEN` is configured on the server, the presented token must match it.
- **Common Response Headers**:
  - `X-GitHub-Request-Id`: Unique request tracking identifier (e.g., `req-00000001`).
  - `X-Oauth-Scopes`: `repo, read:org` (returned on root and meta endpoints).
- **Error Format**: Most error responses return a JSON object with a `message` property, and optionally an `errors` array or `documentation_url`.

---

## 1. API Root

### GET /api/v3
Returns API root URLs and discovery links.

- **Method**: `GET`
- **Path**: `/api/v3`
- **Auth**: Optional / Public
- **Success Status**: `200 OK`
- **Error Statuses**: `401 Unauthorized`, `404 Not Found`
- **Response Headers**: `X-GitHub-Request-Id`, `X-Oauth-Scopes: repo, read:org`
- **Example Response**:
```json
{
  "current_user_url": "api/v3/user",
  "repository_url": "/api/v3/repos/{owner}/{repo}",
  "repositories_url": "/api/v3/user/repos"
}
```

---

## 2. Meta Information

### GET /api/v3/meta
Returns system version metadata.

- **Method**: `GET`
- **Path**: `/api/v3/meta`
- **Auth**: Optional / Public
- **Success Status**: `200 OK`
- **Error Statuses**: `401 Unauthorized`
- **Response Headers**: `X-GitHub-Request-Id`, `X-Oauth-Scopes: repo, read:org`
- **Example Response**:
```json
{
  "installed_version": "ghforge-1.0.0",
  "version": "ghforge-1.0.0"
}
```

---

## 3. Authenticated User

### GET /api/v3/user
Returns the authenticated user profile.

- **Method**: `GET`
- **Path**: `/api/v3/user`
- **Auth**: Required (`Bearer <token>`)
- **Success Status**: `200 OK`
- **Error Statuses**: `401 Unauthorized`
- **Example Response**:
```json
{
  "login": "user",
  "id": 1,
  "type": "User",
  "name": "user"
}
```

---

## 4. Repositories

### GET /api/v3/user/repos
Lists repositories owned by the authenticated user with pagination support (`per_page`, `page`).

- **Method**: `GET`
- **Path**: `/api/v3/user/repos`
- **Query Parameters**: `per_page` (1-100, default 30), `page` (default 1)
- **Auth**: Required
- **Success Status**: `200 OK`
- **Error Statuses**: `401 Unauthorized`
- **Response Headers**: `Link` (pagination links if applicable)
- **Example Response**:
```json
[
  {
    "id": 1,
    "node_id": "R_1",
    "name": "hello-world",
    "full_name": "user/hello-world",
    "owner": { "login": "user", "id": 1, "type": "User" },
    "private": true,
    "description": "A test repository",
    "fork": false,
    "default_branch": "main",
    "created_at": "2026-01-01T00:00:00.000Z",
    "updated_at": "2026-01-01T00:00:00.000Z",
    "pushed_at": "2026-01-01T00:00:00.000Z",
    "html_url": "https://git.make.fun/user/hello-world",
    "url": "/api/v3/repos/user/hello-world",
    "clone_url": "https://git.make.fun/user/hello-world.git",
    "size": 120,
    "open_issues_count": 0,
    "has_issues": true,
    "permissions": { "admin": true, "push": true, "pull": true }
  }
]
```

### POST /api/v3/user/repos
Creates a new repository for the authenticated user.

- **Method**: `POST`
- **Path**: `/api/v3/user/repos`
- **Auth**: Required
- **Request Body**:
```json
{
  "name": "new-repo",
  "private": true,
  "description": "My new repository"
}
```
- **Success Status**: `201 Created`
- **Error Statuses**: `401 Unauthorized`, `422 Unprocessable Entity` (if name is missing or invalid)
- **Example Response**:
```json
{
  "id": 2,
  "node_id": "R_2",
  "name": "new-repo",
  "full_name": "user/new-repo",
  "owner": { "login": "user", "id": 1, "type": "User" },
  "private": true,
  "description": "My new repository",
  "fork": false,
  "default_branch": "main",
  "created_at": "2026-01-01T00:00:00.000Z",
  "updated_at": "2026-01-01T00:00:00.000Z",
  "pushed_at": "2026-01-01T00:00:00.000Z",
  "html_url": "https://git.make.fun/user/new-repo",
  "url": "/api/v3/repos/user/new-repo",
  "clone_url": "https://git.make.fun/user/new-repo.git",
  "size": 0,
  "open_issues_count": 0,
  "has_issues": true,
  "permissions": { "admin": true, "push": true, "pull": true }
}
```

### GET /api/v3/repos/{owner}/{repo}
Gets repository details.

- **Method**: `GET`
- **Path**: `/api/v3/repos/{owner}/{repo}`
- **Auth**: Required
- **Success Status**: `200 OK`
- **Error Statuses**: `401 Unauthorized`, `404 Not Found`
- **Example Response**: (See repository object schema above)

### PATCH /api/v3/repos/{owner}/{repo}
Updates repository description or privacy.

- **Method**: `PATCH`
- **Path**: `/api/v3/repos/{owner}/{repo}`
- **Auth**: Required
- **Request Body**:
```json
{
  "description": "Updated description",
  "private": false
}
```
- **Success Status**: `200 OK`
- **Error Statuses**: `401 Unauthorized`, `404 Not Found`
- **Example Response**: (Updated repository object)

### DELETE /api/v3/repos/{owner}/{repo}
Deletes a repository.

- **Method**: `DELETE`
- **Path**: `/api/v3/repos/{owner}/{repo}`
- **Auth**: Required
- **Success Status**: `204 No Content` (empty body)
- **Error Statuses**: `401 Unauthorized`, `404 Not Found`

### POST /api/v3/repos/{owner}/{repo} (Shorthand Create)
If a repository does not exist, a POST to the repo base path creates it using the URL repo name.

- **Method**: `POST`
- **Path**: `/api/v3/repos/{owner}/{repo}`
- **Auth**: Required
- **Success Status**: `201 Created`
- **Error Statuses**: `401 Unauthorized`

---

## 5. Branches & Git References

### GET /api/v3/repos/{owner}/{repo}/branches
Lists branches in the repository.

- **Method**: `GET`
- **Path**: `/api/v3/repos/{owner}/{repo}/branches`
- **Auth**: Required
- **Success Status**: `200 OK`
- **Error Statuses**: `401 Unauthorized`, `404 Not Found`
- **Example Response**:
```json
[
  {
    "name": "main",
    "commit": { "sha": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4" },
    "protected": false
  }
]
```

### GET /api/v3/repos/{owner}/{repo}/branches/{branch}
Gets details for a specific branch.

- **Method**: `GET`
- **Path**: `/api/v3/repos/{owner}/{repo}/branches/{branch}`
- **Auth**: Required
- **Success Status**: `200 OK`
- **Error Statuses**: `401 Unauthorized`, `404 Not Found`
- **Example Response**:
```json
{
  "name": "main",
  "commit": { "sha": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4" },
  "protected": false
}
```

### GET /api/v3/repos/{owner}/{repo}/git/refs/{branch}
Gets git reference object details.

- **Method**: `GET`
- **Path**: `/api/v3/repos/{owner}/{repo}/git/refs/{branch}`
- **Auth**: Required
- **Success Status**: `200 OK`
- **Error Statuses**: `401 Unauthorized`, `404 Not Found`
- **Example Response**:
```json
{
  "ref": "refs/heads/main",
  "node_id": "ref_main",
  "object": {
    "sha": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4",
    "type": "commit",
    "url": "/api/v3/repos/user/hello-world/git/commits/e3b0c44298fc1c149afbf4c8996fb92427ae41e4"
  },
  "url": "/api/v3/repos/user/hello-world/git/refs/heads/main"
}
```

### POST /api/v3/repos/{owner}/{repo}/git/refs
Creates a new git reference (branch).

- **Method**: `POST`
- **Path**: `/api/v3/repos/{owner}/{repo}/git/refs`
- **Auth**: Required
- **Request Body**:
```json
{
  "ref": "refs/heads/feature",
  "sha": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4"
}
```
- **Success Status**: `201 Created`
- **Error Statuses**: `401 Unauthorized`, `422 Unprocessable Entity` (if ref format or sha is invalid, or ref already exists)
- **Example Response**:
```json
{
  "ref": "refs/heads/feature",
  "object": {
    "sha": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4",
    "type": "commit"
  }
}
```

---

## 6. Commits

### GET /api/v3/repos/{owner}/{repo}/commits
Lists commits on a branch or commit SHA (walks commit history).

- **Method**: `GET`
- **Path**: `/api/v3/repos/{owner}/{repo}/commits`
- **Query Parameters**: `sha` (branch name or commit SHA, defaults to default branch)
- **Auth**: Required
- **Success Status**: `200 OK`
- **Error Statuses**: `401 Unauthorized`, `409 Conflict` (if repository is empty)
- **Example Response**:
```json
[
  {
    "sha": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4",
    "node_id": "C_e3b0c442",
    "commit": {
      "message": "Initial commit",
      "author": { "name": "user", "email": "user@make.fun", "date": "2026-01-01T00:00:00.000Z" },
      "committer": { "name": "user", "email": "user@make.fun", "date": "2026-01-01T00:00:00.000Z" },
      "tree": { "sha": "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "url": "/api/v3/repos/user/hello-world/git/trees/4b825dc642cb6eb9a060e54bf8d69288fbee4904" },
      "url": "/api/v3/repos/user/hello-world/commits/e3b0c44298fc1c149afbf4c8996fb92427ae41e4"
    },
    "parents": [],
    "url": "/api/v3/repos/user/hello-world/commits/e3b0c44298fc1c149afbf4c8996fb92427ae41e4",
    "html_url": "https://git.make.fun/user/hello-world/commit/e3b0c44298fc1c149afbf4c8996fb92427ae41e4"
  }
]
```

### GET /api/v3/repos/{owner}/{repo}/commits/{sha}
Gets a single commit by SHA.

- **Method**: `GET`
- **Path**: `/api/v3/repos/{owner}/{repo}/commits/{sha}`
- **Auth**: Required
- **Success Status**: `200 OK`
- **Error Statuses**: `401 Unauthorized`, `404 Not Found`, `422 Unprocessable Entity` (if object is not a commit)
- **Example Response**: (See commit object schema above)

---

## 7. Labels

### GET /api/v3/repos/{owner}/{repo}/labels
Lists all labels in the repository.

- **Method**: `GET`
- **Path**: `/api/v3/repos/{owner}/{repo}/labels`
- **Auth**: Required
- **Success Status**: `200 OK`
- **Error Statuses**: `401 Unauthorized`, `404 Not Found`
- **Example Response**:
```json
[
  {
    "name": "bug",
    "color": "ff0000",
    "id": 501
  }
]
```

### POST /api/v3/repos/{owner}/{repo}/labels
Creates a new label.

- **Method**: `POST`
- **Path**: `/api/v3/repos/{owner}/{repo}/labels`
- **Auth**: Required
- **Request Body**:
```json
{
  "name": "enhancement",
  "color": "00ff00"
}
```
- **Success Status**: `201 Created`
- **Error Statuses**: `401 Unauthorized`, `422 Unprocessable Entity` (if name is missing)
- **Example Response**:
```json
{
  "name": "enhancement",
  "color": "00ff00",
  "id": 502
}
```

### GET /api/v3/repos/{owner}/{repo}/labels/{name}
Gets a specific label by name.

- **Method**: `GET`
- **Path**: `/api/v3/repos/{owner}/{repo}/labels/{name}`
- **Auth**: Required
- **Success Status**: `200 OK`
- **Error Statuses**: `401 Unauthorized`, `404 Not Found`
- **Example Response**:
```json
{
  "name": "bug",
  "color": "ff0000",
  "id": 500
}
```

### PATCH /api/v3/repos/{owner}/{repo}/labels/{name}
Updates a label.

- **Method**: `PATCH`
- **Path**: `/api/v3/repos/{owner}/{repo}/labels/{name}`
- **Auth**: Required
- **Request Body**:
```json
{
  "new_name": "critical-bug",
  "color": "990000"
}
```
- **Success Status**: `200 OK`
- **Error Statuses**: `401 Unauthorized`, `404 Not Found`
- **Example Response**:
```json
{
  "name": "critical-bug",
  "color": "990000",
  "id": 500
}
```

### DELETE /api/v3/repos/{owner}/{repo}/labels/{name}
Deletes a label.

- **Method**: `DELETE`
- **Path**: `/api/v3/repos/{owner}/{repo}/labels/{name}`
- **Auth**: Required
- **Success Status**: `204 No Content`
- **Error Statuses**: `401 Unauthorized`, `404 Not Found`

---

## 8. Issues

### GET /api/v3/repos/{owner}/{repo}/issues
Lists issues with filtering (`state`, `sort`, `direction`, `per_page`, `page`).

- **Method**: `GET`
- **Path**: `/api/v3/repos/{owner}/{repo}/issues`
- **Query Parameters**: `state` (`open`, `closed`, `all`, default `open`), `sort` (`created`, etc.), `direction` (`asc`, `desc`, default `desc`), `per_page`, `page`
- **Auth**: Required
- **Success Status**: `200 OK`
- **Error Statuses**: `401 Unauthorized`, `404 Not Found`
- **Example Response**:
```json
[
  {
    "id": 10001,
    "number": 1,
    "title": "Fix bug in parser",
    "body": "Parser fails on edge cases.",
    "state": "open",
    "labels": [{ "name": "bug", "color": "ff0000" }],
    "user": { "login": "user" },
    "comments": 0,
    "created_at": "2026-01-01T00:00:00.000Z",
    "updated_at": "2026-01-01T00:00:00.000Z",
    "closed_at": null,
    "url": "/api/v3/repos/user/hello-world/issues/1",
    "html_url": "https://git.make.fun/user/hello-world/issues/1"
  }
]
```

### POST /api/v3/repos/{owner}/{repo}/issues
Creates a new issue.

- **Method**: `POST`
- **Path**: `/api/v3/repos/{owner}/{repo}/issues`
- **Auth**: Required
- **Request Body**:
```json
{
  "title": "New issue title",
  "body": "Issue description",
  "labels": ["bug"]
}
```
- **Success Status**: `201 Created`
- **Error Statuses**: `401 Unauthorized`, `422 Unprocessable Entity` (if title is missing or label does not exist)
- **Example Response**: (See issue object schema above)

### GET /api/v3/repos/{owner}/{repo}/issues/{issue_number}
Gets an issue by number.

- **Method**: `GET`
- **Path**: `/api/v3/repos/{owner}/{repo}/issues/{issue_number}`
- **Auth**: Required
- **Success Status**: `200 OK`
- **Error Statuses**: `401 Unauthorized`, `404 Not Found`
- **Example Response**: (See issue object schema above)

### PATCH /api/v3/repos/{owner}/{repo}/issues/{issue_number}
Updates or closes an issue.

- **Method**: `PATCH`
- **Path**: `/api/v3/repos/{owner}/{repo}/issues/{issue_number}`
- **Auth**: Required
- **Request Body**:
```json
{
  "state": "closed",
  "title": "Updated issue title",
  "body": "Updated body"
}
```
- **Success Status**: `200 OK`
- **Error Statuses**: `401 Unauthorized`, `404 Not Found`, `422 Unprocessable Entity` (if state is invalid)
- **Example Response**: (Updated issue object)

---

## 9. Issue Comments

### GET /api/v3/repos/{owner}/{repo}/issues/{issue_number}/comments
Lists comments on an issue.

- **Method**: `GET`
- **Path**: `/api/v3/repos/{owner}/{repo}/issues/{issue_number}/comments`
- **Auth**: Required
- **Success Status**: `200 OK`
- **Error Statuses**: `401 Unauthorized`, `404 Not Found`
- **Example Response**:
```json
[
  {
    "id": 1,
    "body": "Looks good!",
    "created_at": "2026-01-01T00:00:00.000Z",
    "user": { "login": "user" }
  }
]
```

### POST /api/v3/repos/{owner}/{repo}/issues/{issue_number}/comments
Creates a comment on an issue.

- **Method**: `POST`
- **Path**: `/api/v3/repos/{owner}/{repo}/issues/{issue_number}/comments`
- **Auth**: Required
- **Request Body**:
```json
{
  "body": "LGTM!"
}
```
- **Success Status**: `201 Created`
- **Error Statuses**: `401 Unauthorized`, `404 Not Found`, `422 Unprocessable Entity` (if body is empty)
- **Example Response**:
```json
{
  "id": 2,
  "body": "LGTM!",
  "created_at": "2026-01-01T00:00:00.000Z",
  "user": { "login": "user" }
}
```

---

## 10. Pull Requests

### GET /api/v3/repos/{owner}/{repo}/pulls
Lists pull requests with filtering (`state`: `open`, `closed`, `all`).

- **Method**: `GET`
- **Path**: `/api/v3/repos/{owner}/{repo}/pulls`
- **Query Parameters**: `state` (default `open`)
- **Auth**: Required
- **Success Status**: `200 OK`
- **Error Statuses**: `401 Unauthorized`, `404 Not Found`
- **Example Response**:
```json
[
  {
    "id": 20001,
    "number": 1,
    "title": "Add feature X",
    "body": "Implements feature X.",
    "state": "open",
    "merged": false,
    "merged_at": null,
    "merge_commit_sha": null,
    "user": { "login": "user" },
    "head": { "ref": "feature", "sha": "abc1234...", "label": "feature" },
    "base": { "ref": "main", "sha": "e3b0c442...", "label": "main" },
    "created_at": "2026-01-01T00:00:00.000Z",
    "updated_at": "2026-01-01T00:00:00.000Z",
    "url": "/api/v3/repos/user/hello-world/pulls/1",
    "html_url": "https://git.make.fun/user/hello-world/pull/1"
  }
]
```

### POST /api/v3/repos/{owner}/{repo}/pulls
Creates a pull request.

- **Method**: `POST`
- **Path**: `/api/v3/repos/{owner}/{repo}/pulls`
- **Auth**: Required
- **Request Body**:
```json
{
  "title": "Add feature X",
  "body": "Implements feature X",
  "head": "feature",
  "base": "main"
}
```
- **Success Status**: `201 Created`
- **Error Statuses**: `401 Unauthorized`, `404 Not Found`, `422 Unprocessable Entity` (if head or base ref not found)
- **Example Response**: (See pull request object schema above)

### GET /api/v3/repos/{owner}/{repo}/pulls/{pull_number}
Gets pull request details.

- **Method**: `GET`
- **Path**: `/api/v3/repos/{owner}/{repo}/pulls/{pull_number}`
- **Auth**: Required
- **Success Status**: `200 OK`
- **Error Statuses**: `401 Unauthorized`, `404 Not Found`
- **Example Response**: (See pull request object schema above)

### PATCH /api/v3/repos/{owner}/{repo}/pulls/{pull_number}
Updates or closes a pull request.

- **Method**: `PATCH`
- **Path**: `/api/v3/repos/{owner}/{repo}/pulls/{pull_number}`
- **Auth**: Required
- **Request Body**:
```json
{
  "state": "closed",
  "title": "Updated PR title"
}
```
- **Success Status**: `200 OK`
- **Error Statuses**: `401 Unauthorized`, `404 Not Found`
- **Example Response**: (Updated pull request object)

### GET /api/v3/repos/{owner}/{repo}/pulls/{pull_number}/files
Lists files changed in a pull request (diff summary).

- **Method**: `GET`
- **Path**: `/api/v3/repos/{owner}/{repo}/pulls/{pull_number}/files`
- **Auth**: Required
- **Success Status**: `200 OK`
- **Error Statuses**: `401 Unauthorized`, `404 Not Found`, `422 Unprocessable Entity`
- **Example Response**:
```json
[
  {
    "sha": "README.md:5-2",
    "filename": "README.md",
    "status": "modified",
    "additions": 5,
    "deletions": 2,
    "changes": 7
  }
]
```

### GET /api/v3/repos/{owner}/{repo}/pulls/{pull_number}/merge
Checks if a pull request has been merged.

- **Method**: `GET`
- **Path**: `/api/v3/repos/{owner}/{repo}/pulls/{pull_number}/merge`
- **Auth**: Required
- **Success Status**: `204 No Content` (if already merged)
- **Error Statuses**: `401 Unauthorized`, `404 Not Found` (if not merged / not found)
- **Example Error Response**:
```json
{
  "message": "Pull Request is not mergeable"
}
```

### PUT /api/v3/repos/{owner}/{repo}/pulls/{pull_number}/merge
Merges a pull request (squash merge).

- **Method**: `PUT`
- **Path**: `/api/v3/repos/{owner}/{repo}/pulls/{pull_number}/merge`
- **Auth**: Required
- **Request Body**:
```json
{
  "commit_title": "Merge PR #1: Add feature X"
}
```
- **Success Status**: `200 OK`
- **Error Statuses**: `401 Unauthorized`, `404 Not Found`, `405 Method Not Allowed` (if already merged or has conflicts), `422 Unprocessable Entity`
- **Example Response**:
```json
{
  "sha": "f1e2d3c4b5a6...",
  "merged": true,
  "message": "Pull Request successfully merged"
}
```

---

## 11. Contents

### GET /api/v3/repos/{owner}/{repo}/contents/{path} (or root GET /api/v3/repos/{owner}/{repo}/contents)
Gets file contents or directory listing.

- **Method**: `GET`
- **Path**: `/api/v3/repos/{owner}/{repo}/contents/{path}`
- **Query Parameters**: `ref` (branch name or commit SHA, defaults to default branch)
- **Auth**: Required
- **Success Status**: `200 OK`
- **Error Statuses**: `401 Unauthorized`, `404 Not Found`
- **Example File Response**:
```json
{
  "name": "README.md",
  "path": "README.md",
  "sha": "c1a2b3c4...",
  "size": 150,
  "type": "file",
  "content": "IyBnaGZvcmdlCg==",
  "encoding": "base64",
  "url": "/api/v3/repos/user/hello-world/contents/README.md",
  "download_url": "https://git.make.fun/user/hello-world/raw/README.md",
  "html_url": "https://git.make.fun/user/hello-world/blob/README.md"
}
```
- **Example Directory Response**:
```json
[
  {
    "name": "README.md",
    "path": "README.md",
    "sha": "c1a2b3c4...",
    "size": 150,
    "type": "file",
    "url": "/api/v3/repos/user/hello-world/contents/README.md"
  }
]
```

### PUT /api/v3/repos/{owner}/{repo}/contents/{path}
Creates or updates a file in the repository.

- **Method**: `PUT`
- **Path**: `/api/v3/repos/{owner}/{repo}/contents/{path}`
- **Auth**: Required
- **Request Body**:
```json
{
  "message": "Update README.md",
  "content": "IyBnaGZvcmdlCg==",
  "branch": "main",
  "sha": "c1a2b3c4..."
}
```
- **Success Status**: `201 Created` (for new file) or `200 OK` (for updated file)
- **Error Statuses**: `401 Unauthorized`, `409 Conflict` (if sha is missing or invalid on update), `422 Unprocessable Entity`
- **Example Response**:
```json
{
  "content": {
    "name": "README.md",
    "path": "README.md",
    "sha": "d2b3c4d5...",
    "size": 150,
    "type": "file",
    "content": "IyBnaGZvcmdlCg==",
    "encoding": "base64",
    "url": "/api/v3/repos/user/hello-world/contents/README.md",
    "download_url": "https://git.make.fun/user/hello-world/raw/README.md",
    "html_url": "https://git.make.fun/user/hello-world/blob/README.md"
  },
  "commit": {
    "sha": "e5f6a7b8...",
    "message": "Update README.md"
  }
}
```

### DELETE /api/v3/repos/{owner}/{repo}/contents/{path}
Deletes a file from the repository.

- **Method**: `DELETE`
- **Path**: `/api/v3/repos/{owner}/{repo}/contents/{path}`
- **Auth**: Required
- **Request Body**:
```json
{
  "message": "Delete file",
  "branch": "main",
  "sha": "c1a2b3c4..."
}
```
- **Success Status**: `200 OK`
- **Error Statuses**: `401 Unauthorized`, `404 Not Found`, `409 Conflict` (if sha is missing or doesn't match), `422 Unprocessable Entity`
- **Example Response**:
```json
{
  "commit": {
    "sha": "a1b2c3d4...",
    "message": "Delete file"
  },
  "content": null
}
```
