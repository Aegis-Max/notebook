import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const temporaryDirectories: string[] = [];
let application: ElectronApplication | null = null;

async function launch(userDataPath: string): Promise<{
  application: ElectronApplication;
  page: Page;
}> {
  const launched = await electron.launch({
    args: [projectRoot],
    env: {
      ...process.env,
      CORNELL_AI_MOCK: '1',
      CORNELL_TEST_USER_DATA: userDataPath,
    },
  });
  const page = await launched.firstWindow();
  await page.locator('#note-title').waitFor();
  application = launched;
  return { application: launched, page };
}

async function createUserData(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cornell-electron-e2e-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function closeApplication(): Promise<void> {
  if (application) await application.close().catch(() => undefined);
  application = null;
}

test.afterEach(async () => {
  await closeApplication();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test('安全 preload 白名单可用，笔记跨 Electron 重启持久化', async () => {
  const userData = await createUserData();
  let launched = await launch(userData);
  const initialUrl = launched.page.url();
  const boundary = await launched.page.evaluate(() => {
    const api = window.cornellDesktop;
    return {
      isDesktop: api?.isDesktop,
      topLevelKeys: api ? Object.keys(api).sort() : [],
      noteKeys: api ? Object.keys(api.notes).sort() : [],
      hasRequire: typeof (window as unknown as { require?: unknown }).require,
      hasProcess: typeof (window as unknown as { process?: unknown }).process,
      opened: window.open('https://example.com') !== null,
    };
  });

  expect(boundary).toEqual({
    isDesktop: true,
    topLevelKeys: ['ai', 'isDesktop', 'notes', 'platform', 'review'],
    noteKeys: ['exportBackup', 'importBackup', 'load', 'print', 'save'],
    hasRequire: 'undefined',
    hasProcess: 'undefined',
    opened: false,
  });
  await launched.page.waitForTimeout(100);
  expect(launched.application.windows()).toHaveLength(1);
  expect(launched.page.url()).toBe(initialUrl);

  const saveResult = await launched.page.evaluate(() =>
    window.cornellDesktop!.notes.save([
      {
        id: 'restart-note',
        title: '重启恢复',
        date: '2026-09-04',
        cues: '为什么要主动回忆？',
        notes: '主动回忆比重复阅读更有利于长期保持。',
        summary: '主动提取记忆能暴露学习盲点。',
        createdAt: '2026-09-04T01:00:00.000Z',
        updatedAt: '2026-09-04T01:00:00.000Z',
      },
    ]),
  );
  expect(saveResult).toEqual({ ok: true, error: null });

  await closeApplication();
  launched = await launch(userData);
  const loaded = await launched.page.evaluate(() => window.cornellDesktop!.notes.load());
  expect(loaded.error).toBeNull();
  expect(loaded.notes).toHaveLength(1);
  expect(loaded.notes[0]).toMatchObject({
    id: 'restart-note',
    title: '重启恢复',
    summary: '主动提取记忆能暴露学习盲点。',
  });
});

test('mock 学习教练执行闭卷披露、元认知优先排期和幂等评价', async () => {
  const { page } = await launch(await createUserData());
  await page.evaluate(() =>
    window.cornellDesktop!.notes.save([
      {
        id: 'coach-note',
        title: 'TCP 复习',
        date: '2026-09-04',
        cues: 'TCP 为什么需要三次握手？',
        notes: 'TCP 通过三次握手建立连接。\n\n客户端首先发送 SYN。',
        summary: '',
        createdAt: '2026-09-04T01:00:00.000Z',
        updatedAt: '2026-09-04T01:00:00.000Z',
      },
    ]),
  );

  const result = await page.evaluate(async () => {
    const api = window.cornellDesktop!;
    let summaryRequired = false;
    try {
      await api.review.startRecall('coach-note', 3);
    } catch {
      summaryRequired = true;
    }

    const started = await api.review.startRecall('coach-note', 3, true);
    let earlyRevealRejected = false;
    try {
      await api.review.revealHint(started.sessionId, 1);
    } catch {
      earlyRevealRejected = true;
    }
    const submitted = await api.review.submitInitialAnswer(
      started.sessionId,
      'TCP 使用握手建立可靠连接',
      'high',
    );
    const revealed = await api.review.revealHint(started.sessionId, 3);
    const firstEvaluation = await api.review.evaluateAnswer(started.sessionId);
    const secondEvaluation = await api.review.evaluateAnswer(started.sessionId);
    const overview = await api.review.getOverview('coach-note');
    return {
      summaryRequired,
      earlyRevealRejected,
      started,
      submitted,
      revealed,
      firstEvaluation,
      evaluationsEqual:
        JSON.stringify(firstEvaluation) === JSON.stringify(secondEvaluation),
      overview,
    };
  });

  expect(result.summaryRequired).toBe(true);
  expect(result.earlyRevealRejected).toBe(true);
  expect(result.started.currentQuestion?.visibleHint).toBeNull();
  expect(result.started.currentQuestion?.visibleEvidence).toEqual([]);
  expect(JSON.stringify(result.started)).not.toContain('assessmentPoints');
  expect(JSON.stringify(result.started)).not.toContain('standardAnswer');
  expect(result.submitted.currentQuestion?.initialAnswer).toBe(
    'TCP 使用握手建立可靠连接',
  );
  expect(result.revealed.currentQuestion?.visibleEvidence.length).toBeGreaterThan(0);
  expect(result.firstEvaluation.currentQuestion?.feedback).not.toBeNull();
  expect(result.evaluationsEqual).toBe(true);
  expect(result.overview.metrics.attemptedCount).toBe(1);
  expect(result.overview.cards).toHaveLength(1);

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const expectedDueDate = [
    tomorrow.getFullYear(),
    String(tomorrow.getMonth() + 1).padStart(2, '0'),
    String(tomorrow.getDate()).padStart(2, '0'),
  ].join('-');
  expect(result.overview.cards[0].dueDate).toBe(expectedDueDate);
  expect(result.overview.cards[0].stage).toBe(0);
});

test('原生对话框完成 v2 导出、v1 导入，打印走主进程', async () => {
  const userData = await createUserData();
  const { application: launched, page } = await launch(userData);
  const exportPath = join(userData, 'exported-backup.json');
  const importPath = join(userData, 'legacy-backup.json');

  await page.evaluate(() =>
    window.cornellDesktop!.notes.save([
      {
        id: 'desktop-note',
        title: '桌面笔记',
        date: '2026-09-04',
        cues: '线索',
        notes: '正文',
        summary: '我的总结',
        createdAt: '2026-09-04T01:00:00.000Z',
        updatedAt: '2026-09-04T01:00:00.000Z',
      },
    ]),
  );
  await launched.evaluate(({ dialog }, targetPath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: targetPath });
  }, exportPath);
  const exported = await page.evaluate(() =>
    window.cornellDesktop!.notes.exportBackup(),
  );
  expect(exported).toEqual({ ok: true, error: null, filePath: exportPath });
  const backup = JSON.parse(await readFile(exportPath, 'utf8')) as Record<string, unknown>;
  expect(backup.schemaVersion).toBe(2);
  expect(backup).toHaveProperty('review');
  expect(backup).not.toHaveProperty('settings');
  expect(JSON.stringify(backup)).not.toContain('encryptedCloudCredential');

  await writeFile(
    importPath,
    JSON.stringify({
      schemaVersion: 1,
      exportedAt: '2026-09-04T03:00:00.000Z',
      notes: [
        {
          id: 'legacy-note',
          title: '网页版旧笔记',
          date: '2026-09-04',
          cues: '旧线索',
          notes: '旧正文',
          summary: '旧总结',
          createdAt: '2026-09-04T01:00:00.000Z',
          updatedAt: '2026-09-04T02:00:00.000Z',
        },
      ],
    }),
    'utf8',
  );
  await launched.evaluate(({ dialog }, targetPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [targetPath] });
  }, importPath);
  const imported = await page.evaluate(() =>
    window.cornellDesktop!.notes.importBackup(),
  );
  expect(imported.ok).toBe(true);
  expect(imported.addedCount).toBe(1);
  expect(imported.notes.map((note) => note.id)).toContain('legacy-note');

  await launched.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]?.webContents;
    if (!contents) throw new Error('主窗口不存在');
    contents.print = (_options, callback) => callback(true, '');
  });
  await expect(
    page.evaluate(() => window.cornellDesktop!.notes.print()),
  ).resolves.toEqual({ ok: true, error: null });
});

test('真实界面完成内化复习，并在重启后显示可继续会话与复习队列', async () => {
  const userData = await createUserData();
  let launched = await launch(userData);
  const page = launched.page;

  await page.getByTestId('note-title').fill('主动回忆课程');
  await page
    .getByTestId('notes-input')
    .fill('主动回忆要求学习者先从记忆中提取信息。\n\n分散练习有助于长期保持。');
  await page
    .getByTestId('cues-input')
    .fill('主动回忆为什么比重复阅读更有效？');
  await expect(page.getByTestId('save-status')).toHaveAttribute(
    'data-state',
    'saved',
  );

  await page.getByTestId('study-button').click();
  await expect(page.getByTestId('review-home')).toBeVisible();
  await page.getByTestId('review-prepare-button').click();
  await page.getByLabel('我确认只用当前笔记开始本次复习').check();
  await page.getByRole('button', { name: '继续：先写总结' }).click();
  await page
    .getByTestId('review-summary-input')
    .fill('我认为主动回忆会暴露哪些内容还不能独立想起。');
  await page.getByTestId('review-start-button').click();

  await expect(page.getByTestId('review-question')).toBeVisible();
  await expect(page.locator('.workspace')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('.workspace')).toHaveAttribute('inert', '');
  await expect(page.getByTestId('review-hint-1')).toHaveCount(0);
  await expect(page.getByTestId('review-evidence')).toHaveCount(0);
  await expect(page.getByTestId('review-feedback')).toHaveCount(0);

  await page
    .getByTestId('review-answer-input')
    .fill('主动回忆会让学习者自己提取信息，并发现还没有掌握的部分。');
  await page.getByTestId('confidence-high').click();
  await page.getByTestId('review-submit-answer').click();
  await expect(page.getByTestId('review-hint-1')).toBeVisible();
  await expect(page.getByTestId('review-evidence')).toHaveCount(0);

  await page.getByTestId('review-hint-1').click();
  await page.getByTestId('review-hint-2').click();
  await page.getByTestId('review-hint-3').click();
  await expect(page.getByTestId('review-evidence')).toBeVisible();
  await page.getByTestId('review-evaluate').click();
  await expect(page.getByTestId('review-feedback')).toBeVisible();
  await expect(page.getByTestId('review-feedback').locator('blockquote').first()).toBeVisible();

  await closeApplication();
  launched = await launch(userData);
  await launched.page.getByTestId('study-button').click();
  await expect(launched.page.getByRole('button', { name: /继续上次复习/ })).toBeVisible();
  await expect(launched.page.locator('.review-card-list li')).toHaveCount(1);
});
