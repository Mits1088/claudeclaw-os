import type { Transformer } from 'grammy';
import { sanitizeOutboundText } from './outbound-sanitizer.js';
import { outboundOptionsForSeam } from './outbound-policy.js';

/** Scan complete text before formatting, splitting, or preview truncation. */
export function outboundText(text: string, seam: string): string {
  return sanitizeOutboundText(text, outboundOptionsForSeam(seam));
}

/** Tool arguments have arbitrary keys, unlike transport envelopes. */
export function serializeOutboundArguments(value: unknown, seam: string): string {
  const options = outboundOptionsForSeam(seam);
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') return sanitizeOutboundText(item, options);
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [sanitizeOutboundText(key, options), visit(child)]));
  };
  return JSON.stringify(visit(value));
}

// Explicit presentation fields only: routing identifiers and credentials used
// to authenticate the transport must not be rewritten.
const textFields = new Set([
  'text', 'content', 'description', 'message', 'caption', 'response', 'error',
  'delta', 'reason', 'label', 'tool', 'argsPreview', 'resultPreview', 'path',
  'title', 'url', 'file_name', 'filename', 'author_name', 'footer',
]);

// Only plain objects are rebuilt. Class instances (grammY InputFile, Buffer,
// streams, Date) keep their prototype: rebuilding an InputFile turns it into a
// plain object, grammY stops treating it as a multipart upload and Telegram
// rejects the JSON-serialised path as an invalid file URL.
function isPlainObject(item: object): boolean {
  const proto = Object.getPrototypeOf(item);
  return proto === Object.prototype || proto === null;
}

export function sanitizePresentation<T>(value: T, seam: string): T {
  const options = outboundOptionsForSeam(seam);
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== 'object' || !isPlainObject(item)) return item;
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [
      key, typeof child === 'string' && textFields.has(key)
        ? sanitizeOutboundText(child, options) : visit(child),
    ]));
  };
  return visit(value) as T;
}

export function serializeOutboundJson(value: unknown, seam: string): string {
  return JSON.stringify(sanitizePresentation(value, seam));
}

/** Installed on the real Telegram Api, including sends, edits and captions. */
export const outboundTelegramTransformer: Transformer = (prev, method, payload, signal) =>
  prev(method, sanitizePresentation(payload, 'telegram.api'), signal);
