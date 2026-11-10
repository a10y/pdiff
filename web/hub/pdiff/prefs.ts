// pdiff settings, saved by the server in ~/.config/pdiff/prefs.json. Each run
// uses a new port (a new origin), so localStorage does not last. The server
// writes the current prefs into index.html, so they are ready before any
// module (such as the theme controller) reads them.

declare global {
  interface Window {
    PDIFF_PREFS?: Record<string, unknown>;
  }
}

const prefs: Record<string, unknown> = { ...(window.PDIFF_PREFS ?? {}) };
let pending: Record<string, string> | null = null;

export function pref<T>(key: string, fallback: T): T {
  return key in prefs ? (prefs[key] as T) : fallback;
}

/** Changes made in the same tick go to the server in one request. */
export function setPref(key: string, value: unknown): void {
  if (prefs[key] === value) return;
  prefs[key] = value;
  if (pending == null) {
    pending = {};
    queueMicrotask(() => {
      const q = new URLSearchParams(pending ?? {});
      pending = null;
      fetch(`api/prefs/set?${q}`).catch(() => {});
    });
  }
  pending[key] = JSON.stringify(value);
}
