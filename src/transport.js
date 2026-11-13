import {createHash,randomUUID} from 'node:crypto';
import {RuntimeSession} from './runtime.js';
import {bounded,ProviderError} from './provider.js';
import {bridgeIdentity,historyIdentity,stableHistory,isPrunedHistory} from './native.js';
import {claim} from './checkpoints.js';
import {latestRuntimeContext} from './request-context.js';
import {describeCatalogFailure} from './network.js';

export class CursorTransport {
  constructor(options={}) {
    this.loadSDK=options.loadSDK??(()=>import('@cursor/sdk'));
    this.timeoutMs=options.timeoutMs??1800000;
    this.catalogTTL=options.catalogTTL??300000;
    this.now=options.now??Date.now;
    this.networkScope=options.networkScope??(action=>action());
    this.enableAgentRetries=Boolean(options.networkScope);
    this.replaceSystemPrompt=options.replaceSystemPrompt??false;
    this.checkpointRoot=options.checkpointRoot;
    this.onPath=options.onPath??(()=>{});
    this.lazyPrompt=true;
    this.closed=false;
    this.catalogs=new Map();
    this.sessions=new Set();
    this.idle=new Map();
    this.continuations=new Map();
  }
  check(key,signal) {
    if (this.closed) throw new ProviderError('DISPOSED','Transport closed');
    if (typeof key!=='string'||!key.trim()) throw new ProviderError('MISSING_CREDENTIAL','An explicit Cursor credential is required');
    if (signal?.aborted) throw new ProviderError('ABORTED','Request cancelled');
  }
  async catalog(apiKey,signal,{refresh=false}={}) {
    this.check(apiKey,signal);
    const digest=createHash('sha256').update(apiKey).digest('hex');
    const cached=this.catalogs.get(digest);
    if (!refresh && cached?.until>this.now()) return structuredClone(cached.models);
    try {
      const models=await bounded(()=>this.networkScope(async()=>{
        const sdk=await this.loadSDK();
        return sdk.Cursor.models.list({apiKey});
      }),{signal,timeoutMs:this.timeoutMs});
      if (!this.closed) {
        this.catalogs.set(digest,{models:structuredClone(models),until:this.now()+this.catalogTTL});
        if (this.catalogs.size>8) this.catalogs.delete(this.catalogs.keys().next().value);
      }
      return models;
    } catch(error) {throw describeCatalogFailure(error);}
  }
  retire(session) {this.sessions.delete(session);}
  expire(token) {this.continuations.delete(token);}
  start(request,restore) {
    const session=new RuntimeSession(this,request,restore);
    this.sessions.add(session);
    session.launch();
    return session;
  }
  async continue(request) {
    const session=this.continuations.get(request.continuation);
    if (!session) throw new ProviderError('CONTINUATION_UNAVAILABLE','Native continuation state was lost or expired');
    if (session.identity!==bridgeIdentity(request)) throw new ProviderError('CONTINUATION_IDENTITY_MISMATCH','Continuation configuration changed');
    if (session.busy) throw new ProviderError('CONTINUATION_BUSY','Continuation already in use');
    const history=stableHistory(request.messages);
    const prefix=history.slice(0,session.prefix.length);
    const changed=historyIdentity(prefix)!==session.prefixHash;
    const pruned=changed&&isPrunedHistory(session.prefix,prefix);
    if (pruned) session.historyPruned=true;
    if (session.ended || changed&&!pruned) {
      for (const call of session.pendingCalls) {
        const calls=request.messages.flatMap(m=>m.role==='assistant'?m.content:[])
          .filter(p=>p.type==='tool-call'&&p.id===call.id);
        const results=request.messages.filter(m=>m.role==='tool'&&m.toolCallId===call.id);
        if (calls.length!==1||results.length!==1||calls[0].name!==call.name||calls[0].arguments!==call.arguments) {
          throw new ProviderError('TOOL_RESULT_MISMATCH','Recovery requires the exact persisted call and result');
        }
      }
      this.expire(request.continuation);
      clearTimeout(session.recoveryTimer);
      session.controller.abort();
      await session.done;await session.dispose();
      const original=typeof request.prompt==='function'?request.prompt():request.prompt;
      const text=(typeof original==='string'?original:original.text)+
        '\nRecovery task: Tool results are authoritative. Explain completed results and remaining work. Do not execute or request any tools or repeat completed commands.';
      this.onPath(request.sessionId,'按已保存的工具结果重建');
      return this.start({...request,tools:[],prompt:typeof original==='string'?text:{...original,text}});
    }
    const ids=session.pendingCalls.map(call=>call.id);
    session.bridge.results(request.messages,ids);
    session.detach?.();
    this.expire(request.continuation);
    session.bridge.resume(request.messages,ids);
    return session;
  }
  async acquire(request) {
    if (request.continuation) return this.continue(request);
    const history=stableHistory(request.messages);
    const snapshot=latestRuntimeContext(request.messages).find(m=>m.source.kind==='runtime-context');
    const workspace=snapshot?.source.sections?.find(s=>s.name==='working-directory:current')?.text;
    const cached=!request.purpose&&this.idle.get(request.sessionId);
    if (cached) {
      this.idle.delete(request.sessionId);clearTimeout(cached.idleTimer);
      const suffix=history.slice(cached.committedLength);
      if (cached.workspace===workspace && cached.identity===bridgeIdentity(request) &&
          cached.committed===historyIdentity(history.slice(0,cached.committedLength)) &&
          suffix.length && suffix.every(m=>m.role==='user') &&
          !request.messages.some(m=>m.content.some(p=>p.type==='image'))) {
        await cached.activate(request,suffix);
        return cached;
      }
      await cached.dispose();
    }
    let reason='未找到可用检查点',saved;
    if (this.checkpointRoot && request.sessionId && !request.purpose) {
      try {
        saved=await claim(this.checkpointRoot,request.sessionId,data=>{
          if (data.workspace!==workspace) {reason='工作区已变化';return false;}
          if (data.identity!==bridgeIdentity(request)) {reason='账号、模型或工具配置不匹配';return false;}
          const size=data.committedLength;
          if (!Number.isSafeInteger(size)||size<1||size>=history.length ||
              data.committed!==historyIdentity(history.slice(0,size)) ||
              !history.slice(size).every(m=>m.role==='user')) {reason='历史与检查点不匹配';return false;}
          if (history.slice(size).some(m=>m.content.some(p=>p.type==='image'))) {reason='新增消息含图片';return false;}
          return true;
        },message=>{reason=message;});
      } catch {reason='无法读取检查点';}
    }
    return this.start(request,{saved,workspace,reason});
  }
  async cache(session,messages,content) {
    const committed=[...stableHistory(messages),{role:'assistant',content}];
    await session.done;
    await session.seal(committed,historyIdentity(committed));
    const previous=this.idle.get(session.sessionId);
    if (previous && previous!==session) await previous.dispose();
    this.idle.set(session.sessionId,session);
    session.idleTimer=setTimeout(()=>{
      if (this.idle.get(session.sessionId)===session) this.idle.delete(session.sessionId);
      void session.dispose();
    },this.timeoutMs);
    session.idleTimer.unref?.();
    while (this.idle.size>8) {
      const oldest=this.idle.entries().next().value;
      this.idle.delete(oldest[0]);await oldest[1].dispose();
    }
  }
  async *stream(input) {
    const request={...input,messages:input.messages??[]};
    this.check(request.apiKey,request.signal);
    if (request.system!==undefined&&typeof request.system!=='string') throw new ProviderError('INVALID_SYSTEM_PROMPT','System prompt must be a string');
    const session=await this.acquire(request);
    session.busy=true;
    const cancel=()=>session.controller.abort();
    request.signal?.addEventListener('abort',cancel,{once:true});
    const content=[];
    let handedOff=false,done=false;
    try {
      for (;;) {
        const event=await bounded(()=>session.take(),{signal:session.controller.signal,timeoutMs:this.timeoutMs});
        if (event.type==='failure') throw event.error;
        if (event.type==='done') {done=session.completed;break;}
        if (['text','reasoning'].includes(event.type)&&event.text) {
          const last=content.at(-1);
          if (last?.type===event.type) last.text+=event.text;
          else content.push({type:event.type,text:event.text});
        } else if (event.type==='tool-call') content.push({...event});
        yield event;
        if (event.type!=='tool-call') continue;
        const calls=[event];
        while (session.queue[0]?.type==='tool-call') {
          const call=session.queue.shift();calls.push(call);yield call;
        }
        session.pendingCalls=calls;
        session.prefix=stableHistory(request.messages);
        session.prefixHash=historyIdentity(session.prefix);
        session.token=randomUUID();
        this.continuations.set(session.token,session);
        handedOff=true;
        yield {type:'continuation',token:session.token};
        break;
      }
    } catch(error) {
      if (session.timedOut) throw new ProviderError('TIMEOUT','Cursor call timed out');
      throw error;
    } finally {
      session.busy=false;
      if (handedOff) session.detach=()=>request.signal?.removeEventListener('abort',cancel);
      else {
        request.signal?.removeEventListener('abort',cancel);
        const reusable=done&&!session.historyPruned&&!this.closed&&request.sessionId&&!request.purpose&&
          content.length&&!session.controller.signal.aborted;
        if (reusable) await this.cache(session,request.messages,content);
        else {
          session.controller.abort();
          await session.done;await session.dispose();
        }
      }
    }
  }
  async close() {
    this.closed=true;
    this.catalogs.clear();this.idle.clear();
    const sessions=Array.from(this.sessions);
    for (const session of sessions) {session.bridge.close();session.controller.abort();}
    await Promise.all(sessions.map(async session=>{await session.done;await session.dispose();}));
    for (const session of this.continuations.values()) clearTimeout(session.recoveryTimer);
    this.continuations.clear();
  }
}
