import * as fs from 'node:fs';
import * as path from 'node:path';
import { laneDirs } from './paths.js';
import type { Attachment, Lane } from './types.js';

export class AttachmentError extends Error {}

export function dispatchAttachmentsDir(id: string, lane: Lane): string {
  return path.join(laneDirs(lane).state, id, 'attachments');
}

export function trapAttachmentsDir(trapId: string): string {
  return path.join(laneDirs('work').inbox, `trap-${trapId}`, 'attachments');
}

function mimeType(name: string): string {
  switch (path.extname(name).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.pdf': return 'application/pdf';
    case '.txt':
    case '.md':
    case '.csv':
    case '.log': return 'text/plain';
    default: return 'application/octet-stream';
  }
}

/** Validate all sources before copying any, then own byte-for-byte copies. */
export function copyAttachments(files: string[], dir: string, maxBytes: number): Attachment[] {
  const sources = files.map((file) => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new AttachmentError(`attachment does not exist: ${file}`);
    }
    if (!stat.isFile()) throw new AttachmentError(`attachment is not a regular file: ${file}`);
    if (stat.size > maxBytes) throw new AttachmentError(`attachment exceeds ${maxBytes} bytes: ${file}`);
    return { file, bytes: stat.size, basename: path.basename(file) };
  });
  if (sources.length === 0) return [];
  fs.mkdirSync(dir, { recursive: true });
  const copied: string[] = [];
  try {
    return sources.map(({ file, basename }) => {
      const ext = path.extname(basename);
      const stem = basename.slice(0, basename.length - ext.length);
      let name = basename;
      let suffix = 2;
      let destination: string;
      while (true) {
        destination = path.resolve(dir, name);
        try {
          fs.copyFileSync(file, destination, fs.constants.COPYFILE_EXCL);
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
          name = `${stem}-${suffix++}${ext}`;
        }
      }
      copied.push(destination);
      const bytes = fs.statSync(destination).size;
      if (bytes > maxBytes) throw new AttachmentError(`attachment exceeds ${maxBytes} bytes: ${file}`);
      return { name, path: destination, bytes, type: mimeType(name) };
    });
  } catch (err) {
    for (const destination of copied) fs.rmSync(destination, { force: true });
    throw err;
  }
}

export function attachmentBlock(attachments: Attachment[]): string {
  if (attachments.length === 0) return '';
  return [
    '--- ATTACHMENTS ---',
    ...attachments.map((a) => `${a.name} (${a.type}, ${a.bytes} bytes) at ${a.path}`),
    'Images and PDFs can be read directly with your file tools.',
  ].join('\n');
}
