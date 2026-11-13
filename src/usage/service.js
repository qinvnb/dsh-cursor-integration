import {TypertRemoteService,Remote} from '@deepseek-ai/dsh-typert-protocol';
import {createLocalReader} from './local.js';
export function mountUsage(ctx,accounts,pool,checks,paths) {
  const local = createLocalReader(ctx.sessionQuery);
  function displayState(){
    const {accounts:rows}=pool.view();
    return {keys:rows,defaults:pool.defaults(),fallback:pool.plannedRef('')??null,manual:pool.info().manual};
  }
  class UsageService extends TypertRemoteService {
    constructor() {super(ctx, 'cursorIntegrationUsage'); for (const initialize of initializers) initialize.call(this);}
    async getDisplayState(sessionId){return {...displayState(),sessionId,path:paths?.get(sessionId)??null,session:pool.session(sessionId)??null};}
    async getSnapshot() {
      const {accounts:rows,totals:overall}=pool.view();
      const selected=rows.find(row=>row.id===pool.active()) ?? rows.find(row=>row.active) ?? rows[0] ?? {account:null};
      const current={...selected,active:true};
      const stats = await local.get(current.account?.data);
      const {account,...active} = current;
      return {account, active, keys:rows, local:stats, pool:pool.info(), routes:Object.fromEntries(checks.status().rows.map(row=>[row.id,checks.preferred(pool.plannedRef(row.id),row.id)])), defaultRoute:checks.fallback, totals:overall};
    }
    async getAllSnapshots() {await pool.refresh();return {accounts:pool.view().accounts};}
    async getRouteChecks(){return checks.status();}
    async startRouteChecks(){return checks.start();}
    async stopRouteChecks(){return checks.stop();}
    async selectKey(id) {
      const keys=accounts.list();
      if(id !== '@auto' && !keys.some(row=>row.id===id)) return {ok:false};
      pool.choose(id==='@auto'?undefined:id);
      return {ok:true,active:keys.find(row=>row.id===pool.active())??null,keys};
    }
  }
  const initializers = [];
  for (const name of ['getDisplayState','getSnapshot','getAllSnapshots','selectKey','getRouteChecks','startRouteChecks','stopRouteChecks']) Remote(UsageService.prototype[name], {kind:'method', name, static:false, private:false,
    addInitializer(fn) {initializers.push(fn);}});
  new UsageService();
}
