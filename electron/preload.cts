import { contextBridge, ipcRenderer } from 'electron';

import type {
  AiDraftConfiguration,
  AiSettings,
  Confidence,
  DesktopApi,
} from '../src/types/desktop.js';
import type { Note } from '../src/domain/note-store.js';

// preload 编译为 CommonJS，常量内联可避免它在运行时 require 主进程的 ESM 模块。
const IPC_CHANNELS = {
  notesLoad: 'cornell:notes:load',
  notesSave: 'cornell:notes:save',
  notesImportBackup: 'cornell:notes:import-backup',
  notesExportBackup: 'cornell:notes:export-backup',
  notesPrint: 'cornell:notes:print',
  aiGetSettings: 'cornell:ai:get-settings',
  aiSaveSettings: 'cornell:ai:save-settings',
  aiSetCloudCredential: 'cornell:ai:set-cloud-credential',
  aiDeleteCloudCredential: 'cornell:ai:delete-cloud-credential',
  aiTestConnection: 'cornell:ai:test-connection',
  aiDiscoverModels: 'cornell:ai:discover-models',
  aiTestDraftConnection: 'cornell:ai:test-draft-connection',
  aiSaveConfiguration: 'cornell:ai:save-configuration',
  reviewGetOverview: 'cornell:review:get-overview',
  reviewStartRecall: 'cornell:review:start-recall',
  reviewStartDue: 'cornell:review:start-due',
  reviewResume: 'cornell:review:resume',
  reviewSubmitInitialAnswer: 'cornell:review:submit-initial-answer',
  reviewRevealHint: 'cornell:review:reveal-hint',
  reviewEvaluateAnswer: 'cornell:review:evaluate-answer',
  reviewNextQuestion: 'cornell:review:next-question',
  reviewPause: 'cornell:review:pause',
  reviewAbandon: 'cornell:review:abandon',
  reviewEvaluateFeynman: 'cornell:review:evaluate-feynman',
} as const;

const invoke = (channel: string, ...args: unknown[]) =>
  ipcRenderer.invoke(channel, ...args);

/**
 * 这是 renderer 能接触到的全部桌面能力。不要在这里暴露 ipcRenderer、事件订阅、
 * 文件路径或任何可由 renderer 任意指定的系统调用。
 */
const desktopApi: DesktopApi = Object.freeze({
  isDesktop: true,
  platform: process.platform,
  notes: Object.freeze({
    load: () => invoke(IPC_CHANNELS.notesLoad),
    save: (notes: Note[]) => invoke(IPC_CHANNELS.notesSave, notes),
    importBackup: () => invoke(IPC_CHANNELS.notesImportBackup),
    exportBackup: () => invoke(IPC_CHANNELS.notesExportBackup),
    print: () => invoke(IPC_CHANNELS.notesPrint),
  }),
  ai: Object.freeze({
    getSettings: () => invoke(IPC_CHANNELS.aiGetSettings),
    saveSettings: (settings: AiSettings) =>
      invoke(IPC_CHANNELS.aiSaveSettings, settings),
    setCloudCredential: (secret: string) =>
      invoke(IPC_CHANNELS.aiSetCloudCredential, secret),
    deleteCloudCredential: () => invoke(IPC_CHANNELS.aiDeleteCloudCredential),
    testConnection: () => invoke(IPC_CHANNELS.aiTestConnection),
    discoverModels: (draft: AiDraftConfiguration) =>
      invoke(IPC_CHANNELS.aiDiscoverModels, draft),
    testDraftConnection: (draft: AiDraftConfiguration) =>
      invoke(IPC_CHANNELS.aiTestDraftConnection, draft),
    saveConfiguration: (draft: AiDraftConfiguration) =>
      invoke(IPC_CHANNELS.aiSaveConfiguration, draft),
  }),
  review: Object.freeze({
    getOverview: (noteId?: string) =>
      invoke(IPC_CHANNELS.reviewGetOverview, noteId),
    startRecall: (
      noteId: string,
      questionCount?: number,
      summaryUnavailable?: boolean,
    ) =>
      invoke(
        IPC_CHANNELS.reviewStartRecall,
        noteId,
        questionCount,
        summaryUnavailable,
      ),
    startDueReview: (cardId: string) =>
      invoke(IPC_CHANNELS.reviewStartDue, cardId),
    resume: (sessionId: string) =>
      invoke(IPC_CHANNELS.reviewResume, sessionId),
    submitInitialAnswer: (
      sessionId: string,
      answer: string,
      confidence: Confidence,
    ) =>
      invoke(
        IPC_CHANNELS.reviewSubmitInitialAnswer,
        sessionId,
        answer,
        confidence,
      ),
    revealHint: (sessionId: string, level: 1 | 2 | 3) =>
      invoke(IPC_CHANNELS.reviewRevealHint, sessionId, level),
    evaluateAnswer: (sessionId: string) =>
      invoke(IPC_CHANNELS.reviewEvaluateAnswer, sessionId),
    nextQuestion: (sessionId: string) =>
      invoke(IPC_CHANNELS.reviewNextQuestion, sessionId),
    pause: (sessionId: string) =>
      invoke(IPC_CHANNELS.reviewPause, sessionId),
    abandon: (sessionId: string) =>
      invoke(IPC_CHANNELS.reviewAbandon, sessionId),
    evaluateFeynman: (
      noteId: string,
      conceptLabel: string,
      explanation: string,
      confidence: Confidence,
      round: number,
    ) =>
      invoke(
        IPC_CHANNELS.reviewEvaluateFeynman,
        noteId,
        conceptLabel,
        explanation,
        confidence,
        round,
      ),
  }),
});

contextBridge.exposeInMainWorld('cornellDesktop', desktopApi);
