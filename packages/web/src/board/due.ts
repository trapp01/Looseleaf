/** How a card's due day reads on its front, and the days it is compared with. */
import type { StatusKind } from '@looseleaf/model';

export type DueState = 'none' | 'upcoming' | 'today' | 'overdue' | 'finished';

/**
 * Whether a due day has passed. Days compare as `YYYY-MM-DD` strings. A card
 * in a `done` status is finished whatever its day, so it is never overdue.
 */
export function dueState(due: string | null, today: string, kind: StatusKind | null): DueState {
  if (due === null) return 'none';
  if (kind === 'done') return 'finished';
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  return 'upcoming';
}

/** Today in the device's time zone as `YYYY-MM-DD`, the form due days are stored in. */
export function todayDay(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** A due day for a card front: "Nov 16", with the year when it is not this year's. */
export function shortDay(day: string, today: string): string {
  const [year, month, date] = day.split('-').map(Number);
  if (!year || !month || !date) return day;
  const value = new Date(year, month - 1, date);
  const sameYear = today.slice(0, 4) === day.slice(0, 4);
  return value.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The full date and time, for a tooltip. */
export function fullTime(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' });
}
