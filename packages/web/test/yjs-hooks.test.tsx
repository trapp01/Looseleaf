// @vitest-environment jsdom
import { useLayoutEffect } from 'react';
import { render, screen } from '@testing-library/react';
import * as Y from 'yjs';
import { expect, test } from 'vitest';
import { useYValue } from '../src/app/yjs-hooks.js';

function Keys({ map }: { map: Y.Map<number> }) {
  const keys = useYValue(map, () => [...map.keys()].sort(), map, true);
  return <output>{keys.join(',')}</output>;
}

/** Layout effects run before React subscribes to the store, which is when a sync update can land. */
function ChangeBeforeSubscribe({ map }: { map: Y.Map<number> }) {
  useLayoutEffect(() => {
    map.set('late', 1);
  }, [map]);
  return null;
}

test('a change between the first render and the subscription is shown', () => {
  const map = new Y.Doc().getMap<number>('keys');
  map.set('early', 1);
  render(
    <>
      <Keys map={map} />
      <ChangeBeforeSubscribe map={map} />
    </>,
  );
  expect(screen.getByRole('status').textContent).toBe('early,late');
});
