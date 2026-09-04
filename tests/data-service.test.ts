import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { DesktopDataService } from '../electron/data-service.js';
import { createBackup } from '../src/domain/note-store.js';
import { makeDesktopNote, makeStoredSession } from './backend-fixtures.js';

const temporaryDirectories: string[] = [];

async function createService(): Promise<DesktopDataService> {
  const directory = await mkdtemp(join(tmpdir(), 'cornell-data-service-test-'));
  temporaryDirectories.push(directory);
  return new DesktopDataService(directory);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('旧版网页备份兼容', () => {
  test('可导入 schemaVersion 1 备份并与桌面数据合并', async () => {
    const service = await createService();
    const local = makeDesktopNote({ id: 'local-note', title: '本地笔记' });
    const imported = makeDesktopNote({
      id: 'imported-note',
      title: '网页版笔记',
      updatedAt: '2026-09-04T04:00:00.000Z',
    });
    await service.saveNotes([local]);

    const result = await service.importBackupText(
      JSON.stringify(createBackup([imported], '2026-09-04T05:00:00.000Z')),
    );

    expect(result).toMatchObject({ addedCount: 1, totalCount: 2 });
    expect(result.notes.map((note) => note.id)).toEqual(['imported-note', 'local-note']);
    expect((await service.read()).review).toEqual({ sessions: [], cards: [], attempts: [] });
  });

  test('同 ID 笔记按 updatedAt 合并，时间相同保留本地版本', async () => {
    const service = await createService();
    const local = makeDesktopNote({ id: 'same', title: '本地新版' });
    await service.saveNotes([local]);

    const older = makeDesktopNote({
      id: 'same',
      title: '导入旧版',
      updatedAt: '2026-09-04T01:30:00.000Z',
    });
    const equalTime = makeDesktopNote({ id: 'same', title: '导入同时版' });

    expect(
      (
        await service.importBackupText(
          JSON.stringify(createBackup([older], '2026-09-04T05:00:00.000Z')),
        )
      ).notes[0].title,
    ).toBe('本地新版');
    expect(
      (
        await service.importBackupText(
          JSON.stringify(createBackup([equalTime], '2026-09-04T05:00:00.000Z')),
        )
      ).notes[0].title,
    ).toBe('本地新版');
  });

  test('旧版备份损坏时不改写已有桌面数据', async () => {
    const service = await createService();
    const local = makeDesktopNote({ id: 'keep-me' });
    await service.saveNotes([local]);

    const damaged = {
      schemaVersion: 1,
      exportedAt: '2026-09-04T05:00:00.000Z',
      notes: [{ ...local, id: '' }],
    };
    await expect(service.importBackupText(JSON.stringify(damaged))).rejects.toMatchObject({
      code: 'INVALID_BACKUP',
    });

    expect((await service.read()).notes).toEqual([local]);
  });
});

describe('笔记生命周期与复习隐私', () => {
  test('更新时保留已完成历史并标记旧卡，删除时级联移除全部正文快照', async () => {
    const service = await createService();
    const note = makeDesktopNote();
    await service.saveNotes([note]);
    await service.update((draft) => {
      draft.review.sessions = [
        makeStoredSession({ sessionId: 'complete', status: 'complete' }),
        makeStoredSession({ sessionId: 'unfinished', status: 'answering' }),
      ];
      draft.review.cards = [
        {
          cardId: 'card-a',
          noteId: note.id,
          noteRevision: note.updatedAt,
          conceptKey: 'tcp-handshake',
          conceptLabel: 'TCP 三次握手',
          dueDate: '2026-09-05',
          stage: 0,
          lastVerdict: 'incorrect',
          highConfidenceMiss: false,
          stale: false,
          createdAt: '2026-09-04T03:00:00.000Z',
          updatedAt: '2026-09-04T03:00:00.000Z',
          lastReviewedAt: '2026-09-04T03:00:00.000Z',
        },
      ];
      draft.review.attempts = [
        {
          attemptId: 'attempt-a',
          sessionId: 'complete',
          cardId: 'card-a',
          noteId: note.id,
          noteRevision: note.updatedAt,
          questionId: 'question-a',
          kind: 'recall',
          sessionMode: 'recall',
          initialAnswer: '我的初答',
          verdict: 'incorrect',
          confidence: 'low',
          hintLevel: 0,
          viewedEvidence: false,
          attemptedAt: '2026-09-04T03:00:00.000Z',
        },
      ];
    });

    await service.saveNotes([
      { ...note, updatedAt: '2026-09-04T04:00:00.000Z' },
    ]);
    const updated = await service.read();
    expect(updated.review.sessions.map((session) => session.sessionId)).toEqual([
      'complete',
    ]);
    expect(updated.review.cards[0].stale).toBe(true);
    expect(updated.review.attempts).toHaveLength(1);

    await service.saveNotes([]);
    const removed = await service.read();
    expect(removed.notes).toEqual([]);
    expect(removed.review).toEqual({ sessions: [], cards: [], attempts: [] });
    expect(JSON.stringify(await service.exportBackup())).not.toContain('TCP');
  });
});
