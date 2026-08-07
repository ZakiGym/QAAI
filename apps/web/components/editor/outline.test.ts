import { describe, expect, it } from 'vitest';
import { fileOutline, symbolTrailAt } from './outline';

/** The breadcrumb the bar would draw for a cursor on `line`. */
function trail(text: string, line: number, language = 'typescript'): string[] {
  return symbolTrailAt(fileOutline(text, language), line).map((s) => s.name);
}

describe('fileOutline — a Playwright spec', () => {
  const spec = `import { test, expect } from '@playwright/test';

test.describe('Checkout', () => {
  test('order total includes tax', async ({ page }) => {
    await test.step('Add an item', async () => {
      await page.getByRole('button', { name: 'Add' }).click();
    });

    await expect(page.getByTestId('total')).toHaveText('$11.00');
  });
});
`;

  it('names the describe, the test and the step, outermost first', () => {
    expect(trail(spec, 6)).toEqual(['Checkout', 'order total includes tax', 'Add an item']);
  });

  it('drops the step once the cursor is past it', () => {
    expect(trail(spec, 9)).toEqual(['Checkout', 'order total includes tax']);
  });

  it('leaves the import line outside every block', () => {
    expect(trail(spec, 1)).toEqual([]);
  });

  /*
   * The bug this file exists to keep fixed. `async ({ page }) => {` opens two
   * braces on one line and the first is a destructuring pattern — claiming "the
   * next brace after the title" names `{ page }`, which closes immediately, and
   * the real body is left anonymous. Every line of every test would then have an
   * empty trail.
   */
  it('does not mistake the destructured fixtures for the test body', () => {
    const symbols = fileOutline(spec, 'typescript');
    const body = symbols.find((s) => s.name === 'order total includes tax');
    expect(body).toBeDefined();
    expect(body!.endLine).toBeGreaterThan(body!.startLine + 1);
  });
});

describe('fileOutline — what must NOT be read as a block', () => {
  it('ignores a title inside a comment', () => {
    const text = `// test('commented out', async () => {
test('real', async () => {
  await page.goto('/');
});
`;
    expect(trail(text, 3)).toEqual(['real']);
  });

  it('ignores a title inside a string', () => {
    const text = `const label = "test('not a block', () => {";
test('real', async () => {
  await page.goto('/');
});
`;
    expect(trail(text, 3)).toEqual(['real']);
  });

  it('ignores a member call that happens to be named test', () => {
    const text = `test('outer', async () => {
  if (/^\\/checkout/.test(page.url())) {
    await page.goto('/');
  }
});
`;
    expect(trail(text, 3)).toEqual(['outer']);
  });

  it('ignores a longer identifier ending in test', () => {
    const text = `function smokeTest('x', () => {\n  const a = 1;\n});\n`;
    expect(trail(text, 2)).toEqual([]);
  });

  /*
   * A regex whose escaped slashes end the line looks exactly like the start of a
   * comment to a naive scanner, which would swallow every block below it.
   */
  it('survives a regex containing escaped slashes', () => {
    const text = `test('outer', async () => {
  await page.waitForURL(/https:\\/\\//);
  await test.step('inner', async () => {
    await page.goto('/');
  });
});
`;
    expect(trail(text, 4)).toEqual(['outer', 'inner']);
  });

  it('does not hand a bodyless title to the next block', () => {
    const text = `test.skip('skipped');
test('real', async () => {
  await page.goto('/');
});
`;
    expect(trail(text, 3)).toEqual(['real']);
  });
});

describe('fileOutline — titles as written', () => {
  it('keeps an apostrophe that was escaped in the source', () => {
    const text = `test('the cart\\'s total', async () => {\n  await page.goto('/');\n});\n`;
    expect(trail(text, 2)).toEqual(["the cart's total"]);
  });

  it('reads a double-quoted title too', () => {
    const text = `test("double quoted", async () => {\n  await page.goto('/');\n});\n`;
    expect(trail(text, 2)).toEqual(['double quoted']);
  });

  it('reads a test declared with function rather than an arrow', () => {
    const text = `test('classic', async function ({ page }) {\n  await page.goto('/');\n});\n`;
    expect(trail(text, 2)).toEqual(['classic']);
  });

  it('reads a describe carrying a modifier chain', () => {
    const text = `test.describe.serial('Ordered', () => {\n  test('one', async () => {\n    await page.goto('/');\n  });\n});\n`;
    expect(trail(text, 3)).toEqual(['Ordered', 'one']);
  });

  it('steps past an options object between the title and the body', () => {
    const text = `test('tagged', { tag: '@slow' }, async ({ page }) => {\n  await page.goto('/');\n});\n`;
    expect(trail(text, 2)).toEqual(['tagged']);
  });
});

describe('fileOutline — a file being typed', () => {
  /*
   * A buffer is unbalanced most of the time you are editing it — you are inside
   * the block whose opening brace you just typed. Dropping unclosed blocks would
   * blank the trail at exactly the moment it is being read.
   */
  it('still names the block whose closing brace has not been typed yet', () => {
    const text = `test.describe('Checkout', () => {\n  test('new one', async ({ page }) => {\n    await page.goto('/');\n`;
    expect(trail(text, 3)).toEqual(['Checkout', 'new one']);
  });
});

describe('fileOutline — a JSON spec', () => {
  const spec = `{
  "routes": [
    "/",
    "/checkout"
  ],
  "auth": {
    "profile": "member",
    "headers": {
      "x-tenant": "acme"
    }
  }
}
`;

  it('reads the property path, outermost first', () => {
    expect(trail(spec, 9, 'json')).toEqual(['auth', 'headers']);
  });

  it('names an array by its key', () => {
    expect(trail(spec, 3, 'json')).toEqual(['routes']);
  });

  it('leaves the root object unnamed', () => {
    expect(trail(spec, 1, 'json')).toEqual([]);
  });

  it('indexes objects inside an array', () => {
    const cases = `{
  "cases": [
    { "name": "first" },
    { "name": "second" }
  ]
}
`;
    expect(trail(cases, 4, 'json')).toEqual(['cases', '[1]']);
  });

  it('does not read a string VALUE as a key', () => {
    const text = `{\n  "title": "auth",\n  "steps": {\n    "one": 1\n  }\n}\n`;
    expect(trail(text, 4, 'json')).toEqual(['steps']);
  });
});

describe('fileOutline — the honest empty answers', () => {
  it('says nothing about a language it cannot read', () => {
    expect(fileOutline('a,b,c\n1,2,3\n', 'plaintext')).toEqual([]);
  });

  it('refuses a buffer too large to be worth scanning on every keystroke', () => {
    const huge = `test('x', async () => {\n  await page.goto('/');\n});\n`.padEnd(400_001, ' ');
    expect(fileOutline(huge, 'typescript')).toEqual([]);
  });

  it('says nothing about an empty buffer', () => {
    expect(fileOutline('', 'typescript')).toEqual([]);
  });
});
