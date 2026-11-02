# dsh-session-fulltext-search

Enable full-text search over DSH session history in the Web sidebar. [中文说明](README.zh-CN.md)

The DeepSeek Harness web UI ships with a content-search backend
(`@deepseek-ai/dsh-session-query-sqlite`, SQLite FTS5) that is **disabled by
default** (`openAt: never`): the sidebar magnifier then matches only session
titles and workspace names. This plugin is the deployment override the
backend's documentation prescribes — it patches that row to
`openAt: first-search` with a persistent derived index under `$DSH_HOME`.

## What you get

- The sidebar magnifier searches **message bodies** (user messages, assistant
  replies, tool results) across all workspaces, with a content snippet per hit.
- The index updates incrementally as sessions grow.
- The first search after install scans existing logs once; later searches are
  fast.

## Install

Into a profile (e.g. `desktop`):

```sh
dsh plugin --profile desktop add github:amd47802574/dsh-session-fulltext-search
```

`dsh plugin add` also registers the package in `dsh.profile.bundles` (the
patch-layer stack). Restart DSH afterwards. Manual equivalent:

```jsonc
// <profile>/package.json
"dependencies": {
  "dsh-session-fulltext-search": "github:amd47802574/dsh-session-fulltext-search"
},
"dsh": { "profile": { "bundles": ["…existing layers…", "dsh-session-fulltext-search"] } }
```

then `pnpm install` inside the profile directory and restart DSH.

## Uninstall

```sh
dsh plugin --profile desktop remove dsh-session-fulltext-search
```

After restarting DSH the sidebar falls back to title-only search. The derived
index file (`$DSH_HOME/session-query-index.sqlite3`) can be deleted.

## Notes

- Tokenizer is FTS5 `unicode61`: word/phrase matching, **not** arbitrary
  substring matching (`python` matches, `pytho` does not). Wrap a query in
  quotes (`"two words"`) for exact-phrase search; FTS5 operators (`OR`, `*`)
  are treated as plain text by the query parser.
- This layer only overrides the `session-query-sqlite` row's config
  (`path`, `openAt`). Your own profile `cordis.patch.yml` sits later in the
  stack, so a manual override there still wins over this plugin.
- The index is derived data — delete the file to force a rebuild. Never point
  `path` at the session persistence database.

## License

MIT
