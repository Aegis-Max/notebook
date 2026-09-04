import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NoteStoreError,
  SCHEMA_VERSION,
  STORAGE_KEY,
  createBackup,
  createNote,
  loadNotes,
  mergeNotes,
  normalizeNote,
  parseBackup,
  saveNotes,
  searchNotes,
  sortNotes,
  validateBackup,
  validateNote,
} from '../src/note-store.js';

class MemoryStorage {
  constructor() {
    this.values = new Map();
    this.writes = [];
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
    this.writes.push([key, String(value)]);
  }
}

function makeNote(overrides = {}) {
  return {
    id: 'note-a',
    title: '网络课程',
    date: '2026-09-03',
    cues: '关键问题',
    notes: '详细记录',
    summary: '课后总结',
    createdAt: '2026-09-03T01:00:00.000Z',
    updatedAt: '2026-09-03T02:00:00.000Z',
    ...overrides,
  };
}

test('公开常量锁定存储键和 schema 版本', () => {
  assert.equal(STORAGE_KEY, 'cornell-notes:v1');
  assert.equal(SCHEMA_VERSION, 1);
});

test('createNote 创建完整的普通对象并支持可测试的时钟和 ID', () => {
  const initial = { title: '  新笔记  ', notes: '第一行\r\n第二行' };
  const note = createNote(initial, {
    now: '2026-09-03T08:09:10.123Z',
    idFactory: () => 'fixed-id',
  });

  assert.deepEqual(note, {
    id: 'fixed-id',
    title: '新笔记',
    date: '2026-09-03',
    cues: '',
    notes: '第一行\n第二行',
    summary: '',
    createdAt: '2026-09-03T08:09:10.123Z',
    updatedAt: '2026-09-03T08:09:10.123Z',
  });
  assert.deepEqual(initial, { title: '  新笔记  ', notes: '第一行\r\n第二行' });
  assert.equal(Object.getPrototypeOf(note), Object.prototype);
});

test('createNote 尊重显式日期与时间字段', () => {
  const note = createNote(
    {
      id: 'manual',
      date: '2024-02-29',
      createdAt: '2026-09-03T09:00:00+08:00',
      updatedAt: '2026-09-03T10:00:00+08:00',
    },
    { now: '2026-01-01T00:00:00Z' },
  );

  assert.equal(note.date, '2024-02-29');
  assert.equal(note.createdAt, '2026-09-03T01:00:00.000Z');
  assert.equal(note.updatedAt, '2026-09-03T02:00:00.000Z');
});

test('createNote 拒绝无效时钟和无效初始值', () => {
  assert.throws(() => createNote(null), NoteStoreError);
  assert.throws(() => createNote({}, { now: 'not-a-date' }), /now/);
});

test('normalizeNote 规范化空白、换行和带偏移量时间戳', () => {
  const source = makeNote({
    id: '  n-1 ',
    title: '  标题  ',
    date: ' 2026-09-03 ',
    cues: 'a\rb\r\nc',
    createdAt: '2026-09-03T09:00:00+08:00',
    updatedAt: '2026-09-03T10:00:00+08:00',
  });

  assert.deepEqual(normalizeNote(source), {
    ...source,
    id: 'n-1',
    title: '标题',
    date: '2026-09-03',
    cues: 'a\nb\nc',
    createdAt: '2026-09-03T01:00:00.000Z',
    updatedAt: '2026-09-03T02:00:00.000Z',
  });
  assert.equal(source.id, '  n-1 ');
});

test('validateNote 返回规范化结果且不抛异常', () => {
  const valid = validateNote(makeNote());
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.errors, []);
  assert.deepEqual(valid.note, makeNote());

  const invalid = validateNote(makeNote({ notes: 42 }));
  assert.equal(invalid.valid, false);
  assert.equal(invalid.note, null);
  assert.match(invalid.errors[0], /notes/);
});

test('笔记验证拒绝空 ID、错误日期、错误时间及倒序时间', () => {
  assert.throws(() => normalizeNote(makeNote({ id: '  ' })), /id 不能为空/);
  assert.throws(() => normalizeNote(makeNote({ date: '2025-02-29' })), /YYYY-MM-DD/);
  assert.throws(
    () => normalizeNote(makeNote({ createdAt: '2026-09-03 01:00:00' })),
    /ISO 8601/,
  );
  assert.throws(
    () =>
      normalizeNote(
        makeNote({
          createdAt: '2026-09-03T03:00:00.000Z',
          updatedAt: '2026-09-03T02:00:00.000Z',
        }),
      ),
    /不能早于/,
  );
});

test('sortNotes 按更新时间、创建时间降序并保持输入与完全平手顺序', () => {
  const oldest = makeNote({
    id: 'oldest',
    updatedAt: '2026-09-03T01:00:00.000Z',
  });
  const tieFirst = makeNote({ id: 'tie-first' });
  const tieSecond = makeNote({ id: 'tie-second' });
  const newestCreated = makeNote({
    id: 'newest-created',
    createdAt: '2026-09-03T01:30:00.000Z',
  });
  const input = [oldest, tieFirst, tieSecond, newestCreated];

  const result = sortNotes(input);
  assert.deepEqual(
    result.map((note) => note.id),
    ['newest-created', 'tie-first', 'tie-second', 'oldest'],
  );
  assert.deepEqual(input, [oldest, tieFirst, tieSecond, newestCreated]);
  assert.notEqual(result, input);
});

test('searchNotes 搜索全部用户字段、忽略大小写并支持多个关键词', () => {
  const notes = [
    makeNote({ id: 'a', title: 'TCP Review', cues: '三次握手' }),
    makeNote({
      id: 'b',
      title: '数据库',
      notes: 'Index Scan',
      updatedAt: '2026-09-03T03:00:00.000Z',
    }),
    makeNote({ id: 'c', title: '其他', summary: 'TCP 已掌握' }),
  ];

  assert.deepEqual(
    searchNotes(notes, 'tcp').map((note) => note.id),
    ['a', 'c'],
  );
  assert.deepEqual(
    searchNotes(notes, '数据库 scan').map((note) => note.id),
    ['b'],
  );
  assert.deepEqual(
    searchNotes(notes, '2026-09-03 三次').map((note) => note.id),
    ['a'],
  );
  assert.deepEqual(
    searchNotes(notes, '  ').map((note) => note.id),
    ['b', 'a', 'c'],
  );
});

test('saveNotes 写入带版本的确定性数据，loadNotes 读回并排序', () => {
  const storage = new MemoryStorage();
  const older = makeNote({ id: 'older' });
  const newer = makeNote({
    id: 'newer',
    createdAt: '2026-09-03T03:00:00.000Z',
    updatedAt: '2026-09-03T03:00:00.000Z',
  });

  assert.deepEqual(saveNotes(storage, [older, newer]), { ok: true, error: null });
  assert.equal(storage.writes.length, 1);
  assert.equal(storage.writes[0][0], STORAGE_KEY);

  const saved = JSON.parse(storage.writes[0][1]);
  assert.equal(saved.schemaVersion, 1);
  assert.deepEqual(
    saved.notes.map((note) => note.id),
    ['newer', 'older'],
  );

  const loaded = loadNotes(storage);
  assert.equal(loaded.error, null);
  assert.deepEqual(loaded.notes, saved.notes);
});

test('loadNotes 在首次使用且没有已保存数据时返回空集合', () => {
  assert.deepEqual(loadNotes(new MemoryStorage()), { notes: [], error: null });
});

test('loadNotes 隔离损坏 JSON、错误 schema 和无效笔记', () => {
  for (const serialized of [
    '{broken',
    JSON.stringify({ schemaVersion: 99, notes: [] }),
    JSON.stringify({ schemaVersion: 1, notes: [makeNote({ id: '' })] }),
  ]) {
    const storage = new MemoryStorage();
    storage.values.set(STORAGE_KEY, serialized);
    const result = loadNotes(storage);

    assert.deepEqual(result.notes, []);
    assert.ok(result.error instanceof NoteStoreError);
  }
});

test('loadNotes 捕获 Storage 读取异常与不可用对象', () => {
  const thrown = new Error('blocked');
  const failed = loadNotes({
    getItem() {
      throw thrown;
    },
  });
  assert.deepEqual(failed.notes, []);
  assert.equal(failed.error.code, 'STORAGE_READ_FAILED');
  assert.equal(failed.error.cause, thrown);

  const unavailable = loadNotes({});
  assert.equal(unavailable.error.code, 'STORAGE_UNAVAILABLE');
});

test('默认 localStorage getter 抛错时读写接口都返回结构化失败', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new DOMException('访问被拒绝', 'SecurityError');
    },
  });

  try {
    const loaded = loadNotes();
    assert.deepEqual(loaded.notes, []);
    assert.equal(loaded.error.code, 'STORAGE_UNAVAILABLE');

    const saved = saveNotes([makeNote()]);
    assert.equal(saved.ok, false);
    assert.equal(saved.error.code, 'STORAGE_UNAVAILABLE');
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
    } else {
      delete globalThis.localStorage;
    }
  }
});

test('saveNotes 捕获写入异常，且无效数据不会触发写入', () => {
  const thrown = new Error('quota exceeded');
  const failed = saveNotes({
    setItem() {
      throw thrown;
    },
  }, [makeNote()]);
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'STORAGE_WRITE_FAILED');
  assert.equal(failed.error.cause, thrown);

  const storage = new MemoryStorage();
  const invalid = saveNotes(storage, [makeNote({ id: '' })]);
  assert.equal(invalid.ok, false);
  assert.equal(storage.writes.length, 0);
});

test('saveNotes(notes) 兼容使用默认存储的简写参数顺序', () => {
  const originalStorage = globalThis.localStorage;
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });

  try {
    assert.deepEqual(saveNotes([makeNote()]), { ok: true, error: null });
    assert.equal(storage.writes[0][0], STORAGE_KEY);
  } finally {
    if (originalStorage === undefined) {
      delete globalThis.localStorage;
    } else {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: originalStorage,
      });
    }
  }
});

test('重复 ID 会被存储、排序和合并入口拒绝', () => {
  const duplicate = [makeNote(), makeNote({ title: '重复' })];
  assert.equal(saveNotes(new MemoryStorage(), duplicate).ok, false);
  assert.throws(() => sortNotes(duplicate), /重复 ID/);
  assert.throws(() => mergeNotes(duplicate, []), /重复 ID/);
});

test('createBackup 生成可序列化、可验证、可再次解析的版本化对象', () => {
  const notes = [
    makeNote({ id: 'older' }),
    makeNote({
      id: 'newer',
      createdAt: '2026-09-03T03:00:00.000Z',
      updatedAt: '2026-09-03T03:00:00.000Z',
    }),
  ];
  const payload = createBackup(notes, '2026-09-03T12:00:00+08:00');
  const json = JSON.stringify(payload, null, 2);

  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.exportedAt, '2026-09-03T04:00:00.000Z');
  assert.deepEqual(
    payload.notes.map((note) => note.id),
    ['newer', 'older'],
  );
  assert.deepEqual(parseBackup(`\uFEFF${json}`), payload.notes);
});

test('createBackup 将无效导出时间转换为可识别的备份错误', () => {
  assert.throws(
    () => createBackup([makeNote()], new Date(Number.NaN)),
    (error) => error instanceof NoteStoreError && error.code === 'INVALID_BACKUP',
  );
});

test('validateBackup 提供无异常验证结果', () => {
  const valid = validateBackup({
    schemaVersion: 1,
    exportedAt: '2026-09-03T00:00:00.000Z',
    notes: [makeNote()],
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.notes.length, 1);

  const invalid = validateBackup({
    schemaVersion: 2,
    exportedAt: '2026-09-03T00:00:00.000Z',
    notes: [],
  });
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors[0], /版本/);
});

test('parseBackup 拒绝非字符串、损坏 JSON、错误结构和重复 ID', () => {
  assert.throws(() => parseBackup(null), /JSON 字符串/);
  assert.throws(() => parseBackup('{bad'), /有效的 JSON/);
  assert.throws(
    () => parseBackup(JSON.stringify({ schemaVersion: 99, exportedAt: '', notes: [] })),
    /版本/,
  );
  assert.throws(
    () =>
      parseBackup(
        JSON.stringify({
          schemaVersion: 1,
          exportedAt: '2026-09-03T00:00:00.000Z',
          notes: [makeNote(), makeNote()],
        }),
      ),
    /重复 ID/,
  );
});

test('mergeNotes 对同 ID 取较晚版本，时间相同保留本地版本', () => {
  const local = [
    makeNote({ id: 'local-only', title: '仅本地' }),
    makeNote({ id: 'import-wins', title: '本地旧版' }),
    makeNote({
      id: 'local-wins',
      title: '本地新版',
      updatedAt: '2026-09-03T05:00:00.000Z',
    }),
    makeNote({ id: 'tie', title: '平手保留本地' }),
  ];
  const imported = [
    makeNote({
      id: 'import-wins',
      title: '导入新版',
      updatedAt: '2026-09-03T04:00:00.000Z',
    }),
    makeNote({
      id: 'local-wins',
      title: '导入旧版',
      updatedAt: '2026-09-03T03:00:00.000Z',
    }),
    makeNote({ id: 'tie', title: '平手导入版' }),
    makeNote({
      id: 'import-only',
      title: '仅导入',
      updatedAt: '2026-09-03T06:00:00.000Z',
    }),
  ];

  const merged = mergeNotes(local, imported);
  assert.deepEqual(
    merged.map((note) => note.id),
    ['import-only', 'local-wins', 'import-wins', 'local-only', 'tie'],
  );
  assert.equal(merged.find((note) => note.id === 'import-wins').title, '导入新版');
  assert.equal(merged.find((note) => note.id === 'local-wins').title, '本地新版');
  assert.equal(merged.find((note) => note.id === 'tie').title, '平手保留本地');
  assert.equal(local[1].title, '本地旧版');
  assert.equal(imported[0].title, '导入新版');
});
