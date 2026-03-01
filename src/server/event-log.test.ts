import { describe, it, expect } from 'vitest';
import { EventLog } from './event-log.js';

describe('EventLog', () => {
  it('stores and retrieves events', () => {
    const log = new EventLog<string>();
    log.push('a');
    log.push('b');
    expect(log.getAll()).toEqual(['a', 'b']);
  });

  it('returns last event', () => {
    const log = new EventLog<number>();
    log.push(1);
    log.push(2);
    expect(log.getLast()).toBe(2);
  });

  it('returns undefined for empty log', () => {
    const log = new EventLog<string>();
    expect(log.getLast()).toBeUndefined();
  });

  it('evicts oldest when capacity exceeded', () => {
    const log = new EventLog<number>(3);
    log.push(1);
    log.push(2);
    log.push(3);
    log.push(4);
    expect(log.getAll()).toEqual([2, 3, 4]);
  });

  it('returns a copy, not a reference', () => {
    const log = new EventLog<string>();
    log.push('x');
    const result = log.getAll();
    result.push('y');
    expect(log.getAll()).toEqual(['x']);
  });
});
