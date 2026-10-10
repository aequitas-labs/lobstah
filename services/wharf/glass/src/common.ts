import { useEffect, useRef, useState } from 'preact/hooks';
import { html } from '../../../../apps/cli/glass/src/html.js';
import { fileUrl } from './api.js';
import { resume } from './model.js';
import type { WharfFile, Worker } from './model.js';
export { html };
export const value = (e: Event) => (e.currentTarget as HTMLInputElement).value;
export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : 'unknown');
export type Action = (path: string, body: unknown) => Promise<boolean>;
export function Copy({ command }: { command: string }) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setError(false);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1000);
    } catch {
      setError(true);
    }
  };
  return html`<div class="cmd"><code>${command}</code><button aria-label="copy command" title=${copied ? 'copied' : 'copy command'} onClick=${copy}>${copied ? '✓' : '⧉'}</button><span role="status">${copied ? 'copied' : error ? 'select the command to copy' : ''}</span></div>`;
}
export function Session({ worker }: { worker: Worker }) {
  const command = resume(worker);
  return html`<div class="sec">session · on ${worker.boatName}</div><div class="sub">Run on that boat; this page cannot open a remote window.</div>${command ? html`<${Copy} command=${command} />` : html`<div class="dim">resume command unknown</div>`}`;
}
export function Files({ files, kind, id }: { files: WharfFile[]; kind: 'documents' | 'dispatches'; id: string }) {
  return files.map(
    (f) =>
      html`<div class="dfile"><a href=${fileUrl(kind, id, f.id)} download=${f.name}>${f.name}</a> <span class="dim">${f.size} bytes</span></div>`,
  );
}
/** Uploaded raster images only: no external paths, raw SVG/HTML or data URLs. */
export function OwnedImage({
  file,
  document: id,
  alt,
  kind = 'documents',
}: {
  file: WharfFile;
  document: string;
  alt: string;
  kind?: 'documents' | 'dispatches';
}) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let disposed = false,
      objectUrl: string | undefined;
    (async () => {
      const res = await fetch(fileUrl(kind, id, file.id), { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return;
      const bytes = new Uint8Array(await res.arrayBuffer());
      const mime =
        bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71
          ? 'image/png'
          : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
            ? 'image/jpeg'
            : /^GIF8[79]a$/.test(new TextDecoder().decode(bytes.slice(0, 6)))
              ? 'image/gif'
              : new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP'
                ? 'image/webp'
                : undefined;
      if (!mime || disposed) return;
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
      setUrl(objectUrl);
    })().catch(() => {});
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.id, id, kind]);
  return url ? html`<img class="mdimg" src=${url} alt=${alt} />` : html`<span class="dim">[image not shown: ${alt}]</span>`;
}
