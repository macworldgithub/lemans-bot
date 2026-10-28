import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';

import './index.css';

// Two pages only, so a path switch is enough (Vite serves index.html for both).
// Lazy so each page only downloads the code it needs.
const DemoPage = lazy(() => import('./pages/DemoPage'));
const MonitorPage = lazy(() => import('./pages/MonitorPage'));

const isMonitor = window.location.pathname.replace(/\/+$/, '') === '/monitor';
document.title = isMonitor ? 'LeMans Call Monitor' : 'LeMans Entertainment — AI Receptionist Demo';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>{isMonitor ? <MonitorPage /> : <DemoPage />}</Suspense>
  </StrictMode>,
);
