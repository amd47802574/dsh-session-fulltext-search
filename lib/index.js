/**
 * dsh-session-fulltext-search — enable dsh's built-in session full-text
 * search backend, and add a substring fallback for CJK queries.
 *
 * Two layers:
 *
 * 1. The bundle patch (cordis.patch.yml) overrides the `session-query-sqlite`
 *    row to `openAt: first-search` with a persistent derived index — without
 *    it the deployment default (`never`) makes the sidebar search match
 *    session titles only.
 *
 * 2. This node half wraps `ctx.sessionQuery` (mounted after the engine, so
 *    the wrapper shadows it for callers that resolve the service late, which
 *    is exactly how the host api-proxy resolves it per request). The FTS5
 *    `unicode61` tokenizer treats a run of continuous CJK text as ONE token,
 *    so a Chinese phrase that does not start and end at a token boundary
 *    never matches — "已保研至福州大学" is a single token, and the query
 *    "福州大学" is not equal to it. For queries containing CJK the wrapper
 *    runs a literal substring scan over the same derived index (LIKE), which
 *    is a superset of the tokenizer's phrase recall, and fabricates the
 *    engine's `SessionSearchHit` shape so every existing consumer — the
 *    sidebar RPC projection, the session-query tool — keeps working.
 *
 * Non-CJK queries pass through to the engine untouched, as does every other
 * engine method (exact reads, traces, within-session search, filters).
 *
 * No dependencies: node:sqlite is built into the Node runtime the host
 * already requires. The second connection opens the derived index read-only;
 * WAL mode lets it read while the owning engine writes.
 *
 * @module dsh-session-fulltext-search
 */

/** Cordis plugin name, for loader diagnostics. */
export const name = 'dsh-session-fulltext-search'

/** Wait for the engine service so the wrapper captures a live reference. */
export const inject = ['sessionQuery']

/** CJK scripts the tokenizer cannot phrase-match inside continuous text. */
const CJK_RE = /[\u3040-\u30FF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/

/** Wire bound shared with the host projection (Unicode code points). */
const SNIPPET_MAX_CODE_POINTS = 240

/** Engine contract defaults: page size and the largest accepted page. */
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

/** Largest sane offset continuation we will honor. */
const MAX_OFFSET = 1_000_000

/** Prefix branding our opaque offset cursors. */
const CURSOR_PREFIX = 'sfs1.'

/** @param {number} offset - zero-based row offset already served. */
function encodeCursor(offset) {
  const payload = Buffer.from(JSON.stringify({ v: 1, o: offset }), 'utf8').toString('base64url')
  return CURSOR_PREFIX + payload
}

/** @returns {number | null} the offset, or null when the cursor is foreign/corrupt. */
function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor.startsWith(CURSOR_PREFIX)) return null
  try {
    const parsed = JSON.parse(Buffer.from(cursor.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8'))
    if (parsed?.v !== 1 || !Number.isInteger(parsed.o) || parsed.o < 0 || parsed.o > MAX_OFFSET) return null
    return parsed.o
  } catch {
    return null
  }
}

/** Escape LIKE wildcards so the query stays a literal substring. */
function escapeLike(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

/** Longest prefix containing at most `maximum` Unicode code points. */
function truncateCodePoints(value, maximum) {
  let count = 0
  let end = 0
  for (const codePoint of value) {
    if (count === maximum) return value.slice(0, end)
    count++
    end += codePoint.length
  }
  return value
}

/** Whitespace-normalized, code-point-bounded plain-text excerpt. */
function buildSnippet(window) {
  return truncateCodePoints(window.replaceAll(/\s+/g, ' ').trim(), SNIPPET_MAX_CODE_POINTS)
}

/**
 * Reduce the request's event metadata filters to the two kinds the scan can
 * honor exactly. Anything else (seq/time ranges, unexpected shapes) returns
 * null and the query defers to the engine rather than guessing semantics.
 */
function scanFilters(request) {
  const filters = request?.eventFilters
  if (!Array.isArray(filters) || filters.length === 0) return { types: null, surfaces: null }
  const types = []
  const surfaces = []
  for (const filter of filters) {
    if (filter?.kind === 'type' && Array.isArray(filter.values)) types.push(...filter.values)
    else if (filter?.kind === 'surface' && Array.isArray(filter.values)) surfaces.push(...filter.values)
    else return null
  }
  if (types.length === 0 || surfaces.length === 0) return null
  return { types, surfaces }
}

/**
 * Mount the plugin: capture the engine, provide the wrapping service.
 * @param ctx - cordis context with `sessionQuery` injected.
 * @param config - row config; `index` is the derived-index path.
 */
export function apply(ctx, config) {
  const engine = ctx.sessionQuery
  const logger = ctx.logger('dsh-session-fulltext-search')
  const indexPath = typeof config?.index === 'string' && config.index !== '' ? config.index : undefined

  let sqliteModule = null
  let db = null

  /** Open (once) and probe the derived index read-only. */
  async function openDb() {
    if (indexPath === undefined) return null
    if (db !== null) return db
    try {
      sqliteModule ??= await import('node:sqlite')
      try {
        db = new sqliteModule.DatabaseSync(indexPath, { readOnly: true, timeout: 3000 })
      } catch {
        db = new sqliteModule.DatabaseSync(indexPath, { readOnly: true })
      }
      db.prepare('SELECT 1 FROM persisted_docs LIMIT 1').get()
      return db
    } catch {
      // Not created yet, engine disabled, or mid-rebuild: this search falls
      // back to whatever the engine itself can answer.
      try { db?.close() } catch { /* already closed */ }
      db = null
      return null
    }
  }

  /**
   * Literal substring search over the durable index, grouped to the
   * strongest matching event per session, ranked like the engine: match
   * count descending, document length ascending, then time/session/seq.
   */
  async function substringSearch(request, exec) {
    const query = request.query.trim()
    if (query === '' || query.includes('\0')) return engine.searchSessions(request, exec)
    const filters = scanFilters(request)
    if (filters === null || request.sessionFilters !== undefined) {
      return engine.searchSessions(request, exec)
    }

    const limit = Math.min(Math.max(
      Number.isInteger(request.limit) && request.limit > 0 ? request.limit : DEFAULT_LIMIT, 1), MAX_LIMIT)
    let offset = 0
    if (request.cursor !== undefined) {
      offset = decodeCursor(request.cursor)
      if (offset === null) return { items: [] }
    }

    // Keep the durable index fresh: the engine reconciles new and changed
    // session logs during its own search pass. Errors are swallowed here on
    // purpose — a disabled or busy engine must not hide the fallback.
    try { await engine.searchSessions({ ...request, cursor: undefined, limit: 1 }, exec) } catch { /* best effort */ }
    if (exec?.signal?.aborted) return { items: [] }

    const handle = await openDb()
    if (handle === null) return { items: [] }

    const params = [query, query, query, query, `%${escapeLike(query)}%`]
    let sql = `
      WITH matched AS (
        SELECT session_id AS sid, seq, type, time, surface, codepoint_length AS cpl,
               instr(text, ?) AS pos,
               (length(text) - length(replace(text, ?, ''))) / max(length(?), 1) AS occ,
               substr(text, max(1, instr(text, ?) - 90), 320) AS win
        FROM persisted_docs
        WHERE text LIKE ? ESCAPE '\\'`
    if (filters.types !== null) {
      sql += ` AND type IN (${filters.types.map(() => '?').join(',')})`
      params.push(...filters.types)
    }
    if (filters.surfaces !== null) {
      sql += ` AND surface IN (${filters.surfaces.map(() => '?').join(',')})`
      params.push(...filters.surfaces)
    }
    sql += `
      ), ranked AS (
        SELECT *, row_number() OVER (
          PARTITION BY sid ORDER BY occ DESC, cpl ASC, time DESC, seq DESC
        ) AS rn
        FROM matched
      )
      SELECT r.sid, r.seq, r.type, r.time, r.surface, r.occ, r.pos, r.win,
             p.cwd, p.version, p.created_at, p.parent_session
      FROM ranked r
      LEFT JOIN persisted_sessions p ON p.id = r.sid
      WHERE r.rn = 1
      ORDER BY r.occ DESC, r.cpl ASC, r.time DESC, r.sid ASC, r.seq DESC
      LIMIT ? OFFSET ?`
    params.push(limit + 1, offset)

    let rows
    try {
      rows = handle.prepare(sql).all(...params)
    } catch (error) {
      logger.warn('substring scan failed: %s', String(error))
      return { items: [] }
    }
    if (exec?.signal?.aborted) return { items: [] }

    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map((row) => ({
      header: {
        id: row.sid,
        ...(row.version !== null && row.version !== undefined ? { version: row.version } : {}),
        ...(row.created_at !== null && row.created_at !== undefined ? { createdAt: row.created_at } : {}),
        ...(row.cwd !== null && row.cwd !== undefined ? { cwd: row.cwd } : {}),
        ...(row.parent_session !== null && row.parent_session !== undefined ? { parentSessionId: row.parent_session } : {}),
      },
      live: false,
      persisted: true,
      bestMatch: {
        sessionId: row.sid,
        seq: row.seq,
        type: row.type,
        time: row.time,
        surface: row.surface,
        snippet: buildSnippet(String(row.win ?? '')),
      },
    }))
    return hasMore ? { items, nextCursor: encodeCursor(offset + limit) } : { items }
  }

  /** The wrapped provider surface: CJK queries take the scan, the rest pass through. */
  const wrappedSearch = async (request, exec) => {
    if (typeof request?.query === 'string' && CJK_RE.test(request.query)) {
      try {
        return await substringSearch(request, exec)
      } catch (error) {
        logger.warn('CJK substring fallback failed, deferring to engine: %s', String(error))
      }
    }
    return engine.searchSessions(request, exec)
  }

  const proxy = new Proxy(engine, {
    get(target, property) {
      if (property === 'searchSessions') return wrappedSearch
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  ctx.provide('sessionQuery', proxy)

  ctx.on('dispose', () => {
    try { db?.close() } catch { /* already closed */ }
    db = null
  })
}
