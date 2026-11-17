type DataLayerEvent = Record<string, unknown>;

declare global {
  interface Window {
    dataLayer?: DataLayerEvent[];
  }
}

const GTM_SCRIPT_BASE = "https://www.googletagmanager.com/gtm.js";

/**
 * Public GTM container ID.
 * Lovable has no environment variables, so the live ID can be hard-coded here.
 * Leave this empty to keep the loader inert.
 */
const GTM_ID_PUBLIC = "";

export function pushDataLayer(event: DataLayerEvent): void {
  window.dataLayer = window.dataLayer ?? [];
  window.dataLayer.push(event);
}

/**
 * Loads Google Tag Manager only when a container ID is present.
 * With the ID empty, nothing is injected and no container request is made.
 */
export function initGTM(): void {
  const id = import.meta.env.VITE_GTM_ID ?? GTM_ID_PUBLIC ?? "";
  if (!id || typeof document === "undefined") return;

  const src = `${GTM_SCRIPT_BASE}?id=${encodeURIComponent(id)}`;
  if (document.querySelector(`script[src="${src}"]`)) return;

  pushDataLayer({ "gtm.start": Date.now(), event: "gtm.js" });

  const script = document.createElement("script");
  script.async = true;
  script.src = src;
  document.head.appendChild(script);
}
