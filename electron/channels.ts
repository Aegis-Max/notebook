/**
 * Renderer 可调用的完整 IPC 白名单。
 *
 * 这里刻意不提供通用 send/on 通道，避免未来界面代码绕过参数校验或订阅主进程事件。
 */
export const IPC_CHANNELS = {
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
