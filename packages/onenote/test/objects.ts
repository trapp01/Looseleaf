// Hand-built store objects for tests of the [MS-ONE] layer, without encoding bytes.
import { PropertySet, type PropertyValue } from '../src/property-set.js';
import type { StoreObject } from '../src/revision-store.js';

export function props(entries: Array<[number, PropertyValue]>): PropertySet {
  return new PropertySet(new Map(entries.map(([id, value]) => [id & 0x3ffffff, value])));
}

export const flag = (id: number, value = true): [number, PropertyValue] => [id, { kind: 'bool', value }];
export const refs = (id: number, ...ids: string[]): [number, PropertyValue] => [id, { kind: 'objects', value: ids, single: ids.length === 1 }];
export const data = (id: number, bytes: ArrayLike<number>): [number, PropertyValue] => [id, { kind: 'bytes', value: Uint8Array.from(bytes) }];
export const f32 = (id: number, value: number): [number, PropertyValue] => data(id, new Uint8Array(new Float32Array([value]).buffer));
export const text = (id: number, s: string): [number, PropertyValue] => {
  const units: number[] = [];
  for (let i = 0; i < s.length; i++) units.push(s.charCodeAt(i) & 0xff, s.charCodeAt(i) >>> 8);
  return data(id, units);
};

/** A pool of objects with a ContentContext over them that records warnings. */
export function objectPool() {
  const objects = new Map<string, StoreObject>();
  const warnings: string[] = [];
  return {
    warnings,
    add(id: string, jcid: number, entries: Array<[number, PropertyValue]> = [], extra: Partial<StoreObject> = {}): string {
      objects.set(id, { id, jcid, props: props(entries), ...extra });
      return id;
    },
    ctx: () => ({ object: (id: string) => objects.get(id), warn: (m: string) => warnings.push(m), visited: new Set<string>() }),
  };
}
