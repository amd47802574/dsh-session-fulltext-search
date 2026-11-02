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
 * 2. This node half patches the mounted sessionQuery ENGINE INSTANCE: it
 *    assigns an own `searchSessions` property over the prototype method, so
 *    every consumer holding the service — the host api-proxy resolves
 *    ctx.get('sessionQuery') per request — calls the wrapper. (A second
 *    ctx.provide for the same service name is rejected by cordis, so
 *    re-providing a proxy is not an option.) The FTS5 `unicode61` tokenizer
 *    treats a run of continuous CJK text as ONE token, so a Chinese phrase
 *    that does not start and end at a token boundary never matches —
 *    "已保研至福州大学" is a single token, and the query "福州大学" is not
 *    equal to it. For queries containing CJK the wrapper runs a literal
 *    substring scan over the same derived index (LIKE), which is a superset
 *    of the tokenizer's phrase recall, and fabricates the engine's
 *    SessionSearchHit shape so every existing consumer — the sidebar RPC
 *    projection, the session-query tool — keeps working.
 *
 * Non-CJK queries pass through to the engine untouched, as does every other
 * engine method (exact reads, traces, within-session search, filters). When
 * the scan cannot run (index missing or rebuilding, unsupported filters) the
 * wrapper defers to the engine rather than returning an empty page.
 *
 * No dependencies: node:sqlite is built into the Node runtime the host
 * already requires. The second connection opens the derived index read-only;
 * WAL mode lets it read while the owning engine writes.
 *
 * @module dsh-session-fulltext-search
 */

import { existsSync } from 'node:fs'

/** Cordis plugin name, for loader diagnostics. */
export const name = 'dsh-session-fulltext-search'

/** Wait for the engine service so the patch captures the live instance. */
export const inject = ['sessionQuery']

/** CJK scripts the tokenizer cannot phrase-match inside continuous text. */
const CJK_RE = /[\u3040-\u30FF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/

/** Wire bound shared with the host projection (Unicode code points). */
const SNIPPET_MAX_CODE_POINTS = 240

/** Engine contract defaults: page size and the largest accepted page. */
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

/** Largest sane already-emitted session count we will resume from. */
const MAX_OFFSET = 1_000_000

/** Prefix branding our opaque offset cursors. */
const CURSOR_PREFIX = 'sfs1.'

/** @param {number} offset - zero-based count of sessions already emitted. */
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
 * Regex for context-injection envelopes (workspace instructions, skill
 * catalogs, runtime facts) that DSH prepends to user messages. Their text is
 * mechanically repeated in every session of a workspace, so matching inside
 * them drowns real conversation content in noise.
 */
const INJECTION_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g

/** Count non-overlapping substring occurrences outside injection envelopes. */
function countOutsideInjections(haystack, needle) {
  let count = 0
  let cursor = 0
  INJECTION_RE.lastIndex = 0
  while (cursor < haystack.length) {
    const match = INJECTION_RE.exec(haystack)
    const end = match === null ? haystack.length : match.index
    const slice = haystack.slice(cursor, end)
    let from = slice.indexOf(needle)
    while (from !== -1) {
      count++
      from = slice.indexOf(needle, from + needle.length)
    }
    cursor = match === null ? haystack.length : match.index + match[0].length
  }
  return count
}

/** Window of `radius` chars around the first non-injection occurrence, or null. */
function windowOutsideInjections(haystack, needle, radius = 150) {
  let cursor = 0
  INJECTION_RE.lastIndex = 0
  while (cursor < haystack.length) {
    const match = INJECTION_RE.exec(haystack)
    const end = match === null ? haystack.length : match.index
    const slice = haystack.slice(cursor, end)
    const at = slice.indexOf(needle)
    if (at !== -1) {
      const absolute = cursor + at
      return haystack.slice(Math.max(0, absolute - radius), absolute + needle.length + radius)
    }
    cursor = match === null ? haystack.length : match.index + match[0].length
  }
  return null
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
 * Mount the plugin: capture the engine, patch its search method in place.
 * @param ctx - cordis context with `sessionQuery` injected.
 * @param config - row config; `index` is the derived-index path.
 */
export function apply(ctx, config) {
  const engine = ctx.sessionQuery
  const logger = ctx.logger('dsh-session-fulltext-search')
  const indexPath = typeof config?.index === 'string' && config.index !== '' ? config.index : undefined

  // The engine's original cross-session search (prototype method), used for
  // pass-through, index-freshness pokes, and scan-failure fallbacks. Calling
  // engine.searchSessions directly here would recurse into the patch.
  const engineSearch = engine.searchSessions.bind(engine)

  let sqliteModule = null
  let db = null

  /** Open (once) and probe the derived index read-only. */
  async function openDb() {
    if (indexPath === undefined || !existsSync(indexPath)) return null
    if (db !== null) return db
    try {
      sqliteModule ??= await import('node:sqlite')
      try {
        db = new sqliteModule.DatabaseSync(indexPath, { readOnly: true, timeout: 3000 })
      } catch {
        db = new sqliteModule.DatabaseSync(indexPath)
      }
      // Belt over read-only opens on runtimes that ignore the option.
      try { db.exec('PRAGMA query_only = true') } catch { /* best effort */ }
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
   * Returns null when the scan cannot serve this request.
   */
  async function scanIndex(request, exec) {
    const query = request.query.trim()
    if (query === '' || query.includes('\0')) return null
    const filters = scanFilters(request)
    if (filters === null || request.sessionFilters !== undefined) return null

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
    try { await engineSearch({ ...request, cursor: undefined, limit: 1 }, exec) } catch { /* best effort */ }
    if (exec?.signal?.aborted) return null

    const handle = await openDb()
    if (handle === null) return null

    // SQL narrows candidates by LIKE; the precise pass runs in JS below,
    // stripping <system-reminder> injection envelopes before counting and
    // excerpting. All candidate rows are fetched in one pass — the LIKE scan
    // dominates cost either way, and session-grouped pagination needs the
    // full row set to keep row-offset cursors aligned with emitted sessions.
    const params = [`%${escapeLike(query)}%`]
    let sql = `
      WITH matched AS (
        SELECT session_id AS sid, seq, type, time, surface, codepoint_length AS cpl, text
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
      )
      SELECT r.sid, r.seq, r.type, r.time, r.surface, r.cpl, r.text,
             p.cwd, p.version, p.created_at, p.parent_session
      FROM matched r
      LEFT JOIN persisted_sessions p ON p.id = r.sid
      ORDER BY r.time DESC, r.sid ASC, r.seq DESC
      LIMIT ?`
    // `offset` counts already-emitted SESSIONS (not rows); cap the scan so a
    // pathological needle cannot pull unbounded rows in one statement.
    const SCAN_ROW_CAP = 5000
    params.push(SCAN_ROW_CAP)

    let rows
    try {
      rows = handle.prepare(sql).all(...params)
    } catch (error) {
      logger.warn('substring scan failed: %s', String(error))
      return null
    }
    if (exec?.signal?.aborted) return null

    // Per-session strongest surviving event, ranked like the engine: match
    // count (outside injections) descending, doc length ascending, then time.
    const best = new Map()
    for (const row of rows) {
      const occ = countOutsideInjections(String(row.text ?? ''), query)
      if (occ === 0) continue
      const prev = best.get(row.sid)
      if (prev === undefined
        || occ > prev.occ
        || (occ === prev.occ && (row.cpl ?? 0) < (prev.cpl ?? Number.MAX_SAFE_INTEGER))) {
        best.set(row.sid, { row, occ })
      }
    }
    const ranked = [...best.entries()]
      .map(([sid, { row, occ }]) => ({ sid, row, occ }))
      .sort((a, b) => b.occ - a.occ
        || (a.row.cpl ?? 0) - (b.row.cpl ?? 0)
        || b.row.time - a.row.time
        || (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0))
    // Session-count cursor: `offset` is the number of already-emitted ranked
    // sessions, so every page slices the same deterministic ranking.
    const page = ranked.slice(offset, offset + limit)
    const hasMore = offset + limit < ranked.length
    const items = page.map(({ row, occ }) => ({
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
        snippet: buildSnippet(windowOutsideInjections(String(row.text ?? ''), query) ?? ''),
      },
    }))
    return hasMore ? { items, nextCursor: encodeCursor(offset + limit) } : { items }
  }

  /** The patched method: CJK queries take the scan, the rest pass through. */
  const wrappedSearch = async (request, exec) => {
    if (typeof request?.query === 'string' && CJK_RE.test(request.query)) {
      try {
        const page = await scanIndex(request, exec)
        if (page !== null) return page
      } catch (error) {
        logger.warn('CJK substring fallback failed, deferring to engine: %s', String(error))
      }
    }
    return engineSearch(request, exec)
  }

  // Own-property patch over the prototype method; every consumer that
  // resolves the service instance sees the wrapper.
  engine.searchSessions = wrappedSearch

  // Cleanup via a fiber effect, not the return value: a plain `export
  // function apply` is constructable, so cordis loads it through the class
  // branch (`new callback(ctx, config)`) where a returned disposer is read
  // as `instance[init]()` and silently dropped. A fiber effect is collected
  // on this plugin's own fiber and runs when it unloads either way.
  ctx.fiber.effect(() => () => {
    if (engine.searchSessions === wrappedSearch) delete engine.searchSessions
    try { db?.close() } catch { /* already closed */ }
    db = null
  })
}
