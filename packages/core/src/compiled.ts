/**
 * Whether this process is a bun-compiled standalone binary (the no-Node
 * distribution channel). Under `bun build --compile`, Bun.main points into
 * the embedded virtual filesystem — plain `bun run` does not, so a dev run
 * under bun is not mistaken for the binary.
 */
export const COMPILED_BINARY: boolean = (() => {
  const bun = (globalThis as { Bun?: { main?: string } }).Bun;
  return bun !== undefined && String(bun.main ?? '').includes('$bunfs');
})();
