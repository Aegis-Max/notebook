import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => false),
    encryptStringAsync: vi.fn(),
    decryptStringAsync: vi.fn(),
  },
}));

import { AiClient } from '../electron/ai-client.js';
import type { SecureSettingsService } from '../electron/secure-settings.js';
import type {
  AiDraftConfiguration,
  AiSettings,
  AiSettingsView,
} from '../src/types/desktop.js';

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

function draft(overrides: Partial<AiSettings> = {}, credential?: string): AiDraftConfiguration {
  return {
    settings: settings(overrides),
    ...(credential ? { cloudCredential: credential } : {}),
  };
}

function settingsService(options: {
  saved?: AiSettings;
  savedCredential?: string | null;
  credentialForBaseUrl?: (baseUrl: string) => string | null | Promise<string | null>;
} = {}) {
  const saved = options.saved ?? settings();
  const view: AiSettingsView = {
    ...saved,
    cloudCredentialConfigured: options.savedCredential !== null,
    secureStorageAvailable: true,
  };
  const getCloudCredentialForBaseUrl = vi.fn(
    async (baseUrl: unknown, _readOptions?: { allowReEncrypt?: boolean }) => {
      if (typeof baseUrl !== 'string') return null;
      if (options.credentialForBaseUrl) {
        return options.credentialForBaseUrl(baseUrl);
      }
      return baseUrl === saved.cloudBaseUrl
        ? (options.savedCredential ?? 'sk-saved')
        : null;
    },
  );
  const service = {
    getSettings: vi.fn(async () => view),
    getCloudCredential: vi.fn(async () => options.savedCredential ?? 'sk-saved'),
    getCloudCredentialForBaseUrl,
    saveSettings: vi.fn(),
    saveConfiguration: vi.fn(),
    setCloudCredential: vi.fn(),
    deleteCloudCredential: vi.fn(),
  };
  return {
    service,
    client: new AiClient(service as unknown as SecureSettingsService),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function response(status: number, body = ''): Response {
  return new Response(body, { status });
}

function fetchCall(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return { url, init };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.CORNELL_AI_MOCK;
});

describe('AiClient 草稿模型发现', () => {
  test.each([
    ['DeepSeek 根地址', 'https://api.deepseek.com', 'https://api.deepseek.com/models'],
    ['DeepSeek v1 地址', 'https://api.deepseek.com/v1/', 'https://api.deepseek.com/v1/models'],
    ['OpenAI v1 地址', 'https://api.openai.com/v1', 'https://api.openai.com/v1/models'],
  ])('%s 保留用户输入的版本路径且不重复拼接', async (_label, baseUrl, expectedUrl) => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [
          { id: 'z-model' },
          { id: ' a-model ' },
          { id: 'z-model' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { client, service } = settingsService();
    const secret = 'sk-temporary-discovery';

    const result = await client.discoverModels(
      draft({ cloudBaseUrl: baseUrl }, secret),
    );

    expect(result).toEqual({
      ok: true,
      error: null,
      errorCode: null,
      provider: 'cloud',
      models: [
        { id: 'a-model', label: 'a-model' },
        { id: 'z-model', label: 'z-model' },
      ],
    });
    const call = fetchCall(fetchMock);
    expect(call.url).toBe(expectedUrl);
    expect(call.init).toMatchObject({
      redirect: 'error',
      cache: 'no-store',
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(service.getCloudCredentialForBaseUrl).not.toHaveBeenCalled();
    expect(service.getSettings).not.toHaveBeenCalled();
    expect(service.saveConfiguration).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test('没有临时密钥时只请求当前 base URL 绑定的已存密钥，并禁用轮换写入', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ id: 'gpt-test' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const { client, service } = settingsService({
      saved: settings({ cloudBaseUrl: 'https://api.openai.com/v1' }),
      savedCredential: 'sk-bound',
    });

    await expect(client.discoverModels(draft())).resolves.toMatchObject({ ok: true });
    expect(service.getCloudCredentialForBaseUrl).toHaveBeenCalledWith(
      'https://api.openai.com/v1',
      { allowReEncrypt: false },
    );
    expect(fetchCall(fetchMock).init.headers).toEqual({
      Authorization: 'Bearer sk-bound',
    });
  });

  test('草稿地址没有匹配密钥时拒绝请求，绝不把旧地址密钥发给新服务', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { client, service } = settingsService({
      saved: settings({ cloudBaseUrl: 'https://api.openai.com/v1' }),
      savedCredential: 'sk-openai-only',
    });

    const result = await client.discoverModels(
      draft({ cloudBaseUrl: 'https://api.deepseek.com/v1' }),
    );

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'CREDENTIAL_REQUIRED',
      provider: 'cloud',
      models: [],
    });
    expect(service.getCloudCredentialForBaseUrl).toHaveBeenCalledWith(
      'https://api.deepseek.com/v1',
      { allowReEncrypt: false },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('sk-openai-only');
  });

  test('Ollama 发现使用回环地址 /api/tags 并接受 name 或 model 字段', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        models: [
          { name: 'qwen3:8b' },
          { model: 'deepseek-r1:7b' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { client, service } = settingsService();

    const result = await client.discoverModels(
      draft({
        provider: 'ollama',
        ollamaBaseUrl: 'http://localhost:11434/',
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      provider: 'ollama',
      models: [
        { id: 'deepseek-r1:7b', label: 'deepseek-r1:7b' },
        { id: 'qwen3:8b', label: 'qwen3:8b' },
      ],
    });
    expect(fetchCall(fetchMock).url).toBe('http://localhost:11434/api/tags');
    expect(service.getCloudCredentialForBaseUrl).not.toHaveBeenCalled();
  });
});

describe('AiClient 草稿连接测试', () => {
  test.each([
    ['DeepSeek 根地址', 'https://api.deepseek.com', 'https://api.deepseek.com/chat/completions'],
    ['DeepSeek v1 地址', 'https://api.deepseek.com/v1/', 'https://api.deepseek.com/v1/chat/completions'],
    ['OpenAI v1 地址', 'https://api.openai.com/v1', 'https://api.openai.com/v1/chat/completions'],
  ])('%s 使用目标模型做最小请求且测试过程不保存草稿', async (_label, baseUrl, expectedUrl) => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: 'OK' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { client, service } = settingsService();
    const secret = 'sk-temporary-test';

    const result = await client.testDraftConnection(
      draft(
        {
          cloudBaseUrl: baseUrl,
          cloudModel: 'deepseek-chat',
        },
        secret,
      ),
    );

    expect(result).toMatchObject({
      ok: true,
      error: null,
      errorCode: null,
      provider: 'cloud',
      model: 'deepseek-chat',
    });
    expect(result.latencyMs).toEqual(expect.any(Number));
    const call = fetchCall(fetchMock);
    expect(call.url).toBe(expectedUrl);
    expect(call.init.method).toBe('POST');
    expect(call.init.headers).toEqual({
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(call.init.body))).toEqual({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'Reply with OK.' }],
    });
    expect(String(call.init.body)).not.toContain('sourceBlocks');
    expect(service.getSettings).not.toHaveBeenCalled();
    expect(service.saveSettings).not.toHaveBeenCalled();
    expect(service.saveConfiguration).not.toHaveBeenCalled();
    expect(service.setCloudCredential).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test('clearCloudCredential 草稿不能回退使用已保存密钥', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { client, service } = settingsService({ savedCredential: 'sk-saved' });

    const result = await client.testDraftConnection({
      settings: settings(),
      clearCloudCredential: true,
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'CREDENTIAL_REQUIRED' });
    expect(service.getCloudCredentialForBaseUrl).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('AiClient 错误分类与脱敏', () => {
  test.each([
    [401, 'AUTHENTICATION_FAILED'],
    [403, 'ACCESS_DENIED'],
    [404, 'ENDPOINT_NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    [503, 'SERVICE_UNAVAILABLE'],
    [418, 'REQUEST_REJECTED'],
  ] as const)('模型发现将 HTTP %s 分类为 %s', async (status, errorCode) => {
    const secret = `sk-http-${status}`;
    const fetchMock = vi.fn(async () =>
      response(status, `服务端不可信错误正文：${secret}`),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { client } = settingsService();

    const result = await client.discoverModels(draft({}, secret));

    expect(result).toMatchObject({ ok: false, errorCode, models: [] });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test('连接接口的 404 明确分类为模型不存在', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(404)));
    const { client } = settingsService();

    await expect(client.testDraftConnection(draft({}, 'sk-test'))).resolves.toMatchObject({
      ok: false,
      errorCode: 'MODEL_NOT_FOUND',
    });
  });

  test.each([
    [Object.assign(new Error('aborted'), { name: 'AbortError' }), 'TIMEOUT'],
    [new Error('网络底层错误包含 sk-network-secret'), 'NETWORK_ERROR'],
  ] as const)('网络异常被稳定分类且不回显底层错误', async (failure, errorCode) => {
    const fetchMock = vi.fn(async () => {
      throw failure;
    });
    vi.stubGlobal('fetch', fetchMock);
    const { client } = settingsService();

    const result = await client.discoverModels(
      draft({}, 'sk-network-secret'),
    );

    expect(result).toMatchObject({ ok: false, errorCode });
    expect(JSON.stringify(result)).not.toContain('sk-network-secret');
  });

  test.each([
    ['not-json', '损坏 JSON'],
    [JSON.stringify({ data: [{ name: 'missing-id' }] }), '错误模型结构'],
  ])('成功状态但返回%s时分类为 INVALID_RESPONSE', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, body)));
    const { client } = settingsService();

    await expect(client.discoverModels(draft({}, 'sk-test'))).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_RESPONSE',
      models: [],
    });
  });

  test('发现到超过设置契约上限的模型 ID 时拒绝该响应', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ data: [{ id: 'm'.repeat(201) }] })),
    );
    const { client } = settingsService();

    await expect(client.discoverModels(draft({}, 'sk-test'))).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_RESPONSE',
      models: [],
    });
  });

  test.each([
    [
      '云端空 choices',
      draft({}, 'sk-test'),
      { choices: [] },
    ],
    [
      '云端空 content',
      draft({}, 'sk-test'),
      { choices: [{ message: { content: '' } }] },
    ],
    [
      'Ollama 空 content',
      draft({ provider: 'ollama' }),
      { message: { content: '' } },
    ],
  ] as const)('%s 不会被误判为连接成功', async (_label, configuration, body) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(body)));
    const { client } = settingsService();

    await expect(client.testDraftConnection(configuration)).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_RESPONSE',
      latencyMs: null,
    });
  });

  test('非法草稿在发起网络请求前返回 INVALID_SETTINGS', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { client } = settingsService();

    const result = await client.discoverModels({
      settings: settings({ cloudBaseUrl: 'http://api.example.com/v1' }),
      cloudCredential: 'sk-test',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'INVALID_SETTINGS',
      models: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
