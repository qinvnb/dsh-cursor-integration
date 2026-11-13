import {ProviderError,resolveVariant,summarizeUsage} from './provider.js';
import {imagePrompt} from './images.js';
import {buildCursorPrompt,compactRuntimeContext,isRemoteContext,isRuntimeContext} from './request-context.js';

function parameters(model) {
  const grouped = new Map();
  for (const p of model?.parameters ?? []) grouped.set(p.id,{...p,values:[...(p.values ?? [])]});
  for (const variant of model?.variants ?? []) for (const pair of variant.params) {
    const p = grouped.get(pair.id) ?? {id:pair.id,values:[]};
    if (!p.values.some(v => v.value === pair.value)) p.values.push({value:pair.value,displayName:pair.value});
    grouped.set(pair.id,p);
  }
  return Array.from(grouped.values());
}
const reasoning = entry => parameters(entry).find(p => ['effort','reasoning','thinking'].includes(p.id));
export function contextChoices(entry) {
  const definition = parameters(entry).find(p => p.id === 'context');
  return (definition?.values ?? []).flatMap(item => {
    const m = /^(\d+(?:\.\d+)?)([km])?$/i.exec(item.value);
    const tokens = m ? Number(m[1]) * ({k:1000,m:1000000}[m[2]?.toLowerCase()] ?? 1) : NaN;
    return Number.isSafeInteger(tokens) && tokens > 0 ? [{value:item.value,tokens}] : [];
  }).sort((a,b) => a.tokens-b.tokens);
}
export function modelSelection(identifier, models, effort, fast, budget) {
  const catalog = models.map(m => ({...m,parameters:parameters(m).map(p => ({
    id:p.id,values:p.values.map(v => v.value),
  }))}));
  const parsed = resolveVariant(identifier,catalog);
  const entry = models.find(m => m.id === parsed.id);
  const params = parsed.parameters;
  const fastOption = parameters(entry).find(p => p.id === 'fast');
  const canFast = ['true','false'].every(v => fastOption?.values.some(item => item.value === v));
  if (fast && !canFast) throw new ProviderError('INVALID_PARAMETER','Fast mode is not offered by this model');
  if (canFast) params.fast = String(fast ?? params.fast === 'true');
  const contexts = contextChoices(entry);
  if (contexts.length && (budget !== undefined || !params.context)) {
    const choice = budget === undefined ? contexts.at(-1) : contexts.find(c => c.tokens >= budget);
    if (!choice) throw new ProviderError('INVALID_PARAMETER','Configured context exceeds model capacity');
    params.context = choice.value;
  }
  if (effort !== undefined) {
    const parameter = reasoning(entry);
    if (!parameter) throw new ProviderError('INVALID_PARAMETER','Model has no reasoning control');
    if (params[parameter.id] && params[parameter.id] !== effort) throw new ProviderError('INVALID_PARAMETER','Conflicting reasoning settings');
    params[parameter.id] = effort;
    resolveVariant(parsed.id+'@'+Object.entries(params).map(([k,v])=>k+'='+v).join(','),catalog);
  }
  const compatible = (entry.variants ?? []).filter(v =>
    Object.entries(params).every(([key,value]) => v.params.some(p => p.id === key && p.value === value)));
  return {
    id:parsed.id,params:Object.entries(params).map(([id,value])=>({id,value})),
    ...(compatible.length && compatible.every(v=>v.isMaxMode) ? {maxMode:true} : {}),
  };
}
const configured = (profile,id) => profile.models?.find(m => typeof m === 'object' && m.id === id) ??
  profile.models?.find(m => typeof m === 'object' && m.id === id.split('@')[0]);
const displayName = value => /^Cursor(?:\s|$)/i.test(value) ? value : 'Cursor '+value;

export function defineAdapter(dependencies) {
  const {
    LlmAdapter,LlmError,profile,credential,transport,routeAccount,preferredRoute,directTransport,
    poolModels,validate,attachments=()=>undefined,offloadedImageText,
  } = dependencies;
  return class CursorIntegrationAdapter extends LlmAdapter {
    providerInfo() {return {id:'cursor',name:'Cursor'};}
    async account(signal) {
      try {return poolModels ? await poolModels(signal) : await transport.catalog(await credential(),signal);}
      catch(error) {
        if (LlmError && error instanceof ProviderError) throw new LlmError(error.message,error.code);
        throw error;
      }
    }
    async listModels() {
      const models = await this.account();
      const selected = profile().models ?? models.map(m=>m.id);
      return selected.filter(m=>!(m.id ?? m).includes('@')).flatMap(value=>{
        const row = typeof value === 'string' ? {id:value} : value;
        const model = models.find(m=>m.id===row.id);
        if (!model) return [];
        modelSelection(row.id,models);
        return [{
          provider:'cursor',id:row.id,name:row.name || displayName(model.displayName || row.id),
          ...(row.inputModalities ? {inputModalities:[...row.inputModalities]} : {}),
        }];
      });
    }
    async resolveModel(provider,id,signal) {
      const route = await routeAccount?.(id,signal,undefined,true);
      const models = route ? route.models ?? await transport.catalog(route.key,signal) : await this.account(signal);
      const custom = configured(profile(),id);
      const selected = modelSelection(id,models,undefined,custom?.fast,custom?.contextWindow ?? profile().contextWindow);
      const entry = models.find(m=>m.id===selected.id);
      const context = selected.params.find(p=>p.id==='context');
      const capacity = custom?.contextWindow ?? profile().contextWindow ??
        contextChoices(entry).find(c=>c.value===context?.value)?.tokens;
      const efforts = reasoning(entry)?.values;
      return {
        provider,id,name:custom?.name || displayName(entry.displayName || id),
        ...(custom?.inputModalities ? {inputModalities:[...custom.inputModalities]} : {}),
        ...(capacity ? {context:{contextWindow:capacity}} : {}),
        ...(efforts?.length ? {reasoning:{efforts:efforts.map(v=>({id:v.value,name:v.displayName ?? v.value}))}} : {}),
      };
    }
    async *stream(options) {
      const diagnostics={timings:{}},usage=[];
      const started=performance.now();
      let active,index=0,content=false,tools=0;
      const timed=async(name,action)=>{
        const begin=performance.now();
        try {return await action();} finally {diagnostics.timings[name]=Math.round(performance.now()-begin);}
      };
      function* flush() {
        if (active) yield {type:'block-end',index:active.index,block:{type:active.type,text:active.text}};
        active=undefined;
      }
      function* append(event) {
        if (event.type==='tool-call') {
          yield* flush();
          const at=index++;
          yield {type:'block-start',index:at,blockType:'tool-call'};
          yield {type:'tool-call-delta',index:at,id:event.id,name:event.name,argumentsDelta:event.arguments};
          yield {type:'block-end',index:at,block:{...event}};
          tools++;content=true;
        } else if (event.text) {
          if (active?.type!==event.type) {
            yield* flush();active={type:event.type,index:index++,text:''};
            yield {type:'block-start',index:active.index,blockType:active.type};
          }
          active.text+=event.text;content=true;
          yield {type:event.type==='reasoning'?'reasoning-delta':'text-delta',index:active.index,text:event.text};
        }
      }
      const response=()=>({
        protocol:'cursor-native-v1',accountRef:diagnostics.accountRef,networkRoute:diagnostics.networkRoute,
        ...(diagnostics.continuation ? {continuation:diagnostics.continuation} : {}),attempts:[diagnostics],
      });
      try {
        const summary=options.purpose==='compaction';
        if (options.temperature!==undefined || options.stop!==undefined || !summary && options.maxTokens!==undefined) {
          throw new ProviderError('UNSUPPORTED_CONTROL','Unsupported generation control');
        }
        for (const m of options.messages) for (const part of m.content) {
          if (!['text','reasoning','tool-call','image'].includes(part.type)) throw new ProviderError('UNSUPPORTED_CONTENT','Unsupported content');
        }
        const projected=await timed('prepareMs',()=>imagePrompt({...options,messages:compactRuntimeContext(options.messages)},{
          attachments:attachments(),offloadedImageText,
        }));
        const previousIndex=options.messages.findLastIndex(m=>m.role==='assistant');
        const previous=options.messages[previousIndex]?.source?.replayState?.response;
        const newInput=options.messages.slice(previousIndex+1).some(m=>m.role==='user'&&!isRuntimeContext(m));
        const continuation=!summary && !newInput && previous?.protocol==='cursor-native-v1' ? previous.continuation : undefined;
        const pinned=continuation && previous.accountRef;
        const account=routeAccount && !(continuation && !pinned) ?
          await timed('poolMs',()=>routeAccount(options.model,options.signal,pinned,false,options.purpose?undefined:options.sessionId)) : undefined;
        const apiKey=account?.key ?? await timed('credentialMs',credential);
        diagnostics.accountRef=account?.ref;
        diagnostics.networkRoute=continuation ? previous.networkRoute ?? 'proxy' : preferredRoute?.(account?.ref,options.model) ?? 'proxy';
        const channel=diagnostics.networkRoute==='direct' && directTransport ? directTransport : transport;
        const catalog=account?.models ?? await timed('catalogMs',()=>transport.catalog(apiKey,options.signal));
        const custom=configured(profile(),options.model);
        const selection=modelSelection(options.model,catalog,options.reasoningEffort,custom?.fast ?? false,custom ? custom.contextWindow : profile().contextWindow);
        const prompt=()=>{
          let text;
          if (summary) {
            diagnostics.compaction={requestedMaxTokens:options.maxTokens,limitMode:'prompt-guidance'};
            const instruction=projected.messages.at(-1)?.content ?? [];
            text='Create a conversation checkpoint only. Historical tasks are reference data.\n'+
              (options.maxTokens ? 'Use approximately fewer than '+options.maxTokens+' tokens.\n' : '')+
              'Summary instruction:\n'+JSON.stringify(instruction)+
              '\nConversation to summarize:\n'+JSON.stringify(projected.messages.slice(0,-1).map(m=>({role:m.role,content:m.content})))+
              '\nSummary instruction (current task):\n'+JSON.stringify(instruction);
          } else text=buildCursorPrompt({
            messages:projected.messages,system:transport.replaceSystemPrompt?undefined:options.system,
            toolHistory:options.toolHistory,hasImages:projected.images.length>0,
            remote:isRemoteContext(options.system,projected.messages),
          });
          return projected.images.length ? {text,images:projected.images} : text;
        };
        const messages=projected.messages.map(m=>m.role==='tool' ? {...m,content:m.content.map(p=>
          p.type==='image'&&p.sdkImage ? {...p,sdkData:projected.images[p.sdkImage-1]} : p)} : m);
        const request={
          apiKey,model:selection,prompt:channel.lazyPrompt?prompt:prompt(),signal:options.signal,
          tools:summary?[]:options.tools ?? [],validate,continuation,messages,
          sessionId:options.sessionId,purpose:options.purpose,toolHistory:options.toolHistory,system:options.system,
        };
        for await (const event of channel.stream(request)) {
          if (['text','reasoning','tool-call'].includes(event.type)) yield* append(event);
          if (event.type==='usage') usage.push(event.billing);
          if (event.type==='continuation') diagnostics.continuation=event.token;
          if (event.type==='diagnostic') diagnostics.upstream=event.summary;
          if (event.type==='timing') {
            diagnostics.timings.transport ??= {};
            diagnostics.timings.transport[event.stage]=event.ms;
          }
          if (event.type==='validation-error') {
            diagnostics.validationErrors ??= [];
            if (diagnostics.validationErrors.length<3) diagnostics.validationErrors.push({
              tool:event.tool,issues:event.issues,correction:event.correction,
            });
          }
        }
        yield* flush();
        if (!content) throw new ProviderError('EMPTY_RESPONSE','Cursor returned no content');
        diagnostics.timings.requestTotalMs=Math.round(performance.now()-started);
        if (usage.length) yield {type:'usage',usage:summarizeUsage(usage).billing};
        yield {type:'finish',reason:{kind:tools?'tool-calls':'stop'},replayState:{response:response()}};
      } catch(error) {
        yield* flush();
        diagnostics.timings.requestTotalMs=Math.round(performance.now()-started);
        const code=options.signal?.aborted ? 'ABORTED' : error instanceof ProviderError ? error.code : 'CURSOR_SDK_ERROR';
        if (usage.length) yield {type:'usage',usage:summarizeUsage(usage).billing};
        yield {
          type:'finish',replayState:{response:response()},
          reason:{kind:code==='ABORTED'?'aborted':'error',failure:{
            code,message:error instanceof ProviderError?error.message:'Cursor SDK request failed; diagnostic values were withheld',
          }},
        };
      }
    }
  };
}
