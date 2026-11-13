/** SDK turn totals are billing counters, never a prompt-size sample. */
export function installCursorContextMeter(meter, estimateToolsTokens) {
  const previous = Object.getOwnPropertyDescriptor(meter, 'measure');
  const original = meter.measure;
  function measure(session, requestHeader) {
    const result = original.call(this, session, requestHeader);
    const header = requestHeader ?? session.requestHeader();
    if (header?.config?.provider !== 'cursor') return result;
    const tokens = estimateToolsTokens(header) + result.surfaceTokens;
    if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error('Invalid Cursor context estimate');
    return Object.freeze({...result, baseline: Object.freeze({kind:'estimated',tokens}), surfaceDeltaTokens:0,totalTokens:tokens});
  }
  meter.measure = measure;
  // Cordis returns a fresh callable proxy on every method read. Inspect the
  // stored descriptor so disposal also works through a scoped service proxy.
  return () => {
    if (Object.getOwnPropertyDescriptor(meter, 'measure')?.value !== measure) return;
    if (previous) Object.defineProperty(meter, 'measure', previous);
    else delete meter.measure;
  };
}

/** Route facts only. Existing DSH contextBreakdown owns retained-history pricing. */
export function createCursorContextRoute(z) {
const schema = z.object({provider:z.string().nullable(),model:z.string().nullable(),contextWindow:z.number().positive().nullable(),accountRef:z.string().nullable().default(null),started:z.number().nullable().default(null)});
return {
  key:'cursorContextRoute', stateVersion:3, stateSchema:schema,
  init:()=>({provider:null,model:null,contextWindow:null,accountRef:null,started:null}),
  apply(state,event) {
    if(event.type==='request/header') {
      const config=event.data.header.config;
      if(config.provider===state.provider&&config.model===state.model)return state;
      return {...state,accountRef:null,provider:config.provider??null,model:config.model??null,contextWindow:null};
    }
    // The enclosing DSH session stream validates every projection as JSON.
    if(event.type==='turn/start' || event.type==='turn/end') return {...state,started:event.type==='turn/start'?event.time:null,accountRef:null};
    if(event.type==='assistant/message'||event.type==='assistant/attempt') {
      const finish=event.data.stream?.findLast(item=>item.chunk?.type==='finish')?.chunk;
      const ref=(finish?.replayState??event.data.message?.source?.replayState)?.response?.accountRef;
      if(typeof ref==='string')return {...state,accountRef:ref};
    }
    if(event.type==='request/context')return {...state,contextWindow:event.data.contextWindow??null};
    return state;
  },
  wire:{viewSchema:schema,view:state=>state},
};
}

/** Read actual session events so forked and reopened chats retain their status. */
export function createCompactionStatus(z) {
  const schema=z.object({
    status:z.enum(['idle','running','summarized','failed']).default('idle'),
    id:z.string().nullable().default(null),
    started:z.number().nullable().default(null),
    ended:z.number().nullable().default(null),
    summarized:z.number().nullable().default(null),
    pruned:z.number().nullable().default(null),
    prunedTokens:z.number().nullable().default(null),
    error:z.string().nullable().default(null),
  });
  return {
    key:'cursorCompactionStatus',stateVersion:1,stateSchema:schema,
    init:()=>schema.parse({}),
    apply(state,event) {
      const data=event.data??{};
      const time=Number.isFinite(event.time)?event.time:null;
      if(event.type==='compaction/start')return {...state,status:'running',id:data.compactionId??null,started:time,error:null};
      if(event.type==='compaction/summary')return {...state,status:'summarized',summarized:time,error:null};
      if(event.type==='compaction/prune')return {...state,pruned:time,prunedTokens:Number.isFinite(data.shadowedTokenCount)?data.shadowedTokenCount:null};
      if(event.type==='compaction/end' && data.compactionId===state.id){
        const raw=typeof data.error==='string'?data.error:'';
        const error=raw ? /temperature|maxTokens|stop controls/.test(raw)?'插件拒绝了压缩参数':
          /429|rate.?limit/i.test(raw)?'Cursor 限流':
          /timeout|timed out/i.test(raw)?'请求超时':
          /useful summary|shrink|above threshold/i.test(raw)?'摘要未达到压缩要求':'压缩请求失败，请查看会话错误' : null;
        return {...state,status:error?'failed':'summarized',ended:time,error};
      }
      return state;
    },
    wire:{viewSchema:schema,view:state=>state},
  };
}
