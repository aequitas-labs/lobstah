/** Task markers are retained in goal lines so Markdown and recap facts agree. */
export function goalLine(line: string): { text: string; done: boolean } {
  const task = /^\[([ xX])\]\s+(.*)$/.exec(line);
  return task ? { text: task[2]!, done: task[1]!.toLowerCase() === 'x' } : { text: line, done: false };
}
