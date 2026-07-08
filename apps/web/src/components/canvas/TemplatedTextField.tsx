import { useRef, useState, type CSSProperties } from 'react';
import clsx from 'clsx';
import { VariablePicker, type UpstreamNode, type VariablePickerOption } from './VariablePicker';



export interface TemplatedTextFieldProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** Render as a textarea instead of a single-line input. */
  multiline?: boolean;
  rows?: number;
  className?: string;
  style?: CSSProperties;
  /** Upstream nodes — populates `nodes.<id>` options. */
  upstream?: UpstreamNode[];
  /** Extra options — typically `scratchpad.*` and `store.*` known keys. */
  extras?: VariablePickerOption[];
  /** Monospace + lower-line-height (for code-shaped fields). */
  mono?: boolean;
  /** Optional `name`/`id` passthrough. */
  name?: string;
  id?: string;
  disabled?: boolean;
}

export function TemplatedTextField(props: TemplatedTextFieldProps) {
  const {
    value,
    onChange,
    placeholder,
    multiline = false,
    rows = 3,
    className,
    style,
    upstream = [],
    extras = [],
    mono = false,
    name,
    id,
    disabled = false,
  } = props;

  const inputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);

  function getEl(): HTMLInputElement | HTMLTextAreaElement | null {
    return multiline ? textareaRef.current : inputRef.current;
  }

  // Decide whether the picker should be open given the current caret position.
  // Rule: open when the caret is inside an unclosed `{{...` pair on the same
  // line, with no whitespace inside the query.
  function reconsiderOpen(next: string, nextCaret: number) {
    const before = next.slice(0, nextCaret);
    const lastOpen = before.lastIndexOf('{{');
    const lastClose = before.lastIndexOf('}}');
    if (lastOpen === -1 || lastOpen < lastClose) {
      setPickerOpen(false);
      return;
    }
    const fragment = before.slice(lastOpen + 2);
    if (/\s/.test(fragment)) {
      setPickerOpen(false);
      return;
    }
    setPickerOpen(true);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) {
    const next = e.target.value;
    const nextCaret = e.target.selectionStart ?? next.length;
    onChange(next);
    setCaret(nextCaret);
    reconsiderOpen(next, nextCaret);
  }

  function handleSelect(e: React.SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) {
    const target = e.currentTarget;
    const nextCaret = target.selectionStart ?? target.value.length;
    setCaret(nextCaret);
    reconsiderOpen(target.value, nextCaret);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (pickerOpen) {
      // Let the picker eat navigation keys.
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape') {
        // The picker is rendered below — forward by triggering its handler via
        // a synthetic event. Simplest: stash intent and let the picker pick up
        // on the next render. We instead bind keys directly here:
        e.preventDefault();
        // Trigger a pseudo-event on the picker's div via the ref-less API by
        // moving the active option in local state. We piggyback on the picker
        // child by simulating: actually simpler — let the picker handle it via
        // its onKeyDown (the picker div is focused after open). To keep this
        // truly simple, we route through window.dispatchEvent on the picker.
        const evt = new KeyboardEvent('keydown', { key: e.key, bubbles: true });
        document.querySelector('[data-templated-picker="1"]')?.dispatchEvent(evt);
      }
    }
  }

  // Helper passed to the picker so when it commits an option it can also move
  // the caret AFTER the inserted `{{path}}` block and close itself.
  function setValueWithCaretAfterInsertion(next: string) {
    onChange(next);
    setPickerOpen(false);
    // Move the caret to the position right after the closing `}}` of the
    // newly-inserted block. We compute it by diffing: assume the caller used
    // VariablePicker.commit which appends `{{...}}` at the open position.
    requestAnimationFrame(() => {
      const el = getEl();
      if (!el) return;
      // Find the first `}}` at or after the previous caret — that's the end
      // of the freshly inserted block.
      const idx = next.indexOf('}}', caret);
      const newCaret = idx === -1 ? next.length : idx + 2;
      el.focus();
      el.setSelectionRange(newCaret, newCaret);
      setCaret(newCaret);
    });
  }

  const sharedCls = clsx(
    'w-full rounded-input border border-line bg-surface-2 px-2 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none',
    mono && 'font-mono text-[11px]',
    multiline ? 'resize-none py-1.5' : 'h-8',
    disabled && 'cursor-not-allowed opacity-60',
    className,
  );

  return (
    <div className="relative">
      {multiline ? (
        <textarea
          ref={textareaRef}
          id={id}
          name={name}
          rows={rows}
          spellCheck={false}
          className={sharedCls}
          style={style}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onChange={handleChange}
          onSelect={handleSelect}
          onKeyDown={handleKeyDown}
          onBlur={() => setTimeout(() => setPickerOpen(false), 100)}
        />
      ) : (
        <input
          ref={inputRef}
          id={id}
          name={name}
          type="text"
          spellCheck={false}
          className={sharedCls}
          style={style}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onChange={handleChange}
          onSelect={handleSelect}
          onKeyDown={handleKeyDown}
          onBlur={() => setTimeout(() => setPickerOpen(false), 100)}
        />
      )}
      {pickerOpen && (
        <div
          data-templated-picker="1"
          className="absolute left-0 top-full z-50 mt-1"
        >
          <VariablePicker
            value={value}
            onChange={setValueWithCaretAfterInsertion}
            caret={caret}
            upstream={upstream}
            extras={extras}
            onDismiss={() => setPickerOpen(false)}
          />
        </div>
      )}
    </div>
  );
}



