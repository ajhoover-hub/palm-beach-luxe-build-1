// In-memory stand-in for the subset of @supabase/supabase-js createClient that
// process-email-queue and send-transactional-email actually call.
//
// Return shape matches @supabase/postgrest-js 2.91.0 PostgrestBuilder.then
// (the version locked in package-lock.json): queries resolve to
// { data, error } and do not throw unless throwOnError is set. These
// functions never set throwOnError.
//
// Queue RPCs follow supabase/migrations/20260603215630_email_infra.sql:
//   enqueue_email -> pgmq.send(queue_name, payload)
//   read_email_batch -> pgmq.read(queue_name, vt, batch_size) columns
//     msg_id, read_ct, message
//   delete_email -> pgmq.delete(queue_name, message_id)
//   move_to_dlq -> pgmq.send(dlq) then pgmq.delete(source)
// pgmq 1.5.1 (extension version is not pinned in the migration) stores the
// jsonb payload as `message`, defaults read_ct to 0, and read() hides the
// claimed rows until now+vt while incrementing read_ct, ordered by msg_id.

type Row = Record<string, unknown>

export type QueueMessage = {
  msg_id: number
  read_ct: number
  message: Row
  enqueued_at: string
  visibleAt: number
}

type Store = {
  nextMsgId: number
  tables: Record<string, Row[]>
  queues: Map<string, QueueMessage[]>
}

const SEND_LOG_STATUSES = new Set([
  'pending',
  'sent',
  'suppressed',
  'failed',
  'bounced',
  'complained',
  'dlq',
])

let store: Store = emptyStore()

function emptyStore(): Store {
  return {
    nextMsgId: 1,
    tables: {
      email_send_state: [
        {
          id: 1,
          retry_after_until: null,
          batch_size: 10,
          send_delay_ms: 200,
          auth_email_ttl_minutes: 15,
          transactional_email_ttl_minutes: 60,
          updated_at: new Date().toISOString(),
        },
      ],
      email_send_log: [],
      suppressed_emails: [],
      email_unsubscribe_tokens: [],
    },
    queues: new Map(),
  }
}

export function resetStore(): void {
  store = emptyStore()
}

export function getStore(): Store {
  return store
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function queueOf(name: string): QueueMessage[] {
  let queue = store.queues.get(name)
  if (!queue) {
    queue = []
    store.queues.set(name, queue)
  }
  return queue
}

function pgmqSend(queueName: string, payload: Row): number {
  const msgId = store.nextMsgId++
  const now = Date.now()
  queueOf(queueName).push({
    msg_id: msgId,
    read_ct: 0,
    message: clone(payload),
    enqueued_at: new Date(now).toISOString(),
    visibleAt: now,
  })
  return msgId
}

function pgmqRead(queueName: string, vtSeconds: number, batchSize: number) {
  const now = Date.now()
  const claimed = queueOf(queueName)
    .filter((message) => message.visibleAt <= now)
    .sort((a, b) => a.msg_id - b.msg_id)
    .slice(0, batchSize)

  for (const message of claimed) {
    message.read_ct += 1
    message.visibleAt = now + vtSeconds * 1000
  }

  return claimed.map((message) => ({
    msg_id: message.msg_id,
    read_ct: message.read_ct,
    message: clone(message.message),
  }))
}

function pgmqDelete(queueName: string, msgId: number): boolean {
  const queue = queueOf(queueName)
  const index = queue.findIndex((message) => message.msg_id === msgId)
  if (index === -1) return false
  queue.splice(index, 1)
  return true
}

class Query {
  private mode: 'select' | 'insert' | 'update' | 'upsert' = 'select'
  private filters: Array<(row: Row) => boolean> = []
  private patch: Row | null = null
  private incoming: Row | null = null
  private upsertOptions: { onConflict?: string; ignoreDuplicates?: boolean } = {}
  private cardinality: 'many' | 'single' | 'maybe' = 'many'

  constructor(private readonly table: string) {}

  select(): this {
    this.mode = 'select'
    return this
  }

  insert(row: Row): this {
    this.mode = 'insert'
    this.incoming = row
    return this
  }

  update(row: Row): this {
    this.mode = 'update'
    this.patch = row
    return this
  }

  upsert(row: Row, options?: { onConflict?: string; ignoreDuplicates?: boolean }): this {
    this.mode = 'upsert'
    this.incoming = row
    this.upsertOptions = options ?? {}
    return this
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value)
    return this
  }

  in(column: string, values: readonly unknown[]): this {
    const allowed = new Set(values)
    this.filters.push((row) => allowed.has(row[column]))
    return this
  }

  single(): this {
    this.cardinality = 'single'
    return this
  }

  maybeSingle(): this {
    this.cardinality = 'maybe'
    return this
  }

  then<TResult1 = { data: unknown; error: { message: string; code?: string } | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: { message: string; code?: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected)
  }

  private rows(): Row[] {
    const table = store.tables[this.table]
    if (!table) throw new Error(`unexpected table ${this.table}`)
    return table
  }

  private matching(): Row[] {
    return this.rows().filter((row) => this.filters.every((filter) => filter(row)))
  }

  private execute(): { data: unknown; error: { message: string; code?: string } | null } {
    if (this.mode === 'insert' || this.mode === 'upsert') {
      return this.writeIncoming()
    }

    if (this.mode === 'update') {
      for (const row of this.matching()) {
        Object.assign(row, clone(this.patch ?? {}))
      }
      return { data: null, error: null }
    }

    const matched = this.matching()
    if (this.cardinality === 'many') {
      return { data: matched.map((row) => clone(row)), error: null }
    }
    if (matched.length > 1) {
      return {
        data: null,
        error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
      }
    }
    if (matched.length === 1) {
      return { data: clone(matched[0]), error: null }
    }
    if (this.cardinality === 'maybe') {
      return { data: null, error: null }
    }
    return {
      data: null,
      error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
    }
  }

  private writeIncoming(): { data: unknown; error: { message: string; code?: string } | null } {
    const incoming = clone(this.incoming ?? {})
    if (this.table === 'email_send_log') {
      const status = incoming.status
      if (typeof status !== 'string' || !SEND_LOG_STATUSES.has(status)) {
        return {
          data: null,
          error: {
            code: '23514',
            message: 'new row for relation "email_send_log" violates check constraint "email_send_log_status_check"',
          },
        }
      }
      if (status === 'sent') {
        const messageId = incoming.message_id
        const duplicate = this.rows().some(
          (row) => row.status === 'sent' && row.message_id === messageId && messageId != null,
        )
        if (duplicate) {
          return {
            data: null,
            error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_email_send_log_message_sent_unique"' },
          }
        }
      }
    }

    if (this.mode === 'upsert') {
      const conflictColumn = this.upsertOptions.onConflict
      if (conflictColumn) {
        const existing = this.rows().find((row) => row[conflictColumn] === incoming[conflictColumn])
        if (existing) {
          if (!this.upsertOptions.ignoreDuplicates) Object.assign(existing, incoming)
          return { data: null, error: null }
        }
      }
    }

    if (!incoming.id) incoming.id = crypto.randomUUID()
    if (!incoming.created_at) incoming.created_at = new Date().toISOString()
    this.rows().push(incoming)
    return { data: null, error: null }
  }
}

// Typed as any so the edge functions keep the call shape they use with the
// real client (column lists, untyped rpc rows). Runtime behavior is below.
export function createClient(_url?: string, _key?: string): any {
  return {
    from(table: string) {
      return new Query(table)
    },
    rpc(fn: string, args: Record<string, unknown>) {
      if (fn === 'enqueue_email') {
        const msgId = pgmqSend(String(args.queue_name), args.payload as Row)
        return Promise.resolve({ data: msgId, error: null })
      }
      if (fn === 'read_email_batch') {
        const data = pgmqRead(String(args.queue_name), Number(args.vt), Number(args.batch_size))
        return Promise.resolve({ data, error: null })
      }
      if (fn === 'delete_email') {
        const deleted = pgmqDelete(String(args.queue_name), Number(args.message_id))
        return Promise.resolve({ data: deleted, error: null })
      }
      if (fn === 'move_to_dlq') {
        const msgId = pgmqSend(String(args.dlq_name), args.payload as Row)
        pgmqDelete(String(args.source_queue), Number(args.message_id))
        return Promise.resolve({ data: msgId, error: null })
      }
      return Promise.resolve({
        data: null,
        error: { message: `unexpected rpc ${fn}` },
      })
    },
  }
}
