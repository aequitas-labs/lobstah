/**
 * Split `report`'s trailing args into note and --pr URL. The note is
 * everything that isn't the --pr pair — in particular, with no --pr present
 * nothing is removed (a -1 index must not shadow index 0).
 */
export function parseReportArgs(rest: string[]): { note?: string; prUrl?: string } {
  const prIndex = rest.indexOf('--pr');
  const prUrl = prIndex >= 0 ? rest[prIndex + 1] : undefined;
  const note =
    rest.filter((_, i) => prIndex < 0 || (i !== prIndex && i !== prIndex + 1)).join(' ') || undefined;
  return { note, prUrl };
}
