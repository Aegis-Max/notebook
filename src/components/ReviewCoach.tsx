import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Note } from '../domain/note-store.js';
import { getDesktopApi } from '../platform/renderer-platform.js';
import type {
  AiSettings,
  AiSettingsView,
  Confidence,
  EvidenceView,
  FeynmanFeedbackView,
  ReviewFeedbackItem,
  ReviewFeedbackView,
  ReviewOverviewView,
  ReviewSessionView,
} from '../types/desktop.js';

type ReviewStage = 'home' | 'privacy' | 'summary' | 'recall' | 'feynman' | 'settings';

const DEFAULT_SETTINGS: AiSettingsView = {
  provider: 'ollama',
  cloudBaseUrl: 'https://api.openai.com/v1',
  cloudModel: 'gpt-5-mini',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen3:8b',
  supplementalKnowledge: false,
  cloudCredentialConfigured: false,
  secureStorageAvailable: false,
};

const CONFIDENCE_OPTIONS: Array<{ value: Confidence; label: string; testId: string }> = [
  { value: 'low', label: '低', testId: 'confidence-low' },
  { value: 'medium', label: '中', testId: 'confidence-middle' },
  { value: 'high', label: '高', testId: 'confidence-high' },
];

function toMessage(error: unknown, fallback = '操作失败，请稍后重试。'): string {
  return error instanceof Error ? error.message : fallback;
}

function percent(value: number | null): string {
  return value === null ? '暂无数据' : `${Math.round(value * 100)}%`;
}

function formatDueDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(year, month - 1, day));
}

function ConfidencePicker({
  value,
  onChange,
  disabled = false,
  idPrefix,
}: {
  value: Confidence | null;
  onChange: (value: Confidence) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  return (
    <fieldset className="confidence-picker" disabled={disabled}>
      <legend>你对这次回答有多大把握？</legend>
      <div className="confidence-options">
        {CONFIDENCE_OPTIONS.map((option) => (
          <button
            key={option.value}
            id={`${idPrefix}-${option.value}`}
            className={value === option.value ? 'is-selected' : ''}
            data-testid={option.testId}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function EvidenceQuotes({ evidence }: { evidence: EvidenceView[] }) {
  if (evidence.length === 0) return null;

  return (
    <div className="evidence-quotes">
      {evidence.map((item) => (
        <figure key={`${item.blockId}-${item.text}`}>
          <figcaption>{item.fieldLabel}</figcaption>
          <blockquote>{item.text}</blockquote>
        </figure>
      ))}
    </div>
  );
}

function FeedbackGroup({
  title,
  tone,
  items,
  emptyLabel,
}: {
  title: string;
  tone: 'positive' | 'attention' | 'neutral';
  items: ReviewFeedbackItem[];
  emptyLabel: string;
}) {
  return (
    <section className={`feedback-group feedback-${tone}`}>
      <h4>{title}</h4>
      {items.length === 0 ? (
        <p className="feedback-empty">{emptyLabel}</p>
      ) : (
        <ul>
          {items.map((item, index) => (
            <li key={`${item.message}-${index}`}>
              <p>{item.message}</p>
              <EvidenceQuotes evidence={item.evidence} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SupplementalKnowledge({ items }: { items: string[] }) {
  if (items.length === 0) return null;

  return (
    <details className="supplemental-knowledge">
      <summary>模型补充知识 · 需自行核验</summary>
      <ul>
        {items.map((item, index) => (
          <li key={`${item}-${index}`}>{item}</li>
        ))}
      </ul>
    </details>
  );
}

function AnswerFeedback({ feedback }: { feedback: ReviewFeedbackView }) {
  const verdictLabel = {
    correct: '已独立回忆',
    partial: '部分回忆',
    incorrect: '需要再练',
    insufficient_evidence: '笔记依据不足',
  }[feedback.verdict];

  return (
    <div className="review-feedback" data-testid="review-feedback" aria-live="polite">
      <div className={`feedback-verdict is-${feedback.verdict}`}>{verdictLabel}</div>
      <FeedbackGroup
        title="已覆盖的要点"
        tone="positive"
        items={feedback.matchedPoints}
        emptyLabel="这次回答还没有覆盖到明确要点。"
      />
      <FeedbackGroup
        title="遗漏或仍需说清的内容"
        tone="attention"
        items={feedback.missingPoints}
        emptyLabel="未发现明显遗漏。"
      />
      <FeedbackGroup
        title="模糊表达"
        tone="neutral"
        items={feedback.ambiguities}
        emptyLabel="未发现需要澄清的表达。"
      />
      <FeedbackGroup
        title="与笔记可能不一致"
        tone="neutral"
        items={feedback.possibleConflicts}
        emptyLabel="未发现与笔记明显不一致的内容。"
      />
      {feedback.followUpQuestion ? (
        <aside className="coach-follow-up">
          <span>教练追问</span>
          <p>{feedback.followUpQuestion}</p>
        </aside>
      ) : null}
      <SupplementalKnowledge items={feedback.supplementalKnowledge} />
    </div>
  );
}

function FeynmanFeedback({ feedback }: { feedback: FeynmanFeedbackView }) {
  return (
    <div className="review-feedback" data-testid="feynman-feedback" aria-live="polite">
      <FeedbackGroup
        title="你已经讲清楚的部分"
        tone="positive"
        items={feedback.covered}
        emptyLabel="还没有足够明确的讲解要点。"
      />
      <FeedbackGroup
        title="遗漏"
        tone="attention"
        items={feedback.omissions}
        emptyLabel="未发现明显遗漏。"
      />
      <FeedbackGroup
        title="模糊表达"
        tone="neutral"
        items={feedback.ambiguities}
        emptyLabel="未发现需要澄清的表达。"
      />
      <FeedbackGroup
        title="可能错误"
        tone="attention"
        items={feedback.possibleConflicts}
        emptyLabel="未发现与笔记明显冲突的内容。"
      />
      {feedback.followUpQuestion ? (
        <aside className="coach-follow-up">
          <span>只追问一个问题</span>
          <p>{feedback.followUpQuestion}</p>
        </aside>
      ) : null}
      <SupplementalKnowledge items={feedback.supplementalKnowledge} />
    </div>
  );
}

interface ReviewCoachProps {
  open: boolean;
  note: Note;
  summary: string;
  dueCount: number;
  onDueCountChange: (count: number) => void;
  onSummaryChange: (value: string) => void;
  onBeforeStart: () => Promise<boolean>;
  onClosedBookChange: (closed: boolean) => void;
  onClose: () => void;
}

export function ReviewCoach({
  open,
  note,
  summary,
  dueCount,
  onDueCountChange,
  onSummaryChange,
  onBeforeStart,
  onClosedBookChange,
  onClose,
}: ReviewCoachProps) {
  const [stage, setStage] = useState<ReviewStage>('home');
  const [overview, setOverview] = useState<ReviewOverviewView | null>(null);
  const [settings, setSettings] = useState<AiSettingsView>(DEFAULT_SETTINGS);
  const [settingsDraft, setSettingsDraft] = useState<AiSettings>(DEFAULT_SETTINGS);
  const [credential, setCredential] = useState('');
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [summaryUnavailable, setSummaryUnavailable] = useState(false);
  const [questionCount, setQuestionCount] = useState(3);
  const [session, setSession] = useState<ReviewSessionView | null>(null);
  const [answer, setAnswer] = useState('');
  const [confidence, setConfidence] = useState<Confidence | null>(null);
  const [feynmanConcept, setFeynmanConcept] = useState('');
  const [feynmanExplanation, setFeynmanExplanation] = useState('');
  const [feynmanConfidence, setFeynmanConfidence] = useState<Confidence | null>(null);
  const [feynmanRound, setFeynmanRound] = useState(1);
  const [feynmanFeedback, setFeynmanFeedback] = useState<FeynmanFeedbackView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);
  const api = getDesktopApi();

  const loadOverview = useCallback(async () => {
    const currentApi = getDesktopApi();
    if (!currentApi) return;
    const nextOverview = await currentApi.review.getOverview(note.id);
    setOverview(nextOverview);
    onDueCountChange(nextOverview.dueCount);
  }, [note.id, onDueCountChange]);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setStage('home');
    setSession(null);
    setPrivacyAccepted(false);
    setSummaryUnavailable(false);
    setError('');
    setFeynmanConcept(note.title.trim());

    const currentApi = getDesktopApi();
    if (!currentApi) return;

    setBusy(true);
    void Promise.all([currentApi.review.getOverview(note.id), currentApi.ai.getSettings()])
      .then(([nextOverview, nextSettings]) => {
        if (cancelled) return;
        setOverview(nextOverview);
        setSettings(nextSettings);
        setSettingsDraft(nextSettings);
        onDueCountChange(nextOverview.dueCount);
      })
      .catch((loadError) => {
        if (!cancelled) setError(toMessage(loadError, '无法读取复习数据。'));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [note.id, note.title, onDueCountChange, open]);

  useEffect(() => {
    if (!open) return;
    window.setTimeout(() => {
      panelRef.current?.querySelector<HTMLElement>('[data-review-focus]')?.focus();
    }, 0);
  }, [open, stage, session?.currentQuestion?.questionId]);

  useEffect(() => {
    setAnswer('');
    setConfidence(null);
  }, [session?.currentQuestion?.questionId]);

  const sessionIsActive =
    stage === 'recall' && session !== null && session.status !== 'complete';

  const closeReview = useCallback(async () => {
    const currentApi = getDesktopApi();
    if (sessionIsActive && currentApi && session) {
      setBusy(true);
      try {
        await currentApi.review.pause(session.sessionId);
      } catch {
        // 关闭界面不能因暂停写入失败而锁住用户；后端已逐题持久化。
      } finally {
        setBusy(false);
      }
    }
    onClosedBookChange(false);
    onClose();
  }, [onClose, onClosedBookChange, session, sessionIsActive]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      void closeReview();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [closeReview, open]);

  const runSessionAction = useCallback(
    async (action: () => Promise<ReviewSessionView>) => {
      setBusy(true);
      setError('');
      try {
        const nextSession = await action();
        setSession(nextSession);
        if (nextSession.status === 'complete') {
          await loadOverview();
        }
        return nextSession;
      } catch (actionError) {
        setError(toMessage(actionError));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [loadOverview],
  );

  const startRecall = async () => {
    const currentApi = getDesktopApi();
    if (!currentApi) return;
    setBusy(true);
    setError('');

    try {
      const saved = await onBeforeStart();
      if (!saved) throw new Error('笔记尚未安全保存，请先导出备份后再开始复习。');
      onClosedBookChange(true);
      const nextSession = await currentApi.review.startRecall(
        note.id,
        questionCount,
        summaryUnavailable,
      );
      setSession(nextSession);
      setStage('recall');
    } catch (startError) {
      onClosedBookChange(false);
      setError(toMessage(startError, '无法开始本次复习。'));
    } finally {
      setBusy(false);
    }
  };

  const resumeSession = async (sessionId: string) => {
    const currentApi = getDesktopApi();
    if (!currentApi) return;
    onClosedBookChange(true);
    const resumed = await runSessionAction(() => currentApi.review.resume(sessionId));
    if (resumed) setStage('recall');
    else onClosedBookChange(false);
  };

  const startDueReview = async (cardId: string) => {
    const currentApi = getDesktopApi();
    if (!currentApi) return;
    onClosedBookChange(true);
    const started = await runSessionAction(() => currentApi.review.startDueReview(cardId));
    if (started) setStage('recall');
    else onClosedBookChange(false);
  };

  const submitAnswer = async () => {
    const currentApi = getDesktopApi();
    if (!currentApi || !session || !confidence) return;
    const submittedAnswer = answer.trim() || '我想不起来';
    await runSessionAction(() =>
      currentApi.review.submitInitialAnswer(session.sessionId, submittedAnswer, confidence),
    );
  };

  const revealHint = async (level: 1 | 2 | 3) => {
    const currentApi = getDesktopApi();
    if (!currentApi || !session) return;
    await runSessionAction(() => currentApi.review.revealHint(session.sessionId, level));
  };

  const evaluateAnswer = async () => {
    const currentApi = getDesktopApi();
    if (!currentApi || !session) return;
    await runSessionAction(() => currentApi.review.evaluateAnswer(session.sessionId));
  };

  const nextQuestion = async () => {
    const currentApi = getDesktopApi();
    if (!currentApi || !session) return;
    await runSessionAction(() => currentApi.review.nextQuestion(session.sessionId));
  };

  const evaluateFeynman = async () => {
    const currentApi = getDesktopApi();
    if (!currentApi || !feynmanConfidence || !feynmanConcept.trim() || !feynmanExplanation.trim()) {
      return;
    }

    setBusy(true);
    setError('');
    try {
      const feedback = await currentApi.review.evaluateFeynman(
        note.id,
        feynmanConcept.trim(),
        feynmanExplanation.trim(),
        feynmanConfidence,
        feynmanRound,
      );
      setFeynmanFeedback(feedback);
    } catch (feynmanError) {
      setError(toMessage(feynmanError, '费曼讲解评估失败。'));
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = async () => {
    const currentApi = getDesktopApi();
    if (!currentApi) return;
    setBusy(true);
    setError('');
    try {
      await currentApi.ai.saveSettings(settingsDraft);
      if (credential.trim()) {
        const credentialResult = await currentApi.ai.setCloudCredential(credential.trim());
        if (!credentialResult.ok) throw new Error(credentialResult.error ?? '密钥保存失败。');
        setCredential('');
      }
      const nextSettings = await currentApi.ai.getSettings();
      setSettings(nextSettings);
      setSettingsDraft(nextSettings);
      setStage('home');
    } catch (settingsError) {
      setError(toMessage(settingsError, 'AI 设置保存失败。'));
    } finally {
      setBusy(false);
    }
  };

  const deleteCredential = async () => {
    const currentApi = getDesktopApi();
    if (!currentApi) return;
    setBusy(true);
    setError('');
    try {
      const result = await currentApi.ai.deleteCloudCredential();
      if (!result.ok) throw new Error(result.error ?? '密钥移除失败。');
      const nextSettings = await currentApi.ai.getSettings();
      setSettings(nextSettings);
      setSettingsDraft(nextSettings);
      setCredential('');
    } catch (credentialError) {
      setError(toMessage(credentialError));
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async () => {
    const currentApi = getDesktopApi();
    if (!currentApi) return;
    setBusy(true);
    setError('');
    try {
      await currentApi.ai.saveSettings(settingsDraft);
      if (credential.trim()) {
        const savedCredential = await currentApi.ai.setCloudCredential(credential.trim());
        if (!savedCredential.ok) throw new Error(savedCredential.error ?? '密钥保存失败。');
        setCredential('');
      }
      const result = await currentApi.ai.testConnection();
      if (!result.ok) throw new Error(result.error ?? '连接测试失败。');
      setError(`连接成功：${result.model}`);
    } catch (connectionError) {
      setError(toMessage(connectionError, '连接测试失败。'));
    } finally {
      setBusy(false);
    }
  };

  const currentQuestion = session?.currentQuestion ?? null;
  const hasSubmittedAnswer = currentQuestion?.initialAnswer !== null && currentQuestion?.initialAnswer !== undefined;
  const noteHasStudyMaterial = Boolean(note.notes.trim() || note.cues.trim());
  const providerLabel = settings.provider === 'ollama' ? '本机 Ollama' : '云端模型';
  const activeModel =
    settings.provider === 'ollama' ? settings.ollamaModel : settings.cloudModel;

  const headerCopy = useMemo(() => {
    if (stage === 'privacy') return ['发送前确认', '只使用完成本次训练所需的当前笔记片段'];
    if (stage === 'summary') return ['先用自己的话总结', '开始后原笔记将完全隐藏'];
    if (stage === 'recall') return ['闭卷回忆', '先回答，再查看提示与依据'];
    if (stage === 'feynman') return ['费曼讲解', 'AI 只指出遗漏、模糊和可能错误'];
    if (stage === 'settings') return ['AI 设置', '本地模型或由你控制密钥的云端模型'];
    return ['内化复习', '主动回忆 · 自我解释 · 间隔复习'];
  }, [stage]);

  if (!open) return null;

  return (
    <div className="review-overlay" data-testid="review-panel" role="presentation">
      <div
        className="review-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-panel-title"
      >
        <header className="review-panel-header">
          <div>
            <span className="coach-kicker">学习教练</span>
            <h2 id="review-panel-title" data-review-focus tabIndex={-1}>{headerCopy[0]}</h2>
            <p>{headerCopy[1]}</p>
          </div>
          <button
            className="review-close-button"
            data-testid="review-close"
            type="button"
            aria-label={sessionIsActive ? '暂停并关闭复习' : '关闭复习'}
            disabled={busy}
            onClick={() => void closeReview()}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        {error ? (
          <div className={error.startsWith('连接成功') ? 'review-notice is-success' : 'review-notice is-error'} role="status">
            {error}
          </div>
        ) : null}

        <div className="review-panel-body">
          {!api ? (
            <section className="review-unavailable" data-testid="review-home">
              <div className="review-empty-icon" aria-hidden="true">◎</div>
              <h3>学习教练在桌面客户端中运行</h3>
              <p>
                浏览器开发模式继续支持笔记编辑、导入导出和打印；AI 复习需要桌面端的安全存储与本地数据库。
              </p>
            </section>
          ) : stage === 'home' ? (
            <section className="review-home" data-testid="review-home">
              <div className="coach-intro-card">
                <div>
                  <span className="coach-pill">当前范围</span>
                  <h3>{note.title.trim() || '未命名笔记'}</h3>
                  <p>AI 不代写笔记，只负责出题、追问，并依据你的原笔记指出遗漏。</p>
                </div>
                <div className="coach-model-state">
                  <span>{providerLabel}</span>
                  <strong>{activeModel || '尚未设置模型'}</strong>
                </div>
              </div>

              {overview?.resumableSession ? (
                <button
                  className="resume-session-card"
                  type="button"
                  disabled={busy}
                  onClick={() => void resumeSession(overview.resumableSession!.sessionId)}
                >
                  <span>继续上次复习</span>
                  <strong>
                    已完成 {overview.resumableSession.completedCount}/{overview.resumableSession.total} 题
                  </strong>
                </button>
              ) : null}

              <div className="review-primary-actions">
                <button
                  className="review-primary-button"
                  data-testid="review-prepare-button"
                  type="button"
                  disabled={busy || !noteHasStudyMaterial}
                  onClick={() => setStage('privacy')}
                >
                  <span>开始回忆模式</span>
                  <small>3～5 题 · 先答后看</small>
                </button>
                <button
                  className="review-secondary-card"
                  data-testid="feynman-tab"
                  type="button"
                  disabled={busy || !noteHasStudyMaterial}
                  onClick={() => {
                    setFeynmanFeedback(null);
                    setFeynmanExplanation('');
                    setFeynmanConfidence(null);
                    setFeynmanRound(1);
                    setStage('feynman');
                  }}
                >
                  <span>费曼讲解</span>
                  <small>先讲给 AI 听，再接受追问</small>
                </button>
              </div>
              {!noteHasStudyMaterial ? (
                <p className="inline-guidance">请先在“课堂笔记”或“线索与问题”中记录可核验的内容，再开始训练。</p>
              ) : null}

              <section className="review-queue-section" data-testid="review-queue-panel">
                <div className="review-section-title">
                  <div>
                    <h3>间隔复习队列</h3>
                    <p>答错、依赖提示和高信心误答会更早回来。</p>
                  </div>
                  <span className="due-count-badge">{overview?.dueCount ?? dueCount} 项到期</span>
                </div>
                {overview?.cards.length ? (
                  <ul className="review-card-list">
                    {overview.cards.map((card) => (
                      <li key={card.cardId}>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void startDueReview(card.cardId)}
                        >
                          <span>
                            <strong>{card.conceptLabel}</strong>
                            <small>{card.noteTitle}</small>
                          </span>
                          <span className={card.stale ? 'review-card-state is-stale' : 'review-card-state'}>
                            {card.stale ? '笔记已更新' : formatDueDate(card.dueDate)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="review-queue-empty">还没有到期项目。完成一次回忆训练后会自动安排复习。</p>
                )}
              </section>

              <section className="learning-metrics" aria-label="学习效果指标">
                <h3>真正衡量内化的指标</h3>
                <dl>
                  <div><dt>已尝试</dt><dd>{overview?.metrics.attemptedCount ?? 0} 题</dd></div>
                  <div><dt>延迟回忆</dt><dd>{percent(overview?.metrics.delayedRecallAccuracy ?? null)}</dd></div>
                  <div><dt>错题修正</dt><dd>{percent(overview?.metrics.correctionRate ?? null)}</dd></div>
                  <div><dt>信心校准</dt><dd>{percent(overview?.metrics.confidenceCalibration ?? null)}</dd></div>
                  <div><dt>迁移应用</dt><dd>{percent(overview?.metrics.transferAccuracy ?? null)}</dd></div>
                </dl>
              </section>

              <button
                className="settings-link-button"
                data-testid="ai-settings-button"
                type="button"
                onClick={() => setStage('settings')}
              >
                AI 与隐私设置
              </button>
            </section>
          ) : stage === 'privacy' ? (
            <section className="privacy-preflight">
              <button className="review-back-button" type="button" onClick={() => setStage('home')}>返回</button>
              <div className="privacy-grid">
                <article>
                  <span className="privacy-icon is-sent" aria-hidden="true">↗</span>
                  <h3>本次会使用</h3>
                  <ul>
                    <li>仅当前这篇笔记的课堂笔记、线索与总结</li>
                    <li>你在本次训练中主动提交的回答</li>
                    <li>生成反馈所需的最小上下文片段</li>
                  </ul>
                </article>
                <article>
                  <span className="privacy-icon is-private" aria-hidden="true">✓</span>
                  <h3>不会发生</h3>
                  <ul>
                    <li>不会自动上传整本笔记库</li>
                    <li>不会把模型输出写回笔记正文</li>
                    <li>不会在提交初答前显示提示或答案依据</li>
                  </ul>
                </article>
              </div>
              <div className="privacy-destination">
                <span>处理位置</span>
                <strong>{providerLabel} · {activeModel || '未设置模型'}</strong>
                <p>
                  {settings.provider === 'ollama'
                    ? '请求发送到你设置的本机 Ollama 地址。'
                    : '云端密钥只由 Electron 主进程从系统钥匙串读取。'}
                </p>
              </div>
              <label className="consent-check">
                <input
                  type="checkbox"
                  checked={privacyAccepted}
                  onChange={(event) => setPrivacyAccepted(event.target.checked)}
                />
                <span>我确认只用当前笔记开始本次复习</span>
              </label>
              <div className="review-footer-actions">
                <button className="secondary-button" type="button" onClick={() => setStage('settings')}>检查 AI 设置</button>
                <button
                  className="review-primary-button is-compact"
                  type="button"
                  disabled={!privacyAccepted}
                  onClick={() => setStage('summary')}
                >
                  继续：先写总结
                </button>
              </div>
            </section>
          ) : stage === 'summary' ? (
            <section className="review-summary-step">
              <button className="review-back-button" type="button" onClick={() => setStage('privacy')}>返回</button>
              <div className="summary-workspace">
                <article className="source-preview">
                  <span className="coach-pill">原笔记仍可见</span>
                  <h3>先理解，再合上笔记</h3>
                  <div className="source-preview-content">
                    <h4>课堂笔记</h4>
                    <p>{note.notes.trim() || '暂无课堂笔记内容'}</p>
                    {note.cues.trim() ? <><h4>线索与问题</h4><p>{note.cues}</p></> : null}
                  </div>
                </article>
                <label className="summary-composer">
                  <span>用自己的话写下你现在的理解</span>
                  <small>不要求完美；AI 稍后只指出遗漏和误解，不会替你重写。</small>
                  <textarea
                    data-testid="review-summary-input"
                    value={summary}
                    disabled={summaryUnavailable}
                    placeholder="这篇笔记最重要的概念是什么？它们为什么成立，彼此有什么联系？"
                    onChange={(event) => onSummaryChange(event.target.value)}
                  />
                </label>
              </div>
              <label className="consent-check is-muted">
                <input
                  type="checkbox"
                  checked={summaryUnavailable}
                  onChange={(event) => setSummaryUnavailable(event.target.checked)}
                />
                <span>我现在总结不出来，把这次记录为回忆困难</span>
              </label>
              <div className="question-count-control">
                <label htmlFor="review-question-count">本次题数</label>
                <select
                  id="review-question-count"
                  value={questionCount}
                  onChange={(event) => setQuestionCount(Number(event.target.value))}
                >
                  <option value={3}>3 题</option>
                  <option value={4}>4 题</option>
                  <option value={5}>5 题</option>
                </select>
              </div>
              <div className="review-footer-actions">
                <span className="closed-book-note">开始后将隐藏原笔记，并冻结本次复习快照。</span>
                <button
                  className="review-primary-button is-compact"
                  data-testid="review-start-button"
                  type="button"
                  disabled={busy || (!summary.trim() && !summaryUnavailable)}
                  onClick={() => void startRecall()}
                >
                  {busy ? '正在准备题目…' : '隐藏笔记，开始回忆'}
                </button>
              </div>
            </section>
          ) : stage === 'recall' ? (
            <section className="recall-session">
              {session?.status === 'complete' || !currentQuestion ? (
                <div className="review-complete-state">
                  <div className="review-empty-icon" aria-hidden="true">✓</div>
                  <span className="coach-pill">本轮完成</span>
                  <h3>先让记忆休息一下</h3>
                  <p>薄弱概念已经进入间隔复习队列，下次会换一种问法或新情境再次测试。</p>
                  <div className="complete-actions">
                    <button
                      className="review-secondary-card"
                      data-testid="feynman-tab"
                      type="button"
                      onClick={() => {
                        onClosedBookChange(false);
                        setFeynmanRound(1);
                        setFeynmanFeedback(null);
                        setStage('feynman');
                      }}
                    >
                      再做一次费曼讲解
                    </button>
                    <button className="review-primary-button is-compact" type="button" onClick={() => void closeReview()}>
                      完成本次复习
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="question-progress" aria-label={`第 ${currentQuestion.position} 题，共 ${currentQuestion.total} 题`}>
                    <span>第 {currentQuestion.position} / {currentQuestion.total} 题</span>
                    <div><i style={{ width: `${(currentQuestion.position / currentQuestion.total) * 100}%` }} /></div>
                    <strong>{currentQuestion.kind === 'application' ? '情境应用' : '主动回忆'}</strong>
                  </div>
                  <article className="review-question-card" data-testid="review-question">
                    <span className="concept-label">{currentQuestion.conceptLabel}</span>
                    <h3 data-review-focus tabIndex={-1}>{currentQuestion.prompt}</h3>
                    {hasSubmittedAnswer ? (
                      <div className="submitted-answer">
                        <span>你的初次回答 · 已锁定</span>
                        <p>{currentQuestion.initialAnswer}</p>
                        <small>信心：{CONFIDENCE_OPTIONS.find((item) => item.value === currentQuestion.confidence)?.label ?? '未记录'}</small>
                      </div>
                    ) : (
                      <>
                        <label className="answer-composer">
                          <span className="visually-hidden">你的回答</span>
                          <textarea
                            data-testid="review-answer-input"
                            value={answer}
                            placeholder="不要翻看原文，写下你现在能独立回忆的内容……"
                            onChange={(event) => setAnswer(event.target.value)}
                          />
                        </label>
                        <button
                          className="cannot-recall-button"
                          data-testid="review-cannot-recall"
                          type="button"
                          onClick={() => setAnswer('我想不起来')}
                        >
                          我想不起来
                        </button>
                        <ConfidencePicker
                          idPrefix="recall-confidence"
                          value={confidence}
                          onChange={setConfidence}
                        />
                        <button
                          className="review-primary-button answer-submit"
                          data-testid="review-submit-answer"
                          type="button"
                          disabled={busy || !confidence || !answer.trim()}
                          onClick={() => void submitAnswer()}
                        >
                          提交初次回答
                        </button>
                      </>
                    )}
                  </article>

                  {hasSubmittedAnswer && !currentQuestion.feedback ? (
                    <section className="hint-controls" aria-label="分级提示">
                      <div className="review-section-title">
                        <div>
                          <h3>需要一点帮助吗？</h3>
                          <p>提示使用情况会影响复习排期，但不会覆盖你的初答。</p>
                        </div>
                      </div>
                      <div className="hint-buttons">
                        <button
                          data-testid="review-hint-1"
                          type="button"
                          disabled={busy || currentQuestion.hintLevel >= 1}
                          onClick={() => void revealHint(1)}
                        >
                          <strong>方向提示</strong><small>指出主题范围</small>
                        </button>
                        <button
                          data-testid="review-hint-2"
                          type="button"
                          disabled={busy || currentQuestion.hintLevel < 1 || currentQuestion.hintLevel >= 2}
                          onClick={() => void revealHint(2)}
                        >
                          <strong>关键词</strong><small>给出关系线索</small>
                        </button>
                        <button
                          data-testid="review-hint-3"
                          type="button"
                          disabled={busy || currentQuestion.hintLevel < 2 || currentQuestion.hintLevel >= 3}
                          onClick={() => void revealHint(3)}
                        >
                          <strong>查看依据</strong><small>标记为借助原文</small>
                        </button>
                      </div>
                      {currentQuestion.visibleHint ? (
                        <div className="visible-hint" role="status"><span>当前提示</span><p>{currentQuestion.visibleHint}</p></div>
                      ) : null}
                      {currentQuestion.visibleEvidence.length ? (
                        <div className="revealed-evidence" data-testid="review-evidence">
                          <div><span>来自你的笔记</span><small>仅显示与本题相关的原文片段</small></div>
                          <EvidenceQuotes evidence={currentQuestion.visibleEvidence} />
                        </div>
                      ) : null}
                      <button
                        className="review-primary-button is-compact evaluate-button"
                        data-testid="review-evaluate"
                        type="button"
                        disabled={busy}
                        onClick={() => void evaluateAnswer()}
                      >
                        {busy ? '正在对照笔记…' : '让 AI 对照笔记反馈'}
                      </button>
                    </section>
                  ) : null}

                  {currentQuestion.feedback ? (
                    <>
                      <AnswerFeedback feedback={currentQuestion.feedback} />
                      <button
                        className="review-primary-button next-question-button"
                        data-testid="review-next"
                        type="button"
                        disabled={busy}
                        onClick={() => void nextQuestion()}
                      >
                        {currentQuestion.position >= currentQuestion.total ? '完成并安排复习' : '下一题'}
                      </button>
                    </>
                  ) : null}
                </>
              )}
            </section>
          ) : stage === 'feynman' ? (
            <section className="feynman-session">
              <button className="review-back-button" type="button" onClick={() => setStage('home')}>返回</button>
              <div className="feynman-principle">
                <strong>规则很简单：</strong>
                <span>你先讲，AI 只指出遗漏、模糊、可能错误，并且每轮只追问一个问题。</span>
              </div>
              <label className="coach-field">
                <span>要讲解的概念</span>
                <input
                  data-testid="feynman-concept"
                  type="text"
                  value={feynmanConcept}
                  placeholder="例如：测试效应"
                  onChange={(event) => setFeynmanConcept(event.target.value)}
                />
              </label>
              <label className="coach-field">
                <span>{feynmanRound === 1 ? '像向第一次听说的人一样讲清楚' : '结合追问，再用自己的话讲一遍'}</span>
                <textarea
                  data-testid="feynman-input"
                  value={feynmanExplanation}
                  placeholder="这个概念的含义是……它之所以成立，是因为……"
                  onChange={(event) => setFeynmanExplanation(event.target.value)}
                />
              </label>
              <ConfidencePicker
                idPrefix="feynman-confidence"
                value={feynmanConfidence}
                onChange={setFeynmanConfidence}
              />
              {!feynmanFeedback ? (
                <button
                  className="review-primary-button is-compact"
                  data-testid="feynman-submit"
                  type="button"
                  disabled={busy || !feynmanConcept.trim() || !feynmanExplanation.trim() || !feynmanConfidence}
                  onClick={() => void evaluateFeynman()}
                >
                  {busy ? '正在检查讲解…' : '提交给学习教练'}
                </button>
              ) : (
                <>
                  <FeynmanFeedback feedback={feynmanFeedback} />
                  <div className="review-footer-actions">
                    {!feynmanFeedback.complete && feynmanRound < 2 ? (
                      <button
                        className="review-primary-button is-compact"
                        type="button"
                        onClick={() => {
                          setFeynmanRound((round) => round + 1);
                          setFeynmanExplanation('');
                          setFeynmanConfidence(null);
                          setFeynmanFeedback(null);
                        }}
                      >
                        根据追问再讲一遍
                      </button>
                    ) : (
                      <button className="review-primary-button is-compact" type="button" onClick={() => setStage('home')}>
                        完成讲解
                      </button>
                    )}
                  </div>
                </>
              )}
            </section>
          ) : (
            <section className="ai-settings" data-testid="ai-settings-dialog">
              <button className="review-back-button" type="button" onClick={() => setStage('home')}>返回</button>
              <div className="provider-options" role="radiogroup" aria-label="AI 运行方式">
                <button
                  className={settingsDraft.provider === 'ollama' ? 'is-selected' : ''}
                  data-testid="ai-provider-ollama"
                  type="button"
                  role="radio"
                  aria-checked={settingsDraft.provider === 'ollama'}
                  onClick={() => setSettingsDraft((current) => ({ ...current, provider: 'ollama' }))}
                >
                  <strong>本地模型</strong>
                  <span>Ollama · 笔记不离开本机</span>
                </button>
                <button
                  className={settingsDraft.provider === 'cloud' ? 'is-selected' : ''}
                  data-testid="ai-provider-cloud"
                  type="button"
                  role="radio"
                  aria-checked={settingsDraft.provider === 'cloud'}
                  onClick={() => setSettingsDraft((current) => ({ ...current, provider: 'cloud' }))}
                >
                  <strong>云端模型</strong>
                  <span>兼容 OpenAI API · 用户自备密钥</span>
                </button>
              </div>

              {settingsDraft.provider === 'ollama' ? (
                <div className="settings-fields">
                  <label className="coach-field">
                    <span>Ollama 地址</span>
                    <input
                      type="url"
                      value={settingsDraft.ollamaBaseUrl}
                      placeholder="http://127.0.0.1:11434"
                      onChange={(event) => setSettingsDraft((current) => ({ ...current, ollamaBaseUrl: event.target.value }))}
                    />
                  </label>
                  <label className="coach-field">
                    <span>模型</span>
                    <input
                      data-testid="ai-model"
                      type="text"
                      value={settingsDraft.ollamaModel}
                      placeholder="qwen3:8b"
                      onChange={(event) => setSettingsDraft((current) => ({ ...current, ollamaModel: event.target.value }))}
                    />
                  </label>
                </div>
              ) : (
                <div className="settings-fields">
                  <label className="coach-field">
                    <span>API 地址</span>
                    <input
                      type="url"
                      value={settingsDraft.cloudBaseUrl}
                      placeholder="https://api.openai.com/v1"
                      onChange={(event) => setSettingsDraft((current) => ({ ...current, cloudBaseUrl: event.target.value }))}
                    />
                  </label>
                  <label className="coach-field">
                    <span>模型</span>
                    <input
                      data-testid="ai-model"
                      type="text"
                      value={settingsDraft.cloudModel}
                      placeholder="gpt-5-mini"
                      onChange={(event) => setSettingsDraft((current) => ({ ...current, cloudModel: event.target.value }))}
                    />
                  </label>
                  <label className="coach-field">
                    <span>API 密钥</span>
                    <input
                      data-testid="ai-api-key"
                      type="password"
                      value={credential}
                      autoComplete="new-password"
                      placeholder={settings.cloudCredentialConfigured ? '已保存在系统钥匙串中' : '输入后将保存到系统钥匙串'}
                      onChange={(event) => setCredential(event.target.value)}
                    />
                  </label>
                  <div className="credential-state">
                    <span className={settings.cloudCredentialConfigured ? 'is-configured' : ''}>
                      {settings.cloudCredentialConfigured ? '密钥已安全配置' : '尚未配置密钥'}
                    </span>
                    {settings.cloudCredentialConfigured ? (
                      <button type="button" disabled={busy} onClick={() => void deleteCredential()}>移除密钥</button>
                    ) : null}
                  </div>
                  {!settings.secureStorageAvailable ? (
                    <p className="secure-storage-warning">当前系统安全存储不可用，云端密钥将无法保存；请优先使用 Ollama。</p>
                  ) : null}
                </div>
              )}

              <label className="consent-check is-muted">
                <input
                  type="checkbox"
                  checked={settingsDraft.supplementalKnowledge}
                  onChange={(event) => setSettingsDraft((current) => ({ ...current, supplementalKnowledge: event.target.checked }))}
                />
                <span>允许模型补充笔记之外的知识（将单独标记且不参与判分）</span>
              </label>
              <p className="settings-privacy-note">
                密钥不会进入渲染进程日志、笔记备份或模型提示词；AI 永远不能直接修改笔记正文。
              </p>
              <div className="review-footer-actions">
                <button className="secondary-button" type="button" disabled={busy} onClick={() => void testConnection()}>
                  测试连接
                </button>
                <button
                  className="review-primary-button is-compact"
                  data-testid="ai-settings-save"
                  type="button"
                  disabled={busy}
                  onClick={() => void saveSettings()}
                >
                  {busy ? '正在保存…' : '保存设置'}
                </button>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
