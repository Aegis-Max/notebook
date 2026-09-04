import type { AiConnectionResult, AiSettings } from '../src/types/desktop.js';
import { DesktopError, errorMessage } from './errors.js';
import type { SecureSettingsService } from './secure-settings.js';

const REQUEST_TIMEOUT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

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

async function request(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: 'error',
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new DesktopError('AI_TIMEOUT', 'AI 服务响应超时');
    }
    throw new DesktopError('AI_UNREACHABLE', '无法连接 AI 服务', { cause: error });
  } finally {
    clearTimeout(timeout);
  }
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
    return { response, text: await readLimitedText(response) };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new DesktopError('AI_TIMEOUT', 'AI 服务响应超时');
    }
    if (error instanceof DesktopError) throw error;
    throw new DesktopError('AI_UNREACHABLE', '无法连接 AI 服务', { cause: error });
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

export class AiClient {
  constructor(private readonly settingsService: SecureSettingsService) {}

  async testConnection(): Promise<AiConnectionResult> {
    const settings = await this.settingsService.getSettings();
    if (process.env.CORNELL_AI_MOCK === '1') {
      return {
        ok: true,
        error: null,
        provider: settings.provider,
        model: this.modelFor(settings),
      };
    }

    try {
      if (settings.provider === 'cloud') {
        const secret = await this.requireCloudCredential();
        const response = await request(
          endpoint(settings.cloudBaseUrl, '/models'),
          { headers: { Authorization: `Bearer ${secret}` } },
          CONNECTION_TIMEOUT_MS,
        );
        if (!response.ok) {
          throw new DesktopError('AI_CONNECTION_REJECTED', '云端 AI 拒绝了连接');
        }
      } else {
        const response = await request(
          endpoint(settings.ollamaBaseUrl, '/api/tags'),
          {},
          CONNECTION_TIMEOUT_MS,
        );
        if (!response.ok) {
          throw new DesktopError('AI_CONNECTION_REJECTED', '本地 Ollama 拒绝了连接');
        }
      }

      return {
        ok: true,
        error: null,
        provider: settings.provider,
        model: this.modelFor(settings),
      };
    } catch (error) {
      return {
        ok: false,
        error: errorMessage(error, 'AI 连接测试失败'),
        provider: settings.provider,
        model: this.modelFor(settings),
      };
    }
  }

  /**
   * 返回尚未信任的 JSON；学习教练必须再用 Zod 和笔记逐字引用规则校验。
   */
  async completeJson(systemPrompt: string, payload: unknown): Promise<unknown> {
    const settings = await this.settingsService.getSettings();
    if (settings.provider === 'cloud') {
      const secret = await this.requireCloudCredential();
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
      if (!response.ok) {
        throw new DesktopError('AI_REQUEST_REJECTED', '云端 AI 请求失败');
      }
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
    if (!response.ok) {
      throw new DesktopError('AI_REQUEST_REJECTED', '本地 Ollama 请求失败');
    }
    const envelope = parseJson(text) as {
      message?: { content?: unknown };
    };
    if (typeof envelope.message?.content !== 'string') {
      throw new DesktopError('AI_EMPTY_RESPONSE', '本地 Ollama 未返回可用内容');
    }
    return parseJson(envelope.message.content);
  }

  private async requireCloudCredential(): Promise<string> {
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
