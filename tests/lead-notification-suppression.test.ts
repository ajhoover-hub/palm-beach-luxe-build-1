import { FunctionsClient } from "npm:@supabase/functions-js@2.91.0"
import { TEMPLATES } from "../supabase/functions/_shared/transactional-email-templates/registry.ts"
import { startStandIn, type StandInState } from "./postgrest-stand-in.ts"

const DENO = Deno.execPath()
const ROOT = new URL("..", import.meta.url).pathname
const STANDIN_PORT = 8765
const FUNCTION_PORT = 8000
const STANDIN_URL = `http://127.0.0.1:${STANDIN_PORT}`
const FUNCTION_URL = `http://127.0.0.1:${FUNCTION_PORT}`
const SERVICE_ROLE_KEY = "test-service-role-key"
const LOVABLE_API_KEY = "test-lovable-api-key"

const office = TEMPLATES["contact-notification"].to
const styleOffice = TEMPLATES["style-book-notification"].to
if (!office || office !== styleOffice) {
  throw new Error("contact-notification and style-book-notification must share one fixed recipient")
}

const browserFunctions = new FunctionsClient(FUNCTION_URL)

type Child = { kill: () => void; output: () => Promise<string> }

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: Deno.env.get("PATH") ?? "",
    HOME: Deno.env.get("HOME") ?? "",
    DENO_DIR: Deno.env.get("DENO_DIR") ?? "",
    TMPDIR: Deno.env.get("TMPDIR") ?? "/tmp",
    SUPABASE_URL: STANDIN_URL,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    LOVABLE_API_KEY,
    ...extra,
  }
}

function spawnFunction(script: string, extra: Record<string, string> = {}): Child {
  const stderr: string[] = []
  const command = new Deno.Command(DENO, {
    args: ["run", "--node-modules-dir=none", "--allow-net", "--allow-env", "--allow-write", script],
    cwd: ROOT,
    env: childEnv(extra),
    stdout: "piped",
    stderr: "piped",
  })
  const process = command.spawn()
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const text = await new Response(stream).text()
    stderr.push(text)
  }
  const stdoutDone = pump(process.stdout)
  const stderrDone = pump(process.stderr)
  return {
    kill: () => {
      try {
        process.kill("SIGKILL")
      } catch {
        // already exited
      }
    },
    output: async () => {
      await Promise.allSettled([stdoutDone, stderrDone, process.status])
      return stderr.join("\n")
    },
  }
}

async function waitForHttp(url: string): Promise<void> {
  let last = "no response"
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(url, { method: "GET" })
      if (response.status < 500) return
      last = `status ${response.status}`
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`timed out waiting for ${url}: ${last}`)
}

async function resetState(): Promise<void> {
  const response = await fetch(`${STANDIN_URL}/test/reset`, { method: "POST" })
  if (!response.ok) throw new Error(`reset failed: ${response.status}`)
}

async function state(): Promise<{ tables: StandInState["tables"]; queues: StandInState["queues"] }> {
  const response = await fetch(`${STANDIN_URL}/test/state`)
  if (!response.ok) throw new Error(`state failed: ${response.status}`)
  return await response.json()
}

function describePayload(value: unknown): string {
  return JSON.stringify(value, (key, item) => (key === "unsubscribe_token" || key === "token" ? (item ? "[present]" : item) : item))
}

function serviceRoleAuthorization(): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
  return `Bearer ${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role: "service_role" })}.test-signature`
}

async function signWebhook(body: string): Promise<{ timestamp: string; signature: string }> {
  // Same construction as verifyWebhookRequest in @lovable.dev/webhooks-js@0.0.3:
  // signed payload is `${timestamp}.${body}`, header value is `sha256=` plus hex HMAC-SHA256.
  const timestamp = String(Math.floor(Date.now() / 1000))
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(LOVABLE_API_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  )
  const signature = "sha256=" +
    Array.from(new Uint8Array(mac)).map((byte) => byte.toString(16).padStart(2, "0")).join("")
  return { timestamp, signature }
}

async function postFunction(body: unknown, headers: HeadersInit = {}): Promise<Response> {
  return await fetch(FUNCTION_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

function tokenAttached(payload: Record<string, unknown> | undefined): boolean {
  return typeof payload?.unsubscribe_token === "string" && payload.unsubscribe_token.length > 0
}

async function suppressOffice(reason: string): Promise<void> {
  // Writers in handle-email-unsubscribe and handle-email-suppression store the
  // lowercased address, and the send function looks the address up lowercased.
  const suppressed = await fetch(`${STANDIN_URL}/rest/v1/suppressed_emails`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: office!.toLowerCase(), reason }),
  })
  if (!suppressed.ok) throw new Error(`seed suppression failed: ${suppressed.status}`)
  const token = await fetch(`${STANDIN_URL}/rest/v1/email_unsubscribe_tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: `used-office-token-${reason}`,
      email: office!.toLowerCase(),
      used_at: new Date().toISOString(),
    }),
  })
  if (!token.ok) throw new Error(`seed token failed: ${token.status}`)
}

Deno.test({
  name: "fixed office lead notifications are delivered without an unsubscribe token",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const standin = startStandIn(STANDIN_PORT)
    const failures: string[] = []
    const check = (condition: boolean, message: string) => {
      if (!condition) failures.push(message)
    }
    let sendFunction: Child | undefined
    let otherFunction: Child | undefined
    try {
      sendFunction = spawnFunction("supabase/functions/send-transactional-email/index.ts")
      await waitForHttp(FUNCTION_URL)

      await tSuppressAndStillDeliver(check)
      await tSubscriberSuppressionRemains(check)
      await tDoNotMintUnsubscribeToken(check, async () => {
        sendFunction?.kill()
        await sendFunction?.output()
        sendFunction = undefined
      })

      await tComplaintWebhookThenStillDeliver(check)
      await tUnsubscribeTokenThenStillDeliver(check)

      if (failures.length > 0) {
        throw new Error(failures.join("\n"))
      }
    } catch (error) {
      if (sendFunction) {
        const logs = await sendFunction.output()
        sendFunction = undefined
        if (logs.trim()) console.error(logs.slice(-4000))
      }
      if (otherFunction) {
        const logs = await otherFunction.output()
        if (logs.trim()) console.error(logs.slice(-4000))
      }
      throw error
    } finally {
      sendFunction?.kill()
      otherFunction?.kill()
      await standin.stop()
    }

    async function tSuppressAndStillDeliver(check: (condition: boolean, message: string) => void) {
      for (const reason of ["unsubscribe", "complaint"]) {
        await resetState()
        await suppressOffice(reason)

        for (const templateName of ["contact-notification", "style-book-notification"] as const) {
          const marker = `${templateName}-${reason}-still-delivered`
          const invoked = await browserFunctions.invoke("send-transactional-email", {
            body: {
              templateName,
              recipientEmail: "visitor@example.com",
              idempotencyKey: marker,
              templateData: {
                fullName: marker,
                email: "visitor@example.com",
                phone: "555-0100",
                message: marker,
                projectType: "New custom home",
                style: "Anglo-Caribbean",
              },
            },
          })
          const queued = (await state()).queues.transactional_emails.map((message) => message.message)
          const delivered = queued.filter((message) => message.idempotency_key === marker)
          check(
            invoked.error === null && invoked.data?.success === true && invoked.data?.queued === true,
            `${templateName} with ${reason} suppression returned ${JSON.stringify(invoked.data)} error=${invoked.error?.message ?? "null"} instead of a queued success. The browser client only treats a non-2xx response as an error, so a 200 email_suppressed body is shown as a successful inquiry.`,
          )
          check(
            delivered.length === 1 && delivered[0].to === office,
            `${templateName} was not queued to the fixed office recipient while that address was suppressed (${reason}). queued=${describePayload(delivered)}`,
          )
          check(
            delivered.length !== 1 || !tokenAttached(delivered[0]),
            `${templateName} queue payload still carries an unsubscribe token for the office address`,
          )
          check(
            delivered.length !== 1 || delivered[0].purpose === "transactional",
            `${templateName} was not queued with purpose transactional`,
          )
        }
      }
    }

    async function tDoNotMintUnsubscribeToken(
      check: (condition: boolean, message: string) => void,
      stopSendFunction: () => Promise<void>,
    ) {
      await resetState()
      const marker = "contact-notification-no-token"
      const response = await postFunction({
        templateName: "contact-notification",
        recipientEmail: "attacker@example.com",
        idempotencyKey: marker,
        templateData: { fullName: marker, email: "attacker@example.com", message: marker, projectType: "Renovation" },
      })
      const body = await response.json()
      const snapshot = await state()
      const queued = snapshot.queues.transactional_emails.map((message) => message.message)
        .filter((message) => message.idempotency_key === marker)
      const tokens = snapshot.tables.email_unsubscribe_tokens
      check(response.status === 200 && body.success === true && body.queued === true, `clean office notification was not accepted: ${response.status} ${JSON.stringify(body)}`)
      check(queued.length === 1 && queued[0].to === office, `clean office notification was not addressed to the template recipient: ${describePayload(queued)}`)
      check(queued.length === 1 && !tokenAttached(queued[0]), `clean office notification queued an unsubscribe token`)
      check(tokens.length === 0, `sending the office notification created ${tokens.length} unsubscribe token row(s) for the fixed recipient`)
      check(
        typeof queued[0]?.html === "string" && String(queued[0].html).includes(marker),
        "office notification html did not include the submitted inquiry",
      )

      await stopSendFunction()
      const capturePath = await Deno.makeTempFile()
      const worker = spawnFunction("tests/serve-queue-worker.ts", { EMAIL_CAPTURE_PATH: capturePath })
      try {
        await waitForHttp(FUNCTION_URL)
        const drained = await fetch(FUNCTION_URL, {
          method: "POST",
          headers: { authorization: serviceRoleAuthorization() },
        })
        const drainedBody = await drained.json()
        check(drained.ok && drainedBody.processed === 1, `queue worker did not send the office notification: ${drained.status} ${JSON.stringify(drainedBody)}`)
        const captured = JSON.parse(await Deno.readTextFile(capturePath)) as Array<Record<string, unknown>>
        check(captured.length === 1, `sendLovableEmail was not called once: ${describePayload(captured)}`)
        check(captured[0]?.to === office, `outbound recipient was ${captured[0]?.to}`)
        check(captured[0]?.purpose === "transactional", `outbound purpose was ${captured[0]?.purpose}`)
        check(
          !tokenAttached(captured[0]),
          "outbound Lovable send still includes an unsubscribe token for the fixed office recipient",
        )
      } finally {
        worker.kill()
        const logs = await worker.output()
        if (logs.trim()) console.error(logs.slice(-2000))
      }
    }

    async function tSubscriberSuppressionRemains(check: (condition: boolean, message: string) => void) {
      await resetState()
      const visitor = "visitor.suppressed@example.com"
      await fetch(`${STANDIN_URL}/rest/v1/suppressed_emails`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: visitor, reason: "unsubscribe" }),
      })
      for (const templateName of ["contact-confirmation", "style-book-confirmation"]) {
        const before = (await state()).queues.transactional_emails.length
        const response = await postFunction({
          templateName,
          recipientEmail: visitor,
          templateData: { firstName: "Visitor", style: "Mediterranean" },
        })
        const body = await response.json()
        const after = (await state()).queues.transactional_emails.length
        check(after === before, `${templateName} to a suppressed visitor was still queued`)
        check(body.reason === "email_suppressed" || response.status >= 400, `${templateName} did not keep visitor suppression: ${response.status} ${JSON.stringify(body)}`)
      }
    }

    async function tComplaintWebhookThenStillDeliver(check: (condition: boolean, message: string) => void) {
      await resetState()
      const suppression = spawnFunction("supabase/functions/handle-email-suppression/index.ts")
      try {
        await waitForHttp(FUNCTION_URL)
        const payload = JSON.stringify({
          data: {
            email: office!,
            reason: "complaint",
            is_retry: false,
            retry_count: 0,
          },
        })
        const signed = await signWebhook(payload)
        const response = await fetch(FUNCTION_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-lovable-signature": signed.signature,
            "x-lovable-timestamp": signed.timestamp,
          },
          body: payload,
        })
        const body = await response.json()
        check(response.status === 200 && body.success === true, `complaint webhook was not accepted: ${response.status} ${JSON.stringify(body)}`)
      } finally {
        suppression.kill()
        await suppression.output()
      }

      const rows = (await state()).tables.suppressed_emails
      check(
        rows.some((row) => String(row.email).toLowerCase() === office!.toLowerCase() && row.reason === "complaint"),
        `complaint webhook did not suppress the office address: ${JSON.stringify(rows)}`,
      )

      sendFunction = spawnFunction("supabase/functions/send-transactional-email/index.ts")
      await waitForHttp(FUNCTION_URL)
      const marker = "after-complaint-still-delivered"
      const invoked = await browserFunctions.invoke("send-transactional-email", {
        body: {
          templateName: "style-book-notification",
          idempotencyKey: marker,
          templateData: { fullName: marker, email: "after.complaint@example.com", style: "Oceanfront", message: marker },
        },
      })
      const delivered = (await state()).queues.transactional_emails.map((message) => message.message)
        .filter((message) => message.idempotency_key === marker)
      check(invoked.error === null && invoked.data?.success === true, `style-book notification after a complaint was not a success to the browser client: ${JSON.stringify(invoked.data)}`)
      check(delivered.length === 1 && delivered[0].to === office && !tokenAttached(delivered[0]), `style-book notification after a complaint was not delivered without an unsubscribe token: ${describePayload(delivered)}`)
      sendFunction.kill()
      await sendFunction.output()
      sendFunction = undefined
    }

    async function tUnsubscribeTokenThenStillDeliver(check: (condition: boolean, message: string) => void) {
      await resetState()
      sendFunction = spawnFunction("supabase/functions/send-transactional-email/index.ts")
      await waitForHttp(FUNCTION_URL)
      const first = "office-mail-before-unsubscribe"
      await postFunction({
        templateName: "contact-notification",
        idempotencyKey: first,
        templateData: { fullName: first, email: "lead@example.com", message: first, projectType: "Addition" },
      })
      const tokenRows = (await state()).tables.email_unsubscribe_tokens
      sendFunction.kill()
      await sendFunction.output()
      sendFunction = undefined

      if (tokenRows.length > 0) {
        const unsubscribe = spawnFunction("supabase/functions/handle-email-unsubscribe/index.ts")
        try {
          await waitForHttp(FUNCTION_URL)
          const response = await fetch(`${FUNCTION_URL}?token=${encodeURIComponent(String(tokenRows[0].token))}`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: "List-Unsubscribe=One-Click",
          })
          const body = await response.json()
          check(response.status === 200 && body.success === true, `one-click unsubscribe did not accept the office token: ${response.status} ${JSON.stringify(body)}`)
        } finally {
          unsubscribe.kill()
          await unsubscribe.output()
        }
      }

      sendFunction = spawnFunction("supabase/functions/send-transactional-email/index.ts")
      await waitForHttp(FUNCTION_URL)
      const marker = "office-mail-after-unsubscribe"
      const invoked = await browserFunctions.invoke("send-transactional-email", {
        body: {
          templateName: "contact-notification",
          idempotencyKey: marker,
          templateData: { fullName: marker, email: "next.lead@example.com", message: marker, projectType: "New custom home" },
        },
      })
      const delivered = (await state()).queues.transactional_emails.map((message) => message.message)
        .filter((message) => message.idempotency_key === marker)
      check(
        invoked.error === null && invoked.data?.success === true && delivered.length === 1 && delivered[0].to === office && !tokenAttached(delivered[0]),
        `contact notification after an office unsubscribe was not delivered without a token. invoke=${JSON.stringify(invoked.data)} delivered=${describePayload(delivered)}`,
      )
      sendFunction.kill()
      await sendFunction.output()
      sendFunction = undefined
    }
  },
})
