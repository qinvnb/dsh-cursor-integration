import {apply as mountUsage,inject as usageInject} from '../usage-entry.js';
import {mountSettings} from './settings.js';
import {mountContext} from './context.js';
export const inject=Array.from(new Set([...usageInject,'remote.credentials','remote.llm']));
export async function apply(ctx) {
  mountSettings(ctx);
  mountContext(ctx);
  await mountUsage(ctx);
}
