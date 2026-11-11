import { localBackend } from '../../../../packages/glass-ui/ui/backends/local.js';
import { WHARF_CAPABILITIES } from '../../../../packages/glass-ui/ui/backends/wharf.js';
import { startGlassPage } from '../../../../packages/glass-ui/ui/start.js';

/** The parity test's reference: the local page's entry, on the wharf's capabilities, with no host parts. */
startGlassPage({ ...localBackend, capabilities: WHARF_CAPABILITIES });
