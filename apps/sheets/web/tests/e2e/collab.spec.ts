import { type Browser, expect, type Page, test } from "@playwright/test";

type Sheets = { engine: { viewport: Function; editText: Function } };

async function cell(page: Page, ref: string): Promise<{ text?: string; edit: string }> {
  return page.evaluate(async (ref) => {
    const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
    const col = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    const row = Number(m[2]) - 1;
    const { engine } = (window as unknown as { sheets: Sheets }).sheets;
    const vp = await engine.viewport(row, col, row, col);
    return { text: vp.cells[0]?.[2], edit: await engine.editText(row, col) };
  }, ref);
}

async function typeAt(page: Page, ref: string, value: string): Promise<void> {
  await page.getByTestId("namebox").fill(ref);
  await page.getByTestId("namebox").press("Enter");
  await page.keyboard.type(value);
  await page.keyboard.press("Enter");
}

/** Every cell in A1:F20 as text, for comparing two people's views. */
async function grid(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const { engine } = (window as unknown as { sheets: Sheets }).sheets;
    const vp = await engine.viewport(0, 0, 19, 5);
    return JSON.stringify(vp.cells.map((c: unknown[]) => [c[0], c[1], c[2]]));
  });
}

/** Alice starts a workbook and shares it; Bob opens the link in his own browser. */
async function pair(browser: Browser): Promise<{ alice: Page; bob: Page; url: string }> {
  const a = await browser.newContext();
  await a.grantPermissions(["clipboard-read", "clipboard-write"]);
  const alice = await a.newPage();
  await alice.goto("/");
  await expect(alice.getByTestId("status")).toHaveText("Ready");
  await typeAt(alice, "A1", "10");
  await alice.getByTestId("title").fill("Shared budget");
  await alice.getByTestId("share").click();
  await expect(alice.getByTestId("status")).toHaveText(/Link copied|Live/);
  await expect(alice).toHaveURL(/\?book=[0-9a-f]{32}$/);
  const url = alice.url();
  const bob = await (await browser.newContext()).newPage();
  await bob.goto(url);
  await expect(bob.getByTestId("status")).toHaveText(/Live/);
  return { alice, bob, url };
}

test("a shared link opens the same workbook, and edits flow both ways", async ({ browser }) => {
  const { alice, bob } = await pair(browser);
  await expect(bob.getByTestId("title")).toHaveValue("Shared budget");
  await expect.poll(async () => (await cell(bob, "A1")).text).toBe("10");

  await typeAt(alice, "A2", "=A1*3");
  await expect.poll(async () => (await cell(bob, "A2")).text).toBe("30");
  expect((await cell(bob, "A2")).edit).toBe("=A1*3");

  await typeAt(bob, "A1", "7");
  await expect.poll(async () => (await cell(alice, "A2")).text).toBe("21");

  // Each sees the other.
  await expect(alice.getByTestId("avatar")).toHaveCount(1);
  await expect(bob.getByTestId("avatar")).toHaveCount(1);
  await expect(alice.getByTestId("status")).toHaveText(/2 people · all changes saved/);
});

test("formatting and new sheets replicate; each person keeps their own view", async ({ browser }) => {
  const { alice, bob } = await pair(browser);
  await alice.getByTestId("namebox").fill("A1");
  await alice.getByTestId("namebox").press("Enter");
  await alice.getByRole("button", { name: "Bold" }).click();
  await expect
    .poll(() =>
      bob.evaluate(async () => {
        const { engine } = (window as unknown as { sheets: Sheets }).sheets;
        const vp = await engine.viewport(0, 0, 0, 0);
        return vp.styles[String(vp.cells[0]?.[4])]?.b === true;
      }),
    )
    .toBe(true);
  await bob.getByTestId("add-sheet").click();
  await expect(bob.getByRole("tab")).toHaveCount(2);
  await expect(alice.getByRole("tab")).toHaveCount(2);
  // Bob moved to the new sheet; Alice stayed where she was.
  await expect(bob.getByRole("tab").nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(alice.getByRole("tab").nth(0)).toHaveAttribute("aria-selected", "true");
  await typeAt(bob, "B2", "on sheet two");
  await alice.getByRole("tab").nth(1).click();
  await expect.poll(async () => (await cell(alice, "B2")).text).toBe("on sheet two");
});

test("simultaneous typing converges to the same workbook for everyone", async ({ browser }) => {
  const { alice, bob } = await pair(browser);
  await Promise.all([
    (async () => {
      for (let i = 1; i <= 6; i++) await typeAt(alice, `B${i}`, `a${i}`);
    })(),
    (async () => {
      for (let i = 1; i <= 6; i++) await typeAt(bob, `C${i}`, `=B${i}&"-b"`);
    })(),
    (async () => {
      await typeAt(alice, "D1", "first");
      await typeAt(bob, "D1", "second");
    })(),
  ]);
  await expect(alice.getByTestId("status")).toHaveText(/all changes saved/);
  await expect(bob.getByTestId("status")).toHaveText(/all changes saved/);
  await expect.poll(async () => (await grid(alice)) === (await grid(bob))).toBe(true);
  expect((await cell(bob, "C6")).text).toBe("a6-b");
});

test("undo is shared: it takes back the last change for everyone", async ({ browser }) => {
  const { alice, bob } = await pair(browser);
  await typeAt(alice, "E1", "keep");
  await typeAt(alice, "E1", "oops");
  await expect.poll(async () => (await cell(bob, "E1")).text).toBe("oops");
  await bob.keyboard.press("Control+z");
  await expect.poll(async () => (await cell(alice, "E1")).text).toBe("keep");
  await expect.poll(async () => (await cell(bob, "E1")).text).toBe("keep");
});

test("the server keeps the workbook: a reload shows everything", async ({ browser }) => {
  const { alice, bob, url } = await pair(browser);
  await typeAt(alice, "F5", "persisted");
  await expect.poll(async () => (await cell(bob, "F5")).text).toBe("persisted");
  await bob.close();
  const carol = await (await browser.newContext()).newPage();
  await carol.goto(url);
  await expect(carol.getByTestId("status")).toHaveText(/Live/);
  expect((await cell(carol, "F5")).text).toBe("persisted");
  expect((await cell(carol, "A1")).text).toBe("10");
});

test("edits made while offline are sent after reconnecting", async ({ browser }) => {
  const { alice, bob } = await pair(browser);
  // Drop Bob's connection from the server's side of things: close his socket and block the reconnect.
  await bob.context().setOffline(true);
  await bob.evaluate(() => {
    const s = (window as unknown as { sheets: { session: () => { ws: WebSocket | null } } }).sheets.session();
    s.ws?.close();
  });
  await expect(bob.getByTestId("status")).toHaveText(/Offline/);
  await typeAt(bob, "A10", "written offline");
  await expect(bob.getByTestId("status")).toHaveText(/Offline · 1 edit/);
  await typeAt(alice, "A11", "meanwhile");
  await bob.context().setOffline(false);
  await expect(bob.getByTestId("status")).toHaveText(/Live.*all changes saved/, { timeout: 20_000 });
  await expect.poll(async () => (await cell(alice, "A10")).text).toBe("written offline");
  await expect.poll(async () => (await cell(bob, "A11")).text).toBe("meanwhile");
  expect(await grid(alice)).toBe(await grid(bob));
});
