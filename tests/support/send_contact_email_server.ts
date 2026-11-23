/**
 * Boots the real send-contact-email handler.
 *
 * Resend's client posts to https://api.resend.com (resend@2.0.0). Those calls
 * are recorded and answered locally so the test never contacts Resend.
 * Lookups of suppressed_emails are answered the way postgrest-js 2.91.0
 * reads a GET maybeSingle() result: a JSON array, empty when the address is
 * not listed.
 */
const capturePath = Deno.env.get("RESEND_CAPTURE_PATH");
if (!capturePath) {
  throw new Error("RESEND_CAPTURE_PATH is required");
}

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const suppressed = new Set(
  (Deno.env.get("SUPPRESSED_EMAILS") ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0),
);

const originalFetch = globalThis.fetch.bind(globalThis);
let writeChain: Promise<void> = Promise.resolve();

function record(entry: { url: string; method: string; body: string }): Promise<void> {
  const line = JSON.stringify(entry) + "\n";
  writeChain = writeChain.then(() =>
    Deno.writeTextFile(capturePath!, line, { append: true })
  );
  return writeChain;
}

globalThis.fetch = async (
  input: Request | URL | string,
  init?: RequestInit,
): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();

  if (url.startsWith("https://api.resend.com/")) {
    let body = "";
    if (typeof init?.body === "string") {
      body = init.body;
    } else if (init?.body != null) {
      body = String(init.body);
    } else if (input instanceof Request) {
      body = await input.clone().text();
    }
    await record({ url, method, body });
    return new Response(JSON.stringify({ id: "resend-placeholder-id" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  if (supabaseUrl && url.startsWith(supabaseUrl) && url.includes("/rest/v1/suppressed_emails")) {
    const parsed = new URL(url);
    const haystack = decodeURIComponent(parsed.search).toLowerCase();
    const listed = [...suppressed].some((email) => haystack.includes(email));
    const rows = listed ? [{ id: "suppressed-row" }] : [];
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  return originalFetch(input as RequestInfo, init);
};

await import("../../supabase/functions/send-contact-email/index.ts");
