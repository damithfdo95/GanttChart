import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Startup } from './app/Startup';
import { initPersistence } from './lib/storage/db/bootstrap';
import './index.css';

/**
 * Startup order (V6.6 §18): the persistence bootstrap runs BEFORE the React
 * application renders. It opens GanttChartDB, runs the localStorage →
 * IndexedDB migration when needed (verified, idempotent) and loads the
 * workspace — so an empty workspace can never overwrite pre-migration data.
 * The plain-DOM placeholder avoids rendering a false empty workspace while
 * the database work is in flight.
 */
const rootEl = document.getElementById('root')!;
rootEl.textContent = 'Loading… / 読み込み中…';

void initPersistence().then((boot) => {
  createRoot(rootEl).render(
    <StrictMode>
      <Startup boot={boot} />
    </StrictMode>,
  );
});
