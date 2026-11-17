// Google Ads conversion tracking for bmbpalmbeach.com.
// Inert unless a public ID is hard-coded below or supplied as VITE_GADS_*.
// Every event is also pushed to window.dataLayer (pb_form_submit / pb_click_to_call).
import { pushDataLayer } from "@/lib/gtm";

type Gtag = (...args: unknown[]) => void;

declare global {
  interface Window {
    gtag?: Gtag;
  }
}

/**
 * Public Google Ads IDs. Lovable has no environment variables, so these are
 * hard-coded. GTM_ID_PUBLIC stays empty in src/lib/gtm.ts.
 * GADS_FORM_LABEL_PUBLIC is action 7906689044, Palm Beach - Contact form submission.
 * GADS_CALL_LABEL_PUBLIC is action 7906689578, Palm Beach - Click to call (website).
 */
const GADS_ID_PUBLIC = "AW-1000292937";
const GADS_FORM_LABEL_PUBLIC = "Yl7DCJSAmrodEMmE_dwD";
const GADS_CALL_LABEL_PUBLIC = "7dlICKqEmrodEMmE_dwD";

const ADS_ID = import.meta.env.VITE_GADS_ID ?? GADS_ID_PUBLIC ?? "";
const FORM_LABEL = import.meta.env.VITE_GADS_FORM_LABEL ?? GADS_FORM_LABEL_PUBLIC ?? "";
const CALL_LABEL = import.meta.env.VITE_GADS_CALL_LABEL ?? GADS_CALL_LABEL_PUBLIC ?? "";

let tagLoaded = false;
let telListenerInstalled = false;

function gtag(...args: unknown[]): void {
  if (typeof window === "undefined") return;
  if (!window.gtag) {
    window.dataLayer = window.dataLayer ?? [];
    window.gtag = function () {
      // eslint-disable-next-line prefer-rest-params
      (window.dataLayer as unknown[]).push(arguments);
    };
  }
  window.gtag(...args);
}

function isBrowser(): boolean {
  return !import.meta.env.SSR && typeof window !== "undefined" && typeof document !== "undefined";
}

export function initGoogleAdsTag(): void {
  if (!isBrowser() || tagLoaded || !ADS_ID) return;
  const src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(ADS_ID)}`;
  if (document.querySelector(`script[src="${src}"]`)) {
    tagLoaded = true;
    return;
  }
  tagLoaded = true;
  const script = document.createElement("script");
  script.async = true;
  script.src = src;
  document.head.appendChild(script);
  gtag("js", new Date());
  gtag("config", ADS_ID);
}

function sendConversion(label: string | undefined, extra: Record<string, unknown> = {}): void {
  if (!ADS_ID || !label) return;
  gtag("event", "conversion", { send_to: `${ADS_ID}/${label}`, ...extra });
}

export function trackFormConversion(form: string): void {
  if (!isBrowser()) return;
  const key = `pb_conv_form_${form}`;
  try {
    if (window.sessionStorage.getItem(key)) return;
    window.sessionStorage.setItem(key, "1");
  } catch {
    /* fire anyway */
  }
  pushDataLayer({ event: "pb_form_submit", form_name: form });
  sendConversion(FORM_LABEL);
}

export function installTelClickTracking(): void {
  if (!isBrowser() || telListenerInstalled) return;
  telListenerInstalled = true;
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target as Element | null;
      const link = target?.closest?.('a[href^="tel:"]') as HTMLAnchorElement | null;
      if (!link) return;
      const phone = link.getAttribute("href")?.slice(4) ?? "";
      pushDataLayer({
        event: "pb_click_to_call",
        phone_number: phone,
        page_path: window.location.pathname,
      });
      sendConversion(CALL_LABEL, { transport_type: "beacon" });
    },
    true,
  );
}
