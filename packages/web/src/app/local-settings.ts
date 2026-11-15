/**
 * Per-device preferences in localStorage. Every access is wrapped: private
 * windows and blocked site data make storage throw or come back empty, and
 * the app then runs on defaults.
 */
const PREFIX = 'looseleaf.';

export function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(PREFIX + key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeLocal(key: string, value: unknown): void {
  try {
    if (value === undefined || value === null) globalThis.localStorage?.removeItem(PREFIX + key);
    else globalThis.localStorage?.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage is unavailable; the preference lasts for this session only.
  }
}
