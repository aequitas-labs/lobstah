/** Exact repository-relative files or directories, never globs or Git metadata. */
export function validIgnoreDirtyPath(value: string): boolean {
  const clean = value.replace(/\/$/, '');
  return clean.length > 0 && !/[\\\0:*?\[\]{}]/.test(clean) &&
    !clean.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git');
}
