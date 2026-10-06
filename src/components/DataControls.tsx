import { useRef } from 'react';

export interface ImportMessage {
  kind: 'ok' | 'error';
  text: string;
}

export interface DataControlsLabels {
  export: string;
  import: string;
  reset: string;
}

interface DataControlsProps {
  labels: DataControlsLabels;
  message: ImportMessage | null;
  onExport: () => void;
  onImportFile: (file: File) => void;
  onReset: () => void;
}

/**
 * Local JSON export / import / reset controls (§22–§23).
 * Uses only browser file APIs (input type="file", Blob, FileReader,
 * URL.createObjectURL). The selected file is never sent anywhere.
 */
export function DataControls({ labels, message, onExport, onImportFile, onReset }: DataControlsProps) {
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="data-controls">
      <button type="button" className="btn" onClick={onExport}>
        {labels.export}
      </button>
      <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
        {labels.import}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="visually-hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onImportFile(file);
          e.target.value = ''; // allow re-importing the same file
        }}
      />
      <button type="button" className="btn btn-danger" onClick={onReset}>
        {labels.reset}
      </button>
      {message ? (
        <span className={`data-controls-message ${message.kind}`} role="status" aria-live="polite">
          {message.text}
        </span>
      ) : null}
    </div>
  );
}
