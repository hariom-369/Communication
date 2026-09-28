import nodemailer, { type Transporter } from 'nodemailer';

/** Plain-text transactional email. HTML is not used: nothing user-controlled can inject markup. */
export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

/**
 * SMTP delivery (Mailpit locally, the provider's SMTP relay — e.g. Amazon SES — in production).
 * Production requires `smtps://` or STARTTLS; see config validation.
 */
export class SmtpMailer implements Mailer {
  readonly #transport: Transporter;
  readonly #from: string;

  constructor(url: string, from: string) {
    this.#transport = nodemailer.createTransport(url);
    this.#from = from;
  }

  async send(message: EmailMessage): Promise<void> {
    await this.#transport.sendMail({
      from: this.#from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }

  close(): void {
    this.#transport.close();
  }
}
