import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface AgentInput {
  harness: 'claude' | 'codex';
  model: string;
  effort: string;
  prompt: string;
  sessionId?: string;
  mcpUrl: string;
  workspace: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onEvent: (event: unknown) => void;
}

export interface AgentResult {
  sessionId?: string;
  text: string;
  error?: string;
  usage?: unknown;
  costUsd?: number;
}

/** Runs one native CLI turn; resumes preserve conversation, while auth stays with the installed CLI. */
export function runAgent(input: AgentInput): Promise<AgentResult> {
  if (input.signal?.aborted) return Promise.resolve({ text: '', error: 'Run cancelled' });
  const claude = input.harness === 'claude';
  const binary = claude ? process.env.CLAUDE_BIN ?? 'claude' : process.env.CODEX_BIN ?? 'codex';
  const args = claude ? [
    '-p', input.prompt, '--output-format', 'stream-json', '--verbose',
    '--setting-sources', '', '--disable-slash-commands', '--no-chrome',
    '--settings', JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false, claudeMdExcludes: ['**'] }),
    '--strict-mcp-config', '--mcp-config', JSON.stringify({
      mcpServers: { perf_marketing_eval: { type: 'http', url: input.mcpUrl } },
    }),
    '--tools', '', '--allowedTools', 'mcp__perf_marketing_eval__*',
    '--permission-mode', 'dontAsk', '--model', input.model, '--effort', input.effort,
    ...(input.sessionId ? ['--resume', input.sessionId] : ['--session-id', randomUUID()]),
  ] : [
    'exec', ...(input.sessionId ? ['resume'] : []),
    '--json', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
    '--model', input.model,
    ...[
      'apps', 'plugins', 'browser_use', 'multi_agent', 'hooks', 'memories',
      'shell_tool', 'unified_exec', 'view_image', 'image_generation', 'skill_search',
    ].flatMap((feature) => ['--disable', feature]),
    ...[
      `model_reasoning_effort=${JSON.stringify(input.effort)}`,
      `mcp_servers.perf_marketing_eval.url=${JSON.stringify(input.mcpUrl)}`,
      'mcp_servers.perf_marketing_eval.required=true',
      'mcp_servers.perf_marketing_eval.default_tools_approval_mode="approve"',
      'approval_policy="never"', 'sandbox_mode="read-only"', 'web_search="disabled"',
      'project_doc_max_bytes=0', 'project_doc_fallback_filenames=[]',
      'features.skip_host_skill_discovery=true',
    ].flatMap((config) => ['-c', config]),
    ...(input.sessionId ? [input.sessionId] : ['--cd', input.workspace]),
    input.prompt,
  ];

  return new Promise((resolve) => {
    const env = { ...process.env };
    // Allow a benchmark launched from Claude Code to start its own isolated session.
    delete env.CLAUDECODE;
    const child = spawn(binary, args, {
      cwd: input.workspace, env, stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const result: AgentResult = { sessionId: input.sessionId, text: '' };
    let buffer = '';
    let stderr = '';
    let completed = false;
    let mcpStatus: string | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const kill = (signal: NodeJS.Signals): void => {
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, signal); return; } catch { /* Child already exited. */ }
      }
      child.kill(signal);
    };
    const stop = (error: string): void => {
      if (killTimer) return;
      result.error = error;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 2_000);
    };
    const onAbort = (): void => stop('Run cancelled');
    const timer = setTimeout(() => stop(`Turn timed out after ${input.timeoutMs} ms`), input.timeoutMs);
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted) onAbort();

    const handleLine = (line: string): void => {
      if (!line.trim()) return;
      let event: Record<string, any>;
      try { event = JSON.parse(line); } catch { return; }
      try { input.onEvent(event); } catch (error) {
        stop(`Could not record trace: ${String(error)}`);
        return;
      }
      if (!event || typeof event !== 'object') return;
      if (claude) {
        if (typeof event.session_id === 'string') result.sessionId = event.session_id;
        if (event.type === 'system' && event.subtype === 'init') {
          const servers = Array.isArray(event.mcp_servers) ? event.mcp_servers : [];
          mcpStatus = servers.find((server: any) => server?.name === 'perf_marketing_eval')?.status;
        }
        if (event.type === 'result') {
          completed = true;
          if (typeof event.result === 'string') result.text = event.result;
          result.usage = event.usage;
          if (typeof event.total_cost_usd === 'number') result.costUsd = event.total_cost_usd;
          if (event.is_error || event.subtype !== 'success') {
            result.error ??= Array.isArray(event.errors) ? event.errors.join('\n') : event.result || event.subtype || 'Claude turn failed';
          }
        }
      } else {
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') result.sessionId = event.thread_id;
        if (event.type === 'item.completed' && event.item?.type === 'agent_message'
          && typeof event.item.text === 'string' && event.item.phase !== 'commentary') {
          result.text = event.item.text;
        }
        if (event.type === 'turn.completed') {
          completed = true;
          result.usage = event.usage;
        }
        if (event.type === 'turn.failed' || event.type === 'error') {
          result.error ??= event.error?.message ?? event.message ?? JSON.stringify(event.error ?? event);
        }
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4_000); });
    child.on('error', (error) => { result.error ??= `${binary}: ${error.message}`; });
    child.on('close', (exitCode, signal) => {
      handleLine(buffer);
      clearTimeout(timer);
      if (killTimer) kill('SIGKILL');
      clearTimeout(killTimer);
      input.signal?.removeEventListener('abort', onAbort);
      if (exitCode !== 0) result.error ??= `${binary} exited ${exitCode ?? signal}${stderr.trim() ? `: ${stderr.trim()}` : ''}`;
      if (!result.sessionId) result.error ??= 'No session ID returned';
      if (!completed) result.error ??= 'CLI exited without completing the turn';
      if (claude && mcpStatus !== 'connected') result.error ??= `Benchmark MCP is ${mcpStatus ?? 'missing'}`;
      result.text = result.text.trim();
      if (!result.text) result.error ??= 'No final answer returned';
      resolve(result);
    });
  });
}
