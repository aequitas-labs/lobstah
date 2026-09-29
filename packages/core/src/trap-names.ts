import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomInt } from 'node:crypto';
import { lobstahHome } from './paths.js';

/** Short, pronounceable words. Keep both lists lowercase, distinct, and benign. */
export const TRAP_FIRST_WORDS = [
  'airy', 'amber', 'azure', 'blue', 'bright', 'brisk', 'calm', 'clear',
  'cool', 'coral', 'crisp', 'dawn', 'dune', 'early', 'easy', 'even',
  'fair', 'fern', 'gentle', 'glad', 'gold', 'green', 'hardy', 'hazy',
  'ivory', 'kind', 'leafy', 'light', 'lively', 'maple', 'mellow', 'mild',
  'misty', 'mossy', 'neat', 'open', 'pearl', 'placid', 'quiet', 'rapid',
  'reedy', 'rosy', 'round', 'sandy', 'silver', 'smooth', 'soft', 'springy',
  'steady', 'sunny', 'sweet', 'tender', 'tidal', 'tiny', 'vivid', 'warm',
  'wavy', 'white', 'willow', 'windy', 'wispy', 'young', 'yellow', 'fresh',
] as const;

export const TRAP_LAST_WORDS = [
  'anchor', 'aspen', 'bay', 'beach', 'boat', 'brook', 'buoy', 'cedar',
  'cliff', 'coast', 'cove', 'crab', 'creek', 'dune', 'egret', 'ferry',
  'field', 'finch', 'foam', 'grove', 'gull', 'harbor', 'heron', 'inlet',
  'island', 'isle', 'jetty', 'kelp', 'kite', 'lagoon', 'lake', 'lark',
  'marsh', 'meadow', 'otter', 'oyster', 'path', 'pebble', 'pier', 'pine',
  'puffin', 'reef', 'ripple', 'river', 'rock', 'rook', 'sail', 'sand',
  'seal', 'shell', 'shore', 'skiff', 'spray', 'star', 'stone', 'sunset',
  'swift', 'tern', 'tide', 'valley', 'vessel', 'wave', 'wharf', 'wren',
] as const;

export const TRAP_NAME_RE = /^[a-z]{2,8}-[a-z]{2,8}$/;

function namesDir(): string {
  return path.join(lobstahHome(), 'trap-names');
}

function nameFile(name: string): string {
  return path.join(namesDir(), `${name}.json`);
}

/** All names ever assigned in this home, including stowed and swept traps. */
export function knownTrapNames(): string[] {
  try {
    return fs.readdirSync(namesDir()).filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -5)).filter((name) => TRAP_NAME_RE.test(name)).sort();
  } catch {
    return [];
  }
}

export function trapIdForName(name: string): string | undefined {
  if (!TRAP_NAME_RE.test(name)) return undefined;
  try {
    const id = (JSON.parse(fs.readFileSync(nameFile(name), 'utf8')) as { trapId?: unknown }).trapId;
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
}

export function trapNameForId(trapId: string): string | undefined {
  return knownTrapNames().find((name) => trapIdForName(name) === trapId);
}

/** Reserve a stable name; an exclusive create makes concurrent sign-ons collision-safe. */
export function reserveTrapName(trapId: string, requested?: string, start = randomInt(TRAP_FIRST_WORDS.length * TRAP_LAST_WORDS.length)): string {
  fs.mkdirSync(namesDir(), { recursive: true });
  const old = knownTrapNames().find((name) => trapIdForName(name) === trapId);
  if (requested !== undefined && !TRAP_NAME_RE.test(requested)) {
    throw new Error(`invalid trap name "${requested}" — use two lowercase words of 2–8 letters joined by one hyphen`);
  }
  if (requested === undefined && old) return old;
  const total = TRAP_FIRST_WORDS.length * TRAP_LAST_WORDS.length;
  const candidates = requested === undefined
    ? Array.from({ length: total }, (_, offset) => {
        const index = (start + offset) % total;
        return `${TRAP_FIRST_WORDS[Math.floor(index / TRAP_LAST_WORDS.length)]}-${TRAP_LAST_WORDS[index % TRAP_LAST_WORDS.length]}`;
      })
    : [requested];
  for (const name of candidates) {
    if (name === old) return name;
    try {
      fs.writeFileSync(nameFile(name), JSON.stringify({ trapId }), { flag: 'wx' });
      if (old) fs.rmSync(nameFile(old), { force: true });
      return name;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (trapIdForName(name) === trapId) return name;
      if (requested !== undefined) throw new Error(`trap name "${name}" is already taken`);
    }
  }
  throw new Error('all trap names in this lobstah home are taken');
}
