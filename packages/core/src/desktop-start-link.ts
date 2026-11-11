/** A launch card points to a prefilled composer or a saved Claude Code session, never a terminal fallback. */
export interface DesktopAppStart { profile: string; url: string }

/** Keep custom app navigation limited to the documented Claude Code start and session links. */
export function validDesktopStartLink(value: string): boolean {
  if (/^claude:\/\/claude\.ai\/[A-Za-z0-9_/-]+$/.test(value)) return true;
  try {
    const url = new URL(value), folder = url.searchParams.get('folder'), prompt = url.searchParams.get('q');
    return value.length <= 8192 && url.protocol === 'claude:' && url.host === 'code' && url.pathname === '/new' && !url.hash && !url.username && !url.password &&
      !!folder && (folder.startsWith('/') || /^[A-Za-z]:[\\/]/.test(folder)) && !!prompt && prompt.length <= 4096 && [...url.searchParams.keys()].every((key) => key === 'folder' || key === 'q');
  } catch { return false; }
}

/** Prefill only the sign-on instruction; the actual catch stays queued until the app session parks. */
export function desktopStartLink(folder: string, prompt: string): string {
  const url = `claude://code/new?${new URLSearchParams({ q: prompt, folder })}`;
  if (!validDesktopStartLink(url)) throw new Error('invalid Claude Code start link');
  return url;
}
