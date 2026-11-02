# dsh-session-fulltext-search

让 DSH 网页侧边栏的放大镜支持**会话历史全文搜索**——并且真正搜得到中文。[English](README.md)

DeepSeek Harness 自带 SQLite FTS5 内容搜索后端
（`@deepseek-ai/dsh-session-query-sqlite`），但默认部署把它配置为
`openAt: never`：侧边栏搜索只会匹配会话标题与工作区名。本插件就是后端
文档规定的部署级开关——把该行覆盖为 `openAt: first-search`，并在
`$DSH_HOME` 下使用持久化派生索引。

但对中文用户这只解决了第一层：FTS5 的 `unicode61` 分词器把**连续中文
文本整体当作一个 token**，查询词只有恰好在 token 边界对齐时才能命中——
搜 `福州大学` 搜不到 `已保研至福州大学`。因此本插件同时挂载一个
**子串回退层**：包含 CJK 字符的查询改用字面子串扫描同一个派生索引，
消息正文里的任何中文片段都能按原文找到；非 CJK 查询仍走分词索引。

## 效果

- 侧边栏放大镜可搜索**消息正文**（用户消息、助手回复），跨全部工作区，
  命中行附带内容摘要。
- **中文搜索是子串匹配**——不存在整 token 边界问题。
- 索引随会话增量更新。

## 安装

装进某个 profile（例如 `desktop`）：

```sh
dsh plugin --profile desktop add github:amd47802574/dsh-session-fulltext-search
```

`dsh plugin add` 会同时把包登记进 `dsh.profile.bundles`（组合层列表），
随后重启 DSH 即生效。手动等价写法：

```jsonc
// <profile>/package.json
"dependencies": {
  "dsh-session-fulltext-search": "github:amd47802574/dsh-session-fulltext-search"
},
"dsh": { "profile": { "bundles": ["…原有层…", "dsh-session-fulltext-search"] } }
```

然后在 profile 目录里执行 `pnpm install` 并重启 DSH。

## 卸载

```sh
dsh plugin --profile desktop remove dsh-session-fulltext-search
```

重启 DSH 后侧边栏退回仅标题搜索。派生索引文件
（`$DSH_HOME/session-query-index.sqlite3`）可随手删除。

## 注意

- 含 CJK 字符的查询走子串扫描；其他查询保持分词器的词/短语匹配
  （`pytho` 依然搜不到 `python`——这是 FTS5 的设计）。整句精确搜索请加
  引号（`"两个 词"`）；FTS5 操作符（`OR`、`*`）会被当作普通文本处理。
- 回退层用独立的只读 SQLite 连接读派生索引，引擎继续写入（WAL）。
  索引缺失或正在重建时，该次查询只是结果少一些，不会报错。
- 插件只覆盖 `session-query-sqlite` 一行的 `config`（`path`、`openAt`）
  并新增自己的包装行。你自己 profile 的 `cordis.patch.yml` 在层栈中更靠后，
  若你再覆盖该行，仍以你的配置为准。
- 索引是派生数据，删掉文件即触发重建；不要把 `path` 指向会话持久化
  数据库。

## 许可

MIT
