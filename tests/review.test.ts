import { describe, expect, test } from 'vitest';

import {
  addCalendarDays,
  calculateLearningMetrics,
  createNoteSnapshot,
  createReviewCardId,
  getReviewIntervalDays,
  scheduleNextReview,
  toLocalCalendarDate,
  type ReviewAttempt,
  type ReviewOutcome,
} from '../src/domain/review.js';
import type { Note } from '../src/domain/note-store.js';

function outcome(overrides: Partial<ReviewOutcome> = {}): ReviewOutcome {
  return {
    verdict: 'correct',
    confidence: 'high',
    hintLevel: 0,
    viewedEvidence: false,
    ...overrides,
  };
}

function attempt(overrides: Partial<ReviewAttempt> = {}): ReviewAttempt {
  return {
    attemptId: 'attempt-a',
    sessionId: 'session-a',
    cardId: 'card-a',
    noteId: 'note-a',
    noteRevision: '2026-09-01T00:00:00.000Z',
    questionId: 'question-a',
    kind: 'recall',
    sessionMode: 'due',
    initialAnswer: '我的回答',
    verdict: 'correct',
    confidence: 'high',
    hintLevel: 0,
    viewedEvidence: false,
    attemptedAt: '2026-09-03T01:00:00.000Z',
    ...overrides,
  };
}

describe('固定 1/3/7 日排程', () => {
  test.each([
    ['错误', outcome({ verdict: 'incorrect', confidence: 'low' }), 1],
    ['查看原文', outcome({ viewedEvidence: true }), 1],
    ['证据层级提示', outcome({ hintLevel: 3 }), 1],
    ['高信心部分正确', outcome({ verdict: 'partial', confidence: 'high' }), 1],
    ['部分正确', outcome({ verdict: 'partial', confidence: 'medium' }), 3],
    ['使用提示后正确', outcome({ hintLevel: 1 }), 3],
    ['低信心正确', outcome({ confidence: 'low' }), 3],
    ['中信心独立正确', outcome({ confidence: 'medium' }), 7],
    ['高信心独立正确', outcome(), 7],
  ] as const)('%s 遵循对应固定间隔', (_label, reviewOutcome, expectedDays) => {
    expect(getReviewIntervalDays(reviewOutcome)).toBe(expectedDays);
  });

  test('排期同时返回阶段和高信心失误标记', () => {
    expect(
      scheduleNextReview(outcome({ verdict: 'partial', confidence: 'high' }), {
        now: '2026-09-03T15:30:00.000Z',
        timeZone: 'Asia/Shanghai',
      }),
    ).toEqual({
      reviewedOn: '2026-09-03',
      dueDate: '2026-09-04',
      intervalDays: 1,
      stage: 0,
      highConfidenceMiss: true,
    });

    expect(
      scheduleNextReview(outcome({ confidence: 'medium' }), {
        now: '2026-09-03T15:30:00.000Z',
        timeZone: 'Asia/Shanghai',
      }).stage,
    ).toBe(2);
  });
});

describe('本地自然日与时区边界', () => {
  test('同一时刻按复习所在地确定自然日', () => {
    const instant = '2026-09-03T16:30:00.000Z';
    expect(toLocalCalendarDate(instant, 'UTC')).toBe('2026-09-03');
    expect(toLocalCalendarDate(instant, 'Asia/Shanghai')).toBe('2026-09-04');
    expect(toLocalCalendarDate(instant, 'America/Los_Angeles')).toBe('2026-09-03');
  });

  test('午夜后以新的本地自然日为排程起点', () => {
    const scheduled = scheduleNextReview(outcome(), {
      now: '2026-09-03T16:01:00.000Z',
      timeZone: 'Asia/Shanghai',
    });

    expect(scheduled.reviewedOn).toBe('2026-09-04');
    expect(scheduled.dueDate).toBe('2026-09-11');
  });

  test('日历加法跨越闰日、年末和夏令时日期而不依赖 24 小时毫秒', () => {
    expect(addCalendarDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');

    const beforeDstSwitch = scheduleNextReview(outcome({ verdict: 'incorrect' }), {
      now: '2026-03-08T07:30:00.000Z',
      timeZone: 'America/Los_Angeles',
    });
    expect(beforeDstSwitch.reviewedOn).toBe('2026-03-07');
    expect(beforeDstSwitch.dueDate).toBe('2026-03-08');
  });

  test('拒绝无效自然日、非整数日增量和无效时刻', () => {
    expect(() => addCalendarDays('2025-02-29', 1)).toThrow(/YYYY-MM-DD/);
    expect(() => addCalendarDays('2026-09-03', 1.5)).toThrow(/整数/);
    expect(() => toLocalCalendarDate('not-a-date')).toThrow(/有效日期/);
  });
});

describe('稳定标识与冻结快照', () => {
  test('相同概念键跨调用得到相同 card ID，并规范化 Unicode 与空白', () => {
    const first = createReviewCardId(' note-a ', ' TCP  三次握手 ');
    const second = createReviewCardId('note-a', 'ＴＣＰ 三次握手');
    expect(first).toBe(second);
    expect(first).not.toBe(createReviewCardId('note-a', 'TCP 四次挥手'));
    expect(() => createReviewCardId('', 'TCP')).toThrow(/不能为空/);
  });

  test('笔记快照只复制复习所需内容并锁定 revision', () => {
    const note: Note = {
      id: 'note-a',
      title: '网络课程',
      date: '2026-09-03',
      cues: 'TCP',
      notes: '三次握手',
      summary: '可靠连接',
      createdAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-03T01:00:00.000Z',
    };

    const snapshot = createNoteSnapshot(note, '2026-09-03T02:00:00.000Z');
    note.notes = '后来修改的正文';

    expect(snapshot).toEqual({
      noteId: 'note-a',
      title: '网络课程',
      revision: '2026-09-03T01:00:00.000Z',
      cues: 'TCP',
      notes: '三次握手',
      summary: '可靠连接',
      capturedAt: '2026-09-03T02:00:00.000Z',
    });
  });
});

describe('学习指标', () => {
  test('无记录时返回零尝试和不可计算指标', () => {
    expect(calculateLearningMetrics([])).toEqual({
      attemptedCount: 0,
      delayedRecallAccuracy: null,
      correctionRate: null,
      confidenceCalibration: null,
      transferAccuracy: null,
    });
  });

  test('计算独立延迟回忆、错题修正、信心校准和迁移正确率', () => {
    const attempts = [
      attempt({
        attemptId: 'a-fail',
        cardId: 'card-a',
        verdict: 'incorrect',
        confidence: 'high',
        attemptedAt: '2026-09-01T01:00:00.000Z',
      }),
      attempt({
        attemptId: 'a-corrected',
        cardId: 'card-a',
        verdict: 'correct',
        confidence: 'medium',
        attemptedAt: '2026-09-02T01:00:00.000Z',
      }),
      attempt({
        attemptId: 'b-partial',
        cardId: 'card-b',
        verdict: 'partial',
        confidence: 'medium',
        attemptedAt: '2026-09-01T02:00:00.000Z',
      }),
      attempt({
        attemptId: 'c-transfer',
        cardId: 'card-c',
        kind: 'application',
        sessionMode: 'due',
        verdict: 'correct',
        confidence: 'high',
        attemptedAt: '2026-09-03T01:00:00.000Z',
      }),
      attempt({
        attemptId: 'd-transfer-hinted',
        cardId: 'card-d',
        kind: 'application',
        sessionMode: 'due',
        verdict: 'correct',
        confidence: 'high',
        hintLevel: 1,
        attemptedAt: '2026-09-03T02:00:00.000Z',
      }),
    ];

    const metrics = calculateLearningMetrics(attempts);
    expect(metrics.attemptedCount).toBe(5);
    expect(metrics.delayedRecallAccuracy).toBeCloseTo(1 / 3);
    expect(metrics.correctionRate).toBeCloseTo(1 / 3);
    expect(metrics.confidenceCalibration).toBeCloseTo(0.7);
    expect(metrics.transferAccuracy).toBeCloseTo(1 / 2);
  });

  test('错题修正按时间排序而不是输入数组顺序', () => {
    const metrics = calculateLearningMetrics([
      attempt({
        attemptId: 'later-success',
        attemptedAt: '2026-09-04T00:00:00.000Z',
      }),
      attempt({
        attemptId: 'earlier-failure',
        verdict: 'incorrect',
        confidence: 'low',
        attemptedAt: '2026-09-03T00:00:00.000Z',
      }),
    ]);

    expect(metrics.correctionRate).toBe(1);
  });

  test('拒绝无法排序的复习记录时间', () => {
    expect(() =>
      calculateLearningMetrics([attempt({ attemptedAt: 'not-a-time' })]),
    ).toThrow(/attemptedAt/);
  });
});
