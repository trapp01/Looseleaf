import { shell } from '../shell-bridge.js';

/** Registers the app-shell service worker where the browser allows one (secure contexts only). */
export function registerServiceWorker(): void {
  if (shell() || !window.isSecureContext || !('serviceWorker' in navigator) || location.protocol === 'app:') return;
  if (import.meta.env.DEV) return;
  navigator.serviceWorker.register('./sw.js').catch(() => undefined);
}
