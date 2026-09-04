import { createRoot } from 'react-dom/client';
import App from './App.js';
import '../styles.css';

let rootElement = document.getElementById('root');

if (!rootElement) {
  rootElement = document.createElement('div');
  rootElement.id = 'root';
  document.body.replaceChildren(rootElement);
}

createRoot(rootElement).render(<App />);
