import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const selectors = {
  cues: '#cues-input',
  date: '#note-date',
  deleteNote: '#delete-note-button',
  export: '#export-button',
  import: '#import-button',
  importFile: '#import-file',
  mobileListToggle: '#mobile-list-toggle',
  newNote: '#new-note-button',
  noteItem: '[data-testid="note-item"]',
  noteList: '#note-list',
  notes: '#notes-input',
  print: '#print-button',
  saveStatus: '#save-status',
  search: '#search-input',
  summary: '#summary-input',
  title: '#note-title',
  utilityMenu: '[data-testid="utility-menu"]',
  utilityMenuToggle: '#utility-menu-toggle',
  version: '#app-version',
};

const savedStatusPattern = /已保存|保存成功|保存于|saved/i;
const builtInExample = {
  id: 'builtin-example:codex-workshop:v1',
  seedStateKey: 'cornell-builtin-example-seed:codex-workshop:v1',
  title: 'Codex 工作坊：从基础使用到插件、技能与自动化',
};

function makeToken(label) {
  return `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function watchConsole(page) {
  const issues = [];

  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      issues.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    issues.push(`pageerror: ${error.message}`);
  });

  return issues;
}

const consoleIssuesByPage = new WeakMap();

test.beforeEach(async ({ page }) => {
  consoleIssuesByPage.set(page, watchConsole(page));
});

test.afterEach(async ({ page }) => {
  expect(
    consoleIssuesByPage.get(page),
    '页面不应产生 console warning/error 或未捕获异常',
  ).toEqual([]);
});

async function openApp(page) {
  const response = await page.goto('/');
  expect(response?.ok(), '首页应成功返回').toBe(true);
  await expect(page).toHaveTitle(/康奈尔|Cornell/i);
  await expect(page.locator('body')).toContainText(/康奈尔|Cornell/i);
}

async function expectEditorReady(page) {
  for (const selector of [
    selectors.newNote,
    selectors.search,
    selectors.title,
    selectors.date,
    selectors.cues,
    selectors.notes,
    selectors.summary,
    selectors.saveStatus,
    selectors.version,
  ]) {
    await expect(page.locator(selector), `${selector} 应可见`).toBeVisible();
  }

  await expect(page.locator(selectors.importFile)).toBeAttached();
  await expect(page.locator(selectors.deleteNote)).toBeAttached();
  await expect(page.locator(selectors.noteList)).toBeAttached();
  await expect(page.locator(selectors.utilityMenu)).toBeAttached();
}

async function ensureNoteListOpen(page) {
  const toggle = page.locator(selectors.mobileListToggle);

  if (await toggle.isVisible()) {
    if (await toggle.getAttribute('aria-expanded') !== 'true') {
      await toggle.click();
    }
  }

  await expect(page.locator(selectors.noteList)).toBeVisible();
}

async function expectStored(page, marker) {
  await expect.poll(
    () => page.evaluate((value) => {
      return Object.values(localStorage).some((entry) => entry?.includes(value));
    }, marker),
    { message: `localStorage 应保存 ${marker}` },
  ).toBe(true);
  await expect(page.locator(selectors.saveStatus)).toHaveText(savedStatusPattern);
}

async function fillCurrentNote(page, note) {
  await page.locator(selectors.title).fill(note.title);
  await page.locator(selectors.date).fill(note.date);
  await page.locator(selectors.cues).fill(note.cues);
  await page.locator(selectors.notes).fill(note.notes);
  await page.locator(selectors.summary).fill(note.summary);
  await expectStored(page, note.title);
}

async function createNote(page, overrides = {}) {
  const marker = makeToken('康奈尔测试');
  const note = {
    title: marker,
    date: '2026-09-03',
    cues: `线索：${marker}\n核心问题是什么？`,
    notes: `详细笔记：${marker}\n- 第一条\n- 第二条`,
    summary: `摘要：${marker}`,
    ...overrides,
  };

  await page.locator(selectors.newNote).click();
  await fillCurrentNote(page, note);
  return note;
}

async function openUtilityAction(page, actionSelector) {
  const action = page.locator(actionSelector);

  if (!(await action.isVisible())) {
    const toggle = page.locator(selectors.utilityMenuToggle);
    await expect(toggle).toBeVisible();
    await toggle.click();
  }

  await expect(action).toBeVisible();
  return action;
}

async function deleteCurrentNote(page) {
  page.once('dialog', async (dialog) => {
    expect(dialog.type()).toBe('confirm');
    await dialog.accept();
  });
  const deleteButton = await openUtilityAction(page, selectors.deleteNote);
  await deleteButton.click();

  const customConfirmButton = page.locator('#delete-confirm-button');
  if (await customConfirmButton.isVisible()) {
    await customConfirmButton.click();
  }
}

async function chooseImportFile(page, file) {
  const importButton = await openUtilityAction(page, selectors.import);
  const fileChooserPromise = page.waitForEvent('filechooser');
  await importButton.click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(file);
}

async function tabUntilFocused(page, selector, maximumTabs = 20) {
  for (let count = 0; count < maximumTabs; count += 1) {
    await page.keyboard.press('Tab');
    if (await page.locator(selector).evaluate((element) => element === document.activeElement)) {
      return;
    }
  }

  throw new Error(`${selector} 无法通过 ${maximumTabs} 次 Tab 聚焦`);
}

test('全新浏览器存储内置一份经典示例，删除后刷新不复活', async ({ page }) => {
  await openApp(page);
  await expectEditorReady(page);
  await expect(page.locator(selectors.title)).toHaveValue(builtInExample.title);
  await expect(page.locator(selectors.cues)).not.toHaveValue('');
  await expect(page.locator(selectors.notes)).not.toHaveValue('');
  await expect(page.locator(selectors.summary)).not.toHaveValue('');
  await ensureNoteListOpen(page);

  const exampleItem = page.locator(
    `${selectors.noteItem}[data-note-id="${builtInExample.id}"]`,
  );
  await expect(page.locator(selectors.noteItem)).toHaveCount(1);
  await expect(exampleItem).toHaveCount(1);
  expect(await page.evaluate(
    (key) => localStorage.getItem(key),
    builtInExample.seedStateKey,
  )).toBe('complete');

  await page.reload();
  await expect(page.locator(selectors.title)).toHaveValue(builtInExample.title);
  await ensureNoteListOpen(page);
  await expect(page.locator(selectors.noteItem)).toHaveCount(1);
  await expect(exampleItem).toHaveCount(1);

  const deleteButton = await openUtilityAction(page, selectors.deleteNote);
  await deleteButton.click();
  await page.locator('#delete-confirm-button').click();
  await expect(page.locator(selectors.title)).toHaveValue('');
  await ensureNoteListOpen(page);
  await expect(exampleItem).toHaveCount(0);
  await expect(page.locator(selectors.noteItem)).toHaveCount(1);
  const blankNoteId = await page.locator(selectors.noteItem).getAttribute('data-note-id');
  expect(blankNoteId).toBeTruthy();
  expect(blankNoteId).not.toBe(builtInExample.id);

  await page.reload();
  await expect(page.locator(selectors.title)).toHaveValue('');
  await ensureNoteListOpen(page);
  await expect(exampleItem).toHaveCount(0);
  await expect(page.locator(selectors.noteItem)).toHaveCount(1);
  await expect(page.locator(selectors.noteItem)).toHaveAttribute('data-note-id', blankNoteId);
});

test('已有合法空库首次升级时也播种内置示例', async ({ page }) => {
  await page.addInitScript(({ key }) => {
    localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, notes: [] }));
  }, { key: 'cornell-notes:v1' });

  await openApp(page);
  await expectEditorReady(page);
  await expect(page.locator(selectors.title)).toHaveValue(builtInExample.title);
  await ensureNoteListOpen(page);
  await expect(
    page.locator(`${selectors.noteItem}[data-note-id="${builtInExample.id}"]`),
  ).toHaveCount(1);
  await expect(page.locator(selectors.noteItem)).toHaveCount(1);
  expect(await page.evaluate(
    (key) => localStorage.getItem(key),
    builtInExample.seedStateKey,
  )).toBe('complete');
});

test('首页完整加载，核心控件可用且控制台健康', async ({ page }) => {
  await openApp(page);
  await expectEditorReady(page);
  await expect(page.locator(selectors.version)).toHaveText('v1.0');

  const [versionBox, saveStatusBox] = await Promise.all([
    page.locator(selectors.version).boundingBox(),
    page.locator(selectors.saveStatus).boundingBox(),
  ]);
  expect(versionBox).not.toBeNull();
  expect(saveStatusBox).not.toBeNull();
  expect(versionBox.x + versionBox.width).toBeLessThanOrEqual(saveStatusBox.x);
});

test('创建并编辑康奈尔笔记后，刷新仍能恢复全部内容', async ({ page }) => {
  await openApp(page);
  const note = await createNote(page);

  await ensureNoteListOpen(page);
  await expect(page.locator(selectors.noteItem).filter({ hasText: note.title })).toHaveCount(1);
  await page.reload();

  await expect(page.locator(selectors.title)).toHaveValue(note.title);
  await expect(page.locator(selectors.date)).toHaveValue(note.date);
  await expect(page.locator(selectors.cues)).toHaveValue(note.cues);
  await expect(page.locator(selectors.notes)).toHaveValue(note.notes);
  await expect(page.locator(selectors.summary)).toHaveValue(note.summary);
});

test('搜索会筛选笔记，删除只移除当前笔记', async ({ page }) => {
  await openApp(page);
  const first = await createNote(page, { title: makeToken('项目甲') });
  const second = await createNote(page, { title: makeToken('项目乙') });

  await page.locator(selectors.search).fill(first.title);
  await ensureNoteListOpen(page);
  await expect(page.locator(selectors.noteItem).filter({ hasText: first.title })).toHaveCount(1);
  await expect(page.locator(selectors.noteItem).filter({ hasText: second.title })).toHaveCount(0);

  await page.locator(selectors.search).fill('');
  await expect(page.locator(selectors.noteItem).filter({ hasText: first.title })).toHaveCount(1);
  await expect(page.locator(selectors.noteItem).filter({ hasText: second.title })).toHaveCount(1);

  await page.locator(selectors.noteItem).filter({ hasText: first.title }).click();
  await expect(page.locator(selectors.title)).toHaveValue(first.title);
  await deleteCurrentNote(page);

  await expect(page.locator(selectors.noteItem).filter({ hasText: first.title })).toHaveCount(0);
  await expect(page.locator(selectors.noteItem).filter({ hasText: second.title })).toHaveCount(1);
});

test('删除最后一篇笔记后自动创建空白笔记并正确管理焦点', async ({ page }) => {
  await openApp(page);
  await page.locator(selectors.title).fill('最后一篇笔记');
  await expectStored(page, '最后一篇笔记');

  const deleteButton = await openUtilityAction(page, selectors.deleteNote);
  await deleteButton.click();
  await expect(page.locator('#delete-dialog')).toBeVisible();
  await expect(page.locator('#delete-cancel-button')).toBeFocused();
  await page.locator('#delete-confirm-button').click();

  await expect(page.locator(selectors.title)).toBeFocused();
  await ensureNoteListOpen(page);
  await expect(page.locator(selectors.noteItem)).toHaveCount(1);
  await expect(page.locator(selectors.title)).toHaveValue('');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('cornell-notes:v1')).notes.length)).toBe(1);
});

test('键盘切换笔记后焦点保持在可继续操作的位置', async ({ page }, testInfo) => {
  await openApp(page);
  const first = await createNote(page, { title: makeToken('键盘甲') });
  await createNote(page, { title: makeToken('键盘乙') });
  await ensureNoteListOpen(page);

  const firstItem = page.locator(selectors.noteItem).filter({ hasText: first.title });
  await firstItem.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(selectors.title)).toHaveValue(first.title);

  if (testInfo.project.name === 'mobile-chrome') {
    await expect(page.locator(selectors.title)).toBeFocused();
  } else {
    await expect(page.locator(selectors.noteItem).filter({ hasText: first.title })).toBeFocused();
  }
});

test('导出的 JSON 可以通过导入按钮完整恢复', async ({ page }) => {
  await openApp(page);
  const note = await createNote(page, { title: makeToken('导入导出') });
  const exportButton = await openUtilityAction(page, selectors.export);
  const downloadPromise = page.waitForEvent('download');

  await exportButton.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.json$/i);

  const downloadPath = await download.path();
  expect(downloadPath, '导出文件应可读取').not.toBeNull();
  const exportedText = await readFile(downloadPath, 'utf8');
  const exportedBackup = JSON.parse(exportedText);
  const exportedNote = exportedBackup.notes.find((entry) => entry.title === note.title);
  expect(exportedNote).toMatchObject({
    title: note.title,
    date: note.date,
    cues: note.cues,
    notes: note.notes,
    summary: note.summary,
  });

  await deleteCurrentNote(page);
  await expect(page.locator(selectors.noteItem).filter({ hasText: note.title })).toHaveCount(0);

  await chooseImportFile(page, downloadPath);

  await ensureNoteListOpen(page);
  await expect(page.locator(selectors.noteItem).filter({ hasText: note.title })).toHaveCount(1);
  await page.locator(selectors.noteItem).filter({ hasText: note.title }).click();
  await expect(page.locator(selectors.cues)).toHaveValue(note.cues);
  await expect(page.locator(selectors.notes)).toHaveValue(note.notes);
  await expect(page.locator(selectors.summary)).toHaveValue(note.summary);
});

test('笔记标题中的脚本标记只作为文本显示', async ({ page }) => {
  await openApp(page);
  const scriptText = '<script>window.__xss=1</script>';
  await createNote(page, { title: scriptText });
  await ensureNoteListOpen(page);

  const matchingItem = page.locator(selectors.noteItem).filter({ hasText: scriptText });
  await expect(matchingItem).toHaveCount(1);
  await expect(matchingItem).toContainText(scriptText);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  await expect(page.locator('script').filter({ hasText: 'window.__xss=1' })).toHaveCount(0);
});

test('非法 JSON 导入会保留现有笔记并显示错误提示', async ({ page }) => {
  await openApp(page);
  const note = await createNote(page, { title: makeToken('非法导入保护') });
  await ensureNoteListOpen(page);

  const itemCountBefore = await page.locator(selectors.noteItem).count();
  const storageBefore = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  await chooseImportFile(page, {
    name: 'invalid-cornell-notes.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{ "notes": [ this is not valid JSON ]'),
  });

  await expect(page.locator('#toast')).toBeVisible();
  await expect(page.locator('#toast')).toContainText(/无效|失败|格式|解析|JSON/i);
  await expect(page.locator(selectors.title)).toHaveValue(note.title);
  await expect(page.locator(selectors.cues)).toHaveValue(note.cues);
  await expect(page.locator(selectors.notes)).toHaveValue(note.notes);
  await expect(page.locator(selectors.summary)).toHaveValue(note.summary);
  await ensureNoteListOpen(page);
  await expect(page.locator(selectors.noteItem)).toHaveCount(itemCountBefore);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).toBe(storageBefore);
});

test('损坏的本地数据会进入可用空白状态且不会被自动覆盖', async ({ page }) => {
  const damagedPayload = '{损坏的本地数据';
  await page.addInitScript(({ key, value }) => {
    localStorage.setItem(key, value);
  }, { key: 'cornell-notes:v1', value: damagedPayload });

  await openApp(page);
  await expectEditorReady(page);
  await expect(page.locator(selectors.title)).toHaveValue('');
  await expect(page.locator('#toast')).toContainText(/本地数据无法读取/);
  await expect(page.locator(selectors.saveStatus)).toContainText('保存失败');
  expect(await page.evaluate(() => localStorage.getItem('cornell-notes:v1'))).toBe(damagedPayload);
});

test('本地存储被浏览器拒绝时应用仍可编辑并导出内存备份', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('访问被拒绝', 'SecurityError');
      },
    });
  });

  await openApp(page);
  await expectEditorReady(page);
  await page.locator(selectors.title).fill('无本地存储的笔记');
  await expect(page.locator(selectors.saveStatus)).toContainText('保存失败');

  const exportButton = await openUtilityAction(page, selectors.export);
  const downloadPromise = page.waitForEvent('download');
  await exportButton.click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const backup = JSON.parse(await readFile(downloadPath, 'utf8'));
  expect(backup.notes.some((entry) => entry.title === '无本地存储的笔记')).toBe(true);
});

test('删除写入失败时保留原笔记并显示失败状态', async ({ page }) => {
  await openApp(page);
  const title = makeToken('删除回滚');
  await page.locator(selectors.title).fill(title);
  await expectStored(page, title);
  await page.evaluate(() => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function failOnce(...args) {
      Storage.prototype.setItem = originalSetItem;
      throw new DOMException(`拒绝写入 ${args[0]}`, 'QuotaExceededError');
    };
  });

  const deleteButton = await openUtilityAction(page, selectors.deleteNote);
  await deleteButton.click();
  await page.locator('#delete-confirm-button').click();

  await expect(page.locator(selectors.title)).toHaveValue(title);
  await expect(page.locator(selectors.saveStatus)).toContainText('保存失败');
  await expect(page.locator('#toast')).toContainText(/删除失败/);
  await ensureNoteListOpen(page);
  await expect(page.locator(selectors.noteItem).filter({ hasText: title })).toHaveCount(1);
});

test('日期不能被清空，恢复后仍可继续保存和导出', async ({ page }) => {
  await openApp(page);
  const note = await createNote(page, { title: makeToken('日期保护') });
  await page.locator(selectors.date).fill('');

  await expect(page.locator(selectors.date)).toHaveValue(note.date);
  await expect(page.locator('#toast')).toContainText(/日期不能为空/);

  const updatedTitle = `${note.title}-继续编辑`;
  await page.locator(selectors.title).fill(updatedTitle);
  await expectStored(page, updatedTitle);

  const exportButton = await openUtilityAction(page, selectors.export);
  const downloadPromise = page.waitForEvent('download');
  await exportButton.click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const backup = JSON.parse(await readFile(downloadPath, 'utf8'));
  expect(backup.notes.find((entry) => entry.title === updatedTitle)?.date).toBe(note.date);
});

test('主要操作支持键盘焦点，手机触控目标不小于 44px', async ({ page }, testInfo) => {
  await openApp(page);
  await expect(page.locator(selectors.importFile)).toHaveAttribute('tabindex', '-1');

  if (testInfo.project.name === 'mobile-chrome') {
    for (const selector of [
      selectors.newNote,
      selectors.mobileListToggle,
      selectors.utilityMenuToggle,
      selectors.title,
      selectors.date,
      '.brand',
    ]) {
      const control = page.locator(selector);
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box, `${selector} 应有可测量的触控区域`).not.toBeNull();
      expect(box.width, `${selector} 的触控宽度`).toBeGreaterThanOrEqual(44);
      expect(box.height, `${selector} 的触控高度`).toBeGreaterThanOrEqual(44);
    }

    await page.locator(selectors.utilityMenuToggle).click();
    for (const selector of [
      selectors.import,
      selectors.export,
      selectors.print,
      selectors.deleteNote,
    ]) {
      const control = page.locator(selector);
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box, `${selector} 应有可测量的触控区域`).not.toBeNull();
      expect(box.width, `${selector} 的触控宽度`).toBeGreaterThanOrEqual(44);
      expect(box.height, `${selector} 的触控高度`).toBeGreaterThanOrEqual(44);
    }

    await page.keyboard.press('Escape');
    await expect(page.locator(selectors.utilityMenuToggle)).toBeFocused();
    for (const [selector, fieldSelector] of [
      [selectors.title, '.title-field'],
      [selectors.date, '.date-field'],
    ]) {
      await page.locator(selector).focus();
      const boxShadow = await page.locator(fieldSelector).evaluate((element) => {
        return getComputedStyle(element).boxShadow;
      });
      expect(boxShadow, `${selector} 聚焦时应有清晰视觉反馈`).not.toBe('none');
    }

    await ensureNoteListOpen(page);
    await page.locator(`${selectors.noteItem}[aria-current="page"]`).focus();
    await page.keyboard.press('Escape');
    await expect(page.locator(selectors.mobileListToggle)).toBeFocused();

    const deleteButton = await openUtilityAction(page, selectors.deleteNote);
    await deleteButton.click();
    await expect(page.locator(selectors.utilityMenu)).toBeHidden();
    for (const selector of ['#delete-cancel-button', '#delete-confirm-button']) {
      const box = await page.locator(selector).boundingBox();
      expect(box, `${selector} 应有可测量的触控区域`).not.toBeNull();
      expect(box.width, `${selector} 的触控宽度`).toBeGreaterThanOrEqual(44);
      expect(box.height, `${selector} 的触控高度`).toBeGreaterThanOrEqual(44);
    }
    await page.locator('#delete-cancel-button').click();
    return;
  }

  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await tabUntilFocused(page, selectors.newNote);
  const focusAppearance = await page.locator(selectors.newNote).evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      focusVisible: element.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      boxShadow: style.boxShadow,
    };
  });

  expect(focusAppearance.focusVisible).toBe(true);
  expect(
    (
      focusAppearance.outlineStyle !== 'none'
      && focusAppearance.outlineWidth !== '0px'
    ) || focusAppearance.boxShadow !== 'none',
    '键盘焦点应有清晰可见的轮廓或阴影',
  ).toBe(true);
  await tabUntilFocused(page, selectors.search);
});

test('康奈尔区域随桌面与手机视口正确重排且无水平溢出', async ({ page }, testInfo) => {
  await openApp(page);
  await expectEditorReady(page);

  const boxes = await Promise.all([
    page.locator(selectors.cues).boundingBox(),
    page.locator(selectors.notes).boundingBox(),
    page.locator(selectors.summary).boundingBox(),
  ]);
  const [cuesBox, notesBox, summaryBox] = boxes;

  expect(cuesBox).not.toBeNull();
  expect(notesBox).not.toBeNull();
  expect(summaryBox).not.toBeNull();

  if (testInfo.project.name === 'mobile-chrome') {
    expect(cuesBox.y).toBeGreaterThanOrEqual(notesBox.y + notesBox.height - 2);
  } else {
    expect(notesBox.x).toBeGreaterThanOrEqual(cuesBox.x + cuesBox.width - 2);
  }
  expect(summaryBox.y).toBeGreaterThanOrEqual(
    Math.max(cuesBox.y + cuesBox.height, notesBox.y + notesBox.height) - 2,
  );

  const hasHorizontalOverflow = await page.evaluate(() => {
    return document.documentElement.scrollWidth > window.innerWidth + 1;
  });
  expect(hasHorizontalOverflow, '页面不应出现水平滚动条').toBe(false);
});

test('长文本会自动换行，并在手机端完整展开', async ({ page }, testInfo) => {
  await openApp(page);
  const editor = page.locator(selectors.notes);
  const initialHeight = (await editor.boundingBox()).height;
  const longText = Array.from(
    { length: 80 },
    (_, index) => `第 ${index + 1} 行：这是一段用于验证手机端长文本自动换行与完整访问的课堂笔记内容。`,
  ).join('\n');
  await editor.fill(longText);

  const metrics = await editor.evaluate((element) => ({
    clientHeight: element.clientHeight,
    clientWidth: element.clientWidth,
    overflowY: getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight,
    scrollWidth: element.scrollWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);

  if (testInfo.project.name === 'mobile-chrome') {
    expect(metrics.clientHeight).toBeGreaterThan(initialHeight);
    expect(metrics.clientHeight).toBeGreaterThanOrEqual(metrics.scrollHeight - 1);
  } else {
    expect(metrics.overflowY).toBe('auto');
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  }
});

test('打印媒体保留笔记内容并隐藏应用操作控件', async ({ page }) => {
  await openApp(page);
  await createNote(page, { title: makeToken('打印') });
  await page.emulateMedia({ media: 'print' });

  expect(await page.evaluate(() => window.matchMedia('print').matches)).toBe(true);
  for (const selector of [selectors.cues, selectors.notes, selectors.summary]) {
    await expect(page.locator(selector)).toBeVisible();
  }
  for (const selector of [
    selectors.newNote,
    selectors.search,
    selectors.deleteNote,
    selectors.utilityMenu,
  ]) {
    await expect(page.locator(selector), `${selector} 在打印时应隐藏`).toBeHidden();
  }

  const hasHorizontalOverflow = await page.evaluate(() => {
    return document.documentElement.scrollWidth > window.innerWidth + 1;
  });
  expect(hasHorizontalOverflow, '打印布局不应横向溢出').toBe(false);
});
