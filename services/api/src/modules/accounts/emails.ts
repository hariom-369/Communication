import type { EmailMessage } from '../../platform/email.js';

/** Plain-text emails. Never include message content, tokens in subjects, or tracking. */

export function verificationEmail(to: string, username: string, code: string): EmailMessage {
  return {
    to,
    subject: 'Your Tessera verification code',
    text: [
      `Hi ${username},`,
      '',
      `Your verification code is: ${code}`,
      '',
      'It expires in 15 minutes. If you did not create a Tessera account, ignore this email —',
      'no account will be activated without this code.',
    ].join('\n'),
  };
}

export function existingAccountEmail(to: string): EmailMessage {
  return {
    to,
    subject: 'Someone tried to sign up with your email',
    text: [
      'Someone tried to create a new Tessera account with this email address, which already has',
      'an account. If this was you, sign in instead (or reset your password).',
      '',
      'If it was not you, no action is needed: your account was not changed.',
    ].join('\n'),
  };
}
