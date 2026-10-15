import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { loadRuntimeConfig, type RuntimeConfig } from './app/config';
import { setDisplayTimeZone } from './lib/format';
import './index.css';

const root = createRoot(document.getElementById('root')!);

async function start(): Promise<{ config: RuntimeConfig; demo: boolean }> {
  // Mock mode (npm run dev:mock): fictional sample data, no Cognito/API. Never bundled otherwise.
  if (import.meta.env.VITE_MOCK === '1') {
    const mock = await import('./mock/mock-api');
    mock.installMockApi(mock.MOCK_CONFIG);
    return { config: mock.MOCK_CONFIG, demo: true };
  }
  return { config: await loadRuntimeConfig(), demo: false };
}

start()
  .then(({ config, demo }) => {
    setDisplayTimeZone(config.timeZone);
    root.render(
      <StrictMode>
        <App config={config} demo={demo} />
      </StrictMode>,
    );
  })
  .catch((err: Error) => {
    root.render(
      <div style={{ padding: 24, fontFamily: 'system-ui', color: '#0b0b0b' }}>
        <h1 style={{ fontSize: 18 }}>Configuration error</h1>
        <p style={{ color: '#52514e' }}>{err.message}</p>
      </div>,
    );
  });
