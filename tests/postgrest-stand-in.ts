/**
 * In-memory PostgREST used only by the lead-notification tests.
 *
 * The query shapes it accepts are the ones @supabase/postgrest-js@2.119.2
 * (the client resolved by the unpinned `npm:@supabase/supabase-js@2` import
 * in the edge functions) actually sends:
 * - GET/POST/PATCH filters as `column=eq.value`, `column=is.null`, `column=in.(a,b)`
 * - `.maybeSingle()` left as a JSON array so the client unwraps 0 or 1 rows
 * - `.single()` as one JSON object when Accept is application/vnd.pgrst.object+json
 * - upsert Prefer resolution=ignore-duplicates|merge-duplicates plus on_conflict
 * - rpc POST /rest/v1/rpc/<fn>
 */

export type Row = Record<string, unknown>

export interface EmailQueueMessage {
  msg_id: number
  read_ct: number
  message: Record<string, unknown>
}

export interface StandInState {
  tables: Record<string, Row[]>
  queues: Record<string, EmailQueueMessage[]>
  nextMsgId: number
}

const RESERVED_PARAMS = new Set(["select", "on_conflict", "columns", "order", "offset", "limit"])

export function createState(): StandInState {
  return {
    tables: {
      suppressed_emails: [],
      email_unsubscribe_tokens: [],
      email_send_log: [],
      email_send_state: [
        {
          id: 1,
          retry_after_until: null,
          batch_size: 10,
          send_delay_ms: 0,
          auth_email_ttl_minutes: 15,
          transactional_email_ttl_minutes: 60,
        },
      ],
    },
    queues: {
      auth_emails: [],
      transactional_emails: [],
      auth_emails_dlq: [],
      transactional_emails_dlq: [],
    },
    nextMsgId: 1,
  }
}

function project(row: Row, select: string | null): Row {
  if (!select || select.trim() === "*") return { ...row }
  const columns = select.split(",").map((column) => column.trim()).filter(Boolean)
  const projected: Row = {}
  for (const column of columns) {
    projected[column] = row[column]
  }
  return projected
}

function matches(row: Row, filters: Array<[string, string]>): boolean {
  return filters.every(([column, expression]) => {
    const value = row[column]
    if (expression.startsWith("eq.")) {
      return String(value) === expression.slice(3)
    }
    if (expression.startsWith("is.")) {
      const expected = expression.slice(3)
      if (expected === "null") return value === null || value === undefined
      if (expected === "true") return value === true
      if (expected === "false") return value === false
      return false
    }
    if (expression.startsWith("in.(") && expression.endsWith(")")) {
      const items = expression.slice(4, -1).split(",").filter((item) => item.length > 0)
      return items.includes(String(value))
    }
    throw new Error(`PostgREST stand-in does not implement filter ${column}=${expression}`)
  })
}

function filtersFrom(url: URL): Array<[string, string]> {
  const filters: Array<[string, string]> = []
  url.searchParams.forEach((value, key) => {
    if (!RESERVED_PARAMS.has(key)) filters.push([key, value])
  })
  return filters
}

function prefer(req: Request): string {
  return req.headers.get("Prefer") ?? ""
}

function wantsObject(req: Request): boolean {
  return (req.headers.get("Accept") ?? "").includes("application/vnd.pgrst.object+json")
}

function json(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function empty(status: number): Response {
  return new Response(null, { status })
}

type BodyRequest = { method: string; url: string; headers: Headers; jsonBody: unknown }

export async function handlePostgrest(state: StandInState, req: Request): Promise<Response> {
  const url = new URL(req.url)
  if (url.pathname === "/test/state") {
    return json({
      tables: state.tables,
      queues: state.queues,
    })
  }
  if (url.pathname === "/test/reset" && req.method === "POST") {
    const fresh = createState()
    state.tables = fresh.tables
    state.queues = fresh.queues
    state.nextMsgId = fresh.nextMsgId
    return json({ ok: true })
  }

  const restPrefix = "/rest/v1/"
  if (!url.pathname.startsWith(restPrefix)) {
    return json({ message: `unexpected path ${url.pathname}` }, 404)
  }
  const restPath = url.pathname.slice(restPrefix.length)
  let jsonBody: unknown = undefined
  if (req.method !== "GET" && req.method !== "HEAD") {
    const text = await req.text()
    jsonBody = text ? JSON.parse(text) : undefined
  }
  const bodyReq: BodyRequest = { method: req.method, url: req.url, headers: req.headers, jsonBody }

  if (restPath.startsWith("rpc/")) {
    return handleRpc(state, restPath.slice(4), bodyReq.jsonBody as Record<string, unknown>)
  }

  const table = restPath
  if (!state.tables[table]) state.tables[table] = []
  const rows = state.tables[table]
  const filters = filtersFrom(url)

  if (req.method === "GET") {
    const found = rows.filter((row) => matches(row, filters)).map((row) => project(row, url.searchParams.get("select")))
    if (wantsObject(req)) {
      if (found.length !== 1) {
        return json(
          {
            code: "PGRST116",
            details: `The result contains ${found.length} rows`,
            hint: null,
            message: "JSON object requested, multiple (or no) rows returned",
          },
          406,
        )
      }
      return json(found[0])
    }
    return json(found)
  }

  if (req.method === "POST") {
    return handleWrite(table, rows, url, bodyReq, filters)
  }

  if (req.method === "PATCH") {
    const body = bodyReq.jsonBody as Row
    const updated = rows.filter((row) => matches(row, filters))
    for (const row of updated) Object.assign(row, body)
    const projected = updated.map((row) => project(row, url.searchParams.get("select")))
    if (prefer(req).includes("return=representation") || wantsObject(req)) {
      return json(projected)
    }
    return empty(204)
  }

  return json({ message: `method ${req.method} not implemented for ${table}` }, 405)
}

function handleWrite(
  table: string,
  rows: Row[],
  url: URL,
  req: BodyRequest,
  filters: Array<[string, string]>,
): Response {
  const header = prefer(req as unknown as Request)
  const body = req.jsonBody as Row | Row[]
  const incoming = Array.isArray(body) ? body : [body]
  const conflict = url.searchParams.get("on_conflict")
  const ignore = header.includes("resolution=ignore-duplicates")

  if (conflict) {
    for (const item of incoming) {
      const keys = conflict.split(",").map((key) => key.trim())
      const existing = rows.find((row) => keys.every((key) => String(row[key]) === String(item[key])))
      if (!existing) {
        rows.push({ id: crypto.randomUUID(), ...item })
      } else if (!ignore) {
        Object.assign(existing, item)
      }
    }
  } else {
    for (const item of incoming) {
      rows.push({ id: crypto.randomUUID(), ...item })
    }
  }

  if (header.includes("return=representation")) {
    const found = rows.filter((row) => matches(row, filters))
    return json(found.map((row) => project(row, url.searchParams.get("select"))))
  }
  return empty(201)
}

function handleRpc(state: StandInState, fn: string, args: Record<string, unknown>): Response {
  if (fn === "enqueue_email") {
    const queueName = String(args.queue_name)
    if (!state.queues[queueName]) state.queues[queueName] = []
    const msgId = state.nextMsgId++
    state.queues[queueName].push({
      msg_id: msgId,
      read_ct: 0,
      message: args.payload as Record<string, unknown>,
    })
    return json(msgId)
  }
  if (fn === "read_email_batch") {
    const queueName = String(args.queue_name)
    const batchSize = Number(args.batch_size ?? 10)
    const queue = state.queues[queueName] ?? []
    const batch = queue.slice(0, batchSize)
    for (const message of batch) message.read_ct += 1
    return json(batch.map((message) => ({ ...message })))
  }
  if (fn === "delete_email") {
    const queueName = String(args.queue_name)
    const messageId = Number(args.message_id)
    const queue = state.queues[queueName] ?? []
    const index = queue.findIndex((message) => message.msg_id === messageId)
    if (index >= 0) queue.splice(index, 1)
    return json(index >= 0)
  }
  if (fn === "move_to_dlq") {
    const source = String(args.source_queue)
    const dlq = String(args.dlq_name)
    const messageId = Number(args.message_id)
    if (!state.queues[dlq]) state.queues[dlq] = []
    const msgId = state.nextMsgId++
    state.queues[dlq].push({
      msg_id: msgId,
      read_ct: 0,
      message: (args.payload as Record<string, unknown>) ?? {},
    })
    const queue = state.queues[source] ?? []
    const index = queue.findIndex((message) => message.msg_id === messageId)
    if (index >= 0) queue.splice(index, 1)
    return json(msgId)
  }
  return json({ message: `unknown rpc ${fn}` }, 404)
}

export function startStandIn(port: number): { state: StandInState; stop: () => Promise<void> } {
  const state = createState()
  const server = Deno.serve({ port, hostname: "127.0.0.1", onListen() {} }, (req) => handlePostgrest(state, req))
  return {
    state,
    stop: () => server.shutdown(),
  }
}
