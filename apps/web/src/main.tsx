import './no-eval.js'; // first: it must run before any schema is built
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const client = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 2000 } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
