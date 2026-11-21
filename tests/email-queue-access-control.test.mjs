/**
 * Access-control spec for the email queue RPCs.
 *
 * These tests fail while anon and authenticated can execute the four
 * SECURITY DEFINER queue functions, and while those functions accept a
 * caller-chosen queue name. They pass once execute is limited to
 * service_role and each function only touches auth_emails,
 * transactional_emails, and the matching dead-letter queues.
 *
 * Run:
 *   node --test tests/email-queue-access-control.test.mjs
 *
 * Requires local PostgreSQL reachable as `sudo -u postgres psql`, the pgmq
 * 1.5.1 extension, PostgREST 12.2.12 (POSTGREST_BIN or /tmp/postgrest/postgrest),
 * and Deno (DENO_BIN or /tmp/deno-bin/deno).
 *
 * JWT secret, database password, and mail API key below are local placeholders.
 * They are not the project's keys.
 */
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import http from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after, before } from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const migrationPath = resolve(root, 'supabase/migrations/20260603215630_email_infra.sql')
const workerPath = resolve(root, 'supabase/functions/process-email-queue/index.ts')

const DB = 'email_queue_acl_test'
const JWT_SECRET = 'placeholder-jwt-secret-0123456789abcdef'
const DB_PASSWORD = 'placeholder-local-db-password'
const LOVABLE_API_KEY = 'placeholder-lovable-api-key'
const POSTGREST_PORT = 3001
const PROXY_PORT = 3000
const MAIL_PORT = 8765
const WORKER_PORT = 8000

const postgrestBin = process.env.POSTGREST_BIN || '/tmp/postgrest/postgrest'
const denoBin = process.env.DENO_BIN || '/tmp/deno-bin/deno'

let postgrest
let proxy
let mailServer
let worker
const sentMails = []

function signJwt(role) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ role, iss: 'local-test' })).toString('base64url')
  const signature = createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}

const anonJwt = signJwt('anon')
const authenticatedJwt = signJwt('authenticated')
const serviceJwt = signJwt('service_role')

function psql(sql, database = DB) {
  const result = spawnSync(
    'sudo',
    ['-u', 'postgres', 'psql', '-d', database, '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql],
    { encoding: 'utf8' }
  )
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `psql exited ${result.status}`)
  }
  return result.stdout.trim()
}

function psqlFile(path, database = DB) {
  const result = spawnSync(
    'sudo',
    ['-u', 'postgres', 'psql', '-d', database, '-v', 'ON_ERROR_STOP=1', '-f', path],
    { encoding: 'utf8' }
  )
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `psql exited ${result.status}`)
  }
}

function scalar(sql) {
  const out = psql(sql)
  return out.split('\n').filter(Boolean).at(-1) ?? ''
}

async function listen(server, port) {
  server.listen(port, '127.0.0.1')
  await once(server, 'listening')
  return server
}

function startProxy() {
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const path = req.url.replace(/^\/rest\/v1/, '') || '/'
      const headers = { ...req.headers, host: `127.0.0.1:${POSTGREST_PORT}` }
      delete headers['transfer-encoding']
      headers['content-length'] = String(body.length)
      const upstream = http.request(
        {
          hostname: '127.0.0.1',
          port: POSTGREST_PORT,
          method: req.method,
          path,
          headers,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
          upstreamRes.pipe(res)
        }
      )
      upstream.on('error', (error) => {
        res.writeHead(502)
        res.end(error.message)
      })
      upstream.end(body)
    })
  })
  return listen(server, PROXY_PORT)
}

function startMailSink() {
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (req.url.startsWith('/v1/messaging/email/prepare-uploads')) {
        res.writeHead(204)
        res.end()
        return
      }
      let body = raw
      try {
        body = JSON.parse(raw)
      } catch {
        body = raw
      }
      sentMails.push({ url: req.url, body })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: true }))
    })
  })
  return listen(server, MAIL_PORT)
}

async function waitFor(predicate, label) {
  const started = Date.now()
  let last = ''
  while (Date.now() - started < 90000) {
    try {
      if (await predicate()) return
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last}` : ''}`)
}

async function rpc(jwt, fn, args) {
  const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${jwt}`,
      apikey: jwt,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(args),
  })
  const text = await response.text()
  return { status: response.status, text }
}

async function runWorker() {
  const response = await fetch(`http://127.0.0.1:${WORKER_PORT}/`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${serviceJwt}`,
      'content-type': 'application/json',
    },
    body: '{}',
  })
  const text = await response.text()
  return { status: response.status, text }
}

function resetQueues() {
  psql(`
    TRUNCATE
      pgmq.q_auth_emails,
      pgmq.q_transactional_emails,
      pgmq.q_auth_emails_dlq,
      pgmq.q_transactional_emails_dlq;
  `)
  sentMails.length = 0
}

function queueVisible(queue) {
  return Number(scalar(`SELECT count(*) FROM pgmq.q_${queue} WHERE vt <= clock_timestamp()`))
}

function queueExists(queue) {
  return scalar(`SELECT to_regclass('pgmq.q_${queue}')`) !== ''
}

function dropQueue(queue) {
  psql(`
    DO $$ BEGIN
      PERFORM pgmq.drop_queue('${queue}');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END $$;
  `)
}

const attackerPayload = (html) => ({
  to: 'inquiry-person@example.com',
  from: 'Beau Monde Builders <noreply@bmbpalmbeach.com>',
  sender_domain: 'notify.bmbpalmbeach.com',
  subject: 'Your inquiry',
  html,
  text: 'attacker text',
  purpose: 'transactional',
  unsubscribe_token: 'inquiry-unsubscribe-token',
  message_id: `msg-${html}`,
  queued_at: new Date().toISOString(),
})

before(async () => {
  psql(`
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = 'email_queue_acl_test' AND pid <> pg_backend_pid();
  `, 'postgres')
  psql('DROP DATABASE IF EXISTS email_queue_acl_test', 'postgres')
  psql('CREATE DATABASE email_queue_acl_test', 'postgres')
  psql(`
    CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE EXTENSION IF NOT EXISTS pg_net SCHEMA extensions;
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    CREATE EXTENSION IF NOT EXISTS supabase_vault;
    CREATE EXTENSION IF NOT EXISTS pgmq;

    DO $$ BEGIN
      CREATE ROLE anon NOLOGIN NOINHERIT;
    EXCEPTION WHEN duplicate_object THEN
      ALTER ROLE anon NOLOGIN NOINHERIT;
    END $$;
    DO $$ BEGIN
      CREATE ROLE authenticated NOLOGIN NOINHERIT;
    EXCEPTION WHEN duplicate_object THEN
      ALTER ROLE authenticated NOLOGIN NOINHERIT;
    END $$;
    DO $$ BEGIN
      CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
    EXCEPTION WHEN duplicate_object THEN
      ALTER ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
    END $$;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

    -- Same default privileges the Supabase Postgres init script grants the
    -- postgres role on new public functions (supabase/postgres
    -- migrations/db/init-scripts/00000000000000-initial-schema.sql).
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;

    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text
    LANGUAGE sql STABLE
    AS $$
      SELECT nullif(current_setting('request.jwt.claim.role', true), '')::text;
    $$;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
  `)
  psqlFile(migrationPath)
  psql(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
        CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD '${DB_PASSWORD}';
      ELSE
        ALTER ROLE authenticator WITH LOGIN PASSWORD '${DB_PASSWORD}';
      END IF;
    END $$;
    GRANT anon, authenticated, service_role TO authenticator;
    GRANT USAGE ON SCHEMA public TO authenticator;
  `)

  const conf = `/tmp/email-queue-acl-postgrest.conf`
  spawnSync('bash', ['-c', `cat > ${conf} <<'EOF'
db-uri = "postgres://authenticator:${DB_PASSWORD}@127.0.0.1:5432/${DB}"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "${JWT_SECRET}"
server-port = ${POSTGREST_PORT}
server-host = "127.0.0.1"
EOF`], { encoding: 'utf8' })

  postgrest = spawn(postgrestBin, [conf], { stdio: ['ignore', 'pipe', 'pipe'] })
  proxy = await startProxy()
  mailServer = await startMailSink()

  const workerLog = createWriteStream('/tmp/email-queue-worker.log')
  worker = spawn(denoBin, ['run', '--allow-net', '--allow-env', workerPath], {
    env: {
      ...process.env,
      PORT: String(WORKER_PORT),
      LOVABLE_API_KEY,
      LOVABLE_SEND_URL: `http://127.0.0.1:${MAIL_PORT}/v1/messaging/email/send`,
      SUPABASE_URL: `http://127.0.0.1:${PROXY_PORT}`,
      SUPABASE_SERVICE_ROLE_KEY: serviceJwt,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  worker.stdout?.pipe(workerLog)
  worker.stderr?.pipe(workerLog)

  await waitFor(async () => {
    const open = await fetch(`http://127.0.0.1:${POSTGREST_PORT}/`)
    return open.status !== 503
  }, 'postgrest')
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${WORKER_PORT}/`, { method: 'POST' })
    return response.status === 401
  }, 'process-email-queue')
})

after(async () => {
  proxy?.close()
  mailServer?.close()
  postgrest?.kill('SIGTERM')
  worker?.kill('SIGTERM')
})

test('service_role mail still flows, and anon cannot enqueue mail the worker sends', async () => {
  resetQueues()
  const controlHtml = '<p>legitimate-control-html</p>'
  const seeded = await rpc(serviceJwt, 'enqueue_email', {
    queue_name: 'transactional_emails',
    payload: attackerPayload(controlHtml),
  })
  assert.equal(seeded.status, 200, seeded.text)
  const controlRun = await runWorker()
  assert.equal(controlRun.status, 200, controlRun.text)
  assert.ok(
    sentMails.some((mail) => JSON.stringify(mail.body).includes(controlHtml)),
    `worker did not forward a service_role message: ${JSON.stringify(sentMails)}`
  )

  sentMails.length = 0
  const attacks = []
  for (const queue of ['auth_emails', 'transactional_emails']) {
    const html = `<p>attacker-html-for-${queue}</p>`
    attacks.push({
      queue,
      html,
      response: await rpc(anonJwt, 'enqueue_email', {
        queue_name: queue,
        payload: attackerPayload(html),
      }),
    })
  }
  await runWorker()

  for (const attack of attacks) {
    const mailed = sentMails.filter((mail) => JSON.stringify(mail.body).includes(attack.html))
    const queued = Number(scalar(
      `SELECT count(*) FROM pgmq.q_${attack.queue} WHERE message->>'html' = '${attack.html}'`
    ))
    assert.deepEqual(
      mailed,
      [],
      `worker sent anon-queued html for ${attack.queue}: ${JSON.stringify(sentMails)}`
    )
    assert.equal(queued, 0, `anon enqueue left a row on ${attack.queue}`)
    assert.equal(
      attack.response.status,
      401,
      `anon enqueue_email(${attack.queue}) returned ${attack.response.status}: ${attack.response.text}`
    )
  }
})

test('authenticated cannot enqueue onto the queues the worker sends', async () => {
  resetQueues()
  for (const queue of ['auth_emails', 'transactional_emails']) {
    const html = `<p>authenticated-html-for-${queue}</p>`
    const response = await rpc(authenticatedJwt, 'enqueue_email', {
      queue_name: queue,
      payload: attackerPayload(html),
    })
    const queued = Number(scalar(
      `SELECT count(*) FROM pgmq.q_${queue} WHERE message->>'html' = '${html}'`
    ))
    assert.equal(response.status, 401, response.text)
    assert.equal(queued, 0)
  }
})

for (const role of [
  ['anon', anonJwt],
  ['authenticated', authenticatedJwt],
]) {
  const [roleName, jwt] = role

  test(`${roleName} cannot read an in-flight inquiry`, async () => {
    resetQueues()
    const html = `<p>${roleName}-inquiry-body</p>`
    const seeded = await rpc(serviceJwt, 'enqueue_email', {
      queue_name: 'transactional_emails',
      payload: attackerPayload(html),
    })
    assert.equal(seeded.status, 200, seeded.text)
    const before = queueVisible('transactional_emails')
    const response = await rpc(jwt, 'read_email_batch', {
      queue_name: 'transactional_emails',
      batch_size: 10,
      vt: 3600,
    })
    assert.equal(response.status, 401, response.text)
    assert.equal(response.text.includes('inquiry-unsubscribe-token'), false, response.text)
    assert.equal(response.text.includes(html), false, response.text)
    assert.equal(queueVisible('transactional_emails'), before)
  })

  test(`${roleName} cannot delete an in-flight inquiry`, async () => {
    resetQueues()
    const seeded = await rpc(serviceJwt, 'enqueue_email', {
      queue_name: 'transactional_emails',
      payload: attackerPayload(`<p>${roleName}-delete-body</p>`),
    })
    assert.equal(seeded.status, 200, seeded.text)
    const messageId = Number(scalar(
      `SELECT msg_id FROM pgmq.q_transactional_emails ORDER BY msg_id DESC LIMIT 1`
    ))
    const response = await rpc(jwt, 'delete_email', {
      queue_name: 'transactional_emails',
      message_id: messageId,
    })
    assert.equal(response.status, 401, response.text)
    assert.equal(Number(scalar(
      `SELECT count(*) FROM pgmq.q_transactional_emails WHERE msg_id = ${messageId}`
    )), 1)
  })

  test(`${roleName} cannot move an in-flight inquiry to the dead-letter queue`, async () => {
    resetQueues()
    const payload = attackerPayload(`<p>${roleName}-move-body</p>`)
    const seeded = await rpc(serviceJwt, 'enqueue_email', {
      queue_name: 'transactional_emails',
      payload,
    })
    assert.equal(seeded.status, 200, seeded.text)
    const messageId = Number(scalar(
      `SELECT msg_id FROM pgmq.q_transactional_emails ORDER BY msg_id DESC LIMIT 1`
    ))
    const response = await rpc(jwt, 'move_to_dlq', {
      source_queue: 'transactional_emails',
      dlq_name: 'transactional_emails_dlq',
      message_id: messageId,
      payload,
    })
    assert.equal(response.status, 401, response.text)
    assert.equal(Number(scalar(
      `SELECT count(*) FROM pgmq.q_transactional_emails WHERE msg_id = ${messageId}`
    )), 1)
    assert.equal(Number(scalar(
      `SELECT count(*) FROM pgmq.q_transactional_emails_dlq WHERE message->>'html' = '${payload.html}'`
    )), 0)
  })
}

test('queue functions reject names outside the known mail queues without creating or changing them', async () => {
  resetQueues()
  const outside = `outside_${randomBytes(4).toString('hex')}`
  try {
    const enqueued = await rpc(serviceJwt, 'enqueue_email', {
      queue_name: outside,
      payload: attackerPayload('<p>outside-enqueue</p>'),
    })
    assert.notEqual(enqueued.status, 200, enqueued.text)
    assert.equal(queueExists(outside), false, `enqueue created pgmq.q_${outside}`)

    psql(`SELECT pgmq.create('${outside}')`)
    psql(`SELECT pgmq.send('${outside}', '{"html":"<p>outside-read</p>","unsubscribe_token":"outside-token"}'::jsonb)`)
    const before = queueVisible(outside)
    const read = await rpc(serviceJwt, 'read_email_batch', {
      queue_name: outside,
      batch_size: 10,
      vt: 3600,
    })
    assert.notEqual(read.status, 200, read.text)
    assert.equal(read.text.includes('outside-token'), false, read.text)
    assert.equal(queueVisible(outside), before)

    const messageId = Number(scalar(`SELECT max(msg_id) FROM pgmq.q_${outside}`))
    const deleted = await rpc(serviceJwt, 'delete_email', {
      queue_name: outside,
      message_id: messageId,
    })
    assert.notEqual(deleted.status, 200, deleted.text)
    assert.equal(Number(scalar(`SELECT count(*) FROM pgmq.q_${outside} WHERE msg_id = ${messageId}`)), 1)

    const otherDlq = `${outside}_dlq`
    const moved = await rpc(serviceJwt, 'move_to_dlq', {
      source_queue: outside,
      dlq_name: otherDlq,
      message_id: messageId,
      payload: { html: '<p>outside-move</p>' },
    })
    assert.notEqual(moved.status, 200, moved.text)
    assert.equal(Number(scalar(`SELECT count(*) FROM pgmq.q_${outside} WHERE msg_id = ${messageId}`)), 1)
    assert.equal(queueExists(otherDlq), false, `move_to_dlq created pgmq.q_${otherDlq}`)
  } finally {
    dropQueue(outside)
    dropQueue(`${outside}_dlq`)
  }
})

test('service_role can enqueue, read, delete, and move the known queues', async () => {
  resetQueues()
  for (const queue of ['auth_emails', 'transactional_emails']) {
    const html = `<p>known-queue-${queue}</p>`
    const enqueued = await rpc(serviceJwt, 'enqueue_email', {
      queue_name: queue,
      payload: attackerPayload(html),
    })
    assert.equal(enqueued.status, 200, enqueued.text)
    const read = await rpc(serviceJwt, 'read_email_batch', {
      queue_name: queue,
      batch_size: 10,
      vt: 0,
    })
    assert.equal(read.status, 200, read.text)
    assert.equal(read.text.includes(html), true, read.text)
    const messageId = Number(scalar(`SELECT max(msg_id) FROM pgmq.q_${queue}`))
    const moved = await rpc(serviceJwt, 'move_to_dlq', {
      source_queue: queue,
      dlq_name: `${queue}_dlq`,
      message_id: messageId,
      payload: attackerPayload(html),
    })
    assert.equal(moved.status, 200, moved.text)
    const dlqId = Number(scalar(`SELECT max(msg_id) FROM pgmq.q_${queue}_dlq`))
    const deleted = await rpc(serviceJwt, 'delete_email', {
      queue_name: `${queue}_dlq`,
      message_id: dlqId,
    })
    assert.equal(deleted.status, 200, deleted.text)
    assert.equal(Number(scalar(`SELECT count(*) FROM pgmq.q_${queue}_dlq WHERE msg_id = ${dlqId}`)), 0)
  }
})
