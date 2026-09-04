import { describe, expect, test } from 'vitest';

import {
  assertEvidence,
  parseDesktopDatabase,
  snapshotBlocks,
} from '../electron/data-model.js';
import { makeDesktopDatabase, makeStoredSession } from './backend-fixtures.js';

describe('笔记引用完整性', () => {
  test('只接受能在指定快照块中逐字定位的内容', () => {
    const session = makeStoredSession();
    const blocks = snapshotBlocks(session.noteSnapshot);

    expect(
      assertEvidence(
        { blockId: 'notes:1', text: '通过三次握手' },
        blocks,
      ),
    ).toMatchObject({ blockId: 'notes:1', field: 'notes' });

    expect(() =>
      assertEvidence({ blockId: 'notes:1', text: '笔记中不存在的结论' }, blocks),
    ).toThrowError(expect.objectContaining({ code: 'AI_INVALID_EVIDENCE' }));
    expect(() =>
      assertEvidence({ blockId: 'notes:99', text: '三次握手' }, blocks),
    ).toThrowError(expect.objectContaining({ code: 'AI_INVALID_EVIDENCE' }));
    expect(() => assertEvidence({ blockId: 'notes:1', text: '' }, blocks)).toThrowError(
      expect.objectContaining({ code: 'AI_INVALID_EVIDENCE' }),
    );
  });

  test.each([
    ['题目引用', (database: ReturnType<typeof makeDesktopDatabase>) => {
      database.review.sessions[0].questions[0].evidence[0].text = '模型编造的内容';
    }],
    ['评估要点引用', (database: ReturnType<typeof makeDesktopDatabase>) => {
      database.review.sessions[0].questions[0].assessmentPoints[0].evidence[0].text =
        '模型编造的内容';
    }],
    ['评价反馈引用', (database: ReturnType<typeof makeDesktopDatabase>) => {
      const question = database.review.sessions[0].questions[0];
      question.initialAnswer = '我的回答';
      question.confidence = 'medium';
      question.verdict = 'partial';
      question.answeredAt = '2026-09-04T03:01:00.000Z';
      question.evaluatedAt = '2026-09-04T03:02:00.000Z';
      question.feedback = {
        verdict: 'partial',
        matchedPoints: [],
        missingPoints: [
          {
            message: '遗漏了一个要点',
            evidence: [
              { blockId: 'summary:1', field: 'summary', text: '模型编造的内容' },
            ],
          },
        ],
        ambiguities: [],
        possibleConflicts: [],
        followUpQuestion: '为什么？',
        supplementalKnowledge: [],
      };
    }],
    ['引用字段', (database: ReturnType<typeof makeDesktopDatabase>) => {
      database.review.sessions[0].questions[0].evidence[0].field = 'summary';
    }],
  ] as const)('拒绝无法回溯到冻结快照的%s', (_label, mutate) => {
    const database = makeDesktopDatabase();
    mutate(database);
    expect(() => parseDesktopDatabase(database)).toThrow(/\u65e0效的笔记引用/);
  });

  test('拒绝与会话笔记或 revision 不一致的快照', () => {
    for (const mutate of [
      (database: ReturnType<typeof makeDesktopDatabase>) => {
        database.review.sessions[0].noteSnapshot.noteId = 'another-note';
      },
      (database: ReturnType<typeof makeDesktopDatabase>) => {
        database.review.sessions[0].noteSnapshot.revision = '2026-09-04T09:00:00.000Z';
      },
    ]) {
      const database = makeDesktopDatabase();
      mutate(database);
      expect(() => parseDesktopDatabase(database)).toThrow(/\u5feb照与会话不一致/);
    }
  });
});
