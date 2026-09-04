import type {
  AiConnectionResult,
  AiDraftConfiguration,
  AiModelDiscoveryResult,
  AiModelInfo,
  AiOperationErrorCode,
  AiProviderKind,
  AiSettings,
} from '../src/types/desktop.js';
import { DesktopError } from './errors.js';
import {
  normalizeAiDraftConfiguration,
  type SecureSettingsService,
} from './secure-settings.js';

const REQUEST_TIMEOUT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_DISCOVERED_MODELS = 5_000;
const MAX_MODEL_ID_LENGTH = 200;
const CONNECTION_TEST_PROMPT = 'Reply with OK.';

type AiOperation = 'completion' | 'discovery' | 'connection';

/** 配置值就是 API base URL：这里只拼接资源路径，不猜测或改写 /v1。 */
function endpoint(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${suffix}`;
}

async function readLimitedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new DesktopError('AI_RESPONSE_TOO_LARGE', 'AI 返回内容过大');
  }

  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new DesktopError('AI_RESPONSE_TOO_LARGE', 'AI 返回内容过大');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function requestWithBody(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ response: Response; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: 'error',
      cache: 'no-store',
    });

    // 错误响应可能回显 Authorization 或请求正文；不要读取，更不能传给 renderer。
    if (!response.ok) return { response, text: '' };
    return { response, text: await readLimitedText(response) };
  } catch (error) {
    if (error instanceof DesktopError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new DesktopError('AI_TIMEOUT', 'AI 服务响应超时');
    }
    throw new DesktopError('AI_UNREACHABLE', '无法连接 AI 服务', {
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/gi, '').trim());
  } catch (error) {
    throw new DesktopError('AI_INVALID_JSON', 'AI 未返回有效的结构化结果', {
      cause: error,
    });
  }
}

function throwForResponse(response: Response, operation: AiOperation): void {
  if (response.ok) return;

  switch (response.status) {
    case 401:
      throw new DesktopError('AI_AUTHENTICATION_FAILED', 'AI 服务认证失败');
    case 403:
      throw new DesktopError('AI_ACCESS_DENIED', '当前凭据无权访问 AI 服务或模型');
    case 404:
      if (operation === 'connection') {
        throw new DesktopError('AI_MODEL_NOT_FOUND', '未找到选定模型');
      }
      throw new DesktopError('AI_ENDPOINT_NOT_FOUND', '未找到 AI 接口，请检查 base URL');
    case 408:
      throw new DesktopError('AI_TIMEOUT', 'AI 服务响应超时');
    case 429:
      throw new DesktopError('AI_RATE_LIMITED', 'AI 请求过于频繁或额度不足');
    default:
      if (response.status >= 500) {
        throw new DesktopError('AI_SERVICE_UNAVAILABLE', 'AI 服务暂时不可用');
      }
      throw new DesktopError('AI_REQUEST_REJECTED', 'AI 服务拒绝了请求');
  }
}

function operationErrorCode(error: unknown): AiOperationErrorCode {
  if (!(error instanceof DesktopError)) return 'REQUEST_REJECTED';

  switch (error.code) {
    case 'INVALID_AI_DRAFT':
    case 'INVALID_AI_URL':
    case 'INSECURE_CLOUD_URL':
    case 'OLLAMA_NOT_LOOPBACK':
      return 'INVALID_SETTINGS';
    case 'CREDENTIAL_REQUIRED':
      return 'CREDENTIAL_REQUIRED';
    case 'SECURE_STORAGE_UNAVAILABLE':
    case 'CREDENTIAL_DECRYPT_FAILED':
      return 'SECURE_STORAGE_UNAVAILABLE';
    case 'AI_AUTHENTICATION_FAILED':
      return 'AUTHENTICATION_FAILED';
    case 'AI_ACCESS_DENIED':
      return 'ACCESS_DENIED';
    case 'AI_MODEL_NOT_FOUND':
      return 'MODEL_NOT_FOUND';
    case 'AI_ENDPOINT_NOT_FOUND':
      return 'ENDPOINT_NOT_FOUND';
    case 'AI_RATE_LIMITED':
      return 'RATE_LIMITED';
    case 'AI_SERVICE_UNAVAILABLE':
      return 'SERVICE_UNAVAILABLE';
    case 'AI_TIMEOUT':
      return 'TIMEOUT';
    case 'AI_UNREACHABLE':
      return 'NETWORK_ERROR';
    case 'AI_INVALID_JSON':
    case 'AI_INVALID_RESPONSE':
    case 'AI_EMPTY_RESPONSE':
    case 'AI_RESPONSE_TOO_LARGE':
      return 'INVALID_RESPONSE';
    default:
      return 'REQUEST_REJECTED';
  }
}

/** 只按公开分类返回固定文本，避免任何底层错误消息带出密钥。 */
function operationErrorMessage(error: unknown): string {
  switch (operationErrorCode(error)) {
    case 'INVALID_SETTINGS':
      return 'AI 草稿配置格式无效';
    case 'CREDENTIAL_REQUIRED':
      return '请输入当前 API 地址对应的密钥';
    case 'SECURE_STORAGE_UNAVAILABLE':
      return '系统安全存储当前不可用，无法读取云端密钥';
    case 'AUTHENTICATION_FAILED':
      return 'AI 服务认证失败';
    case 'ACCESS_DENIED':
      return '当前凭据无权访问 AI 服务或模型';
    case 'MODEL_NOT_FOUND':
      return '未找到选定模型';
    case 'ENDPOINT_NOT_FOUND':
      return '未找到 AI 接口，请检查 base URL';
    case 'RATE_LIMITED':
      return 'AI 请求过于频繁或额度不足';
    case 'SERVICE_UNAVAILABLE':
      return 'AI 服务暂时不可用';
    case 'TIMEOUT':
      return 'AI 服务响应超时';
    case 'NETWORK_ERROR':
      return '无法连接 AI 服务';
    case 'INVALID_RESPONSE':
      return 'AI 服务返回了无法识别的响应';
    case 'SAVE_FAILED':
      return '保存 AI 配置失败';
    case 'REQUEST_REJECTED':
    default:
      return 'AI 服务拒绝了请求';
  }
}

function providerFromCandidate(candidate: unknown): AiProviderKind {
  if (
    candidate &&
    typeof candidate === 'object' &&
    'settings' in candidate &&
    candidate.settings &&
    typeof candidate.settings === 'object' &&
    'provider' in candidate.settings &&
    candidate.settings.provider === 'cloud'
  ) {
    return 'cloud';
  }
  return 'ollama';
}

function modelFromCandidate(candidate: unknown): string {
  if (!candidate || typeof candidate !== 'object' || !('settings' in candidate)) {
    return '';
  }
  const settings = candidate.settings;
  if (!settings || typeof settings !== 'object') return '';
  if (
    'provider' in settings &&
    settings.provider === 'cloud' &&
    'cloudModel' in settings &&
    typeof settings.cloudModel === 'string'
  ) {
    return settings.cloudModel.trim();
  }
  if ('ollamaModel' in settings && typeof settings.ollamaModel === 'string') {
    return settings.ollamaModel.trim();
  }
  return '';
}

function normalizeModelIds(ids: string[]): AiModelInfo[] {
  const unique = new Set<string>();
  for (const candidate of ids) {
    const id = candidate.trim();
    if (!id || id.length > MAX_MODEL_ID_LENGTH) {
      throw new DesktopError('AI_INVALID_RESPONSE', 'AI 返回的模型 ID 无效');
    }
    unique.add(id);
    if (unique.size > MAX_DISCOVERED_MODELS) {
      throw new DesktopError('AI_INVALID_RESPONSE', 'AI 返回的模型列表过大');
    }
  }
  return [...unique]
    .sort((left, right) => left.localeCompare(right))
    .map((id) => ({ id, label: id }));
}

function parseCloudModels(text: string): AiModelInfo[] {
  const envelope = parseJson(text);
  if (!envelope || typeof envelope !== 'object' || !('data' in envelope)) {
    throw new DesktopError('AI_INVALID_RESPONSE', '云端 AI 未返回有效模型列表');
  }
  const data = envelope.data;
  if (!Array.isArray(data)) {
    throw new DesktopError('AI_INVALID_RESPONSE', '云端 AI 未返回有效模型列表');
  }
  const ids = data.map((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      !('id' in item) ||
      typeof item.id !== 'string'
    ) {
      throw new DesktopError('AI_INVALID_RESPONSE', '云端 AI 模型列表格式无效');
    }
    return item.id;
  });
  return normalizeModelIds(ids);
}

function parseOllamaModels(text: string): AiModelInfo[] {
  const envelope = parseJson(text);
  if (!envelope || typeof envelope !== 'object' || !('models' in envelope)) {
    throw new DesktopError('AI_INVALID_RESPONSE', 'Ollama 未返回有效模型列表');
  }
  const models = envelope.models;
  if (!Array.isArray(models)) {
    throw new DesktopError('AI_INVALID_RESPONSE', 'Ollama 未返回有效模型列表');
  }
  const ids = models.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new DesktopError('AI_INVALID_RESPONSE', 'Ollama 模型列表格式无效');
    }
    const id =
      'name' in item && typeof item.name === 'string'
        ? item.name
        : 'model' in item && typeof item.model === 'string'
          ? item.model
          : null;
    if (!id) {
      throw new DesktopError('AI_INVALID_RESPONSE', 'Ollama 模型列表格式无效');
    }
    return id;
  });
  return normalizeModelIds(ids);
}

function assertConnectionEnvelope(provider: AiProviderKind, text: string): void {
  const envelope = parseJson(text);
  if (!envelope || typeof envelope !== 'object') {
    throw new DesktopError('AI_INVALID_RESPONSE', 'AI 未返回有效连接测试结果');
  }
  if (provider === 'cloud') {
    if (
      !('choices' in envelope) ||
      !Array.isArray(envelope.choices) ||
      !envelope.choices[0] ||
      typeof envelope.choices[0] !== 'object' ||
      !('message' in envelope.choices[0]) ||
      !envelope.choices[0].message ||
      typeof envelope.choices[0].message !== 'object' ||
      !('content' in envelope.choices[0].message) ||
      typeof envelope.choices[0].message.content !== 'string' ||
      envelope.choices[0].message.content.trim().length === 0
    ) {
      throw new DesktopError('AI_INVALID_RESPONSE', '云端 AI 未返回有效连接测试结果');
    }
    return;
  }
  if (
    !('message' in envelope) ||
    !envelope.message ||
    typeof envelope.message !== 'object' ||
    !('content' in envelope.message) ||
    typeof envelope.message.content !== 'string' ||
    envelope.message.content.trim().length === 0
  ) {
    throw new DesktopError('AI_INVALID_RESPONSE', 'Ollama 未返回有效连接测试结果');
  }
}

export class AiClient {
  constructor(private readonly settingsService: SecureSettingsService) {}

  /** 兼容旧 API；现在也会用已保存模型发送一次最小真实聊天请求。 */
  async testConnection(): Promise<AiConnectionResult> {
    const settings = await this.settingsService.getSettings();
    return this.testDraftConnection({ settings });
  }

  async discoverModels(candidate: unknown): Promise<AiModelDiscoveryResult> {
    let provider = providerFromCandidate(candidate);
    try {
      const draft = normalizeAiDraftConfiguration(candidate);
      provider = draft.settings.provider;
      const selectedModel = this.modelFor(draft.settings);
      if (process.env.CORNELL_AI_MOCK === '1') {
        return {
          ok: true,
          error: null,
          errorCode: null,
          provider,
          models: [{ id: selectedModel, label: selectedModel }],
        };
      }

      if (provider === 'cloud') {
        const secret = await this.resolveDraftCloudCredential(draft);
        const { response, text } = await requestWithBody(
          endpoint(draft.settings.cloudBaseUrl, '/models'),
          { headers: { Authorization: `Bearer ${secret}` } },
          CONNECTION_TIMEOUT_MS,
        );
        throwForResponse(response, 'discovery');
        return {
          ok: true,
          error: null,
          errorCode: null,
          provider,
          models: parseCloudModels(text),
        };
      }

      const { response, text } = await requestWithBody(
        endpoint(draft.settings.ollamaBaseUrl, '/api/tags'),
        {},
        CONNECTION_TIMEOUT_MS,
      );
      throwForResponse(response, 'discovery');
      return {
        ok: true,
        error: null,
        errorCode: null,
        provider,
        models: parseOllamaModels(text),
      };
    } catch (error) {
      return {
        ok: false,
        error: operationErrorMessage(error),
        errorCode: operationErrorCode(error),
        provider,
        models: [],
      };
    }
  }

  async testDraftConnection(candidate: unknown): Promise<AiConnectionResult> {
    let provider = providerFromCandidate(candidate);
    let model = modelFromCandidate(candidate);
    try {
      const draft = normalizeAiDraftConfiguration(candidate);
      provider = draft.settings.provider;
      model = this.modelFor(draft.settings);
      if (process.env.CORNELL_AI_MOCK === '1') {
        return {
          ok: true,
          error: null,
          errorCode: null,
          provider,
          model,
          latencyMs: 0,
        };
      }

      const startedAt = Date.now();
      if (provider === 'cloud') {
        const secret = await this.resolveDraftCloudCredential(draft);
        const { response, text } = await requestWithBody(
          endpoint(draft.settings.cloudBaseUrl, '/chat/completions'),
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${secret}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: CONNECTION_TEST_PROMPT }],
            }),
          },
          CONNECTION_TIMEOUT_MS,
        );
        throwForResponse(response, 'connection');
        assertConnectionEnvelope(provider, text);
      } else {
        const { response, text } = await requestWithBody(
          endpoint(draft.settings.ollamaBaseUrl, '/api/chat'),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              stream: false,
              options: { temperature: 0, num_predict: 1 },
              messages: [{ role: 'user', content: CONNECTION_TEST_PROMPT }],
            }),
          },
          CONNECTION_TIMEOUT_MS,
        );
        throwForResponse(response, 'connection');
        assertConnectionEnvelope(provider, text);
      }

      return {
        ok: true,
        error: null,
        errorCode: null,
        provider,
        model,
        latencyMs: Math.max(0, Date.now() - startedAt),
      };
    } catch (error) {
      return {
        ok: false,
        error: operationErrorMessage(error),
        errorCode: operationErrorCode(error),
        provider,
        model,
        latencyMs: null,
      };
    }
  }

  /**
   * 返回尚未信任的 JSON；学习教练必须再用 Zod 和笔记逐字引用规则校验。
   */
  async completeJson(systemPrompt: string, payload: unknown): Promise<unknown> {
    const settings = await this.settingsService.getSettings();
    if (settings.provider === 'cloud') {
      const secret = await this.requireSavedCloudCredential();
      const { response, text } = await requestWithBody(
        endpoint(settings.cloudBaseUrl, '/chat/completions'),
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${secret}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: settings.cloudModel,
            temperature: 0.1,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: JSON.stringify(payload) },
            ],
          }),
        },
        REQUEST_TIMEOUT_MS,
      );
      throwForResponse(response, 'completion');
      const envelope = parseJson(text) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = envelope.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new DesktopError('AI_EMPTY_RESPONSE', '云端 AI 未返回可用内容');
      }
      return parseJson(content);
    }

    const { response, text } = await requestWithBody(
      endpoint(settings.ollamaBaseUrl, '/api/chat'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: settings.ollamaModel,
          stream: false,
          format: 'json',
          options: { temperature: 0.1 },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(payload) },
          ],
        }),
      },
      REQUEST_TIMEOUT_MS,
    );
    throwForResponse(response, 'completion');
    const envelope = parseJson(text) as {
      message?: { content?: unknown };
    };
    if (typeof envelope.message?.content !== 'string') {
      throw new DesktopError('AI_EMPTY_RESPONSE', '本地 Ollama 未返回可用内容');
    }
    return parseJson(envelope.message.content);
  }

  private async resolveDraftCloudCredential(
    draft: AiDraftConfiguration,
  ): Promise<string> {
    if (draft.cloudCredential) return draft.cloudCredential;
    if (draft.clearCloudCredential) {
      throw new DesktopError('CREDENTIAL_REQUIRED', '请输入当前 API 地址对应的密钥');
    }
    const secret = await this.settingsService.getCloudCredentialForBaseUrl(
      draft.settings.cloudBaseUrl,
      { allowReEncrypt: false },
    );
    if (!secret) {
      throw new DesktopError('CREDENTIAL_REQUIRED', '请输入当前 API 地址对应的密钥');
    }
    return secret;
  }

  private async requireSavedCloudCredential(): Promise<string> {
    const secret = await this.settingsService.getCloudCredential();
    if (!secret) {
      throw new DesktopError('CREDENTIAL_REQUIRED', '请先保存云端 AI 密钥');
    }
    return secret;
  }

  private modelFor(settings: AiSettings): string {
    return settings.provider === 'cloud' ? settings.cloudModel : settings.ollamaModel;
  }
}
