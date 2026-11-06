import { localBackend } from '../../../../packages/glass-ui/ui/backends/local.js';
import { startGlassPage } from '../../../../packages/glass-ui/ui/start.js';

/** The capability test's page: the local glass on a source that fills five tabs and takes no optional action. */
startGlassPage({
  ...localBackend,
  capabilities: { tabs: ['deck', 'dispatches', 'traps', 'reports', 'reviews'], actions: new Set() },
});
