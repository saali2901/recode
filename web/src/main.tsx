import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'cleanui/src';
import '../../node_modules/cleanui/src/themes/contrast.css';
import '../../node_modules/cleanui/src/themes/coral.css';
import '../../node_modules/cleanui/src/themes/forest.css';
import '../../node_modules/cleanui/src/themes/harbor.css';
import '../../node_modules/cleanui/src/themes/midnight.css';
import '../../node_modules/cleanui/src/themes/mono.css';
import '../../node_modules/cleanui/src/themes/paper.css';
import './styles.css';
import { initToken } from './api';
import { App } from './App';
import { applyTheme, loadTheme } from './theme';

initToken();
applyTheme(loadTheme());

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
