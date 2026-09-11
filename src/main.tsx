import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/manrope';
import App from './App';
import './styles.css';

// JS updates must replace the RAF/WebGL/sensor closures together. Preserving
// component state can otherwise leave an old projection running behind new UI.
if (import.meta.hot) {
  const reloadRuntime = ({ updates }: { updates: { type: string }[] }) => {
    if (updates.some(update => update.type === 'js-update')) window.location.reload();
  };
  import.meta.hot.on('vite:beforeUpdate', reloadRuntime);
  import.meta.hot.dispose(() => import.meta.hot?.off('vite:beforeUpdate', reloadRuntime));
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
