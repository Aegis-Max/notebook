import {
  BUILTIN_EXAMPLE_NOTE_ID,
  BUILTIN_EXAMPLE_SEED_STATE_KEY,
  createBuiltinExampleNote,
} from '../domain/builtin-example.js';
import {
  createBackup,
  loadNotes,
  mergeNotes,
  parseBackup,
  saveNotes,
  sortNotes,
  type Note,
} from '../domain/note-store.js';
import type {
  DesktopApi,
  ImportResult,
  LoadNotesResult,
  SaveResult,
} from '../types/desktop.js';

export interface RendererImportResult extends ImportResult {}

export interface RendererNotesApi {
  load(): Promise<LoadNotesResult>;
  save(notes: Note[]): Promise<SaveResult>;
  importBackup(currentNotes: Note[], file?: File): Promise<RendererImportResult>;
  exportBackup(notes: Note[]): Promise<{ ok: boolean; error: string | null; filePath: string | null }>;
  print(): Promise<SaveResult>;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function desktopApi(): DesktopApi | null {
  return window.cornellDesktop ?? null;
}

function today(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

async function browserLoad(): Promise<LoadNotesResult> {
  const result = loadNotes();
  return {
    notes: result.notes,
    error: result.error?.message ?? null,
    isFirstRun: result.isFirstRun,
    didSeedBuiltinExample: false,
  };
}

type SaveNotes = (notes: Note[]) => Promise<SaveResult>;

function migrationStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * 把内置示例按版本投放一次。pending 状态让“标记成功、笔记保存失败”可在
 * 下次启动继续；complete 与笔记本身分离，确保用户删除示例后不会复活。
 */
async function seedBuiltinExampleOnce(
  result: LoadNotesResult,
  save: SaveNotes,
): Promise<LoadNotesResult> {
  if (result.error) return { ...result, didSeedBuiltinExample: false };

  const storage = migrationStorage();
  if (!storage) return { ...result, didSeedBuiltinExample: false };

  try {
    if (storage.getItem(BUILTIN_EXAMPLE_SEED_STATE_KEY) === 'complete') {
      return { ...result, didSeedBuiltinExample: false };
    }
    storage.setItem(BUILTIN_EXAMPLE_SEED_STATE_KEY, 'pending');
  } catch {
    return { ...result, didSeedBuiltinExample: false };
  }

  if (result.notes.some((note) => note.id === BUILTIN_EXAMPLE_NOTE_ID)) {
    try {
      storage.setItem(BUILTIN_EXAMPLE_SEED_STATE_KEY, 'complete');
    } catch {
      // 保留 pending，下次启动只会重试标记，不会复制同 ID 示例。
    }
    return { ...result, didSeedBuiltinExample: false };
  }

  const notes = sortNotes([...result.notes, createBuiltinExampleNote()]);
  let saved: SaveResult;
  try {
    saved = await save(notes);
  } catch {
    return { ...result, didSeedBuiltinExample: false };
  }
  if (!saved.ok) return { ...result, didSeedBuiltinExample: false };

  try {
    storage.setItem(BUILTIN_EXAMPLE_SEED_STATE_KEY, 'complete');
  } catch {
    // 笔记已经安全保存；保留 pending 以便下次启动补齐幂等标记。
  }
  return { ...result, notes, didSeedBuiltinExample: true };
}

async function browserSave(notes: Note[]): Promise<SaveResult> {
  const result = saveNotes(notes);
  return {
    ok: result.ok,
    error: result.error?.message ?? null,
  };
}

async function browserImport(currentNotes: Note[], file?: File): Promise<RendererImportResult> {
  if (!file) {
    return {
      ok: false,
      error: '请选择要导入的康奈尔笔记 JSON 文件。',
      addedCount: 0,
      totalCount: currentNotes.length,
      notes: currentNotes,
    };
  }

  try {
    const importedNotes = parseBackup(await file.text());
    const existingIds = new Set(currentNotes.map((note) => note.id));
    const merged = mergeNotes(currentNotes, importedNotes);
    const addedCount = merged.filter((note) => !existingIds.has(note.id)).length;
    const saved = saveNotes(merged);

    if (!saved.ok) {
      return {
        ok: false,
        error: '导入内容无法写入本地存储，原有笔记未改变。',
        addedCount: 0,
        totalCount: currentNotes.length,
        notes: currentNotes,
      };
    }

    const notes = sortNotes(merged);
    return {
      ok: true,
      error: null,
      addedCount,
      totalCount: notes.length,
      notes,
    };
  } catch (error) {
    return {
      ok: false,
      error: errorMessage(error, '备份文件无效，未修改现有笔记。'),
      addedCount: 0,
      totalCount: currentNotes.length,
      notes: currentNotes,
    };
  }
}

async function browserExport(notes: Note[]) {
  try {
    const backup = createBackup(notes);
    const blob = new Blob([JSON.stringify(backup, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = `cornell-notes-${today()}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 0);
    return { ok: true, error: null, filePath: anchor.download };
  } catch (error) {
    return {
      ok: false,
      error: errorMessage(error, '导出失败，请检查笔记数据。'),
      filePath: null,
    };
  }
}

export const rendererNotesApi: RendererNotesApi = {
  async load() {
    const api = desktopApi();
    const result = api ? await api.notes.load() : await browserLoad();
    return seedBuiltinExampleOnce(
      result,
      (notes) => api ? api.notes.save(notes) : browserSave(notes),
    );
  },

  async save(notes) {
    const api = desktopApi();
    return api ? api.notes.save(notes) : browserSave(notes);
  },

  async importBackup(currentNotes, file) {
    const api = desktopApi();
    return api ? api.notes.importBackup() : browserImport(currentNotes, file);
  },

  async exportBackup(notes) {
    const api = desktopApi();
    return api ? api.notes.exportBackup() : browserExport(notes);
  },

  async print() {
    const api = desktopApi();
    if (api) return api.notes.print();
    window.print();
    return { ok: true, error: null };
  },
};

export function getDesktopApi(): DesktopApi | null {
  return desktopApi();
}

export function isDesktopRuntime(): boolean {
  return desktopApi()?.isDesktop === true;
}
