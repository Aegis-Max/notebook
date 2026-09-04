import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { app, BrowserWindow, session } from 'electron';

import { AiClient } from './ai-client.js';
import { DesktopDataService } from './data-service.js';
import { registerIpcHandlers } from './ipc.js';
import { SecureSettingsService } from './secure-settings.js';
import { StudyCoachService } from './study-coach.js';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const preloadPath = join(moduleDirectory, 'preload.cjs');
const developmentUrl = process.env.VITE_DEV_SERVER_URL;
let mainWindow: BrowserWindow | null = null;
let allowedDocumentUrl = '';

const isolatedUserData = process.env.CORNELL_TEST_USER_DATA;
if (isolatedUserData) {
  app.setPath(
    'userData',
    isAbsolute(isolatedUserData) ? isolatedUserData : resolve(isolatedUserData),
  );
}

function validatedDevelopmentUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('VITE_DEV_SERVER_URL 必须是有效 URL');
  }
  if (
    url.protocol !== 'http:' ||
    (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('开发服务器只允许使用无凭据的本机 HTTP URL');
  }
  return url.toString();
}

function sameDocumentTarget(candidate: string): boolean {
  try {
    const expected = new URL(allowedDocumentUrl);
    const actual = new URL(candidate);
    return (
      actual.protocol === expected.protocol &&
      actual.host === expected.host &&
      actual.pathname === expected.pathname &&
      actual.search === expected.search
    );
  } catch {
    return false;
  }
}

function lockDownSession(): void {
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setDevicePermissionHandler(() => false);
}

async function createMainWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: '#edf3ef',
    title: '康奈尔笔记',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      devTools: !app.isPackaged,
    },
  });
  // 在首个 renderer 脚本可能调用 IPC 前就登记可信窗口。
  mainWindow = window;

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('will-navigate', (event, url) => {
    if (!sameDocumentTarget(url)) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (!sameDocumentTarget(url)) event.preventDefault();
  });
  window.webContents.on('render-process-gone', () => {
    // 不输出笔记正文、URL 参数或任何密钥；窗口可由用户重新打开应用恢复。
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  try {
    if (developmentUrl) {
      allowedDocumentUrl = validatedDevelopmentUrl(developmentUrl);
      await window.loadURL(allowedDocumentUrl);
    } else {
      const rendererPath = join(app.getAppPath(), 'dist', 'index.html');
      allowedDocumentUrl = pathToFileURL(rendererPath).toString();
      await window.loadFile(rendererPath);
    }
  } catch (error) {
    if (mainWindow === window) mainWindow = null;
    window.destroy();
    throw error;
  }
  return window;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    lockDownSession();
    const data = new DesktopDataService(app.getPath('userData'));
    const settings = new SecureSettingsService(app.getPath('userData'));
    const ai = new AiClient(settings);
    const coach = new StudyCoachService(data, settings, ai);
    registerIpcHandlers({ data, settings, ai, coach, getWindow: () => mainWindow });

    mainWindow = await createMainWindow();
    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = await createMainWindow();
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
