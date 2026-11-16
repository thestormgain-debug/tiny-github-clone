# ghforge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ghforge/ghforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ghforge/ghforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process: git smart HTTP (upload-pack protocol v2 and v0, receive-pack v0 with report-status, side-band-64k and delete-refs, shallow fetch depth 1, fast-forward-only pushes), the REST v3 API under /api/v3 (repositories, contents, labels, issues, pull requests with squash merge), the GraphQL v4 API at /api/graphql with introspection, and an MCP endpoint at /mcp (JSON-RPC 2.0, Streamable HTTP) — all served from its own in-memory store with no git binary, no packages and no outside service.

## Run it

```sh
node main.ts
```

The program binds an ephemeral port, POSTs {"port": N} to $MAKEFUN_ENV_URL/register, then long-polls GET $MAKEFUN_ENV_URL/done and exits 0 when the env answers {"done": true}.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
