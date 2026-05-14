import { selectedGroupModelIds } from '../model-groups.js';
import { LatencyObservation, ModelGroups } from '../types.js';

const GENERIC_MODELS = new Set(['', 'auto', 'default', 'omfm', 'openrouter/free']);

export interface RouteChoice {
  modelId: string;
  reason: 'requested-selected' | 'model-group' | 'lowest-latency' | 'fallback-order';
}

function latencyValue(obs: LatencyObservation | undefined): number | undefined {
  if (!obs) return undefined;
  if (!Number.isFinite(obs.latencyMs)) return undefined;
  return obs.latencyMs;
}

export function isCoolingDown(obs: LatencyObservation | undefined): boolean {
  if (!obs?.cooldownUntil) return false;
  const until = Date.parse(obs.cooldownUntil);
  return Number.isFinite(until) && until > Date.now();
}

function statusRank(obs: LatencyObservation | undefined): number {
  if (isCoolingDown(obs)) return 2;
  if (obs?.lastStatus && obs.lastStatus !== 'ok' && !obs.cooldownUntil) return 1;
  return 0;
}

function pickLowestLatency(ids: string[], observations: Record<string, LatencyObservation>): string | undefined {
  let bestId: string | undefined;
  let bestRank = Infinity;
  let bestLatency = Infinity;
  let bestIndex = Infinity;

  for (let i = 0; i < ids.length; i++) {
    const modelId = ids[i]!;
    const obs = observations[modelId];
    const latency = latencyValue(obs);
    if (latency === undefined) continue;

    const rank = statusRank(obs);

    let isBetter = false;
    if (rank < bestRank) {
      isBetter = true;
    } else if (rank === bestRank) {
      if (latency < bestLatency) {
        isBetter = true;
      } else if (latency === bestLatency) {
        if (i < bestIndex) {
          isBetter = true;
        } else if (i === bestIndex) {
           if (bestId && modelId.localeCompare(bestId) < 0) {
              isBetter = true;
           }
        }
      }
    }

    if (isBetter) {
      bestId = modelId;
      bestRank = rank;
      bestLatency = latency;
      bestIndex = i;
    }
  }

  return bestId;
}

export function chooseModel(selectedModelIds: string[], observations: Record<string, LatencyObservation>, requestedModel?: string): RouteChoice {
  if (selectedModelIds.length === 0) {
    throw new Error('No models selected. Run `omfm model` to choose at least one OpenRouter free model.');
  }

  if (requestedModel && !GENERIC_MODELS.has(requestedModel) && selectedModelIds.includes(requestedModel)) {
    return { modelId: requestedModel, reason: 'requested-selected' };
  }

  const available = selectedModelIds.filter((id) => !isCoolingDown(observations[id]));
  const primary = pickLowestLatency(available, observations);
  if (primary) return { modelId: primary, reason: 'lowest-latency' };

  const fallback = pickLowestLatency(selectedModelIds, observations);
  if (fallback) return { modelId: fallback, reason: 'lowest-latency' };

  return { modelId: selectedModelIds[0]!, reason: 'fallback-order' };
}

function candidatePool(selectedModelIds: string[], requestedModel?: string, modelGroups?: ModelGroups): { ids: string[]; grouped: boolean } {
  if (requestedModel && !GENERIC_MODELS.has(requestedModel) && selectedModelIds.includes(requestedModel)) {
    return { ids: selectedModelIds, grouped: false };
  }
  const ids = modelGroups ? selectedGroupModelIds(selectedModelIds, modelGroups, requestedModel) : undefined;
  return ids ? { ids, grouped: true } : { ids: selectedModelIds, grouped: false };
}

export function chooseGroupedModel(selectedModelIds: string[], observations: Record<string, LatencyObservation>, requestedModel?: string, modelGroups?: ModelGroups): RouteChoice {
  if (requestedModel && !GENERIC_MODELS.has(requestedModel) && selectedModelIds.includes(requestedModel)) {
    return { modelId: requestedModel, reason: 'requested-selected' };
  }
  const pool = candidatePool(selectedModelIds, requestedModel, modelGroups);
  const choice = chooseModel(pool.ids, observations, requestedModel);
  return pool.grouped && choice.reason !== 'requested-selected' ? { ...choice, reason: 'model-group' } : choice;
}

export function orderedCandidates(selectedModelIds: string[], observations: Record<string, LatencyObservation>, requestedModel?: string, modelGroups?: ModelGroups): string[] {
  const pool = candidatePool(selectedModelIds, requestedModel, modelGroups);
  const first = chooseGroupedModel(selectedModelIds, observations, requestedModel, modelGroups).modelId;

  // Precompute metrics to avoid repeated object lookups and index calculations during sorting
  const metrics = new Map<string, { rank: number; latency: number | undefined; index: number }>();
  for (let i = 0; i < pool.ids.length; i++) {
    const id = pool.ids[i]!;
    metrics.set(id, {
      rank: statusRank(observations[id]),
      latency: latencyValue(observations[id]),
      index: i
    });
  }

  const rest = pool.ids.filter((id) => id !== first).sort((a, b) => {
    const ma = metrics.get(a)!;
    const mb = metrics.get(b)!;

    if (ma.rank !== mb.rank) return ma.rank - mb.rank;

    if (ma.latency !== undefined && mb.latency !== undefined) return ma.latency - mb.latency || ma.index - mb.index || a.localeCompare(b);
    if (ma.latency !== undefined) return -1;
    if (mb.latency !== undefined) return 1;

    return ma.index - mb.index || a.localeCompare(b);
  });
  return [first, ...rest];
}
