/** A status kind as a small icon with its name for screen readers and on hover, so colour never carries it alone. */
import { CheckmarkCircleRegular, CircleRegular, RecordRegular } from '@fluentui/react-icons';
import type { StatusKind } from '@looseleaf/model';

export const KIND_NAMES: Record<StatusKind, string> = { todo: 'To do', doing: 'Doing', done: 'Done' };

const ICONS = { todo: CircleRegular, doing: RecordRegular, done: CheckmarkCircleRegular } as const;

export function KindMarker({ kind }: { kind: StatusKind }) {
  const Icon = ICONS[kind];
  return (
    <span className={`kind-marker kind-${kind}`} title={KIND_NAMES[kind]} role="img" aria-label={KIND_NAMES[kind]}>
      <Icon aria-hidden="true" />
    </span>
  );
}
