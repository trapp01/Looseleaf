/**
 * Short notices at the bottom of the window ("Archived HOME-12"), each
 * optionally with an Undo. A notice leaves on its own after TOAST_MS; Undo
 * runs the given function and dismisses it. A new notice replaces the last.
 */
import { useStore, Store } from './store.js';

export const TOAST_MS = 6000;

export interface Toast {
  id: number;
  message: string;
  undo?: () => void;
}

export class Toasts {
  readonly list = new Store<Toast[]>([]);
  private nextId = 1;

  show(message: string, undo?: () => void): void {
    const toast: Toast = { id: this.nextId++, message, undo };
    this.list.set([toast]);
    setTimeout(() => this.dismiss(toast.id), TOAST_MS);
  }

  dismiss(id: number): void {
    this.list.update((list) => list.filter((toast) => toast.id !== id));
  }
}

export function Toaster({ toasts }: { toasts: Toasts }) {
  const list = useStore(toasts.list);
  return (
    <div className="toaster" role="status" aria-live="polite">
      {list.map((toast) => (
        <div key={toast.id} className="toast">
          <span>{toast.message}</span>
          {toast.undo && (
            <button
              type="button"
              className="toast-undo"
              onClick={() => {
                toast.undo!();
                toasts.dismiss(toast.id);
              }}
            >
              Undo
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
