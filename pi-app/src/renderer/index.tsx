import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { App } from './App';
import { i18n } from './i18n';
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/unbounded/wght.css';
import '@fontsource-variable/noto-sans-sc/index.css';
import './assets/typography.css';
import './assets/tokens.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('SleepClaw root element is missing');
createRoot(root).render(<React.StrictMode><I18nextProvider i18n={i18n}><App /></I18nextProvider></React.StrictMode>);
