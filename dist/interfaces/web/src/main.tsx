import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import GlobalStyle from './style/GlobalStyle.tsx';
import { StyleSheetManager } from 'styled-components';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StyleSheetManager>
      <GlobalStyle />
      <App />
    </StyleSheetManager>
  </StrictMode>,
);
