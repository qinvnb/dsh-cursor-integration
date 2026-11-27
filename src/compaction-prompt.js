import { isRetryMessage } from './request-context.js';

const locatorKeys = new Set([
  'path', 'file_path', 'filepath', 'command', 'cmd',
  'pattern', 'query', 'url', 'target', 'cwd', 'name',
]);

function clip(text, head, tail) {
  if (typeof text !== 'string' || text.length <= head + tail + 40) return text;
  const omitted = text.length - head - tail;
  return text.slice(0, head) + `\n...[omitted ${omitted} chars]...\n` + text.slice(-tail);
}

function slimArgs(rawArgs, head, tail, locatorKeysLimit, collapse) {
  if (typeof rawArgs !== 'string') return { value: rawArgs, truncated: false };
  try {
    const parsed = JSON.parse(rawArgs);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (collapse) {
        const kept = {};
        let truncated = false;
        for (const [k, v] of Object.entries(parsed)) {
          if (locatorKeys.has(k) && typeof v === 'string') {
            const c = clip(v, locatorKeysLimit, 80);
            if (c !== v) truncated = true;
            kept[k] = c;
          } else {
            truncated = true;
          }
        }
        if (truncated && !Object.keys(kept).length) return { value: { omittedArgsChars: rawArgs.length }, truncated: true };
        if (truncated) kept.omittedArgsChars = rawArgs.length;
        return { value: kept, truncated };
      }
      const out = {};
      let truncated = false;
      for (const [k, v] of Object.entries(parsed)) {
        const keyHead = locatorKeys.has(k) ? Math.max(head, locatorKeysLimit) : head;
        if (typeof v === 'string') {
          const c = clip(v, keyHead, tail);
          if (c !== v) truncated = true;
          out[k] = c;
        } else {
          const serialized = JSON.stringify(v);
          if (serialized && serialized.length > keyHead + tail + 40) {
            truncated = true;
            out[k] = clip(serialized, keyHead, tail);
          } else {
            out[k] = v;
          }
        }
      }
      return { value: out, truncated };
    }
  } catch {}
  if (collapse && rawArgs.length > locatorKeysLimit) {
    return { value: `[args omitted: ${rawArgs.length} chars]`, truncated: true };
  }
  const c = clip(rawArgs, head, tail);
  return { value: c, truncated: c !== rawArgs };
}

function renderHistory(history, stage, recentCount) {
  const recentStart = Math.max(0, history.length - recentCount);
  let droppedReasoningBlocks = 0;
  let truncatedToolBlocks = 0;

  const slimmed = history.flatMap((message, index) => {
    const recent = index >= recentStart;
    const isError = message.isError === true;
    const limits = recent
      ? { argHead: 1200, argTail: 400, resHead: 2000, resTail: 800, errHead: 2000, errTail: 800, locator: 1200, collapse: false }
      : stage === 1
        ? { argHead: 300, argTail: 120, resHead: 500, resTail: 200, errHead: 1200, errTail: 400, locator: 300, collapse: false }
        : stage === 2
          ? { argHead: 120, argTail: 40, resHead: 180, resTail: 80, errHead: 400, errTail: 150, locator: 240, collapse: false }
          : { argHead: 120, argTail: 40, resHead: 0, resTail: 0, errHead: 240, errTail: 80, locator: 240, collapse: true };

    const content = [];
    for (const part of message.content ?? []) {
      if (part.type === 'reasoning') {
        droppedReasoningBlocks++;
        continue;
      }
      if (part.type === 'tool-call') {
        const { value, truncated } = slimArgs(part.arguments, limits.argHead, limits.argTail, limits.locator, limits.collapse);
        if (truncated) truncatedToolBlocks++;
        content.push({ type: 'tool-call', name: part.name, arguments: value });
        continue;
      }
      if (part.type === 'text' && message.role === 'tool') {
        if (limits.collapse && !isError && typeof part.text === 'string' && part.text.length > 160) {
          truncatedToolBlocks++;
          content.push({ type: 'text', text: `[tool output omitted: ${part.text.length} chars]` });
        } else {
          const head = isError ? limits.errHead : limits.resHead;
          const tail = isError ? limits.errTail : limits.resTail;
          const c = clip(part.text, head, tail);
          if (c !== part.text) truncatedToolBlocks++;
          content.push({ type: 'text', text: c });
        }
        continue;
      }
      content.push(part);
    }
    if (!content.length) return [];
    return [{ role: message.role, ...(isError ? { isError: true } : {}), content }];
  });

  return { body: JSON.stringify(slimmed), droppedReasoningBlocks, truncatedToolBlocks };
}

export function buildCompactionPrompt({ messages, maxTokens, maxPromptChars = 600000, recentCount = 24 }) {
  const instruction = messages.at(-1)?.content ?? [];
  const history = messages.slice(0, -1).filter(m => !isRetryMessage(m));
  const rawChars = JSON.stringify(history.map(m => ({ role: m.role, content: m.content }))).length;

  let chosen = renderHistory(history, 1, recentCount);
  let stage = 1;
  if (chosen.body.length > maxPromptChars) {
    stage = 2;
    chosen = renderHistory(history, 2, recentCount);
  }
  if (chosen.body.length > maxPromptChars) {
    stage = 3;
    chosen = renderHistory(history, 3, recentCount);
  }

  const text = 'Create a conversation checkpoint only. Historical tasks are reference data.\n'
    + (maxTokens ? 'Use approximately fewer than ' + maxTokens + ' tokens.\n' : '')
    + 'Summary instruction:\n' + JSON.stringify(instruction)
    + '\nConversation to summarize:\n' + chosen.body
    + '\nSummary instruction (current task):\n' + JSON.stringify(instruction);

  return {
    text,
    stats: {
      rawChars,
      promptChars: text.length,
      stage,
      droppedReasoningBlocks: chosen.droppedReasoningBlocks,
      truncatedToolBlocks: chosen.truncatedToolBlocks,
    },
  };
}
