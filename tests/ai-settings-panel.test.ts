// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { AiSettingsPanel } from '../src/components/AiSettingsPanel.js';
import type {
  AiConfigurationSaveResult,
  AiConnectionResult,
  AiModelDiscoveryResult,
  AiSettingsView,
} from '../src/types/desktop.js';

const apiMocks = vi.hoisted(() => ({
  discoverModels: vi.fn<() => Promise<AiModelDiscoveryResult>>(),
  testDraftConnection: vi.fn<() => Promise<AiConnectionResult>>(),
  saveConfiguration: vi.fn<() => Promise<AiConfigurationSaveResult>>(),
}));

vi.mock('../src/platform/renderer-platform.js', () => ({
  getDesktopApi: () => ({ ai: apiMocks }),
}));

const cloudSettings: AiSettingsView = {
  provider: 'cloud',
  cloudBaseUrl: 'https://api.openai.com/v1',
  cloudModel: 'gpt-5-mini',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen3:8b',
  supplementalKnowledge: false,
  cloudCredentialConfigured: false,
  secureStorageAvailable: true,
};

function renderPanel(
  settings: AiSettingsView = cloudSettings,
  onSaved = vi.fn(),
) {
  render(createElement(AiSettingsPanel, {
    settings,
    loading: false,
    onBack: vi.fn(),
    onSaved,
  }));
  return { onSaved };
}

beforeEach(() => {
  apiMocks.discoverModels.mockReset();
  apiMocks.testDraftConnection.mockReset();
  apiMocks.saveConfiguration.mockReset();
});

afterEach(() => cleanup());

describe('AI 设置面板', () => {
  test('预设会更新基础地址与默认模型，仍允许改为自定义地址', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('ai-preset-deepseek'));
    expect((screen.getByTestId('ai-base-url') as HTMLInputElement).value)
      .toBe('https://api.deepseek.com');
    expect((screen.getByTestId('ai-model') as HTMLInputElement).value)
      .toBe('deepseek-chat');

    await user.clear(screen.getByTestId('ai-base-url'));
    await user.type(screen.getByTestId('ai-base-url'), 'https://models.example.com/v1');
    expect((screen.getByTestId('ai-preset-custom') as HTMLInputElement).checked).toBe(true);
  });

  test('模型检测只读取草稿，支持搜索选择且不会保存配置', async () => {
    apiMocks.discoverModels.mockResolvedValue({
      ok: true,
      error: null,
      errorCode: null,
      provider: 'cloud',
      models: [
        { id: 'study-large', label: 'Study Large' },
        { id: 'study-mini', label: 'Study Mini' },
      ],
    });
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId('ai-discover-models'));
    await screen.findByTestId('ai-model-list');

    expect(apiMocks.discoverModels).toHaveBeenCalledTimes(1);
    expect(apiMocks.saveConfiguration).not.toHaveBeenCalled();
    await user.type(screen.getByTestId('ai-model-search'), 'mini');
    expect(screen.queryByRole('button', { name: /Study Large/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: /Study Mini/ }));
    expect((screen.getByTestId('ai-model') as HTMLInputElement).value).toBe('study-mini');
  });

  test('草稿连接测试显示模型和延迟，但不会保存设置', async () => {
    apiMocks.testDraftConnection.mockResolvedValue({
      ok: true,
      error: null,
      errorCode: null,
      provider: 'cloud',
      model: 'gpt-5-mini',
      latencyMs: 128,
    });
    const user = userEvent.setup();
    renderPanel();

    await user.type(screen.getByTestId('ai-api-key'), 'sk-draft-only');
    await user.click(screen.getByTestId('ai-test-connection'));

    await waitFor(() => expect(apiMocks.testDraftConnection).toHaveBeenCalledTimes(1));
    expect(apiMocks.saveConfiguration).not.toHaveBeenCalled();
    expect(screen.getByTestId('ai-settings-notice').textContent)
      .toContain('gpt-5-mini · 128 ms');
    expect(screen.getByTestId('ai-settings-notice').textContent)
      .toContain('未保存设置');
  });

  test('密钥显隐仅作用于本次输入，只有保存按钮提交配置', async () => {
    const savedSettings = { ...cloudSettings, cloudCredentialConfigured: true };
    apiMocks.saveConfiguration.mockResolvedValue({
      ok: true,
      error: null,
      errorCode: null,
      settings: savedSettings,
    });
    const onSaved = vi.fn();
    const user = userEvent.setup();
    renderPanel(cloudSettings, onSaved);

    const credential = screen.getByTestId('ai-api-key') as HTMLInputElement;
    expect(credential.type).toBe('password');
    await user.type(credential, 'sk-save-me');
    await user.click(screen.getByTestId('ai-api-key-visibility'));
    expect(credential.type).toBe('text');
    expect(apiMocks.saveConfiguration).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('ai-settings-save'));
    await waitFor(() => expect(apiMocks.saveConfiguration).toHaveBeenCalledTimes(1));
    expect(apiMocks.saveConfiguration.mock.calls[0]?.[0]).toMatchObject({
      cloudCredential: 'sk-save-me',
      settings: { provider: 'cloud', cloudModel: 'gpt-5-mini' },
    });
    expect(onSaved).toHaveBeenCalledWith(savedSettings);
  });

  test('移除密钥先保留为草稿，点击保存后才提交清除标记', async () => {
    const configuredSettings = { ...cloudSettings, cloudCredentialConfigured: true };
    apiMocks.saveConfiguration.mockResolvedValue({
      ok: true,
      error: null,
      errorCode: null,
      settings: cloudSettings,
    });
    const user = userEvent.setup();
    renderPanel(configuredSettings);

    await user.click(screen.getByRole('button', { name: '移除已保存密钥' }));
    expect(apiMocks.saveConfiguration).not.toHaveBeenCalled();
    expect(screen.getByText('保存后移除')).not.toBeNull();

    await user.click(screen.getByTestId('ai-settings-save'));
    await waitFor(() => expect(apiMocks.saveConfiguration).toHaveBeenCalledTimes(1));
    expect(apiMocks.saveConfiguration.mock.calls[0]?.[0]).toMatchObject({
      clearCloudCredential: true,
    });
  });

  test('切换到本地模型会丢弃不可见的云端密钥草稿', async () => {
    const configuredSettings = { ...cloudSettings, cloudCredentialConfigured: true };
    apiMocks.saveConfiguration.mockResolvedValue({
      ok: true,
      error: null,
      errorCode: null,
      settings: { ...configuredSettings, provider: 'ollama' },
    });
    const user = userEvent.setup();
    renderPanel(configuredSettings);

    await user.type(screen.getByTestId('ai-api-key'), 'sk-hidden-draft');
    await user.click(screen.getByRole('button', { name: '移除已保存密钥' }));
    await user.click(screen.getByText('本地模型', { exact: true }));
    await user.click(screen.getByTestId('ai-settings-save'));

    await waitFor(() => expect(apiMocks.saveConfiguration).toHaveBeenCalledTimes(1));
    expect(apiMocks.saveConfiguration.mock.calls[0]?.[0]).not.toHaveProperty('cloudCredential');
    expect(apiMocks.saveConfiguration.mock.calls[0]?.[0]).not.toHaveProperty('clearCloudCredential');
  });
});
