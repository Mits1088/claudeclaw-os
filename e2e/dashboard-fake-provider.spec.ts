import { test, expect, type Page } from '@playwright/test';

type ProviderType = 'opencode' | 'gemini' | 'acp-codex' | 'claude' | 'acp' | 'openai' | 'openrouter' | 'anthropic-compatible';

// Mirrors src/provider-registry.ts with the experimental tier enabled. The
// Settings provider section renders only when /api/health advertises more than
// one provider, and the sidebar quick-switch only when /api/provider/status
// does — so both fakes must carry it. `codex` is deliberately absent: the
// renamed ACP provider is offered as acp-codex and nothing else.
const PROVIDER_OPTIONS = [
  { type: 'claude', label: 'Claude', tier: 'stable' },
  { type: 'anthropic-compatible', label: 'Z.ai (GLM)', tier: 'experimental' },
  { type: 'openai', label: 'OpenAI', tier: 'stable' },
  { type: 'acp-codex', label: 'Codex (ACP)', tier: 'experimental' },
  { type: 'gemini', label: 'Gemini', tier: 'experimental' },
  { type: 'opencode', label: 'OpenCode', tier: 'experimental' },
  { type: 'openrouter', label: 'OpenRouter', tier: 'experimental' },
  { type: 'acp', label: 'Custom ACP', tier: 'experimental' },
];

async function installFakeDashboard(page: Page) {
  let provider: { type: ProviderType; command?: string; args?: string[]; model?: string; runtimeMode?: string; thinkingMode?: string } = { type: 'opencode' };
  let processing = false;
  let aborts = 0;

  await page.addInitScript(() => {
    class MockEventSource extends EventTarget {
      url: string;
      readyState = 1;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(url: string) {
        super();
        this.url = url;
        (window as any).__mockEventSources = (window as any).__mockEventSources || [];
        (window as any).__mockEventSources.push(this);
        setTimeout(() => this.onopen?.(new Event('open')), 0);
      }

      close() {
        this.readyState = 2;
      }
    }
    (window as any).EventSource = MockEventSource;
    (window as any).__emitSse = (eventName: string, data: unknown) => {
      const sources = (window as any).__mockEventSources || [];
      for (const source of sources) {
        source.dispatchEvent(new MessageEvent(eventName, { data: JSON.stringify(data) }));
      }
    };
  });

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });

    if (path === '/api/health') {
      return json({
        contextPct: 12,
        turns: 4,
        model: provider.model || (provider.type === 'claude' ? 'claude-opus-4-6' : provider.type === 'acp-codex' ? 'gpt-5.5' : provider.type),
        provider,
        providerType: provider.type,
        runtime: provider.type === 'acp' ? `${provider.command} ${(provider.args || []).join(' ')}`.trim() : provider.type,
        providers: PROVIDER_OPTIONS,
        killSwitches: {
          WARROOM_TEXT_ENABLED: true,
          WARROOM_VOICE_ENABLED: true,
          LLM_SPAWN_ENABLED: true,
          DASHBOARD_MUTATIONS_ENABLED: true,
          MISSION_AUTO_ASSIGN_ENABLED: true,
          SCHEDULER_ENABLED: true,
        },
        killSwitchRefusals: {},
      });
    }
    if (path === '/api/provider/status') {
      return json({
        provider,
        providerType: provider.type,
        label: provider.type === 'claude' ? 'Claude' : provider.type === 'opencode' ? 'OpenCode' : provider.type === 'gemini' ? 'Gemini' : provider.type === 'acp-codex' ? 'Codex (ACP)' : 'ACP',
        runtime: provider.type === 'acp' ? `${provider.command} ${(provider.args || []).join(' ')}`.trim() : provider.type,
        model: provider.model || (provider.type === 'claude' ? 'claude-opus-4-6' : provider.type === 'acp-codex' ? 'gpt-5.5' : provider.type === 'gemini' ? 'Gemini CLI default' : 'OpenCode default'),
        providers: PROVIDER_OPTIONS,
      });
    }
    if (path === '/api/security/status') return json({});
    if (path === '/api/agents') {
      const model = provider.model || (provider.type === 'claude' ? 'claude-opus-4-6' : provider.type === 'openai' ? 'gpt-5.5' : 'fake-model');
      const nativeRuntime = provider.type === 'claude' || provider.type === 'openai';
      return json({
        agents: [
          {
            id: 'main', name: 'Main', description: '', model, running: true, todayTurns: 2, todayCost: 0, provider,
            runtimeMode: provider.runtimeMode || '', thinkingMode: provider.thinkingMode || '',
            runtimeOptions: nativeRuntime ? {
              modeLabel: 'Effort', thinkingLabel: 'Thinking',
              modeOptions: [{ id: '', label: 'Default' }, { id: 'low', label: 'Low' }, { id: 'high', label: 'High' }],
              thinkingOptions: [{ id: '', label: 'Default' }, { id: 'on', label: 'On' }, { id: 'off', label: 'Off' }],
            } : null,
          },
        ],
        claudeModels: [{ id: 'claude-opus-4-6', label: 'Opus 4.6' }, { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }],
        openaiModels: [{ id: 'gpt-5.5', label: 'GPT-5.5' }, { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' }],
      });
    }
    if (path === '/api/chat/history') return json({ turns: [] });
    if (path === '/api/agents/main/tokens') return json({ todayCost: 0, todayTurns: 0, allTimeCost: 0 });
    if (path === '/api/providers/models') {
      // The real endpoint canonicalizes a legacy `codex` query to acp-codex and
      // echoes the canonical id back; mirror that so the fake stays faithful.
      const requested = url.searchParams.get('provider') || 'opencode';
      const selected = requested === 'codex' ? 'acp-codex' : requested;
      return json({
        provider: selected,
        models: selected === 'acp-codex'
          ? [{ id: 'gpt-5.5', label: 'GPT-5.5' }, { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' }]
          : selected === 'claude'
            ? [{ id: 'claude-opus-4-6', label: 'Opus 4.6' }]
            : [{ id: selected + '-default', label: selected + ' default' }],
        defaultModel: selected === 'acp-codex' ? 'gpt-5.5' : selected === 'claude' ? 'claude-opus-4-6' : selected === 'openai' ? 'gpt-5.5' : selected + '-default',
        selectable: true,
        allowCustom: true,
      });
    }
    if (path === '/api/providers/runtime-options') {
      const requested = url.searchParams.get('provider') || 'opencode';
      const selected = requested === 'codex' ? 'acp-codex' : requested;
      return json({
        provider: selected,
        source: selected === 'claude' ? 'static' : 'provider',
        modeOptions: selected === 'acp-codex'
          ? []
          : [{ id: 'fast', label: 'Fast' }, { id: 'normal', label: 'Normal' }, { id: 'deep', label: 'Deep' }],
        thinkingOptions: selected === 'acp-codex'
          ? [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }, { id: 'xhigh', label: 'Extra high' }]
          : [{ id: 'auto', label: 'Auto' }, { id: 'off', label: 'Off' }, { id: 'on', label: 'On' }],
      });
    }
    if (path === '/api/agents/main/provider' && req.method() === 'PATCH') {
      const body = JSON.parse(req.postData() || '{}');
      provider = body.provider;
      return json({ ok: true, agent: 'main', provider, restartRequired: false });
    }
    if (path === '/api/agents/main/model' && req.method() === 'PATCH') {
      const body = JSON.parse(req.postData() || '{}');
      provider = { ...provider, model: body.model };
      return json({ ok: true, agent: 'main', model: body.model, changed: true, sessionReset: true, restartRequired: false, cleared: [] });
    }
    if (path === '/api/agents/main/runtime' && req.method() === 'PATCH') {
      const body = JSON.parse(req.postData() || '{}');
      provider = { ...provider, ...body };
      return json({ ok: true, agent: 'main', changed: true, sessionReset: false, restartRequired: false, ...body });
    }
    if (path === '/api/chat/send' && req.method() === 'POST') {
      processing = true;
      return json({ ok: true });
    }
    if (path === '/api/chat/abort' && req.method() === 'POST') {
      aborts += 1;
      processing = false;
      await page.evaluate(() => {
        (window as any).__emitSse('processing', { processing: false });
      });
      return json({ ok: true, aborted: true, aborts });
    }

    return json({ ok: true, processing });
  });
}

test.beforeEach(async ({ page }) => {
  await installFakeDashboard(page);
});

test('sidebar runtime is a read-only provider and model summary', async ({ page }) => {
  await page.goto('/agents?token=test&chatId=e2e');

  const runtime = page.getByLabel('System status');
  await expect(runtime).toBeVisible();
  await expect(runtime.getByText('Runtime', { exact: true })).toBeVisible();
  await expect(runtime.getByText('OpenCode', { exact: true })).toBeVisible();
  await expect(runtime.getByText('Model', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Switch main provider')).toHaveCount(0);
});

test('agent cards keep a general settings entry and add direct provider controls', async ({ page }) => {
  await page.goto('/agents?token=test&chatId=e2e');
  const card = page.getByRole('group', { name: 'Main agent', exact: true });
  const settingsButton = card.getByRole('button', { name: 'Open settings for Main' });
  const providerButton = card.getByRole('button', { name: 'Configure provider for Main' });
  await expect(settingsButton).toBeVisible();
  await expect(providerButton).toHaveText('Model: OpenCode');
  await expect(card.getByRole('button', { name: 'Configure model for Main' })).toBeVisible();
  await expect(card.getByRole('combobox')).toHaveCount(0);
  await expect(card.getByLabel('Agent status')).toHaveText('Online');

  // Reading the activity summary remains inert.
  await card.getByLabel('Agent activity summary').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The provider name is a direct shortcut into the Provider section.
  await providerButton.click();
  let settings = page.getByRole('dialog', { name: 'Main · Agent settings' });
  await expect(settings.getByRole('button', { name: 'Provider', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(settings.getByRole('group', { name: 'Provider choices' })).toBeVisible();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();

  // The gear still opens the profile overview for less-frequent settings.
  await settingsButton.click();
  settings = page.getByRole('dialog', { name: 'Main · Agent settings' });
  await expect(settings.getByText('Set on Telegram')).toBeVisible();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(settings).toHaveCount(0);
});

test('Escape dismisses a themed model picker before closing agent settings', async ({ page }) => {
  await page.goto('/agents?token=test&chatId=e2e');
  test.skip(!await page.evaluate(() => CSS.supports('appearance', 'base-select')), 'Requires a customizable native select');
  await openProviderSettings(page);
  await selectProvider(page, 'claude');
  const settings = page.getByRole('dialog', { name: 'Main · Agent settings' });
  const picker = settings.getByRole('combobox', { name: 'Model', exact: true });
  await expect(picker).toBeEnabled();
  await picker.click();
  await expect(settings.locator('select:open')).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(settings.locator('select:open')).toHaveCount(0);
  await expect(settings).toBeVisible();
  await expect(settings.getByText('Discard unsaved changes?', { exact: true })).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(settings.getByText('Discard unsaved changes?', { exact: true })).toBeVisible();
});

test('native provider cards save model and runtime changes inline', async ({ page }) => {
  await page.goto('/agents?token=test&chatId=e2e');
  const card = page.getByRole('group', { name: 'Main agent', exact: true });

  await card.getByRole('button', { name: 'Configure provider for Main' }).click();
  await selectProvider(page, 'claude');
  await saveProvider(page);

  const model = card.getByRole('combobox', { name: 'Model', exact: true });
  await expect(model).toHaveValue('claude-opus-4-6');
  const modelRequest = page.waitForRequest((request) => request.url().includes('/api/agents/main/model') && request.method() === 'PATCH');
  await model.selectOption('claude-sonnet-4-6');
  expect((await modelRequest).postDataJSON()).toEqual({ model: 'claude-sonnet-4-6' });
  await expect(model).toHaveValue('claude-sonnet-4-6');

  const effort = card.getByRole('combobox', { name: 'Effort', exact: true });
  const runtimeRequest = page.waitForRequest((request) => request.url().includes('/api/agents/main/runtime') && request.method() === 'PATCH');
  await effort.selectOption('high');
  expect((await runtimeRequest).postDataJSON()).toEqual({ runtimeMode: 'high' });
  await expect(effort).toHaveValue('high');
});

test('provider settings use a compact picker on narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await page.goto('/agents?token=test&chatId=e2e');
  await openProviderSettings(page);

  const picker = page.getByRole('combobox', { name: 'Provider', exact: true });
  await expect(picker).toBeVisible();
  await expect(page.getByRole('group', { name: 'Provider choices' })).toBeHidden();
  await picker.selectOption('openai');
  await expect(picker).toHaveValue('openai');
  await expect(page.getByText('OpenAI configuration')).toBeVisible();
});

async function openProviderSettings(page: Page) {
  await page.getByRole('button', { name: 'Open settings for Main' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Provider', exact: true }).click();
}

async function selectProvider(page: Page, type: ProviderType) {
  const choice = page.getByRole('dialog').locator(`[data-provider="${type}"]`);
  await expect(choice).toBeVisible();
  await choice.click();
}

/**
 * Clicks "Save provider" and resolves only when THIS save's PATCH has come
 * back.
 *
 * The success toast is not a usable completion signal on its own: it stays
 * mounted from the previous iteration, so `getByText('Provider saved')`
 * resolves instantly against a stale toast. The loop would then move on while
 * the in-flight save was still settling, and the previous save's refresh
 * callback could clobber the selection that had just been made — which is
 * exactly how this test flaked (the Model select stayed on Gemini and never
 * loaded gpt-5.5 after acp-codex was picked).
 *
 * Arming waitForResponse BEFORE the click is what makes this race-free.
 */
async function saveProvider(page: Page) {
  const saveResponse = page.waitForResponse((response) =>
    response.url().includes('/api/agents/main/provider')
    && response.request().method() === 'PATCH');

  await page.getByRole('button', { name: /save provider/i }).click();
  const response = await saveResponse;
  expect(response.ok()).toBe(true);
  // Settings stay open after saving so another section can be edited.
  await expect(page.getByRole('button', { name: 'Reset', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('provider picker switches built-in and custom providers', async ({ page }) => {
  await page.goto('/agents?token=test&chatId=e2e');
  await openProviderSettings(page);

  await expect(page.getByText('Main · Agent settings')).toBeVisible();
  for (const provider of ['claude', 'opencode', 'gemini', 'acp-codex'] as ProviderType[]) {
    if (provider !== 'claude') await openProviderSettings(page);
    await selectProvider(page, provider);
    if (provider === 'acp-codex') {
      // The model list is fetched per provider, so wait for THIS provider's
      // options to land rather than selecting into the previous provider's
      // list (Gemini's, in the iteration order above).
      const modelPicker = page.getByRole('combobox', { name: 'Model', exact: true });
      await expect(modelPicker).toBeEnabled();
      await expect(modelPicker.locator('option[value="gpt-5.5"]')).toHaveCount(1);
      await modelPicker.selectOption('gpt-5.5');

      await expect(page.getByRole('button', { name: 'Extra high' })).toBeVisible();
      await page.getByRole('button', { name: 'Extra high' }).click();
    }
    await saveProvider(page);
  }

  await page.goto('/chat?token=test&chatId=e2e');
  await expect(page.getByRole('main').getByText('gpt-5.5')).toBeVisible();

  await page.goto('/agents?token=test&chatId=e2e');
  await openProviderSettings(page);
  await selectProvider(page, 'acp');
  await page.getByPlaceholder('my-acp-agent').fill('fake-acp');
  await page.getByPlaceholder('--acp').fill('--stdio --verbose');
  await saveProvider(page);
});

// Legacy boundary: `codex` was the pre-rename id for the Codex-over-ACP
// provider. It stays readable in persisted config and on API reads, but it must
// never be offered as its own choice in the UI — otherwise an operator can pick
// a provider id that no longer exists in the registry.
test('the provider picker offers acp-codex and never the legacy codex id', async ({ page }) => {
  await page.goto('/agents?token=test&chatId=e2e');
  await openProviderSettings(page);

  const choices = page.getByRole('dialog').locator('[data-provider]');
  const values = await choices.evaluateAll(
    (options) => options.map((option) => option.getAttribute('data-provider')),
  );

  expect(values).toContain('acp-codex');
  expect(values).toContain('openai');
  expect(values).not.toContain('codex');
});

test('dashboard status shows active provider and model in chat', async ({ page }) => {
  await page.goto('/chat?token=test&chatId=e2e');

  await expect(page.getByText('Stream live')).toBeVisible();
  await expect(page.getByRole('main').getByText('Model')).toBeVisible();
  await expect(page.getByRole('main').getByText('opencode')).toBeVisible();

  await page.goto('/agents?token=test&chatId=e2e');
  await openProviderSettings(page);
  await selectProvider(page, 'acp-codex');
  const modelPicker = page.getByRole('combobox', { name: 'Model', exact: true });
  await expect(modelPicker.locator('option[value="gpt-5.5"]')).toHaveCount(1);
  await modelPicker.selectOption('gpt-5.5');
  await saveProvider(page);

  await page.goto('/chat?token=test&chatId=e2e');
  await expect(page.getByLabel('System status').getByText('Codex (ACP)', { exact: true })).toBeVisible();
  await expect(page.getByRole('main').getByText('gpt-5.5')).toBeVisible();
});

test('chat sends a message, renders progress, streamed text, and keeps text selectable', async ({ page }) => {
  await page.goto('/chat?token=test&chatId=e2e');

  await page.getByPlaceholder('Type a message. Shift+Enter for newline.').fill('use the fake provider');
  await page.getByRole('button', { name: /send/i }).click();
  await page.evaluate(() => {
    (window as any).__emitSse('user_message', { content: 'use the fake provider', source: 'dashboard' });
    (window as any).__emitSse('processing', { processing: true });
    (window as any).__emitSse('progress', {
      description: 'Inspect fake plan',
      progressKind: 'plan',
      status: 'in_progress',
      planEntries: [{ content: 'Inspect fake plan', status: 'in_progress', priority: 'high' }],
      timestamp: Date.now(),
    });
    (window as any).__emitSse('progress', {
      description: 'Running fake tool',
      progressKind: 'tool_active',
      status: 'pending',
      toolCallId: 'tool-1',
      locations: [{ path: 'README.md', line: 12 }],
      timestamp: Date.now(),
    });
  });

  await expect(page.getByText('Inspect fake plan')).toBeVisible();
  await expect(page.getByText('Running fake tool').first()).toBeVisible();
  await expect(page.getByText('README.md:12')).toBeVisible();

  await page.evaluate(() => {
    (window as any).__emitSse('assistant_message', {
      content: 'Fake streamed provider reply with selectable text.',
      source: 'dashboard',
    });
    (window as any).__emitSse('processing', { processing: false });
  });
  const reply = page.getByText('Fake streamed provider reply with selectable text.');
  await expect(reply).toBeVisible();

  const selectable = await reply.evaluate((node) => getComputedStyle(node.closest('.select-text') || node).userSelect);
  expect(selectable).toBe('text');
});

test('provider tool progress renders once per tool id', async ({ page }) => {
  await page.goto('/chat?token=test&chatId=e2e');

  await page.getByPlaceholder('Type a message. Shift+Enter for newline.').fill('dedupe fake tool progress');
  await page.getByRole('button', { name: /send/i }).click();
  await page.evaluate(() => {
    (window as any).__emitSse('user_message', { content: 'dedupe fake tool progress', source: 'dashboard' });
    (window as any).__emitSse('processing', { processing: true });
    (window as any).__emitSse('progress', {
      description: 'Running fake tool',
      progressKind: 'tool_active',
      status: 'pending',
      toolCallId: 'tool-dedupe',
      locations: [{ path: 'README.md', line: 12 }],
      timestamp: Date.now(),
    });
    (window as any).__emitSse('progress', {
      description: 'Running fake tool',
      progressKind: 'tool_active',
      status: 'pending',
      toolCallId: 'tool-dedupe',
      locations: [{ path: 'README.md', line: 12 }],
      timestamp: Date.now() + 1,
    });
  });

  await expect(page.getByText('Running fake tool')).toHaveCount(2);
  await expect(page.getByText('README.md:12')).toHaveCount(1);
});

test('stop button aborts an active fake-provider turn', async ({ page }) => {
  await page.goto('/chat?token=test&chatId=e2e');

  await page.evaluate(() => {
    (window as any).__emitSse('processing', { processing: true });
  });
  await page.getByRole('button', { name: /stop/i }).click();
  await expect(page.getByRole('button', { name: /send/i })).toBeVisible();
});


test('Z.ai setup shows models, saves a masked key, and clears it on provider switch', async ({ page }) => {
  let configured = false;
  let savedBody: unknown;
  await page.route('**/api/providers/zai/setup*', async (route) => {
    if (route.request().method() === 'POST') {
      savedBody = route.request().postDataJSON();
      configured = true;
      return route.fulfill({ json: { saved: true, restartRequired: true } });
    }
    return route.fulfill({ json: { configured, enabled: true, ready: configured, canEdit: true, legacyKey: false, message: configured ? 'API key configured.' : 'Add your Z.ai API key to finish setup.' } });
  });
  await page.goto('/agents?token=test&chatId=e2e');
  await openProviderSettings(page);
  await selectProvider(page, 'anthropic-compatible');
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('anthropic-compatible-default');
  await expect(page.getByRole('button', { name: 'Save provider', exact: true })).toBeDisabled();
  const password = page.locator('input[aria-label="Z.ai API key"]');
  await expect(password).toHaveAttribute('type', 'password');
  await password.fill('synthetic-browser-key');
  await page.getByRole('button', { name: 'Save key', exact: true }).click();
  await expect(password).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save provider', exact: true })).toBeEnabled();
  expect(savedBody).toEqual({ apiKey: 'synthetic-browser-key' });
  await expect(page.getByText('Key saved. Restart other running agents', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Replace API key' }).click();
  await password.fill('unsaved-secret');
  await selectProvider(page, 'claude');
  await selectProvider(page, 'anthropic-compatible');
  await page.getByRole('button', { name: 'Replace API key' }).click();
  await expect(password).toHaveValue('');
});

test('Z.ai model failures remain visible and retry restores selection', async ({ page }) => {
  let fail = true;
  await page.route('**/api/providers/models*', async (route) => {
    if (new URL(route.request().url()).searchParams.get('provider') !== 'anthropic-compatible') return route.fallback();
    return route.fulfill({ status: fail ? 500 : 200, json: fail ? { error: 'Unavailable' } : { provider: 'anthropic-compatible', models: [{ id: 'glm-test', label: 'GLM test' }], defaultModel: 'glm-test', selectable: true } });
  });
  await page.route('**/api/providers/zai/setup*', (route) => route.fulfill({ json: { configured: true, enabled: true, ready: true, canEdit: true, legacyKey: false, message: 'API key configured.' } }));
  await page.goto('/agents?token=test&chatId=e2e');
  await openProviderSettings(page);
  await selectProvider(page, 'anthropic-compatible');
  await expect(page.getByText('Could not load models.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save provider', exact: true })).toBeDisabled();
  fail = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('glm-test');
  await expect(page.getByRole('button', { name: 'Save provider', exact: true })).toBeEnabled();
});


test('Z.ai preserves an existing custom endpoint when saving its model', async ({ page }) => {
  await page.route('**/api/agents?*', (route) => route.fulfill({ json: { agents: [{ id: 'main', name: 'Main', running: true, model: 'custom-glm', provider: { type: 'anthropic-compatible', model: 'custom-glm', baseUrl: 'https://example.com/anthropic' } }] } }));
  await page.route('**/api/providers/zai/setup*', (route) => {
    expect(new URL(route.request().url()).searchParams.get('baseUrl')).toBe('https://example.com/anthropic');
    return route.fulfill({ json: { configured: true, enabled: true, ready: true, canEdit: false, legacyKey: true, message: 'A custom endpoint is configured. Manage its credential in the server configuration.' } });
  });
  await page.goto('/agents?token=test&chatId=e2e');
  await openProviderSettings(page);
  await expect(page.getByText('A custom endpoint is configured.', { exact: false })).toBeVisible();
  await expect(page.locator('input[aria-label="Z.ai API key"]')).toHaveCount(0);
  const request = page.waitForRequest((req) => req.url().includes('/api/agents/main/provider') && req.method() === 'PATCH');
  await saveProvider(page);
  expect((await request).postDataJSON().provider).toMatchObject({ baseUrl: 'https://example.com/anthropic', model: 'custom-glm' });
});


test('Settings directs provider changes to the agent setup dialog', async ({ page }) => {
  await page.goto('/settings?token=test&chatId=e2e');
  await expect(page.getByRole('button', { name: 'Save provider' })).toHaveCount(0);
  await expect(page.getByLabel('Provider', { exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Manage agent providers' }).click();
  await expect(page).toHaveURL(/\/agents/);
  await openProviderSettings(page);
  await expect(page.getByText('Main · Agent settings')).toBeVisible();
});

test('OpenRouter setup shows models, saves a masked key, and clears it on provider switch', async ({ page }) => {
  let configured = false;
  let savedBody: unknown;
  await page.route('**/api/providers/openrouter/setup*', async (route) => {
    if (route.request().method() === 'POST') {
      savedBody = route.request().postDataJSON();
      configured = true;
      return route.fulfill({ json: { saved: true, restartRequired: true } });
    }
    return route.fulfill({ json: { configured, enabled: true, ready: configured, canEdit: true, legacyKey: false, message: configured ? 'API key configured.' : 'Add your OpenRouter API key to finish setup.' } });
  });
  await page.goto('/agents?token=test&chatId=e2e');
  await openProviderSettings(page);
  await selectProvider(page, 'openrouter');
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('openrouter-default');
  await expect(page.getByRole('button', { name: 'Save provider', exact: true })).toBeDisabled();
  const password = page.locator('input[aria-label="OpenRouter API key"]');
  await expect(password).toHaveAttribute('type', 'password');
  await password.fill('synthetic-browser-key');
  await page.getByRole('button', { name: 'Save key', exact: true }).click();
  await expect(password).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save provider', exact: true })).toBeEnabled();
  expect(savedBody).toEqual({ apiKey: 'synthetic-browser-key' });
  await expect(page.getByText('Key saved. OpenRouter will use it on the next turn.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Replace API key' }).click();
  await password.fill('unsaved-secret');
  await selectProvider(page, 'claude');
  await selectProvider(page, 'openrouter');
  await page.getByRole('button', { name: 'Replace API key' }).click();
  await expect(password).toHaveValue('');
});

test('OpenRouter search, free filter and server sort preserve the selected model', async ({ page }) => {
  const sorts: string[] = [];
  await page.route('**/api/providers/models*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get('provider') !== 'openrouter') return route.fallback();
    const sort = query.get('sort')!;
    sorts.push(sort);
    const models = [{ id: 'paid/model', label: 'paid/model', free: false }, { id: 'free/model', label: 'free/model', free: true }];
    if (sort !== 'most-popular') models.reverse();
    return route.fulfill({ json: { provider: 'openrouter', models, defaultModel: models[0].id, allowCustom: true, selectable: true } });
  });
  await page.route('**/api/providers/openrouter/setup*', (route) => route.fulfill({ json: { configured: true, enabled: true, ready: true, canEdit: true } }));
  await page.goto('/agents?token=test&chatId=e2e');
  await openProviderSettings(page);
  await selectProvider(page, 'openrouter');
  const model = page.getByRole('combobox', { name: 'Model', exact: true });
  await expect(model).toHaveValue('paid/model');
  const searchBounds = await page.getByRole('searchbox', { name: 'Search models' }).boundingBox();
  const modelBounds = await model.boundingBox();
  expect(searchBounds!.y).toBeLessThan(modelBounds!.y);
  await page.screenshot({ path: 'workspace/scratch/provider-polish.png' });
  await page.getByRole('checkbox', { name: 'Free only' }).check();
  await expect(model).toHaveValue('paid/model');
  await page.getByRole('searchbox', { name: 'Search models' }).fill('no-match');
  await expect(page.getByText('0 matches', { exact: false })).toBeVisible();
  await expect(model).toHaveValue('paid/model');
  await page.getByRole('combobox', { name: 'Sort models', exact: true }).selectOption('newest');
  await expect(model).toBeEnabled();
  await expect(model).toHaveValue('paid/model');
  await page.getByRole('combobox', { name: 'Sort models', exact: true }).selectOption('pricing-low-to-high');
  await expect(model).toBeEnabled();
  await expect(model).toHaveValue('paid/model');
  expect(sorts).toEqual(['most-popular', 'newest', 'pricing-low-to-high']);
  const request = page.waitForRequest((req) => req.url().includes('/api/agents/main/provider') && req.method() === 'PATCH');
  await saveProvider(page);
  expect((await request).postDataJSON().provider.model).toBe('paid/model');
});
