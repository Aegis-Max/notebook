import { stat, readFile, writeFile } from 'node:fs/promises';

import {
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
} from 'electron';

import type { AiClient } from './ai-client.js';
import { IPC_CHANNELS } from './channels.js';
import type { DesktopDataService } from './data-service.js';
import { DesktopError, errorMessage } from './errors.js';
import type { SecureSettingsService } from './secure-settings.js';
import type { StudyCoachService } from './study-coach.js';

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

interface IpcServices {
  data: DesktopDataService;
  settings: SecureSettingsService;
  ai: AiClient;
  coach: StudyCoachService;
  getWindow: () => BrowserWindow | null;
}

function assertTrustedSender(
  event: IpcMainInvokeEvent,
  getWindow: () => BrowserWindow | null,
): void {
  const window = getWindow();
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new DesktopError('UNTRUSTED_IPC_SENDER', '已拒绝非主界面的桌面调用');
  }
}

function handle(
  channel: string,
  getWindow: () => BrowserWindow | null,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedSender(event, getWindow);
    return handler(event, ...args);
  });
}

async function chooseImportFile(window: BrowserWindow | null): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: '导入康奈尔笔记备份',
    properties: ['openFile'],
    filters: [{ name: '康奈尔笔记备份', extensions: ['json'] }],
  };
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : result.filePaths[0] ?? null;
}

async function chooseExportFile(window: BrowserWindow | null): Promise<string | null> {
  const date = new Date().toISOString().slice(0, 10);
  const options: Electron.SaveDialogOptions = {
    title: '导出康奈尔笔记备份',
    defaultPath: `康奈尔笔记备份-${date}.json`,
    filters: [{ name: '康奈尔笔记备份', extensions: ['json'] }],
  };
  const result = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options);
  return result.canceled ? null : result.filePath ?? null;
}

export function registerIpcHandlers(services: IpcServices): void {
  const { data, settings, ai, coach, getWindow } = services;

  handle(IPC_CHANNELS.notesLoad, getWindow, async () => {
    try {
      const database = await data.read();
      return { notes: database.notes, error: null };
    } catch (error) {
      return { notes: [], error: errorMessage(error, '读取笔记失败') };
    }
  });

  handle(IPC_CHANNELS.notesSave, getWindow, async (_event, notes) => {
    try {
      await data.saveNotes(notes);
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: errorMessage(error, '保存笔记失败') };
    }
  });

  handle(IPC_CHANNELS.notesImportBackup, getWindow, async () => {
    const current = await data.read();
    try {
      const filePath = await chooseImportFile(getWindow());
      if (!filePath) {
        return {
          ok: false,
          error: null,
          addedCount: 0,
          totalCount: current.notes.length,
          notes: current.notes,
        };
      }
      const metadata = await stat(filePath);
      if (!metadata.isFile() || metadata.size > MAX_IMPORT_BYTES) {
        throw new DesktopError('BACKUP_TOO_LARGE', '备份文件无效或超过 50 MB');
      }
      const result = await data.importBackupText(await readFile(filePath, 'utf8'));
      return { ok: true, error: null, ...result };
    } catch (error) {
      return {
        ok: false,
        error: errorMessage(error, '导入备份失败'),
        addedCount: 0,
        totalCount: current.notes.length,
        notes: current.notes,
      };
    }
  });

  handle(IPC_CHANNELS.notesExportBackup, getWindow, async () => {
    try {
      const filePath = await chooseExportFile(getWindow());
      if (!filePath) return { ok: false, error: null, filePath: null };
      const backup = await data.exportBackup();
      await writeFile(filePath, `${JSON.stringify(backup, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      return { ok: true, error: null, filePath };
    } catch (error) {
      return {
        ok: false,
        error: errorMessage(error, '导出备份失败'),
        filePath: null,
      };
    }
  });

  handle(IPC_CHANNELS.notesPrint, getWindow, async () => {
    const window = getWindow();
    if (!window || window.isDestroyed()) {
      return { ok: false, error: '主窗口不可用' };
    }
    return new Promise<{ ok: boolean; error: string | null }>((resolve) => {
      window.webContents.print(
        { silent: false, printBackground: true },
        (success, failureReason) => {
          resolve({
            ok: success,
            error: success ? null : failureReason || '打印未完成',
          });
        },
      );
    });
  });

  handle(IPC_CHANNELS.aiGetSettings, getWindow, () => settings.getSettings());
  handle(IPC_CHANNELS.aiSaveSettings, getWindow, (_event, candidate) =>
    settings.saveSettings(candidate),
  );
  handle(IPC_CHANNELS.aiSetCloudCredential, getWindow, (_event, secret) =>
    settings.setCloudCredential(secret),
  );
  handle(IPC_CHANNELS.aiDeleteCloudCredential, getWindow, () =>
    settings.deleteCloudCredential(),
  );
  handle(IPC_CHANNELS.aiTestConnection, getWindow, () => ai.testConnection());

  handle(IPC_CHANNELS.reviewGetOverview, getWindow, (_event, noteId) =>
    coach.getOverview(noteId),
  );
  handle(
    IPC_CHANNELS.reviewStartRecall,
    getWindow,
    (_event, noteId, questionCount, summaryUnavailable) =>
      coach.startRecall(noteId, questionCount, summaryUnavailable),
  );
  handle(IPC_CHANNELS.reviewStartDue, getWindow, (_event, cardId) =>
    coach.startDueReview(cardId),
  );
  handle(IPC_CHANNELS.reviewResume, getWindow, (_event, sessionId) =>
    coach.resume(sessionId),
  );
  handle(
    IPC_CHANNELS.reviewSubmitInitialAnswer,
    getWindow,
    (_event, sessionId, answer, confidence) =>
      coach.submitInitialAnswer(sessionId, answer, confidence),
  );
  handle(
    IPC_CHANNELS.reviewRevealHint,
    getWindow,
    (_event, sessionId, level) => coach.revealHint(sessionId, level),
  );
  handle(IPC_CHANNELS.reviewEvaluateAnswer, getWindow, (_event, sessionId) =>
    coach.evaluateAnswer(sessionId),
  );
  handle(IPC_CHANNELS.reviewNextQuestion, getWindow, (_event, sessionId) =>
    coach.nextQuestion(sessionId),
  );
  handle(IPC_CHANNELS.reviewPause, getWindow, (_event, sessionId) =>
    coach.pause(sessionId),
  );
  handle(IPC_CHANNELS.reviewAbandon, getWindow, async (_event, sessionId) => {
    try {
      await coach.abandon(sessionId);
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: errorMessage(error, '无法放弃复习') };
    }
  });
  handle(
    IPC_CHANNELS.reviewEvaluateFeynman,
    getWindow,
    (_event, noteId, conceptLabel, explanation, confidence, round) =>
      coach.evaluateFeynman(
        noteId,
        conceptLabel,
        explanation,
        confidence,
        round,
      ),
  );
}
