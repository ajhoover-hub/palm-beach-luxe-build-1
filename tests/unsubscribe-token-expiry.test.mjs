import assert from "node:assert/strict";
import test from "node:test";
import {
  installClient,
  loadUnsubscribeHandler,
  MAX_UNUSED_TOKEN_AGE_MS,
} from "./support/unsubscribe-function-harness.mjs";

const OLD_TOKEN = "OLD_UNSUBSCRIBE_TOKEN_PLACEHOLDER";
const OTHER_TOKEN = "OTHER_UNSUBSCRIBE_TOKEN_PLACEHOLDER";
const FRESH_TOKEN = "FRESH_UNSUBSCRIBE_TOKEN_PLACEHOLDER";
const OLD_EMAIL = "old-recipient@example.com";
const OTHER_EMAIL = "other-recipient@example.com";
const FRESH_EMAIL = "fresh-recipient@example.com";

function storeWith(token, email, createdAt) {
  return {
    email_unsubscribe_tokens: [
      {
        token,
        email,
        created_at: createdAt,
        used_at: null,
      },
      {
        token: OTHER_TOKEN,
        email: OTHER_EMAIL,
        created_at: new Date().toISOString(),
        used_at: null,
      },
    ],
    suppressed_emails: [],
  };
}

function problemsFor(state, body, token, email) {
  const problems = [];
  if (body?.success === true || body?.valid === true) problems.push("accepted the token");
  const row = state.email_unsubscribe_tokens.find((item) => item.token === token);
  if (row?.used_at) problems.push("marked the token used");
  if (state.suppressed_emails.some((item) => item.email === email)) {
    problems.push("added the address to the suppression list");
  }
  const other = state.email_unsubscribe_tokens.find((item) => item.token === OTHER_TOKEN);
  if (other?.used_at) problems.push("marked a different token used");
  if (state.suppressed_emails.some((item) => item.email === OTHER_EMAIL)) {
    problems.push("suppressed a different address");
  }
  return problems;
}

async function call(handler, request) {
  const response = await handler(request);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

test("an unused unsubscribe token older than 30 days is refused with no suppression", async () => {
  const handler = await loadUnsubscribeHandler();
  const createdAt = new Date(Date.now() - MAX_UNUSED_TOKEN_AGE_MS - 60 * 60 * 1000).toISOString();
  const cases = [
    {
      name: "json post",
      request: new Request("http://127.0.0.1/functions/v1/handle-email-unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: OLD_TOKEN }),
      }),
    },
    {
      name: "form post",
      request: new Request("http://127.0.0.1/functions/v1/handle-email-unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: OLD_TOKEN }).toString(),
      }),
    },
    {
      name: "one-click post",
      request: new Request(
        `http://127.0.0.1/functions/v1/handle-email-unsubscribe?token=${encodeURIComponent(OLD_TOKEN)}`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click",
        },
      ),
    },
    {
      name: "query post",
      request: new Request(
        `http://127.0.0.1/functions/v1/handle-email-unsubscribe?token=${encodeURIComponent(OLD_TOKEN)}`,
        { method: "POST" },
      ),
    },
    {
      name: "get",
      request: new Request(
        `http://127.0.0.1/functions/v1/handle-email-unsubscribe?token=${encodeURIComponent(OLD_TOKEN)}`,
        { method: "GET" },
      ),
    },
  ];

  const failures = [];
  for (const entry of cases) {
    const state = storeWith(OLD_TOKEN, OLD_EMAIL, createdAt);
    installClient(state);
    const result = await call(handler, entry.request);
    const problems = problemsFor(state, result.body, OLD_TOKEN, OLD_EMAIL);
    if (problems.length > 0) {
      failures.push(`${entry.name}: ${problems.join(", ")} (status ${result.status})`);
    }
  }
  assert.deepEqual(failures, []);
});

test("a fresh unsubscribe token suppresses only the address stored for that token", async () => {
  const handler = await loadUnsubscribeHandler();
  const state = {
    email_unsubscribe_tokens: [
      {
        token: FRESH_TOKEN,
        email: FRESH_EMAIL,
        created_at: new Date().toISOString(),
        used_at: null,
      },
      {
        token: OTHER_TOKEN,
        email: OTHER_EMAIL,
        created_at: new Date().toISOString(),
        used_at: null,
      },
    ],
    suppressed_emails: [],
  };
  installClient(state);
  const result = await call(
    handler,
    new Request("http://127.0.0.1/functions/v1/handle-email-unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: FRESH_TOKEN }),
    }),
  );
  assert.equal(result.status, 200);
  assert.equal(result.body?.success, true);
  const row = state.email_unsubscribe_tokens.find((item) => item.token === FRESH_TOKEN);
  assert.ok(row?.used_at);
  assert.deepEqual(
    state.suppressed_emails.map((item) => item.email),
    [FRESH_EMAIL],
  );
  const other = state.email_unsubscribe_tokens.find((item) => item.token === OTHER_TOKEN);
  assert.equal(other?.used_at, null);
});
