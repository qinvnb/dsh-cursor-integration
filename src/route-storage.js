import {existsSync,readFileSync,mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';import {homedir} from 'node:os';
const dir=join(homedir(),'.dsh','storages','dsh-cursor-integration');
const file=join(dir,'model-routes-v1.json');
export function loadDefaults(){try{return JSON.parse(readFileSync(join(dir,'account-defaults.json'),'utf8'));}catch{return {};}}
export function saveDefaults(value){mkdirSync(dir,{recursive:true});const target=join(dir,'account-defaults.json');const tmp=target+'.'+process.pid+'.tmp';writeFileSync(tmp,JSON.stringify(value),{mode:0o600});renameSync(tmp,target);}
export function loadRoutes(){try{return existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};}catch{return {};}}
export function saveRoutes(value){mkdirSync(dir,{recursive:true});const tmp=file+'.'+process.pid+'.tmp';writeFileSync(tmp,JSON.stringify(value),{mode:0o600});renameSync(tmp,file);}
