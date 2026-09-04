import { describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => false),
    encryptStringAsync: vi.fn(),
    decryptStringAsync: vi.fn(),
  },
}));

import { normalizeAiSettings } from '../electron/secure-settings.js';
import type { AiSettings } from '../src/types/desktop.js';

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
