export const STORAGE_KEY = 'cornell-notes:v1';
export const SCHEMA_VERSION = 1;

export interface Note {
  id: string;
  title: string;
  date: string;
  cues: string;
  notes: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
}

export interface StorageLike {
  getItem?(key: string): string | null | undefined;
  setItem?(key: string, value: string): void;
}

export interface CreateNoteOptions {
  now?: Date | string;
  idFactory?: () => string;
}

export type NoteStoreErrorCode =
  | 'INVALID_NOTE'
  | 'INVALID_NOTE_COLLECTION'
  | 'INVALID_STORED_DATA'
  | 'UNSUPPORTED_SCHEMA'
  | 'STORAGE_UNAVAILABLE'
  | 'STORAGE_READ_FAILED'
  | 'STORAGE_WRITE_FAILED'
  | 'INVALID_BACKUP';

export interface LoadNotesResult {
  notes: Note[];
  error: NoteStoreError | null;
}

export interface SaveNotesResult {
  ok: boolean;
  error: NoteStoreError | null;
}

export interface NoteValidationResult {
  valid: boolean;
  errors: string[];
  note: Note | null;
}

export interface NotesBackup {
  schemaVersion: typeof SCHEMA_VERSION;
  exportedAt: string;
  notes: Note[];
}

export interface BackupValidationResult {
  valid: boolean;
  errors: string[];
  exportedAt: string | null;
  notes: Note[];
}

const NOTE_FIELDS = [
  'id',
  'title',
  'date',
  'cues',
  'notes',
  'summary',
  'createdAt',
  'updatedAt',
] as const satisfies readonly (keyof Note)[];

const SEARCHABLE_FIELDS = [
  'title',
  'date',
  'cues',
  'notes',
  'summary',
] as const satisfies readonly (keyof Note)[];

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

let fallbackIdCounter = 0;

export class NoteStoreError extends Error {
  readonly code: NoteStoreErrorCode;
  override readonly cause?: unknown;

  constructor(code: NoteStoreErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'NoteStoreError';
    this.code = code;

    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new NoteStoreError('INVALID_NOTE', `字段 ${field} 必须是字符串`);
  }

  return value;
}

function normalizeMultilineText(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function isCalendarDate(value: string): boolean {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (year < 1 || month < 1 || month > 12 || day < 1) return false;

  const daysInMonth = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  return day <= daysInMonth[month - 1];
}

function normalizeTimestamp(value: unknown, field: string): string {
  const timestamp = requireString(value, field).trim();
  if (!ISO_TIMESTAMP_PATTERN.test(timestamp)) {
    throw new NoteStoreError('INVALID_NOTE', `字段 ${field} 必须是 ISO 8601 时间`);
  }

  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    throw new NoteStoreError('INVALID_NOTE', `字段 ${field} 不是有效时间`);
  }

  return parsed.toISOString();
}

function normalizeExternalTimestamp(
  value: unknown,
  field: string,
  code: NoteStoreErrorCode,
): string {
  try {
    const raw = value instanceof Date ? value.toISOString() : value;
    return normalizeTimestamp(raw, field);
  } catch (error) {
    throw new NoteStoreError(code, `${field} 必须是有效的 ISO 8601 时间`, error);
  }
}

function toLocalDateString(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function createId(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch {
    // 某些隐私模式会在访问 crypto 时抛错，继续使用本地兜底 ID。
  }

  fallbackIdCounter += 1;
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `note-${Date.now().toString(36)}-${fallbackIdCounter.toString(36)}-${randomPart}`;
}

function normalizeNotesCollection(
  notes: unknown,
  code: NoteStoreErrorCode = 'INVALID_NOTE_COLLECTION',
): Note[] {
  if (!Array.isArray(notes)) {
    throw new NoteStoreError(code, '笔记集合必须是数组');
  }

  const ids = new Set<string>();
  return notes.map((candidate, index) => {
    let note: Note;
    try {
      note = normalizeNote(candidate);
    } catch (error) {
      throw new NoteStoreError(
        code,
        `第 ${index + 1} 条笔记无效：${errorMessage(error)}`,
        error,
      );
    }

    if (ids.has(note.id)) {
      throw new NoteStoreError(code, `笔记集合包含重复 ID：${note.id}`);
    }

    ids.add(note.id);
    return note;
  });
}

function sortNormalizedNotes(notes: readonly Note[]): Note[] {
  return notes
    .map((note, index) => ({ note, index }))
    .sort((left, right) => {
      const updatedDifference =
        Date.parse(right.note.updatedAt) - Date.parse(left.note.updatedAt);
      if (updatedDifference !== 0) return updatedDifference;

      const createdDifference =
        Date.parse(right.note.createdAt) - Date.parse(left.note.createdAt);
      if (createdDifference !== 0) return createdDifference;

      return left.index - right.index;
    })
    .map(({ note }) => note);
}

function resolveStorage(storage?: unknown): unknown {
  if (storage !== undefined) return storage;

  try {
    const defaultStorage = (
      globalThis as typeof globalThis & { localStorage?: StorageLike }
    ).localStorage;
    if (defaultStorage === undefined) {
      throw new Error('当前环境没有 localStorage');
    }
    return defaultStorage;
  } catch (error) {
    throw new NoteStoreError('STORAGE_UNAVAILABLE', '本地存储不可用', error);
  }
}

type StorageMethod = keyof StorageLike;

function requireStorageMethod<M extends StorageMethod>(
  storage: unknown,
  method: M,
): asserts storage is StorageLike & Required<Pick<StorageLike, M>> {
  if (!isRecord(storage) || typeof storage[method] !== 'function') {
    throw new NoteStoreError('STORAGE_UNAVAILABLE', `存储对象缺少 ${method} 方法`);
  }
}

function parseStoredPayload(payload: unknown): Note[] {
  if (!isRecord(payload)) {
    throw new NoteStoreError('INVALID_STORED_DATA', '本地笔记数据必须是对象');
  }

  if (payload.schemaVersion !== SCHEMA_VERSION) {
    throw new NoteStoreError(
      'UNSUPPORTED_SCHEMA',
      `不支持的数据版本：${String(payload.schemaVersion)}`,
    );
  }

  return normalizeNotesCollection(payload.notes, 'INVALID_STORED_DATA');
}

/** 创建一条可直接持久化的 Cornell 笔记。 */
export function createNote(initial?: Partial<Note>, options?: CreateNoteOptions): Note;
export function createNote(initial: unknown = {}, options: unknown = {}): Note {
  if (!isRecord(initial)) {
    throw new NoteStoreError('INVALID_NOTE', '新笔记初始值必须是对象');
  }
  if (!isRecord(options)) {
    throw new NoteStoreError('INVALID_NOTE', '新笔记选项必须是对象');
  }

  const nowDate = options.now === undefined ? new Date() : new Date(options.now as string);
  if (Number.isNaN(nowDate.getTime())) {
    throw new NoteStoreError('INVALID_NOTE', 'now 必须是有效时间');
  }

  const now = nowDate.toISOString();
  const generatedId =
    initial.id ??
    (typeof options.idFactory === 'function'
      ? (options.idFactory as () => unknown)()
      : createId());

  return normalizeNote({
    id: generatedId,
    title: initial.title ?? '',
    date: initial.date ?? toLocalDateString(nowDate),
    cues: initial.cues ?? '',
    notes: initial.notes ?? '',
    summary: initial.summary ?? '',
    createdAt: initial.createdAt ?? now,
    updatedAt: initial.updatedAt ?? now,
  });
}

/** 将一条笔记规范化为稳定的可序列化结构。 */
export function normalizeNote(candidate: unknown): Note {
  if (!isRecord(candidate)) {
    throw new NoteStoreError('INVALID_NOTE', '笔记必须是对象');
  }

  for (const field of NOTE_FIELDS) {
    requireString(candidate[field], field);
  }

  const note: Note = {
    id: (candidate.id as string).trim(),
    title: (candidate.title as string).trim(),
    date: (candidate.date as string).trim(),
    cues: normalizeMultilineText(candidate.cues as string),
    notes: normalizeMultilineText(candidate.notes as string),
    summary: normalizeMultilineText(candidate.summary as string),
    createdAt: normalizeTimestamp(candidate.createdAt, 'createdAt'),
    updatedAt: normalizeTimestamp(candidate.updatedAt, 'updatedAt'),
  };

  if (note.id.length === 0) {
    throw new NoteStoreError('INVALID_NOTE', '字段 id 不能为空');
  }
  if (!isCalendarDate(note.date)) {
    throw new NoteStoreError('INVALID_NOTE', '字段 date 必须是有效的 YYYY-MM-DD 日期');
  }
  if (Date.parse(note.updatedAt) < Date.parse(note.createdAt)) {
    throw new NoteStoreError('INVALID_NOTE', 'updatedAt 不能早于 createdAt');
  }

  return note;
}

/** 无异常验证接口，成功时同时返回规范化后的 note。 */
export function validateNote(candidate: unknown): NoteValidationResult {
  try {
    return { valid: true, errors: [], note: normalizeNote(candidate) };
  } catch (error) {
    return {
      valid: false,
      errors: [errorMessage(error)],
      note: null,
    };
  }
}

/** 返回按最近更新时间降序排列的新数组，不修改输入。 */
export function sortNotes(notes: readonly unknown[]): Note[] {
  return sortNormalizedNotes(normalizeNotesCollection(notes));
}

/** 对所有用户可见文本做不区分大小写的多关键词搜索。 */
export function searchNotes(notes: readonly unknown[], query: unknown = ''): Note[] {
  const normalizedNotes = normalizeNotesCollection(notes);
  const terms = String(query ?? '')
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  const matches =
    terms.length === 0
      ? normalizedNotes
      : normalizedNotes.filter((note) => {
          const haystack = SEARCHABLE_FIELDS.map((field) => note[field])
            .join('\n')
            .toLocaleLowerCase();
          return terms.every((term) => haystack.includes(term));
        });

  return sortNormalizedNotes(matches);
}

/** 从 Storage 读取数据；任何错误均通过结果对象返回。 */
export function loadNotes(storage?: StorageLike | unknown): LoadNotesResult {
  let resolvedStorage: unknown;
  try {
    resolvedStorage = resolveStorage(storage);
    requireStorageMethod(resolvedStorage, 'getItem');
  } catch (error) {
    return {
      notes: [],
      error:
        error instanceof NoteStoreError
          ? error
          : new NoteStoreError('STORAGE_UNAVAILABLE', '本地存储不可用', error),
    };
  }

  let serialized: string | null | undefined;
  try {
    serialized = resolvedStorage.getItem(STORAGE_KEY);
  } catch (error) {
    return {
      notes: [],
      error: new NoteStoreError('STORAGE_READ_FAILED', '读取本地笔记失败', error),
    };
  }

  if (serialized === null || serialized === undefined) {
    return { notes: [], error: null };
  }

  try {
    const payload: unknown = JSON.parse(serialized);
    return { notes: sortNormalizedNotes(parseStoredPayload(payload)), error: null };
  } catch (error) {
    return {
      notes: [],
      error:
        error instanceof NoteStoreError
          ? error
          : new NoteStoreError('INVALID_STORED_DATA', '本地笔记数据已损坏', error),
    };
  }
}

/** 保存完整笔记集合，支持 saveNotes(notes) 与 saveNotes(storage, notes)。 */
export function saveNotes(notes: readonly unknown[]): SaveNotesResult;
export function saveNotes(
  storage: StorageLike | undefined,
  notes: readonly unknown[],
): SaveNotesResult;
export function saveNotes(
  storageOrNotes: StorageLike | readonly unknown[] | unknown,
  maybeNotes?: readonly unknown[] | unknown,
): SaveNotesResult {
  let resolvedStorageInput: unknown = storageOrNotes;
  let notesInput: unknown = maybeNotes;
  if (Array.isArray(storageOrNotes)) {
    notesInput = storageOrNotes;
    resolvedStorageInput = maybeNotes;
  }

  let normalizedNotes: Note[];
  try {
    normalizedNotes = sortNormalizedNotes(normalizeNotesCollection(notesInput));
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof NoteStoreError
          ? error
          : new NoteStoreError('INVALID_NOTE_COLLECTION', '笔记数据无效', error),
    };
  }

  let resolvedStorage: unknown;
  try {
    resolvedStorage = resolveStorage(resolvedStorageInput);
    requireStorageMethod(resolvedStorage, 'setItem');
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof NoteStoreError
          ? error
          : new NoteStoreError('STORAGE_UNAVAILABLE', '本地存储不可用', error),
    };
  }

  const serialized = JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    notes: normalizedNotes,
  });

  try {
    resolvedStorage.setItem(STORAGE_KEY, serialized);
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error: new NoteStoreError('STORAGE_WRITE_FAILED', '保存本地笔记失败', error),
    };
  }
}

/** 创建可直接交给 JSON.stringify 的备份对象。 */
export function createBackup(
  notes: readonly unknown[],
  exportedAt: Date | string = new Date(),
): NotesBackup {
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: normalizeExternalTimestamp(exportedAt, 'exportedAt', 'INVALID_BACKUP'),
    notes: sortNormalizedNotes(normalizeNotesCollection(notes, 'INVALID_BACKUP')),
  };
}

/** 验证已解析的备份对象。 */
export function validateBackup(candidate: unknown): BackupValidationResult {
  try {
    if (!isRecord(candidate)) {
      throw new NoteStoreError('INVALID_BACKUP', '备份内容必须是对象');
    }
    if (candidate.schemaVersion !== SCHEMA_VERSION) {
      throw new NoteStoreError(
        'UNSUPPORTED_SCHEMA',
        `不支持的备份版本：${String(candidate.schemaVersion)}`,
      );
    }

    const exportedAt = normalizeExternalTimestamp(
      candidate.exportedAt,
      'exportedAt',
      'INVALID_BACKUP',
    );
    const notes = sortNormalizedNotes(
      normalizeNotesCollection(candidate.notes, 'INVALID_BACKUP'),
    );

    return { valid: true, errors: [], exportedAt, notes };
  } catch (error) {
    return {
      valid: false,
      errors: [errorMessage(error)],
      exportedAt: null,
      notes: [],
    };
  }
}

/** 解析并验证 JSON 备份。 */
export function parseBackup(jsonText: unknown): Note[] {
  if (typeof jsonText !== 'string') {
    throw new NoteStoreError('INVALID_BACKUP', '备份必须是 JSON 字符串');
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(jsonText.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new NoteStoreError('INVALID_BACKUP', '备份不是有效的 JSON', error);
  }

  const result = validateBackup(candidate);
  if (!result.valid) {
    throw new NoteStoreError('INVALID_BACKUP', result.errors.join('；'));
  }

  return result.notes;
}

/** 合并本地与导入笔记；时间相同时保留本地版本。 */
export function mergeNotes(
  localNotes: readonly unknown[],
  importedNotes: readonly unknown[],
): Note[] {
  const local = normalizeNotesCollection(localNotes);
  const imported = normalizeNotesCollection(importedNotes);
  const merged = new Map(local.map((note) => [note.id, note]));

  for (const importedNote of imported) {
    const localNote = merged.get(importedNote.id);
    if (
      localNote === undefined ||
      Date.parse(importedNote.updatedAt) > Date.parse(localNote.updatedAt)
    ) {
      merged.set(importedNote.id, importedNote);
    }
  }

  return sortNormalizedNotes([...merged.values()]);
}
