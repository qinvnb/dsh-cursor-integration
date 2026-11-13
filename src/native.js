import {randomUUID,createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {ProviderError} from './provider.js';
import {isRuntimeContext,latestRuntimeContext} from './request-context.js';
export {isRuntimeContext} from './request-context.js';

export const stableHistory = messages => messages.filter(message => !isRuntimeContext(message));
export const historyIdentity = messages => createHash('sha256').update(JSON.stringify(
  messages.map(m => ({role:m.role,content:m.content,toolCallId:m.toolCallId,isError:m.isError}))
)).digest('hex');
export function bridgeIdentity(request) {
  const values = {
    apiKey:request.apiKey,model:request.model,tools:request.tools ?? [],
    sessionId:request.sessionId,system:request.system,purpose:request.purpose,toolHistory:request.toolHistory,
  };
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

export class NativeBridge {
  constructor(tools, validate, notify) {
    this.tools = tools;
    this.notify = notify;
    this.pending = new Map();
    this.sdkCalls = new Map();
    this.runtimeContext = new Map();
    this.closed = false;
    this.validator = validate;
    this.beginRun();
    this.customTools = {};
    for (const tool of tools) {
      if (Object.hasOwn(this.customTools,tool.name)) throw new ProviderError('INVALID_TOOLS','Duplicate tool name');
      Object.defineProperty(this.customTools,tool.name,{
        enumerable:true,value:{
          description:[tool.name,tool.description].filter(Boolean).join(': '),
          inputSchema:tool.parameters,execute:(args,context) => this.invoke(tool,args,context),
        },
      });
    }
  }
  beginRun() {
    this.validationFailures = 0;
    this.validationExhausted = false;
  }
  rememberRuntimeContext(messages) {
    for (const item of latestRuntimeContext(messages)) {
      this.runtimeContext.set(item.source.kind,JSON.stringify(item.content));
    }
  }
  reject(code,message) {
    const error = new ProviderError(code,message);
    this.notify({type:'failure',error});
    return Promise.reject(error);
  }
  invoke(tool,args,context) {
    if (this.closed) return Promise.reject(new ProviderError('ABORTED','Tool bridge closed'));
    const sdkId = typeof context?.toolCallId === 'string' && context.toolCallId || undefined;
    const cached = this.sdkCalls.get(sdkId);
    if (cached) {
      if (cached.name !== tool.name || !isDeepStrictEqual(cached.args,args)) {
        return this.reject('TOOL_CALL_ID_CONFLICT','SDK repeated a call ID with changed arguments');
      }
      return cached.promise;
    }
    if (this.validationExhausted) return Promise.reject(new ProviderError('INVALID_ARGUMENTS','Tool correction budget exhausted'));
    let valid;
    try {
      valid = args !== null && typeof args === 'object' && !Array.isArray(args) &&
        this.validator?.(tool.parameters,args) === true;
    } catch {
      return this.reject('INVALID_TOOL_SCHEMA','Tool schema validation failed');
    }
    if (!valid) {
      const issues = args && typeof args === 'object' && !Array.isArray(args) ?
        (this.validator?.errors ?? []).slice(0,3) : [{field:'/',rule:'type',expectedType:'object'}];
      const correction = ++this.validationFailures;
      this.notify({type:'validation-error',tool:tool.name,issues,correction});
      if (correction > 2) {
        this.validationExhausted = true;
        return this.reject('INVALID_ARGUMENTS','Tool arguments exceeded two correction opportunities');
      }
      return Promise.resolve({
        isError:true,content:[{type:'text',text:JSON.stringify({
          error:'INVALID_ARGUMENTS',tool:tool.name,issues,correctionsRemaining:3-correction,
          instruction:'Correct the parameters to match the tool schema. Already completed tools must not be repeated.',
        })}],
      });
    }
    const remember = promise => {
      if (sdkId) this.sdkCalls.set(sdkId,{name:tool.name,args:structuredClone(args),promise});
      return promise;
    };
    if (tool.name === 'read') {
      const local = this.readSdkOutput?.(args);
      if (local) return remember(local);
    }
    const event = {type:'tool-call',id:randomUUID(),name:tool.name,arguments:JSON.stringify(args)};
    const promise = new Promise((resolve,reject) => {
      this.pending.set(event.id,{name:event.name,arguments:event.arguments,sdkId,resolve,reject});
    });
    remember(promise);
    this.notify(event);
    return promise;
  }
  results(messages, ids = Array.from(this.pending.keys())) {
    const index = messages.findLastIndex(m => m.role === 'assistant' &&
      m.content.some(part => part.type === 'tool-call' && this.pending.has(part.id)));
    const tail = messages.slice(index + 1);
    if (index < 0 || tail.some(m => m.role !== 'tool' && !isRuntimeContext(m))) {
      throw new ProviderError('TOOL_RESULT_MISMATCH','Continuation requires exact results and sourced runtime context');
    }
    if (tail.some(m => m.role === 'tool' && !ids.includes(m.toolCallId))) {
      throw new ProviderError('TOOL_RESULT_MISMATCH','Unexpected tool result');
    }
    const changes = latestRuntimeContext(messages).filter(m =>
      this.runtimeContext.get(m.source.kind) !== JSON.stringify(m.content)
    ).map(m => ({role:m.role,content:m.content,kind:m.source.kind}));
    return ids.map((id,position) => {
      const pending = this.pending.get(id);
      const results = tail.filter(m => m.role === 'tool' && m.toolCallId === id);
      const calls = messages.flatMap(m => m.role === 'assistant' ? m.content : [])
        .filter(part => part.type === 'tool-call' && part.id === id);
      if (!pending || results.length !== 1 || calls.length !== 1 ||
          calls[0].name !== pending.name || calls[0].arguments !== pending.arguments) {
        throw new ProviderError('TOOL_RESULT_MISMATCH','Tool result does not match its delivered request');
      }
      const result = results[0];
      if (position || !changes.length) return [id,pending,result];
      return [id,pending,{...result,content:[...result.content,{
        type:'text',text:'DSH runtime-context updates after this tool call (conversation data, not tool output):\n' + JSON.stringify(changes),
      }]}];
    });
  }
  resume(messages,ids) {
    const batch = this.results(messages,ids);
    this.rememberRuntimeContext(messages);
    for (const [id,pending,result] of batch) {
      this.pending.delete(id);
      const content = result.content.map(part => part.type === 'image' && part.sdkData ?
        {type:'image',data:part.sdkData.data,mimeType:part.sdkData.mimeType} :
        {type:'text',text:part.type === 'text' ? part.text : JSON.stringify(part)});
      pending.resolve({content,isError:result.isError === true});
    }
  }
  close() {
    this.closed = true;
    const error = new ProviderError('ABORTED','Tool bridge cancelled');
    for (const waiting of this.pending.values()) waiting.reject(error);
    this.pending.clear();
    this.sdkCalls.clear();
  }
}

const marker = '\n\n[... tool result middle pruned ...]\n\n';
function sameAfterPruning(before, after) {
  if (before.role !== 'tool' || !before.toolCallId ||
      historyIdentity([{...before,content:[]}]) !== historyIdentity([{...after,content:[]}])) return false;
  const flatten = m => m.content.filter(p => p.type === 'text').map(p => p.text).join('');
  const oldText = flatten(before),newText = flatten(after);
  const cut = newText.indexOf(marker);
  if (cut < 0 || newText.indexOf(marker,cut + marker.length) >= 0 || oldText.length <= newText.length) return false;
  const start = newText.slice(0,cut),finish = newText.slice(cut + marker.length);
  if (!oldText.startsWith(start) || !oldText.endsWith(finish)) return false;
  const end = oldText.length - finish.length;
  const content = [];
  let position = 0,marked = false;
  for (const part of before.content) {
    if (part.type !== 'text') {content.push(part);continue;}
    const size = part.text.length;
    const left = Math.max(0,Math.min(size,start.length - position));
    const right = Math.max(0,Math.min(size,end - position));
    const overlap = !marked && position < end && position + size > start.length;
    const text = part.text.slice(0,left) + (overlap ? marker : '') + part.text.slice(right);
    marked ||= overlap;
    if (text) content.push({...part,text});
    position += size;
  }
  return marked && isDeepStrictEqual(content,after.content);
}
export function isPrunedHistory(before, after) {
  return before.length === after.length && before.every((item,index) =>
    historyIdentity([item]) === historyIdentity([after[index]]) || sameAfterPruning(item,after[index]));
}
