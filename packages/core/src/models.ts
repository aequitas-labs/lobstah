/**
 * Which harness a model id belongs to. A model never crosses harnesses:
 * `claude-opus-5-5` handed to Codex is "not supported when using Codex with a
 * ChatGPT account", and a `gpt-*` id handed to Claude Code fails the same
 * way. A dispatch whose model belongs elsewhere runs on its harness's
 * default model instead of failing (see modelForHarness).
 *
 * A small prefix table: Claude ids (`claude-*`) and the Claude Code aliases
 * (`opus`, `sonnet`, `haiku`, `fable`, `opusplan`); OpenAI ids (`gpt-*`,
 * `o1`/`o3`/`o4-mini`…, `codex-*`). Anything else is unknown and passes
 * through — a custom provider's model is the operator's call.
 */
const MODEL_OWNERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(anthropic[/.])?(claude|opus|sonnet|haiku|fable)(\b|-|$)|^opusplan$/i, 'claude'],
  [/^(openai\/)?(gpt-|o\d+(\b|-|$)|codex-)/i, 'codex'],
];

export function modelHarness(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return MODEL_OWNERS.find(([re]) => re.test(model))?.[1];
}

export interface HarnessModel {
  /** The model to pass to the adapter; undefined → the adapter's default. */
  model?: string;
  /** Set when the requested model belonged to another harness and was dropped. */
  dropped?: { model: string; owner: string };
}

/** The model to run on `harness`: the requested one, unless it belongs to another harness. */
export function modelForHarness(harness: string, model: string | undefined): HarnessModel {
  const owner = modelHarness(model);
  if (model && owner && owner !== harness) return { dropped: { model, owner } };
  return { model };
}

/** The status-note phrasing for a dropped model. */
export function droppedModelNote(harness: string, dropped: NonNullable<HarnessModel['dropped']>): string {
  return `model ${dropped.model} is a ${dropped.owner} model — dropped, using ${harness}'s default`;
}
