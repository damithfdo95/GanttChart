import { useRef } from 'react';

interface CsvFileButtonProps {
  /** Button label (already localized by the caller). */
  label: string;
  /** The accept attribute for the hidden file input. */
  accept?: string;
  disabled?: boolean;
  /** Extra class for the button (e.g. 'btn-ghost'). */
  className?: string;
  /** Called with the raw text of the chosen file (UTF-8 decoded). */
  onText: (text: string, fileName: string) => void;
}

/**
 * A button that opens a file picker for a CSV file and hands the raw text to
 * the caller (the Overall import idiom: a hidden input + click-through, so
 * the same file can be picked twice in a row).
 */
export function CsvFileButton({ label, accept = '.csv,text/csv', disabled, className = 'btn', onText }: CsvFileButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        {label}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="visually-hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            const reader = new FileReader();
            reader.onload = () => onText(String(reader.result ?? ''), file.name);
            reader.readAsText(file); // UTF-8 (the app's own exports carry a BOM)
          }
          e.target.value = ''; // allow re-importing the same file
        }}
      />
    </>
  );
}
