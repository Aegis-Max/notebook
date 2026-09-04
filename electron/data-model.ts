import { z } from 'zod';

import { normalizeNote, sortNotes, type Note } from '../src/domain/note-store.js';
import type {
  Confidence,
  NoteEvidenceField,
  ReviewAttempt,
  ReviewCard,
  ReviewFeedback,
  ReviewFeedbackPoint,
  ReviewQuestionKind,
  ReviewQuestionRecord,
  ReviewSession,
  ReviewSessionMode,
  ReviewSessionStatus,
  ReviewStage,
  ReviewVerdict,
} from '../src/domain/review.js';
import { DesktopError } from './errors.js';

export const DESKTOP_DATA_SCHEMA_VERSION = 2;

const idSchema = z.string().trim().min(1).max(1000);
const shortTextSchema = z.string().max(4000);
const longTextSchema = z.string().max(1_000_000);
const isoTimestampSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: '时间戳无效',
});
const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '自然日格式无效');
const confidenceSchema: z.ZodType<Confidence> = z.enum(['low', 'medium', 'high']);
const verdictSchema: z.ZodType<ReviewVerdict> = z.enum([
  'incorrect',
  'partial',
  'correct',
]);
const questionKindSchema: z.ZodType<ReviewQuestionKind> = z.enum([
  'recall',
  'application',
]);
const sessionModeSchema: z.ZodType<ReviewSessionMode> = z.enum(['recall', 'due']);
const sessionStatusSchema: z.ZodType<ReviewSessionStatus> = z.enum([
  'answering',
  'ready-for-feedback',
  'feedback',
  'complete',
  'paused',
]);
const evidenceFieldSchema: z.ZodType<NoteEvidenceField> = z.enum([
  'cues',
  'notes',
  'summary',
]);

const noteSchema = z.unknown().transform((candidate, context): Note => {
  try {
    return normalizeNote(candidate);
  } catch (error) {
    context.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : '笔记无效',
    });
    return z.NEVER;
  }
});

const evidenceSchema = z
  .object({
    blockId: idSchema,
    field: evidenceFieldSchema,
    text: longTextSchema.min(1),
  })
  .strict();

const feedbackPointSchema: z.ZodType<ReviewFeedbackPoint> = z
  .object({
    message: shortTextSchema.min(1),
    evidence: z.array(evidenceSchema).max(20),
  })
  .strict();

const feedbackSchema: z.ZodType<ReviewFeedback> = z
  .object({
    verdict: z.enum(['incorrect', 'partial', 'correct', 'insufficient_evidence']),
    matchedPoints: z.array(feedbackPointSchema).max(30),
    missingPoints: z.array(feedbackPointSchema).max(30),
    ambiguities: z.array(feedbackPointSchema).max(30),
    possibleConflicts: z.array(feedbackPointSchema).max(30),
    followUpQuestion: shortTextSchema.nullable(),
    supplementalKnowledge: z.array(shortTextSchema).max(20),
  })
  .strict();

const snapshotSchema = z
  .object({
    noteId: idSchema,
    title: shortTextSchema,
    revision: idSchema,
    cues: longTextSchema,
    notes: longTextSchema,
    summary: longTextSchema,
    capturedAt: isoTimestampSchema,
  })
  .strict();

const baseQuestionSchema = z
  .object({
    questionId: idSchema,
    cardId: idSchema,
    conceptKey: idSchema,
    conceptLabel: shortTextSchema.min(1),
    prompt: shortTextSchema.min(1),
    kind: questionKindSchema,
    hints: z.array(shortTextSchema.min(1)).length(2),
    evidence: z.array(evidenceSchema).min(1).max(20),
    initialAnswer: longTextSchema.nullable(),
    confidence: confidenceSchema.nullable(),
    hintLevel: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    viewedEvidence: z.boolean(),
    verdict: verdictSchema.nullable(),
    feedback: feedbackSchema.nullable(),
    createdAt: isoTimestampSchema,
    answeredAt: isoTimestampSchema.nullable(),
    evaluatedAt: isoTimestampSchema.nullable(),
  })
  .strict();

export interface StoredReviewQuestion extends ReviewQuestionRecord {
  /** 仅主进程用于评价答案；不会通过 preload 暴露。 */
  assessmentPoints: ReviewFeedbackPoint[];
}

const storedQuestionSchema: z.ZodType<StoredReviewQuestion> = baseQuestionSchema
  .extend({
    assessmentPoints: z.array(feedbackPointSchema).min(1).max(30),
  })
  .strict();

export interface StoredReviewSession extends Omit<ReviewSession, 'questions'> {
  questions: StoredReviewQuestion[];
}

const storedSessionSchema: z.ZodType<StoredReviewSession> = z
  .object({
    sessionId: idSchema,
    noteId: idSchema,
    noteRevision: idSchema,
    mode: sessionModeSchema,
    status: sessionStatusSchema,
    noteSnapshot: snapshotSchema,
    userSummary: longTextSchema.nullable(),
    questions: z.array(storedQuestionSchema).min(1).max(20),
    currentQuestionIndex: z.number().int().min(0).max(19),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((session, context) => {
    if (
      session.currentQuestionIndex >= session.questions.length &&
      session.status !== 'complete'
    ) {
      context.addIssue({ code: 'custom', message: '当前题目索引越界' });
    }
    if (
      session.noteSnapshot.noteId !== session.noteId ||
      session.noteSnapshot.revision !== session.noteRevision
    ) {
      context.addIssue({ code: 'custom', message: '复习快照与会话不一致' });
    }
    if (!sessionEvidenceIsValid(session)) {
      context.addIssue({ code: 'custom', message: '复习记录包含无效的笔记引用' });
    }
  });

const cardSchema: z.ZodType<ReviewCard> = z
  .object({
    cardId: idSchema,
    noteId: idSchema,
    noteRevision: idSchema,
    conceptKey: idSchema,
    conceptLabel: shortTextSchema.min(1),
    dueDate: calendarDateSchema,
    stage: z.union([z.literal(0), z.literal(1), z.literal(2)]) as z.ZodType<ReviewStage>,
    lastVerdict: verdictSchema,
    highConfidenceMiss: z.boolean(),
    stale: z.boolean(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    lastReviewedAt: isoTimestampSchema,
  })
  .strict();

const attemptSchema: z.ZodType<ReviewAttempt> = z
  .object({
    attemptId: idSchema,
    sessionId: idSchema,
    cardId: idSchema,
    noteId: idSchema,
    noteRevision: idSchema,
    questionId: idSchema,
    kind: questionKindSchema,
    sessionMode: sessionModeSchema,
    initialAnswer: longTextSchema,
    verdict: verdictSchema,
    confidence: confidenceSchema,
    hintLevel: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    viewedEvidence: z.boolean(),
    attemptedAt: isoTimestampSchema,
  })
  .strict();

export interface DesktopReviewData {
  sessions: StoredReviewSession[];
  cards: ReviewCard[];
  attempts: ReviewAttempt[];
}

export interface DesktopDatabase {
  schemaVersion: typeof DESKTOP_DATA_SCHEMA_VERSION;
  notes: Note[];
  review: DesktopReviewData;
}

const reviewDataSchema: z.ZodType<DesktopReviewData> = z
  .object({
    sessions: z.array(storedSessionSchema).max(10_000),
    cards: z.array(cardSchema).max(50_000),
    attempts: z.array(attemptSchema).max(200_000),
  })
  .strict();

const databaseSchema = z
  .object({
    schemaVersion: z.literal(DESKTOP_DATA_SCHEMA_VERSION),
    notes: z.array(noteSchema).max(10_000),
    review: reviewDataSchema,
  })
  .strict();

const backupSchema = z
  .object({
    schemaVersion: z.literal(DESKTOP_DATA_SCHEMA_VERSION),
    exportedAt: isoTimestampSchema,
    notes: z.array(noteSchema).max(10_000),
    review: reviewDataSchema,
  })
  .strict();

export interface DesktopBackup extends DesktopDatabase {
  exportedAt: string;
}

function requireUniqueIds(
  values: readonly unknown[],
  getId: (value: never) => string,
  label: string,
): void {
  const ids = new Set<string>();
  for (const raw of values) {
    const id = getId(raw as never);
    if (ids.has(id)) throw new DesktopError('DUPLICATE_ID', `${label}包含重复 ID`);
    ids.add(id);
  }
}

export function emptyDesktopDatabase(): DesktopDatabase {
  return {
    schemaVersion: DESKTOP_DATA_SCHEMA_VERSION,
    notes: [],
    review: { sessions: [], cards: [], attempts: [] },
  };
}

export function parseDesktopDatabase(candidate: unknown): DesktopDatabase {
  const parsed = databaseSchema.parse(candidate);
  requireUniqueIds(parsed.notes, (note: Note) => note.id, '笔记');
  requireUniqueIds(parsed.review.sessions, (session: StoredReviewSession) => session.sessionId, '会话');
  requireUniqueIds(parsed.review.cards, (card: ReviewCard) => card.cardId, '复习卡片');
  requireUniqueIds(parsed.review.attempts, (attempt: ReviewAttempt) => attempt.attemptId, '复习记录');
  return { ...parsed, notes: sortNotes(parsed.notes) };
}

export function parseDesktopBackup(candidate: unknown): DesktopBackup {
  const parsed = backupSchema.parse(candidate);
  const database = parseDesktopDatabase({
    schemaVersion: parsed.schemaVersion,
    notes: parsed.notes,
    review: parsed.review,
  });
  return { ...database, exportedAt: new Date(parsed.exportedAt).toISOString() };
}

export interface SourceBlock {
  blockId: string;
  field: NoteEvidenceField;
  fieldLabel: string;
  text: string;
}

export function snapshotBlocks(
  snapshot: Pick<StoredReviewSession['noteSnapshot'], 'cues' | 'notes' | 'summary'>,
): SourceBlock[] {
  const definitions: Array<[NoteEvidenceField, string, string]> = [
    ['cues', '线索与问题', snapshot.cues],
    ['notes', '课堂笔记', snapshot.notes],
    ['summary', '总结', snapshot.summary],
  ];
  const blocks: SourceBlock[] = [];

  for (const [field, fieldLabel, text] of definitions) {
    const parts = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
    parts.forEach((part, index) => {
      blocks.push({ blockId: `${field}:${index + 1}`, field, fieldLabel, text: part });
    });
  }
  return blocks;
}

function evidenceMatchesBlock(
  evidence: { blockId: string; field: NoteEvidenceField; text: string },
  blocks: readonly SourceBlock[],
): boolean {
  const block = blocks.find((candidate) => candidate.blockId === evidence.blockId);
  return Boolean(
    block &&
      block.field === evidence.field &&
      evidence.text.length > 0 &&
      block.text.includes(evidence.text),
  );
}

function sessionEvidenceIsValid(session: StoredReviewSession): boolean {
  const blocks = snapshotBlocks(session.noteSnapshot);
  const feedbackEvidence = (feedback: ReviewFeedback | null) =>
    feedback
      ? [
          ...feedback.matchedPoints,
          ...feedback.missingPoints,
          ...feedback.ambiguities,
          ...feedback.possibleConflicts,
        ].flatMap((point) => point.evidence)
      : [];

  return session.questions.every((question) =>
    [
      ...question.evidence,
      ...question.assessmentPoints.flatMap((point) => point.evidence),
      ...feedbackEvidence(question.feedback),
    ].every((evidence) => evidenceMatchesBlock(evidence, blocks)),
  );
}

export function assertEvidence(
  evidence: { blockId: string; text: string },
  blocks: readonly SourceBlock[],
): SourceBlock {
  const block = blocks.find((candidate) => candidate.blockId === evidence.blockId);
  if (!block || evidence.text.length === 0 || !block.text.includes(evidence.text)) {
    throw new DesktopError(
      'AI_INVALID_EVIDENCE',
      'AI 返回的引用无法在当前笔记快照中逐字定位',
    );
  }
  return block;
}
