import type { Note } from './note-store.js';

export type Confidence = 'low' | 'medium' | 'high';
export type ReviewVerdict = 'incorrect' | 'partial' | 'correct';
export type ReviewQuestionKind = 'recall' | 'application';
export type ReviewSessionMode = 'recall' | 'due';
export type ReviewSessionStatus =
  | 'answering'
  | 'ready-for-feedback'
  | 'feedback'
  | 'complete'
  | 'paused';
export type HintLevel = 0 | 1 | 2 | 3;
export type ReviewStage = 0 | 1 | 2;
export type NoteEvidenceField = 'cues' | 'notes' | 'summary';

export interface NoteSnapshot {
  noteId: string;
  title: string;
  revision: string;
  cues: string;
  notes: string;
  summary: string;
  capturedAt: string;
}

export interface ReviewEvidence {
  blockId: string;
  field: NoteEvidenceField;
  text: string;
}

export interface ReviewFeedbackPoint {
  message: string;
  evidence: ReviewEvidence[];
}

/**
 * 反馈只记录诊断与追问，不提供可直接替换用户笔记的标准答案字段。
 */
export interface ReviewFeedback {
  verdict: ReviewVerdict | 'insufficient_evidence';
  matchedPoints: ReviewFeedbackPoint[];
  missingPoints: ReviewFeedbackPoint[];
  ambiguities: ReviewFeedbackPoint[];
  possibleConflicts: ReviewFeedbackPoint[];
  followUpQuestion: string | null;
  supplementalKnowledge: string[];
}

export interface ReviewQuestionRecord {
  questionId: string;
  cardId: string;
  conceptKey: string;
  conceptLabel: string;
  prompt: string;
  kind: ReviewQuestionKind;
  hints: string[];
  evidence: ReviewEvidence[];
  initialAnswer: string | null;
  confidence: Confidence | null;
  hintLevel: HintLevel;
  viewedEvidence: boolean;
  verdict: ReviewVerdict | null;
  feedback: ReviewFeedback | null;
  createdAt: string;
  answeredAt: string | null;
  evaluatedAt: string | null;
}

export interface ReviewSession {
  sessionId: string;
  noteId: string;
  noteRevision: string;
  mode: ReviewSessionMode;
  status: ReviewSessionStatus;
  noteSnapshot: NoteSnapshot;
  userSummary: string | null;
  questions: ReviewQuestionRecord[];
  currentQuestionIndex: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewCard {
  cardId: string;
  noteId: string;
  noteRevision: string;
  conceptKey: string;
  conceptLabel: string;
  dueDate: string;
  stage: ReviewStage;
  lastVerdict: ReviewVerdict;
  highConfidenceMiss: boolean;
  stale: boolean;
  createdAt: string;
  updatedAt: string;
  lastReviewedAt: string;
}

export interface ReviewAttempt {
  attemptId: string;
  sessionId: string;
  cardId: string;
  noteId: string;
  noteRevision: string;
  questionId: string;
  kind: ReviewQuestionKind;
  sessionMode: ReviewSessionMode;
  initialAnswer: string;
  verdict: ReviewVerdict;
  confidence: Confidence;
  hintLevel: HintLevel;
  viewedEvidence: boolean;
  attemptedAt: string;
}

/** “复习记录”是持久化的一次初答及其评估结果。 */
export type ReviewRecord = ReviewAttempt;

export interface ReviewOutcome {
  verdict: ReviewVerdict;
  confidence: Confidence;
  hintLevel: HintLevel;
  viewedEvidence: boolean;
}

export interface ReviewScheduleOptions {
  now?: Date | string | number;
  /** 默认使用运行应用的系统时区；测试或显式用户时区可传 IANA 名称。 */
  timeZone?: string;
}

export interface ReviewSchedule {
  reviewedOn: string;
  dueDate: string;
  intervalDays: 1 | 3 | 7;
  stage: ReviewStage;
  highConfidenceMiss: boolean;
}

export interface LearningMetrics {
  attemptedCount: number;
  delayedRecallAccuracy: number | null;
  correctionRate: number | null;
  confidenceCalibration: number | null;
  transferAccuracy: number | null;
}

const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const CONFIDENCE_SCORE: Readonly<Record<Confidence, number>> = {
  low: 0,
  medium: 0.5,
  high: 1,
};
const VERDICT_SCORE: Readonly<Record<ReviewVerdict, number>> = {
  incorrect: 0,
  partial: 0.5,
  correct: 1,
};

function normalizeDateInput(value: Date | string | number): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError('复习时间必须是有效日期');
  }
  return date;
}

function formatCalendarParts(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseCalendarDate(value: string): { year: number; month: number; day: number } {
  const match = CALENDAR_DATE_PATTERN.exec(value);
  if (!match) {
    throw new RangeError('自然日必须使用有效的 YYYY-MM-DD 格式');
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) {
    throw new RangeError('自然日必须使用有效的 YYYY-MM-DD 格式');
  }

  const probe = new Date(0);
  probe.setUTCHours(0, 0, 0, 0);
  probe.setUTCFullYear(year, month - 1, day);
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new RangeError('自然日必须使用有效的 YYYY-MM-DD 格式');
  }

  return { year, month, day };
}

function requireReviewOutcome(outcome: ReviewOutcome): void {
  if (!['incorrect', 'partial', 'correct'].includes(outcome.verdict)) {
    throw new TypeError('verdict 不是有效的复习结果');
  }
  if (!['low', 'medium', 'high'].includes(outcome.confidence)) {
    throw new TypeError('confidence 不是有效的信心等级');
  }
  if (![0, 1, 2, 3].includes(outcome.hintLevel)) {
    throw new TypeError('hintLevel 必须是 0、1、2 或 3');
  }
  if (typeof outcome.viewedEvidence !== 'boolean') {
    throw new TypeError('viewedEvidence 必须是布尔值');
  }
}

function ratio(successes: number, total: number): number | null {
  return total === 0 ? null : successes / total;
}

function isIndependentSuccess(attempt: ReviewAttempt): boolean {
  return (
    attempt.verdict === 'correct' &&
    attempt.hintLevel === 0 &&
    !attempt.viewedEvidence
  );
}

function requireAttemptTimestamp(attempt: ReviewAttempt): number {
  const timestamp = Date.parse(attempt.attemptedAt);
  if (Number.isNaN(timestamp)) {
    throw new RangeError(`复习记录 ${attempt.attemptId} 的 attemptedAt 无效`);
  }
  return timestamp;
}

/**
 * 将一个时刻转换为对应时区的自然日。未传 timeZone 时使用操作系统本地时区。
 */
export function toLocalCalendarDate(
  value: Date | string | number = new Date(),
  timeZone?: string,
): string {
  const date = normalizeDateInput(value);
  if (timeZone === undefined) {
    return formatCalendarParts(date.getFullYear(), date.getMonth() + 1, date.getDate());
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
}

/**
 * 对纯自然日做日历加法，不按 24 小时毫秒相加，因此不会被夏令时切换影响。
 */
export function addCalendarDays(calendarDate: string, days: number): string {
  if (!Number.isInteger(days)) {
    throw new RangeError('自然日增量必须是整数');
  }

  const { year, month, day } = parseCalendarDate(calendarDate);
  const result = new Date(0);
  result.setUTCHours(0, 0, 0, 0);
  result.setUTCFullYear(year, month - 1, day + days);
  return formatCalendarParts(
    result.getUTCFullYear(),
    result.getUTCMonth() + 1,
    result.getUTCDate(),
  );
}

/** 按首版 1/3/7 日固定规则计算间隔。 */
export function getReviewIntervalDays(outcome: ReviewOutcome): 1 | 3 | 7 {
  requireReviewOutcome(outcome);

  if (
    outcome.verdict === 'incorrect' ||
    outcome.viewedEvidence ||
    outcome.hintLevel === 3 ||
    (outcome.verdict === 'partial' && outcome.confidence === 'high')
  ) {
    return 1;
  }

  if (
    outcome.verdict === 'partial' ||
    outcome.hintLevel > 0 ||
    (outcome.verdict === 'correct' && outcome.confidence === 'low')
  ) {
    return 3;
  }

  return 7;
}

/** 基于复习发生地的自然日生成下一次到期日。 */
export function scheduleNextReview(
  outcome: ReviewOutcome,
  options: ReviewScheduleOptions = {},
): ReviewSchedule {
  const intervalDays = getReviewIntervalDays(outcome);
  const reviewedOn = toLocalCalendarDate(options.now ?? new Date(), options.timeZone);
  const stage: ReviewStage = intervalDays === 1 ? 0 : intervalDays === 3 ? 1 : 2;

  return {
    reviewedOn,
    dueDate: addCalendarDays(reviewedOn, intervalDays),
    intervalDays,
    stage,
    highConfidenceMiss:
      outcome.confidence === 'high' && outcome.verdict !== 'correct',
  };
}

/**
 * 根据笔记 ID 与调用方提供的稳定概念键生成跨重启不变的 card ID。
 */
export function createReviewCardId(noteId: string, conceptKey: string): string {
  const normalizedNoteId = noteId.normalize('NFKC').trim();
  const normalizedConceptKey = conceptKey.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (normalizedNoteId.length === 0 || normalizedConceptKey.length === 0) {
    throw new TypeError('noteId 和 conceptKey 不能为空');
  }

  return `review-card:${encodeURIComponent(normalizedNoteId)}:${encodeURIComponent(normalizedConceptKey)}`;
}

/** 从一条笔记冻结供复习使用的最小快照。 */
export function createNoteSnapshot(note: Note, capturedAt: Date | string = new Date()): NoteSnapshot {
  const captureDate = normalizeDateInput(capturedAt);
  return {
    noteId: note.id,
    title: note.title,
    revision: note.updatedAt,
    cues: note.cues,
    notes: note.notes,
    summary: note.summary,
    capturedAt: captureDate.toISOString(),
  };
}

/**
 * 计算首版学习指标：
 * - 延迟回忆与迁移正确率只把无提示、未查看原文的正确作答视为独立成功；
 * - 错题修正率按 card 去重，要求失败后出现后续独立成功；
 * - 信心校准为信心分值与实际结果分值的平均绝对误差补数，范围 0～1。
 */
export function calculateLearningMetrics(
  attempts: readonly ReviewAttempt[],
): LearningMetrics {
  const delayedAttempts = attempts.filter(
    (attempt) => attempt.sessionMode === 'due' && attempt.kind === 'recall',
  );
  const transferAttempts = attempts.filter((attempt) => attempt.kind === 'application');

  const attemptsByCard = new Map<string, ReviewAttempt[]>();
  for (const attempt of attempts) {
    requireAttemptTimestamp(attempt);
    const cardAttempts = attemptsByCard.get(attempt.cardId) ?? [];
    cardAttempts.push(attempt);
    attemptsByCard.set(attempt.cardId, cardAttempts);
  }

  let cardsWithFailure = 0;
  let correctedCards = 0;
  for (const cardAttempts of attemptsByCard.values()) {
    const ordered = cardAttempts
      .map((attempt, index) => ({ attempt, index }))
      .sort((left, right) => {
        const difference =
          requireAttemptTimestamp(left.attempt) - requireAttemptTimestamp(right.attempt);
        return difference === 0 ? left.index - right.index : difference;
      })
      .map(({ attempt }) => attempt);

    const firstFailureIndex = ordered.findIndex((attempt) => !isIndependentSuccess(attempt));
    if (firstFailureIndex !== -1) {
      cardsWithFailure += 1;
      if (ordered.slice(firstFailureIndex + 1).some(isIndependentSuccess)) {
        correctedCards += 1;
      }
    }
  }

  const calibrationError = attempts.reduce((total, attempt) => {
    return total + Math.abs(CONFIDENCE_SCORE[attempt.confidence] - VERDICT_SCORE[attempt.verdict]);
  }, 0);

  return {
    attemptedCount: attempts.length,
    delayedRecallAccuracy: ratio(
      delayedAttempts.filter(isIndependentSuccess).length,
      delayedAttempts.length,
    ),
    correctionRate: ratio(correctedCards, cardsWithFailure),
    confidenceCalibration:
      attempts.length === 0 ? null : 1 - calibrationError / attempts.length,
    transferAccuracy: ratio(
      transferAttempts.filter(isIndependentSuccess).length,
      transferAttempts.length,
    ),
  };
}
