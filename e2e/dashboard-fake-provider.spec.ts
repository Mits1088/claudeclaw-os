import { test, expect, type Page } from '@playwright/test';

type ProviderType = 'opencode' | 'gemini' | 'acp-codex' | 'claude' | 'acp';

// Mirrors src/provider-registry.ts with the experimental tier enabled. The
// Settings provider section renders only when /api/health advertises more than
// one provider, and the sidebar quick-switch only when /api/provider/status
// does — so both fakes must carry it. `codex` is deliberately absent: the
// renamed ACP provider is offered as acp-codex and nothing else.
const PROVIDER_OPTIONS = [
  { type: 'claude', label: 'Claude', tier: 'stable' },
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
      return json({
        agents: [
          { id: 'main', name: 'Main', description: '', model: 'fake-model', running: true, todayTurns: 2, todayCost: 0, provider },
        ],
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
        defaultModel: selected === 'acp-codex' ? 'gpt-5.5' : selected + '-default',
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

  const runtime = page.getByLabel('Active runtime');
  await expect(runtime).toBeVisible();
  await expect(runtime.getByText('Runtime', { exact: true })).toBeVisible();
  await expect(runtime.getByText('OpenCode', { exact: true })).toBeVisible();
  await expect(runtime.getByText('Model', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Switch main provider')).toHaveCount(0);
});

test('agent card uses explicit detail and provider-setup buttons', async ({ page }) => {
  await page.goto('/agents?token=test&chatId=e2e');

  const agentDetails = page.getByRole('button', { name: 'Open details for Main' });
  const providerSetup = page.getByRole('button', { name: 'Configure provider for Main' });
  await expect(agentDetails).toBeVisible();
  await expect(providerSetup).toBeVisible();
  await expect(
    page.getByLabel('Agent activity summary').getByText('running', { exact: true }),
  ).toBeVisible();

  // Neutral card content is no longer a hidden modal trigger.
  await page.getByText('Today turns', { exact: true }).click();
  await expect(page.getByText('Set on Telegram')).toHaveCount(0);

  await agentDetails.click();
  const agentModalContent = page.getByText('Set on Telegram');
  await expect(agentModalContent).toBeVisible();
  await agentModalContent
    .locator('xpath=ancestor::div[contains(@class, "fixed inset-0")][1]')
    .getByRole('button')
    .first()
    .click();
  await expect(agentModalContent).toHaveCount(0);

  await providerSetup.click();
  const providerModalTitle = page.getByText('Main Provider Setup');
  await expect(providerModalTitle).toBeVisible();
  await providerModalTitle
    .locator('xpath=ancestor::div[contains(@class, "fixed inset-0")][1]')
    .getByRole('button')
    .first()
    .click();
  await expect(providerModalTitle).toHaveCount(0);

  const agentDetailsBox = await agentDetails.boundingBox();
  const fileBox = await page.getByTitle('Edit persona + config').boundingBox();
  expect(agentDetailsBox).not.toBeNull();
  expect(fileBox).not.toBeNull();
  expect(Math.abs(agentDetailsBox!.height - fileBox!.height)).toBeLessThanOrEqual(1);
});

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
}

test('provider picker switches built-in and custom providers', async ({ page }) => {
  await page.goto('/settings?token=test&chatId=e2e');

  await expect(page.getByText('Agent provider')).toBeVisible();
  const picker = page.getByLabel('Provider', { exact: true });

  for (const provider of ['claude', 'opencode', 'gemini', 'acp-codex'] as ProviderType[]) {
    await picker.selectOption(provider);
    if (provider === 'acp-codex') {
      // The model list is fetched per provider, so wait for THIS provider's
      // options to land rather than selecting into the previous provider's
      // list (Gemini's, in the iteration order above).
      const modelPicker = page.getByLabel('Model');
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

  await page.goto('/settings?token=test&chatId=e2e');
  const customPicker = page.getByLabel('Provider', { exact: true });
  await customPicker.selectOption('acp');
  await page.getByPlaceholder('my-acp-agent').fill('fake-acp');
  await page.getByPlaceholder('--acp').fill('--stdio --verbose');
  await saveProvider(page);
  // Fresh page load, so no stale toast — the message is a real signal here.
  await expect(page.getByText('Provider saved').first()).toBeVisible();
});

// Legacy boundary: `codex` was the pre-rename id for the Codex-over-ACP
// provider. It stays readable in persisted config and on API reads, but it must
// never be offered as its own choice in the UI — otherwise an operator can pick
// a provider id that no longer exists in the registry.
test('the provider picker offers acp-codex and never the legacy codex id', async ({ page }) => {
  await page.goto('/settings?token=test&chatId=e2e');

  const picker = page.getByLabel('Provider', { exact: true });
  await expect(picker.locator('option[value="acp-codex"]')).toHaveCount(1);
  const values = await picker.locator('option').evaluateAll(
    (options) => options.map((option) => (option as HTMLOptionElement).value),
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

  await page.goto('/settings?token=test&chatId=e2e');
  await page.getByLabel('Provider', { exact: true }).selectOption('acp-codex');
  const modelPicker = page.getByLabel('Model');
  await expect(modelPicker.locator('option[value="gpt-5.5"]')).toHaveCount(1);
  await modelPicker.selectOption('gpt-5.5');
  await saveProvider(page);

  await page.goto('/chat?token=test&chatId=e2e');
  await expect(page.getByLabel('Active runtime').getByText('Codex (ACP)', { exact: true })).toBeVisible();
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
