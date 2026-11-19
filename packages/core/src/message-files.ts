/** File types accepted by messages and card answers, shared with the wharf. */
export const MESSAGE_FILE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.log': 'text/plain', '.diff': 'text/plain',
  '.patch': 'text/plain', '.yaml': 'text/plain', '.yml': 'text/plain', '.toml': 'text/plain', '.zip': 'application/zip',
};
export function messageFileType(name: string, bytes?: Uint8Array): string | undefined {
  const ext = /\.[^.]+$/.exec(name)?.[0]?.toLowerCase() ?? '';
  const type = MESSAGE_FILE_TYPES[ext];
  if (!type || !bytes) return type;
  const signature = (offset: number, value: number[]) => value.every((b, i) => bytes[offset + i] === b);
  if (ext === '.png' && !signature(0, [137,80,78,71,13,10,26,10])) return;
  if ((ext === '.jpg' || ext === '.jpeg') && !signature(0, [255,216,255])) return;
  if (ext === '.gif' && !signature(0, [71,73,70,56])) return;
  if (ext === '.webp' && (!signature(0, [82,73,70,70]) || !signature(8, [87,69,66,80]))) return;
  if (ext === '.pdf' && !signature(0, [37,80,68,70,45])) return;
  if (ext === '.zip' && !signature(0, [80,75])) return;
  return type;
}
