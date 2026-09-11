import type { EvalCase } from './dataset.js';

export type ReportField = { key: string; description: string; type: 'number' | 'entity' | 'strategy'; unit?: string };
type Condition = {
  field: string;
  expectedPath: string[];
  comparison: 'number' | 'exact' | 'alias' | 'magnitude';
  expectedScale?: number;
  absoluteTolerance?: number;
  approximateTolerance?: number;
  maxRoundingUnit?: number;
  aliases?: string[];
};
export type ReportingContract = {
  caseId: string;
  fields: ReportField[];
  rules: Array<{ criterionId: string; anyOf: Condition[][] }>;
};
export type ReportMessage = { eventIndex: number; turn: number; text: string };
export type ReportFact = { field: string; eventIndex: number; quote: string; literal: string; unit: 'native' | 'percent' | 'ratio';
  currency?: { eventIndex: number; quote: string; literal: string } };

const normalize = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]+/gu, '');
const currencyPattern = '(?:USD|AUD|CAD|COP|ZAR|INR|EUR|GBP|JPY|CNY|CHF|NZD|SGD|HKD|MXN|BRL)';
const moneyPattern = `${currencyPattern}|(?:US|AU|CA|NZ|HK|SG|A|C|R)?[$]|[€£₹¥]|R(?=\\s*[+\\-(\\d])`;

const currencyAliases: Record<string, string[]> = {
  '$': ['USD', 'AUD', 'CAD', 'COP', 'NZD', 'SGD', 'HKD', 'MXN'],
  'US$': ['USD'], 'AU$': ['AUD'], 'A$': ['AUD'], 'CA$': ['CAD'], 'C$': ['CAD'],
  'NZ$': ['NZD'], 'HK$': ['HKD'], 'SG$': ['SGD'], 'R$': ['BRL'], R: ['ZAR'],
  '€': ['EUR'], '£': ['GBP'], '₹': ['INR'], '¥': ['JPY', 'CNY'],
};

function currencyTokens(text: string): Array<{ literal: string; at: number; currencies: string[] }> {
  const pattern = new RegExp(`(?<![\\p{L}])(?:${currencyPattern})(?![\\p{L}])|(?:US|AU|CA|NZ|HK|SG|A|C|R)?[$]|[€£₹¥]|(?<![\\p{L}])R(?=\\s*[+\\-(\\d]|$)`, 'giu');
  return [...text.matchAll(pattern)].map((match) => ({ literal: match[0], at: match.index!,
    currencies: currencyAliases[match[0].toUpperCase()] ?? [match[0].toUpperCase()] }));
}

/** Preserve the stated currency independently of the currency expected by the field. */
function currencyFact(fact: ReportFact, source: ReportMessage, messages: ReportMessage[]): ReportFact {
  if (fact.currency) {
    const annotation = fact.currency;
    const message = messages.find((candidate) => candidate.eventIndex === annotation.eventIndex
      && typeof annotation.quote === 'string' && sourceText(candidate.text, annotation.quote) !== undefined);
    const quote = message && sourceText(message.text, annotation.quote);
    const literal = quote && typeof annotation.literal === 'string' ? sourceText(quote, annotation.literal) : undefined;
    const clean = literal?.replace(/[*_`]/g, '').trim();
    if (!message || !quote || !literal || !clean || !currencyTokens(quote).some((token) => token.literal === clean)
      || currencyTokens(clean).length !== 1 || currencyTokens(clean)[0]!.literal !== clean) {
      throw new Error(`${fact.field}: currency must cite a complete currency symbol or code from an actual source line.`);
    }
    return { ...fact, currency: { eventIndex: message.eventIndex, quote, literal } };
  }
  // A complete adjacent currency code or unambiguous symbol already identifies this amount.
  if (currencyTokens(fact.literal).some((token) => token.currencies.length === 1)) return fact;
  let quote = fact.quote, tokens = currencyTokens(quote);
  if (!tokens.some((token) => token.currencies.length === 1)) {
    quote = source.text; tokens = currencyTokens(quote);
  }
  if (!tokens.length) return fact;
  const possible = tokens.reduce((values, token) => values.filter((value) => token.currencies.includes(value)), tokens[0]!.currencies);
  if (!possible.length) throw new Error(`${fact.field}: multiple currencies occur in the source; cite the currency line for this amount.`);
  const token = [...tokens].sort((a, b) => a.currencies.length - b.currencies.length)[0]!;
  const lineStart = quote.lastIndexOf('\n', token.at) + 1;
  const nextLine = quote.indexOf('\n', token.at);
  return { ...fact, currency: { eventIndex: source.eventIndex,
    quote: quote.slice(lineStart, nextLine < 0 ? undefined : nextLine), literal: token.literal } };
}

function sourceOffset(fact: ReportFact, message: ReportMessage, numeric: boolean): number {
  let found = -1;
  for (let quoteAt = message.text.indexOf(fact.quote); quoteAt >= 0; quoteAt = message.text.indexOf(fact.quote, quoteAt + 1)) {
    for (let at = fact.quote.indexOf(fact.literal); at >= 0; at = fact.quote.indexOf(fact.literal, at + 1)) {
      const start = quoteAt + at, end = start + fact.literal.length;
      const before = numeric ? message.text.slice(0, start).replace(/[*_`]/g, '') : message.text.slice(0, start);
      const after = numeric ? message.text.slice(end).replace(/[*_`]/g, '') : message.text.slice(end);
      // A grounded substring must not crop a sign, digit, scale, or explicit unit from the stated value.
      if ((/[\p{L}\p{N}_]$/u.test(before) && /^[\p{L}\p{N}_]/u.test(fact.literal))
        || (/[\p{L}\p{N}_]$/u.test(fact.literal) && /^[\p{L}\p{N}_]/u.test(after))) continue;
      if (numeric && ((/^[+\-−–—]/.test(fact.literal) && (/[\p{L}\p{N}_]$/u.test(before) || /\d\s+$/.test(before)))
        || new RegExp(`\\d(?:[.,'’]\\d+)*\\s*(?:%|pp|percent|[kmb]|thousand|million|billion|${currencyPattern})?\\s*[–—-]\\s*$`, 'i').test(before)
        || new RegExp(`^\\s*[–—-]\\s*(?:(?:${moneyPattern})\\s*)?[+\\-−–]?\\s*(?:\\d|[.]\\d)`, 'i').test(after)
        || /\d[.,'’]?$/.test(before)
        || (/\d[ '’]+$/.test(before) && /^\d{3}(?!\d)/.test(fact.literal)) || /[+\-−–]$/.test(before)
        || /\b(?:minus|negative|plus)\s*$/i.test(before) || /^(?:[.,]\d|\d)/.test(after)
        || /\bR\s*$/.test(before) || new RegExp(`(?:${moneyPattern})\\s*$`, 'i').test(before)
        || new RegExp(`^\\s*(?:%|percent\\b|percentage\\b|per\\s+cent\\b|[kmb]\\b|thousand\\b|million\\b|billion\\b|${currencyPattern}\\b)`, 'i').test(after)
        || (before.endsWith('(') && after.startsWith(')')))) continue;
      found = start;
    }
  }
  return found;
}

/** Recover adjacent signs and units only from the exact cited quote, never an expected answer. */
function normalizeFact(fact: ReportFact, source: ReportMessage, numeric: boolean): ReportFact {
  if (!numeric) return fact;
  const money = `${currencyPattern}|(?:US|AU|CA|NZ|HK|SG|A|C|R)?[$]|[€£₹¥]|\\bR`;
  const formatting = '[\\s*_`]*';
  const prefix = new RegExp(`(?:(?:${money}|[+\\-−–])${formatting})+$`, 'i');
  const suffix = new RegExp(`^(?:${formatting}(?:[kmb]\\b|thousand\\b|million\\b|billion\\b|%|percent(?:age)?(?:\\s+points?)?\\b|per\\s+cent\\b|${currencyPattern}\\b))+`, 'i');
  let literal = fact.literal;
  if (literal.startsWith('(') && !literal.endsWith(')')) literal = literal.slice(1);
  if (literal.endsWith(')') && !literal.startsWith('(')) literal = literal.slice(0, -1);
  let normalized = { ...fact, literal };
  for (let at = fact.quote.indexOf(literal); at >= 0; at = fact.quote.indexOf(literal, at + 1)) {
    const end = at + literal.length;
    const before = fact.quote.slice(0, at).match(prefix)?.[0] ?? '';
    const after = fact.quote.slice(end).match(suffix)?.[0] ?? '';
    const opening = fact.quote.slice(0, at - before.length).match(/\(\s*$/)?.[0];
    const closing = fact.quote.slice(end + after.length).match(/^\s*\)/)?.[0];
    const candidate = { ...fact, literal: (opening && closing ? opening : '') + before + literal + after
      + (opening && closing ? closing : '') };
    if (sourceOffset(candidate, source, true) >= 0) normalized = candidate;
  }
  return normalized;
}

/** Recover exact source text when transcription only removes Markdown or swaps approximation glyphs. */
function sourceText(text: string, quote: string): string | undefined {
  if (text.includes(quote)) return quote;
  const plain = (value: string): { text: string; positions: number[] } => {
    let text = '';
    const positions: number[] = [];
    for (let index = 0; index < value.length; index++) {
      const char = value[index]!;
      if ('*_`'.includes(char)) continue;
      text += '≈≃≅'.includes(char) ? '~' : char;
      positions.push(index);
    }
    return { text, positions };
  };
  const source = plain(text), needle = plain(quote).text;
  const at = needle ? source.text.indexOf(needle) : -1;
  return at < 0 ? undefined : text.slice(source.positions[at], source.positions[at + needle.length - 1]! + 1);
}

/** Every extracted value must be visible in the cited assistant message. */
export function validateFacts(raw: unknown, contract: ReportingContract, messages: ReportMessage[]): ReportFact[] {
  const facts = (raw as { facts?: unknown })?.facts;
  if (!Array.isArray(facts)) throw new Error('Fact extraction lacks a facts array.');
  const fields = new Map(contract.fields.map((field) => [field.key, field]));
  return facts.filter((fact) => !(fields.has(fact?.field) && fact?.literal === '')).map((rawFact) => {
    const field = fields.get(rawFact?.field);
    const nativeUnit = (field && field.type !== 'number' && rawFact.unit === undefined)
      || (field?.unit !== undefined && rawFact?.unit === field.unit && !['percent', 'ratio'].includes(rawFact.unit));
    let fact = nativeUnit ? { ...rawFact, unit: 'native' } : rawFact;
    const source = messages.find((message) => message.eventIndex === fact?.eventIndex
      && typeof fact?.quote === 'string' && sourceText(message.text, fact.quote) !== undefined);
    if (source && typeof fact?.literal === 'string') {
      const quote = sourceText(source.text, fact.quote)!;
      fact = { ...fact, quote, literal: sourceText(quote, fact.literal) ?? fact.literal };
    }
    if (!fields.has(fact?.field) || typeof fact.quote !== 'string' || !fact.quote.trim()
      || typeof fact.literal !== 'string' || !fact.literal.trim() || !fact.quote.includes(fact.literal)
      || !['native', 'percent', 'ratio'].includes(fact.unit) || !source) {
      throw new Error(`${String(fact?.field ?? '(unknown field)')}: extracted fact has an unknown field, unit, or ungrounded source quote.`);
    }
    const numeric = fields.get(fact.field)?.type === 'number';
    let normalized = normalizeFact(fact, source, numeric);
    if (sourceOffset(normalized, source, numeric) < 0) {
      throw new Error(`${fact.field}: extracted literal crops a numeric token or explicit unit from its source.`);
    }
    if (numeric && (/^[A-Z]{3}$/.test(field!.unit ?? '') || field!.unit === 'account_currency')) {
      normalized = currencyFact(normalized, source, messages);
    } else if (normalized.currency) {
      throw new Error(`${fact.field}: a currency annotation requires a monetary field.`);
    }
    if (numeric && !reportedNumber(normalized, field!, false)) {
      throw new Error(`${fact.field}: numeric literal is not parseable; copy only the stated number with its sign, currency, percent, and scale, leaving labels and rate suffixes in the source line.`);
    }
    return normalized;
  });
}

function wordNumber(text: string): number | undefined {
  const ones = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const tens = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  let total = 0, group = 0, sign = 1, seen = false, groupSeen = false;
  const signed = text.trim();
  if (signed.startsWith('-')) sign = -1;
  const words = signed.replace(/^[+-]\s*/, '').toLowerCase().split(/[\s-]+/).filter(Boolean);
  if (!words.length) return undefined;
  for (const [index, word] of words.entries()) {
    if (word === 'and') continue;
    if (index === 0 && ['minus', 'negative', 'plus'].includes(word)) { sign = word === 'plus' ? 1 : -1; continue; }
    if (ones.includes(word)) { group += ones.indexOf(word); seen = groupSeen = true; }
    else if (tens.includes(word)) { group += (tens.indexOf(word) + 2) * 10; seen = groupSeen = true; }
    else if (word === 'hundred') { if (!groupSeen) return undefined; group *= 100; }
    else if (['thousand', 'million', 'billion'].includes(word)) {
      if (!groupSeen) return undefined;
      total += group * 1000 ** (['thousand', 'million', 'billion'].indexOf(word) + 1); group = 0; groupSeen = false;
    } else return undefined;
  }
  return seen ? sign * (total + group) : undefined;
}

function scalarNumber(fact: ReportFact, field: ReportField, checkUnits = true): { value: number; roundingUnit: number } | undefined {
  let literal = fact.literal.normalize('NFKC').replace(/[*_`]/g, '').trim().replace(/[−–]/g, '-');
  const percentPattern = /%|\b(?:pp|percent(?:age)?(?:\s+points?)?|per\s+cent)\b/gi;
  const percentagePoints = /\b(?:pp|percent(?:age)?\s+points?)\b/i.test(literal);
  const percent = new RegExp(percentPattern.source, 'i').test(literal);
  const targetPercent = /^(?:percent|percentage|%)$/.test(field.unit ?? '');
  const targetRatio = field.unit === 'ratio';
  const targetCurrency = /^[A-Z]{3}$/.test(field.unit ?? '') ? field.unit : undefined;
  const money = [...currencyTokens(literal), ...currencyTokens(fact.currency?.literal ?? '')];

  if (checkUnits && ((percentagePoints && field.unit !== 'percentage_points')
    || (!targetPercent && !targetRatio && (percent || fact.unit !== 'native'))
    || (money.length && !targetCurrency && field.unit !== 'account_currency')
    || (targetCurrency && money.some((token) => !token.currencies.includes(targetCurrency))))) return undefined;
  literal = literal.replace(new RegExp(moneyPattern, 'gi'), '').replace(percentPattern, '')
    .replace(/^[~≈≃]\s*|^(?:about|around|approximately|approx\.?|roughly)\s*/i, '').trim();
  let scale = 1;
  const compact = literal.match(/\s*(k|m|b|thousand|million|billion)$/i);
  if (compact && /\d/.test(literal)) {
    scale = /^(k|thousand)$/i.test(compact[1]!) ? 1e3 : /^(m|million)$/i.test(compact[1]!) ? 1e6 : 1e9;
    literal = literal.slice(0, compact.index).trim();
  }
  if (/^\(.*\)$/.test(literal)) {
    literal = literal.slice(1, -1).trim();
    if (!/^[+-]/.test(literal)) literal = '-' + literal;
  }
  const words = literal;
  literal = literal.replace(/[\s'’]/g, '');
  // A comma can group thousands or mark decimals; repeated dots unambiguously group thousands.
  if (literal.includes(',') && literal.includes('.')) {
    literal = literal.lastIndexOf(',') > literal.lastIndexOf('.')
      ? literal.replace(/\./g, '').replace(',', '.') : literal.replace(/,/g, '');
  } else if (literal.includes(',')) {
    literal = /^[+-]?\d{1,3}(?:,\d{3})+$/.test(literal) || /^[+-]?\d{1,3}(?:,\d{2})*,\d{3}$/.test(literal)
      ? literal.replace(/,/g, '') : literal.replace(',', '.');
  } else if (/^[+-]?\d{1,3}(?:\.\d{3}){2,}$/.test(literal)) {
    literal = literal.replace(/\./g, '');
  }
  const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(literal);
  const value = numeric ? Number(literal) : wordNumber(words);
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const decimals = numeric ? (literal.split('.')[1]?.length ?? 0) : 0;
  if (targetPercent && !percent && fact.unit === 'ratio') scale *= 100;
  if (targetRatio && (percent || fact.unit === 'percent')) scale /= 100;
  return { value: value * scale, roundingUnit: 10 ** -decimals * scale };
}

/** Preserve a scalar or both stated interval endpoints; never replace a range with a midpoint. */
export function reportedNumber(fact: ReportFact, field: ReportField, checkUnits = true): {
  value?: number; roundingUnit: number; bounds?: [number, number]; boundRoundingUnits?: [number, number];
} | undefined {
  const scalar = scalarNumber(fact, field, checkUnits);
  if (scalar) return scalar;
  const literal = fact.literal.normalize('NFKC').replace(/[*_`]/g, '').trim();
  const percent = /%|\b(?:pp|percent(?:age)?(?:\s+points?)?|per\s+cent)\b/i;
  const scale = /\b(?:thousand|million|billion)\b|(?<=\d)\s*[kmb]\b/i;
  for (const separator of literal.matchAll(/[–—-]|\bto\b/gi)) {
    let left = literal.slice(0, separator.index).trim();
    let right = literal.slice(separator.index! + separator[0].length).trim();
    if (!/\d/.test(left) || !/\d/.test(right)) continue;
    // A shared trailing field label belongs to the interval, not to its numeric tokens.
    if (field.unit && !/^(?:percent|percentage|percentage_points|ratio|account_currency|[A-Z]{3})$/.test(field.unit)) {
      const label = field.unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      left = left.replace(new RegExp(`\\s+${label}$`, 'i'), '');
      right = right.replace(new RegExp(`\\s+${label}$`, 'i'), '');
    }
    const leftMoney = currencyTokens(left), rightMoney = currencyTokens(right);
    if (!leftMoney.length && rightMoney.length) left = rightMoney[0]!.literal + ' ' + left;
    if (!rightMoney.length && leftMoney.length) right = leftMoney[0]!.literal + ' ' + right;
    const leftPercent = left.match(percent)?.[0], rightPercent = right.match(percent)?.[0];
    if (!leftPercent && rightPercent) left += ' ' + rightPercent;
    if (!rightPercent && leftPercent) right += ' ' + leftPercent;
    const rightScale = right.match(scale)?.[0];
    if (!scale.test(left) && rightScale) left += ' ' + rightScale;
    const start = scalarNumber({ ...fact, literal: left }, field, checkUnits);
    const end = scalarNumber({ ...fact, literal: right }, field, checkUnits);
    if (start && end) return { bounds: [start.value, end.value],
      boundRoundingUnits: [start.roundingUnit, end.roundingUnit],
      roundingUnit: Math.max(start.roundingUnit, end.roundingUnit) };
  }
  return undefined;
}

function clockMatches(literal: string, expected: string): boolean {
  const reference = expected.match(/T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/);
  if (!reference || !Number.isFinite(Date.parse(expected))) return false;
  const offset = (value: string): number | undefined => {
    const match = value.match(/^(?:UTC|GMT|Z)?(?:\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?)?$/i);
    if (!match || Number(match[2] ?? 0) > 23 || Number(match[3] ?? 0) > 59) return undefined;
    return (match[1] === '-' ? -1 : 1) * (Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0));
  };
  const expectedOffset = offset(reference[4]!)!;
  const annotated = literal.normalize('NFKC').trim();
  const dateAnnotation = annotated.match(/^(\d{4}-\d{2}-\d{2})(?:T|\s+)|\((\d{4}-\d{2}-\d{2})\)/i);
  const statedDate = dateAnnotation?.[1] ?? dateAnnotation?.[2];
  const clock = (dateAnnotation ? annotated.replace(dateAnnotation[0], '') : annotated).trim().match(/^(\d{1,2})(?::([0-5]\d)(?::([0-5]\d))?)?\s*(a\.?m\.?|p\.?m\.?)?(?:\s*(.+))?$/i);
  if (!clock || (!clock[2] && !clock[4])) return false;
  let hours = Number(clock[1]);
  if (clock[4]) {
    if (hours < 1 || hours > 12) return false;
    hours = hours % 12 + (/^p/i.test(clock[4]) ? 12 : 0);
  } else if (hours > 23) return false;
  const zone = (clock[5] ?? '').trim().replace(/^\((.*)\)$/, '$1').replace(/\s+time$/i, '').trim();
  let sourceOffset = !zone || /^local$/i.test(zone) ? expectedOffset : offset(zone);
  if (sourceOffset === undefined) {
    const names = Intl.supportedValuesOf('timeZone').filter((name) =>
      normalize(name) === normalize(zone) || normalize(name.split('/').at(-1)!) === normalize(zone));
    const offsets = new Set(names.map((timeZone) => offset(new Intl.DateTimeFormat('en', {
      timeZone, timeZoneName: 'longOffset',
    }).formatToParts(new Date(expected)).find((part) => part.type === 'timeZoneName')!.value)));
    if (offsets.size === 1) sourceOffset = [...offsets][0];
  }
  if (sourceOffset === undefined && /^[a-z]{2,6}$/i.test(zone)) {
    const abbreviation = zone.toUpperCase();
    const date = new Date(expected);
    const offsets = new Set<number>();
    let recognized = false;
    for (const timeZone of Intl.supportedValuesOf('timeZone')) {
      const name = (locale: string, style: 'short' | 'long' | 'longOffset'): string =>
        new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: style }).formatToParts(date)
          .find((part) => part.type === 'timeZoneName')!.value;
      const shortNames = ['en', 'en-AU', 'en-GB'].map((locale) => name(locale, 'short'));
      const shortMatch = shortNames.some((value) => value.toUpperCase() === abbreviation);
      // Long-name initials only veto ambiguity; they never invent an accepted abbreviation.
      const initials = name('en', 'long').split(/[^a-z]+/i).map((word) => word[0] ?? '').join('').toUpperCase();
      if (shortMatch || (shortNames.every((value) => offset(value) !== undefined) && initials === abbreviation)) {
        recognized ||= shortMatch;
        const minutes = offset(name('en', 'longOffset'));
        if (minutes !== undefined) offsets.add(minutes);
      }
    }
    if (recognized && offsets.size === 1) sourceOffset = [...offsets][0];
  }
  if (sourceOffset === undefined) return false;
  const seconds = (hours * 60 + Number(clock[2] ?? 0) - sourceOffset) * 60 + Number(clock[3] ?? 0);
  if (statedDate) {
    const midnight = Date.parse(`${statedDate}T00:00:00Z`);
    return Number.isFinite(midnight) && new Date(midnight).toISOString().slice(0, 10) === statedDate
      && midnight + seconds * 1000 === Date.parse(expected);
  }
  const target = Number(reference[1]) * 3600 + Number(reference[2]) * 60 + Number(reference[3] ?? 0);
  return (((seconds + expectedOffset * 60) % 86400) + 86400) % 86400 === target;
}

export function reportingGrades(item: EvalCase, contract: ReportingContract, facts: ReportFact[], messages: ReportMessage[]):
  Array<{ id: string; verdict: 'YES' | 'NO'; evidence: string }> {
  facts = validateFacts({ facts }, contract, messages);
  const byField = new Map<string, ReportFact>();
  const offset = (fact: ReportFact): number => sourceOffset(fact, messages.find((message) => message.eventIndex === fact.eventIndex
    && message.text.includes(fact.quote))!, contract.fields.find((field) => field.key === fact.field)?.type === 'number');
  for (const fact of [...facts].sort((a, b) => a.eventIndex - b.eventIndex || offset(a) - offset(b))) byField.set(fact.field, fact);
  return contract.rules.map((rule) => {
    const alternatives = rule.anyOf.map((conditions) => conditions.map((condition) => {
      const field = contract.fields.find((candidate) => candidate.key === condition.field)!;
      const fact = byField.get(condition.field);
      const expected = condition.expectedPath.reduce<unknown>((value, key) =>
        value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, item.heldOut.private_key);
      if (expected === undefined) throw new Error(`${item.id}/${rule.criterionId}: missing expected path ${condition.expectedPath.join('.')}`);
      let pass = false;
      let comparison = '';
      if (fact && field.type === 'number') {
        const parsed = reportedNumber(fact, field);
        const rawTarget = Number(expected) * (condition.expectedScale ?? 1);
        const target = condition.comparison === 'magnitude' ? Math.abs(rawTarget) : rawTarget;
        if (!Number.isFinite(target)) throw new Error(`${condition.field}: expected number is invalid.`);
        const approximate = /[~≈]|\b(?:about|around|approximately|approx\.?|roughly)\b/i.test(fact.quote);
        const points = parsed ? (parsed.bounds ?? [parsed.value!]).map((value, index) => ({
          value: condition.comparison === 'magnitude' ? Math.abs(value) : value,
          roundingUnit: parsed.boundRoundingUnits?.[index] ?? parsed.roundingUnit,
        })) : [];
        if (condition.comparison === 'magnitude' && parsed?.bounds
          && Math.min(...parsed.bounds) < 0 && Math.max(...parsed.bounds) > 0) {
          points.push({ value: 0, roundingUnit: Math.min(...parsed.boundRoundingUnits!) });
        }
        const tolerances = points.map((point) => condition.comparison === 'exact' ? 0 : Math.max(
          point.roundingUnit / 2, condition.absoluteTolerance ?? 0,
          approximate ? condition.approximateTolerance ?? 0 : 0));
        const epsilon = Number.EPSILON * Math.max(1, Math.abs(target)) * 8;
        pass = points.length > 0 && points.every((point, index) =>
          (condition.maxRoundingUnit === undefined || point.roundingUnit <= condition.maxRoundingUnit
            || Math.abs(point.value - target) <= epsilon)
          && Math.abs(point.value - target) <= tolerances[index]! + epsilon);
        const displayedTolerance = tolerances.length ? tolerances.join(' / ')
          : condition.comparison === 'exact' ? 0 : Math.max(condition.absoluteTolerance ?? 0,
            approximate ? condition.approximateTolerance ?? 0 : 0);
        comparison = `; expected=${target}, tolerance=${displayedTolerance}`
          + (parsed?.bounds ? `; reported interval=${JSON.stringify(parsed.bounds)}; every endpoint must satisfy tolerance` : '');
      } else if (fact) {
        const accepted = [...(typeof expected === 'string' || typeof expected === 'number' ? [String(expected)] : []), ...(condition.aliases ?? [])];
        const parts = fact.literal.replace(/[()]/g, '/').split('/').map((part) => part.trim()).filter(Boolean);
        const timestamp = typeof expected === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(expected) ? expected : undefined;
        const matches = (actual: string): boolean => condition.comparison === 'alias' && timestamp !== undefined
          ? clockMatches(actual, timestamp)
          : accepted.some((value) => condition.comparison === 'exact'
            ? actual.trim() === value.trim() : normalize(actual) === normalize(value));
        pass = matches(fact.literal) || (condition.comparison === 'alias' && parts.length > 1 && parts.every(matches));
        comparison = `; accepted=${accepted.join(' / ')}`;
      }
      return { pass, present: !!fact, span: fact && field.type === 'number' ? `${fact.eventIndex}:${offset(fact)}:${fact.literal.length}` : undefined, evidence: `${condition.field}: ${fact ? JSON.stringify(fact.literal) + ' at event ' + fact.eventIndex : 'not reported'}${comparison}` };
    }));
    const passed = alternatives.find((checks) => checks.every((check) => check.pass)
      && alternatives.flat().every((other) => !other.present || other.pass
        || (other.span !== undefined && checks.some((check) => check.span === other.span))));
    const evidence = (passed ?? alternatives.flat()).map((check) => check.evidence).join('; ');
    return { id: rule.criterionId, verdict: passed ? 'YES' : 'NO', evidence };
  });
}
