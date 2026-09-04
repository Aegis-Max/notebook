import type { Note } from '../src/domain/note-store.js';
import type { DesktopDatabase, StoredReviewSession } from '../electron/data-model.js';

export function makeDesktopNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'note-a',
    title: '网络课程',
    date: '2026-09-04',
    cues: 'TCP 为什么需要三次握手？',
    notes: 'TCP 通过三次握手建立连接。\n\n客户端先发送 SYN。',
    summary: '三次握手用于确认双方的收发能力。',
    createdAt: '2026-09-04T01:00:00.000Z',
    updatedAt: '2026-09-04T02:00:00.000Z',
    ...overrides,
  };
}

export function makeStoredSession(
  overrides: Partial<StoredReviewSession> = {},
): StoredReviewSession {
  const note = makeDesktopNote();
  const evidence = {
    blockId: 'notes:1',
    field: 'notes' as const,
    text: '三次握手建立连接',
  };

  return {
    sessionId: 'session-a',
    noteId: note.id,
    noteRevision: note.updatedAt,
    mode: 'recall',
    status: 'answering',
    noteSnapshot: {
      noteId: note.id,
      title: note.title,
      revision: note.updatedAt,
      cues: note.cues,
      notes: note.notes,
      summary: note.summary,
      capturedAt: '2026-09-04T03:00:00.000Z',
    },
    userSummary: '用自己的话总结',
    questions: [
      {
        questionId: 'question-a',
        cardId: 'card-a',
        conceptKey: 'tcp-handshake',
        conceptLabel: 'TCP 三次握手',
        prompt: '请说明 TCP 如何建立连接。',
        kind: 'recall',
        hints: ['先回忆发起方的动作', '关注 SYN 报文'],
        evidence: [{ ...evidence }],
        assessmentPoints: [
          {
            message: '应说明三次握手会建立连接',
            evidence: [{ ...evidence }],
          },
        ],
        initialAnswer: null,
        confidence: null,
        hintLevel: 0,
        viewedEvidence: false,
        verdict: null,
        feedback: null,
        createdAt: '2026-09-04T03:00:00.000Z',
        answeredAt: null,
        evaluatedAt: null,
      },
    ],
    currentQuestionIndex: 0,
    createdAt: '2026-09-04T03:00:00.000Z',
    updatedAt: '2026-09-04T03:00:00.000Z',
    ...overrides,
  };
}

export function makeDesktopDatabase(
  overrides: Partial<DesktopDatabase> = {},
): DesktopDatabase {
  return {
    schemaVersion: 2,
    notes: [makeDesktopNote()],
    review: {
      sessions: [makeStoredSession()],
      cards: [],
      attempts: [],
    },
    ...overrides,
  };
}
