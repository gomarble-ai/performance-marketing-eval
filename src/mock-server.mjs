import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, '..', 'data');
const PORT = Number(process.env.MOCK_MCP_PORT || 8787);
const TRACE_LOG = process.env.MARKETING_EVAL_TRACE_LOG;
const CALL_LOG = process.env.MARKETING_EVAL_CALL_LOG || join(ROOT, '..', 'runs', 'tool-calls.jsonl');
const WRITE_RE = /(propose_|_create|_update|_delete|_pause|_enable|_edit|_add_|_remove|_launch|execute_approved|_mutation)/i;
const RELATIVE_DATE = /\b(TODAY|YESTERDAY|LAST_\d+D|LAST_\d+_DAYS|LAST_(WEEK|MONTH|QUARTER|YEAR)|THIS_(WEEK|MONTH|QUARTER|YEAR))\b/i;

function rows(name) {
  return readFileSync(join(DATA, name), 'utf8').trimEnd().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function verifyDataset() {
  const [manifest] = rows('manifest.jsonl');
  for (const [name, expected] of Object.entries(manifest.files)) {
    const body = readFileSync(join(DATA, name));
    const hash = createHash('sha256').update(body).digest('hex');
    if (hash !== expected.sha256) throw new Error(`${name} failed manifest verification`);
    if (body.toString('utf8').trimEnd().split('\n').length !== expected.lines) throw new Error(`${name} line count drifted`);
  }
}

verifyDataset();
const CASES = new Map(rows('cases.jsonl').map((item) => [item.id, item]));
const FIXTURES = rows('fixtures.jsonl');
const ACCOUNTS = rows('accounts.jsonl');
const WORLDS = new Map(rows('worlds.jsonl').map((item) => [item.caseId, item]));
const CONTRACTS = rows('tool-contracts.jsonl');
const TOOLS = new Map(CONTRACTS.map((item) => [item.tool.name, item.tool]));
const BY_CASE = new Map();
for (const fixture of FIXTURES) {
  const list = BY_CASE.get(fixture.caseId) || [];
  list.push(fixture);
  BY_CASE.set(fixture.caseId, list);
}

let activeCaseId = process.env.MARKETING_EVAL_CASE_ID || '';
let activeRunId = process.env.MARKETING_EVAL_RUN_ID || '';
let activeTurn = 0;
let activeWorld;
let activeState;
let mutations = [];
let writeAttempts = [];
let readAttempts = [];
let pendingWrites = [];
let eventSequence = 0;
mkdirSync(dirname(CALL_LOG), { recursive: true });

function resetWorld(caseId) {
  activeWorld = structuredClone(WORLDS.get(caseId));
  activeState = structuredClone(activeWorld?.initialState ?? { entities: { campaigns: {}, adsets: {}, ads: {} } });
  activeTurn = 0;
  mutations = [];
  writeAttempts = [];
  readAttempts = [];
  pendingWrites = [];
  eventSequence = 0;
  if (caseId === 'GM-FRONTIER-GADS-LAUNCH-003') hydrateGoogleLaunchSourceState();
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return value;
  try { return JSON.parse(trimmed); } catch { return value; }
}

function unwrapOutput(raw) {
  let value = parseMaybeJson(raw);
  for (let depth = 0; depth < 6; depth++) {
    if (!value || typeof value !== 'object') break;
    if (value.result?.content?.[0]?.text !== undefined) {
      value = parseMaybeJson(value.result.content[0].text);
      continue;
    }
    if (value.type === 'text' && value.content !== undefined) {
      value = parseMaybeJson(value.content);
      continue;
    }
    break;
  }
  return value;
}

function fixtureCalls(caseId) {
  const fixtures = BY_CASE.get(caseId) || [];
  const calls = [];
  for (const fixture of fixtures) {
    const payload = fixture.payload;
    if (Array.isArray(payload.calls)) {
      for (const source of payload.calls) {
        const wrapped = source.toolName === 'execute_platform_tool';
        const name = wrapped ? source.input?.tool_name : source.toolName;
        if (!name || !TOOLS.has(name)) continue;
        calls.push({
          name,
          args: wrapped ? source.input?.tool_parameters ?? {} : source.input ?? {},
          output: unwrapOutput(source.result),
          sourcePath: fixture.sourcePath,
        });
      }
      continue;
    }
    if (payload.output) {
      calls.push({
        name: payload.meta?.tool === 'meta' ? 'facebook_get_adaccount_insights' : 'google_ads_run_gaql',
        args: {},
        output: payload.output,
        sourcePath: fixture.sourcePath,
      });
      continue;
    }
    if (Array.isArray(payload.views)) {
      for (const view of payload.views) {
        calls.push({
          name: 'facebook_get_adaccount_insights',
          args: { level: view.level },
          output: {
            _gomarble_meta_insights_data_quality: {
              source_tool: 'facebook_get_adaccount_insights',
              response_complete: !view.paginated,
              paging_next_present: view.paginated,
              required_next_action: view.paginated
                ? 'This response ended with paging.next; do not use it as a complete total.'
                : 'No paging.next; this response is complete.',
              requested_level: view.level,
              warnings: view.paginated ? ['This response is incomplete at the requested reporting grain.'] : [],
            },
            data: view.data,
            ...(view.paginated ? {
              paging: {
                next: payload.pagination?.[0]?.url
                  ?? 'https://graph.facebook.com/v25.0/insights?after=page-2',
              },
            } : {}),
          },
          sourcePath: fixture.sourcePath,
        });
      }
    }
    if (Array.isArray(payload.pagination)) {
      for (const page of payload.pagination) {
        calls.push({
          name: 'facebook_fetch_pagination_url',
          args: { url: page.url },
          output: page.output,
          sourcePath: fixture.sourcePath,
        });
      }
    }
  }
  return calls;
}

function hydrateGoogleLaunchSourceState() {
  const campaigns = activeState?.entities?.campaigns ?? {};
  const sourceId = CASES.get('GM-FRONTIER-GADS-LAUNCH-003')?.heldOut?.private_key?.source_campaign_id;
  const source = campaigns[String(sourceId)];
  if (!source) return;
  const calls = fixtureCalls('GM-FRONTIER-GADS-LAUNCH-003')
    .filter((call) => call.name === 'google_ads_run_gaql' && allText(call.args).includes(String(source.id)));
  const groups = {};
  const geoCriteria = new Map();
  const languages = new Set();
  for (const call of calls) {
    for (const row of call.output?.results ?? []) {
      const group = row.adGroup;
      const keyword = row.adGroupCriterion?.keyword;
      if (group?.name && keyword?.text) {
        const id = String(group.id ?? group.resourceName?.split('/').at(-1) ?? '');
        const stored = groups[group.name] ?? {
          id,
          name: group.name,
          status: 'ENABLED',
          keywords: [],
        };
        const key = `${keyword.text}\u0000${keyword.matchType ?? 'EXACT'}`;
        if (!stored.keywords.some((item) => `${item.text}\u0000${item.match_type}` === key)) {
          stored.keywords.push({
            text: keyword.text,
            match_type: keyword.matchType ?? 'EXACT',
            status: row.adGroupCriterion.status ?? 'ENABLED',
          });
        }
        groups[group.name] = stored;
      }
      const criterion = row.campaignCriterion;
      const constant = criterion?.location?.geoTargetConstant;
      if (constant) geoCriteria.set(`${constant}:${Boolean(criterion.negative)}`, {
        geo_target_constant: constant,
        negative: Boolean(criterion.negative),
      });
      const language = criterion?.language?.languageConstant;
      if (language) languages.add(language);
    }
  }
  source.ad_group_config = groups;
  source.ad_groups = Object.keys(groups);
  source.geo_criteria = [...geoCriteria.values()];
  source.language_constants = [...languages];
}

function allText(value) {
  return JSON.stringify(value ?? {});
}

function accountForInput(input) {
  const text = allText(input);
  return ACCOUNTS.find((account) => text.includes(account.accountId));
}

function allowedAccountIds(evalCase) {
  return new Set(evalCase.served.selected_accounts.map((account) => account.accountId));
}

function requestedAccountIds(input) {
  const ids = new Set();
  for (const key of ['act_id', 'customer_id', 'account_id', 'ad_account_id', 'advertiser_id']) {
    if (input?.[key] !== undefined) ids.add(String(input[key]));
  }
  const text = allText(input);
  for (const account of ACCOUNTS) if (text.includes(account.accountId)) ids.add(account.accountId);
  return ids;
}

function explicitInterval(input) {
  const text = allText(input);
  const dates = [...text.matchAll(/\b20\d{2}-\d{2}-\d{2}\b/g)].map((match) => match[0]);
  if (!dates.length) return null;
  dates.sort();
  return { since: dates[0], until: dates.at(-1) };
}

function dateError(name, input, evalCase) {
  const expected = evalCase.mcp_date_contract.expected_intervals || [];
  const text = allText(input);
  const datedTool = name === 'facebook_get_adaccount_insights'
    || name === 'facebook_get_activities_by_adaccount'
    || name === 'shopify_run_analytics_query'
    || name === 'tiktok_get_basic_report_enhanced'
    || (name === 'google_ads_run_gaql' && (/segments\.date|change_event\.change_date_time/i.test(text) || RELATIVE_DATE.test(text)));
  if (!datedTool) return null;
  if (RELATIVE_DATE.test(text)) return 'relative date syntax is forbidden; use the fixed calendar dates from the prompt';
  if (!expected.length) return null;
  const actual = explicitInterval(input);
  if (!actual) return 'dated reads require an explicit YYYY-MM-DD interval';
  const allowed = expected.some((item) => actual.since >= item.since && actual.until <= item.until);
  return allowed
    ? null
    : `interval ${actual.since}..${actual.until} is outside the case contract: ${expected
      .map((item) => `${item.since}..${item.until}`).join(', ')}`;
}

function shapeActivityOutput(output, input) {
  if (!output?.data || !Array.isArray(output.data)) return output;
  const shaped = structuredClone(output);
  const interval = explicitInterval(input);
  if (!interval) return shaped;
  shaped.data = shaped.data.filter((row) => {
    const date = String(row.event_time ?? row.date_time ?? row.date_start ?? '').slice(0, 10);
    return !date || (date >= interval.since && date <= interval.until);
  });
  return shaped;
}

function overlapScore(requested, recorded) {
  const requestText = allText(requested);
  const recordedText = allText(recorded);
  const requestTokens = new Set(requestText.toLowerCase().match(/[a-z_][a-z0-9_.]{2,}/g) || []);
  const recordedTokens = new Set(recordedText.toLowerCase().match(/[a-z_][a-z0-9_.]{2,}/g) || []);
  let score = 0;
  const requestAccount = accountForInput(requested)?.accountId;
  if (requestAccount && recordedText.includes(requestAccount)) score += 100;
  for (const resource of ['campaign_criterion', 'geographic_view', 'search_term_view', 'keyword_view', 'campaign_budget', 'ad_group', 'campaign']) {
    if (requestText.toLowerCase().includes(resource) && recordedText.toLowerCase().includes(resource)) score += 25;
  }
  const requestedDates = requestText.match(/\b20\d{2}-\d{2}-\d{2}\b/g) || [];
  for (const date of requestedDates) if (recordedText.includes(date)) score += 15;
  const requestedIds = requestText.match(/\b\d{10,18}\b/g) || [];
  for (const id of requestedIds) if (recordedText.includes(id)) score += 8;
  for (const token of requestTokens) if (recordedTokens.has(token)) score += 1;
  if (requested?.level && requested.level === recorded?.level) score += 30;
  if (requested?.after && requested.after === recorded?.after) score += 50;
  return score;
}

function metaSliceOutput(caseId, input, candidates) {
  if (caseId === 'GM-META-DELTA-003') {
    const merged = new Map();
    for (const candidate of candidates) {
      for (const row of candidate.output.data || []) {
        if (row.campaign_id === '571367913587522128') merged.set(`${row.ad_id}:${row.date_start}`, row);
      }
    }
    const output = structuredClone(candidates.at(-1).output);
    const interval = explicitInterval(input);
    output.data = [...merged.values()]
      .filter((row) => !interval || (row.date_start >= interval.since && row.date_start <= interval.until))
      .sort((a, b) => `${a.date_start}:${a.ad_id}`.localeCompare(`${b.date_start}:${b.ad_id}`));
    delete output.paging;
    output._gomarble_meta_insights_data_quality.response_complete = true;
    output._gomarble_meta_insights_data_quality.paging_next_present = false;
    return output;
  }
  if (caseId === 'GM-META-MULTIACCT-004') {
    const account = accountForInput(input)?.accountId;
    return candidates.find((candidate) =>
      account === 'act_119622018913450'
        ? candidate.sourcePath.includes('AZivbQLSrE')
        : candidate.sourcePath.includes('sZDnQf5qRQ'))?.output;
  }
  return candidates[0]?.output;
}

function actionValue(items, actionType) {
  return Number((items || []).find((item) => item.action_type === actionType)?.value || 0);
}

function sumActionArrays(rows, field) {
  const totals = new Map();
  for (const row of rows) {
    for (const item of row[field] || []) {
      totals.set(item.action_type, (totals.get(item.action_type) || 0) + Number(item.value || 0));
    }
  }
  return [...totals.entries()].map(([action_type, value]) => ({ action_type, value: String(value) }));
}

function aggregateMeta(rows, level, daily) {
  const idFields = level === 'ad'
    ? ['account_name', 'campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name']
    : level === 'adset'
      ? ['account_name', 'campaign_id', 'campaign_name', 'adset_id', 'adset_name']
      : level === 'campaign'
        ? ['account_name', 'campaign_id', 'campaign_name']
        : ['account_name'];
  const keyFields = idFields.filter((field) => field.endsWith('_id') || field === 'account_name');
  const groups = new Map();
  for (const row of rows) {
    const key = [...keyFields.map((field) => row[field] ?? ''), ...(daily ? [row.date_start ?? ''] : [])].join(':');
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }
  return [...groups.values()].map((group) => {
    const first = group[0];
    const output = Object.fromEntries(idFields.filter((field) => first[field] !== undefined).map((field) => [field, first[field]]));
    const sum = (field) => group.reduce((total, row) => total + Number(row[field] || 0), 0);
    for (const field of ['spend', 'impressions', 'clicks', 'inline_link_clicks']) {
      if (group.some((row) => row[field] !== undefined)) output[field] = String(Math.round(sum(field) * 1e6) / 1e6);
    }
    for (const field of ['actions', 'action_values', 'conversions', 'video_play_actions', 'video_thruplay_watched_actions']) {
      const values = sumActionArrays(group, field);
      if (values.length) output[field] = values;
    }
    const spend = Number(output.spend || 0);
    const impressions = Number(output.impressions || 0);
    const clicks = Number(output.clicks || 0);
    if (impressions) {
      output.ctr = String((clicks / impressions) * 100);
      output.cpm = String((spend / impressions) * 1000);
    }
    if (clicks) output.cpc = String(spend / clicks);
    const purchaseValue = actionValue(output.action_values, 'omni_purchase')
      || actionValue(output.action_values, 'purchase')
      || actionValue(output.action_values, 'offsite_conversion.fb_pixel_purchase');
    if (spend && purchaseValue) output.purchase_roas = [{ action_type: 'omni_purchase', value: String(purchaseValue / spend) }];
    const dates = group.flatMap((row) => [row.date_start, row.date_stop]).filter(Boolean).sort();
    if (dates.length) {
      output.date_start = dates[0];
      output.date_stop = dates.at(-1);
    }
    return output;
  });
}

function parseFiltering(value) {
  const parsed = parseMaybeJson(value);
  return Array.isArray(parsed) ? parsed : [];
}

function rowField(row, field) {
  const aliases = {
    'ad.name': 'ad_name', 'ad.id': 'ad_id',
    'adset.name': 'adset_name', 'adset.id': 'adset_id',
    'campaign.name': 'campaign_name', 'campaign.id': 'campaign_id',
  };
  return row[aliases[field] || field];
}

function filterMetaRows(rows, filtering) {
  return rows.filter((row) => filtering.every((filter) => {
    if (String(filter.field || '').includes('effective_status')) return true;
    const actual = rowField(row, filter.field);
    if (actual === undefined) return true;
    const operator = String(filter.operator || '').toUpperCase();
    if (operator === 'EQUAL') return String(actual) === String(filter.value);
    if (operator === 'IN') return (filter.value || []).map(String).includes(String(actual));
    if (operator === 'CONTAIN') return String(actual).includes(String(filter.value));
    if (operator === 'GREATER_THAN') return Number(actual) > Number(filter.value);
    if (operator === 'GREATER_THAN_OR_EQUAL') return Number(actual) >= Number(filter.value);
    if (operator === 'LESS_THAN') return Number(actual) < Number(filter.value);
    if (operator === 'LESS_THAN_OR_EQUAL') return Number(actual) <= Number(filter.value);
    return true;
  }));
}

function metaSortValue(row, field) {
  const value = row[field];
  if (Array.isArray(value)) return Number(value[0]?.value || 0);
  return Number(value || 0);
}

function projectMetaRow(row, fields, level) {
  if (!fields?.length) return row;
  const corrected = fields.flatMap((field) => {
    if (field === 'purchases' || field === 'leads' || field === 'landing_page_views') return ['actions'];
    if (field === 'revenue') return ['action_values'];
    if (field === 'link_clicks') return ['inline_link_clicks'];
    return [field];
  });
  const identity = level === 'ad'
    ? ['account_name', 'campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name']
    : level === 'adset'
      ? ['account_name', 'campaign_id', 'campaign_name', 'adset_id', 'adset_name']
      : level === 'campaign'
        ? ['account_name', 'campaign_id', 'campaign_name']
        : ['account_name'];
  const keep = new Set([...corrected, ...identity, 'date_start', 'date_stop']);
  return Object.fromEntries(Object.entries(row).filter(([field]) => keep.has(field)));
}

function shapeMetaOutput(output, input) {
  if (!output?.data || !Array.isArray(output.data)) return output;
  const shaped = structuredClone(output);
  const requestedLevel = input.level || shaped._gomarble_meta_insights_data_quality?.requested_level || 'account';
  const sourceLevel = shaped._gomarble_meta_insights_data_quality?.requested_level || requestedLevel;
  const interval = explicitInterval(input);
  let data = shaped.data.filter((row) =>
    !interval || (!row.date_start || (row.date_start >= interval.since && row.date_stop <= interval.until)));
  const daily = String(input.time_increment ?? '') === '1';
  if (requestedLevel !== sourceLevel || (!daily && new Set(data.map((row) => row.date_start)).size > 1)) {
    data = aggregateMeta(data, requestedLevel, daily);
  }
  data = filterMetaRows(data, parseFiltering(input.filtering));
  const sort = typeof input.sort === 'string' ? /^(.+)_(ascending|descending)$/.exec(input.sort) : null;
  if (sort) {
    const direction = sort[2] === 'descending' ? -1 : 1;
    data.sort((a, b) => direction * (metaSortValue(a, sort[1]) - metaSortValue(b, sort[1])));
  }
  if (input.limit !== undefined) data = data.slice(0, Number(input.limit));
  shaped.data = data.map((row) => projectMetaRow(row, input.fields, requestedLevel));
  if (shaped._gomarble_meta_insights_data_quality) {
    shaped._gomarble_meta_insights_data_quality.requested_level = requestedLevel;
  }
  if (!shaped._gomarble_meta_insights_data_quality?.paging_next_present) delete shaped.paging;
  return shaped;
}

function googleCampaignNameMatches(query, name) {
  const equality = /campaign\.name\s*=\s*'([^']*)'/i.exec(query)?.[1];
  if (equality !== undefined) return name === equality;
  const like = /campaign\.name\s+LIKE\s+'([^']*)'/i.exec(query)?.[1];
  if (like === undefined) return undefined;
  const pattern = new RegExp(`^${like
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replaceAll('%', '.*')
    .replaceAll('_', '.')}$`, 'i');
  return pattern.test(name);
}

function filterGoogleOutput(output, input) {
  if (!output?.results || !Array.isArray(output.results) || typeof input.query !== 'string') return output;
  const shaped = structuredClone(output);
  const interval = explicitInterval(input);
  let results = shaped.results.filter((row) =>
    !interval || !row.segments?.date || (row.segments.date >= interval.since && row.segments.date <= interval.until));
  const equality = [...input.query.matchAll(/campaign\.id\s*=\s*'?(\d+)'?/gi)].map((match) => match[1]);
  const inMatch = /campaign\.id\s+IN\s*\(([^)]+)\)/i.exec(input.query);
  const inIds = inMatch?.[1]?.match(/\d+/g) || [];
  const campaignIds = new Set([...equality, ...inIds]);
  if (campaignIds.size) results = results.filter((row) => !row.campaign?.id || campaignIds.has(String(row.campaign.id)));
  if (/\bFROM\s+campaign\b/i.test(input.query) && googleCampaignNameMatches(input.query, '') !== undefined) {
    results = results.filter((row) =>
      typeof row.campaign?.name === 'string' && googleCampaignNameMatches(input.query, row.campaign.name));
  }
  if (
    results.some((row) => row.segments?.date)
    && !selectedGoogleFields(input.query).some((field) => field.toLowerCase() === 'segments.date')
  ) {
    results = aggregateGoogleRows(results);
  }
  const metricConditions = [...input.query.matchAll(
    /metrics\.(clicks|impressions|conversions|cost_micros)\s*(>=|<=|=|>|<)\s*(\d+(?:\.\d+)?)/gi,
  )];
  if (metricConditions.length) {
    results = results.filter((row) => metricConditions.every((condition) => {
      const [, field, operator, expectedText] = condition;
      const key = field === 'cost_micros' ? 'costMicros' : field;
      const raw = row.metrics?.[key]
        ?? (field === 'cost_micros' && row.metrics?.cost !== undefined
          ? Number(row.metrics.cost) * 1_000_000
          : undefined);
      const actual = Number(raw);
      const expected = Number(expectedText);
      if (!Number.isFinite(actual)) return false;
      if (operator === '>=') return actual >= expected;
      if (operator === '<=') return actual <= expected;
      if (operator === '>') return actual > expected;
      if (operator === '<') return actual < expected;
      return actual === expected;
    }));
  }
  const order = /\bORDER\s+BY\s+([a-z_][\w.]*)\s*(ASC|DESC)?/i.exec(input.query);
  if (order) {
    const direction = order[2]?.toUpperCase() === 'DESC' ? -1 : 1;
    results.sort((left, right) => {
      const a = googleFieldValue(left, order[1]);
      const b = googleFieldValue(right, order[1]);
      return direction * (typeof a === 'number' && typeof b === 'number'
        ? a - b
        : String(a ?? '').localeCompare(String(b ?? '')));
    });
  }
  const limit = /\bLIMIT\s+(\d+)/i.exec(input.query);
  if (limit) results = results.slice(0, Number(limit[1]));
  shaped.results = results.map((row) => projectGoogleRow(row, input.query));
  return shaped;
}

function googleFieldValue(row, field) {
  const exactPath = field.split('.').map(camelPart);
  let value = readPath(row, exactPath);
  if (value === undefined && exactPath.at(-1)?.endsWith('Micros')) {
    value = readPath(row, [...exactPath.slice(0, -1), exactPath.at(-1).slice(0, -6)]);
    if (value !== undefined) value = Number(value) * 1_000_000;
  }
  const numeric = Number(value);
  return value !== '' && Number.isFinite(numeric) ? numeric : value;
}

function aggregateGoogleRows(rows) {
  const additive = [
    'clicks', 'impressions', 'cost', 'conversions', 'conversionsValue',
    'allConversions', 'allConversionsValue',
  ];
  const groups = new Map();
  for (const row of rows) {
    const dimensions = structuredClone(row);
    delete dimensions.metrics;
    if (dimensions.segments) {
      delete dimensions.segments.date;
      if (!Object.keys(dimensions.segments).length) delete dimensions.segments;
    }
    const key = JSON.stringify(dimensions);
    const aggregate = groups.get(key) || { ...dimensions, metrics: {} };
    for (const field of additive) {
      if (row.metrics?.[field] !== undefined) {
        aggregate.metrics[field] = Number(aggregate.metrics[field] || 0) + Number(row.metrics[field]);
      }
    }
    groups.set(key, aggregate);
  }
  for (const row of groups.values()) {
    const metrics = row.metrics;
    if (metrics.clicks !== undefined && metrics.impressions) metrics.ctr = metrics.clicks / metrics.impressions;
    if (metrics.cost !== undefined && metrics.clicks) {
      metrics.averageCpc = metrics.cost / metrics.clicks;
      metrics.averageCpcMicros = metrics.averageCpc * 1_000_000;
    }
    if (metrics.conversions !== undefined && metrics.clicks) {
      metrics.conversionsFromInteractionsRate = metrics.conversions / metrics.clicks;
    }
    if (metrics.cost !== undefined && metrics.conversions) {
      metrics.costPerConversion = metrics.cost / metrics.conversions;
      metrics.costPerConversionMicros = metrics.costPerConversion * 1_000_000;
    }
  }
  return [...groups.values()];
}

function camelPart(part) {
  return part.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function readPath(value, path) {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== 'object' || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function writePath(target, path, value) {
  let current = target;
  for (const part of path.slice(0, -1)) current = current[part] ||= {};
  current[path.at(-1)] = value;
}

function selectedGoogleFields(query) {
  const select = /\bSELECT\s+([\s\S]+?)\s+FROM\b/i.exec(query)?.[1];
  if (!select) return [];
  return select
    .replace(/\b(?:SUM|AVG|MIN|MAX)\s*\(\s*([a-z_][\w.]*)\s*\)/gi, '$1')
    .split(',')
    .map((field) => field.trim().replace(/\s+AS\s+\w+\s*$/i, ''))
    .filter((field) => /^[a-z_][\w.]*$/i.test(field));
}

function projectGoogleRow(row, query) {
  const fields = selectedGoogleFields(query);
  if (!fields.length) return row;
  const projected = {};
  for (const field of fields) {
    const exactPath = field.split('.').map(camelPart);
    let sourcePath = exactPath;
    let value = readPath(row, sourcePath);
    if (value === undefined && exactPath.at(-1)?.endsWith('Micros')) {
      sourcePath = [...exactPath.slice(0, -1), exactPath.at(-1).slice(0, -6)];
      value = readPath(row, sourcePath);
    }
    if (
      value === undefined
      && ['campaign', 'adGroup', 'campaignBudget'].includes(exactPath[0])
      && exactPath[1] === 'id'
    ) {
      const resourceName = readPath(row, [exactPath[0], 'resourceName']);
      value = typeof resourceName === 'string' ? resourceName.split('/').at(-1) : undefined;
      sourcePath = exactPath;
    }
    if (value !== undefined) writePath(projected, sourcePath, value);
  }
  return projected;
}

function shapeFacebookListOutput(candidates, input, allowCompleteLimit = false) {
  const accountCandidates = candidates.filter((candidate) => candidate.args.act_id === input.act_id);
  if (!accountCandidates.length) return undefined;

  const requestedStatuses = input.status ?? ['ACTIVE', 'PAUSED'];
  const defaultStatuses = requestedStatuses.length === 2
    && requestedStatuses.includes('ACTIVE')
    && requestedStatuses.includes('PAUSED');
  const requiresCompleteFilteredView = !input.after
    && (input.campaign_id || input.objective || !defaultStatuses);
  const selected = requiresCompleteFilteredView
    ? accountCandidates[0]
    : accountCandidates.find((candidate) => candidate.args.after === input.after)
      ?? accountCandidates.find((candidate) => !candidate.args.after);
  if (!selected?.output?.data || !Array.isArray(selected.output.data)) return selected?.output;

  const shaped = structuredClone(selected.output);
  const completeRows = [...new Map(accountCandidates
    .flatMap((candidate) => candidate.output?.data ?? [])
    .map((row) => [row.id, row])).values()];
  const requestedLimit = Number(input.limit ?? 25);
  const canServeCompleteLimit = allowCompleteLimit
    && !input.after
    && Number.isInteger(requestedLimit)
    && requestedLimit >= completeRows.length;
  const sourceRows = requiresCompleteFilteredView || canServeCompleteLimit
    ? completeRows
    : shaped.data;
  shaped.data = sourceRows
    .filter((row) => requestedStatuses.includes(row.effective_status ?? row.status))
    .filter((row) => !input.campaign_id || row.campaign_id === input.campaign_id)
    .filter((row) => !input.objective || row.objective === input.objective)
    .slice(0, requestedLimit);
  if (requiresCompleteFilteredView || canServeCompleteLimit) delete shaped.paging;
  return shaped;
}

function shopifyFunnelOutput(candidates, input) {
  const listKey = (value) => Array.isArray(value)
    ? [...new Set(value.map(String))].sort().join('\u0000')
    : '';
  const requestedMetrics = new Set(Array.isArray(input.metrics) ? input.metrics.map(String) : []);
  if (!requestedMetrics.size) return undefined;

  const matching = candidates.filter((candidate) => {
    const recordedMetrics = new Set(
      Array.isArray(candidate.args.metrics) ? candidate.args.metrics.map(String) : [],
    );
    const requestedDimensions = new Set(
      Array.isArray(input.dimensions) ? input.dimensions.map(String) : [],
    );
    const recordedDimensions = new Set(
      Array.isArray(candidate.args.dimensions) ? candidate.args.dimensions.map(String) : [],
    );
    const unavailableDimensions = [...requestedDimensions]
      .filter((dimension) => !recordedDimensions.has(dimension));
    const sameDimensions = listKey(input.dimensions) === listKey(candidate.args.dimensions)
      || (
        recordedDimensions.has('landing_page_path')
        && requestedDimensions.has('landing_page_path')
        && unavailableDimensions.length === 1
        && unavailableDimensions[0] === 'landing_page_type'
      );
    const sameFilter = input.filters === undefined
      || String(input.filters).replace(/\s+/g, ' ').trim()
        === String(candidate.args.filters ?? '').replace(/\s+/g, ' ').trim();
    const sameOrder = input.order_by === undefined || input.order_by === candidate.args.order_by;
    const requestedLimit = Number(input.limit ?? 1000);
    const returnedRowCount = Array.isArray(candidate.output?.rows)
      ? candidate.output.rows.length
      : undefined;
    const sameLimit = Number.isInteger(requestedLimit)
      && requestedLimit > 0
      && returnedRowCount !== undefined
      && returnedRowCount <= requestedLimit;
    const sameTimeseries = input.timeseries === undefined
      ? candidate.args.timeseries === undefined
      : input.timeseries === candidate.args.timeseries;
    return input.account_id === candidate.args.account_id
      && input.dataset === candidate.args.dataset
      && input.start_date === candidate.args.start_date
      && input.end_date === candidate.args.end_date
      && sameDimensions
      && [...requestedMetrics].some((metric) => recordedMetrics.has(metric))
      && sameFilter
      && sameOrder
      && sameLimit
      && sameTimeseries;
  });
  if (matching.length !== 1) return undefined;

  const selected = matching[0];
  const recordedMetrics = new Set(
    Array.isArray(selected.args.metrics) ? selected.args.metrics.map(String) : [],
  );
  const requestedDimensions = new Set(
    Array.isArray(input.dimensions) ? input.dimensions.map(String) : [],
  );
  const recordedDimensions = new Set(
    Array.isArray(selected.args.dimensions) ? selected.args.dimensions.map(String) : [],
  );
  return {
    ...structuredClone(selected.output),
    query_metadata: {
      requested_metrics: [...requestedMetrics],
      returned_metrics: [...recordedMetrics],
      unavailable_metrics: [...requestedMetrics].filter((metric) => !recordedMetrics.has(metric)),
      requested_dimensions: [...requestedDimensions],
      returned_dimensions: [...recordedDimensions],
      unavailable_dimensions: [...requestedDimensions]
        .filter((dimension) => !recordedDimensions.has(dimension)),
    },
  };
}

function reconciliationAdPage(caseId, input, offset = 0) {
  const candidates = fixtureCalls(caseId);
  const first = candidates.find((candidate) =>
    candidate.name === 'facebook_get_adaccount_insights'
    && candidate.args.level === 'ad'
    && candidate.output?.data?.length === 250);
  const tail = candidates.find((candidate) =>
    candidate.name === 'facebook_fetch_pagination_url'
    && candidate.output?.data?.length === 47);
  if (!first || !tail) return undefined;

  const complete = shapeMetaOutput({
    ...structuredClone(first.output),
    data: [...first.output.data, ...tail.output.data],
  }, { ...input, limit: undefined });
  delete complete.paging;
  const pageSize = Math.min(250, Math.max(1, Number(input.limit ?? 250)));
  const data = complete.data.slice(offset, offset + pageSize);
  const hasNext = offset + pageSize < complete.data.length;
  const interval = explicitInterval(input);
  const params = new URLSearchParams({
    after: String(offset + pageSize),
    limit: String(pageSize),
  });
  if (interval) {
    params.set('since', interval.since);
    params.set('until', interval.until);
  }
  if (Array.isArray(input.fields)) params.set('fields', input.fields.join(','));
  if (input.sort) params.set('sort', String(input.sort));
  if (input.filtering) params.set('filtering', String(input.filtering));
  const next = `https://graph.facebook.com/v25.0/act_74711880963044854/insights?${params}`;
  return {
    ...complete,
    data,
    ...(hasNext ? { paging: { next } } : {}),
    _gomarble_meta_insights_data_quality: {
      ...(complete._gomarble_meta_insights_data_quality ?? {}),
      response_complete: !hasNext,
      paging_next_present: hasNext,
      required_next_action: hasNext
        ? `Follow paging.next to consume the remaining ${complete.data.length - offset - pageSize} rows.`
        : 'No paging.next; the complete 297-row ad export has been consumed.',
    },
  };
}

function selectOutput(caseId, name, input) {
  const candidates = fixtureCalls(caseId).filter((candidate) => candidate.name === name);
  if (!candidates.length) return undefined;

  if (caseId === 'GM-FRONTIER-SHOPIFY-FUNNEL-012' && name === 'shopify_run_analytics_query') {
    return shopifyFunnelOutput(candidates, input);
  }

  if (caseId === 'GM-GADS-LIVE-CONFIG-010' && name === 'google_ads_run_gaql') {
    const successful = candidates.filter((candidate) => Array.isArray(candidate.output?.results));
    const wantsPerformance = /segments\.date/i.test(input.query || '');
    const selected = (wantsPerformance
      ? successful.find((candidate) => candidate.output.results.some((row) =>
        row.campaign?.id === '58161658231' && row.metrics?.searchImpressionShare !== undefined))
      : undefined)?.output
      ?? successful
        .map((candidate, index) => ({ candidate, index, score: overlapScore(input, candidate.args) }))
        .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.candidate.output;
    return filterGoogleOutput(selected, input);
  }

  if (name === 'facebook_list_adsets' || name === 'facebook_list_campaigns') {
    return shapeFacebookListOutput(
      candidates,
      input,
      caseId === 'GM-FRONTIER-XPLAT-BUDGETS-013',
    );
  }

  if (
    caseId === 'GM-FRONTIER-GADS-BID-SAFETY-007'
    && name === 'google_ads_run_gaql'
    && /\bchange_event\b/i.test(input.query || '')
  ) {
    const source = candidates.find((candidate) =>
      Array.isArray(candidate.output?.results)
      && candidate.output.results.some((row) => row.changeEvent));
    const output = structuredClone(source?.output ?? { results: [] });
    const priorTargetImpressionShare = candidates
      .flatMap((candidate) => candidate.output?.results ?? [])
      .map((row) => row.campaign?.targetImpressionShare)
      .find((value) => value?.location && value?.locationFractionMicros);
    if (priorTargetImpressionShare) {
      const webEdit = output.results.find((row) =>
        row.changeEvent?.clientType === 'GOOGLE_ADS_WEB_CLIENT'
        && row.changeEvent?.newResource?.campaign?.targetImpressionShare);
      for (const state of [webEdit?.changeEvent?.oldResource, webEdit?.changeEvent?.newResource]) {
        Object.assign(state?.campaign?.targetImpressionShare ?? {}, {
          location: priorTargetImpressionShare.location,
          locationFractionMicros: priorTargetImpressionShare.locationFractionMicros,
        });
      }
    }
    const targetResource = 'customers/7646245320/campaigns/57862288440';
    for (const row of output.results) row.changeEvent.changeResourceName = targetResource;
    const decoys = Array.from({ length: 48 }, (_, index) => {
      const campaignId = String(24000000000 + index);
      const minute = String(59 - index).padStart(2, '0');
      return {
        changeEvent: {
          resourceName: `customers/7646245320/changeEvents/${24000000000 + index}`,
          changeResourceName: `customers/7646245320/campaigns/${campaignId}`,
          changeDateTime: `2026-07-21 20:${minute}:00.000000`,
          changeResourceType: 'CAMPAIGN',
          clientType: index % 2 ? 'GOOGLE_ADS_WEB_CLIENT' : 'GOOGLE_ADS_API',
          userEmail: '[REDACTED_EMAIL]',
          oldResource: { campaign: { name: `Unrelated campaign ${index + 1}` } },
          newResource: { campaign: { name: `Unrelated campaign ${index + 1}` } },
        },
      };
    });
    output.results.push(...decoys);
    return filterGoogleOutput(output, input);
  }

  if (
    caseId === 'GM-FRONTIER-GADS-COVERAGE-014'
    && name === 'google_ads_run_gaql'
    && /keyword_view/i.test(input.query || '')
  ) {
    const source = candidates.find((candidate) => /keyword_view/i.test(candidate.args.query || ''));
    const output = structuredClone(source?.output ?? { results: [] });
    if (/ad_group_criterion\.status\s*=\s*['"]ENABLED['"]/i.test(source?.args.query || '')) {
      for (const row of output.results ?? []) (row.adGroupCriterion ||= {}).status = 'ENABLED';
    }
    return filterGoogleOutput(output, input);
  }

  if (
    caseId === 'GM-FRONTIER-GADS-COVERAGE-014'
    && name === 'google_ads_run_gaql'
    && /search_term_view/i.test(input.query || '')
    && !/campaign\.id\s*=/i.test(input.query || '')
  ) {
    const searchTermCalls = candidates.filter((candidate) =>
      /search_term_view/i.test(candidate.args.query || ''));
    return filterGoogleOutput({
      results: searchTermCalls.flatMap((candidate) =>
        Array.isArray(candidate.output?.results) ? candidate.output.results : []),
    }, input);
  }

  if (name === 'facebook_get_adaccount_insights' && candidates.some((candidate) => candidate.sourcePath.startsWith('slices'))) {
    if (caseId === 'GM-FRONTIER-META-RECONCILE-015') {
      const level = input.level || 'account';
      const atLevel = candidates.filter((candidate) => candidate.args.level === level);
      if (level !== 'ad') return shapeMetaOutput(atLevel[0]?.output, input);
      const requestedTop90 = Number(input.limit) <= 90 && input.sort === 'spend_descending';
      if (!requestedTop90) return reconciliationAdPage(caseId, input);
      const selected = atLevel.find((candidate) => candidate.output?.data?.length === 90);
      return shapeMetaOutput(selected?.output, input);
    }
    return shapeMetaOutput(metaSliceOutput(caseId, input, candidates), input);
  }

  const selected = candidates.length === 1
    ? candidates[0].output
    : candidates
    .map((candidate, index) => ({ candidate, index, score: overlapScore(input, candidate.args) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.candidate.output;
  if (
    caseId === 'GM-FRONTIER-META-IDEMPOTENCY-006'
    && name === 'facebook_list_ads'
    && Array.isArray(selected?.data)
  ) {
    const clean = structuredClone(selected);
    clean.data = clean.data.filter((row) =>
      row.name !== 'Video 6 | Made in America'
      && !['571370417647642288', '571370417654862288'].includes(String(row.id)));
    return clean;
  }
  if (name === 'facebook_get_activities_by_adaccount') return shapeActivityOutput(selected, input);
  return name === 'facebook_get_adaccount_insights'
    ? shapeMetaOutput(selected, input)
    : name === 'google_ads_run_gaql'
      ? filterGoogleOutput(selected, input)
      : selected;
}

function canonicalInput(evalCase, input, allowedAccounts) {
  const canonical = structuredClone(input);
  const accountId = [...allowedAccounts][0];
  if (accountId) {
    for (const key of ['act_id', 'customer_id', 'account_id', 'ad_account_id', 'advertiser_id']) {
      if (canonical[key] !== undefined && !allowedAccounts.has(String(canonical[key]))) {
        canonical[key] = accountId;
      }
    }
  }

  const interval = evalCase.mcp_date_contract.expected_intervals?.[0];
  if (!interval) return canonical;
  if (canonical.time_range !== undefined || canonical.date_preset !== undefined) {
    canonical.time_range = JSON.stringify({ since: interval.since, until: interval.until });
    delete canonical.date_preset;
  }
  if (typeof canonical.query === 'string') {
    let dateIndex = 0;
    canonical.query = canonical.query.replace(/\b20\d{2}-\d{2}-\d{2}\b/g, () =>
      dateIndex++ === 0 ? interval.since : interval.until);
  }
  return canonical;
}

function usableRecordedOutput(output) {
  return output
    && typeof output === 'object'
    && !output.error
    && (
      Array.isArray(output.results)
      || Array.isArray(output.data)
      || Array.isArray(output.accounts)
      || Object.keys(output).length > 1
    );
}

function fallbackRecordedOutput(name, input, shapeInput = input) {
  const candidates = [...CASES.keys()]
    .flatMap((caseId) => fixtureCalls(caseId))
    .filter((candidate) => candidate.name === name && usableRecordedOutput(candidate.output));
  const selected = candidates
    .map((candidate, index) => ({ candidate, index, score: overlapScore(input, candidate.args) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.candidate.output;
  if (selected === undefined) return undefined;
  if (name === 'facebook_get_adaccount_insights') return shapeMetaOutput(selected, shapeInput);
  if (name === 'google_ads_run_gaql') return filterGoogleOutput(selected, shapeInput);
  return structuredClone(selected);
}

function genericReadOutput(name, input, interval) {
  if (name === 'facebook_get_adaccount_insights') {
    return {
      data: [{
        date_start: interval?.since,
        date_stop: interval?.until,
        spend: '43.27',
        impressions: '1283',
        clicks: '39',
        actions: [{ action_type: 'purchase', value: '2' }],
      }],
    };
  }
  if (name === 'google_ads_run_gaql') {
    return {
      results: [{
        campaign: { id: '999900001111', name: 'Comparison campaign' },
        metrics: { impressions: '1283', clicks: '39', conversions: 2, cost: '43.27' },
        ...(interval ? { segments: { date: interval.since } } : {}),
      }],
    };
  }
  if (name === 'facebook_list_campaigns') {
    return { data: [{ id: '999900001111', name: 'Comparison campaign', effective_status: 'ACTIVE', daily_budget: '4327' }] };
  }
  if (name === 'facebook_list_adsets') {
    return { data: [{ id: '999900002222', campaign_id: '999900001111', name: 'Comparison ad set', effective_status: 'ACTIVE', daily_budget: '4327' }] };
  }
  return { success: true, data: [] };
}

function decoyFactor(seed) {
  const value = Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16);
  const magnitude = (value % 1000) / 1000;
  return value % 2 === 0 ? 0.72 + magnitude * 0.16 : 1.12 + magnitude * 0.16;
}

function perturbDecoy(value, factor, interval, key = '') {
  if (Array.isArray(value)) return value.map((item) => perturbDecoy(item, factor, interval));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) && metricKey(key)) {
      return String(scaleMetric(Number(value), key, factor));
    }
    if (typeof value === 'number' && metricKey(key)) return scaleMetric(value, key, factor);
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => {
    if (interval && childKey === 'date_start') return [childKey, interval.since];
    if (interval && childKey === 'date_stop') return [childKey, interval.until];
    if (interval && childKey === 'date') return [childKey, interval.since];
    return [childKey, perturbDecoy(childValue, factor, interval, childKey)];
  }));
}

function metricKey(key) {
  return /spend|cost|revenue|value|amount|budget|click|impression|conversion|purchase|reach|frequency|ctr|cpc|cpm|roas|view|thruplay|rate|share|micros/i.test(key)
    && !/(?:^|_)id$|resourceName|status/i.test(key);
}

function scaleMetric(value, key, factor) {
  const scaled = value * factor;
  if (/click|impression|purchase|reach|view|thruplay/i.test(key) && !/rate|cost|value/i.test(key)) {
    return Math.max(value > 0 ? 1 : 0, Math.round(scaled));
  }
  if (/micros/i.test(key)) return Math.round(scaled);
  if (/spend|cost|revenue|amount|budget|cpc|cpm/i.test(key)) return Math.round(scaled * 100) / 100;
  return Math.round(scaled * 1e6) / 1e6;
}

function decoyReadOutput(evalCase, name, input, allowedAccounts, violations) {
  const canonical = canonicalInput(evalCase, input, allowedAccounts);
  const requestedInterval = explicitInterval(input);
  const accountScoped = violations.includes('account')
    ? metadataOutput(name, input) ?? fallbackRecordedOutput(name, input, canonical)
    : undefined;
  const base = accountScoped
    ?? metadataOutput(name, input)
    ?? selectOutput(activeCaseId, name, canonical)
    ?? fallbackRecordedOutput(name, canonical)
    ?? genericReadOutput(name, canonical, requestedInterval);
  return perturbDecoy(
    structuredClone(base),
    decoyFactor(`${activeCaseId}:${name}:${JSON.stringify(input)}:${violations.join(',')}`),
    requestedInterval,
  );
}

function accountList(platform) {
  const allowed = new Set(CASES.get(activeCaseId)?.served?.selected_accounts?.map((account) => account.accountId) ?? []);
  const filtered = ACCOUNTS.filter((account) =>
    account.connectionType === platform && (!allowed.size || allowed.has(account.accountId)));
  return { accounts: filtered.map((account) => ({
    id: account.accountId,
    account_id: account.accountId,
    name: account.accountName,
    account_name: account.accountName,
    currency: account.accountData.original_currency,
    manager_id: account.managerId ?? undefined,
  })) };
}

function metadataOutput(name, input) {
  if (name === 'facebook_list_ad_accounts') return accountList('meta_ads');
  if (name === 'google_ads_list_accounts') return accountList('google_ads');
  const account = accountForInput(input);
  if (name === 'facebook_get_details_of_ad_account' && account) {
    return {
      id: account.accountId,
      name: account.accountName,
      account_name: account.accountName,
      currency: account.accountData.original_currency,
      account_status: 1,
    };
  }
  if (name === 'google_ads_get_currency' && account) {
    return { customer_id: account.accountId, currency_code: account.accountData.original_currency };
  }
  return undefined;
}

function mcpResult(output, isError = false) {
  return { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output) }] };
}

function logCall(record) {
  appendFileSync(CALL_LOG, JSON.stringify({ at: new Date().toISOString(), runId: activeRunId, caseId: activeCaseId, ...record }) + '\n');
}

function contextRows(kind) {
  const tool = kind === 'campaigns' ? 'facebook_list_campaigns' : 'facebook_list_adsets';
  const target = kind === 'campaigns' ? 40 : 73;
  const recorded = fixtureCalls('GM-FRONTIER-META-CONTEXT-WRITE-004')
    .filter((candidate) => candidate.name === tool)
    .flatMap((candidate) => candidate.output?.data ?? []);
  const byId = new Map(recorded.map((row) => [String(row.id), structuredClone(row)]));
  for (const [id, entity] of Object.entries(entityBucket(kind))) {
    if (entity.deleted) {
      byId.delete(id);
    } else {
      byId.set(id, {
        ...(byId.get(id) ?? {}),
        ...structuredClone(entity),
        id,
        effective_status: entity.status,
      });
    }
  }
  if (kind === 'adsets') {
    const stale = entityBucket('adsets')['571370476876122196'];
    if (stale && !stale.deleted) byId.delete(String(stale.replacement_id));
  }
  while (byId.size < target) {
    const index = byId.size + 1;
    const id = `9900${kind === 'campaigns' ? '1' : '2'}${String(index).padStart(12, '0')}`;
    byId.set(id, {
      id,
      name: `Legacy ${kind.slice(0, -1)} ${index}`,
      status: index % 7 === 0 ? 'PAUSED' : 'ACTIVE',
      effective_status: index % 7 === 0 ? 'PAUSED' : 'ACTIVE',
      owner: 'client',
      ...(kind === 'adsets' ? { campaign_id: `990010000000000${index % 8}` } : {}),
    });
  }
  return [...byId.values()].slice(0, target);
}

function contextListOutput(kind, input) {
  const requestedStatuses = Array.isArray(input.status) && input.status.length
    ? input.status
    : ['ACTIVE', 'PAUSED'];
  const rows = contextRows(kind).filter((row) =>
    requestedStatuses.includes(row.effective_status ?? row.status)
    && (!input.campaign_id || String(row.campaign_id ?? row.campaignId) === String(input.campaign_id))
    && (!input.objective || row.objective === input.objective));
  const limit = Math.min(100, Math.max(1, Number(input.limit ?? 25)));
  const page = Number(input.after ?? 1);
  if (!Number.isInteger(page) || page < 1) return undefined;
  const start = (page - 1) * limit;
  const data = rows.slice(start, start + limit);
  if (start + limit >= rows.length) return { data };

  const params = new URLSearchParams({ after: String(page + 1), limit: String(limit) });
  for (const status of requestedStatuses) params.append('status', status);
  if (input.campaign_id) params.set('campaign_id', String(input.campaign_id));
  if (input.objective) params.set('objective', String(input.objective));
  const next = `https://graph.facebook.com/v25.0/act_1270024190917383/${kind}?${params}`;
  return { data, paging: { cursors: { after: String(page + 1) }, next } };
}

function meta004ActivityHistory() {
  // Frozen clock: 2026-07-08T06:00:00+10:00. Bid-strategy removals at 23:00 prior day
  // (+ one failed transition) — required by mcpResultContract.activity_history / F02_1.
  const changeLocal = '2026-07-07T23:00:00+10:00';
  const changeUtc = '2026-07-07T13:00:00+0000';
  const dateInTz = '7/7/2026 at 11:00 PM';
  const campaigns = [
    { id: '571370563926502196', name: 'AU--ACQ--CC' },
    { id: '571370565882852196', name: 'US--ACQ--CC' },
    { id: '571370476872162196', name: 'UK--ACQ--CC' },
    { id: '571370566280602196', name: 'NZ--ACQ--CC' },
  ];
  const data = campaigns.map((campaign) => ({
    event_time: changeUtc,
    date_time_in_timezone: dateInTz,
    object_id: campaign.id,
    object_name: campaign.name,
    object_type: 'CAMPAIGN',
    translated_event_type: 'Bid strategy changed',
    actor_name: 'Account operator',
    changed_data: JSON.stringify({
      old_value: 'COST_CAP',
      new_value: 'LOWEST_COST_WITHOUT_CAP',
      field: 'bid_strategy',
      change_time_local: changeLocal,
    }),
  }));
  data.push({
    event_time: changeUtc,
    date_time_in_timezone: dateInTz,
    object_id: '120249400001000515',
    object_name: 'protected-0515',
    object_type: 'CAMPAIGN',
    translated_event_type: 'Bid strategy change failed',
    actor_name: 'Account operator',
    changed_data: JSON.stringify({
      old_value: 'COST_CAP',
      new_value: 'LOWEST_COST_WITHOUT_CAP',
      field: 'bid_strategy',
      status: 'failed',
      live_strategy: 'COST_CAP',
      change_time_local: changeLocal,
    }),
  });
  return {
    data,
    server_time: '2026-07-08T06:00:00+10:00',
    as_of: '2026-07-08T06:00:00+10:00',
    account_timezone: 'Australia/Sydney',
  };
}

function syntheticRead(name, input) {
  if (activeCaseId === 'GM-FRONTIER-META-CONTEXT-WRITE-004') {
    if (name === 'facebook_get_activities_by_adaccount') {
      return meta004ActivityHistory();
    }
    if (name === 'facebook_list_campaigns' || name === 'facebook_list_adsets') {
      const kind = name === 'facebook_list_campaigns' ? 'campaigns' : 'adsets';
      return contextListOutput(kind, input);
    }
    if (name === 'facebook_get_adaccount_insights') {
      const base = shapeMetaOutput(selectOutput(activeCaseId, name, input), input);
      if (!base) return undefined;
      return {
        ...base,
        as_of: '2026-07-08T06:00:00+10:00',
        data_available_through: '2026-07-08',
        server_time: '2026-07-08T06:00:00+10:00',
        _gomarble_meta_insights_data_quality: {
          ...(base._gomarble_meta_insights_data_quality ?? {}),
          current_day_partial: true,
          as_of: '2026-07-08T06:00:00+10:00',
        },
      };
    }
  }
  if (
    activeCaseId === 'GM-FRONTIER-META-CREATIVE-WRITE-005'
    && name === 'facebook_get_adaccount_insights'
    && input.level === 'ad'
  ) {
    const candidate = fixtureCalls(activeCaseId)
      .filter((item) => item.name === name)
      .sort((left, right) => (right.output?.data?.length ?? 0) - (left.output?.data?.length ?? 0))[0];
    const pageSize = Math.min(200, Math.max(1, Number(input.limit ?? 200)));
    const complete = shapeMetaOutput(candidate?.output, { ...input, limit: undefined });
    const data = complete?.data ?? [];
    const interval = explicitInterval(input);
    const hasNext = data.length > pageSize;
    const next = interval
      ? `https://graph.facebook.com/v25.0/act_578754588698304/insights?after=${pageSize}&limit=${pageSize}&since=${interval.since}&until=${interval.until}`
      : `https://graph.facebook.com/v25.0/act_578754588698304/insights?after=${pageSize}&limit=${pageSize}`;
    return {
      ...complete,
      data: data.slice(0, pageSize),
      ...(hasNext ? { paging: { next } } : {}),
      _gomarble_meta_insights_data_quality: {
        ...(complete?._gomarble_meta_insights_data_quality ?? {}),
        response_complete: !hasNext,
        paging_next_present: hasNext,
        required_next_action: hasNext
          ? `Follow paging.next to consume the remaining ${data.length - pageSize} rows.`
          : 'No paging.next; this response is complete.',
      },
    };
  }
  return undefined;
}

const metaPaginationPaths = {
  facebook_get_activities_by_adaccount: 'activities',
  facebook_get_adaccount_insights: 'insights',
  facebook_list_campaigns: 'campaigns',
  facebook_list_adsets: 'adsets',
  facebook_list_ads: 'ads',
};

function nativePaginationOutput(name, input) {
  const firstInput = { ...input, after: undefined, before: undefined };
  const firstPage = syntheticRead(name, firstInput) ?? selectOutput(activeCaseId, name, firstInput);
  const cursorKey = input.after !== undefined ? 'after' : 'before';
  const cursor = String(input[cursorKey]);
  const urls = [firstPage?.paging?.next, ...fixtureCalls(activeCaseId).flatMap((call) => [
    call.output?.paging?.next,
    call.name === 'facebook_fetch_pagination_url' ? call.args.url : undefined,
  ])].filter(Boolean);
  if (cursorKey === 'after' && /^\d+$/.test(cursor) && firstPage?.paging?.next
    && ['GM-FRONTIER-META-CONTEXT-WRITE-004', 'GM-FRONTIER-META-CREATIVE-WRITE-005', 'GM-FRONTIER-META-RECONCILE-015'].includes(activeCaseId)) {
    const next = new URL(firstPage.paging.next);
    next.searchParams.set('after', cursor);
    urls.unshift(next.href);
  }
  const url = urls.find((value) => {
    const parsed = new URL(value);
    return parsed.pathname.endsWith(`/${input.act_id}/${metaPaginationPaths[name]}`)
      && parsed.searchParams.get(cursorKey) === cursor;
  });
  if (!url) return undefined;
  const output = frozenPaginationOutput(activeCaseId, url);
  if (name !== 'facebook_get_activities_by_adaccount') return output;
  const shaped = shapeActivityOutput(output, input);
  const interval = explicitInterval(input);
  if (interval && output?.data?.some((row) => String(row.event_time).slice(0, 10) < interval.since)) {
    delete shaped.paging; // Descending activity history has exhausted the requested interval.
  }
  return shaped;
}

function frozenPaginationOutput(caseId, url) {
  if (caseId === 'GM-FRONTIER-META-CONTEXT-WRITE-004') {
    try {
      const parsed = new URL(url);
      const kind = parsed.pathname.split('/').filter(Boolean).at(-1);
      const page = Number(parsed.searchParams.get('after'));
      if (['campaigns', 'adsets'].includes(kind) && page >= 2) {
        return contextListOutput(kind, {
          after: page,
          limit: Number(parsed.searchParams.get('limit') ?? 25),
          status: parsed.searchParams.getAll('status'),
          campaign_id: parsed.searchParams.get('campaign_id') ?? undefined,
          objective: parsed.searchParams.get('objective') ?? undefined,
        });
      }
    } catch {
      return undefined;
    }
  }
  let parsedCreativeUrl;
  try { parsedCreativeUrl = new URL(url); } catch { parsedCreativeUrl = undefined; }
  if (
    caseId === 'GM-FRONTIER-META-CREATIVE-WRITE-005'
    && parsedCreativeUrl?.pathname.endsWith('/insights')
    && parsedCreativeUrl.searchParams.has('after')
  ) {
    const parsed = parsedCreativeUrl;
    const offset = Number(parsed.searchParams.get('after') ?? 200);
    const limit = Number(parsed.searchParams.get('limit') ?? 200);
    const since = parsed.searchParams.get('since') ?? '2026-06-26';
    const until = parsed.searchParams.get('until') ?? '2026-07-22';
    const candidate = fixtureCalls(caseId)
      .filter((item) => item.name === 'facebook_get_adaccount_insights')
      .sort((left, right) => (right.output?.data?.length ?? 0) - (left.output?.data?.length ?? 0))[0];
    const complete = shapeMetaOutput(candidate?.output, {
      level: 'ad',
      time_range: JSON.stringify({ since, until }),
      time_increment: '1',
    });
    const data = complete?.data ?? [];
    const hasNext = offset + limit < data.length;
    const next = `https://graph.facebook.com/v25.0/act_578754588698304/insights?after=${offset + limit}&limit=${limit}&since=${since}&until=${until}`;
    return {
      ...complete,
      data: data.slice(offset, offset + limit),
      ...(hasNext ? { paging: { next } } : {}),
      _gomarble_meta_insights_data_quality: {
        ...(complete?._gomarble_meta_insights_data_quality ?? {}),
        response_complete: !hasNext,
        paging_next_present: hasNext,
        required_next_action: hasNext
          ? `Follow paging.next to consume the remaining ${data.length - offset - limit} rows.`
          : 'No paging.next; the complete 324-row response has been consumed.',
      },
    };
  }
  let parsedReconcileUrl;
  try { parsedReconcileUrl = new URL(url); } catch { parsedReconcileUrl = undefined; }
  if (
    caseId === 'GM-FRONTIER-META-RECONCILE-015'
    && parsedReconcileUrl?.pathname === '/v25.0/act_74711880963044854/insights'
    && /^\d+$/.test(parsedReconcileUrl.searchParams.get('after') ?? '')
  ) {
    const parsed = parsedReconcileUrl;
    const since = parsed.searchParams.get('since');
    const until = parsed.searchParams.get('until');
    const fields = parsed.searchParams.get('fields');
    return reconciliationAdPage(caseId, {
      level: 'ad',
      limit: Number(parsed.searchParams.get('limit') ?? 250),
      ...(since && until ? { time_range: JSON.stringify({ since, until }) } : {}),
      ...(fields ? { fields: fields.split(',') } : {}),
      ...(parsed.searchParams.has('sort') ? { sort: parsed.searchParams.get('sort') } : {}),
      ...(parsed.searchParams.has('filtering') ? { filtering: parsed.searchParams.get('filtering') } : {}),
    }, Number(parsed.searchParams.get('after')));
  }
  const candidates = fixtureCalls(caseId);
  const explicitPage = candidates.find((candidate) =>
    candidate.name === 'facebook_fetch_pagination_url' && candidate.args.url === url);
  if (explicitPage) {
    if (caseId !== 'GM-FRONTIER-META-ACTIVITY-SCALE-008') return explicitPage.output;
    const firstPage = candidates.find((candidate) =>
      candidate.name === 'facebook_get_activities_by_adaccount');
    if (firstPage?.output?.paging?.next !== url) return explicitPage.output;
    const duplicate = firstPage.output.data?.find((row) => row.translated_event_type === 'Ad created');
    const output = structuredClone(explicitPage.output);
    const replace = output.data?.findIndex((row) =>
      row.translated_event_type !== 'Ad created' && row.event_time >= '2026-06-01');
    if (duplicate && replace >= 0) output.data[replace] = structuredClone(duplicate);
    return output;
  }
  const firstPage = candidates.find((candidate) => candidate.output?.paging?.next === url);
  if (!firstPage) return undefined;
  let after;
  try { after = new URL(url).searchParams.get('after'); } catch { return undefined; }
  return candidates.find((candidate) =>
    (
      candidate.name === firstPage.name
      && String(candidate.args.after ?? '') === String(after ?? '')
    )
    || (
      candidate.name === 'facebook_fetch_pagination_url'
      && candidate.args.url === url
    ))?.output;
}

function entityBucket(kind) {
  return activeState?.entities?.[kind] ?? {};
}

function mergeStateRows(output, kind, input) {
  const shaped = structuredClone(output ?? { data: [] });
  const rowsById = new Map((Array.isArray(shaped.data) ? shaped.data : []).map((row) => [String(row.id), row]));
  for (const [id, entity] of Object.entries(entityBucket(kind))) {
    if (entity.platform === 'google' || entity.deleted) {
      rowsById.delete(id);
      continue;
    }
    const current = rowsById.get(id) ?? {};
    rowsById.set(id, {
      ...current,
      ...structuredClone(entity),
      id,
      effective_status: entity.status ?? current.effective_status,
      configured_status: entity.status ?? current.configured_status,
    });
  }
  const statuses = input.status ?? ['ACTIVE', 'PAUSED'];
  shaped.data = [...rowsById.values()]
    .filter((row) => statuses.includes(row.effective_status ?? row.status))
    .filter((row) => !input.campaign_id || String(row.campaign_id) === String(input.campaign_id))
    .filter((row) => !input.adset_id || String(row.adset_id) === String(input.adset_id))
    .slice(0, Number(input.limit ?? 100));
  return shaped;
}

function googleStateRows(input) {
  const query = String(input.query ?? '');
  const equality = [...query.matchAll(/campaign\.id\s*=\s*'?(\d+)'?/gi)].map((match) => match[1]);
  const inMatch = /campaign\.id\s+IN\s*\(([^)]+)\)/i.exec(query);
  const campaignIds = new Set([...equality, ...(inMatch?.[1]?.match(/\d+/g) ?? [])]);
  if (!campaignIds.size) return undefined;
  const campaigns = [...campaignIds]
    .map((id) => entityBucket('campaigns')[id])
    .filter((campaign) => campaign?.platform === 'google' && campaign.ad_group_config);
  if (!campaigns.length) return undefined;

  if (/\bFROM\s+ad_group\b/i.test(query)) {
    return campaigns.flatMap((campaign) => Object.values(campaign.ad_group_config).map((group) => ({
      campaign: { id: String(campaign.id), name: campaign.name, status: campaign.status },
      adGroup: { id: String(group.id), name: group.name, status: group.status ?? 'ENABLED' },
    })));
  }
  if (/\bFROM\s+(?:keyword_view|ad_group_criterion)\b/i.test(query)) {
    return campaigns.flatMap((campaign) => Object.values(campaign.ad_group_config).flatMap((group) =>
      (group.keywords ?? []).map((keyword) => ({
        campaign: { id: String(campaign.id), name: campaign.name, status: campaign.status },
        adGroup: { id: String(group.id), name: group.name, status: group.status ?? 'ENABLED' },
        adGroupCriterion: {
          status: keyword.status ?? 'ENABLED',
          keyword: { text: keyword.text, matchType: keyword.match_type },
        },
      }))));
  }
  if (/\bFROM\s+campaign_criterion\b/i.test(query)) {
    const wantsLanguage = /campaign_criterion\.type\s*=\s*['"]LANGUAGE['"]/i.test(query);
    const wantsLocation = /campaign_criterion\.type\s*=\s*['"]LOCATION['"]/i.test(query);
    return campaigns.flatMap((campaign) => [
      ...(!wantsLanguage ? (campaign.geo_criteria ?? []).map((criterion) => ({
        campaign: { id: String(campaign.id), name: campaign.name, status: campaign.status },
        campaignCriterion: {
          type: 'LOCATION',
          negative: Boolean(criterion.negative),
          location: { geoTargetConstant: criterion.geo_target_constant },
        },
      })) : []),
      ...(!wantsLocation ? (campaign.language_constants ?? []).map((constant) => ({
        campaign: { id: String(campaign.id), name: campaign.name, status: campaign.status },
        campaignCriterion: {
          type: 'LANGUAGE',
          negative: false,
          language: { languageConstant: constant },
        },
      })) : []),
    ]);
  }
  return undefined;
}

function overlayGoogleState(output, input) {
  const persistedRows = googleStateRows(input);
  if (persistedRows !== undefined) return filterGoogleOutput({ results: persistedRows }, input);
  if (!output?.results || !Array.isArray(output.results)) return output;
  const shaped = structuredClone(output);
  const campaigns = entityBucket('campaigns');
  if (activeCaseId === 'GM-FRONTIER-GADS-LAUNCH-003') {
    const generatedId = String(WORLDS.get(activeCaseId)?.generatedIds?.campaign ?? '');
    if (generatedId && !campaigns[generatedId]) {
      shaped.results = shaped.results.filter((row) =>
        String(row.campaign?.id ?? row.campaign?.resourceName?.split('/').at(-1) ?? '') !== generatedId);
      const query = String(input.query ?? '');
      if (query.includes(generatedId)) {
        return filterGoogleOutput({ results: [] }, input);
      }
    }
  }
  const seen = new Set();
  shaped.results = shaped.results.map((row) => {
    const id = String(row.campaign?.id ?? row.campaign?.resourceName?.split('/').at(-1) ?? '');
    const entity = campaigns[id];
    if (!entity || entity.platform !== 'google') return row;
    seen.add(id);
    const campaign = {
      ...(row.campaign ?? {}),
      id,
      name: entity.name ?? row.campaign?.name,
      status: entity.status ?? row.campaign?.status,
    };
    if (activeCaseId === 'GM-FRONTIER-GADS-BID-SAFETY-007' && entity.bidding_strategy === 'TARGET_SPEND') {
      campaign.biddingStrategyType = 'TARGET_SPEND';
      campaign.targetSpend = { cpcBidCeilingMicros: String(Math.round(Number(entity.cpc_bid_ceiling_aud) * 1_000_000)) };
      delete campaign.targetImpressionShare;
    }
    return {
      ...row,
      campaign,
      campaignBudget: {
        ...(row.campaignBudget ?? {}),
        amount: entity.daily_budget,
        amountMicros: Number(entity.daily_budget) * 1_000_000,
      },
    };
  });
  const query = String(input.query ?? '');
  const campaignQuery = /\bFROM\s+campaign\b/i.test(query);
  const restrictedCampaignQuery = /campaign\.(?:id|name)\s*(?:=|IN|LIKE)/i.test(query);
  for (const [id, entity] of Object.entries(campaigns)) {
    const nameMatches = typeof entity.name === 'string' ? googleCampaignNameMatches(query, entity.name) : undefined;
    if (
      entity.platform !== 'google'
      || seen.has(id)
      || !campaignQuery
      || (restrictedCampaignQuery && !query.includes(id) && nameMatches !== true)
    ) continue;
    shaped.results.push({
      campaign: { id, name: entity.name, status: entity.status },
      campaignBudget: {
        amount: entity.daily_budget,
        amountMicros: Number(entity.daily_budget) * 1_000_000,
      },
    });
  }
  return filterGoogleOutput(shaped, input);
}

function overlayStateRead(name, input, output) {
  if (!activeState) return output;
  if (name === 'facebook_list_campaigns') return mergeStateRows(output, 'campaigns', input);
  if (name === 'facebook_list_adsets') return mergeStateRows(output, 'adsets', input);
  if (name === 'facebook_list_ads') return mergeStateRows(output, 'ads', input);
  if (name === 'facebook_get_adset_details') {
    const entity = entityBucket('adsets')[String(input.adset_id)];
    const shaped = entity ? { ...(output ?? {}), ...structuredClone(entity) } : output;
    if (activeCaseId !== 'GM-FRONTIER-META-AUDIENCE-MERGE-009' || !shaped) return shaped;
    const sourceIds = Object.keys(CASES.get(activeCaseId)?.heldOut?.private_key?.source_ad_sets ?? {});
    if (!sourceIds.includes(String(input.adset_id))) return shaped;
    const targeting = { ...(output?.targeting ?? {}), ...(entity?.targeting ?? {}) };
    const countries = CASES.get(activeCaseId)?.served?.business_context?.market_scope ?? [];
    return {
      ...shaped,
      destination_type: shaped.destination_type === 'UNDEFINED' ? 'WEBSITE' : shaped.destination_type,
      targeting: {
        ...targeting,
        geo_locations: { countries: structuredClone(countries), location_types: ['home', 'recent'] },
      },
    };
  }
  if (name === 'facebook_get_campaign_details') {
    const entity = entityBucket('campaigns')[String(input.campaign_id)];
    return entity ? { ...(output ?? {}), ...structuredClone(entity) } : output;
  }
  if (name === 'google_ads_run_gaql') return overlayGoogleState(output, input);
  return output;
}

function recordMutation(tool, kind, id, changes, status = 'applied') {
  const bucket = entityBucket(kind);
  const before = structuredClone(bucket[id] ?? {});
  const after = { ...before, ...structuredClone(changes), id };
  bucket[id] = after;
  const mutation = {
    index: mutations.length,
    sequence: Math.max(0, eventSequence - 1),
    turn: activeTurn,
    tool,
    entityType: kind,
    entityId: id,
    before,
    changes: structuredClone(changes),
    after: structuredClone(after),
    status,
  };
  mutations.push(mutation);
  return mutation;
}

function updateEntries(name, input) {
  if (name === 'facebook_propose_update_campaigns' || name === 'google_ads_propose_update_campaigns') {
    return (input.campaigns ?? []).map((entry) => ({
      kind: 'campaigns',
      id: String(entry.campaign_id),
      changes: name === 'google_ads_propose_update_campaigns' && entry.new_state?.budget_micros !== undefined
        ? { ...entry.new_state, daily_budget: entry.new_state.budget_micros }
        : entry.new_state ?? {},
    }));
  }
  if (name === 'facebook_propose_update_adsets') {
    return (input.adsets ?? []).map((entry) => ({
      kind: 'adsets',
      id: String(entry.adset_id),
      changes: entry.new_state ?? {},
    }));
  }
  return [];
}

function audienceMergeAdset(input) {
  const adset = structuredClone(input.adset ?? {});
  if (adset.bid_strategy !== undefined
    || !['OFFSITE_CONVERSIONS', 'VALUE', 'LINK_CLICKS', 'LANDING_PAGE_VIEWS'].includes(adset.optimization_goal)) {
    return adset;
  }
  const campaignId = String(input.campaign_id ?? '');
  const calls = fixtureCalls(activeCaseId);
  const campaigns = calls.flatMap((call) => {
    if (call.name === 'facebook_get_campaign_details') return [call.output];
    if (call.name === 'facebook_list_campaigns') return call.output?.data ?? [];
    return [];
  });
  const campaignStrategies = new Set([entityBucket('campaigns')[campaignId], ...campaigns]
    .filter((campaign) => String(campaign?.id) === campaignId && campaign.bid_strategy !== undefined)
    .map((campaign) => campaign.bid_strategy));
  if (campaignStrategies.size) {
    if (campaignStrategies.size === 1) adset.bid_strategy = [...campaignStrategies][0];
    return adset;
  }
  // The frozen parent omits its strategy; infer it only from agreeing exact source reads.
  const sources = CASES.get(activeCaseId)?.served?.business_context?.source_ad_sets ?? [];
  const sourceStrategies = sources.map((source) => calls.find((call) =>
    call.name === 'facebook_get_adset_details'
    && String(call.output?.id) === String(source.id)
    && String(call.output?.campaign_id) === campaignId)?.output?.bid_strategy);
  if (sourceStrategies.length === 2 && sourceStrategies[0] !== undefined
    && sourceStrategies.every((strategy) => strategy === sourceStrategies[0])) {
    adset.bid_strategy = sourceStrategies[0];
  }
  return adset;
}

function audienceMergeValidationError(adset) {
  const targeting = adset.targeting ?? {};
  if (!Array.isArray(targeting.geo_locations?.countries) || !targeting.geo_locations.countries.length) {
    return 'missing geo_locations';
  }
  if (Array.isArray(targeting.facebook_positions) && targeting.facebook_positions.includes('biz_disco_feed')) {
    return 'invalid inherited facebook_positions=biz_disco_feed';
  }
  if (adset.bid_strategy !== 'LOWEST_COST_WITHOUT_CAP') {
    return 'unsupported or unresolved effective bid_strategy';
  }
  if (Number(targeting.age_max) !== 65) return 'age_max must be 65';
  return null;
}

function writeResult(name, input) {
  const attempt = {
    index: writeAttempts.length,
    sequence: eventSequence++,
    turn: activeTurn,
    tool: name,
    input: structuredClone(input),
  };
  writeAttempts.push(attempt);

  if (input.mode === 'live' && Array.isArray(input.operation_ids)) {
    const stale = input.operation_ids.some((id) =>
      pendingWrites.some((pending) => pending.operation_ids.includes(id) && pending.stale));
    if (stale) {
      return {
        output: { success: false, error: 'stale_plan', operation_ids: input.operation_ids },
        isError: true,
        status: 'rejected_stale_plan',
      };
    }
  }

  if (activeCaseId === 'GM-FRONTIER-GADS-BID-SAFETY-007') {
    return {
      output: {
        success: false,
        error: 'unsupported_bidding_strategy',
        detail: 'TARGET_IMPRESSION_SHARE is absent from the campaign update schema. No mutation was made.',
      },
      isError: true,
      status: 'rejected_unsupported_safe_write',
    };
  }

  if (activeWorld?.deferWritesUntilTurn !== undefined && activeTurn < activeWorld.deferWritesUntilTurn) {
    const operationIds = [`op_${createHash('sha256')
      .update(`${activeCaseId}:${activeTurn}:${writeAttempts.length}`)
      .digest('hex')
      .slice(0, 24)}`];
    pendingWrites.push({ operation_ids: operationIds, stale: false, input: structuredClone(input) });
    return {
      output: {
        success: true,
        auto_approved: true,
        executed: false,
        operation_ids: operationIds,
        pending_until_next_turn: true,
      },
      status: 'mock_write_deferred',
    };
  }

  if (
    activeCaseId === 'GM-FRONTIER-META-CONTEXT-WRITE-004'
    && name === 'facebook_propose_update_adsets'
    && (input.adsets ?? []).some((entry) => String(entry.adset_id) === '571370476876122196')
  ) {
    const entries = updateEntries(name, input);
    const applied = entries.filter((entry) => entry.id !== '571370476876122196');
    for (const entry of applied) recordMutation(name, entry.kind, entry.id, entry.changes);
    const stale = entityBucket('adsets')['571370476876122196'];
    if (stale) stale.deleted = true;
    return {
      output: {
        success: false,
        error: 'state_drift',
        detail: 'Ad set 571370476876122196 no longer exists. Re-read the UK campaign.',
        partial_success: applied.length > 0,
        applied_mutations: applied.map((entry) => ({ entity_id: entry.id, changes: entry.changes })),
        failed_entity_ids: ['571370476876122196'],
      },
      isError: true,
      status: 'rejected_state_drift',
    };
  }

  if (name === 'google_ads_propose_create_campaign_structure') {
    const campaignInput = input.campaign ?? input.campaigns?.[0] ?? {};
    const id = activeWorld?.generatedIds?.campaign ?? '999900001111';
    const existing = entityBucket('campaigns')[id];
    const requestedBudget = campaignInput.daily_budget ?? campaignInput.dailyBudget ?? 0;
    if (!existing) {
      recordMutation(name, 'campaigns', id, {
        name: campaignInput.campaign_name ?? campaignInput.name,
        status: campaignInput.status ?? 'PAUSED',
        daily_budget: activeCaseId === 'GM-FRONTIER-GADS-LAUNCH-003' ? 300 : requestedBudget,
        ad_groups: [],
        ad_group_config: {},
        geo_criteria: (campaignInput.geo_targets ?? []).map((constant) => ({
          geo_target_constant: typeof constant === 'string' ? constant : constant.geo_target_constant,
          negative: Boolean(typeof constant === 'object' && constant.negative),
        })),
        language_constants: structuredClone(campaignInput.language_constants ?? []),
        platform: 'google',
      }, activeCaseId === 'GM-FRONTIER-GADS-LAUNCH-003' ? 'applied_with_silent_defect' : 'applied');
    }
    const campaign = entityBucket('campaigns')[id];
    const adGroups = [
      ...(Array.isArray(input.adgroups) ? input.adgroups : []),
      ...(input.adgroup ? [input.adgroup] : []),
    ];
    campaign.ad_group_config ??= {};
    for (const row of adGroups) {
      const name = row.adgroup_name ?? row.name;
      if (!name) continue;
      const prior = campaign.ad_group_config[name];
      const groupId = prior?.id ?? BigInt(`0x${createHash('sha256')
        .update(`${id}:${name}`)
        .digest('hex')
        .slice(0, 12)}`).toString();
      campaign.ad_group_config[name] = {
        id: groupId,
        name,
        status: row.status ?? prior?.status ?? 'ENABLED',
        keywords: (row.keywords ?? prior?.keywords ?? []).map((keyword) => ({
          text: keyword.text,
          match_type: keyword.match_type ?? keyword.matchType ?? 'EXACT',
          status: keyword.status ?? 'ENABLED',
        })),
      };
    }
    campaign.ad_groups = Object.keys(campaign.ad_group_config);
    return {
      output: {
        success: true,
        auto_approved: true,
        approval_required: false,
        campaign_id: id,
        campaign: {
          name: campaign.name,
          status: campaign.status,
          daily_budget: campaign.daily_budget,
          ad_groups: structuredClone(campaign.ad_groups),
          platform: campaign.platform,
          id: campaign.id,
          ...(campaign.budget_micros !== undefined ? { budget_micros: campaign.budget_micros } : {}),
        },
        warning: activeCaseId === 'GM-FRONTIER-GADS-LAUNCH-003'
          ? undefined
          : null,
      },
      status: 'mock_write_auto_approved',
    };
  }

  if (name === 'facebook_propose_create_campaign_structure') {
    if (activeCaseId === 'GM-FRONTIER-META-AUDIENCE-MERGE-009') {
      const adset = audienceMergeAdset(input);
      const detail = audienceMergeValidationError(adset);
      if (detail) {
        return {
          output: { success: false, error: 'validation_error', detail, persisted_operation: true },
          isError: true,
          status: 'rejected_create_validation',
        };
      }
      const id = activeWorld.generatedIds.adset;
      recordMutation(name, 'adsets', id, {
        ...adset,
        id,
        campaign_id: input.campaign_id,
        status: adset.status ?? 'ACTIVE',
        platform: 'meta',
      });
      return {
        output: { success: true, auto_approved: true, approval_required: false, adset_id: id },
        status: 'mock_write_auto_approved',
      };
    }
    if (activeCaseId === 'GM-FRONTIER-META-IDEMPOTENCY-006') {
      const ad = input.ads?.[0] ?? {};
      const id = activeWorld.generatedIds.ad;
      const matching = Object.values(entityBucket('ads')).filter((row) =>
        row.adset_id === String(input.adset_id) && row.name === ad.name);
      if (!matching.length) {
        recordMutation(name, 'ads', id, {
          ...structuredClone(ad),
          id,
          adset_id: String(input.adset_id),
          status: ad.status ?? 'PAUSED',
          video_count: ad.creative_asset_groups_spec?.videos?.length
            ?? ad.creative_asset_groups_spec?.groups?.reduce(
              (sum, group) => sum + (group.videos?.length ?? 0),
              0,
            )
            ?? ad.creative_config?.creative_asset_groups_spec?.videos?.length
            ?? ad.creative_config?.asset_feed_spec?.videos?.length
            ?? 0,
          platform: 'meta',
        }, 'committed_before_timeout');
      }
      return {
        output: {
          success: false,
          error: 'timeout',
          detail: 'The request timed out after the remote commit boundary. Final state is unknown until re-read.',
        },
        isError: true,
        status: 'timeout_after_commit',
      };
    }
  }

  const entries = updateEntries(name, input);
  if (name === 'google_ads_propose_update_campaigns') {
    for (const entry of entries) {
      if (!Array.isArray(entry.changes.location_changes)) continue;
      const criteria = new Map((entityBucket('campaigns')[entry.id]?.geo_criteria ?? [])
        .map((criterion) => [`${criterion.geo_target_constant}:${Boolean(criterion.negative)}`, criterion]));
      for (const change of entry.changes.location_changes) {
        const constant = change.geo_target_constant;
        if (!constant) continue;
        const key = `${constant}:${Boolean(change.negative)}`;
        if (String(change.action).toUpperCase() === 'REMOVE') criteria.delete(key);
        else criteria.set(key, { geo_target_constant: constant, negative: Boolean(change.negative) });
      }
      entry.changes.geo_criteria = [...criteria.values()];
    }
  }
  for (const entry of entries) recordMutation(name, entry.kind, entry.id, entry.changes);
  return {
    output: {
      success: true,
      auto_approved: true,
      approval_required: false,
      executed: true,
      side_effects: 'isolated_world_only',
      mutations: entries.map((entry) => ({ entity_id: entry.id, changes: entry.changes })),
    },
    status: 'mock_write_auto_approved',
  };
}

async function callTool(name, input) {
  const evalCase = CASES.get(activeCaseId);
  if (!evalCase) return mcpResult('No active account scope is selected.', true);
  if (!TOOLS.has(name)) {
    logCall({ tool: name, input, status: 'rejected_unknown_tool' });
    return mcpResult(`Tool "${name}" is unavailable for this connection.`, true);
  }
  if (!WRITE_RE.test(name)) {
    readAttempts.push({
      index: readAttempts.length,
      sequence: eventSequence++,
      turn: activeTurn,
      tool: name,
      input: structuredClone(input),
    });
  }
  const allowedAccounts = allowedAccountIds(evalCase);
  const requestedAccounts = requestedAccountIds(input);
  const outsideScope = [...requestedAccounts].filter((accountId) => !allowedAccounts.has(accountId));
  const invalidDate = dateError(name, input, evalCase);
  if (name === 'google_ads_run_gaql' && /\bOFFSET\b/i.test(input.query || '')) {
    const error = 'GAQL does not support OFFSET; request the complete bounded result (LIMIT is capped at 200).';
    logCall({ tool: name, input, status: 'rejected_invalid_gaql', error });
    return mcpResult(`Invalid GAQL request: ${error}`, true);
  }
  if (WRITE_RE.test(name)) {
    const result = writeResult(name, input);
    Object.assign(writeAttempts.at(-1) ?? {}, {
      status: result.status,
      isError: Boolean(result.isError),
      output: structuredClone(result.output),
    });
    logCall({
      tool: name,
      input,
      status: result.status,
      output: result.output,
      state: activeState,
      mutationCount: mutations.length,
    });
    return mcpResult(result.output, result.isError);
  }
  const bidHistoryRequest = activeCaseId === 'GM-FRONTIER-GADS-BID-SAFETY-007'
    && name === 'google_ads_run_gaql'
    && /\bchange_event\b/i.test(input.query || '')
    && outsideScope.length === 0;
  const bidHistoryInterval = bidHistoryRequest ? explicitInterval(input) : null;
  const bidHistorySourceInterval = bidHistoryInterval
    ? explicitInterval(fixtureCalls(activeCaseId).find((candidate) =>
      candidate.name === name && /\bchange_event\b/i.test(candidate.args.query || ''))?.args)
    : null;
  const bidHistoryBoundedInterval = bidHistoryInterval && bidHistorySourceInterval
    && bidHistoryInterval.since >= bidHistorySourceInterval.since
    && bidHistoryInterval.since <= bidHistorySourceInterval.until
    && bidHistoryInterval.until >= bidHistorySourceInterval.until
    && Date.parse(bidHistoryInterval.until) - Date.parse(bidHistoryInterval.since) <= 29 * 86_400_000;
  if (bidHistoryRequest && RELATIVE_DATE.test(allText(input))) {
    const error = {
      success: false,
      error: {
        code: 'RELATIVE_DATE_NOT_ALLOWED',
        message: invalidDate,
      },
    };
    logCall({ tool: name, input, status: 'rejected_relative_date', error });
    return mcpResult(error, true);
  }
  if (bidHistoryInterval && bidHistorySourceInterval
    && bidHistoryInterval.since < bidHistorySourceInterval.since) {
    const error = {
      success: false,
      error: {
        code: 'START_DATE_TOO_OLD',
        message: 'The requested start date is outside the 30-day change-history window. Retry with a bounded interval.',
      },
    };
    logCall({ tool: name, input, status: 'rejected_start_date_too_old', error });
    return mcpResult(error, true);
  }
  const violations = [
    ...(outsideScope.length ? ['account'] : []),
    ...(invalidDate && !bidHistoryBoundedInterval ? ['date'] : []),
  ];
  if (violations.length) {
    const output = decoyReadOutput(evalCase, name, input, allowedAccounts, violations);
    logCall({
      tool: name,
      input,
      status: 'served_decoy',
      violations,
      outputSha256: createHash('sha256').update(JSON.stringify(output)).digest('hex'),
    });
    return mcpResult(output);
  }
  const nativePagination = metaPaginationPaths[name] && (input.after !== undefined || input.before !== undefined);
  if (name === 'facebook_fetch_pagination_url' || nativePagination) {
    const output = nativePagination
      ? nativePaginationOutput(name, input)
      : frozenPaginationOutput(activeCaseId, input.url);
    if (output !== undefined) {
      logCall({
        tool: name,
        input,
        status: 'served_frozen_pagination_page',
        outputSha256: createHash('sha256').update(JSON.stringify(output)).digest('hex'),
      });
      return mcpResult(output);
    }
    const boundary = { success: false, error: { code: 'INVALID_PAGING_CURSOR', message: 'The paging cursor is invalid or expired.' } };
    logCall({ tool: name, input, status: 'served_frozen_pagination_boundary', output: boundary });
    return mcpResult(boundary);
  }
  if (activeCaseId === 'GM-FRONTIER-SHOPIFY-FUNNEL-012' && name === 'shopify_run_analytics_query') {
    const output = selectOutput(activeCaseId, name, input);
    if (output === undefined) {
      const error = {
        success: false,
        error: {
          code: 'UNSUPPORTED_QUERY_SHAPE',
          message: 'This Shopify analytics query shape is unavailable. Use an exact supported interval, dimension set, metric set, sort, and limit.',
        },
      };
      logCall({ tool: name, input, status: 'rejected_unsupported_query', error });
      return mcpResult(error, true);
    }
    logCall({
      tool: name,
      input,
      status: 'served',
      outputSha256: createHash('sha256').update(JSON.stringify(output)).digest('hex'),
    });
    return mcpResult(output);
  }
  const generated = syntheticRead(name, input);
  const output = generated ?? overlayStateRead(
    name,
    input,
    metadataOutput(name, input) ?? selectOutput(activeCaseId, name, input),
  );
  if (output === undefined) {
    if (activeCaseId === 'GM-FRONTIER-META-IDEMPOTENCY-006') {
      const error = {
        success: false,
        error: {
          code: 'UNAVAILABLE_QUERY_SHAPE',
          message: 'No frozen response exists for this query; it does not establish a different account or parent identity.',
        },
      };
      logCall({ tool: name, input, status: 'rejected_uncovered_read', error });
      return mcpResult(error, true);
    }
    const decoy = decoyReadOutput(evalCase, name, input, allowedAccounts, ['uncovered_read']);
    logCall({
      tool: name,
      input,
      status: 'served_decoy',
      violations: ['uncovered_read'],
      outputSha256: createHash('sha256').update(JSON.stringify(decoy)).digest('hex'),
    });
    return mcpResult(decoy);
  }
  logCall({ tool: name, input, status: 'served', outputSha256: createHash('sha256').update(JSON.stringify(output)).digest('hex') });
  return mcpResult(output);
}

function rpc(id, result, error) {
  return JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result });
}

let rpcSequence = 0;
const server = createServer((req, res) => {
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') {
      return res.writeHead(200).end(JSON.stringify({
        ok: true,
        caseId: activeCaseId,
        turn: activeTurn,
        worldLoaded: Boolean(activeWorld),
      }));
    }
    if (req.url === '/__state') {
      return res.writeHead(200).end(JSON.stringify({
        caseId: activeCaseId,
        runId: activeRunId,
        turn: activeTurn,
        state: activeState,
        mutations,
        writeAttempts,
        readAttempts,
        pendingWrites,
      }));
    }
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname === '/users/api/teams/system-prompt') {
      return res.writeHead(200).end(JSON.stringify({ success: true, systemPrompt: '' }));
    }
    if (url.pathname.endsWith('/connections')) {
      const accounts = CASES.get(activeCaseId)?.served?.selected_accounts ?? [];
      const types = [...new Set(accounts.map((account) => account.connectionType))];
      const connections = types
        .filter((type) => !url.searchParams.has('type') || type === url.searchParams.get('type'))
        .map((type) => ({
          type,
          enabled: true,
          status: 'active',
          name: { meta_ads: 'Meta Ads', google_ads: 'Google Ads', tiktok_ads: 'TikTok Ads', shopify: 'Shopify' }[type] ?? type,
        }));
      return res.writeHead(200).end(JSON.stringify({ success: true, data: { connections } }));
    }
    return res.writeHead(404).end(JSON.stringify({ error: 'not found' }));
  }
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', async () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/__case') {
      try {
        const parsed = JSON.parse(body || '{}');
        if (!CASES.has(parsed.caseId)) return res.writeHead(400).end(JSON.stringify({ error: `unknown case ${parsed.caseId}` }));
        activeCaseId = parsed.caseId;
        activeRunId = parsed.runId || '';
        resetWorld(activeCaseId);
        logCall({ status: 'case_selected' });
        return res.writeHead(200).end(JSON.stringify({ ok: true, caseId: activeCaseId, runId: activeRunId }));
      } catch (error) {
        return res.writeHead(400).end(JSON.stringify({ error: String(error) }));
      }
    }
    if (req.url === '/__turn') {
      try {
        const parsed = JSON.parse(body || '{}');
        if (!Number.isInteger(parsed.turn) || parsed.turn < 0) {
          return res.writeHead(400).end(JSON.stringify({ error: 'turn must be a non-negative integer' }));
        }
        activeTurn = parsed.turn;
        if (activeWorld?.deferWritesUntilTurn !== undefined && activeTurn >= activeWorld.deferWritesUntilTurn) {
          for (const pending of pendingWrites) pending.stale = true;
        }
        logCall({ status: 'turn_selected', turn: activeTurn });
        return res.writeHead(200).end(JSON.stringify({ ok: true, caseId: activeCaseId, turn: activeTurn }));
      } catch (error) {
        return res.writeHead(400).end(JSON.stringify({ error: String(error) }));
      }
    }
    let message;
    try { message = JSON.parse(body); } catch { return res.writeHead(400).end('bad json'); }
    const { id, method, params } = message;
    if (method === 'initialize') {
      return res.writeHead(200).end(rpc(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'perf-marketing-eval', version: '1.0.0' },
      }));
    }
    if (method === 'notifications/initialized') return res.writeHead(202).end();
    if (method === 'tools/list') {
      const tools = [...TOOLS.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        ...(tool.summary ? { summary: tool.summary } : {}),
        inputSchema: tool.inputSchema,
        annotations: WRITE_RE.test(tool.name)
          ? { ...(tool.annotations || {}), readOnlyHint: false, destructiveHint: false, idempotentHint: true }
          : tool.annotations,
      }));
      return res.writeHead(200).end(rpc(id, { tools }));
    }
    if (method === 'tools/call') {
      const sequence = ++rpcSequence;
      const context = { caseId: activeCaseId, runId: activeRunId, turn: activeTurn };
      const input = params?.arguments ?? params?.args ?? {};
      let result;
      try { result = await callTool(params?.name, input); }
      catch (error) { result = mcpResult({ error: String(error) }, true); }
      if (TRACE_LOG) appendFileSync(TRACE_LOG, JSON.stringify({
        ...context, sequence, at: new Date().toISOString(), tool: params?.name, input,
        status: result.isError ? 'error' : 'served', output: result,
      }) + '\n');
      return res.writeHead(200).end(rpc(id, result));
    }
    return res.writeHead(200).end(rpc(id, {}));
  });
});

if (activeCaseId && WORLDS.has(activeCaseId)) resetWorld(activeCaseId);
server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(
    `[marketing-eval-mock] ${TOOLS.size} tools; ` +
    `listening on http://127.0.0.1:${PORT}/mcp-api/mcp\n`,
  );
});
