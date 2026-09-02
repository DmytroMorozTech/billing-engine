import { describe, expect, it } from 'vitest';

import { SequentialIdGenerator, Uuid7Generator } from './ids.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('Uuid7Generator', () => {
  it('produces well-formed version 7 uuids', () => {
    const id = new Uuid7Generator().next();
    expect(id).toMatch(UUID);
    expect(id[14]).toBe('7');
  });

  it('produces ids that sort chronologically', () => {
    const generator = new Uuid7Generator();
    const ids = Array.from({ length: 50 }, () => generator.next());
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('SequentialIdGenerator', () => {
  it('is predictable, so tests can assert on stored rows', () => {
    const generator = new SequentialIdGenerator();
    expect(generator.next()).toBe('00000000-0000-7000-8000-000000000001');
    expect(generator.next()).toBe('00000000-0000-7000-8000-000000000002');
  });

  it('still produces valid uuids, so column types behave as in production', () => {
    expect(new SequentialIdGenerator().next()).toMatch(UUID);
  });
});
