import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { ReviewCoach } from './components/ReviewCoach.js';
import { createBuiltinExampleNote } from './domain/builtin-example.js';
import {
  createNote,
  searchNotes,
  sortNotes,
  type Note,
} from './domain/note-store.js';
import {
  isDesktopRuntime,
  rendererNotesApi,
} from './platform/renderer-platform.js';

const AUTOSAVE_DELAY = 500;
const PAPER_HOLES = Array.from({ length: 18 }, (_, index) => index);

type SaveState = 'saved' | 'saving' | 'error';
type EditableNoteField = 'title' | 'date' | 'cues' | 'notes' | 'summary';

interface ToastState {
  message: string;
  tone: 'neutral' | 'error';
  id: number;
}

function today(): string {
  const date = new Date();
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function formatDate(dateValue: string | undefined): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue ?? '')) return dateValue || '未设置日期';
  const [year, month, day] = dateValue!.split('-').map(Number);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(year, month - 1, day));
}

function displayTitle(note: Note | null | undefined): string {
  return note?.title.trim() || '未命名笔记';
}

function isMobileViewport(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 720px)').matches;
}

function focusAfterPaint(element: HTMLElement | null | undefined, select = false): void {
  window.requestAnimationFrame(() => {
    element?.focus();
    if (select && element instanceof HTMLInputElement) element.select();
  });
}

function NoteDocumentIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 3h7l5 5v13H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm7 0v5h5M9 13h6M9 17h6" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function App() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState('');
  const [query, setQuery] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [toast, setToast] = useState<ToastState | null>(null);
  const [utilityMenuOpen, setUtilityMenuOpen] = useState(false);
  const [mobileListOpen, setMobileListOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Note | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewEntry, setReviewEntry] = useState<'home' | 'settings'>('home');
  const [closedBook, setClosedBook] = useState(false);
  const [reviewDueCount, setReviewDueCount] = useState(0);

  const notesRef = useRef<Note[]>([]);
  const selectedIdRef = useRef('');
  const dirtyRef = useRef(false);
  const revisionRef = useRef(0);
  const latestSaveRef = useRef(0);
  const saveTimerRef = useRef<number | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const deleteTriggerRef = useRef<HTMLElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const notesInputRef = useRef<HTMLTextAreaElement>(null);
  const cuesInputRef = useRef<HTMLTextAreaElement>(null);
  const summaryInputRef = useRef<HTMLTextAreaElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const utilityToggleRef = useRef<HTMLButtonElement>(null);
  const utilityMenuRef = useRef<HTMLElement>(null);
  const noteListRef = useRef<HTMLUListElement>(null);
  const mobileListToggleRef = useRef<HTMLButtonElement>(null);
  const studyButtonRef = useRef<HTMLButtonElement>(null);
  const reviewTriggerRef = useRef<HTMLElement | null>(null);

  const commitNotes = useCallback((nextNotes: Note[]) => {
    notesRef.current = nextNotes;
    setNotes(nextNotes);
  }, []);

  const commitSelectedId = useCallback((noteId: string) => {
    selectedIdRef.current = noteId;
    setSelectedNoteId(noteId);
  }, []);

  const showToast = useCallback((message: string, tone: ToastState['tone'] = 'neutral') => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToast({ message, tone, id: Date.now() });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3600);
  }, []);

  const persistNow = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}) => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (!dirtyRef.current && quiet) return true;

    const requestId = latestSaveRef.current + 1;
    latestSaveRef.current = requestId;
    const capturedRevision = revisionRef.current;
    const result = await rendererNotesApi.save(notesRef.current);

    if (result.ok) {
      if (capturedRevision === revisionRef.current) {
        dirtyRef.current = false;
        if (latestSaveRef.current === requestId) setSaveState('saved');
      }
      return true;
    }

    if (latestSaveRef.current === requestId) {
      setSaveState('error');
      showToast('保存失败，请立即导出备份以免内容丢失。', 'error');
    }
    return false;
  }, [showToast]);

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true;
    revisionRef.current += 1;
    setSaveState('saving');
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void persistNow();
    }, AUTOSAVE_DELAY);
  }, [persistNow]);

  useEffect(() => {
    let cancelled = false;

    void rendererNotesApi.load().then(async (result) => {
      if (cancelled) return;
      let loadedNotes = result.notes;

      if (loadedNotes.length === 0) {
        loadedNotes = [
          result.isFirstRun === true
            ? createBuiltinExampleNote()
            : createNote({ date: today() }),
        ];
        if (result.error) {
          setSaveState('error');
        } else {
          const saved = await rendererNotesApi.save(loadedNotes);
          if (!saved.ok) setSaveState('error');
        }
      } else {
        loadedNotes = sortNotes(loadedNotes);
        setSaveState('saved');
      }

      if (cancelled) return;
      commitNotes(loadedNotes);
      commitSelectedId(loadedNotes[0].id);
      if (result.error) showToast('本地数据无法读取，已进入空白笔记。', 'error');
    }).catch(() => {
      if (cancelled) return;
      const blankNote = createNote({ date: today() });
      commitNotes([blankNote]);
      commitSelectedId(blankNote.id);
      setSaveState('error');
      showToast('本地数据无法读取，已进入空白笔记。', 'error');
    });

    return () => {
      cancelled = true;
    };
  }, [commitNotes, commitSelectedId, showToast]);

  useEffect(() => {
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') void persistNow({ quiet: true });
    };
    const flushBeforeUnload = () => {
      void persistNow({ quiet: true });
    };
    document.addEventListener('visibilitychange', flushWhenHidden);
    window.addEventListener('beforeunload', flushBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', flushWhenHidden);
      window.removeEventListener('beforeunload', flushBeforeUnload);
    };
  }, [persistNow]);

  useEffect(() => () => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
  }, []);

  const currentNote = useMemo(
    () => notes.find((note) => note.id === selectedNoteId) ?? notes[0] ?? null,
    [notes, selectedNoteId],
  );
  const deferredQuery = useDeferredValue(query);
  const visibleNotes = useMemo(
    () => searchNotes(notes, deferredQuery),
    [deferredQuery, notes],
  );

  useEffect(() => {
    document.title = `${displayTitle(currentNote)} · 康奈尔笔记`;
  }, [currentNote?.title]);

  const resizeMobileEditor = useCallback((editor: HTMLTextAreaElement | null, minimum: number) => {
    if (!editor) return;
    if (!isMobileViewport()) {
      editor.style.removeProperty('height');
      return;
    }
    editor.style.height = 'auto';
    editor.style.height = `${Math.max(minimum, editor.scrollHeight)}px`;
  }, []);

  const resizeMobileEditors = useCallback(() => {
    resizeMobileEditor(notesInputRef.current, 357);
    resizeMobileEditor(cuesInputRef.current, 111);
    resizeMobileEditor(summaryInputRef.current, 79);
  }, [resizeMobileEditor]);

  useEffect(() => {
    window.requestAnimationFrame(resizeMobileEditors);
  }, [currentNote?.notes, currentNote?.cues, currentNote?.summary, resizeMobileEditors]);

  useEffect(() => {
    window.addEventListener('resize', resizeMobileEditors);
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 720px)') : null;
    media?.addEventListener?.('change', resizeMobileEditors);
    return () => {
      window.removeEventListener('resize', resizeMobileEditors);
      media?.removeEventListener?.('change', resizeMobileEditors);
    };
  }, [resizeMobileEditors]);

  const updateCurrentNote = useCallback((field: EditableNoteField, value: string) => {
    const currentId = selectedIdRef.current;
    const existing = notesRef.current.find((note) => note.id === currentId);
    if (!existing) return;

    if (field === 'date' && value === '') {
      setNotes([...notesRef.current]);
      showToast('日期不能为空，已保留原日期。', 'error');
      return;
    }

    const updatedAt = new Date().toISOString();
    const nextNotes = notesRef.current.map((note) =>
      note.id === currentId ? { ...note, [field]: value, updatedAt } : note,
    );
    commitNotes(nextNotes);
    scheduleSave();
  }, [commitNotes, scheduleSave, showToast]);

  const closeUtilityMenu = useCallback((restoreFocus = false) => {
    setUtilityMenuOpen(false);
    if (restoreFocus) focusAfterPaint(utilityToggleRef.current);
  }, []);

  const closeMobileList = useCallback((restoreFocus = false) => {
    setMobileListOpen(false);
    if (restoreFocus) focusAfterPaint(mobileListToggleRef.current);
  }, []);

  useEffect(() => {
    const closeMenusFromOutside = (event: globalThis.MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        utilityMenuOpen
        && !utilityMenuRef.current?.contains(target)
        && !utilityToggleRef.current?.contains(target)
      ) {
        setUtilityMenuOpen(false);
      }
    };
    const closeMenusFromEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || reviewOpen || deleteDialogRef.current?.open) return;
      if (utilityMenuOpen) {
        const restore = isMobileViewport() && Boolean(utilityMenuRef.current?.contains(document.activeElement));
        closeUtilityMenu(restore);
      }
      if (mobileListOpen) {
        const restore = isMobileViewport() && Boolean(noteListRef.current?.contains(document.activeElement));
        closeMobileList(restore);
      }
    };
    document.addEventListener('click', closeMenusFromOutside);
    document.addEventListener('keydown', closeMenusFromEscape);
    return () => {
      document.removeEventListener('click', closeMenusFromOutside);
      document.removeEventListener('keydown', closeMenusFromEscape);
    };
  }, [closeMobileList, closeUtilityMenu, mobileListOpen, reviewOpen, utilityMenuOpen]);

  const selectNote = async (noteId: string, keyboardActivated: boolean) => {
    if (noteId === selectedIdRef.current) {
      closeMobileList();
      if (keyboardActivated && isMobileViewport()) focusAfterPaint(titleInputRef.current);
      return;
    }

    await persistNow({ quiet: true });
    if (!notesRef.current.some((note) => note.id === noteId)) return;
    commitSelectedId(noteId);
    closeMobileList();

    if (keyboardActivated) {
      if (isMobileViewport()) {
        focusAfterPaint(titleInputRef.current);
      } else {
        window.requestAnimationFrame(() => {
          const button = [...(noteListRef.current?.querySelectorAll<HTMLButtonElement>('[data-note-id]') ?? [])]
            .find((candidate) => candidate.dataset.noteId === noteId);
          button?.focus();
        });
      }
    }
  };

  const addNote = async () => {
    await persistNow({ quiet: true });
    const note = createNote({ date: today() });
    const nextNotes = sortNotes([note, ...notesRef.current]);
    commitNotes(nextNotes);
    commitSelectedId(note.id);
    dirtyRef.current = true;
    revisionRef.current += 1;
    setSaveState('saving');
    void persistNow();
    closeMobileList();
    focusAfterPaint(titleInputRef.current, true);
  };

  const askToDeleteNote = async () => {
    const note = notesRef.current.find((candidate) => candidate.id === selectedIdRef.current);
    if (!note) return;
    deleteTriggerRef.current = isMobileViewport()
      ? utilityToggleRef.current
      : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    await persistNow({ quiet: true });
    closeUtilityMenu();
    setDeleteTarget(note);
    deleteDialogRef.current?.showModal();
    focusAfterPaint(deleteCancelRef.current);
  };

  const closeDeleteDialog = () => {
    deleteDialogRef.current?.close();
    setDeleteTarget(null);
    focusAfterPaint(deleteTriggerRef.current);
  };

  const deleteSelectedNote = async () => {
    const deletingId = selectedIdRef.current;
    const sortedBeforeDelete = sortNotes(notesRef.current);
    const deletingIndex = sortedBeforeDelete.findIndex((note) => note.id === deletingId);
    let nextNotes = sortedBeforeDelete.filter((note) => note.id !== deletingId);
    if (nextNotes.length === 0) nextNotes = [createNote({ date: today() })];
    const nextIndex = Math.min(Math.max(deletingIndex, 0), nextNotes.length - 1);
    const nextSelectedId = nextNotes[nextIndex].id;
    const saveResult = await rendererNotesApi.save(nextNotes);

    if (!saveResult.ok) {
      setSaveState('error');
      deleteDialogRef.current?.close();
      setDeleteTarget(null);
      showToast('删除失败：本地存储不可用，原笔记已保留。', 'error');
      focusAfterPaint(deleteTriggerRef.current);
      return;
    }

    const sortedNextNotes = sortNotes(nextNotes);
    commitNotes(sortedNextNotes);
    commitSelectedId(nextSelectedId);
    dirtyRef.current = false;
    setSaveState('saved');
    deleteDialogRef.current?.close();
    setDeleteTarget(null);
    showToast('笔记已删除');
    focusAfterPaint(titleInputRef.current);
  };

  const applyImport = async (file?: File) => {
    const result = await rendererNotesApi.importBackup(notesRef.current, file);
    if (!result.ok) {
      showToast(result.error ?? '备份文件无效，未修改现有笔记。', 'error');
      if (importInputRef.current) importInputRef.current.value = '';
      closeUtilityMenu();
      return;
    }

    const nextNotes = sortNotes(result.notes);
    commitNotes(nextNotes);
    dirtyRef.current = false;
    setSaveState('saved');
    if (!nextNotes.some((note) => note.id === selectedIdRef.current)) {
      commitSelectedId(nextNotes[0].id);
    }
    showToast(`导入完成：新增 ${result.addedCount} 篇，共 ${result.totalCount} 篇`);
    if (importInputRef.current) importInputRef.current.value = '';
    closeUtilityMenu();
  };

  const openImport = () => {
    if (isDesktopRuntime()) {
      void persistNow({ quiet: true }).then(() => applyImport());
    } else {
      importInputRef.current?.click();
    }
  };

  const onBrowserImport = (event: ChangeEvent<HTMLInputElement>) => {
    void applyImport(event.target.files?.[0]);
  };

  const exportAllNotes = async () => {
    await persistNow({ quiet: true });
    const result = await rendererNotesApi.exportBackup(notesRef.current);
    if (result.ok) showToast(`已导出 ${notesRef.current.length} 篇笔记`);
    else showToast(result.error ? `导出失败：${result.error}` : '导出失败，请检查笔记数据。', 'error');
    closeUtilityMenu();
  };

  const printCurrentNote = async () => {
    await persistNow({ quiet: true });
    closeUtilityMenu();
    const result = await rendererNotesApi.print();
    if (!result.ok) showToast(result.error ?? '打印失败。', 'error');
  };

  const openReview = () => {
    reviewTriggerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : studyButtonRef.current;
    closeUtilityMenu();
    closeMobileList();
    setReviewEntry('home');
    setReviewOpen(true);
  };

  const openAiSettings = useCallback(() => {
    reviewTriggerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : utilityToggleRef.current;
    closeUtilityMenu();
    closeMobileList();
    setReviewEntry('settings');
    setReviewOpen(true);
  }, [closeMobileList, closeUtilityMenu]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    const openSettingsFromShortcut = (event: KeyboardEvent) => {
      if (
        reviewOpen
        || deleteDialogRef.current?.open
        || event.key !== ','
        || (!event.metaKey && !event.ctrlKey)
        || event.altKey
        || event.shiftKey
      ) {
        return;
      }
      event.preventDefault();
      openAiSettings();
    };
    window.addEventListener('keydown', openSettingsFromShortcut);
    return () => window.removeEventListener('keydown', openSettingsFromShortcut);
  }, [openAiSettings, reviewOpen]);

  const closeReview = () => {
    setReviewOpen(false);
    setClosedBook(false);
    focusAfterPaint(reviewTriggerRef.current);
  };

  const saveLabel = saveState === 'saved' ? '已保存' : saveState === 'saving' ? '保存中…' : '保存失败';
  const footerLabel = saveState === 'saved'
    ? '已保存 · 自动保存已开启'
    : saveState === 'saving'
      ? '正在自动保存…'
      : '保存失败 · 请导出备份';

  const noteListHeading = query.trim() ? `${visibleNotes.length} 个搜索结果` : '全部笔记';

  return (
    <>
      <div className="app-shell" id="app-shell" data-testid="app-shell">
        <header className="topbar" id="topbar" data-testid="topbar">
          <a className="brand" href="#editor" aria-label="康奈尔笔记首页，当前版本 1.0" data-testid="brand">
            <svg className="brand-icon" viewBox="0 0 32 32" aria-hidden="true">
              <path d="M3.5 6.7c0-1.5 1.2-2.7 2.7-2.7h5.3c2 0 3.6.7 4.5 2.1.9-1.4 2.5-2.1 4.5-2.1h5.3c1.5 0 2.7 1.2 2.7 2.7v18.1c0 1-.9 1.8-1.9 1.7l-5.9-.4c-1.6-.1-3.2.5-4.2 1.8l-.5.6-.5-.6c-1-1.3-2.6-1.9-4.2-1.8l-5.9.4c-1 .1-1.9-.7-1.9-1.7V6.7Z" fill="currentColor" />
              <path d="M16 6.2v20.9" fill="none" stroke="#15543f" strokeWidth="1.35" />
            </svg>
            <span>康奈尔笔记</span>
            <span className="app-version" id="app-version" data-testid="app-version" aria-hidden="true">v1.0</span>
          </a>

          <div className="save-status" id="save-status" data-testid="save-status" data-state={saveState} role="status" aria-live="polite">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="9.25" fill="currentColor" />
              <path d="m8 12.1 2.35 2.35L16.4 8.7" fill="none" stroke="#15543f" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span id="save-status-text">{saveLabel}</span>
          </div>

          <button
            className="icon-button mobile-menu-button"
            ref={utilityToggleRef}
            id="utility-menu-toggle"
            data-testid="utility-menu-toggle"
            type="button"
            aria-label={utilityMenuOpen ? '关闭工具菜单' : '打开工具菜单'}
            aria-controls="utility-menu"
            aria-expanded={utilityMenuOpen}
            onClick={(event) => {
              event.stopPropagation();
              setUtilityMenuOpen((open) => !open);
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="5" r="1.8" fill="currentColor" />
              <circle cx="12" cy="12" r="1.8" fill="currentColor" />
              <circle cx="12" cy="19" r="1.8" fill="currentColor" />
            </svg>
          </button>

          <nav
            className={`tools-menu${utilityMenuOpen ? ' is-open' : ''}`}
            ref={utilityMenuRef}
            id="utility-menu"
            data-testid="utility-menu"
            data-open={utilityMenuOpen}
            aria-label="笔记工具"
          >
            <button className="tool-button" id="import-button" data-testid="import-button" type="button" onClick={openImport}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 16v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <span>导入</span>
            </button>
            <button className="tool-button" id="export-button" data-testid="export-button" type="button" onClick={() => void exportAllNotes()}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4m0 0L8 8m4-4 4 4M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <span>导出</span>
            </button>
            <span className="tool-divider" aria-hidden="true" />
            <button className="tool-button" id="print-button" data-testid="print-button" type="button" onClick={() => void printCurrentNote()}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8V3h10v5M7 17H5a2 2 0 0 1-2-2v-4a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v4a2 2 0 0 1-2 2h-2m-10-4h10v8H7v-8Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <span>打印</span>
            </button>
            {isDesktopRuntime() ? (
              <button className="tool-button" data-testid="app-ai-settings-button" type="button" onClick={openAiSettings}>
                <span>AI 设置</span>
                <kbd aria-hidden="true">⌘,</kbd>
              </button>
            ) : null}
            <button className="tool-button delete-note-button" id="delete-note-button" data-testid="delete-note-button" type="button" title="删除当前笔记" onClick={() => void askToDeleteNote()}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <span>删除</span>
            </button>
          </nav>

          <input
            className="visually-hidden"
            ref={importInputRef}
            id="import-file"
            data-testid="import-file"
            type="file"
            accept="application/json,.json"
            tabIndex={-1}
            aria-label="选择要导入的康奈尔笔记 JSON 文件"
            onChange={onBrowserImport}
          />
        </header>

        <div
          className="workspace"
          aria-hidden={closedBook || undefined}
          // React 19 支持 inert；闭卷时同时从键盘与无障碍阅读顺序中移除原笔记。
          inert={closedBook || undefined}
        >
          <aside className={`sidebar${mobileListOpen ? ' is-mobile-open' : ''}`} id="sidebar" data-testid="sidebar" aria-label="笔记库">
            <button className="new-note-button" id="new-note-button" data-testid="new-note-button" type="button" onClick={() => void addNote()}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16M4 12h16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              <span>新建笔记</span>
            </button>

            <div className="search-control">
              <svg className="search-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.6" cy="10.6" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="m15.4 15.4 4.3 4.3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              <label className="visually-hidden" htmlFor="search-input">搜索笔记</label>
              <input id="search-input" data-testid="search-input" type="search" placeholder="搜索笔记" autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} />
              <button
                className="mobile-list-toggle"
                ref={mobileListToggleRef}
                id="mobile-list-toggle"
                data-testid="mobile-list-toggle"
                type="button"
                aria-label={mobileListOpen ? '收起笔记列表' : '展开笔记列表'}
                aria-controls="notes-index"
                aria-expanded={mobileListOpen}
                onClick={() => setMobileListOpen((open) => !open)}
              >
                <svg className="search-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9.5 5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            </div>

            <button className="review-queue-button" data-testid="review-queue" type="button" onClick={openReview}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h12v14H6zM9 9h6M9 13h4" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" /><path d="M16 3v4M8 3v4" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" /></svg>
              <span><strong>复习队列</strong><small>间隔复习与学习指标</small></span>
              {reviewDueCount > 0 ? <em>{reviewDueCount}</em> : null}
            </button>

            <div className="notes-index" id="notes-index">
              <h2 id="note-list-heading">{noteListHeading}</h2>
              <nav aria-label="全部笔记">
                <ul className="note-list" ref={noteListRef} id="note-list" data-testid="note-list">
                  {visibleNotes.length === 0 ? (
                    <li className="note-list-empty">没有找到匹配的笔记</li>
                  ) : visibleNotes.map((note) => (
                    <li className="note-list-entry" key={note.id}>
                      <button
                        className={`note-item${note.id === selectedNoteId ? ' is-active' : ''}`}
                        data-note-id={note.id}
                        data-testid="note-item"
                        type="button"
                        aria-current={note.id === selectedNoteId ? 'page' : undefined}
                        aria-label={`${displayTitle(note)}，${formatDate(note.date)}`}
                        onClick={(event: ReactMouseEvent<HTMLButtonElement>) => void selectNote(note.id, event.detail === 0)}
                      >
                        <NoteDocumentIcon />
                        <span className="note-item-copy">
                          <strong className="note-item-title">{displayTitle(note)}</strong>
                          <time className="note-item-date" dateTime={note.date}>{formatDate(note.date)}</time>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </nav>
            </div>
          </aside>

          <main className="editor" id="editor" data-testid="editor">
            <section className="editor-meta" aria-label="当前笔记信息">
              <label className="title-field" htmlFor="note-title">
                <span className="visually-hidden">笔记标题</span>
                <input
                  ref={titleInputRef}
                  id="note-title"
                  data-testid="note-title"
                  type="text"
                  value={currentNote?.title ?? ''}
                  placeholder="未命名笔记"
                  maxLength={120}
                  autoComplete="off"
                  onChange={(event) => updateCurrentNote('title', event.target.value)}
                />
              </label>
              <label className="date-field" htmlFor="note-date">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3v3m10-3v3M4 9h16M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" /></svg>
                <span className="visually-hidden">笔记日期</span>
                <span className="date-display" id="note-date-display" aria-hidden="true">{formatDate(currentNote?.date)}</span>
                <input id="note-date" data-testid="note-date" type="date" value={currentNote?.date ?? ''} aria-label="笔记日期" required onChange={(event) => updateCurrentNote('date', event.target.value)} />
              </label>
              <button
                className="review-launch-button"
                ref={studyButtonRef}
                data-testid="study-button"
                type="button"
                disabled={!currentNote}
                onClick={openReview}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5 12 3l8 2.5-8 2.6-8-2.6Zm2 3.2V15c2.8 2.3 9.2 2.3 12 0V8.7M20 6v7" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" /></svg>
                <span><strong>内化复习</strong><small>学习教练</small></span>
              </button>
            </section>

            <article className="cornell-paper" id="cornell-paper" data-testid="cornell-paper" aria-label="当前康奈尔笔记">
              <div className="paper-holes" aria-hidden="true">
                {PAPER_HOLES.map((hole) => <span key={hole} />)}
              </div>
              <div className="cornell-grid">
                <section className="note-section notes-section" aria-labelledby="notes-heading">
                  <header className="section-heading">
                    <span className="section-icon notes-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m4 20 4.6-1.1L19.3 8.2a2.2 2.2 0 0 0 0-3.1l-.4-.4a2.2 2.2 0 0 0-3.1 0L5.1 15.4 4 20Zm10.1-13.6 3.5 3.5M5.3 15.2l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
                    <h2 id="notes-heading">课堂笔记</h2>
                  </header>
                  <textarea className="section-editor notes-editor" ref={notesInputRef} id="notes-input" data-testid="notes-input" aria-labelledby="notes-heading" spellCheck="true" placeholder="记录课堂内容、重要概念和例子……" value={currentNote?.notes ?? ''} onChange={(event) => updateCurrentNote('notes', event.target.value)} />
                </section>
                <section className="note-section cues-section" aria-labelledby="cues-heading">
                  <header className="section-heading">
                    <span className="section-icon cues-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="currentColor" /><path d="M9.8 9.1a2.35 2.35 0 1 1 3.7 1.92c-.95.65-1.5 1.12-1.5 2.48M12 17.2h.01" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" /></svg></span>
                    <h2 id="cues-heading">线索与问题</h2>
                  </header>
                  <textarea className="section-editor cues-editor" ref={cuesInputRef} id="cues-input" data-testid="cues-input" aria-labelledby="cues-heading" spellCheck="true" placeholder="写下关键词、提示和复习问题……" value={currentNote?.cues ?? ''} onChange={(event) => updateCurrentNote('cues', event.target.value)} />
                </section>
                <section className="note-section summary-section" aria-labelledby="summary-heading">
                  <header className="section-heading">
                    <span className="section-icon summary-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 6h12M8 12h12M8 18h12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><circle cx="4" cy="6" r="1.35" fill="currentColor" /><circle cx="4" cy="12" r="1.35" fill="currentColor" /><circle cx="4" cy="18" r="1.35" fill="currentColor" /></svg></span>
                    <h2 id="summary-heading">总结</h2>
                  </header>
                  <textarea className="section-editor summary-editor" ref={summaryInputRef} id="summary-input" data-testid="summary-input" aria-labelledby="summary-heading" spellCheck="true" placeholder="用几句话总结这篇笔记……" value={currentNote?.summary ?? ''} onChange={(event) => updateCurrentNote('summary', event.target.value)} />
                </section>
              </div>
            </article>

            <div className="editor-footer-status" id="editor-footer-status" data-testid="editor-footer-status" data-state={saveState} aria-hidden="true">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="currentColor" /><path d="m8 12.1 2.35 2.35L16.4 8.7" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <span>{footerLabel}</span>
            </div>
          </main>
        </div>
      </div>

      <dialog
        className="confirm-dialog"
        ref={deleteDialogRef}
        id="delete-dialog"
        data-testid="delete-dialog"
        aria-labelledby="delete-dialog-title"
        aria-describedby="delete-dialog-description"
        onCancel={(event) => {
          event.preventDefault();
          closeDeleteDialog();
        }}
      >
        <form method="dialog" onSubmit={(event) => event.preventDefault()}>
          <svg className="dialog-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <h2 id="delete-dialog-title">删除这篇笔记？</h2>
          <p id="delete-dialog-description"><span id="delete-note-name">“{displayTitle(deleteTarget)}”</span>将从当前设备移除，且无法撤销。</p>
          <div className="dialog-actions">
            <button className="secondary-button" ref={deleteCancelRef} id="delete-cancel-button" data-testid="delete-cancel-button" type="button" onClick={closeDeleteDialog}>取消</button>
            <button className="danger-button" id="delete-confirm-button" data-testid="delete-confirm-button" type="button" onClick={() => void deleteSelectedNote()}>删除</button>
          </div>
        </form>
      </dialog>

      <div className="toast-region" id="toast-region" data-testid="toast-region" aria-live="polite" aria-atomic="true">
        {toast ? <div className="toast is-visible" id="toast" data-testid="toast" data-tone={toast.tone} role="status" key={toast.id}>{toast.message}</div> : null}
      </div>

      {currentNote ? (
        <ReviewCoach
          open={reviewOpen}
          initialStage={reviewEntry}
          note={currentNote}
          summary={currentNote.summary}
          dueCount={reviewDueCount}
          onDueCountChange={setReviewDueCount}
          onSummaryChange={(value) => updateCurrentNote('summary', value)}
          onBeforeStart={() => persistNow()}
          onClosedBookChange={setClosedBook}
          onClose={closeReview}
        />
      ) : null}
    </>
  );
}
