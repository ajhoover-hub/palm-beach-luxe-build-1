// Test entry: load the real queue worker with fetch pointed at the in-memory
// PostgREST stand-in, and record the JSON body the real sendLovableEmail posts.
// prepare-uploads answers 204 so the SDK sends the message inline. That is the
// branch in @lovable.dev/email-js where a 204 skips the upload and the
// following POST body is the full request, including any unsubscribe_token.

const capturePath = Deno.env.get("EMAIL_CAPTURE_PATH")
if (!capturePath) throw new Error("EMAIL_CAPTURE_PATH is required")

const realFetch = globalThis.fetch
const captured: unknown[] = []

globalThis.fetch = async (input: Request | URL | string, init?: RequestInit) => {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
    ? input.toString()
    : input.url
  if (url.includes("/v1/messaging/email/prepare-uploads")) {
    return new Response(null, { status: 204 })
  }
  if (url.includes("/v1/messaging/email/send")) {
    const raw = typeof init?.body === "string" ? init.body : ""
    captured.push(raw ? JSON.parse(raw) : null)
    await Deno.writeTextFile(capturePath, JSON.stringify(captured))
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  return realFetch(input, init)
}

await import("../supabase/functions/process-email-queue/index.ts")
