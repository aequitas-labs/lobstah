import { render } from 'preact';
import { html } from '../../../../apps/cli/glass/src/html.js';
import { App } from './app.js';
render(html`<${App} />`, document.body);
