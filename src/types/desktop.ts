import type { Note } from '../domain/note-store.js';

export type AiProviderKind = 'cloud' | 'ollama';
export type Confidence = 'low' | 'medium' | 'high';
export type ReviewVerdict = 'incorrect' | 'partial' | 'correct';
export type ReviewQuestionKind = 'recall' | 'application';
export type ReviewSessionMode = 'recall' | 'due';

export interface SaveResult {
  ok: boolean;
  error: string | null;
}

export interface LoadNotesResult {
  notes: Note[];
  error: string | null;
}

export interface ImportResult extends SaveResult {
  addedCount: number;
  totalCount: number;
  notes: Note[];
}

export interface ExportResult extends SaveResult {
  filePath: string | null;
}

export interface PrintResult extends SaveResult {}

export interface AiSettings {
  provider: AiProviderKind;
  cloudBaseUrl: string;
  cloudModel: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  supplementalKnowledge: boolean;
}

export interface AiSettingsView extends AiSettings {
  cloudCredentialConfigured: boolean;
  secureStorageAvailable: boolean;
}

export interface AiConnectionResult extends SaveResult {
  provider: AiProviderKind;
  model: string;
}

export interface EvidenceView {
  blockId: string;
  field: 'cues' | 'notes' | 'summary';
  fieldLabel: string;
  text: string;
}

export interface ReviewFeedbackItem {
  message: string;
  evidence: EvidenceView[];
}

export interface ReviewFeedbackView {
  verdict: ReviewVerdict | 'insufficient_evidence';
  matchedPoints: ReviewFeedbackItem[];
  missingPoints: ReviewFeedbackItem[];
  ambiguities: ReviewFeedbackItem[];
  possibleConflicts: ReviewFeedbackItem[];
  followUpQuestion: string | null;
  supplementalKnowledge: string[];
}

export interface ReviewQuestionView {
  questionId: string;
  conceptLabel: string;
  prompt: string;
  kind: ReviewQuestionKind;
  position: number;
  total: number;
  initialAnswer: string | null;
  confidence: Confidence | null;
  hintLevel: 0 | 1 | 2 | 3;
  visibleHint: string | null;
  visibleEvidence: EvidenceView[];
  feedback: ReviewFeedbackView | null;
}

export interface ReviewSessionView {
  sessionId: string;
  noteId: string;
  noteTitle: string;
  noteRevision: string;
  mode: ReviewSessionMode;
  status: 'answering' | 'ready-for-feedback' | 'feedback' | 'complete' | 'paused';
  currentQuestion: ReviewQuestionView | null;
  completedCount: number;
  total: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewCardView {
  cardId: string;
  noteId: string;
  noteTitle: string;
  conceptLabel: string;
  dueDate: string;
  stage: number;
  lastVerdict: ReviewVerdict;
  highConfidenceMiss: boolean;
  stale: boolean;
}

export interface LearningMetricsView {
  attemptedCount: number;
  delayedRecallAccuracy: number | null;
  correctionRate: number | null;
  confidenceCalibration: number | null;
  transferAccuracy: number | null;
}

export interface ReviewOverviewView {
  dueCount: number;
  upcomingCount: number;
  cards: ReviewCardView[];
  resumableSession: ReviewSessionView | null;
  metrics: LearningMetricsView;
}

export interface FeynmanFeedbackView {
  covered: ReviewFeedbackItem[];
  omissions: ReviewFeedbackItem[];
  ambiguities: ReviewFeedbackItem[];
  possibleConflicts: ReviewFeedbackItem[];
  followUpQuestion: string | null;
  supplementalKnowledge: string[];
  round: number;
  complete: boolean;
}

export interface DesktopApi {
  readonly isDesktop: true;
  readonly platform: string;
  notes: {
    load(): Promise<LoadNotesResult>;
    save(notes: Note[]): Promise<SaveResult>;
    importBackup(): Promise<ImportResult>;
    exportBackup(): Promise<ExportResult>;
    print(): Promise<PrintResult>;
  };
  ai: {
    getSettings(): Promise<AiSettingsView>;
    saveSettings(settings: AiSettings): Promise<AiSettingsView>;
    setCloudCredential(secret: string): Promise<SaveResult>;
    deleteCloudCredential(): Promise<SaveResult>;
    testConnection(): Promise<AiConnectionResult>;
  };
  review: {
    getOverview(noteId?: string): Promise<ReviewOverviewView>;
    startRecall(
      noteId: string,
      questionCount?: number,
      summaryUnavailable?: boolean,
    ): Promise<ReviewSessionView>;
    startDueReview(cardId: string): Promise<ReviewSessionView>;
    resume(sessionId: string): Promise<ReviewSessionView>;
    submitInitialAnswer(
      sessionId: string,
      answer: string,
      confidence: Confidence,
    ): Promise<ReviewSessionView>;
    revealHint(sessionId: string, level: 1 | 2 | 3): Promise<ReviewSessionView>;
    evaluateAnswer(sessionId: string): Promise<ReviewSessionView>;
    nextQuestion(sessionId: string): Promise<ReviewSessionView>;
    pause(sessionId: string): Promise<ReviewSessionView>;
    abandon(sessionId: string): Promise<SaveResult>;
    evaluateFeynman(
      noteId: string,
      conceptLabel: string,
      explanation: string,
      confidence: Confidence,
      round: number,
    ): Promise<FeynmanFeedbackView>;
  };
}

declare global {
  interface Window {
    cornellDesktop?: DesktopApi;
  }
}
