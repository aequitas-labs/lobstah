import { serveWatchPlugin } from '../plugin-server.js';
import { DeploymentWatchType, deploymentActionSchemas } from './index.js';

/** Installed executable entry point; source behavior stays in DeploymentWatchType. */
await serveWatchPlugin(new DeploymentWatchType(), { actionSchemas: deploymentActionSchemas });
