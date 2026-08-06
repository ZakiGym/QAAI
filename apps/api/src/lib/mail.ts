/**
 * Outbound email.
 *
 * QAAI had no email channel of any kind. That was survivable while the product
 * only ever showed you things — but a password reset and an invite are both a
 * link that has to reach a person who is not looking at the app, and there was
 * nowhere to send it. Password reset in particular cannot be built without this:
 * a reset link the user never receives is not a reset.
 *
 * Two drivers, chosen by configuration rather than by NODE_ENV:
 *
 *   SMTP     — when SMTP_HOST is set. Real mail, any provider.
 *   console  — otherwise. Writes the message, INCLUDING the link, to the log.
 *
 * The console driver is not a stub. A self-hosted install with no mail server is
 * a real deployment, and the honest behaviour there is to put the link somewhere
 * the operator can retrieve it and to SAY that is what happened — which is why
 * `send` reports which driver ran, and why the routes that use it tell the user
 * "ask your administrator" rather than "check your email" when it is console.
 *
 * The alternative — silently dropping mail — is the failure this codebase keeps
 * producing: an action that reports success and does nothing.
 */

import { createTransport, type Transporter } from 'nodemailer';
import { env } from '../env.js';
import { logger } from './logger.js';

export type MailDriver = 'smtp' | 'console';

export interface Mail {
  to: string;
  subject: string;
  /** Plain text. Every message here is short and link-shaped; no HTML needed. */
  text: string;
}

export interface MailResult {
  driver: MailDriver;
  /** True when the message reached a mail server. False for the console driver. */
  delivered: boolean;
}

/** Which driver this deployment will use. Read it before promising a user anything. */
export function mailDriver(): MailDriver {
  return env.SMTP_HOST ? 'smtp' : 'console';
}

let transporter: Transporter | null = null;

function smtp(): Transporter {
  if (transporter) return transporter;
  transporter = createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // Implicit TLS on 465, STARTTLS everywhere else — the convention every
    // provider follows, so operators do not have to set a third variable.
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
  });
  return transporter;
}

export async function sendMail(mail: Mail): Promise<MailResult> {
  const driver = mailDriver();

  if (driver === 'console') {
    /*
     * `info`, not `debug`. This is the only copy of the link that exists — the
     * token is hashed in the database and cannot be recovered — so it must not
     * sit below the default log level and disappear.
     */
    logger.info(
      { to: mail.to, subject: mail.subject, body: mail.text },
      'email not sent: no SMTP_HOST configured. The message body above contains the link.',
    );
    return { driver, delivered: false };
  }

  try {
    await smtp().sendMail({
      from: env.SMTP_FROM,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
    });
    return { driver, delivered: true };
  } catch (err) {
    /*
     * Logged and rethrown. The caller decides what the user sees — a failed
     * reset email must not look like a successful one, and a failed invite email
     * must not lose the invite, which is already durable in the database by the
     * time this runs.
     */
    logger.error({ err, to: mail.to, subject: mail.subject }, 'SMTP send failed');
    throw err;
  }
}

// ─── The messages ────────────────────────────────────────────────────────────
//
// Kept here rather than inline at the call sites so the wording of everything
// QAAI sends to a human is in one file, and so the routes stay about their own
// logic.

export function passwordResetMail(to: string, url: string, ttlMinutes: number): Mail {
  return {
    to,
    subject: 'Reset your QAAI password',
    text: [
      'Someone asked to reset the password for this QAAI account.',
      '',
      url,
      '',
      `The link works once and expires in ${ttlMinutes} minutes.`,
      '',
      'If this was not you, nothing has changed and you can ignore this message.',
    ].join('\n'),
  };
}

/**
 * Sent to every OWNER when Stripe reports a failed invoice payment (§9 dunning).
 *
 * One message per failed charge attempt, not one per incident: Stripe's retries
 * are days apart, and a card that is still broken a week later deserves a
 * second nudge. The wording promises only what the code does — nothing is
 * switched off on failure (see the webhook in routes/billing.ts).
 */
export function paymentFailedMail(to: string, orgName: string, billingUrl: string): Mail {
  return {
    to,
    subject: `Payment failed for ${orgName} on QAAI`,
    text: [
      `The latest subscription payment for ${orgName} on QAAI did not go through.`,
      '',
      'Stripe will retry automatically. To sort it out sooner, update the card on file:',
      '',
      billingUrl,
      '',
      'Nothing has been switched off. If payment keeps failing, the subscription',
      'will eventually lapse and the organisation drops to the free plan.',
    ].join('\n'),
  };
}

export function inviteMail(to: string, orgName: string, inviterName: string, url: string): Mail {
  return {
    to,
    subject: `${inviterName} invited you to ${orgName} on QAAI`,
    text: [
      `${inviterName} has invited you to join ${orgName} on QAAI.`,
      '',
      url,
      '',
      'The link expires in 7 days.',
    ].join('\n'),
  };
}
