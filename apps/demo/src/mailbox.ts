/**
 * Built-in SMTP catcher (§4 "Email/OTP flows").
 *
 * Two ways in: the store drops messages straight into the mailbox, and a real
 * SMTP listener catches anything an external app sends to it. Either way the
 * runner reads them over HTTP at /__mail, which is what makes magic-link and
 * OTP tests possible without a third-party mail service.
 */

import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';

export interface CaughtMail {
  id: string;
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string | null;
  receivedAt: string;
}

/** Ring buffer — a long-running demo should not grow without bound. */
const MAX_MESSAGES = 200;

export class Mailbox {
  private messages: CaughtMail[] = [];
  private seq = 0;

  add(mail: Omit<CaughtMail, 'id' | 'receivedAt'>): CaughtMail {
    const entry: CaughtMail = {
      ...mail,
      id: `mail-${++this.seq}`,
      receivedAt: new Date().toISOString(),
    };
    this.messages.unshift(entry);
    if (this.messages.length > MAX_MESSAGES) this.messages.length = MAX_MESSAGES;
    return entry;
  }

  /** Newest first. `to` filters by recipient, case-insensitively. */
  list(to?: string): CaughtMail[] {
    if (!to) return this.messages;
    const needle = to.toLowerCase();
    return this.messages.filter((m) => m.to.toLowerCase() === needle);
  }

  latestFor(to: string): CaughtMail | undefined {
    return this.list(to)[0];
  }

  clear(): void {
    this.messages = [];
  }
}

/**
 * Starts the SMTP listener. Auth is deliberately open and TLS is off — this
 * only ever binds inside the demo container / localhost, and requiring
 * credentials would defeat the purpose of a catcher.
 */
export function startSmtpCatcher(mailbox: Mailbox, port: number): SMTPServer {
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData(stream, _session, callback) {
      simpleParser(stream)
        .then((parsed) => {
          mailbox.add({
            to: parsed.to && 'text' in parsed.to ? parsed.to.text : '',
            from: parsed.from?.text ?? '',
            subject: parsed.subject ?? '',
            text: parsed.text ?? '',
            html: typeof parsed.html === 'string' ? parsed.html : null,
          });
          callback();
        })
        .catch((err: Error) => callback(err));
    },
  });

  server.listen(port, '127.0.0.1');
  return server;
}

/** Pulls the first 4–8 digit run out of a message body — the OTP extraction step. */
export function extractCode(body: string): string | null {
  return /\b(\d{4,8})\b/.exec(body)?.[1] ?? null;
}

/** Pulls the first http(s) URL out of a message body — the magic-link step. */
export function extractLink(body: string): string | null {
  return /https?:\/\/\S+/.exec(body)?.[0] ?? null;
}
