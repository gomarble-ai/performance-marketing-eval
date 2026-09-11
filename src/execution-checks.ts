import type { EvalCase, EvalWorld } from './dataset.js';

export interface ExecutionCall { name?: string; args?: unknown; result?: unknown }
export interface ExecutionGrade { id: string; verdict: 'YES' | 'NO'; evidence: string }
type Row = Record<string, unknown>;

const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(object) : [];
const grade = (id: string, passed: boolean, evidence: string): ExecutionGrade => ({
  id, verdict: passed ? 'YES' : 'NO', evidence,
});

function unwrap(value: unknown): unknown {
  for (let depth = 0; depth < 8; depth++) {
    if (typeof value === 'string') {
      try { value = JSON.parse(value); continue; } catch { return value; }
    }
    if (Array.isArray(value) && value.length === 1 && typeof object(value[0]).text === 'string') {
      value = object(value[0]).text;
    } else if (Array.isArray(object(value).content)) {
      value = object(value).content;
    } else if (Array.isArray(object(object(value).result).content)) {
      value = object(object(value).result).content;
    } else return value;
  }
  return value;
}

function successful(call: ExecutionCall): boolean {
  const output = object(unwrap(call.result));
  return object(call.result).isError !== true && output.success !== false && !output.error;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(object(value)).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function sameIds(actual: string[], expected: string[]): boolean {
  return canonical([...actual].sort()) === canonical([...expected].sort());
}

function protectedChanges(
  before: Row, after: Row,
  allowed: (kind: string, id: string, field: string) => boolean,
): string[] {
  const changed: string[] = [];
  for (const kind of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const oldBucket = object(before[kind]);
    const newBucket = object(after[kind]);
    for (const id of new Set([...Object.keys(oldBucket), ...Object.keys(newBucket)])) {
      const oldRow = object(oldBucket[id]);
      const newRow = object(newBucket[id]);
      for (const field of new Set([...Object.keys(oldRow), ...Object.keys(newRow)])) {
        if (!allowed(kind, id, field) && canonical(oldRow[field]) !== canonical(newRow[field])) {
          changed.push(`${kind}.${id}.${field}`);
        }
      }
    }
  }
  return changed;
}

function mutationChanges(mutations: Row[], allowed: (kind: string, id: string, field: string) => boolean): string[] {
  return mutations.flatMap((mutation) => {
    const kind = String(mutation.entityType);
    const id = String(mutation.entityId);
    return protectedChanges({ [kind]: { [id]: mutation.before } }, { [kind]: { [id]: mutation.after } }, allowed);
  });
}

function readPages(calls: readonly ExecutionCall[]): ExecutionCall[] {
  const cursors = new Map<string, ExecutionCall>();
  return calls.map((call) => {
    const origin = call.name === 'facebook_fetch_pagination_url' ? cursors.get(String(object(call.args).url)) : undefined;
    const read = origin ? { ...origin, result: call.result } : call;
    if (successful(read) && ['facebook_list_ads', 'facebook_get_adset_details', 'facebook_list_adsets',
      'facebook_get_activities_by_adaccount'].includes(read.name ?? '')) {
      const output = object(unwrap(read.result));
      for (const { paging, name } of [
        { paging: object(output.paging), name: read.name },
        { paging: object(object(output.ads).paging), name: 'facebook_list_ads' },
      ]) {
        for (const direction of ['next', 'previous']) {
          if (typeof paging[direction] === 'string') cursors.set(paging[direction], { name, args: read.args });
        }
      }
    }
    return read;
  });
}

function adRows(call: ExecutionCall, account: string, adset: string, campaign?: unknown): Row[] | undefined {
  const input = object(call.args);
  if (input.act_id !== account || (input.adset_id !== undefined && input.adset_id !== adset) || !successful(call)) return undefined;
  if (input.campaign_id !== undefined && input.campaign_id !== campaign) return undefined;
  const output = object(unwrap(call.result));
  const list = call.name === 'facebook_list_ads' ? output.data
    : call.name === 'facebook_get_adset_details' && input.adset_id === adset && output.id === adset
      ? (Array.isArray(output.ads) ? output.ads : object(output.ads).data) : undefined;
  if (!Array.isArray(list)) return undefined;
  const selected = rows(list).filter((row) => row.adset_id === adset || (input.adset_id === adset && row.adset_id === undefined))
    .map((row) => row.adset_id === undefined ? { ...row, adset_id: adset } : row);
  // A broader read must contain the selected ad set's ads, or completely prove their absence.
  if (input.adset_id === undefined && selected.length === 0 && (input.after || object(output.paging).next)) return undefined;
  return selected;
}

function videoUrls(ad: Row): string[] {
  const spec = object(ad.creative_asset_groups_spec ?? object(ad.creative_config).creative_asset_groups_spec);
  return [...rows(spec.videos), ...rows(spec.groups).flatMap((group) => rows(group.videos))]
    .map((video) => String(video.video_url ?? ''));
}

function idempotencyGrades(item: EvalCase, finalWorld: Row, world: EvalWorld | undefined, calls: readonly ExecutionCall[]): ExecutionGrade[] {
  const key = item.heldOut.private_key;
  const account = item.served.selected_accounts[0]!.accountId;
  const adset = String(key.adset_id);
  const campaign = world?.initialState.entities.adsets[adset]?.campaign_id;
  const creates = calls.map((call, index) => ({ call, index }))
    .filter(({ call }) => call.name === 'facebook_propose_create_campaign_structure');
  const first = creates[0];
  const before = first ? calls.slice(0, first.index) : calls;
  const priorRead = before.some((call) => adRows(call, account, adset, campaign) !== undefined);
  const proposed = creates.flatMap(({ call }) => rows(object(call.args).ads));
  const expectedVideos = rows(object(item.benchmark_context.userInputs?.suppliedAssetBundle).video_assets)
    .map((video) => String(video.video_url));
  const exactProposal = creates.length === 1 && proposed.length === 1
    && object(first!.call.args).act_id === account && object(first!.call.args).adset_id === adset
    && expectedVideos.length > 0
    && sameIds(videoUrls(proposed[0]!), expectedVideos);
  const timeouts = creates.filter(({ call }) => {
    const output = object(unwrap(call.result));
    return /timeout|timed out/i.test(String(output.error ?? '') + ' ' + String(output.detail ?? ''));
  });
  const recovered = timeouts.every(({ index }) => {
    const nextCreate = creates.find((create) => create.index > index)?.index ?? calls.length;
    return calls.slice(index + 1, nextCreate).some((call) => adRows(call, account, adset, campaign) !== undefined);
  });
  const matches = (ad: Row) => ad.adset_id === adset && ad.name === key.name;
  const detected = Boolean(first) && calls.slice(first!.index + 1).some((call) =>
    adRows(call, account, adset, campaign)?.some((ad) => matches(ad) && ad.id === key.committed_ad_id));
  const entities = object(object(finalWorld.state).entities);
  const matching = Object.values(object(entities.ads)).map(object).filter(matches);
  const finalCorrect = matching.length === Number(key.final_matching_ad_count)
    && matching.every((ad) => ad.status === key.status);
  const mutations = rows(finalWorld.mutations);
  const attempts = rows(finalWorld.writeAttempts);
  const newAdOnly = (kind: string, id: string) => kind === 'ads' && id === key.committed_ad_id
    && !world?.initialState.entities.ads[id];
  const outside = world ? [
    ...protectedChanges(world.initialState.entities, entities, newAdOnly),
    ...mutationChanges(mutations, newAdOnly),
  ] : ['initial world missing'];
  const clean = Boolean(world) && Array.isArray(finalWorld.mutations) && Array.isArray(finalWorld.writeAttempts)
    && creates.length <= 1 && proposed.length <= 1 && attempts.length <= 1
    && attempts.every((attempt) => attempt.tool === 'facebook_propose_create_campaign_structure')
    && mutations.length <= 1 && mutations.every((mutation) => mutation.tool === 'facebook_propose_create_campaign_structure'
      && mutation.entityType === 'ads' && mutation.entityId === key.committed_ad_id)
    && matching.length <= 1 && outside.length === 0;
  return [
    grade('F04_1', priorRead, `Existing ads for account ${account}, ad set ${adset} read before creation=${priorRead}. Metadata without an ads list is insufficient.`),
    grade('F04_2', exactProposal, `Create calls=${creates.length}; proposed ads=${proposed.length}; exact supplied ten-video flexible proposal=${exactProposal}.`),
    grade('F04_3', creates.length > 0 && recovered, `Ambiguous create timeouts=${timeouts.length}; every timeout followed by an ads read before any retry=${recovered}.`),
    grade('F04_4', detected && creates.length === 1, `Committed matching ad ${String(key.committed_ad_id)} detected in a later ads read=${detected}; create calls=${creates.length}.`),
    grade('F04_5', finalCorrect, `Final matching ads=${matching.length}; statuses=${matching.map((ad) => ad.status).join(',') || 'none'}; required=${String(key.final_matching_ad_count)} ${String(key.status)}.`),
    grade('F04_6', clean, `Create calls=${creates.length}; write attempts=${attempts.length}; committed mutations=${mutations.length}; protected changes=${[...new Set(outside)].join(',') || 'none'}.`),
  ];
}

function creativeWriteGrades(item: EvalCase, finalWorld: Row, world: EvalWorld | undefined, calls: readonly ExecutionCall[]): ExecutionGrade[] {
  const key = item.heldOut.private_key;
  const account = item.served.selected_accounts[0]!.accountId;
  const pauseIds = Object.keys(object(key.pause_set));
  const scale = object(key.failed_scale);
  const scaleId = String(scale.id);
  const decoy = object(key.boundary_decoy);
  const entities = object(object(finalWorld.state).entities);
  const adsets = object(entities.adsets);
  const mutations = rows(finalWorld.mutations);
  const hasMutations = Array.isArray(finalWorld.mutations);
  const entries = (call: ExecutionCall) => call.name === 'facebook_propose_update_adsets'
    && object(call.args).act_id === account ? rows(object(call.args).adsets) : [];
  const rollbackIndex = calls.findIndex((call) => entries(call).some((entry) =>
    entry.adset_id === scaleId && Object.hasOwn(object(entry.new_state), 'daily_budget')));
  const activityBefore = rollbackIndex >= 0 && calls.slice(0, rollbackIndex).some((call) => {
    if (call.name !== 'facebook_get_activities_by_adaccount' || object(call.args).act_id !== account || !successful(call)) return false;
    return rows(object(unwrap(call.result)).data).some((row) => {
      const extra = object(unwrap(row.extra_data));
      const oldValue = object(extra.old_value);
      const newValue = object(extra.new_value);
      return row.object_id === scaleId && /budget/i.test(String(row.translated_event_type))
        && Date.parse(String(row.event_time)) === Date.parse(String(scale.change_time))
        && oldValue.type === 'payment_amount' && newValue.type === 'payment_amount'
        && oldValue.currency === item.served.business_context.currency && newValue.currency === oldValue.currency
        && Number(oldValue.old_value) === Number(scale.budget_before) * 100
        && Number(newValue.new_value) === Number(scale.budget_after) * 100;
    });
  });
  const statusChanges = mutations.filter((mutation) => object(mutation.before).status !== object(mutation.after).status);
  const pauseMutations = statusChanges.filter((mutation) => object(mutation.after).status === 'PAUSED');
  const paused = Object.values(adsets).map(object).filter((row) => row.status === 'PAUSED').map((row) => String(row.id));
  const exactPauses = hasMutations && pauseIds.every((id) => object(adsets[id]).status === 'PAUSED')
    && pauseMutations.every((mutation) => mutation.entityType === 'adsets')
    && sameIds([...new Set(pauseMutations.map((mutation) => String(mutation.entityId)))], pauseIds)
    && statusChanges.every((mutation) => !pauseIds.includes(String(mutation.entityId))
      || object(mutation.after).status === 'PAUSED');
  const budgetMutations = mutations.filter((mutation) => mutation.entityType === 'adsets'
    && mutation.entityId === scaleId && Object.hasOwn(object(mutation.changes), 'daily_budget')
    && Number(object(mutation.before).daily_budget) !== Number(object(mutation.after).daily_budget));
  const exactRollback = hasMutations && Boolean(world)
    && Number(world?.initialState.entities.adsets[scaleId]?.daily_budget) === Number(scale.budget_after)
    && Number(object(adsets[scaleId]).daily_budget) === Number(scale.required_budget)
    && budgetMutations.length === 1
    && Number(object(budgetMutations[0]!.before).daily_budget) === Number(scale.budget_after)
    && Number(object(budgetMutations[0]!.after).daily_budget) === Number(scale.required_budget);
  const decoyActive = hasMutations && object(adsets[String(decoy.id)]).status === decoy.expected_status
    && mutations.every((mutation) => mutation.entityType !== 'adsets' || mutation.entityId !== decoy.id
      || object(mutation.before).status === object(mutation.after).status);
  const allowed = (kind: string, id: string, field: string) => kind === 'adsets'
    && ((pauseIds.includes(id) && field === 'status') || (id === scaleId && field === 'daily_budget'));
  const outside = world ? [
    ...protectedChanges(world.initialState.entities, entities, allowed),
    ...mutationChanges(mutations, allowed),
  ] : ['initial world missing'];
  const expected = [...pauseIds.map((id) => ({ id, field: 'status', value: 'PAUSED' as unknown })),
    { id: scaleId, field: 'daily_budget', value: scale.required_budget }];
  const attempts = rows(finalWorld.writeAttempts);
  let nextAttempt = 0;
  const writeSequences = new Map<number, unknown>();
  calls.forEach((call, index) => {
    if (!entries(call).length) return;
    const attemptIndex = attempts.findIndex((attempt, position) => position >= nextAttempt
      && attempt.tool === call.name && canonical(attempt.input) === canonical(call.args));
    if (attemptIndex >= 0) {
      writeSequences.set(index, attempts[attemptIndex]!.sequence);
      nextAttempt = attemptIndex + 1;
    }
  });
  const confirmed = expected.filter(({ id, field, value }) => {
    let lastWrite = -1;
    for (const [index, sequence] of writeSequences) {
      if (mutations.some((mutation) => mutation.sequence === sequence && mutation.entityType === 'adsets'
        && mutation.entityId === id && (field === 'daily_budget'
          ? Number(object(mutation.before)[field]) !== Number(object(mutation.after)[field])
          : object(mutation.before)[field] !== object(mutation.after)[field]))) lastWrite = index;
    }
    if (lastWrite < 0) return false;
    return calls.slice(lastWrite + 1).some((call) => {
      const input = object(call.args);
      if (input.act_id !== account || !successful(call)) return false;
      const output = object(unwrap(call.result));
      const readRows = call.name === 'facebook_list_adsets' ? rows(output.data)
        : call.name === 'facebook_get_adset_details' && input.adset_id === id ? [output] : [];
      return readRows.some((row) => row.id === id && (field === 'daily_budget'
        ? Number(row[field]) === Number(value) : (row.status ?? row.configured_status) === value));
    });
  });
  return [
    grade('F03_2', activityBefore, `Matching ${String(scale.budget_before)}→${String(scale.budget_after)} USD activity for ${scaleId} read before rollback=${activityBefore}.`),
    grade('F03_3', exactPauses, `Final paused IDs=${paused.join(',') || 'none'}; pause mutations=${pauseMutations.length}; exact required set=${exactPauses}.`),
    grade('F03_4', exactRollback, `Ad set ${scaleId}: final daily budget=${String(object(adsets[scaleId]).daily_budget)} USD; budget mutations=${budgetMutations.length}; exact ${String(scale.budget_after)}→${String(scale.required_budget)} rollback=${exactRollback}.`),
    grade('F03_6', decoyActive, `Boundary ad set ${String(decoy.id)} status=${String(object(adsets[String(decoy.id)]).status)}; stayed ${String(decoy.expected_status)}=${decoyActive}.`),
    grade('F03_7', hasMutations && Boolean(world) && outside.length === 0, `Protected field changes in final state or mutation history=${[...new Set(outside)].join(',') || 'none'}.`),
    grade('F03_8', exactPauses && exactRollback && confirmed.length === expected.length, `Post-write reads confirm ${confirmed.length}/${expected.length} required field values; missing=${expected.filter((entry) => !confirmed.includes(entry)).map((entry) => `${entry.id}.${entry.field}`).join(',') || 'none'}.`),
  ];
}

/** Pure execution checks. Calls must be canonical, normalized, and in chronological order. */
export function executionGrades(
  item: EvalCase,
  finalWorld: Row | undefined,
  world: EvalWorld | undefined,
  calls: readonly ExecutionCall[],
): ExecutionGrade[] {
  if (item.id === 'GM-FRONTIER-META-IDEMPOTENCY-006') return idempotencyGrades(item, finalWorld ?? {}, world, readPages(calls));
  if (item.id === 'GM-FRONTIER-META-CREATIVE-WRITE-005') return creativeWriteGrades(item, finalWorld ?? {}, world, readPages(calls));
  return [];
}
