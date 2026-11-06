import { render } from 'preact';
import { html } from '../../../../packages/glass-ui/ui/html.js';
import { App } from './app.js';
render(html`<${App} />`, document.body);
