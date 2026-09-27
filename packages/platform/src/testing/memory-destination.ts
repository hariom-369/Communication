import { Writable } from 'node:stream';

/** Captures pino output in memory for assertions in tests. */
export class MemoryDestination extends Writable {
  readonly lines: string[] = [];

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.lines.push(
      ...chunk
        .toString('utf8')
        .split('\n')
        .filter((line) => line.length > 0),
    );
    callback();
  }

  records(): Record<string, unknown>[] {
    return this.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  text(): string {
    return this.lines.join('\n');
  }
}
