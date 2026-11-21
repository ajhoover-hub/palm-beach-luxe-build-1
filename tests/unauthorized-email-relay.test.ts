/**
 * Spec for the transactional-email relay.
 *
 * These tests fail while a caller who only presents the public anon credential
 * can queue mail. They pass once that caller is refused before any send log,
 * unsubscribe token, or queue write, and the queue worker therefore has
 * nothing to hand to the mail API.
 *
 * Run:
 *   deno test --allow-net --allow-read --allow-env --allow-run --no-check --node-modules-dir=none tests/unauthorized-email-relay.test.ts
 */
import * as jose from "jsr:@panva/jose@6";
import { createClient } from "npm:@supabase/supabase-js@2.91.0";

const REPO = new URL("..", import.meta.url).pathname;
const FUNCTION_PORT = 8000;
const SERVICE_ROLE_PLACEHOLDER = "test-service-role-placeholder";
const JWT_SECRET_PLACEHOLDER = "test-jwt-secret-not-a-credential";
const PUBLISHABLE_KEY_PLACEHOLDER = "publishable-key-placeholder";
const LOVABLE_API_KEY_PLACEHOLDER = "lovable-api-key-placeholder";

const PHISH_FIRST = "PHISH_MARKER_FIRST";
const PHISH_PROJECT = "PHISH_MARKER_PROJECT";
const OFFICE_MARKER = "OFFICE_FLOOD_MARKER";
const STYLE_MARKER = "STYLE_PHISH_MARKER";

type Write = { op: string; detail: Record<string, unknown> };
type Queued = {
  msgId: number;
  readCt: number;
  visibleAt: number;
  message: Record<string, unknown>;
};
type OutboundSend = { to: unknown; from: unknown; subject: unknown; html: unknown; text: unknown; idempotencyKey: string | null };

const writes: Write[] = [];
const queue: Queued[] = [];
const sends: OutboundSend[] = [];
const tokens = new Map<string, { token: string; email: string; used_at: string | null }>();
let nextMsgId = 1;

function resetMailState() {
  writes.length = 0;
  queue.length = 0;
  sends.length = 0;
  tokens.clear();
  nextMsgId = 1;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function parseFilter(raw: string | null): { op: string; value: string } | null {
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot < 0) return null;
  return { op: raw.slice(0, dot), value: raw.slice(dot + 1) };
}

function enqueueLikePgmq(payload: Record<string, unknown>): number {
  // public.enqueue_email returns pgmq.send(queue_name, payload) with no
  // idempotency lookup. pgmq.send inserts that jsonb as the message.
  const msgId = nextMsgId++;
  queue.push({
    msgId,
    readCt: 0,
    visibleAt: 0,
    message: payload,
  });
  writes.push({
    op: "enqueue_email",
    detail: {
      to: payload.to,
      from: payload.from,
      subject: payload.subject,
      idempotency_key: payload.idempotency_key,
      label: payload.label,
      htmlIncludes: typeof payload.html === "string" ? payload.html : "",
      textIncludes: typeof payload.text === "string" ? payload.text : "",
    },
  });
  return msgId;
}

function readLikePgmq(queueName: string, vtSeconds: number, qty: number) {
  if (queueName !== "transactional_emails" && queueName !== "auth_emails") {
    return [];
  }
  if (queueName === "auth_emails") return [];
  const now = Date.now();
  const visible = queue.filter((row) => row.visibleAt <= now).slice(0, qty);
  for (const row of visible) {
    row.readCt += 1;
    row.visibleAt = now + vtSeconds * 1000;
  }
  return visible.map((row) => ({
    msg_id: row.msgId,
    read_ct: row.readCt,
    message: row.message,
  }));
}

function selectRows(table: string, url: URL): unknown[] {
  const emailFilter = parseFilter(url.searchParams.get("email"));
  const statusFilter = parseFilter(url.searchParams.get("status"));
  const messageFilter = url.searchParams.get("message_id");
  if (table === "suppressed_emails") return [];
  if (table === "email_unsubscribe_tokens") {
    if (emailFilter?.op === "eq") {
      const row = tokens.get(emailFilter.value);
      return row ? [{ token: row.token, email: row.email, used_at: row.used_at }] : [];
    }
    return [];
  }
  if (table === "email_send_log") {
    const wantedStatus = statusFilter?.op === "eq" ? statusFilter.value : null;
    const wantedIds = new Set<string>();
    if (messageFilter?.startsWith("in.(") && messageFilter.endsWith(")")) {
      for (const id of messageFilter.slice(4, -1).split(",")) {
        wantedIds.add(id.replaceAll('"', ""));
      }
    } else if (messageFilter?.startsWith("eq.")) {
      wantedIds.add(messageFilter.slice(3));
    }
    return writes
      .filter((write) => write.op === "email_send_log")
      .map((write) => write.detail)
      .filter((row) => {
        if (wantedStatus && row.status !== wantedStatus) return false;
        if (wantedIds.size && !wantedIds.has(String(row.message_id))) return false;
        return true;
      });
  }
  if (table === "email_send_state") {
    return [{
      id: 1,
      retry_after_until: null,
      batch_size: 10,
      send_delay_ms: 0,
      auth_email_ttl_minutes: 15,
      transactional_email_ttl_minutes: 60,
    }];
  }
  return [];
}

const mock = Deno.serve({ port: 0, hostname: "127.0.0.1" }, async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const bodyText = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
  const body = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : {};

  if (path === "/v1/messaging/email/prepare-uploads") {
    return new Response(null, { status: 204 });
  }

  if (path === "/v1/messaging/email/send" || path === "/emails") {
    const record: OutboundSend = {
      to: body.to,
      from: body.from,
      subject: body.subject,
      html: body.html,
      text: body.text,
      idempotencyKey: req.headers.get("Idempotency-Key"),
    };
    sends.push(record);
    return json({ id: "send-accepted" });
  }

  const rest = path.match(/^\/rest\/v1\/([^/]+)$/);
  if (rest && req.method === "GET") {
    const rows = selectRows(rest[1], url);
    if (req.headers.get("accept")?.includes("application/vnd.pgrst.object+json")) {
      if (rows.length !== 1) {
        return json({
          code: "PGRST116",
          message: "JSON object requested, multiple (or no) rows returned",
        }, 406);
      }
      return json(rows[0]);
    }
    return json(rows);
  }

  if (rest && req.method === "POST" && rest[1] === "email_send_log") {
    writes.push({ op: "email_send_log", detail: body });
    return new Response(null, { status: 201 });
  }

  if (rest && req.method === "POST" && rest[1] === "email_unsubscribe_tokens") {
    const email = String(body.email ?? "");
    const prefer = req.headers.get("prefer") ?? "";
    if (!tokens.has(email) || !prefer.includes("resolution=ignore-duplicates")) {
      tokens.set(email, {
        token: String(body.token ?? ""),
        email,
        used_at: null,
      });
    }
    writes.push({
      op: "email_unsubscribe_tokens",
      detail: { email, ignoreDuplicates: prefer.includes("resolution=ignore-duplicates") },
    });
    return new Response(null, { status: 201 });
  }

  const rpc = path.match(/^\/rest\/v1\/rpc\/([^/]+)$/);
  if (rpc && req.method === "POST") {
    if (rpc[1] === "enqueue_email") {
      const payload = body.payload as Record<string, unknown>;
      const msgId = enqueueLikePgmq(payload);
      return json(msgId);
    }
    if (rpc[1] === "read_email_batch") {
      const rows = readLikePgmq(
        String(body.queue_name),
        Number(body.vt),
        Number(body.batch_size),
      );
      return json(rows);
    }
    if (rpc[1] === "delete_email") {
      const id = Number(body.message_id);
      const index = queue.findIndex((row) => row.msgId === id);
      if (index >= 0) queue.splice(index, 1);
      return json(true);
    }
    if (rpc[1] === "move_to_dlq") {
      return json(1);
    }
  }

  return json({ error: `unexpected ${req.method} ${path}` }, 404);
});

const mockPort = mock.addr.port;
const mockOrigin = `http://127.0.0.1:${mockPort}`;

function b64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function unsignedJwt(claims: Record<string, unknown>): string {
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(claims)}.placeholder-signature`;
}

async function signedAnonJwt(): Promise<string> {
  const secret = new TextEncoder().encode(JWT_SECRET_PLACEHOLDER);
  return await new jose.SignJWT({
    role: "anon",
    iss: "supabase",
    ref: "test-project",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(secret);
}

type Child = { proc: Deno.ChildProcess; logs: string[] };

function pump(stream: ReadableStream<Uint8Array>, logs: string[]) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const done = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      logs.push(decoder.decode(value));
    }
  })();
  return done;
}

async function startFunction(script: string, extraEnv: Record<string, string>): Promise<Child> {
  const logs: string[] = [];
  const proc = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-net",
      "--allow-env",
      "--no-lock",
      script,
    ],
    cwd: REPO,
    env: {
      PATH: Deno.env.get("PATH") ?? "",
      HOME: Deno.env.get("HOME") ?? "",
      SUPABASE_URL: mockOrigin,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_PLACEHOLDER,
      ...extraEnv,
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  pump(proc.stdout, logs);
  pump(proc.stderr, logs);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const status = await Promise.race([
      proc.status.then((result) => result),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
    ]);
    if (status) {
      throw new Error(`function exited ${status.code}: ${logs.join("")}`);
    }
    try {
      const ready = await fetch(`http://127.0.0.1:${FUNCTION_PORT}`, { method: "OPTIONS" });
      await ready.body?.cancel();
      return { proc, logs };
    } catch {
      // still binding
    }
  }
  proc.kill();
  await proc.status;
  throw new Error(`function did not listen on ${FUNCTION_PORT}: ${logs.join("")}`);
}

async function stopChild(child: Child | null) {
  if (!child) return;
  try {
    child.proc.kill();
  } catch {
    // already gone
  }
  await child.proc.status;
}

let mailer: Child | null = null;

async function mailerLogs(): Promise<string> {
  if (!mailer) return "";
  return mailer.logs.join("\n");
}

async function postFunction(path: string, token: string | null, body: unknown): Promise<Response> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return await fetch(`http://127.0.0.1:${FUNCTION_PORT}/${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function sideEffectsSince(mark: number): Write[] {
  return writes.slice(mark);
}

function describePayload(write: Write): string {
  const detail = write.detail;
  const html = String(detail.htmlIncludes ?? "");
  const text = String(detail.textIncludes ?? "");
  return [
    write.op,
    `to=${detail.to ?? detail.email ?? detail.recipient_email ?? ""}`,
    `from=${detail.from ?? ""}`,
    `subject=${JSON.stringify(detail.subject ?? "")}`,
    `status=${detail.status ?? ""}`,
    `idempotency_key=${detail.idempotency_key ?? ""}`,
    `htmlHasPhish=${html.includes(PHISH_FIRST) || html.includes(PHISH_PROJECT) || html.includes(OFFICE_MARKER) || html.includes(STYLE_MARKER)}`,
    `textHasPhish=${text.includes(PHISH_FIRST) || text.includes(PHISH_PROJECT) || text.includes(OFFICE_MARKER) || text.includes(STYLE_MARKER)}`,
    `htmlLength=${html.length}`,
  ].join(" ");
}

Deno.test({
  name: "gateway HS256 check accepts an anon-role JWT and does not look at role",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
  const secret = new TextEncoder().encode(JWT_SECRET_PLACEHOLDER);
  const token = await signedAnonJwt();
  // Same call as docker/volumes/functions/main/index.ts isValidLegacyJWT:
  // jose.jwtVerify(jwt, secretKey) with no role constraint.
  const verified = await jose.jwtVerify(token, secret);
  if (verified.payload.role !== "anon") {
    throw new Error("signed token did not round-trip the anon role");
  }
  const header = jose.decodeProtectedHeader(token);
  if (header.alg !== "HS256") {
    throw new Error("gateway legacy path only runs for HS256");
  }
},
});

Deno.test({
  name: "shipped publishable key is an unexpired anon JWT for this project",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
  const source = await Deno.readTextFile(`${REPO}src/integrations/supabase/client.ts`);
  const config = await Deno.readTextFile(`${REPO}supabase/config.toml`);
  const projectId = config.match(/project_id = "([^"]+)"/)?.[1];
  const key = source.match(
    /SUPABASE_PUBLISHABLE_KEY = import\.meta\.env\.VITE_SUPABASE_PUBLISHABLE_KEY \|\| "([^"]+)"/,
  )?.[1];
  if (!projectId || !key) {
    throw new Error("could not locate the publishable key constant or project id");
  }
  const [encodedHeader, encodedPayload] = key.split(".");
  const header = JSON.parse(atob(encodedHeader.replaceAll("-", "+").replaceAll("_", "/")));
  const payload = JSON.parse(
    atob(encodedPayload.replaceAll("-", "+").replaceAll("_", "/").padEnd(
      Math.ceil(encodedPayload.length / 4) * 4,
      "=",
    )),
  );
  if (header.alg !== "HS256" || payload.role !== "anon" || payload.ref !== projectId) {
    throw new Error(
      `publishable key claims alg=${header.alg} role=${payload.role} refMatches=${payload.ref === projectId}`,
    );
  }
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) {
    throw new Error("publishable key is expired");
  }
},
});

Deno.test({
  name: "supabase-js 2.91.0 invoke sends the publishable key as the bearer token",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
  const seen: { authorization: string | null; apikey: string | null; url: string }[] = [];
  const client = createClient("http://127.0.0.1:9", PUBLISHABLE_KEY_PLACEHOLDER, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      storage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      },
    },
    global: {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        seen.push({
          authorization: headers.get("Authorization"),
          apikey: headers.get("apikey"),
          url: String(input),
        });
        return Promise.resolve(new Response(JSON.stringify({ error: "stopped" }), { status: 401 }));
      },
    },
  });
  await client.functions.invoke("send-transactional-email", {
    body: { templateName: "contact-confirmation", recipientEmail: "person@example.com" },
  });
  const call = seen.find((entry) => entry.url.includes("/functions/v1/send-transactional-email"));
  if (!call) throw new Error("functions.invoke did not request the function");
  if (call.authorization !== `Bearer ${PUBLISHABLE_KEY_PLACEHOLDER}`) {
    throw new Error("invoke did not put the publishable key in Authorization");
  }
  if (call.apikey !== PUBLISHABLE_KEY_PLACEHOLDER) {
    throw new Error("invoke did not send the publishable key as apikey");
  }
},
});

Deno.test({
  name: "anon credential cannot queue or send contact, notification, or style-book mail",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    resetMailState();
    mailer = await startFunction("supabase/functions/send-transactional-email/index.ts", {});
    const anon = await signedAnonJwt();
    const longProject = `P${"x".repeat(5000)}`;
    const cases: { label: string; body: Record<string, unknown> }[] = [
      {
        label: "contact-confirmation to a caller-chosen inbox",
        body: {
          templateName: "contact-confirmation",
          recipientEmail: "victim.inbox@example.com",
          idempotencyKey: "confirm-repeat-key",
          templateData: {
            firstName: PHISH_FIRST,
            projectType: PHISH_PROJECT,
            timeline: "whenever",
            ownsLot: "no",
            investmentRange: longProject,
          },
        },
      },
      {
        label: "repeat of contact-confirmation with the same idempotency key",
        body: {
          templateName: "contact-confirmation",
          recipientEmail: "victim.inbox@example.com",
          idempotencyKey: "confirm-repeat-key",
          templateData: { firstName: PHISH_FIRST, projectType: PHISH_PROJECT },
        },
      },
      {
        label: "second contact-confirmation with no idempotency key",
        body: {
          templateName: "contact-confirmation",
          recipientEmail: "another.victim@example.com",
          templateData: { firstName: PHISH_FIRST, projectType: PHISH_PROJECT },
        },
      },
      {
        label: "contact-notification flood of the office inbox",
        body: {
          templateName: "contact-notification",
          recipientEmail: "ignored.recipient@example.com",
          templateData: {
            fullName: `Office\r\nBcc: injected@example.com`,
            email: "attacker@example.com",
            message: OFFICE_MARKER,
            projectType: PHISH_PROJECT,
          },
        },
      },
      {
        label: "snake_case contact-confirmation",
        body: {
          template_name: "contact-confirmation",
          recipient_email: "snake.victim@example.com",
          templateData: { firstName: PHISH_FIRST, projectType: PHISH_PROJECT },
        },
      },
      {
        label: "style-book-confirmation to a caller-chosen inbox",
        body: {
          templateName: "style-book-confirmation",
          recipientEmail: "style.victim@example.com",
          templateData: { firstName: PHISH_FIRST, style: STYLE_MARKER },
        },
      },
      {
        label: "style-book-notification to the office",
        body: {
          templateName: "style-book-notification",
          templateData: {
            fullName: "Style Office",
            email: "attacker@example.com",
            message: OFFICE_MARKER,
            style: STYLE_MARKER,
          },
        },
      },
      {
        label: "contact-confirmation with no Authorization header",
        body: {
          templateName: "contact-confirmation",
          recipientEmail: "noauth.victim@example.com",
          templateData: { firstName: PHISH_FIRST, projectType: PHISH_PROJECT },
        },
      },
    ];

    const failures: string[] = [];
    for (const testCase of cases) {
      const mark = writes.length;
      const token = testCase.label.includes("no Authorization") ? null : anon;
      let status = 0;
      try {
        const response = await postFunction("send-transactional-email", token, testCase.body);
        status = response.status;
        await response.body?.cancel();
      } catch (error) {
        failures.push(`${testCase.label} request failed: ${error}`);
        continue;
      }
      const produced = sideEffectsSince(mark);
      if (status !== 401 && status !== 403 || produced.length > 0) {
        failures.push(
          `${testCase.label} status=${status}\n${produced.map(describePayload).join("\n") || "(no writes)"}`,
        );
      }
    }

    await stopChild(mailer);
    mailer = null;
    const worker = await startFunction("supabase/functions/process-email-queue/index.ts", {
      LOVABLE_API_KEY: LOVABLE_API_KEY_PLACEHOLDER,
      LOVABLE_SEND_URL: `${mockOrigin}/v1/messaging/email/send`,
    });
    const workerResponse = await postFunction(
      "process-email-queue",
      unsignedJwt({ role: "service_role" }),
      {},
    );
    const workerStatus = workerResponse.status;
    await workerResponse.text();
    await stopChild(worker);

    if (sends.length > 0 || failures.length > 0) {
      const sendSummary = sends.map((send) => {
        const html = String(send.html ?? "");
        return `to=${send.to} from=${send.from} subject=${JSON.stringify(send.subject)} idempotency=${send.idempotencyKey} htmlHasMarker=${html.includes(PHISH_FIRST) || html.includes(OFFICE_MARKER) || html.includes(STYLE_MARKER)}`;
      }).join("\n");
      throw new Error(
        `worker status=${workerStatus} outbound=${sends.length}\n${sendSummary}\n${failures.join("\n\n")}\n${await mailerLogs()}`,
      );
    }
  },
});

Deno.test({
  name: "send-contact-email is not an open relay for the same anon caller",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    resetMailState();
    let child: Child;
    try {
      child = await startFunction("supabase/functions/send-contact-email/index.ts", {
        RESEND_API_KEY: "re_test_placeholder",
        RESEND_BASE_URL: mockOrigin,
      });
    } catch (error) {
      throw new Error(`send-contact-email did not start, so this shared path is untested: ${error}`);
    }
    const mark = writes.length;
    const anon = await signedAnonJwt();
    const response = await postFunction("send-contact-email", anon, {
      firstName: PHISH_FIRST,
      lastName: "Visitor",
      email: "relay.victim@example.com",
      message: OFFICE_MARKER,
      projectType: PHISH_PROJECT,
    });
    const status = response.status;
    const responseText = await response.text();
    await stopChild(child);
    const produced = sideEffectsSince(mark);
    if ((status === 401 || status === 403) && sends.length === 0 && produced.length === 0) return;
    const sendSummary = sends.map((send) => {
      const html = String(send.html ?? "");
      return `to=${JSON.stringify(send.to)} from=${JSON.stringify(send.from)} subject=${JSON.stringify(send.subject)} htmlHasMarker=${html.includes(PHISH_FIRST) || html.includes(OFFICE_MARKER)}`;
    }).join("\n");
    throw new Error(
      `send-contact-email status=${status} outbound=${sends.length} body=${responseText.slice(0, 300)}\n${sendSummary}`,
    );
  },
});

addEventListener("unload", () => {
  mailer?.proc.kill();
});
