/**
 * Spec for supabase/functions/send-contact-email/index.ts.
 *
 * These tests fail while the legacy handler sends mail for any caller, with
 * no body cap, no per-source rate limit, and no suppression check. They pass
 * when that handler:
 * - accepts only the service-role credential from SUPABASE_SERVICE_ROLE_KEY
 * - rejects a message longer than 8192 characters before any send
 * - allows at most one submission per source, even under concurrent requests
 *   and even when each request names a different recipient
 * - never asks Resend to deliver to an address listed in suppressed_emails
 * - still sends the office notification and the confirmation for one
 *   authorized, unsuppressed, normal-sized submission
 *
 * Run (the suite is expected to fail until the handler is fixed):
 *   deno test --no-lock --allow-net --allow-env --allow-read --allow-write --allow-run tests/send_contact_email_flood_test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";

const FUNCTION_URL = "http://127.0.0.1:8000/";
const SERVICE_ROLE_KEY = "test-service-role-key-placeholder";
const ANON_KEY = "anon-publishable-key-placeholder";
const SUPABASE_URL = "http://suppression.test";
const SUPPRESSED_EMAIL = "suppressed-recipient@example.com";
const OFFICE_EMAIL = "aj@bmbpalmbeach.com";
const MAX_MESSAGE_CHARS = 8192;
const MAX_RESEND_CALLS_PER_SOURCE = 2;

const REPO_ROOT = new URL("../", import.meta.url);
const HARNESS = new URL("./support/send_contact_email_server.ts", import.meta.url);

interface ResendCall {
  url: string;
  method: string;
  body: string;
  payload: {
    to?: string[];
    subject?: string;
    html?: string;
    from?: string;
  };
}

interface RunningServer {
  child: Deno.ChildProcess;
  capturePath: string;
  stop: () => Promise<void>;
  calls: () => Promise<ResendCall[]>;
}

let gate: Promise<void> = Promise.resolve();

function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = gate.then(fn, fn);
  gate = run.then(() => {}, () => {});
  return run;
}

function serviceHeaders(): HeadersInit {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    apikey: SERVICE_ROLE_KEY,
  };
}

function anonHeaders(): HeadersInit {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${ANON_KEY}`,
    apikey: ANON_KEY,
  };
}

async function startServer(): Promise<RunningServer> {
  const capturePath = await Deno.makeTempFile({ prefix: "resend-capture-", suffix: ".ndjson" });
  await Deno.writeTextFile(capturePath, "");
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-lock", "--allow-net", "--allow-env", "--allow-read", "--allow-write", HARNESS.pathname],
    cwd: REPO_ROOT.pathname,
    env: {
      PATH: Deno.env.get("PATH") ?? "",
      HOME: Deno.env.get("HOME") ?? "",
      RESEND_API_KEY: "test-resend-key-placeholder",
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
      SUPABASE_URL,
      SUPPRESSED_EMAILS: SUPPRESSED_EMAIL,
      RESEND_CAPTURE_PATH: capturePath,
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const output: string[] = [];
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const text = await new Response(stream).text();
    if (text) output.push(text);
  };
  const stdoutDone = collect(child.stdout);
  const stderrDone = collect(child.stderr);

  const exitState: { status: Deno.CommandStatus | null } = { status: null };
  child.status.then((status) => {
    exitState.status = status;
  });

  const deadline = Date.now() + 45_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (exitState.status) {
      await Promise.all([stdoutDone, stderrDone]);
      throw new Error(
        `send-contact-email exited before listening (${exitState.status.code}): ${output.join("\n")}`,
      );
    }
    try {
      const probe = await fetch(FUNCTION_URL, { method: "OPTIONS" });
      await probe.body?.cancel();
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!ready) {
    child.kill("SIGKILL");
    await child.status;
    await Promise.all([stdoutDone, stderrDone]);
    throw new Error(`send-contact-email did not listen on ${FUNCTION_URL}: ${output.join("\n")}`);
  }

  return {
    child,
    capturePath,
    stop: async () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
      await child.status;
      await Promise.all([stdoutDone, stderrDone]);
      try {
        await Deno.remove(capturePath);
      } catch {
        // already removed
      }
    },
    calls: async () => {
      const raw = await Deno.readTextFile(capturePath);
      return raw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          const parsed = JSON.parse(line) as { url: string; method: string; body: string };
          let payload: ResendCall["payload"] = {};
          try {
            payload = JSON.parse(parsed.body);
          } catch {
            payload = {};
          }
          return { ...parsed, payload };
        });
    },
  };
}

async function post(body: unknown, headers: HeadersInit): Promise<Response> {
  return await fetch(FUNCTION_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function targets(calls: ResendCall[], email: string): ResendCall[] {
  return calls.filter((call) =>
    (call.payload.to ?? []).some((recipient) => recipient.toLowerCase() === email.toLowerCase())
  );
}

Deno.test("authorized submission still notifies the office and the sender", async () => {
  await exclusive(async () => {
    const server = await startServer();
    try {
      const marker = "authorized-inquiry-marker";
      const response = await post(
        {
          firstName: "Ada",
          lastName: "Lovelace",
          email: "ada@example.com",
          message: marker,
        },
        serviceHeaders(),
      );
      const calls = await server.calls();
      assertEquals(response.status, 200, await response.text());
      assertEquals(calls.length, 2, JSON.stringify(calls.map((call) => call.payload.to)));
      assertEquals(targets(calls, OFFICE_EMAIL).length, 1);
      assertEquals(targets(calls, "ada@example.com").length, 1);
      assert(
        calls.some((call) => (call.payload.html ?? "").includes(marker)),
        "the submitted message was not included in a Resend payload",
      );
      assert(
        calls.every((call) => call.method === "POST" && call.url === "https://api.resend.com/emails"),
        "mail was not sent through Resend's email create endpoint",
      );
    } finally {
      await server.stop();
    }
  });
});

Deno.test("publishable anon key cannot flood the office or the supplied address", async () => {
  await exclusive(async () => {
    const server = await startServer();
    try {
      const attempts = 8;
      const responses = await Promise.all(
        Array.from({ length: attempts }, (_, index) =>
          post(
            {
              firstName: "Flood",
              lastName: "Script",
              email: `flood-${index}@example.com`,
              message: `attacker-controlled-marker-${index}`,
            },
            anonHeaders(),
          )
        ),
      );
      const calls = await server.calls();
      const bodies = await Promise.all(responses.map((response) => response.text()));
      assertEquals(
        calls.length,
        0,
        `anon caller caused ${calls.length} Resend calls. First payload to=${JSON.stringify(calls[0]?.payload.to)} htmlHasMarker=${(calls[0]?.payload.html ?? "").includes("attacker-controlled-marker")}`,
      );
      responses.forEach((response, index) => {
        const success = response.status === 200 && bodies[index].includes('"success":true');
        assert(!success, `anon attempt ${index} was accepted: ${response.status} ${bodies[index]}`);
      });
    } finally {
      await server.stop();
    }
  });
});

Deno.test("a request with no credentials cannot send mail", async () => {
  await exclusive(async () => {
    const server = await startServer();
    try {
      const response = await post(
        {
          firstName: "No",
          lastName: "Auth",
          email: "no-auth@example.com",
          message: "unauthenticated-marker",
        },
        { "content-type": "application/json" },
      );
      const calls = await server.calls();
      const body = await response.text();
      assertEquals(calls.length, 0, `unauthenticated request caused Resend calls: ${JSON.stringify(calls.map((call) => call.payload.to))}`);
      assert(!(response.status === 200 && body.includes('"success":true')), body);
    } finally {
      await server.stop();
    }
  });
});

Deno.test("style-book inquiry from an anon caller cannot send mail", async () => {
  await exclusive(async () => {
    const server = await startServer();
    try {
      const response = await post(
        {
          firstName: "Style",
          email: "style-book@example.com",
          source: "style-book",
          style: "Mediterranean",
        },
        anonHeaders(),
      );
      const calls = await server.calls();
      const body = await response.text();
      assertEquals(calls.length, 0, `style-book anon call caused Resend calls: ${JSON.stringify(calls.map((call) => call.payload.to))}`);
      assert(!(response.status === 200 && body.includes('"success":true')), body);
    } finally {
      await server.stop();
    }
  });
});

Deno.test("one source cannot send through a burst of distinct recipients", async () => {
  await exclusive(async () => {
    const server = await startServer();
    try {
      const attempts = 12;
      const responses = await Promise.all(
        Array.from({ length: attempts }, (_, index) =>
          post(
            {
              firstName: "Burst",
              lastName: "Sender",
              email: `burst-${index}@example.com`,
              message: `burst-marker-${index}`,
            },
            serviceHeaders(),
          )
        ),
      );
      await Promise.all(responses.map((response) => response.body?.cancel() ?? Promise.resolve()));
      const calls = await server.calls();
      assert(
        calls.length <= MAX_RESEND_CALLS_PER_SOURCE,
        `expected at most ${MAX_RESEND_CALLS_PER_SOURCE} Resend calls for one source, got ${calls.length} across recipients ${JSON.stringify(calls.map((call) => call.payload.to))}`,
      );
      assert(
        calls.length >= 1,
        "the one allowed submission did not reach Resend",
      );
    } finally {
      await server.stop();
    }
  });
});

Deno.test("an oversized message is rejected before Resend is called", async () => {
  await exclusive(async () => {
    const server = await startServer();
    try {
      const response = await post(
        {
          firstName: "Large",
          lastName: "Body",
          email: "large-body@example.com",
          message: "A".repeat(MAX_MESSAGE_CHARS + 1),
        },
        serviceHeaders(),
      );
      const calls = await server.calls();
      const body = await response.text();
      assertEquals(calls.length, 0, "oversized body reached Resend");
      assert(response.status >= 400 && response.status < 500, `expected a 4xx rejection, got ${response.status} ${body}`);
    } finally {
      await server.stop();
    }
  });
});

Deno.test("a suppressed recipient is not emailed and the office still is", async () => {
  await exclusive(async () => {
    const server = await startServer();
    try {
      const response = await post(
        {
          firstName: "Blocked",
          lastName: "Recipient",
          email: SUPPRESSED_EMAIL,
          message: "suppressed-recipient-marker",
        },
        serviceHeaders(),
      );
      const calls = await server.calls();
      await response.body?.cancel();
      assertEquals(
        targets(calls, SUPPRESSED_EMAIL).length,
        0,
        `suppressed address was included in a Resend payload: ${JSON.stringify(calls.map((call) => call.payload.to))}`,
      );
      assertEquals(
        targets(calls, OFFICE_EMAIL).length,
        1,
        "the office notification was dropped with the suppressed confirmation",
      );
      assert(
        calls.every((call) => !(call.payload.html ?? "").includes("Thank You, Blocked") || !targets([call], SUPPRESSED_EMAIL).length),
        "confirmation content was sent to the suppressed address",
      );
    } finally {
      await server.stop();
    }
  });
});
