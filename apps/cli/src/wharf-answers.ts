import * as fs from 'node:fs';
import * as path from 'node:path';
import { BackendError, DecisionError, GrantError, backendScopes, lobstahHome, loadConfig, readDecision, readDecisionAnswer, uniqueTempPath, wharfFor } from '@lobstah/core';
import type { BackendScope, CardAnswerReceipt, Config, TendAttention } from '@lobstah/core';
import { answerKey } from './decision-answer.js';
import { applyPermissionAnswer } from './grants-cli.js';
import { writeAck } from './acks.js';
import { buildTendReport } from './tend.js';

/** What this boat says became of a person's answer to one of its cards. */
export interface ReceiptOutcome { state: 'applied' | 'refused'; outcome: string }
/** How often the daemon asks each wharf for answers to this boat's cards. */
export const ANSWERS_CHECK_MS = 10_000;
/** What a boat with `remoteAnswers = false` says to an Allow from its wharf. */
export const ALLOW_HERE_ONLY = 'This boat takes Allow only in its own glass';

type Ledger = { state: 'applying' | 'applied' | 'refused'; outcome?: string };
/** This boat's record of each receipt it took: written before applying and after, so a receipt applies once across retries and restarts. */
function ledgerFile(wharf: string, id: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(wharf) || !/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new Error('invalid answer receipt');
  return path.join(lobstahHome(), 'wharf-answers', wharf, `${id}.json`);
}
function readLedger(file: string): Ledger | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Ledger; } catch { return undefined; }
}
function writeLedger(file: string, entry: Ledger) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = uniqueTempPath(file);
  fs.writeFileSync(tmp, `${JSON.stringify(entry)}\n`);
  fs.renameSync(tmp, file);
}
/** The decision option an action names, in the card's own words. */
function optionOf(r: CardAnswerReceipt): string | undefined {
  switch (r.action.kind) {
    case 'allow-once': return 'Allow once';
    case 'allow-always': return 'Allow always';
    case 'deny': return 'No';
    case 'answer': return r.action.option;
    default: return undefined;
  }
}

/**
 * Apply one person's verified answer, relayed by the wharf, to one of this
 * boat's cards. It applies only to the exact state the person answered,
 * only once, and through the same paths as the local glass: a permission's
 * Allow writes the same grant a glass click would, unless this boat takes
 * Allow only in its own glass. No, seen and free text never grant.
 */
export function applyReceipt(cfg: Pick<Config, 'wharfRemoteAnswers'>, wharf: string, r: CardAnswerReceipt, attention: TendAttention[]): ReceiptOutcome {
  const file = ledgerFile(wharf, r.id);
  const prior = readLedger(file);
  if (prior && prior.state !== 'applying') return { state: prior.state, outcome: prior.outcome ?? '' };
  const finish = (state: ReceiptOutcome['state'], outcome: string): ReceiptOutcome => { writeLedger(file, { state, outcome }); return { state, outcome }; };
  // Applied before a crash, not yet recorded: the decision's own answer names this receipt. Finish its grant, if one is missing.
  if (prior?.state === 'applying' && r.key.startsWith('decision:')) {
    const answered = readDecisionAnswer(r.key);
    if (answered?.receipt === r.id) {
      const decision = readDecision(r.key)!;
      const grant = decision.permission ? applyPermissionAnswer(decision, answered) : undefined;
      return finish('applied', grant ? `grant ${grant.id}` : 'answered');
    }
  }
  const option = optionOf(r);
  const grants = r.family === 'permission' && !!option?.startsWith('Allow');
  if (grants && cfg.wharfRemoteAnswers?.[wharf] === false) return finish('refused', ALLOW_HERE_ONLY);
  const item = attention.find((a) => a.key === r.key);
  if (!item || item.stateHash !== r.stateHash) return finish('refused', 'This card changed on its boat since; answer it as it stands now');
  writeLedger(file, { state: 'applying' });
  try {
    if (r.action.kind === 'seen') {
      writeAck({ key: r.key, kind: item.kind, stateHash: item.stateHash, at: new Date().toISOString(), by: 'slack' });
      return finish('applied', 'seen');
    }
    if (option === undefined && (r.action.kind !== 'answer-text' || !r.text)) return finish('refused', 'This card takes no such answer');
    const { grant } = answerKey(r.key, { ...(option !== undefined ? { option } : { text: r.text }), by: 'wharf', receipt: r.id });
    return finish('applied', grant ? `grant ${grant.id}` : 'answered');
  } catch (e) {
    if (e instanceof DecisionError || e instanceof GrantError) return finish('refused', e.message);
    throw e;
  }
}

let checkedAt = 0;
/**
 * The daemon's remote poll: take the answers people gave this boat's cards
 * on each wharf, apply each, and tell the wharf what became of it. Returns
 * how many it applied, so the boat can restate its cards at once.
 */
export async function applyWharfAnswers(now = Date.now(), log: (m: string) => void = () => {}): Promise<number> {
  if (now - checkedAt < ANSWERS_CHECK_MS) return 0;
  checkedAt = now;
  const cfg = loadConfig();
  const byWharf = new Map<string, BackendScope>();
  for (const s of backendScopes(cfg)) if (s.kind === 'wharf' && !byWharf.has(s.wharf!)) byWharf.set(s.wharf!, s);
  let attention: TendAttention[] | undefined;
  let applied = 0;
  for (const [wharf, scope] of byWharf) {
    const backend = wharfFor(scope);
    let receipts: CardAnswerReceipt[];
    try {
      receipts = await backend.request('cards/answers') as CardAnswerReceipt[];
    } catch (e) {
      // An older wharf has no answers to give.
      if (!(e instanceof BackendError && e.status === 404)) log(`wharf ${wharf} answers: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    for (const r of Array.isArray(receipts) ? receipts : []) {
      attention ??= buildTendReport(now).attention;
      const outcome = applyReceipt(cfg, wharf, r, attention);
      if (outcome.state === 'applied') applied++;
      try {
        // The receipt's own id keys the report: a retried report is the same report.
        await backend.request(`cards/answers/${encodeURIComponent(r.id)}`, outcome, `answer-${r.id}`);
      } catch (e) {
        log(`wharf ${wharf} answer ${r.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return applied;
}
