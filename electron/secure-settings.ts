import { join } from 'node:path';

import { safeStorage } from 'electron';
import { z } from 'zod';

import type { AiSettings, AiSettingsView, SaveResult } from '../src/types/desktop.js';
import { AtomicJsonStore } from './atomic-json-store.js';
import { DesktopError, errorMessage } from './errors.js';

const SETTINGS_SCHEMA_VERSION = 1;
const MAX_CREDENTIAL_LENGTH = 4096;

const rawAiSettingsSchema = z
  .object({
    provider: z.enum(['cloud', 'ollama']),
    cloudBaseUrl: z.string().min(1).max(2048),
    cloudModel: z.string().trim().min(1).max(200),
    ollamaBaseUrl: z.string().min(1).max(2048),
    ollamaModel: z.string().trim().min(1).max(200),
    supplementalKnowledge: z.boolean(),
  })
  .strict();

const settingsFileSchema = z
  .object({
    schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION),
    settings: rawAiSettingsSchema,
    encryptedCloudCredential: z.string().max(16_384).nullable(),
    cloudCredentialBaseUrl: z.string().max(2048).nullable().default(null),
  })
  .strict();

interface SettingsFile {
  schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  settings: AiSettings;
  encryptedCloudCredential: string | null;
  cloudCredentialBaseUrl: string | null;
}

const DEFAULT_SETTINGS: AiSettings = {
  provider: 'ollama',
  cloudBaseUrl: 'https://api.openai.com/v1',
  cloudModel: 'gpt-5-mini',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen3:8b',
  supplementalKnowledge: false,
};

function normalizeBaseUrl(raw: string, kind: 'cloud' | 'ollama'): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new DesktopError('INVALID_AI_URL', 'AI 服务地址不是有效 URL');
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new DesktopError(
      'INVALID_AI_URL',
      'AI 服务地址不能包含账号、密码、查询参数或片段',
    );
  }

  if (kind === 'cloud') {
    if (url.protocol !== 'https:') {
      throw new DesktopError('INSECURE_CLOUD_URL', '云端 AI 服务必须使用 HTTPS');
    }
  } else {
    const hostname = url.hostname.toLocaleLowerCase();
    const isLoopback =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      hostname === '::1';
    if (!isLoopback || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      throw new DesktopError(
        'OLLAMA_NOT_LOOPBACK',
        'Ollama 只允许连接本机回环地址',
      );
    }
  }

  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export function normalizeAiSettings(candidate: unknown): AiSettings {
  const parsed = rawAiSettingsSchema.parse(candidate);
  return {
    ...parsed,
    cloudBaseUrl: normalizeBaseUrl(parsed.cloudBaseUrl, 'cloud'),
    ollamaBaseUrl: normalizeBaseUrl(parsed.ollamaBaseUrl, 'ollama'),
  };
}

function parseSettingsFile(candidate: unknown): SettingsFile {
  const parsed = settingsFileSchema.parse(candidate);
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    settings: normalizeAiSettings(parsed.settings),
    encryptedCloudCredential: parsed.encryptedCloudCredential,
    cloudCredentialBaseUrl: parsed.cloudCredentialBaseUrl,
  };
}

export class SecureSettingsService {
  private readonly store: AtomicJsonStore<SettingsFile>;

  constructor(userDataPath: string) {
    this.store = new AtomicJsonStore(
      join(userDataPath, 'ai-settings.json'),
      () => ({
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        settings: DEFAULT_SETTINGS,
        encryptedCloudCredential: null,
        cloudCredentialBaseUrl: null,
      }),
      parseSettingsFile,
    );
  }

  async getSettings(): Promise<AiSettingsView> {
    const file = await this.store.read();
    return {
      ...file.settings,
      cloudCredentialConfigured:
        file.encryptedCloudCredential !== null &&
        file.cloudCredentialBaseUrl === file.settings.cloudBaseUrl,
      secureStorageAvailable: await this.isSecureStorageAvailable(),
    };
  }

  async saveSettings(candidate: unknown): Promise<AiSettingsView> {
    const settings = normalizeAiSettings(candidate);
    const file = await this.store.update((draft) => {
      if (draft.settings.cloudBaseUrl !== settings.cloudBaseUrl) {
        // 密钥绑定保存时的服务地址，防止被入侵的 renderer 静默改 URL 后转发旧密钥。
        draft.encryptedCloudCredential = null;
        draft.cloudCredentialBaseUrl = null;
      }
      draft.settings = settings;
    });
    return {
      ...file.settings,
      cloudCredentialConfigured:
        file.encryptedCloudCredential !== null &&
        file.cloudCredentialBaseUrl === file.settings.cloudBaseUrl,
      secureStorageAvailable: await this.isSecureStorageAvailable(),
    };
  }

  async setCloudCredential(candidate: unknown): Promise<SaveResult> {
    if (typeof candidate !== 'string') {
      return { ok: false, error: '云端密钥格式无效' };
    }
    const secret = candidate.trim();
    if (secret.length === 0 || secret.length > MAX_CREDENTIAL_LENGTH) {
      return { ok: false, error: '云端密钥长度无效' };
    }

    try {
      if (!(await this.isSecureStorageAvailable())) {
        return { ok: false, error: '当前系统安全存储不可用，未保存密钥' };
      }
      const encrypted = await safeStorage.encryptStringAsync(secret);
      await this.store.update((draft) => {
        draft.encryptedCloudCredential = encrypted.toString('base64');
        draft.cloudCredentialBaseUrl = draft.settings.cloudBaseUrl;
      });
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: errorMessage(error, '无法将密钥保存到系统安全存储') };
    }
  }

  async deleteCloudCredential(): Promise<SaveResult> {
    try {
      await this.store.update((draft) => {
        draft.encryptedCloudCredential = null;
        draft.cloudCredentialBaseUrl = null;
      });
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: errorMessage(error, '无法删除云端密钥') };
    }
  }

  /** 仅供主进程 AI 客户端调用，永远不要经 IPC 返回。 */
  async getCloudCredential(): Promise<string | null> {
    const file = await this.store.read();
    if (
      !file.encryptedCloudCredential ||
      file.cloudCredentialBaseUrl !== file.settings.cloudBaseUrl
    ) {
      return null;
    }
    if (!(await this.isSecureStorageAvailable())) {
      throw new DesktopError(
        'SECURE_STORAGE_UNAVAILABLE',
        '系统安全存储当前不可用，无法读取云端密钥',
      );
    }

    try {
      const encrypted = Buffer.from(file.encryptedCloudCredential, 'base64');
      const decrypted = await safeStorage.decryptStringAsync(encrypted);
      if (decrypted.shouldReEncrypt) {
        const replacement = await safeStorage.encryptStringAsync(decrypted.result);
        await this.store.update((draft) => {
          draft.encryptedCloudCredential = replacement.toString('base64');
        });
      }
      return decrypted.result;
    } catch (error) {
      throw new DesktopError('CREDENTIAL_DECRYPT_FAILED', '无法解密云端密钥', {
        cause: error,
      });
    }
  }

  private async isSecureStorageAvailable(): Promise<boolean> {
    try {
      return await safeStorage.isAsyncEncryptionAvailable();
    } catch {
      return false;
    }
  }
}
