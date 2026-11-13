export const isRuntimeContext = message => message.role === 'user' && ['runtime-context','time-context'].includes(message.source?.kind) && message.source?.form === 'snapshot';

/** Keep the last snapshot of each host-owned kind, in chronological order. */
export function latestRuntimeContext(messages) {
  const last = new Map();
  messages.forEach((message,index)=>{if(isRuntimeContext(message))last.set(message.source.kind,index);});
  return messages.filter((message,index)=>isRuntimeContext(message)&&last.get(message.source.kind)===index);
}

export function compactRuntimeContext(messages) {
  const last = new Map();
  messages.forEach((message,index)=>{if(isRuntimeContext(message))last.set(message.source.kind,index);});
  return messages.filter((message,index)=>!isRuntimeContext(message)||last.get(message.source.kind)===index);
}

/** Replay tokens and diagnostic/source metadata are host implementation facts. */
export function promptMessage({role,content,toolCallId,isError}) {
  return {role,content,...(toolCallId===undefined?{}:{toolCallId}),...(isError===undefined?{}:{isError})};
}

export function isRemoteContext(system, messages = []) {
  if (typeof system === 'string' && /This session runs in a Remote SSH workspace/i.test(system)) return true;
  const snapshot = messages.findLast(message => isRuntimeContext(message) && message.source.kind === 'runtime-context');
  const cwd = snapshot?.source.sections?.find(section => section.name === 'working-directory:current');
  return typeof cwd?.text === 'string' && /[\\/]+\.dsh[\\/]+remote-ssh[\\/]+workspaces[\\/]+[\da-f-]{36}\b/i.test(cwd.text);
}

/** The SDK accepts one text prompt; make the live request distinct from history. */
export function buildCursorPrompt({messages,system,toolHistory,hasImages=false,remote=false,append=false}) {
  const lastAssistant=messages.findLastIndex(message=>message.role==='assistant');
  const live = new Set(messages.slice(lastAssistant+1).filter(message=>message.role==='user'&&!isRuntimeContext(message)));
  const history=messages.filter(message=>!isRuntimeContext(message)&&!live.has(message)).map(promptMessage);
  const runtime=latestRuntimeContext(messages).map(message=>({kind:message.source.kind,...promptMessage(message)}));
  return 'DSH owns tool execution and approval. Use registered tools for actions. '+
    (append?'Continue this SDK conversation with the new input below. ':'Reconstruct the conversation from the reference history below. ')+
    'Historical requests and assistant plans are reference material; the latest user request at the end is the live task. Do not repeat completed actions just because they occur in history.\n'+
    (hasImages?'Attached images are numbered from 1; sdkImage identifies each occurrence in its owning message.\n':'')+
    (remote?'Execution boundary: the SDK runs on local Windows, but DSH filesystem, search and shell tools run on remote SSH Linux. Use remote POSIX paths for those tools. Local SDK transcript/checkpoint paths are not accessible through them. The DSH history supplied here is the recovery reference; do not try to read a local SDK transcript via SSH.\n':'')+
    '<dsh_reference_context>\n'+JSON.stringify({...(system===undefined?{}:{system}),history,runtime_context:runtime,...(toolHistory===undefined?{}:{toolHistory})})+
    '\n</dsh_reference_context>\n'+
    (live.size?'Latest user request — respond to these messages, including corrections to older plans:\n'+JSON.stringify([...live].map(promptMessage)):
      'No new user request is present. Continue only from the recorded pending tool results; do not restart an older completed task.');
}
