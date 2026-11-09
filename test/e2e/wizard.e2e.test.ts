import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startServer, type RunningServer } from '../../src/server/server.js';
import { SAMPLE_ELF } from '../helpers/tools.js';
import { createWorld } from '../helpers/world.js';

/**
 * Browser end-to-end test of the web UI against the real server, with fake Ghidra and mock Claude.
 * Enable with: npm run test:e2e   (builds first; needs Chromium for Playwright)
 */
const enabled = process.env['RECODE_E2E'] === '1';
const SCREENSHOTS = process.env['RECODE_E2E_SCREENSHOTS'] ?? path.resolve('docs/screenshots');

describe.skipIf(!enabled)('web UI end to end (Chromium)', () => {
  let browser: Browser;
  let server: RunningServer;
  let page: Page;
  let workDir: string;
  let root: string;

  beforeAll(async () => {
    browser = await chromium.launch(
      process.env['RECODE_E2E_CHROMIUM']
        ? { executablePath: process.env['RECODE_E2E_CHROMIUM'] }
        : {},
    );
    const world = await createWorld({ project: false });
    workDir = world.workDir;
    root = world.root;
    server = await startServer({
      workspace: workDir,
      staticDir: path.resolve('dist/web'),
      overrides: { skipPrerequisites: true },
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 2,
      acceptDownloads: true,
    });
    page = await context.newPage();
  }, 120_000);

  afterEach(() => undefined);
  afterAll(async () => {
    await browser?.close();
    await server?.close();
    if (root) await fs.rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const nav = () => page.getByRole('navigation', { name: 'Main' });
  const shot = (name: string): Promise<Buffer> =>
    page.screenshot({ path: path.join(SCREENSHOTS, `${name}.png`) });

  it('shows a clear message without the access token', async () => {
    const bare = await browser.newPage();
    await bare.goto(`http://127.0.0.1:${server.port}/`);
    await bare.getByText('Access token missing').waitFor();
    await bare.close();
  });

  it('walks through the whole wizard', { timeout: 180_000 }, async () => {
    await page.goto(server.url);
    await page.getByRole('heading', { name: 'Projects' }).waitFor();
    expect(page.url()).not.toContain('token='); // token removed from the address bar
    await page.getByText('No projects yet').waitFor();
    await shot('01-projects');

    // 1. create project
    await page.getByLabel('New project').fill('demo');
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByRole('heading', { name: 'demo' }).waitFor();
    await page.getByRole('heading', { name: '1. Import' }).waitFor();

    // 2. import: upload the compiled sample
    await page.getByTestId('file-input').setInputFiles(SAMPLE_ELF);
    await page.getByText(/Imported: sample-x86_64 \(elf, x86_64\)/).waitFor();
    await page.getByLabel('Use sample-x86_64').waitFor();
    await shot('02-import');
    await page.getByRole('button', { name: 'Next' }).click();

    // 3. analyze
    await page.getByRole('heading', { name: '2. Analyze' }).waitFor();
    await page.getByRole('button', { name: 'Start' }).click();
    await page
      .getByText(/analyze: .*6 functions/)
      .first()
      .waitFor({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Next' }).click();

    // 4. reconstruct with live progress
    await page.getByRole('heading', { name: '3. Reconstruct' }).waitFor();
    await page.getByRole('button', { name: 'Start' }).click();
    await page.getByText('8 of 8 tasks completed').waitFor({ timeout: 60_000 });
    await page.getByText('recode-c-reconstructor').first().waitFor();
    await page.getByText('add_ints @ 0x').first().waitFor();
    await shot('03-reconstruct');
    await page.getByRole('button', { name: 'Next' }).click();

    // 5. build
    await page.getByRole('heading', { name: '4. Build' }).waitFor();
    await page.getByRole('button', { name: 'Start' }).click();
    await page
      .getByText(/build succeeded/)
      .first()
      .waitFor({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Next' }).click();

    // 6. validate
    await page.getByRole('heading', { name: '5. Validate' }).waitFor();
    await page.getByRole('button', { name: 'Start' }).click();
    const compileRow = page.getByRole('row', { name: /Successful compilation/ });
    await compileRow.getByText('passed').waitFor({ timeout: 60_000 });
    await page
      .getByRole('row', { name: /Functional equivalence/ })
      .getByText('not-assessed')
      .waitFor();
    await shot('04-validate');
    await page.getByRole('button', { name: 'Next' }).click();

    // 7. download the generated C project
    await page.getByRole('heading', { name: '6. Download' }).waitFor();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: /Download C project/ }).click(),
    ]);
    const target = path.join(workDir, 'downloaded.zip');
    await download.saveAs(target);
    const zip = await fs.readFile(target);
    expect(zip.subarray(0, 2).toString()).toBe('PK');
    expect(zip.includes(Buffer.from('CMakeLists.txt'))).toBe(true);

    // The projects page now reflects the work.
    await nav().getByRole('link', { name: 'Projects' }).click();
    await page.getByText('1 binary · 0 reference files').waitFor();
  });

  it('reopens a finished project at its last step and survives a reload', async () => {
    await page.goto(`${server.url}#/projects/demo`);
    await page.getByRole('heading', { name: '6. Download' }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: '6. Download' }).waitFor();
  });

  it('switches themes and remembers the choice', async () => {
    await page.getByLabel('Theme').selectOption('midnight');
    expect(await page.locator('html').getAttribute('data-theme')).toBe('midnight');
    await shot('05-midnight');
    await page.reload();
    expect(await page.locator('html').getAttribute('data-theme')).toBe('midnight');
    await page.getByLabel('Theme').selectOption('default');
  });

  it('shows tool status in Doctor and edits settings', async () => {
    await nav().getByRole('link', { name: 'Doctor' }).click();
    await page
      .getByRole('row', { name: /Ghidra/ })
      .getByText('ok')
      .waitFor();
    await shot('06-doctor');
    await nav().getByRole('link', { name: 'Settings' }).click();
    await page.getByRole('heading', { name: 'Configuration' }).waitFor();
    const input = page.getByLabel('claude.maxParallelAgents');
    await input.fill('3');
    await page
      .getByRole('row', { name: /claude\.maxParallelAgents/ })
      .getByRole('button', { name: 'Save' })
      .click();
    await page.getByText('Saved claude.maxParallelAgents.').waitFor();
    await page.reload();
    await expect(page.getByLabel('claude.maxParallelAgents').inputValue()).resolves.toBe('3');
    await shot('07-settings');
  });

  it('can cancel a running reconstruction and resume it', { timeout: 120_000 }, async () => {
    await page.goto(server.url);
    await page.getByLabel('New project').fill('cancel-demo');
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByTestId('file-input').setInputFiles(SAMPLE_ELF);
    await page.getByText(/Imported:/).waitFor();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Start' }).click();
    await page
      .getByText(/analyze: .*6 functions/)
      .first()
      .waitFor({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Next' }).click();

    vi.stubEnv('MOCK_CLAUDE_MODE', 'hang');
    await page.getByRole('button', { name: 'Start' }).click();
    await page.getByRole('button', { name: 'Cancel' }).waitFor();
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page
      .getByText('Progress is saved. Run the step again to resume.')
      .waitFor({ timeout: 30_000 });

    vi.stubEnv('MOCK_CLAUDE_MODE', 'ok');
    await page.getByRole('button', { name: 'Resume' }).click();
    await page.getByText('8 of 8 tasks completed').waitFor({ timeout: 60_000 });
  });
});
