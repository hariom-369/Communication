/**
 * Connection quality from WebRTC statistics (docs/calling.md §4): round-trip time, jitter and
 * packet loss reduced to three levels, plus whether the call goes through a relay. Computed on
 * the device; nothing is reported anywhere.
 */

export interface CallQuality {
  readonly level: 'good' | 'fair' | 'poor' | 'unknown';
  readonly rttMs: number | null;
  readonly jitterMs: number | null;
  /** Percentage of incoming packets lost. */
  readonly lossPercent: number | null;
  /** Through a TURN relay (the other person does not see this device's address). */
  readonly relayed: boolean | null;
  readonly bytesReceived: number;
}

type Stat = Record<string, unknown> & { type: string; id: string };

const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);

export function qualityFromStats(report: { forEach(cb: (stat: Stat) => void): void }): CallQuality {
  const stats = new Map<string, Stat>();
  report.forEach((stat) => stats.set(stat.id, stat));
  let pair: Stat | undefined;
  for (const stat of stats.values()) {
    if (stat.type === 'transport' && typeof stat['selectedCandidatePairId'] === 'string')
      pair = stats.get(stat['selectedCandidatePairId']);
  }
  pair ??= [...stats.values()].find(
    (s) => s.type === 'candidate-pair' && s['nominated'] === true && s['state'] === 'succeeded',
  );
  const local =
    typeof pair?.['localCandidateId'] === 'string'
      ? stats.get(pair['localCandidateId'])
      : undefined;
  const remote =
    typeof pair?.['remoteCandidateId'] === 'string'
      ? stats.get(pair['remoteCandidateId'])
      : undefined;
  const relayed =
    local === undefined
      ? null
      : local['candidateType'] === 'relay' || remote?.['candidateType'] === 'relay';

  let received = 0;
  let lost = 0;
  let bytesReceived = 0;
  let jitter: number | null = null;
  for (const stat of stats.values()) {
    if (stat.type !== 'inbound-rtp') continue;
    received += num(stat['packetsReceived']) ?? 0;
    lost += Math.max(0, num(stat['packetsLost']) ?? 0);
    bytesReceived += num(stat['bytesReceived']) ?? 0;
    const j = num(stat['jitter']);
    if (j !== null) jitter = Math.max(jitter ?? 0, j);
  }
  const rtt = num(pair?.['currentRoundTripTime']);
  const lossPercent = received + lost > 0 ? (100 * lost) / (received + lost) : null;
  const rttMs = rtt === null ? null : Math.round(rtt * 1000);
  const jitterMs = jitter === null ? null : Math.round(jitter * 1000);

  let level: CallQuality['level'] = 'unknown';
  if (rttMs !== null || lossPercent !== null) {
    const r = rttMs ?? 0;
    const l = lossPercent ?? 0;
    const j = jitterMs ?? 0;
    level = r > 500 || l > 8 || j > 100 ? 'poor' : r > 250 || l > 2 || j > 40 ? 'fair' : 'good';
  }
  return { level, rttMs, jitterMs, lossPercent, relayed, bytesReceived };
}
