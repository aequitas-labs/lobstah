import type { Config } from './config.js';

type GroundsConfig = Pick<Config, 'grounds'>;

/** Only the implicit local grounds has a legacy identity; explicit names are never aliases. */
export function displayGrounds(id: string, cfg: GroundsConfig): string {
  return Object.keys(cfg.grounds).length === 0 && id === 'fleet' ? 'home' : id;
}

/** Local storage remains fleet permanently, including beside an older CLI/daemon. */
export function storageGrounds(name: string, cfg: GroundsConfig): string {
  return Object.keys(cfg.grounds).length === 0 && name === 'home' ? 'fleet' : name;
}
