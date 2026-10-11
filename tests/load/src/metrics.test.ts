import { describe, expect, it } from 'vitest';

import { payloadStamp, sourceAddresses, stampedPayload } from './client.js';
import { Counters, Histogram, schedule } from './metrics.js';

describe('histogram', () => {
  it('reports quantiles within the bucket resolution', () => {
    const histogram = new Histogram();
    for (let i = 1; i <= 1000; i += 1) histogram.record(i);
    const summary = histogram.summary();
    expect(summary.count).toBe(1000);
    expect(summary.mean).toBeCloseTo(500.5, 0);
    // Upper bucket edge: at most ~2.2 % above the true value, never below it.
    expect(summary.p50).toBeGreaterThanOrEqual(500);
    expect(summary.p50).toBeLessThanOrEqual(500 * 1.023);
    expect(summary.p99).toBeGreaterThanOrEqual(990);
    expect(summary.p99).toBeLessThanOrEqual(990 * 1.023);
    expect(summary.max).toBe(1000);
  });

  it('merges across processes as if recorded in one', () => {
    const a = new Histogram();
    const b = new Histogram();
    const all = new Histogram();
    for (let i = 0; i < 500; i += 1) {
      a.record(i % 7);
      b.record(100 + i);
      all.record(i % 7);
      all.record(100 + i);
    }
    const merged = new Histogram();
    merged.merge(a.toData());
    merged.merge(b.toData());
    expect(merged.summary()).toEqual(all.summary());
  });

  it('is empty-safe', () => {
    expect(new Histogram().summary()).toEqual({
      count: 0,
      mean: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0,
    });
  });
});

describe('counters', () => {
  it('adds and merges', () => {
    const counters = new Counters();
    counters.add('sent');
    counters.add('sent', 2);
    counters.merge([['sent', 4], ['lost', 1]]);
    expect(counters.get('sent')).toBe(7);
    expect(counters.get('lost')).toBe(1);
    expect(counters.get('other')).toBe(0);
  });
});

describe('open-loop schedule', () => {
  it('spaces events evenly at the requested rate', () => {
    const offsets = schedule(4, 1000);
    expect(offsets).toEqual([0, 250, 500, 750]);
    expect(schedule(180, 60_000)).toHaveLength(10_800);
    expect(schedule(0, 1000)).toEqual([]);
  });
});

describe('stamped payloads', () => {
  it('carry their send time in the first bytes, at the requested size', () => {
    const payload = stampedPayload(512, 1_760_000_000_123.5);
    expect(Buffer.from(payload, 'base64')).toHaveLength(512);
    expect(payloadStamp(payload)).toBe(1_760_000_000_123.5);
  });
});

describe('source addresses', () => {
  it('are distinct loopback addresses', () => {
    const addresses = sourceAddresses(600);
    expect(new Set(addresses).size).toBe(600);
    for (const address of addresses) expect(address).toMatch(/^127\.0\.\d+\.\d+$/);
    expect(addresses).not.toContain('127.0.0.1');
  });
});
