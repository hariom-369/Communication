import type { EmailMessage } from '../../platform/email.js';

/** Security notifications (docs/notifications.md §4). They cannot be disabled by the user. */

const footer = [
  '',
  'If this was not you, reset your password immediately and sign out of all sessions from',
  'Settings → Security. Tessera will never ask you for your password or codes.',
];

export function securityNoticeEmail(
  to: string,
  headline: string,
  lines: readonly string[] = [],
): EmailMessage {
  return {
    to,
    subject: `Tessera security notice: ${headline}`,
    text: [headline, '', ...lines, ...footer].join('\n'),
  };
}

export function newSignInEmail(
  to: string,
  details: { device: string; network: string; at: Date },
): EmailMessage {
  return securityNoticeEmail(to, 'New sign-in to your account', [
    `Device: ${details.device}`,
    `Network: ${details.network}`,
    `Time (UTC): ${details.at.toISOString().replace('T', ' ').slice(0, 19)}`,
  ]);
}

export function passwordResetEmail(to: string, link: string): EmailMessage {
  return {
    to,
    subject: 'Reset your Tessera password',
    text: [
      'Someone (hopefully you) asked to reset the password for your Tessera account.',
      '',
      `Open this link within 30 minutes to choose a new password:`,
      link,
      '',
      'If you did not ask for this, ignore this email; your password will not change.',
      'Resetting your password signs out all of your sessions.',
    ].join('\n'),
  };
}
