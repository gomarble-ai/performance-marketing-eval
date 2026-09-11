type Response = {
  text?: string;
};

export type ConversationRow = { caseId: string; turn: number; event: unknown };
export type VisibleConversationEvent = {
  caseId: string;
  turn: number;
  eventIndex: number;
} & (
  | { type: 'assistant'; text: string; messageId?: string }
  | { type: 'tool_call' | 'tool_result'; toolCallId: string; toolName: string; status?: string; error?: string }
);

/** Public assistant text and MCP boundaries in source order, excluding reasoning and tool payloads. */
export function visibleConversation(rows: ConversationRow[], caseId?: string): VisibleConversationEvent[] {
  const output: VisibleConversationEvent[] = [];
  const toolNames = new Map<string, string>();
  const assistantTexts = new Map<string, string[]>();
  const completedMessages = new Set<string>();
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const key = (row: ConversationRow, id: string): string => JSON.stringify([row.caseId, row.turn, id]);

  // Keep incomplete started messages, but prefer their completed text when available.
  for (const row of rows) {
    const event = object(row.event);
    const item = object(event.item);
    if (event.type === 'item.completed' && item.type === 'agent_message'
      && typeof item.id === 'string' && typeof item.text === 'string' && item.text.trim()) {
      completedMessages.add(key(row, item.id));
    }
  }

  for (const [eventIndex, row] of rows.entries()) {
    if (caseId !== undefined && row.caseId !== caseId) continue;
    const event = object(row.event);
    const base = { caseId: row.caseId, turn: row.turn, eventIndex };
    const turnKey = key(row, '');
    const addText = (text: string, messageId?: string): void => {
      if (!text.trim()) return;
      output.push({ ...base, type: 'assistant', text, ...(messageId ? { messageId } : {}) });
      const texts = assistantTexts.get(turnKey) ?? [];
      texts.push(text);
      assistantTexts.set(turnKey, texts);
    };

    if (event.type === 'assistant' || event.type === 'user') {
      const message = object(event.message);
      for (const raw of Array.isArray(message.content) ? message.content : []) {
        const block = object(raw);
        if (event.type === 'assistant' && block.type === 'text' && typeof block.text === 'string') {
          addText(block.text, typeof message.id === 'string' ? message.id : undefined);
        } else if (event.type === 'assistant' && block.type === 'tool_use'
          && typeof block.id === 'string' && typeof block.name === 'string' && block.name.startsWith('mcp__')) {
          const toolName = block.name.replace(/^mcp__perf_marketing_eval__/, '');
          toolNames.set(key(row, block.id), toolName);
          output.push({ ...base, type: 'tool_call', toolCallId: block.id, toolName });
        } else if (event.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const toolName = toolNames.get(key(row, block.tool_use_id));
          if (toolName) output.push({ ...base, type: 'tool_result', toolCallId: block.tool_use_id,
            toolName, status: block.is_error ? 'failed' : 'completed' });
        }
      }
    } else if (event.type === 'result' && event.subtype === 'success' && !event.is_error && typeof event.result === 'string') {
      const text = event.result;
      const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim();
      if (!normalize((assistantTexts.get(turnKey) ?? []).join('\n\n')).includes(normalize(text))) addText(text);
    } else if (event.type === 'item.started' || event.type === 'item.completed') {
      const item = object(event.item);
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        if (event.type === 'item.completed' || typeof item.id !== 'string' || !completedMessages.has(key(row, item.id))) {
          addText(item.text, typeof item.id === 'string' ? item.id : undefined);
        }
      } else if (item.type === 'mcp_tool_call' && typeof item.id === 'string') {
        const name = typeof item.tool === 'string' ? item.tool : item.name;
        const toolName = typeof name === 'string' ? name.replace(/^mcp__perf_marketing_eval__/, '') : toolNames.get(key(row, item.id));
        if (!toolName) continue;
        toolNames.set(key(row, item.id), toolName);
        const error = typeof item.error === 'string' ? item.error : object(item.error).message;
        output.push({ ...base, type: event.type === 'item.started' ? 'tool_call' : 'tool_result',
          toolCallId: item.id, toolName,
          ...(typeof item.status === 'string' ? { status: item.status } : {}),
          ...(typeof error === 'string' ? { error } : {}) });
      }
    }
  }
  return output;
}

/** Final text returned by the native CLI. */
export function visibleAnswerText(response: Response): string {
  return response.text ?? '';
}
