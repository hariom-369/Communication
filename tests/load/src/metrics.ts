import { readdir, readFile } from 'node:fs/promises';
import { cpus } from 'node:os';

/**
 * Latency histogram with logarithmic buckets (about 2 % relative error), mergeable across
 * generator processes. Values are milliseconds.
 */
export class Histogram {
  /** Buckets per doubling: 2^(1/32) ≈ 2.2 % per bucket. */
  static readonly RESOLUTION = 32;
  readonly counts = new Map<number, number>();
  count = 0;
  sum = 0;
  max = 0;
  min = Number.POSITIVE_INFINITY;

  record(valueMs: number): void {
    const value = Math.max(valueMs, 0.001);
    const bucket = Math.floor(Math.log2(value) * Histogram.RESOLUTION);
    this.counts.set(bucket, (this.counts.get(bucket) ?? 0) + 1);
    this.count += 1;
    this.sum += value;
    if (value > this.max) this.max = value;
    if (value < this.min) this.min = value;
  }

  /** Upper edge of the bucket holding the q-quantile (0 ≤ q ≤ 1); 0 when empty. */
  quantile(q: number): number {
    if (this.count === 0) return 0;
    const target = Math.max(1, Math.ceil(q * this.count));
    let seen = 0;
    for (const bucket of [...this.counts.keys()].sort((a, b) => a - b)) {
      seen += this.counts.get(bucket) ?? 0;
      if (seen >= target) return Math.min(2 ** ((bucket + 1) / Histogram.RESOLUTION), this.max);
    }
    return this.max;
  }

  merge(other: HistogramData): void {
    for (const [bucket, count] of other.counts)
      this.counts.set(bucket, (this.counts.get(bucket) ?? 0) + count);
    this.count += other.count;
    this.sum += other.sum;
    this.max = Math.max(this.max, other.max);
    this.min = Math.min(this.min, other.min);
  }

  toData(): HistogramData {
    return {
      counts: [...this.counts],
      count: this.count,
      sum: this.sum,
      max: this.max,
      min: this.min,
    };
  }

  summary(): LatencySummary {
    return {
      count: this.count,
      mean: this.count === 0 ? 0 : round(this.sum / this.count),
      p50: round(this.quantile(0.5)),
      p95: round(this.quantile(0.95)),
      p99: round(this.quantile(0.99)),
      max: round(this.max),
    };
  }
}

export interface HistogramData {
  readonly counts: readonly (readonly [number, number])[];
  readonly count: number;
  readonly sum: number;
  readonly max: number;
  readonly min: number;
}

export interface LatencySummary {
  readonly count: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

const round = (value: number) => Math.round(value * 10) / 10;

/** Named counters (errors by kind, frames received, …). */
export class Counters {
  readonly values = new Map<string, number>();

  add(name: string, by = 1): void {
    this.values.set(name, (this.values.get(name) ?? 0) + by);
  }

  get(name: string): number {
    return this.values.get(name) ?? 0;
  }

  merge(other: readonly (readonly [string, number])[]): void {
    for (const [name, value] of other) this.add(name, value);
  }

  toData(): [string, number][] {
    return [...this.values];
  }
}

/**
 * Open-loop schedule: `rate` events per second for `durationMs`, evenly spaced, independent of
 * how fast the system answers (a closed loop would hide queueing by slowing down with it).
 */
export function schedule(rate: number, durationMs: number): number[] {
  if (rate <= 0) return [];
  const count = Math.floor((rate * durationMs) / 1000);
  const step = 1000 / rate;
  return Array.from({ length: count }, (_, i) => i * step);
}

const CLOCK_TICKS = 100; // USER_HZ on Linux

async function cpuTicks(pid: number): Promise<{ ticks: number; rssPages: number } | null> {
  try {
    const stat = await readFile(`/proc/${String(pid)}/stat`, 'utf8');
    // Fields after the command name (which may contain spaces) start at ") ".
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(fields[11]) + Number(fields[12]); // utime + stime
    const rssPages = Number(fields[21]);
    return { ticks, rssPages };
  } catch {
    return null;
  }
}

export interface MonitorTarget {
  readonly name: string;
  /** One process, or every process whose command name is `comm` (e.g. all postgres backends). */
  readonly pid?: number;
  readonly comm?: string;
}

async function pidsOf(target: MonitorTarget): Promise<number[]> {
  if (target.pid !== undefined) return [target.pid];
  if (target.comm === undefined) return [];
  const pids: number[] = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if ((await readFile(`/proc/${entry}/comm`, 'utf8')).trim() === target.comm)
        pids.push(Number(entry));
    } catch {
      // exited
    }
  }
  return pids;
}

async function systemBusyTicks(): Promise<{ busy: number; total: number }> {
  const line = (await readFile('/proc/stat', 'utf8')).split('\n')[0] ?? '';
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (values[3] ?? 0) + (values[4] ?? 0);
  const total = values.reduce((a, b) => a + b, 0);
  return { busy: total - idle, total };
}

export interface ResourceSummary {
  readonly cpuMean: number;
  readonly cpuPeak: number;
  readonly rssPeakMb: number;
  readonly rssStartMb: number;
  readonly rssEndMb: number;
}

/**
 * Samples CPU (in cores) and memory of the given processes or process groups every
 * `intervalMs`, plus the whole machine; keeps the mean and the peak.
 */
export class ResourceMonitor {
  readonly #targets: readonly MonitorTarget[];
  readonly #samples = new Map<string, { at: number[]; cpu: number[]; rss: number[] }>();
  #timer: NodeJS.Timeout | null = null;
  readonly #last = new Map<string, { ticks: number; at: number }>();
  #lastSystem: { busy: number; total: number } | null = null;

  constructor(targets: readonly MonitorTarget[]) {
    this.#targets = targets;
  }

  #push(name: string, cpu: number, rssMb: number): void {
    const entry = this.#samples.get(name) ?? { at: [], cpu: [], rss: [] };
    entry.at.push(Date.now());
    entry.cpu.push(cpu);
    entry.rss.push(rssMb);
    this.#samples.set(name, entry);
  }

  start(intervalMs = 1000): void {
    const cores = cpus().length;
    const tick = async () => {
      const now = Date.now();
      for (const target of this.#targets) {
        let ticks = 0;
        let pages = 0;
        for (const pid of await pidsOf(target)) {
          const sample = await cpuTicks(pid);
          if (sample === null) continue;
          ticks += sample.ticks;
          pages += sample.rssPages;
        }
        const previous = this.#last.get(target.name);
        this.#last.set(target.name, { ticks, at: now });
        if (previous === undefined) continue;
        const used =
          Math.max(0, ticks - previous.ticks) / CLOCK_TICKS / ((now - previous.at) / 1000 || 1);
        this.#push(target.name, used, (pages * 4096) / 2 ** 20);
      }
      const system = await systemBusyTicks();
      if (this.#lastSystem !== null) {
        const busy = system.busy - this.#lastSystem.busy;
        const total = system.total - this.#lastSystem.total;
        this.#push('machine', total > 0 ? (busy / total) * cores : 0, 0);
      }
      this.#lastSystem = system;
    };
    void tick();
    this.#timer = setInterval(() => void tick(), intervalMs);
  }

  /** Mean CPU (cores) of `name` over samples taken in [fromMs, toMs). */
  cpuBetween(name: string, fromMs: number, toMs: number): number {
    const entry = this.#samples.get(name);
    if (entry === undefined) return 0;
    const inside = entry.cpu.filter((_, i) => (entry.at[i] ?? 0) >= fromMs && (entry.at[i] ?? 0) < toMs);
    return round(inside.reduce((a, b) => a + b, 0) / Math.max(1, inside.length));
  }

  stop(): Record<string, ResourceSummary> {
    if (this.#timer !== null) clearInterval(this.#timer);
    const out: Record<string, ResourceSummary> = {};
    const mean = (values: readonly number[]) =>
      values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
    for (const [name, { cpu, rss }] of this.#samples) {
      // Memory at the start and end of the window (mean of the first and last tenth): growth
      // over a soak shows as end ≫ start.
      const tenth = Math.max(1, Math.floor(rss.length / 10));
      out[name] = {
        cpuMean: round(mean(cpu)),
        cpuPeak: round(Math.max(0, ...cpu)),
        rssPeakMb: Math.round(Math.max(0, ...rss)),
        rssStartMb: Math.round(mean(rss.slice(0, tenth))),
        rssEndMb: Math.round(mean(rss.slice(-tenth))),
      };
    }
    return out;
  }
}
