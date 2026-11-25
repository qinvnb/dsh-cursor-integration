import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bounded,ProviderError,summarizeUsage} from './provider.js';
import {NativeBridge,bridgeIdentity,stableHistory} from './native.js';
import {newDirectory,publish,finishTurn,beginTurn,releaseCompleted,removeDirectory} from './checkpoints.js';
import {sdkOutputReader} from './tool-output.js';
import {isRemoteContext,buildCursorPrompt,latestRuntimeContext} from './request-context.js';
import {sdkCreateDiagnostic,describeNetworkFailure,describeRunFailure} from './network.js';
import {normalizeSdkUsage} from './usage/normalize.js';

export class RuntimeSession {
  constructor(transport,request,{saved,workspace,reason}={}) {
    this.transport=transport;
    this.request=request;
    this.saved=saved;
    this.workspace=workspace;
    this.reason=reason;
    this.sessionId=request.sessionId;
    this.identity=bridgeIdentity(request);
    this.controller=new AbortController();
    this.bridge=new NativeBridge(request.tools??[],request.validate,event=>this.emit(event));
    this.queue=[];
    this.pendingCalls=[];
    this.closed=false;
    this.completed=false;
    this.ended=false;
    this.consecutiveRetries=0;
    this.retryWindowStartedAt=undefined;
    this.retryBudgetTimer=undefined;
    this.retryBudgetExceeded=false;
    this.controller.signal.addEventListener('abort',()=>this.bridge.close(),{once:true});
    this.done=Promise.resolve();
  }
  path(text) {
    if (!this.request.purpose) this.transport.onPath(this.sessionId,text);
    this.emit({type:'path',label:text});
  }
  emit(event) {
    if (event.type==='tool-call') {
      this.resetRetryBudget();
      this.activity();
    }
    this.queue.push(event);
    this.wake?.();
    this.wake=undefined;
  }
  async take() {
    while (!this.queue.length) await new Promise(resolve=>{this.wake=resolve;});
    return this.queue.shift();
  }
  options() {return {signal:this.controller.signal,timeoutMs:this.transport.timeoutMs};}
  bindSignal(signal) {
    this.detach?.();
    if(!signal){this.detach=undefined;return;}
    const cancel=()=>this.controller.abort();
    signal.addEventListener('abort',cancel,{once:true});
    this.detach=()=>signal.removeEventListener('abort',cancel);
    if(signal.aborted)cancel();
  }
  reportUsage(sample) {
    try {this.emit({type:'usage',...summarizeUsage([normalizeSdkUsage(sample)])});}
    catch {this.emit({type:'usage-unavailable'});}
  }
  activity() {
    clearTimeout(this.watchdog);
    this.watchdog=undefined;
    // DSH owns tool execution and its cancellation. Waiting for a host tool is not SDK inactivity.
    if (this.closed || this.controller.signal.aborted || this.bridge.pending.size) return;
    this.watchdog=setTimeout(()=>{
      this.timedOut=true;
      this.controller.abort();
    },this.transport.timeoutMs);
  }
  resetRetryBudget() {
    this.consecutiveRetries=0;
    this.retryWindowStartedAt=undefined;
    clearTimeout(this.retryBudgetTimer);
    this.retryBudgetTimer=undefined;
  }
  tripRetryBudget() {
    if (this.closed || this.controller.signal.aborted) return;
    this.retryBudgetExceeded=true;
    clearTimeout(this.retryBudgetTimer);
    this.retryBudgetTimer=undefined;
    this.path('自动重连超时止损');
    this.controller.abort();
  }
  onSdkRetry() {
    if (this.closed || this.controller.signal.aborted) return;
    this.consecutiveRetries++;
    this.path('连接波动，正在第 '+this.consecutiveRetries+' 次自动重连…');
    const limit=this.transport.maxConsecutiveSdkRetries;
    if (Number.isFinite(limit)&&limit>0&&this.consecutiveRetries>limit) {
      this.tripRetryBudget();
      return;
    }
    const windowMs=this.transport.maxRetryWindowMs;
    if (this.retryWindowStartedAt===undefined&&Number.isFinite(windowMs)&&windowMs>0) {
      this.retryWindowStartedAt=this.transport.now();
      this.retryBudgetTimer=setTimeout(()=>this.tripRetryBudget(),windowMs);
      this.retryBudgetTimer.unref?.();
    }
  }
  onSdkResponseHeaders(http,grpc) {
    if (this.closed || this.controller.signal.aborted) return;
    if (!Number.isInteger(http) || http < 200 || http >= 300) return;
    if (grpc !== undefined && grpc !== 0) return;
    clearTimeout(this.retryBudgetTimer);
    this.retryBudgetTimer=undefined;
    this.retryWindowStartedAt=undefined;
    if (this.consecutiveRetries>0) this.path('已重新建立连接，等待模型响应…');
  }
  async allocate() {
    if (this.transport.checkpointRoot && this.sessionId && !this.request.purpose) {
      try {
        this.directory=await newDirectory(this.transport.checkpointRoot,this.sessionId);
        this.persistent=true;
        return;
      } catch {}
    }
    this.directory=await mkdtemp(join(tmpdir(),'dsh-integration-'));
    this.persistent=false;
  }
  sdkOptions(sdk) {
    const r=this.request;
    return {
      apiKey:r.apiKey,model:r.model,
      ...(this.transport.replaceSystemPrompt ? {systemPrompt:r.system?.trim() || 'You are an AI assistant.'} : {}),
      tools:this.bridge.tools.length?['mcp']:[],mcpServers:{},
      local:{
        cwd:this.directory,settingSources:[],customTools:this.bridge.customTools,
        enableAgentRetries:Boolean(this.transport.enableAgentRetries ||
          (this.transport.networkRoute==='proxy' && r.purpose==='compaction')),
        store:new sdk.JsonlLocalAgentStore(join(this.directory,'state')),
      },
    };
  }
  async connect(timing) {
    if (this.agent) return;
    if (this.saved) {
      this.directory=this.saved.directory;
      this.persistent=true;
      this.checkpoint=this.saved.metadata;
    } else await this.allocate();
    let start=performance.now();
    const sdk=await bounded(this.transport.loadSDK,this.options());
    timing('sdkLoadMs',start);
    start=performance.now();
    if (this.saved) {
      this.path('正在恢复检查点');
      try {
        this.agent=await bounded(()=>sdk.Agent.resume(this.saved.agentId,this.sdkOptions(sdk)),{
          ...this.options(),lateCleanup:agent=>agent[Symbol.asyncDispose](),
        });
      } catch(error) {
        if (this.controller.signal.aborted || error instanceof ProviderError) {
          this.checkpoint=undefined;
          throw error;
        }
        const facts=sdkCreateDiagnostic(error);
        const transient=facts.some(value=>value==='HTTP 429'||value==='RateLimitError'||/^HTTP 5/.test(value)) ||
          describeNetworkFailure(error,'Cursor Agent.resume');
        if (transient) {
          this.path('恢复暂时失败，检查点已保留');
          throw new ProviderError(facts.includes('HTTP 429')?'CURSOR_RATE_LIMITED':'CURSOR_RESUME_FAILED',
            'Cursor Agent.resume failed ('+facts.join(', ')+')');
        }
        this.checkpoint=undefined;
        this.reason='SDK 无法恢复原检查点';
        await removeDirectory(this.directory,this.transport.onCleanupDeferred);
        await this.allocate();
      }
      if (this.agent) {
        this.checkpoint=undefined;
        this.path('已从检查点恢复');
        this.prompt=this.incremental(stableHistory(this.request.messages).slice(this.saved.committedLength),true);
        timing('sdkResumeMs',start);
      }
    }
    if (isRemoteContext(this.request.system,this.request.messages)) this.bridge.readSdkOutput=sdkOutputReader(this.directory);
    if (this.agent) return;
    const rebuilding=this.sessionId && !this.request.purpose &&
      this.request.messages.some(m=>['assistant','tool'].includes(m.role));
    this.path(rebuilding?'正在重建 · '+this.reason:'正在新建会话');
    const directory=this.directory;
    try {
      this.agent=await bounded(()=>sdk.Agent.create(this.sdkOptions(sdk)),{
        ...this.options(),lateCleanup:async agent=>{
          await agent[Symbol.asyncDispose]();
          await removeDirectory(directory,this.transport.onCleanupDeferred);
        },
      });
    } catch(error) {
      if (error instanceof ProviderError || this.controller.signal.aborted) throw error;
      const facts=sdkCreateDiagnostic(error);
      this.path((rebuilding?'重建失败 · ':'新建失败 · ')+facts.join(', '));
      throw Object.assign(new ProviderError(facts.includes('HTTP 429')?'CURSOR_RATE_LIMITED':
        describeNetworkFailure(error,'Cursor Agent.create')?.code ?? 'CURSOR_SDK_ERROR',
      'Cursor Agent.create failed ('+facts.join(', ')+')'), {cause:error});
    }
    timing('sdkCreateMs',start);
    this.path(rebuilding?'本轮按历史重建 · '+this.reason:'本轮新建会话');
  }
  incremental(messages,stable=false) {
    const suffix=stable?stableHistory(messages):messages;
    return buildCursorPrompt({
      messages:[...suffix,...latestRuntimeContext(this.request.messages)],
      remote:isRemoteContext(this.request.system,this.request.messages),append:true,
    });
  }
  async activate(request,suffix) {
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer=undefined;
    if (this.marker) {
      await beginTurn(this.directory,this.marker);
      this.marker=undefined;
    }
    this.transport.check(request.apiKey,request.signal);
    this.bindSignal(request.signal);
    this.checkpoint=undefined;
    this.request=request;
    this.queue=[];
    this.token=undefined;
    this.prompt=this.incremental(suffix);
    this.path('复用当前会话');
    this.launch();
  }
  launch() {
    this.ended=false;
    this.completed=false;
    this.retryBudgetExceeded=false;
    this.resetRetryBudget();
    this.bridge.beginRun();
    const diagnostics=this.transport.requestDiagnostics;
    const produce=turn=>this.transport.networkScope(()=>this.produce(turn));
    const hooks={onRetry:()=>this.onSdkRetry(),onResponseHeaders:(http,grpc)=>this.onSdkResponseHeaders(http,grpc)};
    this.done=(diagnostics ? diagnostics.run(this.sessionId,this.transport.networkRoute,produce,this.transport.agentHttpProtocol,hooks) : produce()).finally(()=>{
      clearTimeout(this.watchdog);
      this.resetRetryBudget();
      this.detach?.();
    });
    // The host can be running a long tool before it awaits this producer again.
    void this.done.catch(()=>{});
  }
  async produce(diagnostics) {
    const start=performance.now(),counts={},timings={};
    let run,reported=false,phase='connect',result;
    const timing=(stage,since)=>{
      const ms=Math.round(performance.now()-since);
      timings[stage]=ms;this.emit({type:'timing',stage,ms});
    };
    this.activity();
    try {
      await this.connect(timing);
      this.bridge.rememberRuntimeContext(this.request.messages);
      const prompt=this.prompt ?? (typeof this.request.prompt==='function'?this.request.prompt():this.request.prompt);
      let stage=performance.now();
      phase='send';
      run=await bounded(()=>this.agent.send(prompt),{
        ...this.options(),lateCleanup:late=>late.supports('cancel')?late.cancel():undefined,
      });
      timing('sdkSendMs',stage);
      phase='stream';
      this.activity();
      const stream=run.stream();
      let first=false,content=false;
      for (;;) {
        const next=await bounded(()=>stream.next(),{signal:this.controller.signal,timeoutMs:null});
        this.activity();
        if (next.done) break;
        const event=next.value;
        if (!first) {timing('firstSDKEventMs',start);first=true;}
        const visible=event.type==='thinking'&&event.text ||
          event.type==='assistant'&&event.message.content.some(part=>part.type==='text'&&part.text);
        if (visible || event.type==='tool_call') this.resetRetryBudget();
        if (!content && visible) {
          content=true;timing('firstContentMs',start);
          diagnostics?.record('first_content', { ms: timings.firstContentMs });
        }
        const kind=['assistant','thinking','usage','tool_call','system','status','user'].includes(event.type)?event.type:'other';
        counts[kind]=(counts[kind]??0)+1;
        const names=event.type==='tool_call'?[event.name]:event.type==='assistant'?
          event.message.content.filter(part=>part.type==='tool_use').map(part=>part.name):[];
        for (const name of names) {
          const allowed=this.bridge.tools.length && typeof name==='string' &&
            (name==='mcp'||Object.keys(this.bridge.customTools).some(alias=>
              name===alias||name==='custom-user-tools-'+alias||name.endsWith('__'+alias)));
          if (!allowed) throw new ProviderError('NATIVE_TOOL_BLOCKED','SDK requested an unregistered native tool channel');
        }
        if (event.type==='thinking') this.emit({type:'reasoning',text:event.text});
        if (event.type==='assistant') for (const part of event.message.content) {
          if (part.type==='text') this.emit({type:'text',text:part.text});
        }
        if (event.type==='usage') {
          reported=true;
          this.reportUsage(event.usage);
        }
      }
      phase='wait';
      result=await bounded(()=>run.wait(),this.options());
      this.emit({type:'diagnostic',summary:{
        status:['finished','cancelled','error'].includes(result.status)?result.status:'unknown',
        eventCounts:counts,timings:{...timings,runWallMs:Math.round(performance.now()-start)},
      }});
      if (!reported && result.usage) this.reportUsage(result.usage);
      if (result.status!=='finished') throw describeRunFailure(result.error,result.status);
      this.completed=true;
      diagnostics?.result('finished',phase,run,result);
    } catch(error) {
      this.emit({type:'diagnostic',summary:{
        status:this.retryBudgetExceeded?'error':this.controller.signal.aborted?'cancelled':'error',eventCounts:counts,
        timings:{...timings,runWallMs:Math.round(performance.now()-start)},
      }});
      const failure=this.retryBudgetExceeded
        ? new ProviderError('CURSOR_RETRY_EXHAUSTED','Cursor auto-reconnect stopped after reaching the retry budget without progress.',['retry_budget_exceeded'])
        : this.timedOut?new ProviderError('TIMEOUT','Cursor call timed out'):
          describeNetworkFailure(error,'Cursor model request')??error;
      diagnostics?.result(this.retryBudgetExceeded?'error':this.timedOut?'timeout':this.controller.signal.aborted?'cancelled':'error',phase,run,result,failure,error);
      this.emit({type:'failure',error:failure});
    } finally {
      clearTimeout(this.watchdog);
      this.resetRetryBudget();
      this.ended=true;
      this.detach?.();
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer=undefined;
      const token=this.token;
      if (token && this.transport.continuations.get(token)===this) {
        this.recoveryTimer=setTimeout(()=>this.transport.expire(token),this.transport.timeoutMs);
        this.recoveryTimer.unref?.();
      }
      if (!this.completed) {
        try {
          if (run?.supports?.('cancel')&&run.status==='running') await bounded(()=>run.cancel(),{timeoutMs:5000});
        } catch {}
        await this.dispose();
      }
      this.emit({type:'done'});
    }
  }
  async seal(committed,fingerprint) {
    this.committedLength=committed.length;
    this.committed=fingerprint;
    if (!this.persistent || !this.agent?.agentId) return;
    this.checkpoint={
      agentId:this.agent.agentId,identity:this.identity,workspace:this.workspace,
      committedLength:committed.length,committed:fingerprint,
    };
    this.sealing=finishTurn(this.directory,this.checkpoint).then(marker=>{this.marker=marker;}).catch(()=>{});
    await this.sealing;
  }
  async dispose() {
    if (this.disposing) return this.disposing;
    this.disposing=(async()=>{
      clearTimeout(this.watchdog);clearTimeout(this.idleTimer);clearTimeout(this.recoveryTimer);this.resetRetryBudget();
      this.bridge.close();
      try {
        if (this.agent) await bounded(()=>this.agent[Symbol.asyncDispose](),{timeoutMs:5000});
      } catch {}
      await this.sealing;
      let retained=false;
      if (this.directory && this.checkpoint) {
        if (this.marker) {
          retained=true;
          await releaseCompleted(this.directory,this.marker).catch(()=>{});
        } else {
          try {await publish(this.directory,this.checkpoint);retained=true;} catch {}
        }
      }
      if (this.directory && !retained) await removeDirectory(this.directory,this.transport.onCleanupDeferred);
      this.closed=true;
      this.transport.retire(this);
    })();
    return this.disposing;
  }
}
