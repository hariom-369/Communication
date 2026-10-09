/**
 * Incoming-call ring: a two-tone pattern generated with Web Audio (no audio file to fetch).
 * Browsers may block sound until the user has interacted with the page; the ring is then silent
 * and the on-screen call dialog remains.
 */
export class Ringer {
  #context: AudioContext | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.#timer !== null || typeof AudioContext === 'undefined') return;
    try {
      this.#context = new AudioContext();
    } catch {
      return;
    }
    const ring = () => {
      const context = this.#context;
      if (context?.state !== 'running') {
        void context?.resume().catch(() => undefined);
        return;
      }
      const gain = context.createGain();
      gain.gain.value = 0.08;
      gain.connect(context.destination);
      for (const frequency of [440, 480]) {
        const tone = context.createOscillator();
        tone.frequency.value = frequency;
        tone.connect(gain);
        tone.start();
        tone.stop(context.currentTime + 1.2);
      }
    };
    ring();
    this.#timer = setInterval(ring, 3000);
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    void this.#context?.close().catch(() => undefined);
    this.#context = null;
  }
}
