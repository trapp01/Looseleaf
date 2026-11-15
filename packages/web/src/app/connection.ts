/**
 * Finding and checking a server before the sync client is told about it:
 * whether this page was served by a Looseleaf server, and whether an address
 * and token work. Errors come back as sentences a person can act on.
 */
import { fetchServerInfo, normalizeServerAddress } from '@looseleaf/sync';
import { shell } from '../shell-bridge.js';
import { readLocal, writeLocal } from './local-settings.js';

const DEVICE_ONLY_KEY = 'deviceOnly';
const DETECT_TIMEOUT_MS = 4000;

/** The address of the server that served this page, or null in the desktop shell or a plain dev server. */
export async function detectHostServer(): Promise<string | null> {
  if (shell() || !/^https?:$/.test(location.protocol)) return null;
  const address = normalizeServerAddress(new URL('.', location.href).toString());
  try {
    await withTimeout(fetchServerInfo(address), DETECT_TIMEOUT_MS);
    return address;
  } catch {
    return null;
  }
}

/** Resolves when the address is a reachable Looseleaf server that accepts the token; throws a plain message otherwise. */
export async function checkServer(address: string, token: string): Promise<string> {
  let normalized: string;
  try {
    normalized = normalizeServerAddress(address);
  } catch {
    throw new Error('Enter an address that starts with http:// or https://, like http://nas:8421');
  }
  if (token.trim() === '') throw new Error('Enter the access token.');
  try {
    await withTimeout(fetchServerInfo(normalized), 10_000);
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes('is not a Looseleaf server')) throw new Error(`${normalized} answered, but it isn’t a Looseleaf server.`);
    if (message.includes('speaks sync protocol')) throw new Error('This server runs a different version. Update the server or this app.');
    throw new Error(`Can’t reach ${normalized}. Check the address and that the server is running.`);
  }
  let status: number;
  try {
    const response = await fetch(`${normalized}/api/blobs`, { headers: { Authorization: `Bearer ${token.trim()}` } });
    status = response.status;
  } catch {
    throw new Error(`Can’t reach ${normalized}. Check the address and that the server is running.`);
  }
  if (status === 401 || status === 403) throw new Error('The server refused this access token.');
  if (status >= 400) throw new Error(`The server answered with an error (${status}). Try again in a moment.`);
  return normalized;
}

export function deviceOnlyChosen(): boolean {
  return readLocal(DEVICE_ONLY_KEY, false);
}

export function chooseDeviceOnly(chosen: boolean): void {
  writeLocal(DEVICE_ONLY_KEY, chosen || null);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}
