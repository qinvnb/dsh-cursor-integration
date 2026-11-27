import {existsSync,readFileSync,mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';import {homedir} from 'node:os';
import {sanitizeUsageCache} from './pool.js';
export {sanitizeUsageCache};
const dir=join(homedir(),'.dsh','storages','dsh-cursor-integration');
const file=join(dir,'model-routes-v1.json');
const usageCacheFile=join(dir,'usage-cache-v1.json');
const localUsageCacheFile=join(dir,'local-usage-cache-v1.json');
const safeInt=v=>Number.isSafeInteger(v)&&v>=0?v:null;
export function sanitizeLocalUsageCache(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||raw.version!==1)return null;
  if(!Number.isFinite(raw.updatedAt)||raw.updatedAt<=0)return null;
  if(!raw.sessions||typeof raw.sessions!=='object'||Array.isArray(raw.sessions))return null;
  const sessions={};
  for(const [id,entry] of Object.entries(raw.sessions)){
    if(typeof id!=='string'||!id||!entry||typeof entry!=='object'||Array.isArray(entry)||!Array.isArray(entry.calls))continue;
    const fp=typeof entry.fp==='string'&&entry.fp?entry.fp:null;
    const calls=[];
    for(const c of entry.calls){
      if(!c||typeof c!=='object'||Array.isArray(c)||!Number.isFinite(c.time))continue;
      const model=typeof c.model==='string'&&c.model?c.model:'unknown';
      if(c.kind==='retry'){calls.push({kind:'retry',time:c.time,model});continue;}
      let usage;
      if(c.usage&&typeof c.usage==='object'&&!Array.isArray(c.usage)){
        const inputTokens=safeInt(c.usage.inputTokens),outputTokens=safeInt(c.usage.outputTokens),
          cacheReadTokens=safeInt(c.usage.cacheReadTokens),cacheWriteTokens=safeInt(c.usage.cacheWriteTokens);
        if(inputTokens!==null&&outputTokens!==null&&cacheReadTokens!==null&&cacheWriteTokens!==null){
          usage={inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens};
        }
      }
      calls.push({
        time:c.time,model,failed:Boolean(c.failed),...(usage?{usage}:{}),
        uncalibrated:Boolean(c.uncalibrated),
        sdkSends:safeInt(c.sdkSends)??0,sdkCreates:safeInt(c.sdkCreates)??0,sdkResumes:safeInt(c.sdkResumes)??0,
      });
    }
    sessions[id]={fp,calls};
  }
  return {version:1,updatedAt:raw.updatedAt,sessions};
}
export function loadDefaults(){try{return JSON.parse(readFileSync(join(dir,'account-defaults.json'),'utf8'));}catch{return {};}}
export function saveDefaults(value){mkdirSync(dir,{recursive:true});const target=join(dir,'account-defaults.json');const tmp=target+'.'+process.pid+'.tmp';writeFileSync(tmp,JSON.stringify(value),{mode:0o600});renameSync(tmp,target);}
export function loadRoutes(){try{return existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};}catch{return {};}}
export function saveRoutes(value){mkdirSync(dir,{recursive:true});const tmp=file+'.'+process.pid+'.tmp';writeFileSync(tmp,JSON.stringify(value),{mode:0o600});renameSync(tmp,file);}
export function loadUsageCache(){try{return existsSync(usageCacheFile)?sanitizeUsageCache(JSON.parse(readFileSync(usageCacheFile,'utf8'))):null;}catch{return null;}}
export function saveUsageCache(value){const safe=sanitizeUsageCache(value);if(!safe)return;mkdirSync(dir,{recursive:true});const tmp=usageCacheFile+'.'+process.pid+'.tmp';writeFileSync(tmp,JSON.stringify(safe),{mode:0o600});renameSync(tmp,usageCacheFile);}
export function loadLocalUsageCache(){try{return existsSync(localUsageCacheFile)?sanitizeLocalUsageCache(JSON.parse(readFileSync(localUsageCacheFile,'utf8'))):null;}catch{return null;}}
export function saveLocalUsageCache(value){const safe=sanitizeLocalUsageCache(value);if(!safe)return;mkdirSync(dir,{recursive:true});const tmp=localUsageCacheFile+'.'+process.pid+'.tmp';writeFileSync(tmp,JSON.stringify(safe),{mode:0o600});renameSync(tmp,localUsageCacheFile);}
