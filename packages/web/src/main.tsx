/**
 * Starts the app: opens the replica store in IndexedDB, creates the one sync
 * client and the services over it, and renders. When IndexedDB cannot be
 * opened (some private windows) the replica lives in memory for the session
 * and the app says so.
 */
import '@fontsource/carlito/400.css';
import '@fontsource/carlito/400-italic.css';
import '@fontsource/carlito/700.css';
import '@fontsource/carlito/700-italic.css';
import './styles/tokens.css';
import './styles/base.css';
import './nav/nav.css';
import './ribbon/ribbon.css';
import './canvas/canvas.css';
import './canvas/rich-text.css';
import './phone/phone.css';
import './styles/print.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryStore, openIndexedDbStore, SyncClient, type ClientStore } from '@looseleaf/sync';
import { Boot } from './app/Boot.js';
import { createServices, ServicesContext } from './app/services.js';
import { registerServiceWorker } from './app/service-worker.js';
import { installTagIcons } from './canvas/tag-icons.js';

async function start(): Promise<void> {
  const root = createRoot(document.getElementById('root')!);
  let store: ClientStore;
  let persistent = true;
  try {
    store = await openIndexedDbStore();
  } catch (error) {
    console.error('Could not open IndexedDB; notes stay in memory for this session', error);
    store = new MemoryStore();
    persistent = false;
  }
  const client = await SyncClient.create({ store });
  const services = await createServices(client);
  installTagIcons();
  window.addEventListener('online', () => client.retryNow());
  root.render(
    <StrictMode>
      <ServicesContext.Provider value={services}>
        <Boot persistent={persistent} />
      </ServicesContext.Provider>
    </StrictMode>,
  );
  registerServiceWorker();
}

void start();
