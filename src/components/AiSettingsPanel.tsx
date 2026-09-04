import { useDeferredValue, useEffect, useMemo, useState } from 'react';

import { getDesktopApi } from '../platform/renderer-platform.js';
import type {
  AiDraftConfiguration,
  AiModelInfo,
  AiOperationErrorCode,
  AiSettings,
  AiSettingsView,
} from '../types/desktop.js';

type SettingsAction = 'discover' | 'test' | 'save' | null;
type CloudPresetId = 'openai' | 'deepseek' | 'custom';

interface NoticeState {
  tone: 'success' | 'error' | 'neutral';
  message: string;
}

interface AiSettingsPanelProps {
  settings: AiSettingsView;
  loading: boolean;
  onBack: () => void;
  onSaved: (settings: AiSettingsView) => void;
}

const CLOUD_PRESETS: ReadonlyArray<{
  id: CloudPresetId;
  label: string;
  description: string;
  baseUrl: string | null;
  defaultModel: string | null;
}> = [
  {
    id: 'openai',
    label: 'OpenAI',
    description: '官方 OpenAI API',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5-mini',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: '兼容 OpenAI 协议',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
  },
  {
    id: 'custom',
    label: '自定义',
    description: '其他兼容接口',
    baseUrl: null,
    defaultModel: null,
  },
];

const ERROR_LABELS: Partial<Record<AiOperationErrorCode, string>> = {
  INVALID_SETTINGS: '请检查地址、模型和密钥格式。',
  CREDENTIAL_REQUIRED: '请先输入当前 API 地址对应的密钥。',
  SECURE_STORAGE_UNAVAILABLE: '系统安全存储不可用，无法保存云端密钥。',
  AUTHENTICATION_FAILED: '密钥无效或已过期。',
  ACCESS_DENIED: '当前密钥没有访问该模型的权限。',
  MODEL_NOT_FOUND: '服务中没有找到当前模型。',
  ENDPOINT_NOT_FOUND: '接口地址不正确，请填写 API 基础地址。',
  RATE_LIMITED: '请求过于频繁或额度不足，请稍后重试。',
  SERVICE_UNAVAILABLE: '模型服务暂时不可用。',
  TIMEOUT: '模型服务响应超时。',
  NETWORK_ERROR: '无法连接模型服务，请检查网络和地址。',
  INVALID_RESPONSE: '模型服务返回了无法识别的响应。',
  REQUEST_REJECTED: '模型服务拒绝了请求。',
  SAVE_FAILED: '设置保存失败，原配置仍保留。',
};

function editableSettings(settings: AiSettingsView): AiSettings {
  return {
    provider: settings.provider,
    cloudBaseUrl: settings.cloudBaseUrl,
    cloudModel: settings.cloudModel,
    ollamaBaseUrl: settings.ollamaBaseUrl,
    ollamaModel: settings.ollamaModel,
    supplementalKnowledge: settings.supplementalKnowledge,
  };
}

function normalizedBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function endpointPreview(baseUrl: string, path: string): string {
  const base = normalizedBaseUrl(baseUrl);
  return base ? `${base}${path}` : `—${path}`;
}

function inferCloudPreset(baseUrl: string): CloudPresetId {
  const normalized = normalizedBaseUrl(baseUrl).toLocaleLowerCase();
  const preset = CLOUD_PRESETS.find(
    (candidate) => candidate.baseUrl?.toLocaleLowerCase() === normalized,
  );
  return preset?.id ?? 'custom';
}

function operationError(
  errorCode: AiOperationErrorCode | null,
  message: string | null,
  fallback: string,
): string {
  const detail = errorCode ? ERROR_LABELS[errorCode] : null;
  if (message && detail && !message.includes(detail)) return `${message} ${detail}`;
  return message ?? detail ?? fallback;
}

export function AiSettingsPanel({
  settings,
  loading,
  onBack,
  onSaved,
}: AiSettingsPanelProps) {
  const [draft, setDraft] = useState<AiSettings>(() => editableSettings(settings));
  const [cloudPreset, setCloudPreset] = useState<CloudPresetId>(() => inferCloudPreset(settings.cloudBaseUrl));
  const [credential, setCredential] = useState('');
  const [credentialVisible, setCredentialVisible] = useState(false);
  const [clearCloudCredential, setClearCloudCredential] = useState(false);
  const [models, setModels] = useState<AiModelInfo[]>([]);
  const [modelSearch, setModelSearch] = useState('');
  const [discoveryAttempted, setDiscoveryAttempted] = useState(false);
  const [action, setAction] = useState<SettingsAction>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const deferredModelSearch = useDeferredValue(modelSearch);

  useEffect(() => {
    if (loading) return;
    setDraft(editableSettings(settings));
    setCloudPreset(inferCloudPreset(settings.cloudBaseUrl));
    setCredential('');
    setCredentialVisible(false);
    setClearCloudCredential(false);
    setModels([]);
    setModelSearch('');
    setDiscoveryAttempted(false);
  }, [
    loading,
    settings.cloudBaseUrl,
    settings.cloudModel,
    settings.ollamaBaseUrl,
    settings.ollamaModel,
    settings.provider,
    settings.supplementalKnowledge,
  ]);

  const activeBaseUrl = draft.provider === 'cloud'
    ? draft.cloudBaseUrl
    : draft.ollamaBaseUrl;
  const activeModel = draft.provider === 'cloud'
    ? draft.cloudModel
    : draft.ollamaModel;
  const savedBaseChanged =
    draft.provider === 'cloud'
    && settings.cloudCredentialConfigured
    && normalizedBaseUrl(draft.cloudBaseUrl) !== normalizedBaseUrl(settings.cloudBaseUrl);
  const savedSettings = editableSettings(settings);
  const hasUnsavedChanges =
    JSON.stringify(draft) !== JSON.stringify(savedSettings)
    || credential.trim().length > 0
    || clearCloudCredential;

  const filteredModels = useMemo(() => {
    const query = deferredModelSearch.trim().toLocaleLowerCase();
    if (!query) return models;
    return models.filter((model) =>
      `${model.id} ${model.label}`.toLocaleLowerCase().includes(query),
    );
  }, [deferredModelSearch, models]);

  const updateDraft = (updater: (current: AiSettings) => AiSettings) => {
    setDraft(updater);
    setModels([]);
    setModelSearch('');
    setDiscoveryAttempted(false);
    setNotice(null);
  };

  const configurationDraft = (): AiDraftConfiguration => ({
    settings: draft,
    ...(credential.trim() ? { cloudCredential: credential.trim() } : {}),
    ...(clearCloudCredential ? { clearCloudCredential: true } : {}),
  });

  const selectProvider = (provider: AiSettings['provider']) => {
    if (provider === 'ollama') {
      // 云端凭据草稿在本地模型界面中不可见，切走时清空，避免一次本地设置保存
      // 意外提交隐藏的新密钥或删除标记。
      setCredential('');
      setCredentialVisible(false);
      setClearCloudCredential(false);
    }
    updateDraft((current) => ({ ...current, provider }));
  };

  const selectActiveModel = (model: string) => {
    setDraft((current) => current.provider === 'cloud'
      ? { ...current, cloudModel: model }
      : { ...current, ollamaModel: model });
    setNotice(null);
  };

  const selectPreset = (presetId: CloudPresetId) => {
    const preset = CLOUD_PRESETS.find((candidate) => candidate.id === presetId);
    if (!preset) return;
    setCloudPreset(presetId);
    setNotice(null);
    setModels([]);
    setModelSearch('');
    setDiscoveryAttempted(false);
    if (!preset.baseUrl) return;
    updateDraft((current) => ({
      ...current,
      cloudBaseUrl: preset.baseUrl ?? current.cloudBaseUrl,
      cloudModel: preset.defaultModel ?? current.cloudModel,
    }));
    setClearCloudCredential(false);
  };

  const discoverModels = async () => {
    const api = getDesktopApi();
    if (!api) return;
    setAction('discover');
    setNotice(null);
    setDiscoveryAttempted(true);
    try {
      const result = await api.ai.discoverModels(configurationDraft());
      if (!result.ok) {
        setModels([]);
        setNotice({
          tone: 'error',
          message: operationError(result.errorCode, result.error, '模型检测失败。'),
        });
        return;
      }
      setModels(result.models);
      setNotice({
        tone: 'success',
        message: result.models.length
          ? `检测到 ${result.models.length} 个可用模型，可搜索后选择。`
          : '服务没有返回模型列表，请直接手动填写模型 ID。',
      });
    } catch (error) {
      setModels([]);
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : '模型检测失败。',
      });
    } finally {
      setAction(null);
    }
  };

  const testConnection = async () => {
    const api = getDesktopApi();
    if (!api) return;
    setAction('test');
    setNotice(null);
    try {
      const result = await api.ai.testDraftConnection(configurationDraft());
      if (!result.ok) {
        setNotice({
          tone: 'error',
          message: operationError(result.errorCode, result.error, '连接测试失败。'),
        });
        return;
      }
      setNotice({
        tone: 'success',
        message: `连接成功：${result.model}${result.latencyMs === null ? '' : ` · ${result.latencyMs} ms`}。本次测试未保存设置。`,
      });
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : '连接测试失败。',
      });
    } finally {
      setAction(null);
    }
  };

  const saveConfiguration = async () => {
    const api = getDesktopApi();
    if (!api) return;
    setAction('save');
    setNotice(null);
    try {
      const result = await api.ai.saveConfiguration(configurationDraft());
      if (!result.ok || !result.settings) {
        setNotice({
          tone: 'error',
          message: operationError(result.errorCode, result.error, 'AI 设置保存失败。'),
        });
        return;
      }
      onSaved(result.settings);
      setCredential('');
      setCredentialVisible(false);
      setClearCloudCredential(false);
      setNotice({ tone: 'success', message: 'AI 设置已安全保存。' });
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : 'AI 设置保存失败。',
      });
    } finally {
      setAction(null);
    }
  };

  if (loading) {
    return (
      <section className="ai-settings ai-settings-loading" data-testid="ai-settings-dialog" aria-busy="true">
        <p>正在读取 AI 设置…</p>
      </section>
    );
  }

  return (
    <section className="ai-settings" data-testid="ai-settings-dialog">
      <div className="ai-settings-toolbar">
        <button className="review-back-button" type="button" onClick={onBack}>返回</button>
        <span className={hasUnsavedChanges ? 'settings-dirty-state is-dirty' : 'settings-dirty-state'}>
          {hasUnsavedChanges ? '有未保存更改' : '设置已同步'}
        </span>
      </div>

      <fieldset className="provider-options">
        <legend className="visually-hidden">AI 运行方式</legend>
        <label className={draft.provider === 'ollama' ? 'provider-option is-selected' : 'provider-option'}>
          <input
            className="visually-hidden"
            data-testid="ai-provider-ollama"
            type="radio"
            name="ai-provider"
            checked={draft.provider === 'ollama'}
            onChange={() => selectProvider('ollama')}
          />
          <strong>本地模型</strong>
          <span>Ollama · 笔记不离开本机</span>
        </label>
        <label className={draft.provider === 'cloud' ? 'provider-option is-selected' : 'provider-option'}>
          <input
            className="visually-hidden"
            data-testid="ai-provider-cloud"
            type="radio"
            name="ai-provider"
            checked={draft.provider === 'cloud'}
            onChange={() => selectProvider('cloud')}
          />
          <strong>云端模型</strong>
          <span>兼容 OpenAI API · 用户自备密钥</span>
        </label>
      </fieldset>

      {draft.provider === 'cloud' ? (
        <>
          <fieldset className="cloud-preset-options">
            <legend>服务预设</legend>
            <div>
              {CLOUD_PRESETS.map((preset) => (
                <label
                  className={cloudPreset === preset.id ? 'cloud-preset-option is-selected' : 'cloud-preset-option'}
                  key={preset.id}
                >
                  <input
                    className="visually-hidden"
                    data-testid={`ai-preset-${preset.id}`}
                    type="radio"
                    name="cloud-preset"
                    checked={cloudPreset === preset.id}
                    onChange={() => selectPreset(preset.id)}
                  />
                  <strong>{preset.label}</strong>
                  <small>{preset.description}</small>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="settings-section settings-credential-section">
            <div className="settings-section-heading">
              <div>
                <h3>API 密钥</h3>
                <p>只在本次输入时可见，保存后不会读回界面。</p>
              </div>
              <span className={settings.cloudCredentialConfigured && !savedBaseChanged && !clearCloudCredential ? 'credential-badge is-configured' : 'credential-badge'}>
                {clearCloudCredential
                  ? '保存后移除'
                  : credential.trim()
                    ? '待保存新密钥'
                    : savedBaseChanged
                      ? '新地址需密钥'
                      : settings.cloudCredentialConfigured
                        ? '已安全配置'
                        : '尚未配置'}
              </span>
            </div>
            <label className="coach-field settings-wide-field">
              <span className="visually-hidden">API 密钥</span>
              <span className="credential-input-shell">
                <input
                  data-testid="ai-api-key"
                  type={credentialVisible ? 'text' : 'password'}
                  value={credential}
                  autoComplete="new-password"
                  autoCapitalize="none"
                  maxLength={4096}
                  spellCheck={false}
                  disabled={clearCloudCredential}
                  placeholder={settings.cloudCredentialConfigured ? '输入新密钥可替换已保存密钥' : '输入 API 密钥'}
                  onChange={(event) => {
                    setCredential(event.target.value);
                    setClearCloudCredential(false);
                    setNotice(null);
                  }}
                />
                <button
                  data-testid="ai-api-key-visibility"
                  type="button"
                  disabled={!credential}
                  aria-label={credentialVisible ? '隐藏本次输入的 API 密钥' : '显示本次输入的 API 密钥'}
                  aria-pressed={credentialVisible}
                  onClick={() => setCredentialVisible((visible) => !visible)}
                >
                  {credentialVisible ? '隐藏' : '显示'}
                </button>
              </span>
            </label>
            {settings.cloudCredentialConfigured ? (
              <button
                className="credential-remove-button"
                type="button"
                onClick={() => {
                  setCredential('');
                  setCredentialVisible(false);
                  setClearCloudCredential((clear) => !clear);
                  setNotice(null);
                }}
              >
                {clearCloudCredential ? '保留已保存密钥' : '移除已保存密钥'}
              </button>
            ) : null}
          </div>

          <div className="settings-section">
            <div className="settings-section-heading">
              <div>
                <h3>API 基础地址</h3>
                <p>填写服务根地址或带版本路径的基础地址，不要填写完整对话接口。</p>
              </div>
            </div>
            <label className="coach-field settings-wide-field">
              <span className="visually-hidden">API 基础地址</span>
              <input
                data-testid="ai-base-url"
                type="url"
                value={draft.cloudBaseUrl}
                placeholder="https://api.example.com/v1"
                maxLength={2048}
                spellCheck="false"
                onChange={(event) => {
                  setCloudPreset('custom');
                  updateDraft((current) => ({ ...current, cloudBaseUrl: event.target.value }));
                }}
              />
            </label>
            <dl className="endpoint-preview">
              <div><dt>模型检测</dt><dd>{endpointPreview(draft.cloudBaseUrl, '/models')}</dd></div>
              <div><dt>学习教练</dt><dd>{endpointPreview(draft.cloudBaseUrl, '/chat/completions')}</dd></div>
            </dl>
            {savedBaseChanged && !credential.trim() ? (
              <p className="secure-storage-warning" role="status">
                API 地址已更改。为避免把旧密钥发送到新服务，请重新输入新地址对应的密钥。
              </p>
            ) : null}
            {!settings.secureStorageAvailable ? (
              <p className="secure-storage-warning">当前系统安全存储不可用，云端密钥将无法保存；请优先使用 Ollama。</p>
            ) : null}
          </div>
        </>
      ) : (
        <div className="settings-section">
          <div className="settings-section-heading">
            <div>
              <h3>Ollama 地址</h3>
              <p>仅允许本机回环地址，笔记内容不会离开当前设备。</p>
            </div>
          </div>
          <label className="coach-field settings-wide-field">
            <span className="visually-hidden">Ollama 地址</span>
            <input
              data-testid="ai-base-url"
              type="url"
              value={draft.ollamaBaseUrl}
              placeholder="http://127.0.0.1:11434"
              maxLength={2048}
              spellCheck="false"
              onChange={(event) => updateDraft((current) => ({ ...current, ollamaBaseUrl: event.target.value }))}
            />
          </label>
          <dl className="endpoint-preview">
            <div><dt>模型检测</dt><dd>{endpointPreview(draft.ollamaBaseUrl, '/api/tags')}</dd></div>
            <div><dt>学习教练</dt><dd>{endpointPreview(draft.ollamaBaseUrl, '/api/chat')}</dd></div>
          </dl>
        </div>
      )}

      <div className="settings-section settings-model-section">
        <div className="settings-section-heading">
          <div>
            <h3>模型 {models.length ? <span className="model-count">{models.length}</span> : null}</h3>
            <p>检测服务中的模型并选择；检测不可用时仍可手动填写。</p>
          </div>
          <button
            className="secondary-button model-discover-button"
            data-testid="ai-discover-models"
            type="button"
            disabled={action !== null || !activeBaseUrl.trim() || (savedBaseChanged && !credential.trim())}
            onClick={() => void discoverModels()}
          >
            {action === 'discover' ? '检测中…' : '检测模型'}
          </button>
        </div>

        {models.length ? (
          <div className="model-picker" data-testid="ai-model-list">
            <label className="model-search-field">
              <span className="visually-hidden">搜索检测到的模型</span>
              <input
                data-testid="ai-model-search"
                type="search"
                value={modelSearch}
                placeholder="搜索模型"
                onChange={(event) => setModelSearch(event.target.value)}
              />
            </label>
            <ul aria-label="检测到的模型">
              {filteredModels.length ? filteredModels.map((model) => (
                <li key={model.id}>
                  <button
                    className={activeModel === model.id ? 'is-selected' : ''}
                    type="button"
                    aria-pressed={activeModel === model.id}
                    onClick={() => selectActiveModel(model.id)}
                  >
                    <strong>{model.label || model.id}</strong>
                    {model.label && model.label !== model.id ? <small>{model.id}</small> : null}
                  </button>
                </li>
              )) : <li className="model-empty-state">没有匹配的模型</li>}
            </ul>
          </div>
        ) : discoveryAttempted && action !== 'discover' ? (
          <p className="model-empty-state">未取得模型列表，请使用下方输入框填写模型 ID。</p>
        ) : null}

        <label className="coach-field settings-wide-field">
          <span>当前模型 ID</span>
          <input
            data-testid="ai-model"
            type="text"
            value={activeModel}
            placeholder={draft.provider === 'cloud' ? '例如：gpt-5-mini' : '例如：qwen3:8b'}
            maxLength={200}
            spellCheck="false"
            onChange={(event) => selectActiveModel(event.target.value)}
          />
        </label>
      </div>

      <label className="consent-check is-muted">
        <input
          type="checkbox"
          checked={draft.supplementalKnowledge}
          onChange={(event) => {
            setDraft((current) => ({ ...current, supplementalKnowledge: event.target.checked }));
            setNotice(null);
          }}
        />
        <span>允许模型补充笔记之外的知识（将单独标记且不参与判分）</span>
      </label>
      <p className="settings-privacy-note">
        检测和连接测试不会保存设置，也不会发送笔记内容；密钥不会进入日志、笔记备份或模型提示词。
      </p>

      {notice ? (
        <div
          className={`settings-action-notice is-${notice.tone}`}
          data-testid="ai-settings-notice"
          role="status"
          aria-live="polite"
        >
          {notice.message}
        </div>
      ) : null}

      <div className="review-footer-actions settings-footer-actions">
        <button
          className="secondary-button"
          data-testid="ai-test-connection"
          type="button"
          disabled={action !== null || !activeBaseUrl.trim() || !activeModel.trim() || (savedBaseChanged && !credential.trim())}
          onClick={() => void testConnection()}
        >
          {action === 'test' ? '测试中…' : '测试草稿连接'}
        </button>
        <button
          className="review-primary-button is-compact"
          data-testid="ai-settings-save"
          type="button"
          disabled={
            action !== null
            || !activeBaseUrl.trim()
            || !activeModel.trim()
            || (draft.provider === 'cloud' && !settings.secureStorageAvailable && credential.trim().length > 0)
          }
          onClick={() => void saveConfiguration()}
        >
          {action === 'save' ? '正在保存…' : '保存设置'}
        </button>
      </div>
    </section>
  );
}
