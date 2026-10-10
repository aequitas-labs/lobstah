/** Portable remote identity; never includes credentials, query strings or local paths. */
export function canonicalRepoRemote(value: string): string {
  let host: string; let pathname: string;
  const scp = /^(?:[^@\s/:]+@)?([^\s/:]+):(.+)$/.exec(value);
  if (!value.includes('://') && scp) {
    host = scp[1]; pathname = scp[2];
  } else {
    let u: URL;
    try { u = new URL(value); } catch { throw new Error('no usable git remote'); }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(u.protocol) || u.search || u.hash || u.password || (u.username && u.protocol !== 'ssh:')) throw new Error('no usable git remote');
    host = u.hostname; pathname = u.pathname;
    if (u.port && !(u.protocol === 'ssh:' && u.port === '22')) host += `:${u.port}`;
  }
  host = host.toLowerCase();
  pathname = pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (!/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?$/.test(host) || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(pathname) || pathname.split('/').some((s) => s === '.' || s === '..')) throw new Error('no usable git remote');
  // GitHub repository names are case insensitive. Other hosts retain path case.
  if (host === 'github.com') pathname = pathname.toLowerCase();
  const identity = `${host}/${pathname}`;
  if (identity.length > 512) throw new Error('git remote identity exceeds 512 characters');
  return identity;
}

export function validateRepoIdentity(value: unknown): string {
  if (typeof value !== 'string' || canonicalRepoRemote(`https://${value}`) !== value) throw new Error('invalid canonical repo identity');
  return value;
}
