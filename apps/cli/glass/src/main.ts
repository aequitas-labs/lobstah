import { localBackend } from '../../../../packages/glass-ui/ui/backends/local.js';
import { startGlassPage } from '../../../../packages/glass-ui/ui/start.js';

/** The local glass: the shared glass UI, reading from and writing to the daemon that serves this page. */
startGlassPage(localBackend);
