import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { mergeNotes, parseBackup, sortNotes, type Note } from '../src/domain/note-store.js';
import type { ReviewAttempt, ReviewCard } from '../src/domain/review.js';
import { AtomicJsonStore } from './atomic-json-store.js';
import {
  DESKTOP_DATA_SCHEMA_VERSION,
  emptyDesktopDatabase,
  parseDesktopBackup,
  parseDesktopDatabase,
  type DesktopBackup,
  type DesktopDatabase,
  type StoredReviewSession,
} from './data-model.js';
import { DesktopError, isNodeError } from './errors.js';

export class DesktopDataService {
  private readonly store: AtomicJsonStore<DesktopDatabase>;
  private readonly dataFilePath: string;

  constructor(userDataPath: string) {
    this.dataFilePath = join(userDataPath, 'cornell-data.json');
    this.store = new AtomicJsonStore(
      this.dataFilePath,
      emptyDesktopDatabase,
      parseDesktopDatabase,
    );
  }

  async read(): Promise<DesktopDatabase> {
    return this.store.read();
  }

  async loadNotes(): Promise<{ notes: Note[]; isFirstRun: boolean }> {
    let isFirstRun = false;
    try {
      await stat(this.dataFilePath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw new DesktopError('DATA_READ_FAILED', '无法检查桌面版数据', {
          cause: error,
        });
      }
      isFirstRun = true;
    }

    const database = await this.store.read();
    return { notes: database.notes, isFirstRun };
  }

  async update(
    mutator: (draft: DesktopDatabase) => void | DesktopDatabase,
  ): Promise<DesktopDatabase> {
    return this.store.update(mutator);
  }

  async saveNotes(candidate: unknown): Promise<Note[]> {
    if (!Array.isArray(candidate)) {
      throw new DesktopError('INVALID_NOTES', '笔记集合必须是数组');
    }
    const notes = sortNotes(candidate);
    const noteById = new Map(notes.map((note) => [note.id, note]));
    const result = await this.store.update((draft) => {
      draft.notes = notes;

      // 已完成结果继续保留为历史；卡片标出旧版本。尚未完成的旧快照不能继续作答，
      // 删除后下次进入会从新版本重新生成。
      draft.review.sessions = draft.review.sessions.filter((session) => {
        const current = noteById.get(session.noteId);
        return (
          current !== undefined &&
          (session.status === 'complete' || current.updatedAt === session.noteRevision)
        );
      });
      draft.review.cards = draft.review.cards
        .filter((card) => noteById.has(card.noteId))
        .map((card) => ({
          ...card,
          stale: noteById.get(card.noteId)?.updatedAt !== card.noteRevision,
        }));
      draft.review.attempts = draft.review.attempts.filter((attempt) =>
        noteById.has(attempt.noteId),
      );
    });
    return result.notes;
  }

  async exportBackup(now: Date = new Date()): Promise<DesktopBackup> {
    const data = await this.store.read();
    return {
      schemaVersion: DESKTOP_DATA_SCHEMA_VERSION,
      exportedAt: now.toISOString(),
      notes: data.notes,
      review: data.review,
    };
  }

  async importBackupText(text: string): Promise<{
    notes: Note[];
    addedCount: number;
    totalCount: number;
  }> {
    if (Buffer.byteLength(text, 'utf8') > 50 * 1024 * 1024) {
      throw new DesktopError('BACKUP_TOO_LARGE', '备份文件过大，已拒绝导入');
    }

    let candidate: unknown;
    try {
      candidate = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (error) {
      throw new DesktopError('INVALID_BACKUP', '备份不是有效的 JSON', {
        cause: error,
      });
    }

    if (candidate === null || typeof candidate !== 'object') {
      throw new DesktopError('INVALID_BACKUP', '备份内容格式无效');
    }

    const version = (candidate as { schemaVersion?: unknown }).schemaVersion;
    let importedNotes: Note[];
    let importedReview:
      | {
          sessions: StoredReviewSession[];
          cards: ReviewCard[];
          attempts: ReviewAttempt[];
        }
      | undefined;

    try {
      if (version === 1) {
        importedNotes = parseBackup(text);
      } else if (version === DESKTOP_DATA_SCHEMA_VERSION) {
        const backup = parseDesktopBackup(candidate);
        importedNotes = backup.notes;
        importedReview = backup.review;
      } else {
        throw new DesktopError('UNSUPPORTED_BACKUP', `不支持的备份版本：${String(version)}`);
      }
    } catch (error) {
      if (error instanceof DesktopError) throw error;
      throw new DesktopError('INVALID_BACKUP', '备份内容未通过完整性校验', {
        cause: error,
      });
    }

    const localBefore = await this.store.read();
    const existingIds = new Set(localBefore.notes.map((note) => note.id));
    const addedCount = importedNotes.filter((note) => !existingIds.has(note.id)).length;

    const merged = await this.store.update((draft) => {
      draft.notes = mergeNotes(draft.notes, importedNotes);
      if (importedReview) {
        draft.review.sessions = mergeByTimestamp(
          draft.review.sessions,
          importedReview.sessions,
          (item) => item.sessionId,
          (item) => item.updatedAt,
        );
        draft.review.cards = mergeByTimestamp(
          draft.review.cards,
          importedReview.cards,
          (item) => item.cardId,
          (item) => item.updatedAt,
        );
        draft.review.attempts = mergeImmutable(
          draft.review.attempts,
          importedReview.attempts,
          (item) => item.attemptId,
        );
      }

      const noteById = new Map(draft.notes.map((note) => [note.id, note]));
      draft.review.sessions = draft.review.sessions.filter((session) => {
        const current = noteById.get(session.noteId);
        return (
          current !== undefined &&
          (session.status === 'complete' || current.updatedAt === session.noteRevision)
        );
      });
      draft.review.cards = draft.review.cards
        .filter((card) => noteById.has(card.noteId))
        .map((card) => ({
          ...card,
          stale: noteById.get(card.noteId)?.updatedAt !== card.noteRevision,
        }));
      draft.review.attempts = draft.review.attempts.filter((attempt) =>
        noteById.has(attempt.noteId),
      );
    });

    return {
      notes: merged.notes,
      addedCount,
      totalCount: merged.notes.length,
    };
  }
}

function mergeByTimestamp<T>(
  local: readonly T[],
  imported: readonly T[],
  idFor: (item: T) => string,
  timestampFor: (item: T) => string,
): T[] {
  const merged = new Map(local.map((item) => [idFor(item), item]));
  for (const item of imported) {
    const existing = merged.get(idFor(item));
    if (!existing || Date.parse(timestampFor(item)) > Date.parse(timestampFor(existing))) {
      merged.set(idFor(item), item);
    }
  }
  return [...merged.values()];
}

function mergeImmutable<T>(
  local: readonly T[],
  imported: readonly T[],
  idFor: (item: T) => string,
): T[] {
  const merged = new Map(local.map((item) => [idFor(item), item]));
  for (const item of imported) {
    if (!merged.has(idFor(item))) merged.set(idFor(item), item);
  }
  return [...merged.values()];
}
