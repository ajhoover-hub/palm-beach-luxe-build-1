// Spec for the shared email-queue cooldown. These tests fail while the
// vulnerability is present and pass once it is fixed.
//
// Contract:
// 1. HTTP 429 from the email provider applies only to the message that was
//    limited. The worker still delivers every other message it already claimed
//    in that run, on both auth_emails and transactional_emails, when the
//    provider accepts those messages.
// 2. A retry_after_until value recorded from a 429 must not stop a later run
//    from delivering mail the provider would accept on either queue. Only the
//    message that was limited waits.
// 3. send-transactional-email allows at most 8 successful enqueues per caller
//    per rolling 60_000 ms. The caller is the first hop of x-forwarded-for
//    (split on ",", trim, skip empty). A missing or blank header shares one
//    bucket named "anonymous". The 9th enqueue is HTTP 429 and does not insert
//    a pending email_send_log row and does not call enqueue_email. Another
//    caller is unaffected. Contact, Style Book, notification, and confirmation
//    templates share the same bucket. Rotating recipientEmail does not.
//
// Run:
//   deno test --config=supabase/functions/email-queue-outage.deno.json \
//     --allow-env --allow-net \
//     supabase/functions/email-queue-outage.test.ts

import { assert, assertEquals } from 'jsr:@std/assert@1'
import { createClient, getStore, resetStore } from './email-queue-outage.memory.ts'

const MAX_ENQUEUES_PER_CALLER = 8
const OFFICE = 'aj@bmbpalmbeach.com'

type Handler = (req: Request) => Promise<Response> | Response

const captured: Handler[] = []
Deno.serve = ((...args: unknown[]) => {
  const handler = args.find((value) => typeof value === 'function') as Handler
  captured.push(handler)
  return {
    finished: Promise.resolve(),
    shutdown: () => Promise.resolve(),
    ref() {},
    unref() {},
  }
}) as typeof Deno.serve

const deliveredKeys: string[] = []

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url === 'https://api.lovable.dev/v1/messaging/email/prepare-uploads') {
    return new Response(null, { status: 204 })
  }
  if (url === 'https://api.lovable.dev/v1/messaging/email/send') {
    const body = JSON.parse(String(init?.body ?? '{}')) as { idempotency_key?: string }
    const key = body.idempotency_key ?? ''
    if (key.startsWith('flood-')) {
      return new Response(JSON.stringify({ type: 'rate_limited', message: 'slow down' }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '60' },
      })
    }
    deliveredKeys.push(key)
    return new Response(JSON.stringify({ id: 'provider-accepted' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  throw new Error(`blocked outbound request to ${url}`)
}) as typeof fetch

await import('./process-email-queue/index.ts')
await import('./send-transactional-email/index.ts')

const processQueue = captured[0]
const sendTransactional = captured[1]
if (!processQueue || !sendTransactional || captured.length !== 2) {
  throw new Error(`expected two edge handlers, captured ${captured.length}`)
}

Deno.env.set('LOVABLE_API_KEY', 'test-lovable-api-key')
Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:54321')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key')

function b64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}

function serviceRoleAuthorization(): string {
  return `Bearer ${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ role: 'service_role' })}.test-signature`
}

function contactBody(idempotencyKey: string, templateName = 'contact-notification') {
  return {
    templateName,
    idempotencyKey,
    templateData: {
      fullName: 'Ada Inquiry',
      email: 'ada@example.com',
      phone: '555-0100',
      message: 'A real project inquiry already waiting.',
      projectType: 'Renovation',
      timeline: '6-12 months',
      ownsLot: 'Yes',
      investmentRange: '$1M–$5M',
    },
  }
}

function styleBookBody(idempotencyKey: string, recipientEmail?: string) {
  return {
    templateName: recipientEmail ? 'style-book-confirmation' : 'style-book-notification',
    recipientEmail,
    idempotencyKey,
    templateData: {
      fullName: 'Grace Reader',
      firstName: 'Grace',
      email: recipientEmail ?? 'grace@example.com',
      phone: '555-0101',
      style: 'Anglo-Caribbean',
      message: 'Style book request.',
    },
  }
}

async function enqueue(body: Record<string, unknown>, forwardedFor?: string): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json', authorization: 'Bearer test-anon-key' })
  if (forwardedFor !== undefined) headers.set('x-forwarded-for', forwardedFor)
  return await sendTransactional(
    new Request('http://127.0.0.1/functions/v1/send-transactional-email', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  )
}

async function runWorker(): Promise<{ status: number; body: Record<string, unknown> }> {
  const state = getStore().tables.email_send_state[0]
  state.send_delay_ms = 0
  const response = await processQueue(
    new Request('http://127.0.0.1/functions/v1/process-email-queue', {
      method: 'POST',
      headers: { authorization: serviceRoleAuthorization() },
    }),
  )
  return { status: response.status, body: await response.json() }
}

function transactionalIds(): string[] {
  return (getStore().queues.get('transactional_emails') ?? []).map((message) =>
    String(message.message.idempotency_key ?? '')
  )
}

function pendingCount(): number {
  return getStore().tables.email_send_log.filter((row) => row.status === 'pending').length
}

Deno.test('429 on one transactional message still delivers the inquiry already claimed in that batch', async () => {
  resetStore()
  deliveredKeys.length = 0

  const flood = await enqueue(contactBody('flood-batch'))
  const inquiry = await enqueue(contactBody('inquiry-batch'))
  assertEquals(flood.status, 200)
  assertEquals(inquiry.status, 200)
  assertEquals(transactionalIds(), ['flood-batch', 'inquiry-batch'])

  const run = await runWorker()
  assertEquals(run.status, 200, JSON.stringify(run.body))
  assert(
    deliveredKeys.includes('inquiry-batch'),
    `inquiry stayed queued after a 429 on an earlier message in the same batch: ${JSON.stringify(run.body)} delivered=${JSON.stringify(deliveredKeys)} stillQueued=${JSON.stringify(transactionalIds())}`,
  )
  assert(
    !deliveredKeys.includes('flood-batch'),
    'the message the provider limited must not be recorded as sent',
  )
})

Deno.test('429 on the auth queue still delivers a contact inquiry in the same run', async () => {
  resetStore()
  deliveredKeys.length = 0

  const { error } = await createClient().rpc('enqueue_email', {
    queue_name: 'auth_emails',
    payload: {
      message_id: 'login-flood',
      to: 'member@example.com',
      from: 'Beau Monde Builders <noreply@bmbpalmbeach.com>',
      sender_domain: 'notify.bmbpalmbeach.com',
      subject: 'Your sign-in code',
      html: '<p>code</p>',
      text: 'code',
      purpose: 'transactional',
      label: 'sign_in_otp',
      idempotency_key: 'flood-auth',
      queued_at: new Date().toISOString(),
    },
  })
  assertEquals(error, null)

  const inquiry = await enqueue(styleBookBody('inquiry-stylebook'))
  assertEquals(inquiry.status, 200)
  assertEquals((await inquiry.json()).queued, true)

  const run = await runWorker()
  assertEquals(run.status, 200, JSON.stringify(run.body))
  assert(
    deliveredKeys.includes('inquiry-stylebook'),
    `style book inquiry was not delivered after auth-queue 429: ${JSON.stringify(run.body)} delivered=${JSON.stringify(deliveredKeys)}`,
  )
  assertEquals(
    (getStore().queues.get('transactional_emails') ?? []).some((message) =>
      message.message.idempotency_key === 'inquiry-stylebook' && message.message.to === OFFICE
    ),
    false,
    'the style book notification should have left the queue once the provider accepted it',
  )
})

Deno.test('a recorded cooldown does not stop the next run from delivering either queue', async () => {
  resetStore()
  deliveredKeys.length = 0

  const flood = await enqueue(contactBody('flood-refresh'))
  assertEquals(flood.status, 200)
  const first = await runWorker()
  assertEquals(first.status, 200, JSON.stringify(first.body))
  assert(!deliveredKeys.includes('flood-refresh'))

  const cooldown = getStore().tables.email_send_state[0].retry_after_until
  if (typeof cooldown === 'string') {
    assert(
      new Date(cooldown).getTime() > Date.now(),
      'a cooldown written by the 429 path has to be in the future',
    )
  }

  const inquiry = await enqueue(contactBody('inquiry-during-cooldown'))
  assertEquals(inquiry.status, 200)
  const { error } = await createClient().rpc('enqueue_email', {
    queue_name: 'auth_emails',
    payload: {
      message_id: 'login-during-cooldown',
      to: 'member@example.com',
      from: 'Beau Monde Builders <noreply@bmbpalmbeach.com>',
      sender_domain: 'notify.bmbpalmbeach.com',
      subject: 'Your sign-in code',
      html: '<p>code</p>',
      text: 'code',
      purpose: 'transactional',
      label: 'sign_in_otp',
      idempotency_key: 'login-during-cooldown',
      queued_at: new Date().toISOString(),
    },
  })
  assertEquals(error, null)

  const second = await runWorker()
  assertEquals(second.status, 200, JSON.stringify(second.body))
  assert(
    deliveredKeys.includes('inquiry-during-cooldown'),
    `contact inquiry queued during cooldown was not delivered: ${JSON.stringify(second.body)} delivered=${JSON.stringify(deliveredKeys)} cooldown=${String(cooldown)}`,
  )
  assert(
    deliveredKeys.includes('login-during-cooldown'),
    `login email queued during cooldown was not delivered: ${JSON.stringify(second.body)} delivered=${JSON.stringify(deliveredKeys)} cooldown=${String(cooldown)}`,
  )
})

Deno.test('one public caller cannot fill the transactional queue', async () => {
  resetStore()
  const caller = '203.0.113.10'

  for (let i = 1; i <= MAX_ENQUEUES_PER_CALLER; i++) {
    const response = await enqueue(contactBody(`caller-a-${i}`), caller)
    assertEquals(response.status, 200, `enqueue ${i} should be inside the per-caller budget`)
    await response.json()
  }
  assertEquals(transactionalIds().length, MAX_ENQUEUES_PER_CALLER)
  const pendingBefore = pendingCount()

  const blocked = await enqueue(
    styleBookBody('caller-a-over', 'rotated-recipient@example.com'),
    `${caller}, 10.0.0.8`,
  )
  assertEquals(blocked.status, 429, 'the next enqueue from the same caller has to be refused')
  assertEquals(transactionalIds().length, MAX_ENQUEUES_PER_CALLER, 'a refused enqueue must not add a queue message')
  assertEquals(pendingCount(), pendingBefore, 'a refused enqueue must not write a pending send log')

  const other = await enqueue(contactBody('caller-b-1'), '203.0.113.11')
  assertEquals(other.status, 200, 'a different caller can still enqueue while the first caller is limited')
  await other.json()
  assertEquals(transactionalIds().length, MAX_ENQUEUES_PER_CALLER + 1)

  // The budget is a rolling minute, not a lifetime cap. This sleep runs only
  // after the refusal above, so the vulnerable build still fails before it.
  await new Promise((resolve) => setTimeout(resolve, 61_000))
  const afterWindow = await enqueue(contactBody('caller-a-after-window'), caller)
  assertEquals(afterWindow.status, 200, 'the same caller can enqueue again once the 60s window has elapsed')
  await afterWindow.json()
  assert(transactionalIds().includes('caller-a-after-window'))

  for (let i = 1; i <= MAX_ENQUEUES_PER_CALLER; i++) {
    const response = await enqueue(contactBody(`anon-${i}`))
    assertEquals(response.status, 200, `anonymous enqueue ${i} should be inside that bucket`)
    await response.json()
  }
  const anonPending = pendingCount()
  const anonQueued = transactionalIds().length
  const anonBlocked = await enqueue(styleBookBody('anon-over'))
  assertEquals(anonBlocked.status, 429, 'requests with no x-forwarded-for share one limited bucket')
  assertEquals(transactionalIds().length, anonQueued)
  assertEquals(pendingCount(), anonPending)
})
