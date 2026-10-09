import { describe, expect, it } from 'vitest';

import { qualityFromStats } from './quality.js';

function report(rtt: number, received: number, lost: number, localType = 'host', jitter = 0.005) {
  const stats = [
    { id: 'T1', type: 'transport', selectedCandidatePairId: 'P1' },
    {
      id: 'P1',
      type: 'candidate-pair',
      localCandidateId: 'L',
      remoteCandidateId: 'R',
      currentRoundTripTime: rtt,
    },
    { id: 'L', type: 'local-candidate', candidateType: localType },
    { id: 'R', type: 'remote-candidate', candidateType: 'srflx' },
    {
      id: 'A',
      type: 'inbound-rtp',
      packetsReceived: received,
      packetsLost: lost,
      jitter,
      bytesReceived: 1000,
    },
  ];
  return { forEach: (cb: (s: (typeof stats)[number]) => void) => stats.forEach(cb) };
}

describe('call quality indicator', () => {
  it('reduces round-trip time, jitter and loss to three levels', () => {
    expect(qualityFromStats(report(0.04, 1000, 0)).level).toBe('good');
    expect(qualityFromStats(report(0.3, 1000, 0)).level).toBe('fair');
    expect(qualityFromStats(report(0.04, 950, 50)).level).toBe('fair');
    expect(qualityFromStats(report(0.04, 900, 100)).level).toBe('poor');
    expect(qualityFromStats(report(0.04, 1000, 0, 'host', 0.2)).level).toBe('poor');
    const good = qualityFromStats(report(0.04, 990, 10));
    expect(good).toMatchObject({ rttMs: 40, jitterMs: 5, lossPercent: 1, bytesReceived: 1000 });
  });

  it('tells relayed from direct connections', () => {
    expect(qualityFromStats(report(0.04, 10, 0, 'relay')).relayed).toBe(true);
    expect(qualityFromStats(report(0.04, 10, 0, 'host')).relayed).toBe(false);
    expect(qualityFromStats({ forEach: () => undefined })).toMatchObject({
      level: 'unknown',
      relayed: null,
    });
  });
});
