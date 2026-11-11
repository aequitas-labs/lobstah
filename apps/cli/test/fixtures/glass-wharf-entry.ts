import { createWharfBackend } from '../../../../packages/glass-ui/ui/backends/wharf.js';
import { startGlassPage } from '../../../../packages/glass-ui/ui/start.js';

/** The shared glass UI on the wharf backend: what the hosted glass will mount once its entry switches. */
startGlassPage(createWharfBackend());
