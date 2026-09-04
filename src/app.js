import {
  createBackup,
  createNote,
  loadNotes,
  mergeNotes,
  parseBackup,
  saveNotes,
  searchNotes,
  sortNotes,
} from './note-store.js';

const AUTOSAVE_DELAY = 500;
const mobileEditorMedia = window.matchMedia('(max-width: 720px)');

const elements = {
  newNote: document.querySelector('#new-note-button'),
  search: document.querySelector('#search-input'),
  noteList: document.querySelector('#note-list'),
  noteListHeading: document.querySelector('#note-list-heading'),
  title: document.querySelector('#note-title'),
  date: document.querySelector('#note-date'),
  dateDisplay: document.querySelector('#note-date-display'),
  cues: document.querySelector('#cues-input'),
  notes: document.querySelector('#notes-input'),
  summary: document.querySelector('#summary-input'),
  saveStatus: document.querySelector('#save-status'),
  saveStatusText: document.querySelector('#save-status-text'),
  editorFooterStatus: document.querySelector('#editor-footer-status'),
  exportButton: document.querySelector('#export-button'),
  importButton: document.querySelector('#import-button'),
  importFile: document.querySelector('#import-file'),
  printButton: document.querySelector('#print-button'),
  deleteButton: document.querySelector('#delete-note-button'),
  utilityToggle: document.querySelector('#utility-menu-toggle'),
  utilityMenu: document.querySelector('#utility-menu'),
  toast: document.querySelector('#toast'),
  deleteDialog: document.querySelector('#delete-dialog'),
  deleteNoteName: document.querySelector('#delete-note-name'),
  deleteConfirm: document.querySelector('#delete-confirm-button'),
  deleteCancel: document.querySelector('#delete-cancel-button'),
  mobileListToggle: document.querySelector('#mobile-list-toggle'),
  sidebar: document.querySelector('#sidebar'),
};

const requiredElementNames = [
  'newNote',
  'search',
  'noteList',
  'title',
  'date',
  'dateDisplay',
  'cues',
  'notes',
  'summary',
  'saveStatus',
  'saveStatusText',
  'exportButton',
  'importButton',
  'importFile',
  'printButton',
  'deleteButton',
  'toast',
  'deleteDialog',
  'deleteConfirm',
  'deleteCancel',
];

for (const name of requiredElementNames) {
  if (!elements[name]) {
    throw new Error(`缺少必要界面元素：${name}`);
  }
}

let notes = [];
let selectedNoteId = '';
let saveTimer = null;
let dirty = false;
let toastTimer = null;
let deleteTrigger = null;

const mobileEditorMinimums = new Map([
  [elements.notes, 357],
  [elements.cues, 111],
  [elements.summary, 79],
]);

function today() {
  const date = new Date();
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function currentNote() {
  return notes.find((note) => note.id === selectedNoteId) ?? null;
}

function formatDate(dateValue) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue ?? '')) return dateValue || '未设置日期';
  const [year, month, day] = dateValue.split('-').map(Number);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(year, month - 1, day));
}

function displayTitle(note) {
  return note?.title.trim() || '未命名笔记';
}

function resizeMobileEditor(editor) {
  if (!mobileEditorMedia.matches) {
    editor.style.removeProperty('height');
    return;
  }

  editor.style.height = 'auto';
  const minimumHeight = mobileEditorMinimums.get(editor) ?? 79;
  editor.style.height = `${Math.max(minimumHeight, editor.scrollHeight)}px`;
}

function resizeMobileEditors() {
  for (const editor of mobileEditorMinimums.keys()) resizeMobileEditor(editor);
}

function setSaveStatus(label, state = 'saved') {
  elements.saveStatusText.textContent = label;
  elements.saveStatus.dataset.state = state;
  if (elements.editorFooterStatus) {
    const footerText = elements.editorFooterStatus.querySelector('span');
    if (footerText) {
      footerText.textContent =
        state === 'saved'
          ? '已保存 · 自动保存已开启'
          : state === 'saving'
            ? '正在自动保存…'
            : '保存失败 · 请导出备份';
    }
    elements.editorFooterStatus.dataset.state = state;
  }
}

function showToast(message, tone = 'neutral') {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.dataset.tone = tone;
  elements.toast.hidden = false;
  requestAnimationFrame(() => elements.toast.classList.add('is-visible'));
  toastTimer = window.setTimeout(() => {
    elements.toast.classList.remove('is-visible');
    window.setTimeout(() => {
      elements.toast.hidden = true;
    }, 180);
  }, 3600);
}

function persistNow({ quiet = false } = {}) {
  clearTimeout(saveTimer);
  saveTimer = null;

  if (!dirty && quiet) return true;

  const result = saveNotes(notes);
  if (result.ok) {
    dirty = false;
    setSaveStatus('已保存', 'saved');
    return true;
  }

  setSaveStatus('保存失败', 'error');
  showToast('保存失败，请立即导出备份以免内容丢失。', 'error');
  return false;
}

function scheduleSave() {
  dirty = true;
  setSaveStatus('保存中…', 'saving');
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => persistNow(), AUTOSAVE_DELAY);
}

function updateCurrentNoteFromEditor() {
  const note = currentNote();
  if (!note) return;

  if (!elements.date.value) {
    elements.date.value = note.date || today();
    elements.dateDisplay.textContent = formatDate(elements.date.value);
    showToast('日期不能为空，已保留原日期。', 'error');
    return;
  }

  note.title = elements.title.value;
  note.date = elements.date.value;
  elements.dateDisplay.textContent = formatDate(note.date);
  note.cues = elements.cues.value;
  note.notes = elements.notes.value;
  note.summary = elements.summary.value;
  note.updatedAt = new Date().toISOString();
  scheduleSave();
  renderNoteList();
  document.title = `${displayTitle(note)} · 康奈尔笔记`;
}

function populateEditor(note) {
  elements.title.value = note.title;
  elements.date.value = note.date;
  elements.dateDisplay.textContent = formatDate(note.date);
  elements.cues.value = note.cues;
  elements.notes.value = note.notes;
  elements.summary.value = note.summary;
  document.title = `${displayTitle(note)} · 康奈尔笔记`;
  requestAnimationFrame(resizeMobileEditors);
}

function createNoteRow(note) {
  const item = document.createElement('li');
  item.className = 'note-list-entry';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'note-item';
  button.classList.toggle('is-active', note.id === selectedNoteId);
  button.dataset.noteId = note.id;
  button.dataset.testid = 'note-item';
  if (note.id === selectedNoteId) button.setAttribute('aria-current', 'page');
  button.setAttribute('aria-label', `${displayTitle(note)}，${formatDate(note.date)}`);

  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  const iconPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  iconPath.setAttribute('d', 'M7 3h7l5 5v13H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm7 0v5h5M9 13h6M9 17h6');
  iconPath.setAttribute('fill', 'none');
  iconPath.setAttribute('stroke', 'currentColor');
  iconPath.setAttribute('stroke-width', '1.55');
  iconPath.setAttribute('stroke-linecap', 'round');
  iconPath.setAttribute('stroke-linejoin', 'round');
  icon.append(iconPath);

  const copy = document.createElement('span');
  copy.className = 'note-item-copy';

  const title = document.createElement('strong');
  title.className = 'note-item-title';
  title.textContent = displayTitle(note);

  const date = document.createElement('time');
  date.className = 'note-item-date';
  date.dateTime = note.date;
  date.textContent = formatDate(note.date);

  copy.append(title, date);
  button.append(icon, copy);
  button.addEventListener('click', (event) => {
    selectNote(note.id, { restoreKeyboardFocus: event.detail === 0 });
  });
  item.append(button);
  return item;
}

function renderNoteList() {
  const visibleNotes = searchNotes(notes, elements.search.value);
  elements.noteList.replaceChildren();

  if (elements.noteListHeading) {
    elements.noteListHeading.textContent = elements.search.value.trim()
      ? `${visibleNotes.length} 个搜索结果`
      : '全部笔记';
  }

  if (visibleNotes.length === 0) {
    const emptyItem = document.createElement('li');
    emptyItem.className = 'note-list-empty';
    emptyItem.textContent = '没有找到匹配的笔记';
    elements.noteList.append(emptyItem);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const note of visibleNotes) fragment.append(createNoteRow(note));
  elements.noteList.append(fragment);
}

function selectNote(noteId, { restoreKeyboardFocus = false } = {}) {
  if (noteId === selectedNoteId) {
    closeMobileNoteList();
    if (restoreKeyboardFocus && mobileEditorMedia.matches) elements.title.focus();
    return;
  }

  persistNow({ quiet: true });
  const nextNote = notes.find((note) => note.id === noteId);
  if (!nextNote) return;

  selectedNoteId = noteId;
  populateEditor(nextNote);
  renderNoteList();
  closeMobileNoteList();

  if (restoreKeyboardFocus) {
    if (mobileEditorMedia.matches) {
      elements.title.focus();
    } else {
      const selectedButton = [...elements.noteList.querySelectorAll('[data-note-id]')]
        .find((button) => button.dataset.noteId === noteId);
      selectedButton?.focus();
    }
  }
}

function addNote() {
  persistNow({ quiet: true });
  const note = createNote({ date: today() });
  notes = sortNotes([note, ...notes]);
  selectedNoteId = note.id;
  dirty = true;
  populateEditor(note);
  renderNoteList();
  persistNow();
  closeMobileNoteList();
  elements.title.focus();
  elements.title.select();
}

function askToDeleteNote() {
  const note = currentNote();
  if (!note) return;

  persistNow({ quiet: true });
  deleteTrigger = mobileEditorMedia.matches ? elements.utilityToggle : document.activeElement;
  closeUtilityMenu();
  if (elements.deleteNoteName) elements.deleteNoteName.textContent = `“${displayTitle(note)}”`;
  elements.deleteDialog.showModal();
  elements.deleteCancel.focus();
}

function deleteSelectedNote() {
  const deletingId = selectedNoteId;
  const sortedBeforeDelete = sortNotes(notes);
  const deletingIndex = sortedBeforeDelete.findIndex((note) => note.id === deletingId);
  let nextNotes = sortedBeforeDelete.filter((note) => note.id !== deletingId);

  if (nextNotes.length === 0) nextNotes = [createNote({ date: today() })];
  const nextIndex = Math.min(Math.max(deletingIndex, 0), nextNotes.length - 1);
  const nextSelectedNoteId = nextNotes[nextIndex].id;
  const saveResult = saveNotes(nextNotes);

  if (!saveResult.ok) {
    setSaveStatus('保存失败', 'error');
    elements.deleteDialog.close();
    showToast('删除失败：本地存储不可用，原笔记已保留。', 'error');
    if (deleteTrigger instanceof HTMLElement) deleteTrigger.focus();
    return;
  }

  notes = sortNotes(nextNotes);
  selectedNoteId = nextSelectedNoteId;
  dirty = false;
  setSaveStatus('已保存', 'saved');
  elements.deleteDialog.close();
  populateEditor(currentNote());
  renderNoteList();
  showToast('笔记已删除');
  elements.title.focus();
}

function closeDeleteDialog() {
  elements.deleteDialog.close();
  if (deleteTrigger instanceof HTMLElement) deleteTrigger.focus();
}

function exportAllNotes() {
  persistNow({ quiet: true });
  try {
    const backup = createBackup(notes);
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = `cornell-notes-${today()}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 0);
    showToast(`已导出 ${notes.length} 篇笔记`);
  } catch (error) {
    showToast(error instanceof Error ? `导出失败：${error.message}` : '导出失败，请检查笔记数据。', 'error');
  } finally {
    closeUtilityMenu();
  }
}

async function importBackupFile(file) {
  if (!file) return;

  try {
    const importedNotes = parseBackup(await file.text());
    const beforeIds = new Set(notes.map((note) => note.id));
    const merged = mergeNotes(notes, importedNotes);
    const addedCount = merged.filter((note) => !beforeIds.has(note.id)).length;
    const saveResult = saveNotes(merged);
    if (!saveResult.ok) throw new Error('导入内容无法写入本地存储，原有笔记未改变。');

    notes = sortNotes(merged);
    dirty = false;
    setSaveStatus('已保存', 'saved');
    if (!notes.some((note) => note.id === selectedNoteId)) selectedNoteId = notes[0].id;

    populateEditor(currentNote());
    renderNoteList();
    showToast(`导入完成：新增 ${addedCount} 篇，共 ${notes.length} 篇`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : '备份文件无效，未修改现有笔记。', 'error');
  } finally {
    elements.importFile.value = '';
    closeUtilityMenu();
  }
}

function openImportPicker() {
  elements.importFile.click();
}

function printCurrentNote() {
  persistNow({ quiet: true });
  closeUtilityMenu();
  window.print();
}

function toggleUtilityMenu() {
  if (!elements.utilityToggle || !elements.utilityMenu) return;
  const isOpen = elements.utilityToggle.getAttribute('aria-expanded') === 'true';
  elements.utilityToggle.setAttribute('aria-expanded', String(!isOpen));
  elements.utilityMenu.classList.toggle('is-open', !isOpen);
  elements.utilityMenu.dataset.open = String(!isOpen);
}

function closeUtilityMenu() {
  if (!elements.utilityToggle || !elements.utilityMenu) return;
  const shouldRestoreFocus =
    mobileEditorMedia.matches && elements.utilityMenu.contains(document.activeElement);
  elements.utilityToggle.setAttribute('aria-expanded', 'false');
  elements.utilityMenu.classList.remove('is-open');
  elements.utilityMenu.dataset.open = 'false';
  if (shouldRestoreFocus) elements.utilityToggle.focus();
}

function toggleMobileNoteList() {
  if (!elements.mobileListToggle || !elements.sidebar) return;
  const isOpen = elements.mobileListToggle.getAttribute('aria-expanded') === 'true';
  elements.mobileListToggle.setAttribute('aria-expanded', String(!isOpen));
  elements.sidebar.classList.toggle('is-mobile-open', !isOpen);
}

function closeMobileNoteList() {
  if (!elements.mobileListToggle || !elements.sidebar) return;
  const shouldRestoreFocus =
    mobileEditorMedia.matches && elements.noteList.contains(document.activeElement);
  elements.mobileListToggle.setAttribute('aria-expanded', 'false');
  elements.sidebar.classList.remove('is-mobile-open');
  if (shouldRestoreFocus) elements.mobileListToggle.focus();
}

function bindEvents() {
  elements.newNote.addEventListener('click', addNote);
  elements.search.addEventListener('input', renderNoteList);

  for (const input of [elements.title, elements.date, elements.cues, elements.notes, elements.summary]) {
    input.addEventListener('input', () => {
      updateCurrentNoteFromEditor();
      if (input instanceof HTMLTextAreaElement) resizeMobileEditor(input);
    });
  }

  elements.exportButton.addEventListener('click', exportAllNotes);
  elements.importButton.addEventListener('click', openImportPicker);
  elements.importFile.addEventListener('change', () => importBackupFile(elements.importFile.files?.[0]));
  elements.printButton.addEventListener('click', printCurrentNote);
  elements.deleteButton.addEventListener('click', askToDeleteNote);
  elements.deleteConfirm.addEventListener('click', deleteSelectedNote);
  elements.deleteCancel.addEventListener('click', closeDeleteDialog);
  elements.deleteDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeDeleteDialog();
  });

  elements.utilityToggle?.addEventListener('click', toggleUtilityMenu);
  elements.mobileListToggle?.addEventListener('click', toggleMobileNoteList);

  document.addEventListener('click', (event) => {
    if (
      elements.utilityMenu &&
      elements.utilityToggle &&
      elements.utilityToggle.getAttribute('aria-expanded') === 'true' &&
      !elements.utilityMenu.contains(event.target) &&
      !elements.utilityToggle.contains(event.target)
    ) {
      closeUtilityMenu();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeUtilityMenu();
      closeMobileNoteList();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistNow({ quiet: true });
  });
  window.addEventListener('beforeunload', () => persistNow({ quiet: true }));
  window.addEventListener('resize', resizeMobileEditors);
  mobileEditorMedia.addEventListener?.('change', resizeMobileEditors);
}

function initialize() {
  const result = loadNotes();
  notes = result.notes;

  if (notes.length === 0) {
    notes = [createNote({ date: today() })];
    if (result.error) {
      dirty = false;
      setSaveStatus('保存失败', 'error');
    } else {
      dirty = true;
      persistNow();
    }
  } else {
    notes = sortNotes(notes);
    setSaveStatus('已保存', 'saved');
  }

  selectedNoteId = notes[0].id;
  populateEditor(notes[0]);
  renderNoteList();
  bindEvents();

  if (result.error) showToast('本地数据无法读取，已进入空白笔记。', 'error');
}

initialize();
