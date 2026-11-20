/**
 * Spec for the contact-email HTML injection.
 *
 * These tests call the real send-contact-email handler. The Resend SDK runs
 * unchanged and posts to a local sink (RESEND_BASE_URL). They fail while user
 * fields are copied into HTML or the subject, or while a handler failure
 * returns the raw exception text.
 *
 * Run:
 *   deno test --no-lock --allow-net --allow-run --allow-env --allow-read supabase/functions/send-contact-email/html_injection_test.ts
 */
import * as parse5 from "npm:parse5@7.2.1";
import { assert, assertEquals } from "jsr:@std/assert@1.0.7";

const FUNCTION_URL = "http://127.0.0.1:8000/";
const OFFICE = "aj@bmbpalmbeach.com";
const ATTACK_URL = "https://evil.example/phish";
const PROVIDER_SENTINEL = "LEAKTOKEN";

const LINK = `<a href="${ATTACK_URL}">Review the plans</a>`;
const IMAGE = `<img src="${ATTACK_URL}" alt="inquiry">`;

interface SentEmail {
  from?: string;
  to?: string[];
  subject?: string;
  html?: string;
}

const sent: SentEmail[] = [];
let failNextProviderResponse = false;

const sink = Deno.serve(
  { port: 0, hostname: "127.0.0.1", onListen() {} },
  async (request) => {
    const body = await request.text();
    let parsed: SentEmail = {};
    try {
      parsed = JSON.parse(body) as SentEmail;
    } catch {
      parsed = {};
    }
    sent.push(parsed);
    if (
      failNextProviderResponse ||
      body.includes(PROVIDER_SENTINEL)
    ) {
      failNextProviderResponse = false;
      return new Response(PROVIDER_SENTINEL, {
        status: 500,
        headers: { "content-type": "text/plain" },
      });
    }
    return Response.json({ id: "email_test_placeholder" });
  },
);

const sinkPort = sink.addr.port;
const logs: string[] = [];
const child = new Deno.Command(Deno.execPath(), {
  args: [
    "run",
    "--no-lock",
    "--allow-net=0.0.0.0:8000,127.0.0.1,localhost,deno.land,esm.sh",
    "--allow-env",
    new URL("./index.ts", import.meta.url).pathname,
  ],
  clearEnv: true,
  env: {
    RESEND_API_KEY: "placeholder-not-a-real-key",
    RESEND_BASE_URL: `http://127.0.0.1:${sinkPort}`,
    HOME: Deno.env.get("HOME") ?? "",
    PATH: Deno.env.get("PATH") ?? "",
    DENO_DIR: Deno.env.get("DENO_DIR") ?? "",
  },
  stdout: "piped",
  stderr: "piped",
}).spawn();

const decodeStream = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    logs.push(decoder.decode(value));
  }
};
const stdoutPump = decodeStream(child.stdout);
const stderrPump = decodeStream(child.stderr);

function placeholderAnonAuthorization(): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("=", "").replaceAll("+", "-")
      .replaceAll("/", "_");
  const token = [
    encode({ alg: "HS256", typ: "JWT" }),
    encode({ role: "anon", iss: "supabase" }),
    "placeholder-signature",
  ].join(".");
  return `Bearer ${token}`;
}

async function waitForFunction(): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(FUNCTION_URL, { method: "OPTIONS" });
      await response.body?.cancel();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(
    `send-contact-email did not listen on ${FUNCTION_URL}: ${lastError}\n${logs.join("")}`,
  );
}

function activeMarkup(html: string): string[] {
  const document = parse5.parse(html) as parse5.DefaultTreeAdapterMap["document"];
  const problems: string[] = [];
  const blocked = new Set([
    "img",
    "script",
    "iframe",
    "object",
    "embed",
    "svg",
    "math",
    "link",
    "meta",
    "form",
    "base",
    "video",
    "source",
    "picture",
    "style",
  ]);
  const walk = (node: parse5.DefaultTreeAdapterMap["node"]) => {
    if ("tagName" in node) {
      const tag = node.tagName.toLowerCase();
      if (blocked.has(tag)) problems.push(`<${tag}>`);
      for (const attribute of node.attrs) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value;
        if (name.startsWith("on")) problems.push(`${tag} ${name}`);
        if (name === "src") problems.push(`${tag} src`);
        if (name === "href") {
          if (!/^(mailto:|tel:)/i.test(value)) {
            problems.push(`${tag} href is not mailto or tel`);
          }
          const rest = value.replace(/^(mailto:|tel:)/i, "");
          if (/["'<>\r\n]/.test(rest) || /https?:/i.test(rest)) {
            problems.push(`${tag} href=${value}`);
          }
        }
      }
    }
    if ("childNodes" in node) {
      for (const child of node.childNodes) walk(child);
    }
  };
  walk(document);
  return problems;
}

function assertOutboundIsInert(messages: SentEmail[]) {
  for (const message of messages) {
    const html = message.html ?? "";
    const problems = activeMarkup(html);
    assert(
      problems.length === 0,
      `outbound HTML still contains attacker markup (${problems.join(", ")}): ${html}`,
    );
    assert(
      !/[\r\n]/.test(message.subject ?? ""),
      `subject still contains a newline: ${JSON.stringify(message.subject)}`,
    );
  }
}

function messagesAfter(index: number): SentEmail[] {
  return sent.slice(index);
}

await waitForFunction();

const unsanitized = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name: "contact fields are not active HTML in the office or confirmation email",
  ...unsanitized,
  async fn() {
  const before = sent.length;
  const response = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: placeholderAnonAuthorization(),
    },
    body: JSON.stringify({
      firstName: `Ava\r\nBcc: phish@evil.example ${IMAGE}`,
      lastName: `Stone ${LINK}`,
      email: `client@example.com"><img src="${ATTACK_URL}">`,
      phone: `5615550100"><img src="${ATTACK_URL}">`,
      message: `${LINK}${IMAGE}`,
      projectType: `Renovation ${IMAGE}`,
      timeline: `Soon ${LINK}`,
      ownsLot: `Yes ${IMAGE}`,
      investmentRange: `$1 ${LINK}`,
    }),
  });
  const body = await response.text();
  const messages = messagesAfter(before);
  if (response.status >= 400) {
    assertEquals(
      messages.length,
      0,
      `handler refused the request after sending email: ${body}`,
    );
    return;
  }
  assert(
    messages.some((message) => message.to?.includes(OFFICE)),
    `accepted contact did not notify ${OFFICE}. status=${response.status} body=${body}`,
  );
  assert(
    messages.length >= 2,
    "accepted contact did not send both the office notification and the confirmation",
  );
  assertOutboundIsInert(messages);
  },
});

Deno.test({
  name: "style-book fields are not active HTML in either email",
  ...unsanitized,
  async fn() {
  const before = sent.length;
  const response = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: placeholderAnonAuthorization(),
    },
    body: JSON.stringify({
      source: "style-book",
      firstName: `Ava\r\nBcc: phish@evil.example ${IMAGE}`,
      email: "client@example.com",
      phone: `5615550100"><img src="${ATTACK_URL}">`,
      style: `Coastal ${LINK}${IMAGE}`,
      projectType: IMAGE,
      timeline: LINK,
      ownsLot: IMAGE,
      investmentRange: LINK,
    }),
  });
  const body = await response.text();
  const messages = messagesAfter(before);
  if (response.status >= 400) {
    assertEquals(messages.length, 0, `refused style-book request after sending: ${body}`);
    return;
  }
  assert(
    messages.some((message) => message.to?.includes(OFFICE)),
    `accepted style-book inquiry did not notify ${OFFICE}. body=${body}`,
  );
  assertOutboundIsInert(messages);
  },
});

Deno.test({
  name: "handler failures do not return the raw exception text",
  ...unsanitized,
  async fn() {
  const before = sent.length;
  let parserMessage = "";
  try {
    JSON.parse("{");
  } catch (error) {
    parserMessage = error instanceof Error ? error.message : String(error);
  }
  assert(parserMessage.length > 0);

  const invalid = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: placeholderAnonAuthorization(),
    },
    body: "{",
  });
  const invalidBody = await invalid.text();
  assert(invalid.status >= 400, `invalid JSON was accepted: ${invalidBody}`);
  assert(
    !invalidBody.includes(parserMessage),
    `invalid JSON response returned the parser exception: ${invalidBody}`,
  );
  assertEquals(messagesAfter(before).length, 0);
  },
});

Deno.test({
  name: "provider failures do not return the raw exception text",
  ...unsanitized,
  async fn() {
  const provider = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: placeholderAnonAuthorization(),
    },
    body: JSON.stringify({
      firstName: "Ava",
      lastName: "Stone",
      email: "client@example.com",
      message: PROVIDER_SENTINEL,
    }),
  });
  const providerBody = await provider.text();
  assert(provider.status >= 400, `provider failure was reported as success: ${providerBody}`);
  assert(
    !providerBody.includes(PROVIDER_SENTINEL) && !providerBody.includes("not valid JSON"),
    `provider failure response included the upstream error: ${providerBody}`,
  );
  },
});

addEventListener("unload", () => {
  try {
    child.kill("SIGTERM");
  } catch {
    // The child has already exited.
  }
  sink.shutdown();
});

void stdoutPump;
void stderrPump;
