import type { Context, RawApi } from 'grammy';
import { ALLOWED_CHAT_ID, DASHBOARD_PORT, DASHBOARD_TOKEN, DASHBOARD_URL } from './config.js';
import { isLocked } from './security.js';

interface DashboardDelivery {
  url: string;
  prefix: string;
  token: string;
  suffix: string;
}

// Object identity is the capability. Text, URLs, and serialized payload fields
// cannot opt into this exception. Each request can consume it only once.
const deliveries = new WeakMap<object, DashboardDelivery>();

export function takeDashboardDelivery(method: string, payload: object): DashboardDelivery | undefined {
  const delivery = deliveries.get(payload);
  deliveries.delete(payload);
  if (!delivery) return;
  if (method !== 'sendMessage' || !ALLOWED_CHAT_ID || isLocked()
    || String((payload as { chat_id?: unknown }).chat_id) !== ALLOWED_CHAT_ID) return;
  return delivery;
}

function canOpenUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return host !== 'localhost' && !host.endsWith('.localhost')
    && !host.startsWith('127.') && host !== '[::1]' && host !== '0.0.0.0';
}

/** Called only by the built-in /dashboard handler, after its normal lock gate. */
export async function sendDashboardReply(ctx: Context): Promise<void> {
  // Unlike first-run chat onboarding, credential delivery requires a configured
  // owner. Recheck here so another caller cannot send to an arbitrary recipient.
  if (!ALLOWED_CHAT_ID || ctx.chat?.type !== 'private'
    || String(ctx.chat.id) !== ALLOWED_CHAT_ID || String(ctx.from?.id) !== ALLOWED_CHAT_ID
    || isLocked()) return;
  if (!DASHBOARD_TOKEN) {
    await ctx.reply('Dashboard not configured. Set DASHBOARD_TOKEN in .env and restart.');
    return;
  }

  let base: URL;
  try {
    base = new URL(DASHBOARD_URL || `http://localhost:${DASHBOARD_PORT}`);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password
      || base.search || base.hash) throw new Error('Invalid dashboard base URL');
  } catch {
    await ctx.reply('DASHBOARD_URL must be an HTTP or HTTPS address without credentials, query parameters, or a fragment.');
    return;
  }

  const prefix = `${base.href.replace(/\/+$/, '')}/?token=`;
  const token = encodeURIComponent(DASHBOARD_TOKEN);
  const suffix = `&chatId=${encodeURIComponent(ALLOWED_CHAT_ID)}`;
  const url = prefix + token + suffix;
  const openable = canOpenUrl(base);
  const buttons = [];
  if (openable) buttons.push({ text: 'Open Dashboard', url });
  // Telegram copy buttons accept at most 256 characters. Keep a visible-link
  // fallback when a long URL cannot use a copy button.
  const copyable = url.length <= 256;
  if (copyable) buttons.push({ text: 'Dashboard Link', copy_text: { text: url } });

  const payload: Parameters<RawApi['sendMessage']>[0] = {
    chat_id: ctx.chat.id,
    text: copyable
      ? 'Click the button to copy Dashboard Link to the clipboard.  Paste into browser to launch.'
      : `Dashboard:\n${url}\n\nCopy the link and paste it into a browser to launch.`,
    link_preview_options: { is_disabled: true },
    ...(buttons.length ? { reply_markup: { inline_keyboard: [buttons] } } : {}),
  };
  deliveries.set(payload, { url, prefix, token, suffix });
  try {
    // raw preserves the registered object's identity through the API transformer.
    await ctx.api.raw.sendMessage(payload);
  } finally {
    deliveries.delete(payload);
  }
}
