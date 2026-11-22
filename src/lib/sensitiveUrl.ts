// Query parameters that carry bearer credentials (the unsubscribe link token).
// They must never reach the address bar while measurement runs, the data
// layer, or the Google Ads tag.
const SENSITIVE_QUERY_PARAMS = ["token"] as const;

const UNSUBSCRIBE_PATH = "/unsubscribe";

let capturedUnsubscribeToken: string | null = null;

export function scrubSearch(search: string): string {
  const params = new URLSearchParams(search);
  let changed = false;
  for (const key of SENSITIVE_QUERY_PARAMS) {
    if (params.has(key)) {
      params.delete(key);
      changed = true;
    }
  }
  if (!changed) return search;
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

/** Current page URL with sensitive query parameters removed, for measurement. */
export function measuredPageLocation(): string {
  const { origin, pathname, search } = window.location;
  return `${origin}${pathname}${scrubSearch(search)}`;
}

/**
 * Moves the unsubscribe token out of the address bar into memory.
 * Must run before any measurement tag is initialised.
 */
export function captureSensitiveParams(): void {
  if (typeof window === "undefined") return;
  const { pathname, search, hash } = window.location;
  const params = new URLSearchParams(search);
  const token = params.get("token");
  if (token && pathname.replace(/\/+$/, "") === UNSUBSCRIBE_PATH) {
    capturedUnsubscribeToken = token;
  }
  const scrubbed = scrubSearch(search);
  if (scrubbed !== search) {
    window.history.replaceState(window.history.state, "", `${pathname}${scrubbed}${hash}`);
  }
}

export function getCapturedUnsubscribeToken(): string | null {
  return capturedUnsubscribeToken;
}
