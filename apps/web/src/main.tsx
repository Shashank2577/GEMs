import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './index.css';

// Start fetching the landing chunk in parallel with the app shell instead of after the router mounts (007/NFR-003).
if (location.pathname === '/') void import('./features/landing/LandingPage');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
