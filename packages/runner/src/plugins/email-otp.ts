/**
 * Email / one-time-code flows (§4 EMAIL_OTP).
 *
 * The half of testing that normally forces teams to either mock their mail
 * provider or keep a shared inbox and a human. QAAI drives the real flow:
 * request the code, read the actual delivered message, extract the code, and
 * complete the sign-in — so the thing under test is the flow a customer gets,
 * not a stub of it.
 *
 * The mailbox is read over HTTP from whatever catcher the environment exposes
 * (`mailboxUrl`), which keeps this honest about its one real dependency: you
 * need a test mail sink. The bundled demo store ships one at `/__mail`, and
 * MailHog / Mailpit / Mailosaur expose the same shape.
 */

import { chromium } from 'playwright';
import { emailOtpSpecSchema } from '@qaai/shared';
import type {
  ExecutableTest,
  RunContext,
  RunnerPlugin,
  StepResult,
  TestExecution,
} from '@qaai/shared';

interface CaughtMail {
  to: string;
  subject: string;
  text: string;
  receivedAt: string;
}

function step(index: number, title: string, ok: boolean, detail?: string): StepResult {
  return {
    index,
    title,
    status: ok ? 'PASSED' : 'FAILED',
    startedAt: new Date().toISOString(),
    durationMs: 0,
    screenshotKey: null,
    error: ok
      ? null
      : { message: detail ?? 'failed', stack: null, selector: null, expected: null, actual: null },
  };
}

/**
 * Poll the mailbox until the message lands.
 *
 * Mail is asynchronous, so a single read races the send. Polling with a
 * deadline is the difference between a test that works and one that is flaky
 * for reasons that have nothing to do with the application.
 */
async function waitForMail(
  mailboxUrl: string,
  recipient: string,
  since: number,
  timeoutMs: number,
): Promise<CaughtMail | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const url = new URL(mailboxUrl);
      url.searchParams.set('to', recipient);
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      if (response.ok) {
        const body = (await response.json()) as { messages?: CaughtMail[] };
        const fresh = (body.messages ?? []).find(
          (m) => new Date(m.receivedAt).getTime() >= since - 1000,
        );
        if (fresh) return fresh;
      }
    } catch {
      /* the catcher may not be up yet; keep trying until the deadline */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

export const emailOtpPlugin: RunnerPlugin = {
  type: 'EMAIL_OTP',

  validate(test: ExecutableTest): void {
    const parsed = emailOtpSpecSchema.safeParse(test.spec);
    if (!parsed.success) {
      throw new Error(
        `Email/OTP test "${test.name}" has an invalid spec — ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
    }
  },

  async execute(ctx: RunContext, test: ExecutableTest): Promise<TestExecution> {
    const spec = emailOtpSpecSchema.parse(test.spec);
    const startedAt = Date.now();
    const steps: StepResult[] = [];

    const base: Omit<TestExecution, 'status' | 'steps' | 'errorMessage'> = {
      testId: test.id,
      durationMs: 0,
      network: [],
      console: [],
      videoKey: null,
      traceKey: null,
      retriedAndPassed: false,
      findings: [],
    };

    const finish = (errorMessage: string | null): TestExecution => ({
      ...base,
      status: errorMessage ? 'FAILED' : 'PASSED',
      durationMs: Date.now() - startedAt,
      steps,
      errorMessage,
    });

    const recipient = ctx.secrets[spec.recipientSecretName] ?? spec.recipient ?? '';
    if (!recipient) {
      steps.push(step(0, 'Resolve the recipient', false));
      return finish(
        `No recipient. Set the secret ${spec.recipientSecretName} or put an address in the spec.`,
      );
    }

    const mailboxUrl = /^https?:\/\//i.test(spec.mailboxUrl)
      ? spec.mailboxUrl
      : new URL(spec.mailboxUrl, ctx.baseUrl).toString();

    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();

      // 1. Ask the app to send a code.
      const requestUrl = /^https?:\/\//i.test(spec.requestUrl)
        ? spec.requestUrl
        : new URL(spec.requestUrl, ctx.baseUrl).toString();

      const sentAt = Date.now();
      await page.goto(requestUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.fill(spec.emailSelector, recipient, { timeout: 15_000 });
      await page.click(spec.requestSubmitSelector, { timeout: 15_000 });
      steps.push(step(0, `Requested a code for ${recipient}`, true));

      // 2. Read the mail that was actually delivered.
      const mail = await waitForMail(mailboxUrl, recipient, sentAt, spec.timeoutSeconds * 1000);
      if (!mail) {
        steps.push(step(1, 'Wait for the email', false));
        return finish(
          `No email reached ${recipient} within ${spec.timeoutSeconds}s. Is the mail catcher at ${mailboxUrl} running?`,
        );
      }
      steps.push(step(1, `Received "${mail.subject}"`, true));

      // 3. Pull the code out of the body.
      const match = new RegExp(spec.codePattern).exec(mail.text);
      const code = match?.[1] ?? match?.[0];
      if (!code) {
        steps.push(step(2, 'Extract the code', false));
        return finish(`No code matching /${spec.codePattern}/ in the email body.`);
      }
      steps.push(step(2, `Extracted the code (${code.length} characters)`, true));

      // 4. Use it.
      await page.fill(spec.codeSelector, code, { timeout: 15_000 });
      await page.click(spec.verifySubmitSelector, { timeout: 15_000 });

      try {
        await page.waitForSelector(spec.successSelector, { timeout: 20_000, state: 'visible' });
      } catch {
        steps.push(step(3, 'Complete the sign-in', false));
        return finish(
          `Submitted the code but "${spec.successSelector}" never appeared — the code was rejected, or the success locator is wrong.`,
        );
      }

      steps.push(step(3, 'Signed in with the emailed code', true));
      return finish(null);
    } catch (err) {
      steps.push(
        step(steps.length, 'Email/OTP flow', false, err instanceof Error ? err.message : undefined),
      );
      return finish(err instanceof Error ? err.message.slice(0, 300) : 'The flow could not run');
    } finally {
      await browser.close().catch(() => {});
    }
  },
};
