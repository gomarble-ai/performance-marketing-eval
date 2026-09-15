import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset } from './dataset.js';

const CASE_ID = 'GM-FRONTIER-META-CONTEXT-WRITE-004';
const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));

describe('case contracts', () => {
  test('keeps Meta bidding acronyms aligned across case 004 artifacts', () => {
    const dataset = loadDataset();
    const evalCase = dataset.cases.find((item) => item.id === CASE_ID);
    const world = dataset.worlds.find((item) => item.caseId === CASE_ID);
    const fixtures = dataset.fixtures.filter((item) => item.caseId === CASE_ID);

    if (!evalCase || !world) throw new Error(`${CASE_ID} is missing from the dataset`);

    expect(evalCase.served.business_context.naming).toMatchObject({
      CC: 'cost cap',
      LC: 'lowest cost',
    });

    const renames = evalCase.heldOut.private_key.campaign_renames as Record<string, [string, string]>;
    for (const [campaignId, [before, after]] of Object.entries(renames)) {
      expect(before.split('--').at(-1)).toBe('CC');
      expect(after.split('--').at(-1)).toBe('LC');
      expect(world.initialState.entities.campaigns[campaignId]?.name).toBe(before);
      expect(world.expectedFinalState.writes).toContainEqual({
        entity: campaignId,
        field: 'name',
        value: after,
      });
    }

    expect(JSON.stringify(fixtures)).not.toMatch(/--(?:BE|KE)\b/);
    for (const file of ['grade.ts', 'mock-server.mjs']) {
      expect(readFileSync(join(SOURCE_DIR, file), 'utf8')).not.toMatch(/--(?:BE|KE)\b/);
    }
  });
});
