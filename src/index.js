import z from '@deepseek-ai/schemastery';
import Ajv from 'ajv';
import {z as jsonSchema} from 'zod';
import {LlmAdapter,LlmError,offloadedImageText} from '@deepseek-ai/dsh-llm';
import {estimateToolsTokens} from '@deepseek-ai/dsh-token-meter/estimate';
import {createToolValidator} from './validation.js';
import {CursorTransport} from './transport.js';
import {defineAdapter,contextChoices} from './adapter.js';
import {ProviderError} from './provider.js';
import {createCursorProxy} from './proxy.js';
import {createPool} from './pool.js';
import {createAccountsReader} from './usage/accounts.js';
import {createAccountReader} from './usage/account.js';
import {mountUsage} from './usage/service.js';
import {createRouteChecks} from './route-check.js';
import {loadRoutes,saveRoutes,loadDefaults,saveDefaults} from './route-storage.js';
import {checkpointRoot,sweep} from './checkpoints.js';
import {installCursorContextMeter,createCursorContextRoute,createCompactionStatus} from './context.js';

export const name='cursor-integration';
export const inject=['llm','credentials'];

const modelConfig=z.object({
  id:z.string().required(),name:z.string(),
  inputModalities:z.array(z.union([z.const('text'),z.const('image')])).min(1).default(undefined),
  contextWindow:z.number().step(1).min(1),fast:z.boolean(),fastNameAuto:z.boolean(),
});
const accountConfig=z.object({
  label:z.string().required(),apiKeyEnv:z.string().role('credential-ref').required(),configured:z.boolean(),
});
export const Config=z.object({
  proxyUrl:z.string(),
  providers:z.dict(z.object({
    apiKeyEnv:z.string().role('credential-ref'),accounts:z.array(accountConfig),
    usageRefreshMinutes:z.number().step(1).min(1).max(1440),
    displayName:z.string(),contextWindow:z.number().step(1).min(1),
    models:z.array(z.union([z.string(),modelConfig])),
  })).default({}).volatile(),
});

export function apply(ctx,config) {
  const profile=()=>config.providers.get().cursor??{};
  const paths=new Map();
  const onPath=(id,label)=>{
    if (!id) return;
    paths.delete(id);paths.set(id,label);
    if (paths.size>512) paths.delete(paths.keys().next().value);
  };
  const proxy=config.proxyUrl?createCursorProxy(config.proxyUrl):undefined;
  const onCleanupDeferred=code=>ctx.logger.warn('Checkpoint cleanup deferred ('+code+')');
  const transport=new CursorTransport({networkScope:proxy?.run,checkpointRoot,onPath,onCleanupDeferred});
  const direct=new CursorTransport({checkpointRoot,onPath,onCleanupDeferred});
  const resolve=async ref=>(await ctx.credentials.resolve(ref))?.value;
  const credential=async()=>{
    const ref=profile().apiKeyEnv;
    const key=ref&&await resolve(ref);
    if (!key) throw new ProviderError('MISSING_CREDENTIAL','在 Cursor 集成设置中保存 API Key');
    return key;
  };
  const accounts=createAccountsReader({
    describe:()=>[{ns:name,value:{providers:{cursor:profile()}}}],
    resolve:ref=>ctx.credentials.resolve(ref),createReader:createAccountReader,
    fallbackRef:'CURSOR_API_KEY',proxyUrl:config.proxyUrl,
  });
  const pool=createPool({
    accounts,resolve,loadDefaults,saveDefaults,interval:()=>profile().usageRefreshMinutes??5,
    catalog:(key,signal)=>transport.catalog(key,signal),
    onModelsChanged:()=>ctx.emit('llm/adapters-updated'),
  });
  const checks=createRouteChecks({
    proxyEnabled:Boolean(proxy),load:loadRoutes,save:saveRoutes,
    list:async signal=>{
      const all=await pool.models(signal);
      const selected=profile().models;
      return all.filter(model=>!selected||selected.some(row=>(row.id??row).split('@')[0]===model.id)).map(model=>model.id);
    },
    select:async(id,signal)=>{
      const route=await pool.route(id,signal,undefined,true);
      return {...route,label:accounts.list().find(row=>row.id===route.ref)?.label??'当前账号'};
    },
    probe:async(mode,id,account,signal)=>{
      const channel=mode==='direct'?direct:transport;
      const catalog=account.models??await channel.catalog(account.key,signal);
      let received=false;
      for await (const event of channel.stream({
        apiKey:account.key,model:(await import('./adapter.js')).modelSelection(id,catalog),
        prompt:'Reply OK.',messages:[],tools:[],signal,
      })) if (event.type==='text'&&event.text.trim()) received=true;
      if (!received) throw new ProviderError('EMPTY_RESPONSE','Model connectivity test returned no text');
    },
  });
  pool.start();
  const cleanup=()=>sweep(checkpointRoot).catch(()=>ctx.logger.warn('Checkpoint maintenance deferred'));
  void cleanup();
  const timer=setInterval(cleanup,21600000);
  timer.unref?.();
  ctx.effect(()=>async()=>{
    clearInterval(timer);
    checks.stop();pool.close();accounts.close();
    try {await Promise.all([transport.close(),direct.close()]);} finally {await proxy?.close();}
  });
  ctx.inject(['tokenMeter','sessionProjections'],child=>{
    child.effect(()=>installCursorContextMeter(child.tokenMeter,estimateToolsTokens));
    child.sessionProjections.register(createCursorContextRoute(jsonSchema));
    child.sessionProjections.register(createCompactionStatus(jsonSchema));
  });
  ctx.inject(['sessionQuery'],child=>mountUsage(child,accounts,pool,checks,paths));
  ctx.inject(['settings'],child=>child.effect(()=>child.settings.configure({auto:false},ctx.fiber)));
  const Adapter=defineAdapter({
    LlmAdapter,LlmError,transport,directTransport:direct,profile,credential,
    routeAccount:pool.route,preferredRoute:checks.preferred,poolModels:pool.models,
    validate:createToolValidator(Ajv),attachments:()=>ctx.get('attachments'),offloadedImageText,
  });
  ctx.llm.registerAdapter(['cursor'],new Adapter());
  const namespace=ctx.fiber.entry?.options.id??name;
  ctx.llm.registerModelDiscovery(namespace,async(request,signal)=>{
    if (request.provider&&request.provider!=='cursor') throw new LlmError('Only Cursor is available','INVALID_PROVIDER');
    if (request.baseURL) throw new LlmError('Cursor SDK uses its official endpoints','UNSUPPORTED_ENDPOINT');
    let catalog;
    try {catalog=await transport.catalog(request.apiKey||await credential(),signal,{refresh:true});}
    catch(error) {throw new LlmError(error.message,error.code??'CURSOR_CATALOG_FAILED');}
    return catalog.flatMap(model=>{
      const windows=contextChoices(model);
      const rows=[{id:model.id,name:model.displayName,...(windows.length?{contextWindow:windows.at(-1).tokens}:{})}];
      for (const window of windows) rows.push({id:model.id+'@context='+window.value,contextWindow:window.tokens});
      const fast=new Set([
        ...(model.parameters?.find(p=>p.id==='fast')?.values??[]).map(v=>v.value),
        ...(model.variants??[]).flatMap(v=>v.params.filter(p=>p.id==='fast').map(p=>p.value)),
      ]);
      if (fast.has('true')&&fast.has('false')) for (const value of ['false','true']) {
        rows.push({id:model.id+'@fast='+value,name:model.displayName+(value==='true'?' Fast':'')});
      }
      return rows;
    });
  });
}
