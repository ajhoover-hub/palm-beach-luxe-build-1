/**
 * Renders the contact form and the Style Book inquiry form and submits them
 * through the real send-transactional-email function. @supabase/functions-js
 * 2.91.0 (the version locked for the browser client) is the invoke
 * implementation. A suppressed fixed office recipient must still be queued,
 * because these forms navigate to the thank-you page whenever invoke returns
 * a null error.
 */
import { JSDOM } from "npm:jsdom@25.0.1"
import { createRoot } from "react-dom/client"
import { act, type ReactNode } from "react"
import { HelmetProvider } from "react-helmet-async"
import { MemoryRouter } from "react-router-dom"
import { startStandIn } from "./postgrest-stand-in.ts"

const DENO = Deno.execPath()
const ROOT = new URL("..", import.meta.url).pathname
const STANDIN_PORT = 8766
const FUNCTION_PORT = 8000
const STANDIN_URL = `http://127.0.0.1:${STANDIN_PORT}`
const FUNCTION_URL = `http://127.0.0.1:${FUNCTION_PORT}`

Deno.env.set("LEAD_FUNCTION_URL", FUNCTION_URL)

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { url: "http://localhost/" })
const windowRef = dom.window
Object.assign(globalThis, {
  window: windowRef,
  document: windowRef.document,
  HTMLElement: windowRef.HTMLElement,
  HTMLInputElement: windowRef.HTMLInputElement,
  HTMLTextAreaElement: windowRef.HTMLTextAreaElement,
  HTMLSelectElement: windowRef.HTMLSelectElement,
  HTMLFormElement: windowRef.HTMLFormElement,
  Element: windowRef.Element,
  Node: windowRef.Node,
  navigator: windowRef.navigator,
  Event: windowRef.Event,
  InputEvent: windowRef.InputEvent,
  getComputedStyle: windowRef.getComputedStyle.bind(windowRef),
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  MutationObserver: windowRef.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
})
windowRef.innerWidth = 1280
windowRef.innerHeight = 900
class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}
windowRef.IntersectionObserver = IntersectionObserverStub
globalThis.IntersectionObserver = IntersectionObserverStub as unknown as typeof IntersectionObserver
windowRef.matchMedia = (query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() {
    return false
  },
})

const { default: Contact } = await import("../src/pages/Contact.tsx")
const { default: Projects } = await import("../src/pages/Projects.tsx")

function spawnSendFunction() {
  const command = new Deno.Command(DENO, {
    args: [
      "run",
      "--node-modules-dir=none",
      "--allow-net",
      "--allow-env",
      "supabase/functions/send-transactional-email/index.ts",
    ],
    cwd: ROOT,
    env: {
      PATH: Deno.env.get("PATH") ?? "",
      HOME: Deno.env.get("HOME") ?? "",
      TMPDIR: Deno.env.get("TMPDIR") ?? "/tmp",
      SUPABASE_URL: STANDIN_URL,
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    },
    stdout: "piped",
    stderr: "piped",
  })
  const process = command.spawn()
  process.stdout.cancel().catch(() => {})
  process.stderr.cancel().catch(() => {})
  return {
    kill: () => {
      try {
        process.kill("SIGKILL")
      } catch {
        // already exited
      }
    },
  }
}

async function waitForHttp(url: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(url)
      if (response.status < 500) return
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for ${url}`)
}

async function suppressOffice(email: string) {
  await fetch(`${STANDIN_URL}/rest/v1/suppressed_emails`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, reason: "unsubscribe" }),
  })
  await fetch(`${STANDIN_URL}/rest/v1/email_unsubscribe_tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "used-office-token-form",
      email,
      used_at: new Date().toISOString(),
    }),
  })
}

async function setField(id: string, value: string) {
  const field = document.getElementById(id) as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) & {
    [key: string]: { onChange?: (event: { target: EventTarget }) => void }
  } | null
  if (!field) throw new Error(`missing field ${id}`)
  const prototype = field instanceof windowRef.HTMLTextAreaElement
    ? windowRef.HTMLTextAreaElement.prototype
    : field instanceof windowRef.HTMLSelectElement
    ? windowRef.HTMLSelectElement.prototype
    : windowRef.HTMLInputElement.prototype
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value")
  const propsKey = Object.keys(field).find((key) => key.startsWith("__reactProps$"))
  const onChange = propsKey ? field[propsKey]?.onChange : undefined
  if (!onChange) throw new Error(`field ${id} has no change handler`)
  await act(async () => {
    descriptor?.set?.call(field, value)
    onChange({ target: field })
  })
}

async function render(node: ReactNode) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <HelmetProvider>
        <MemoryRouter>{node}</MemoryRouter>
      </HelmetProvider>,
    )
  })
  return {
    cleanup: async () => {
      await act(async () => root.unmount())
      container.remove()
    },
  }
}

Deno.test({
  name: "contact and style book forms still deliver a suppressed office notification",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const standin = startStandIn(STANDIN_PORT)
    const server = spawnSendFunction()
    try {
      await waitForHttp(FUNCTION_URL)
      const office = "aj@bmbpalmbeach.com"
      await suppressOffice(office)

      const contact = await render(<Contact />)
      await setField("firstName", "Ada")
      await setField("lastName", "Lovelace")
      await setField("email", "ada@example.com")
      await setField("message", "contact-form-still-delivered")
      await setField("projectType", "New custom home")
      const contactForm = document.querySelector("form")
      if (!contactForm) throw new Error("contact form was not rendered")
      await act(async () => {
        ;(contactForm as HTMLFormElement).requestSubmit()
        await new Promise((resolve) => setTimeout(resolve, 400))
      })
      await contact.cleanup()

      const projects = await render(<Projects />)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
      })
      await setField("inq-name", "Grace Hopper")
      await setField("inq-email", "grace@example.com")
      await setField("inq-note", "style-form-still-delivered")
      const inquiry = Array.from(document.querySelectorAll("form")).find((form) => form.querySelector("#inq-email"))
      if (!inquiry) throw new Error("style book inquiry form was not rendered")
      await act(async () => {
        ;(inquiry as HTMLFormElement).requestSubmit()
        await new Promise((resolve) => setTimeout(resolve, 400))
      })
      await projects.cleanup()

      await new Promise((resolve) => setTimeout(resolve, 300))
      const snapshot = await (await fetch(`${STANDIN_URL}/test/state`)).json()
      const queued = snapshot.queues.transactional_emails.map((message: { message: Record<string, unknown> }) => message.message)
      const contactLead = queued.find((message: Record<string, unknown>) =>
        message.template_name === undefined && String(message.html ?? message.subject ?? "").includes("contact-form-still-delivered")
          || String(message.subject ?? "").includes("Ada Lovelace")
          || String(message.html ?? "").includes("contact-form-still-delivered")
      )
      const styleLead = queued.find((message: Record<string, unknown>) =>
        String(message.html ?? "").includes("style-form-still-delivered") || String(message.subject ?? "").includes("Grace Hopper")
      )
      const officeLeads = queued.filter((message: Record<string, unknown>) => message.to === office && message.label !== undefined || message.to === office)
      if (!contactLead || contactLead.to !== office || typeof contactLead.unsubscribe_token === "string") {
        throw new Error(`contact form did not queue an office notification without an unsubscribe token while the office address was suppressed. queued=${queued.length}`)
      }
      if (!styleLead || styleLead.to !== office || typeof styleLead.unsubscribe_token === "string") {
        throw new Error(`style book form did not queue an office notification without an unsubscribe token while the office address was suppressed. queued office messages: ${officeLeads.length}`)
      }
    } finally {
      server.kill()
      await standin.stop()
    }
  },
})
