import { createRoot } from 'react-dom/client';
import Studio from '../app/Studio';
import '../app/globals.css';

const root = document.getElementById('root');
if (!root) throw new Error('Pixel Studio: root element not found');
createRoot(root).render(<Studio />);
