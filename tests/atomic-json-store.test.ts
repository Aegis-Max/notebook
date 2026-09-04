import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { AtomicJsonStore } from '../electron/atomic-json-store.js';

interface CounterData {
  count: number;
}

const temporaryDirectories: string[] = [];

async function temporaryDataPath(): Promise<{ directory: string; filePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'cornell-store-test-'));
  temporaryDirectories.push(directory);
  return { directory, filePath: join(directory, 'data.json') };
}

function parseCounter(candidate: unknown): CounterData {
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    !Number.isInteger((candidate as CounterData).count) ||
    (candidate as CounterData).count < 0
  ) {
    throw new TypeError('计数数据无效');
  }
  return { count: (candidate as CounterData).count };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('AtomicJsonStore', () => {
  test('串行化并发更新，原子落盘后不遗留临时文件', async () => {
    const { directory, filePath } = await temporaryDataPath();
    const store = new AtomicJsonStore(filePath, () => ({ count: 0 }), parseCounter);

    await Promise.all(
      Array.from({ length: 40 }, () =>
        store.update((draft) => {
          draft.count += 1;
        }),
      ),
    );

    expect(await store.read()).toEqual({ count: 40 });
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ count: 40 });
    expect(await readdir(directory)).toEqual(['data.json']);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  test('读取结果是隔离副本，外部修改不会污染已验证状态', async () => {
    const { filePath } = await temporaryDataPath();
    const store = new AtomicJsonStore(filePath, () => ({ count: 2 }), parseCounter);

    const first = await store.read();
    first.count = 999;

    expect(await store.read()).toEqual({ count: 2 });
  });

  test('损坏 JSON 使 update 失败且保留原文件字节', async () => {
    const { filePath } = await temporaryDataPath();
    const damaged = '{"count":';
    await writeFile(filePath, damaged, { encoding: 'utf8', mode: 0o600 });
    const store = new AtomicJsonStore(filePath, () => ({ count: 0 }), parseCounter);

    await expect(
      store.update((draft) => {
        draft.count += 1;
      }),
    ).rejects.toMatchObject({ code: 'DATA_INVALID' });

    expect(await readFile(filePath, 'utf8')).toBe(damaged);
  });

  test('变更未通过 parse 时不覆盖最后一份有效数据', async () => {
    const { filePath } = await temporaryDataPath();
    const store = new AtomicJsonStore(filePath, () => ({ count: 3 }), parseCounter);
    await store.replace({ count: 3 });
    const before = await readFile(filePath, 'utf8');

    await expect(
      store.update((draft) => {
        draft.count = -1;
      }),
    ).rejects.toThrow(/计数数据无效/);

    expect(await readFile(filePath, 'utf8')).toBe(before);
    expect(await store.read()).toEqual({ count: 3 });
  });
});
