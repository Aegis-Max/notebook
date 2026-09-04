import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';

import { DesktopError, isNodeError } from './errors.js';

const MAX_DATA_BYTES = 50 * 1024 * 1024;

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * 单进程串行、同目录临时文件 + rename 的 JSON 存储。
 * 所有读写都会经过 parse，调用者拿不到内部可变引用。
 */
export class AtomicJsonStore<T> {
  private state: T | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly createDefault: () => T,
    private readonly parse: (value: unknown) => T,
  ) {}

  read(): Promise<T> {
    return this.exclusive(async () => clone(await this.load()));
  }

  replace(value: T): Promise<T> {
    return this.exclusive(async () => {
      const validated = this.parse(clone(value));
      await this.writeAtomic(validated);
      this.state = validated;
      return clone(validated);
    });
  }

  update(mutator: (draft: T) => void | T): Promise<T> {
    return this.exclusive(async () => {
      const draft = clone(await this.load());
      const returned = mutator(draft);
      const validated = this.parse(returned === undefined ? draft : returned);
      await this.writeAtomic(validated);
      this.state = validated;
      return clone(validated);
    });
  }

  private exclusive<R>(operation: () => Promise<R>): Promise<R> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async load(): Promise<T> {
    if (this.state !== undefined) return this.state;

    let serialized: string;
    try {
      serialized = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        this.state = this.parse(this.createDefault());
        return this.state;
      }
      throw new DesktopError('DATA_READ_FAILED', '无法读取桌面版数据', {
        cause: error,
      });
    }

    if (Buffer.byteLength(serialized, 'utf8') > MAX_DATA_BYTES) {
      throw new DesktopError('DATA_TOO_LARGE', '桌面版数据文件过大，已拒绝读取');
    }

    try {
      this.state = this.parse(JSON.parse(serialized.replace(/^\uFEFF/, '')));
      return this.state;
    } catch (error) {
      throw new DesktopError(
        'DATA_INVALID',
        '桌面版数据文件已损坏，原文件未被覆盖',
        { cause: error },
      );
    }
  }

  private async writeAtomic(value: T): Promise<void> {
    const directory = dirname(this.filePath);
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_DATA_BYTES) {
      throw new DesktopError('DATA_TOO_LARGE', '数据过大，无法安全保存');
    }

    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = join(
      directory,
      `.${basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );

    let handle;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;

      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600).catch(() => undefined);

      // 尽量把目录项同步落盘；Windows 等平台不支持目录 fsync 时安全忽略。
      const directoryHandle = await open(directory, 'r').catch(() => null);
      if (directoryHandle) {
        await directoryHandle.sync().catch(() => undefined);
        await directoryHandle.close().catch(() => undefined);
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw new DesktopError('DATA_WRITE_FAILED', '无法安全保存桌面版数据', {
        cause: error,
      });
    }
  }
}

