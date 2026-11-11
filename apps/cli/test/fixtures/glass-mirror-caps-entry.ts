import { localBackend } from '../../../../packages/glass-ui/ui/backends/local.js';
import { MIRROR_CAPABILITIES } from '../../../../packages/glass-ui/ui/backends/mirror.js';
import { startGlassPage } from '../../../../packages/glass-ui/ui/start.js';

/** The mirror parity test's reference: the local page's entry, on the mirror's capabilities, with no host parts. */
startGlassPage({ ...localBackend, capabilities: MIRROR_CAPABILITIES });
