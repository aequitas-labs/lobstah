import { expect, it } from 'vitest';
import { canonicalRepoRemote, validateRepoIdentity } from '../src/repo-identity.js';

it('normalises HTTPS, scp and SSH forms, host case and GitHub path case', () => {
  for (const remote of ['https://GitHub.com/Owner/Repo.git', 'git@github.com:owner/repo.git', 'ssh://git@GITHUB.COM:22/OWNER/REPO.git']) {
    expect(canonicalRepoRemote(remote)).toBe('github.com/owner/repo');
  }
  expect(canonicalRepoRemote('ssh://git@Forge.test/Group/Repo.git')).toBe('forge.test/Group/Repo');
  expect(validateRepoIdentity('forge.test/Group/Repo')).toBe('forge.test/Group/Repo');
});
it('rejects paths, credentials, missing owner/name and ambiguous or noncanonical identities', () => {
  for (const remote of ['/tmp/repo', 'file:///tmp/repo', 'https://user:secret@github.com/o/r', 'https://github.com/o/r?token=x', 'https://github.com/r', 'git@github.com:o/../r']) {
    expect(() => canonicalRepoRemote(remote)).toThrow();
  }
  expect(() => validateRepoIdentity('GitHub.com/O/R')).toThrow();
  expect(() => validateRepoIdentity('github.com/o/r.git')).toThrow();
});
