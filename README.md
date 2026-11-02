# dsh-session-fulltext-search

Enable full-text search over DSH session history in the Web sidebar — and make it actually find Chinese text. [中文说明](README.zh-CN.md)

The DeepSeek Harness web UI ships with a content-search backend
(`@deepseek-ai/dsh-session-query-sqlite`, SQLite FTS5) that is **disabled by
default** (`openAt: never`): the sidebar magnifier then matches only session
titles and workspace names. This plugin is the deployment override the
backend's documentation prescribes — `openAt: first-search` with a persistent
derived index under `$DSH_HOME`.

That alone has a catch for CJK users: FTS5's `unicode61` tokenizer treats a
run of continuous Chinese text as **one token**, so a query only matches when
it aligns with token boundaries — searching `福州大学` does not hit
`已保研至福州大学`. This plugin therefore also mounts a **substring fallback**:
queries containing CJK are answered with a literal substring scan over the
same derived index, so any Chinese phrase inside message bodies is found,
exactly as you typed it. Non-CJK queries use the tokenizer unchanged.

## What you get

- The sidebar magnifier searches **message bodies** (user messages, assistant
  replies) across all workspaces, with a content snippet per hit.
- **Chinese searches are substring-based** — no whole-token boundary problem.
- The index updates incrementally as sessions grow.

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

- CJK queries take the substring scan; other queries keep the tokenizer's
  word/phrase matching (so `pytho` still does not match `python` — by design,
  that is how FTS5 works). Wrap a query in quotes (`"two words"`) for
  exact-phrase search; FTS5 operators (`OR`, `*`) are treated as plain text.
- The fallback reads the derived index with its own read-only SQLite
  connection; the owning engine keeps writing (WAL). A missing or rebuilding
  index simply returns fewer results for that one query.
- This layer only overrides the `session-query-sqlite` row's config
  (`path`, `openAt`) and adds its own wrapper row. Your own profile
  `cordis.patch.yml` sits later in the stack, so a manual override there still
  wins over this plugin.
- The index is derived data — delete the file to force a rebuild. Never point
  `path` at the session persistence database.

## License

MIT
