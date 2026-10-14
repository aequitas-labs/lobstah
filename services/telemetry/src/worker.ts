// Only handlers are runtime exports. Validation helpers and constants stay
// available to tests without being interpreted as named Worker entry points.
export { default } from './index.js';
