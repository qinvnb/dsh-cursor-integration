// The pinned SDK 1.0.40 reports inclusive prompt input. Keep DSH's four rails disjoint.
export const usageFormat='cursor-exclusive-v1';
export function normalizeSdkUsage(sample) {
  const fields=['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'];
  const out=Object.fromEntries(fields.map(key=>[key,sample[key]??0]));
  if(Object.values(out).some(value=>!Number.isSafeInteger(value)||value<0))throw Error('Invalid SDK usage');
  const cached=out.cacheReadTokens+out.cacheWriteTokens;
  if(!Number.isSafeInteger(cached)||out.inputTokens<cached)throw Error('Unrecognized SDK input accounting');
  out.inputTokens-=cached;
  return out;
}
