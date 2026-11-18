/** A card's comments and activity as one list, oldest first, and the sentence each activity entry reads as. */
import type { Activity, Card, Comment } from '@looseleaf/model';

export type TimelineEntry = { kind: 'comment'; at: number; comment: Comment } | { kind: 'activity'; at: number; activity: Activity; key: string };

/** Comments and activity merged, oldest first, so the newest sits by the comment box. At the same moment an activity sorts above the comment it came with. */
export function cardTimeline(card: Card): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...card.comments.map((comment): TimelineEntry => ({ kind: 'comment', at: comment.at, comment })),
    ...card.activity.map((activity, index): TimelineEntry => ({ kind: 'activity', at: activity.at, activity, key: `activity-${index}` })),
  ];
  return entries.sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === 'activity' ? -1 : 1));
}

/** What happened, without the actor: "moved this card from Backlog to Done". */
export function describeActivity(activity: Activity): string {
  switch (activity.type) {
    case 'created':
      return activity.status ? `added this card to ${activity.status}` : 'added this card';
    case 'moved':
      return activity.from ? `moved this card from ${activity.from} to ${activity.to}` : `moved this card to ${activity.to}`;
    case 'archived':
      return 'archived this card';
    case 'restored':
      return 'restored this card';
  }
}
