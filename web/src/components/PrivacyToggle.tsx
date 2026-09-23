import { Eye, EyeOff } from 'lucide-preact';
import { privacyBlur, togglePrivacyBlur, type PrivacySection } from '@/lib/privacy';

// Button that flips the section's blur on/off. Lives in PageHeader.actions.
export function PrivacyToggle({ section }: { section: PrivacySection }) {
  const on = privacyBlur(section).value;
  return (
    <button
      type="button"
      onClick={() => togglePrivacyBlur(section)}
      title={on ? 'Reveal content' : 'Blur content (screenshot-safe)'}
      class={[
        'control-button inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-[12px] border transition-colors',
        on
          ? 'control-accent'
          : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-control-hover)] border-[var(--color-border)]',
      ].join(' ')}
    >
      {on ? <EyeOff size={13} /> : <Eye size={13} />}
      {on ? 'Blurred' : 'Blur'}
    </button>
  );
}
