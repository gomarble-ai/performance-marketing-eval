import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

export interface EvalCase {
  id: string;
  title: string;
  tier: 'sanity' | 'frontier';
  platform: string;
  question: string;
  interaction?: Array<{ role: string; content: string }>;
  served: {
    turns: string[];
    business_context: Record<string, unknown>;
    selected_accounts: Array<{
      accountId: string;
      accountName: string;
      connectionType: string;
      managerId?: string;
    }>;
    request_context: {
      analysis_window: string;
      snapshot_time: string;
      clock_source: string;
    };
    mcp_result_contract: Record<string, unknown>;
  };
  heldOut: {
    private_key: Record<string, unknown>;
    expected_tool_reads: string[];
    expected_writes: Array<{ entity: string; field: string; value: unknown }>;
    forbidden_mutations: string[];
    fault_schedule: string[];
    evidence_provenance?: Record<string, unknown>;
  };
  rubric: {
    dimensions: Record<string, number>;
    criteria: Array<{
      id: string;
      checker: 'code' | 'extract' | 'judge';
      lever: string;
      criterion: string;
      gate: boolean;
      safety: boolean;
    }>;
    strict_pass: string;
  };
  benchmark_context: {
    requestContext: Record<string, unknown>;
    selectedAccounts: Array<{
      accountId: string;
      connectionType: string;
    }>;
    policyContext?: Record<string, unknown>;
    selectionContext?: Record<string, unknown>;
    userInputs?: Record<string, unknown>;
  };
  snapshot_contract: { frozen_at: string; host_clock_used: boolean };
  mcp_date_contract: {
    fixed_dates_only: boolean;
    expected_intervals: Array<{ since: string; until: string }>;
  };
}

export interface Fixture {
  caseId: string;
  sourcePath: string;
  payload: unknown;
}

export interface Account {
  accountId: string;
  accountName: string;
  connectionType: 'meta_ads' | 'google_ads' | 'shopify' | 'tiktok_ads';
  managerId?: string;
  accountData: {
    original_currency: string;
    converted_currency: string;
    [key: string]: unknown;
  };
}

export interface ToolContract {
  tool: {
    name: string;
    description?: string;
    summary?: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  };
}

interface Manifest {
  formatVersion: string;
  suite: string;
  suiteVersion: number;
  counts: {
    total: number;
    sanity: number;
    frontier: number;
    writeCases: number;
    criteria: number;
    gates: number;
    safety: number;
    accounts: number;
    sourceFixtures: number;
    toolContracts: number;
    worlds: number;
  };
  files: Record<string, { sha256: string; lines: number }>;
}

export interface EvalWorld {
  caseId: string;
  seed: number;
  initialState: {
    entities: {
      campaigns: Record<string, Record<string, unknown>>;
      adsets: Record<string, Record<string, unknown>>;
      ads: Record<string, Record<string, unknown>>;
    };
  };
  expectedFinalState: {
    writes: Array<{ entity: string; field: string; value: unknown }>;
  };
  faults: string[];
  createFaults?: string[];
  generatedIds?: Record<string, string>;
  deferWritesUntilTurn?: number;
}

function rows<T>(name: string): T[] {
  const body = readFileSync(join(DATA_DIR, name), 'utf8');
  return body.trimEnd().split('\n').filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line) as T;
    } catch (error) {
      throw new Error(`${name}:${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

function sha256(name: string): string {
  return createHash('sha256').update(readFileSync(join(DATA_DIR, name))).digest('hex');
}

export function loadDataset(): {
  manifest: Manifest;
  cases: EvalCase[];
  fixtures: Fixture[];
  accounts: Account[];
  contracts: ToolContract[];
  worlds: EvalWorld[];
} {
  const [manifest] = rows<Manifest>('manifest.jsonl');
  if (!manifest) throw new Error('manifest.jsonl is empty');
  for (const [name, expected] of Object.entries(manifest.files)) {
    const actualHash = sha256(name);
    if (actualHash !== expected.sha256) {
      throw new Error(`${name} hash mismatch: expected ${expected.sha256}, got ${actualHash}`);
    }
    const actualLines = rows<unknown>(name).length;
    if (actualLines !== expected.lines) {
      throw new Error(`${name} line count mismatch: expected ${expected.lines}, got ${actualLines}`);
    }
  }
  return {
    manifest,
    cases: rows<EvalCase>('cases.jsonl'),
    fixtures: rows<Fixture>('fixtures.jsonl'),
    accounts: rows<Account>('accounts.jsonl'),
    contracts: rows<ToolContract>('tool-contracts.jsonl'),
    worlds: rows<EvalWorld>('worlds.jsonl'),
  };
}
