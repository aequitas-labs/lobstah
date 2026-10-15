import fs from 'node:fs';
import path from 'node:path';
import { backendScopes, claimGoalsPrompt, displayGrounds, goalDate, goalsCardTitle, laneDirs, listDecisions, lobstahHome, previousGoalDate, readDecisionAnswer,
  readDirIfPresent, readEvidence, readGoals, readPrs, readStatusLog, repoKey, resolveGrounds, storageGrounds, storedDescriptor, type Config, type DailyGoals, type Lane } from '@lobstah/core';

export function visibleGoals(cfg: Config, now = new Date()): Array<Pick<DailyGoals, 'grounds' | 'date' | 'lines'>> {
  const date = goalDate(now, cfg.helm.timezone);
  return backendScopes(cfg).map((s) => ({ grounds: s.grounds, date, lines: readGoals(storageGrounds(s.grounds, cfg), date).lines })).filter((g) => g.lines.length);
}

export function dailyGoalsContext(grounds: string, cfg: Config, now = new Date()): string | undefined {
  const date = goalDate(now, cfg.helm.timezone), yesterday = previousGoalDate(date);
  const key = storageGrounds(grounds, cfg);
  grounds = displayGrounds(grounds, cfg);
  const card = listDecisions().some((d) => d.title === goalsCardTitle(date) && storageGrounds(d.grounds ?? 'home', cfg) === key);
  if (!claimGoalsPrompt(key, date, card)) return undefined;
  return `First message of the day (${date}, day starts at 04:00 local). After handling this message, put one card up with yesterday's recap and a draft of today's goals: ` +
    `read \`lobstah goals recap-data ${yesterday} --grounds ${grounds}\`, match the facts to yesterday's goals (done, moved, stuck, plus also done), ` +
    `save with \`lobstah goals recap ${yesterday} --file <md> --grounds ${grounds}\`, then use \`lobstah man ask --title "${goalsCardTitle(date)}" --detail <md> --grounds ${grounds}\`. ` +
    `Propose a draft from open cards, PRs and to-dos. After the answer, save it with \`lobstah goals set "<line>" [...] --grounds ${grounds}\`.`;
}

/** Facts only. The helm, not a heuristic, matches work to the day's goals. */
export function goalsRecapData(grounds: string, date: string, cfg: Config) {
  const g = resolveGrounds(cfg, grounds), key = storageGrounds(grounds, cfg);
  const goals = readGoals(key, date);
  const inDay = (at?: string) => !!at && Number.isFinite(Date.parse(at)) && goalDate(new Date(at), cfg.helm.timezone) === date;
  const dispatches = [];
  const urls = new Set<string>();
  for (const lane of ['work', 'chore'] as Lane[]) {
    const dirs = laneDirs(lane);
    const ids = new Set([...readDirIfPresent(dirs.active), ...readDirIfPresent(dirs.done)].filter((s) => !s.startsWith('.')));
    for (const id of ids) {
      const descriptor = storedDescriptor(id, lane);
      if (!descriptor || !g.repos.includes(descriptor.repo)) continue;
      const evidence = readEvidence(id, lane);
      for (const url of [evidence?.prUrl, ...(evidence?.prUrls ?? [])]) if (url) urls.add(url);
      for (const entry of readStatusLog(id, lane)) if ((entry.verb === 'done' || entry.verb === 'failed') && inDay(entry.at))
        dispatches.push({ id, lane, repo: descriptor.repo, verb: entry.verb, at: entry.at, note: entry.note, prUrl: evidence?.prUrl });
    }
  }
  const prs = readPrs().filter((p) => (urls.has(p.url) || g.repos.includes(repoKey(cfg, p.repo))) && (inDay(p.openedAt ?? p.firstSeenAt) || inDay(p.mergedAt)))
    .map((p) => ({ url: p.url, title: p.title, state: p.state, openedAt: p.openedAt, firstSeenAt: p.firstSeenAt, mergedAt: p.mergedAt }));
  const cards = listDecisions().filter((d) => {
    if (d.grounds) return storageGrounds(d.grounds, cfg) === key;
    const repo = d.repo ?? (d.dispatch ? storedDescriptor(d.dispatch, d.lane ?? 'work')?.repo : undefined);
    return repo ? g.repos.includes(repo) : storageGrounds('home', cfg) === key;
  }).flatMap((d) => {
    const answer = readDecisionAnswer(d.key);
    return answer && inDay(answer.answeredAt) ? [{ key: d.key, title: d.title, answeredAt: answer.answeredAt, option: answer.option, text: answer.text }] : [];
  });
  // Optional #232 store: no import, command or dependency on the to-do PR.
  let todos: Array<{ id: number; text: string; state: string; updatedAt: string }> = [];
  try { todos = JSON.parse(fs.readFileSync(path.join(lobstahHome(), 'todos', `${key}.json`), 'utf8')).items ?? []; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  return { date, timezone: cfg.helm.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, dayStartsAt: '04:00',
    goals, dispatches, prs, cards, todos: todos.filter((t) => (t.state === 'done' || t.state === 'dropped') && inDay(t.updatedAt)),
    note: 'PR firstSeenAt is when lobstah first recorded it, not its forge creation time. Only retained records are available.' };
}
