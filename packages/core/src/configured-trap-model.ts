/** A repo-less worker profile, owned by exactly one grounds. */
export interface ConfiguredTrapProfile {
  harness: 'claude' | 'codex';
  surface: 'claude-desktop' | 'terminal';
  grounds: string;
  cwd?: string;
  terminal?: 'terminal' | 'iterm' | 'tmux';
  maxInstances: number;
}

/** Persisted profile identity; a working folder is never a git worktree. */
export interface ConfiguredTrapLocation {
  profile: string;
  grounds: string;
  surface: ConfiguredTrapProfile['surface'];
}

/** A dispatch served only by the named configured profile in its grounds. */
export interface ConfiguredTrapTarget extends ConfiguredTrapLocation {
  kind: 'configured-trap';
  parentDispatch?: string;
}

/** The repository side of the dispatch routing boundary. */
export interface RepoDispatchTarget {
  kind: 'repo';
  repo: string;
}

/** The complete desk instruction; tool approvals remain with the harness reviewer. */
export const CONFIGURED_TRAP_INSTRUCTION = 'You are a repo-less trap assigned an inspection or reversible UI step. File findings or screenshots for the original dispatch; its worker keeps ownership of repo changes and the PR.';
