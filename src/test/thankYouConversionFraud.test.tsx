/**
 * Spec for the unauthenticated thank-you conversion.
 *
 * These tests fail while /thank-you?form=contact and /thank-you?form=stylebook
 * record a Google Ads form conversion with no proof the inquiry was accepted.
 * They pass once a conversion is sent only after send-transactional-email
 * accepts the inquiry and returns a one-time nonce, and the thank-you page
 * redeems that nonce before calling gtag.
 *
 * Contract the page must implement:
 * - The notification invoke (templateName contact-notification or
 *   style-book-notification) is what accepts the inquiry. Its data includes
 *   conversionNonce, conversionForm, and expiresAt. A response without
 *   conversionNonce is not proof, even when success and queued are true.
 * - The thank-you page reads form and nonce from the query string. Before any
 *   form conversion it calls
 *   supabase.functions.invoke("redeem-conversion-nonce", { body: { nonce, form } }).
 * - It may send the form conversion only after that call resolves
 *   { accepted: true, form } for the same form as the query string.
 * - A nonce is single-use. A second redeem, including from a cleared
 *   sessionStorage, resolves { accepted: false } and sends nothing.
 * - The Google Ads form conversion is gtag("event", "conversion", { send_to })
 *   using the hard-coded ads id and form label. pb_form_submit is the same
 *   claim and is held to the same rule.
 *
 * Click-to-call (installTelClickTracking / the call label) is a different
 * event and is not covered here.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import { act } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppRoutes } from "@/App";

const FORM_CONVERSION_LABEL = "Yl7DCJSAmrodEMmE_dwD";

type InquiryForm = "contact" | "stylebook";

type IssuedNonce = {
  nonce: string;
  form: InquiryForm;
  expiresAt: number;
  used: boolean;
};

const h = vi.hoisted(() => {
  const nonces = new Map<string, IssuedNonce>();
  const pendingByTemplate = new Map<string, IssuedNonce>();
  const log: string[] = [];
  const conversions: Array<{ send_to?: string }> = [];
  return { nonces, pendingByTemplate, log, conversions };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: {
      invoke: async (name: string, options?: { body?: Record<string, unknown> }) => {
        if (name === "send-transactional-email") {
          const templateName = String(options?.body?.templateName ?? "");
          const issued = h.pendingByTemplate.get(templateName);
          if (issued) {
            h.pendingByTemplate.delete(templateName);
            return {
              data: {
                success: true,
                queued: true,
                conversionNonce: issued.nonce,
                conversionForm: issued.form,
                expiresAt: new Date(issued.expiresAt).toISOString(),
              },
              error: null,
            };
          }
          return { data: { success: true, queued: true }, error: null };
        }

        if (name === "redeem-conversion-nonce") {
          const body = options?.body ?? {};
          const nonce = typeof body.nonce === "string" ? body.nonce : "";
          const form = body.form === "contact" || body.form === "stylebook" ? body.form : "";
          const rec = h.nonces.get(nonce);
          const accepted = Boolean(
            rec && !rec.used && rec.form === form && rec.expiresAt > Date.now(),
          );
          if (accepted && rec) rec.used = true;
          h.log.push(accepted ? "redeem-accepted" : "redeem-rejected");
          await Promise.resolve();
          return {
            data: accepted ? { accepted: true, form: rec?.form } : { accepted: false },
            error: null,
          };
        }

        return { data: null, error: new Error(`unexpected function ${name}`) };
      },
    },
  },
}));

function issue(form: InquiryForm, templateName: string, expiresAt = Date.now() + 60_000): string {
  const nonce = `issued-${form}-${h.nonces.size + 1}`;
  const rec: IssuedNonce = { nonce, form, expiresAt, used: false };
  h.nonces.set(nonce, rec);
  h.pendingByTemplate.set(templateName, rec);
  return nonce;
}

function adsIdFromTag(): string {
  const script = document.querySelector('script[src*="googletagmanager.com/gtag/js"]');
  if (!(script instanceof HTMLScriptElement)) {
    throw new Error("Google tag script was not inserted");
  }
  return new URL(script.src).searchParams.get("id") ?? "";
}

function formSendTo(): string {
  return `${adsIdFromTag()}/${FORM_CONVERSION_LABEL}`;
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="router-location">{`${location.pathname}${location.search}`}</div>;
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <HelmetProvider>
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <MemoryRouter initialEntries={[path]}>
            <LocationProbe />
            <AppRoutes />
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>
    </HelmetProvider>,
  );
}

function tree(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <HelmetProvider>
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <MemoryRouter initialEntries={[path]}>
            <LocationProbe />
            <AppRoutes />
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>
    </HelmetProvider>
  );
}

async function flush() {
  await act(async () => {
    for (let step = 0; step < 5; step += 1) await Promise.resolve();
  });
}

function recordedSignals(): string[] {
  return h.log.filter((entry) => entry === "conversion" || entry === "pb_form_submit");
}

beforeEach(() => {
  h.log.length = 0;
  h.conversions.length = 0;
  h.nonces.clear();
  h.pendingByTemplate.clear();
  window.sessionStorage.clear();
  window.localStorage.clear();
  const dataLayer: unknown[] = [];
  const push = dataLayer.push.bind(dataLayer);
  dataLayer.push = ((item: unknown) => {
    if (
      item &&
      typeof item === "object" &&
      "event" in item &&
      (item as { event?: unknown }).event === "pb_form_submit"
    ) {
      h.log.push("pb_form_submit");
    }
    return push(item);
  }) as typeof dataLayer.push;
  window.dataLayer = dataLayer as typeof window.dataLayer;
  window.gtag = (...args: unknown[]) => {
    if (args[0] === "event" && args[1] === "conversion") {
      h.log.push("conversion");
      const payload = args[2];
      h.conversions.push(
        payload && typeof payload === "object" ? (payload as { send_to?: string }) : {},
      );
    }
  };
});

afterEach(() => {
  cleanup();
});

describe("thank-you ads conversion", () => {
  it("loads the hard-coded Google Ads tag with the app", () => {
    renderAt("/thank-you");
    expect(adsIdFromTag()).toBe("AW-1000292937");
  });

  it("does not record a contact conversion for an unauthenticated thank-you URL", async () => {
    renderAt("/thank-you?form=contact");
    expect(await screen.findByRole("heading", { name: /thank you/i })).toBeTruthy();
    await flush();
    expect(recordedSignals()).toEqual([]);
  });

  it("does not record a style-book conversion for an unauthenticated thank-you URL", async () => {
    renderAt("/thank-you?form=stylebook");
    expect(await screen.findByRole("heading", { name: /thank you/i })).toBeTruthy();
    await flush();
    expect(recordedSignals()).toEqual([]);
  });

  it("does not record another conversion when a new session opens the same URL", async () => {
    for (const path of ["/thank-you?form=contact", "/thank-you?form=stylebook"]) {
      const first = renderAt(path);
      await flush();
      first.unmount();
      window.sessionStorage.clear();
      renderAt(path);
      await flush();
      cleanup();
    }
    expect(recordedSignals()).toEqual([]);
  });

  it("does not treat a visitor-supplied nonce or storage flag as proof", async () => {
    window.sessionStorage.setItem("pb_form_ok", "1");
    window.sessionStorage.setItem("conversionNonce", "attacker-picked");
    window.localStorage.setItem("pb_conv_form_contact", "1");
    const contact = renderAt("/thank-you?form=contact&nonce=attacker-picked");
    await flush();
    contact.unmount();
    renderAt("/thank-you?form=stylebook&nonce=attacker-picked");
    await flush();
    expect(recordedSignals()).toEqual([]);
    expect(h.log.filter((entry) => entry === "redeem-accepted")).toEqual([]);
  });

  it("does not record a conversion when the email function accepts an inquiry without a nonce", async () => {
    const user = userEvent.setup();
    renderAt("/contact");
    await user.type(screen.getByLabelText(/first name/i), "Ada");
    await user.type(screen.getByLabelText(/last name/i), "Lovelace");
    await user.type(screen.getByLabelText(/direct email/i), "ada@example.com");
    await user.selectOptions(screen.getByLabelText(/project type/i), "New custom home");
    await user.type(screen.getByLabelText(/tell us about your vision/i), "A house on the island.");
    await user.click(screen.getByRole("button", { name: /talk to beau monde/i }));
    expect(await screen.findByRole("heading", { name: /thank you/i })).toBeTruthy();
    await flush();
    expect(recordedSignals()).toEqual([]);
  });

  it("does not record a style-book conversion when that inquiry is accepted without a nonce", async () => {
    const user = userEvent.setup();
    renderAt("/projects");
    const name = await screen.findByLabelText(/^name$/i);
    await user.type(name, "Ada Lovelace");
    await user.type(screen.getByLabelText(/^email$/i), "ada@example.com");
    const submit = document.querySelector("button[type='submit']");
    const form = submit?.closest("form");
    if (!(form instanceof HTMLFormElement)) {
      throw new Error("style-book inquiry form was not rendered");
    }
    fireEvent.submit(form);
    expect(await screen.findByRole("heading", { name: /thank you/i })).toBeTruthy();
    await flush();
    expect(recordedSignals()).toEqual([]);
  });

  it("does not let a contact nonce authorize a style-book URL", async () => {
    const nonce = issue("contact", "contact-notification");
    h.pendingByTemplate.clear();
    renderAt(`/thank-you?form=stylebook&nonce=${encodeURIComponent(nonce)}`);
    await flush();
    expect(recordedSignals()).toEqual([]);
    expect(h.nonces.get(nonce)?.used).toBe(false);
  });

  it("does not record a conversion for an expired nonce", async () => {
    const nonce = issue("contact", "contact-notification", Date.now() - 1_000);
    h.pendingByTemplate.clear();
    renderAt(`/thank-you?form=contact&nonce=${encodeURIComponent(nonce)}`);
    await flush();
    expect(recordedSignals()).toEqual([]);
    expect(h.log.filter((entry) => entry === "redeem-accepted")).toEqual([]);
  });

  it("redeems one server nonce once, including from a second session", async () => {
    const nonce = issue("stylebook", "style-book-notification");
    h.pendingByTemplate.clear();
    const path = `/thank-you?form=stylebook&nonce=${encodeURIComponent(nonce)}`;
    const first = renderAt(path);
    await flush();
    first.unmount();
    window.sessionStorage.clear();
    window.localStorage.clear();
    renderAt(path);
    await flush();
    expect(h.conversions.map((payload) => payload.send_to)).toEqual([formSendTo()]);
    expect(h.log.filter((entry) => entry === "redeem-accepted")).toEqual(["redeem-accepted"]);
    expect(h.log.filter((entry) => entry === "redeem-rejected")).toEqual(["redeem-rejected"]);
    const acceptedAt = h.log.indexOf("redeem-accepted");
    expect(acceptedAt).toBeLessThan(h.log.indexOf("conversion"));
    expect(h.log.findIndex((entry, index) => entry === "pb_form_submit" && index < acceptedAt)).toBe(-1);
  });

  it("sends one contact conversion only after the notification response nonce is redeemed", async () => {
    const nonce = issue("contact", "contact-notification");
    const user = userEvent.setup();
    renderAt("/contact");
    await user.type(screen.getByLabelText(/first name/i), "Ada");
    await user.type(screen.getByLabelText(/last name/i), "Lovelace");
    await user.type(screen.getByLabelText(/direct email/i), "ada@example.com");
    await user.selectOptions(screen.getByLabelText(/project type/i), "New custom home");
    await user.type(screen.getByLabelText(/tell us about your vision/i), "A house on the island.");
    await user.click(screen.getByRole("button", { name: /talk to beau monde/i }));
    expect(await screen.findByRole("heading", { name: /thank you/i })).toBeTruthy();
    await flush();
    expect(screen.getByTestId("router-location").textContent).toContain(
      `nonce=${encodeURIComponent(nonce)}`,
    );
    expect(h.conversions.map((payload) => payload.send_to)).toEqual([formSendTo()]);
    expect(h.log.indexOf("redeem-accepted")).toBeGreaterThanOrEqual(0);
    expect(h.log.indexOf("redeem-accepted")).toBeLessThan(h.log.indexOf("conversion"));
    expect(h.log.filter((entry) => entry === "conversion")).toHaveLength(1);
  });

  it("sends one style-book conversion only after that notification nonce is redeemed", async () => {
    const nonce = issue("stylebook", "style-book-notification");
    const user = userEvent.setup();
    renderAt("/projects");
    await user.type(await screen.findByLabelText(/^name$/i), "Ada Lovelace");
    await user.type(screen.getByLabelText(/^email$/i), "ada@example.com");
    const submit = document.querySelector("button[type='submit']");
    const form = submit?.closest("form");
    if (!(form instanceof HTMLFormElement)) {
      throw new Error("style-book inquiry form was not rendered");
    }
    fireEvent.submit(form);
    expect(await screen.findByRole("heading", { name: /thank you/i })).toBeTruthy();
    await flush();
    expect(screen.getByTestId("router-location").textContent).toContain(
      `nonce=${encodeURIComponent(nonce)}`,
    );
    expect(h.conversions.map((payload) => payload.send_to)).toEqual([formSendTo()]);
    const acceptedAt = h.log.indexOf("redeem-accepted");
    expect(acceptedAt).toBeGreaterThanOrEqual(0);
    expect(acceptedAt).toBeLessThan(h.log.indexOf("conversion"));
    expect(h.log.filter((entry) => entry === "conversion")).toHaveLength(1);
  });

  it("lets only one of two concurrent thank-you loads spend the nonce", async () => {
    const nonce = issue("contact", "contact-notification");
    h.pendingByTemplate.clear();
    const path = `/thank-you?form=contact&nonce=${encodeURIComponent(nonce)}`;
    const firstHost = document.createElement("div");
    const secondHost = document.createElement("div");
    document.body.append(firstHost, secondHost);
    let firstRoot: Root | undefined;
    let secondRoot: Root | undefined;
    await act(async () => {
      firstRoot = createRoot(firstHost);
      secondRoot = createRoot(secondHost);
      firstRoot.render(tree(path));
      secondRoot.render(tree(path));
    });
    await flush();
    expect(h.conversions).toHaveLength(1);
    expect(h.conversions[0]?.send_to).toBe(formSendTo());
    expect(h.log.filter((entry) => entry === "redeem-accepted")).toHaveLength(1);
    expect(h.log.filter((entry) => entry === "redeem-rejected")).toHaveLength(1);
    expect(h.log.indexOf("redeem-accepted")).toBeLessThan(h.log.indexOf("conversion"));
    await act(async () => {
      firstRoot?.unmount();
      secondRoot?.unmount();
    });
    firstHost.remove();
    secondHost.remove();
  });
});
