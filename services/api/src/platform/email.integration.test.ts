import type { AddressInfo } from 'node:net';

import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SmtpMailer } from './email.js';

let server: SMTPServer;
const received: string[] = [];

beforeAll(async () => {
  server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData(stream, _session, callback) {
      let data = '';
      stream.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
      stream.on('end', () => {
        received.push(data);
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});
afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

describe('SmtpMailer (real SMTP exchange)', () => {
  it('delivers plain-text mail', async () => {
    const { port } = server.server.address() as AddressInfo;
    const mailer = new SmtpMailer(
      `smtp://127.0.0.1:${port}?ignoreTLS=true`,
      'Tessera <no-reply@tessera.test>',
    );
    await mailer.send({ to: 'asha@example.test', subject: 'Hello', text: 'Your code is: 123456' });
    mailer.close();
    const message = received.at(-1) ?? '';
    expect(message).toMatch(/^To: asha@example\.test/m);
    expect(message).toMatch(/^Subject: Hello/m);
    expect(message).toMatch(/Content-Type: text\/plain/);
    expect(message).not.toMatch(/text\/html/);
    expect(message).toContain('Your code is: 123456');
  });
});
