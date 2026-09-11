import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadDataset, DATA_DIR } from './dataset.js';
import { runAgent } from './agents.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    harness: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string', default: 'high' },
    case: { type: 'string' }, tier: { type: 'string' }, out: { type: 'string' },
    timeout: { type: 'string', default: '600' }, port: { type: 'string' }, help: { type: 'boolean' },
  },
});

if (values.help) {
  console.log('Usage: bun run eval:claude|eval:codex --model MODEL [--effort high] [--case ID[,ID]] [--tier sanity|frontier] [--out DIR] [--timeout SECONDS] [--port PORT]');
  process.exit(0);
}

const hash = (body: string | Buffer): string => createHash('sha256').update(body).digest('hex');
const append = (path: string, value: unknown): void => appendFileSync(path, JSON.stringify(value) + '\n');
type Call = { caseId: string; turn: number; sequence: number; tool: string; input: unknown; output: unknown };

function callsForTurn(path: string, caseId: string, turn: number): Array<{ name: string; args: unknown; result: unknown }> {
  const matching: Call[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    const call = JSON.parse(line) as Call;
    if (call.caseId === caseId && call.turn === turn) matching.push(call);
  }
  matching.sort((a, b) => a.sequence - b.sequence);
  const calls: Array<{ name: string; args: unknown; result: unknown }> = [];
  for (const call of matching) calls.push({ name: call.tool, args: call.input, result: call.output });
  return calls;
}

async function availablePort(): Promise<number> {
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid --port');
  return new Promise((accept, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') { probe.close(); reject(new Error('No TCP port')); return; }
      probe.close(() => accept(address.port));
    });
  });
}

async function main(): Promise<void> {
  const harness = values.harness;
  if (harness !== 'claude' && harness !== 'codex') throw new Error('--harness must be claude or codex');
  if (!values.model) throw new Error('--model is required');
  const timeoutMs = Number(values.timeout) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout must be positive');
  if (values.tier && !['sanity', 'frontier'].includes(values.tier)) throw new Error('Invalid --tier');
  const dataset = loadDataset();
  const requested = values.case?.split(',').map((id) => id.trim());
  for (const id of requested ?? []) {
    if (!dataset.cases.some((item) => item.id === id)) throw new Error(`Unknown case ${id}`);
  }
  const cases = dataset.cases.filter((item) => (!requested || requested.includes(item.id)) && (!values.tier || item.tier === values.tier));
  if (!cases.length) throw new Error('No cases selected');
  const executable = harness === 'claude' ? process.env.CLAUDE_BIN ?? 'claude' : process.env.CODEX_BIN ?? 'codex';
  const cliVersion = execFileSync(executable, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  const runId = `${harness}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const runDir = resolve(values.out ?? join(ROOT, 'runs', runId));
  mkdirSync(dirname(runDir), { recursive: true });
  mkdirSync(runDir); // Never overwrite an earlier evaluation.
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'perf-marketing-eval-'));
  const callPath = join(runDir, 'tool-calls.jsonl');
  const resultPath = join(runDir, 'results.jsonl');
  const transcriptPath = join(runDir, 'conversations.jsonl');
  for (const path of [callPath, resultPath, transcriptPath]) writeFileSync(path, '');
  const sourceHash = hash(readdirSync(join(ROOT, 'src')).sort().map((name) => `${name}:${hash(readFileSync(join(ROOT, 'src', name)))}`).join('\n'));
  const metadata = {
    runId, harness, cliVersion, model: values.model, effort: values.effort,
    startedAt: new Date().toISOString(), caseIds: cases.map((item) => item.id),
    datasetSha256: hash(readFileSync(join(DATA_DIR, 'manifest.jsonl'))),
    runtimeSha256: sourceHash,
  };
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(metadata, null, 2) + '\n');
  const fd = openSync(join(runDir, 'mock.log'), 'a');
  const mock = spawn('node', [join(ROOT, 'src/mock-server.mjs')], {
    env: { ...process.env, MOCK_MCP_PORT: String(port), MARKETING_EVAL_CALL_LOG: join(runDir, 'events.jsonl'), MARKETING_EVAL_TRACE_LOG: callPath },
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  let mockError: Error | undefined;
  mock.on('error', (error) => { mockError = error; });
  const controller = new AbortController();
  const interrupt = (): void => { controller.abort(); mock.kill(); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const post = async (path: string, body: unknown): Promise<void> => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`${path}: ${await response.text()}`);
  };
  let completed = 0;
  let errors = 0;
  try {
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (mockError) throw mockError;
      if (mock.exitCode !== null) throw new Error(`Mock exited ${mock.exitCode}; see mock.log`);
      controller.signal.throwIfAborted();
      try { if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* starting */ }
      if (Date.now() >= deadline) throw new Error('Mock startup timed out');
      await Bun.sleep(100);
    }
    for (const item of cases) {
      controller.signal.throwIfAborted();
      await post('/__case', { caseId: item.id, runId });
      const workspace = join(workspaceRoot, item.id);
      mkdirSync(workspace);
      const responses = [];
      let sessionId: string | undefined;
      let error: string | undefined;
      const started = Date.now();
      for (const [turn, request] of item.served.turns.entries()) {
        await post('/__turn', { turn });
        const prompt = turn === 0 ? [
          `Authoritative current date: ${item.snapshot_contract.frozen_at.slice(0, 10)}. Never use the host clock.`,
          'Unattended evaluation: do not ask questions or wait for confirmation. Use only the supplied operational context and the perf_marketing_eval MCP tools for platform data and writes. If a detail is unspecified, infer a safe default from the source campaign or current account state. Complete the task.',
          'The MCP server is a local simulator. User-requested mock writes are pre-authorized: proposal tools apply them automatically without an external approval UI. Honor every task-specific scope, timing, and safety constraint.',
          'Operational context:', JSON.stringify({ operationalContext: item.benchmark_context }),
          'Request:', request,
        ].join('\n\n') : request;
        const response = await runAgent({
          harness, model: values.model, effort: values.effort!, prompt, sessionId,
          mcpUrl: `${base}/mcp-api/mcp`, workspace, timeoutMs, signal: controller.signal,
          onEvent: (event) => append(transcriptPath, { caseId: item.id, turn, event }),
        });
        sessionId = response.sessionId;
        const calls = callsForTurn(callPath, item.id, turn);
        responses.push({ prompt, ...response, toolCalls: calls });
        error = response.error;
        if (!error && turn < item.served.turns.length - 1 && !sessionId) error = 'Missing session ID for the next turn';
        if (error) break;
      }
      const stateResponse = await fetch(`${base}/__state`, { signal: AbortSignal.timeout(5000) });
      if (!stateResponse.ok) throw new Error('Could not capture final mock state');
      const finalWorld = await stateResponse.json();
      append(resultPath, { runId, executor: `${harness}-cli`, model: values.model, effort: values.effort,
        caseId: item.id, tier: item.tier, sessionId, responses, finalWorld, error,
        durationSeconds: (Date.now() - started) / 1000 });
      completed++;
      if (error) errors++;
      console.log(`[${completed}/${cases.length}] ${item.id}: ${error ? `ERROR ${error}` : 'complete'}`);
    }
  } finally {
    controller.abort();
    mock.kill();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    rmSync(workspaceRoot, { recursive: true, force: true });
    writeFileSync(join(runDir, 'run.json'), JSON.stringify({ ...metadata, finishedAt: new Date().toISOString(), completed, errors, complete: completed === cases.length }, null, 2) + '\n');
  }
  console.log(`Results and traces: ${runDir}`);
  if (errors) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
