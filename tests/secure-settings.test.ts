import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => false),
    encryptStringAsync: vi.fn(),
    decryptStringAsync: vi.fn(),
  },
}));

import { safeStorage } from 'electron';

import {
  normalizeAiDraftConfiguration,
  normalizeAiSettings,
  SecureSettingsService,
} from '../electron/secure-settings.js';
import type { AiSettings } from '../src/types/desktop.js';

const temporaryDirectories: string[] = [];
const decryptedByCiphertext = new Map<string, string>();

async function temporaryDataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cornell-settings-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

beforeEach(() => {
  decryptedByCiphertext.clear();
  vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockReset();
  vi.mocked(safeStorage.encryptStringAsync).mockReset();
  vi.mocked(safeStorage.decryptStringAsync).mockReset();
  vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
  vi.mocked(safeStorage.encryptStringAsync).mockImplementation(async (secret) => {
    const ciphertext = `ciphertext-${decryptedByCiphertext.size + 1}`;
    decryptedByCiphertext.set(ciphertext, secret);
    return Buffer.from(ciphertext, 'utf8');
  });
  vi.mocked(safeStorage.decryptStringAsync).mockImplementation(async (encrypted) => ({
    result: decryptedByCiphertext.get(encrypted.toString('utf8')) ?? '',
    shouldReEncrypt: false,
  }));
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function settings(overrides: Partial<AiSettings> = {}): AiSettings {
  return {
    provider: 'cloud',
    cloudBaseUrl: 'https://api.openai.com/v1',
    cloudModel: 'gpt-test',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'qwen-test',
    supplementalKnowledge: false,
    ...overrides,
  };
}

describe('AI 服务地址规范化', () => {
  test('去除首尾空白和多余末尾斜杠', () => {
    expect(
      normalizeAiSettings(
        settings({
          cloudBaseUrl: '  https://API.OPENAI.COM/v1///  ',
          ollamaBaseUrl: ' http://localhost:11434/// ',
        }),
      ),
    ).toMatchObject({
      cloudBaseUrl: 'https://api.openai.com/v1',
      ollamaBaseUrl: 'http://localhost:11434',
    });
  });

  test.each([
    'http://api.example.com/v1',
    'ftp://api.example.com/v1',
  ])('云端地址必须使用 HTTPS：%s', (cloudBaseUrl) => {
    expect(() => normalizeAiSettings(settings({ cloudBaseUrl }))).toThrowError(
      expect.objectContaining({ code: 'INSECURE_CLOUD_URL' }),
    );
  });

  test.each([
    'http://192.168.1.8:11434',
    'http://0.0.0.0:11434',
    'https://ollama.example.com',
    'http://127.0.0.1.evil.example:11434',
  ])('Ollama 拒绝非回环主机：%s', (ollamaBaseUrl) => {
    expect(() => normalizeAiSettings(settings({ ollamaBaseUrl }))).toThrowError(
      expect.objectContaining({ code: 'OLLAMA_NOT_LOOPBACK' }),
    );
  });

  test.each([
    'http://localhost:11434',
    'https://localhost:11434/api/',
    'http://127.0.0.1:11434/',
    'http://[::1]:11434/',
  ])('Ollama 允许本机回环地址：%s', (ollamaBaseUrl) => {
    expect(normalizeAiSettings(settings({ ollamaBaseUrl })).ollamaBaseUrl).not.toMatch(
      /\/$/,
    );
  });

  test.each([
    'https://user:secret@example.com/v1',
    'https://example.com/v1?token=secret',
    'https://example.com/v1#fragment',
  ])('拒绝可能泄露凭据或改变请求语义的 URL：%s', (cloudBaseUrl) => {
    expect(() => normalizeAiSettings(settings({ cloudBaseUrl }))).toThrowError(
      expect.objectContaining({ code: 'INVALID_AI_URL' }),
    );
  });
});

describe('AI 草稿与密钥安全存储', () => {
  test('草稿会规范化地址和密钥，且拒绝同时替换与清除密钥', () => {
    expect(
      normalizeAiDraftConfiguration({
        settings: settings({
          cloudBaseUrl: ' https://API.DEEPSEEK.COM/v1/// ',
        }),
        cloudCredential: '  sk-draft  ',
      }),
    ).toMatchObject({
      settings: { cloudBaseUrl: 'https://api.deepseek.com/v1' },
      cloudCredential: 'sk-draft',
    });

    expect(() =>
      normalizeAiDraftConfiguration({
        settings: settings(),
        cloudCredential: 'sk-new',
        clearCloudCredential: true,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_AI_DRAFT' }));
  });

  test('密钥只对绑定的规范化 base URL 可用，且不会进入设置视图或磁盘明文', async () => {
    const directory = await temporaryDataDirectory();
    const service = new SecureSettingsService(directory);
    const secret = 'sk-private-never-persist-plaintext';

    const saved = await service.saveConfiguration({
      settings: settings({ cloudBaseUrl: 'https://api.openai.com/v1/' }),
      cloudCredential: `  ${secret}  `,
    });

    expect(saved).toMatchObject({
      ok: true,
      error: null,
      errorCode: null,
      settings: { cloudCredentialConfigured: true },
    });
    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(JSON.stringify(await service.getSettings())).not.toContain(secret);
    expect(await readFile(join(directory, 'ai-settings.json'), 'utf8')).not.toContain(
      secret,
    );

    expect(
      await service.getCloudCredentialForBaseUrl(
        ' https://API.OPENAI.COM/v1/// ',
        { allowReEncrypt: false },
      ),
    ).toBe(secret);
    vi.mocked(safeStorage.decryptStringAsync).mockClear();
    expect(
      await service.getCloudCredentialForBaseUrl('https://api.deepseek.com/v1'),
    ).toBeNull();
    expect(safeStorage.decryptStringAsync).not.toHaveBeenCalled();
    expect(
      await service.getCloudCredentialForBaseUrl('https://api.openai.com'),
    ).toBeNull();
    expect(safeStorage.decryptStringAsync).not.toHaveBeenCalled();
  });

  test('草稿读取禁用密钥轮换时不改写设置文件', async () => {
    const directory = await temporaryDataDirectory();
    const service = new SecureSettingsService(directory);
    const secret = 'sk-read-only-draft';
    await service.saveConfiguration({
      settings: settings(),
      cloudCredential: secret,
    });
    const filePath = join(directory, 'ai-settings.json');
    const before = await readFile(filePath, 'utf8');
    vi.mocked(safeStorage.decryptStringAsync).mockResolvedValue({
      result: secret,
      shouldReEncrypt: true,
    });

    await expect(
      service.getCloudCredentialForBaseUrl('https://api.openai.com/v1', {
        allowReEncrypt: false,
      }),
    ).resolves.toBe(secret);

    expect(safeStorage.encryptStringAsync).toHaveBeenCalledTimes(1);
    expect(await readFile(filePath, 'utf8')).toBe(before);
  });

  test('原子保存按同 URL 保留、显式替换、换 URL 失效和显式清除处理密钥', async () => {
    const directory = await temporaryDataDirectory();
    const service = new SecureSettingsService(directory);
    await service.saveConfiguration({
      settings: settings(),
      cloudCredential: 'sk-first',
    });

    const preserved = await service.saveConfiguration({
      settings: settings({ cloudModel: 'gpt-next' }),
    });
    expect(preserved.settings).toMatchObject({
      cloudModel: 'gpt-next',
      cloudCredentialConfigured: true,
    });
    await expect(service.getCloudCredential()).resolves.toBe('sk-first');

    const replaced = await service.saveConfiguration({
      settings: settings({ cloudModel: 'gpt-next' }),
      cloudCredential: 'sk-second',
    });
    expect(replaced.settings?.cloudCredentialConfigured).toBe(true);
    await expect(service.getCloudCredential()).resolves.toBe('sk-second');

    const invalidated = await service.saveConfiguration({
      settings: settings({
        cloudBaseUrl: 'https://api.deepseek.com/v1',
        cloudModel: 'deepseek-chat',
      }),
    });
    expect(invalidated.settings?.cloudCredentialConfigured).toBe(false);
    await expect(service.getCloudCredential()).resolves.toBeNull();

    await service.saveConfiguration({
      settings: settings({
        cloudBaseUrl: 'https://api.deepseek.com/v1',
        cloudModel: 'deepseek-chat',
      }),
      cloudCredential: 'sk-deepseek',
    });
    const cleared = await service.saveConfiguration({
      settings: settings({
        cloudBaseUrl: 'https://api.deepseek.com/v1',
        cloudModel: 'deepseek-chat',
      }),
      clearCloudCredential: true,
    });
    expect(cleared.settings?.cloudCredentialConfigured).toBe(false);
    await expect(service.getCloudCredential()).resolves.toBeNull();
  });

  test('新密钥无法安全加密时不修改原设置，且错误结果不回显密钥', async () => {
    const directory = await temporaryDataDirectory();
    const service = new SecureSettingsService(directory);
    const original = await service.getSettings();
    const secret = 'sk-must-not-leak';
    vi.mocked(safeStorage.encryptStringAsync).mockRejectedValue(
      new Error(`底层错误不应回显 ${secret}`),
    );

    const result = await service.saveConfiguration({
      settings: settings({
        cloudBaseUrl: 'https://api.deepseek.com/v1',
        cloudModel: 'deepseek-chat',
      }),
      cloudCredential: secret,
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'SAVE_FAILED',
      settings: null,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(await service.getSettings()).toEqual(original);
  });
});
