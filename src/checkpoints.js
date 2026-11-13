import { createHash, randomUUID } from 'node:crypto';
import { mkdir, unlink, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const checkpointRoot = join(homedir(), '.dsh', 'storages', 'dsh-cursor-integration', 'checkpoints-v1');
const ttl = 7 * 86400000;
const generation = /^[a-f0-9]{32}-[a-f0-9-]{36}$/;
const ready = /^ready-(\d+)-[a-f0-9-]{36}\.json$/;
const completed = /^idle-(\d+)-(\d+)-[a-f0-9-]{36}\.json$/;
const owner = 'busy-' + process.pid;
const sessionPrefix = id => createHash('sha256').update(id).digest('hex').slice(0,32) + '-';

// Cleanup is a cache maintenance operation, never a reason to fail a turn.
export async function removeDirectory(directory,onDeferred=()=>{},remove=rm) {
  try {
    await remove(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});
    return true;
  } catch(error) {
    try {onDeferred(error?.code??'UNKNOWN');} catch {}
    return false;
  }
}

export async function newDirectory(root, id) {
  await mkdir(root,{recursive:true,mode:0o700});
  const directory = join(root,sessionPrefix(id)+randomUUID());
  await mkdir(directory,{mode:0o700});
  await writeFile(join(directory,owner),'',{mode:0o600});
  return directory;
}

// Publish only after the SDK has released its file handles.
export async function publish(directory, metadata) {
  const marker = join(directory,owner);
  await writeFile(marker,JSON.stringify(metadata),{mode:0o600});
  await rename(marker,join(directory,'ready-'+Date.now()+'-'+randomUUID()+'.json'));
}

// The marker name switches atomically only after a complete metadata write.
export async function finishTurn(directory, metadata) {
  const marker='idle-'+process.pid+'-'+Date.now()+'-'+randomUUID()+'.json';
  await writeFile(join(directory,owner),JSON.stringify(metadata),{mode:0o600});
  await rename(join(directory,owner),join(directory,marker));
  return marker;
}
export function beginTurn(directory, marker) {
  return rename(join(directory,marker),join(directory,owner));
}
export function releaseCompleted(directory, marker) {
  return rename(join(directory,marker),join(directory,marker.replace(/^idle-\d+-/,'ready-')));
}
function usableMarker(names) {
  for(const marker of names){
    const available=ready.exec(marker);
    if(available)return {marker,time:Number(available[1])};
    const sealed=completed.exec(marker);
    if(sealed && processGone(Number(sealed[1])))return {marker,time:Number(sealed[2])};
  }
}

async function entries(root, prefix='') {
  let list;
  try {list=await readdir(root,{withFileTypes:true});}
  catch(error){if(error.code==='ENOENT')return [];throw error;}
  return list.filter(e=>e.isDirectory()&&generation.test(e.name)&&e.name.startsWith(prefix)).map(e=>join(root,e.name));
}

// Windows can report success to two concurrent renames to the same destination.
async function acquire(directory){
  try{await writeFile(join(directory,'claim.lock'),String(process.pid),{flag:'wx',mode:0o600});return true;}
  catch{return false;}
}
async function release(directory){await unlink(join(directory,'claim.lock')).catch(()=>{});}

export async function claim(root, id, matches, miss=()=>{}) {
  for(const directory of await entries(root,sessionPrefix(id))) {
    const names=await readdir(directory).catch(()=>[]);
    const candidate=usableMarker(names);
    if(!candidate){miss('没有可领取的已完成检查点');continue;}
    const {marker,time}=candidate;
    if(Date.now()-time>ttl){miss('检查点已过期');continue;}
    if(!await acquire(directory))continue;
    try {
      const file=join(directory,marker);
      const data=JSON.parse(await readFile(file,'utf8'));
      if(typeof data.agentId!=='string'||!matches(data))continue;
      await rename(file,join(directory,owner));
      return {directory,agentId:data.agentId,committedLength:data.committedLength,metadata:data};
    } catch { /* An expired or concurrently claimed checkpoint is a cache miss. */ } finally {await release(directory);}
  }
}

function processGone(pid) {
  try {process.kill(pid,0);return false;} catch(error){return error.code==='ESRCH';}
}

export async function sweep(root) {
  const idle=[];
  for(const directory of await entries(root)){
    const names=await readdir(directory).catch(()=>[]);
    if(names.includes('claim.lock')){
      const pid=Number(await readFile(join(directory,'claim.lock'),'utf8').catch(()=>''));
      if(!Number.isSafeInteger(pid)||pid<1||!processGone(pid))continue;
      // A stale gate can be abandoned together with its generation. Never unlock
      // it for reuse while another cleaner might still be retiring it.
      await removeDirectory(directory);continue;
    }
    const available=usableMarker(names);
    if(available){idle.push({directory,...available});continue;}
    const busy=names.find(n=>/^busy-\d+$/.test(n));
    if(busy && processGone(Number(busy.slice(5)))) {
      // A crashed owner cannot publish this generation or replay pending tools.
      try{await rename(join(directory,busy),join(directory,owner));}catch{continue;}
      await removeDirectory(directory);
    }
  }
  let bytes=0, retained=0;
  const sorted=idle.sort((a,b)=>b.time-a.time);
  for(const {directory,marker,time} of sorted){
    let size=0;
    const state=join(directory,'state');
    for(const name of ['agents','runs','run_events','checkpoints']){
      size+=(await stat(join(state,name+'.ndjson')).catch(()=>null))?.size??0;
    }
    if(retained<32 && bytes+size<=1024**3 && Date.now()-time<=ttl){
      bytes+=size; retained++; continue;
    }
    if(!await acquire(directory))continue;
    try{await rename(join(directory,marker),join(directory,owner));}catch{await release(directory);continue;}
    try {await removeDirectory(directory);} finally {await release(directory);}
  }
}
