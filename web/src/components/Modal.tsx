import { useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { X } from 'lucide-preact';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  width?: number;
  height?: string;
  bodyClassName?: string;
  closeDisabled?: boolean;
  children: ComponentChildren;
  footer?: ComponentChildren;
}

// A themed native picker sits above the dialog. Let it consume Escape first.
function hasOpenSelect() {
  return CSS.supports('selector(select:open)') && document.querySelector('select:open') !== null;
}

export function Modal({ open, onClose, title, width = 480, height, bodyClassName, closeDisabled, children, footer }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== dialogRef.current) return;
      if (e.key === 'Escape') {
        if (hasOpenSelect()) return;
        e.preventDefault();
        closeRef.current();
      }
      if (e.key === 'Tab') {
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])
          .filter((el) => el.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first) { e.preventDefault(); dialogRef.current?.focus(); }
        else if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKey);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      class="viewport-overlay fixed inset-0 z-[90] flex items-center justify-center p-4 bg-black/50"
      onClick={onClose}
    >
      <div
        role="dialog"
        ref={dialogRef}
        tabIndex={-1}
        aria-modal="true"
        aria-label={title}
        class="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl shadow-2xl flex flex-col min-w-0"
        style={{ width: width + 'px', height, outline: 'none', maxWidth: '100%', maxHeight: 'calc(var(--app-height) - 2rem)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="flex items-center px-5 py-3 border-b border-[var(--color-border)] shrink-0">
          <h2 class="text-[14px] font-semibold text-[var(--color-text)] min-w-0 break-words">{title}</h2>
          <button
            type="button"
            aria-label="Close dialog"
            disabled={closeDisabled}
            class="ml-auto p-1 rounded hover:bg-[var(--color-control-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
        <div class={bodyClassName ?? 'flex-1 min-h-0 overflow-y-auto px-5 py-4'}>{children}</div>
        {footer && (
          <div class="flex flex-wrap items-center gap-2 px-5 py-3 border-t border-[var(--color-border)] shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export function Drawer({ open, onClose, title, children }: Props) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !e.defaultPrevented && !hasOpenSelect()) onClose();
    }
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <div
        class={[
          'viewport-overlay fixed inset-0 z-[80] bg-black/50 transition-opacity',
          open ? 'opacity-100' : 'opacity-0 pointer-events-none',
        ].join(' ')}
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-label={title}
        aria-modal={open ? 'true' : undefined}
        aria-hidden={!open}
        class={[
          'fixed left-0 right-0 z-[81] bg-[var(--color-card)] border-t border-[var(--color-border)] rounded-t-xl shadow-2xl flex flex-col transition-transform',
          open ? 'translate-y-0' : 'translate-y-full pointer-events-none',
        ].join(' ')}
        style={{
          top: 'calc(var(--app-height) * 0.15)',
          height: 'calc(var(--app-height) * 0.85)',
          visibility: open ? 'visible' : 'hidden',
          transition: `transform 150ms ease, visibility 0s linear ${open ? '0s' : '150ms'}`,
        }}
      >
        <div class="flex items-center px-6 py-3 border-b border-[var(--color-border)] shrink-0">
          <div class="w-12 h-1 rounded-full bg-[var(--color-border)] mx-auto absolute left-1/2 -translate-x-1/2 top-1.5" />
          <h2 class="text-[13px] font-semibold text-[var(--color-text)]">{title}</h2>
          <button
            type="button"
            aria-label="Close panel"
            class="ml-auto p-1 rounded hover:bg-[var(--color-control-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto">{children}</div>
      </div>
    </>
  );
}
