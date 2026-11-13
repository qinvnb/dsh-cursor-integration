export class ProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
  }
}

export function resolveVariant(identifier, catalog) {
  const syntax = /^([^@]+)(?:@(.+))?$/;
  const match = typeof identifier === 'string' && syntax.exec(identifier);
  if (!match) throw new ProviderError('INVALID_MODEL', 'Invalid model identifier');
  const model = catalog.find(item => item.id === match[1]);
  if (!model) throw new ProviderError('UNKNOWN_MODEL', 'Model is absent from the account catalog');
  const parameters = {};
  for (const assignment of match[2]?.split(',') ?? []) {
    const pair = /^([^=]+)=([^=]+)$/.exec(assignment);
    const key = pair?.[1], value = pair?.[2];
    const definition = model.parameters?.find(item => item.id === key);
    if (!pair || ['__proto__','constructor','prototype'].includes(key) ||
        Object.hasOwn(parameters, key) || !definition?.values?.some(item => String(item) === value)) {
      throw new ProviderError('INVALID_PARAMETER', 'Unknown, duplicate or invalid model parameter');
    }
    parameters[key] = value;
  }
  const suffix = Object.entries(parameters).sort(([a],[b]) => a.localeCompare(b))
    .map(([key,value]) => key + '=' + value).join(',');
  return {id:model.id,parameters,variant:model.id + (suffix ? '@' + suffix : '')};
}

export async function bounded(operation, options = {}) {
  const {signal, timeoutMs = 30000, lateCleanup = async () => {}} = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
    throw new ProviderError('CONFIG', 'Invalid operation timeout');
  }
  if (signal?.aborted) throw new ProviderError('ABORTED', 'Request cancelled');
  let expired = false, cancel, timeout;
  const work = Promise.resolve().then(operation);
  const interrupt = new Promise((_, reject) => {
    cancel = () => {
      expired = true;
      reject(new ProviderError('ABORTED', 'Request cancelled'));
    };
    timeout = setTimeout(() => {
      expired = true;
      reject(new ProviderError('TIMEOUT', 'Operation timed out'));
    },timeoutMs);
    signal?.addEventListener('abort',cancel,{once:true});
  });
  work.then(value => expired ? lateCleanup(value) : undefined, () => {})
    .catch(() => {});
  try {return await Promise.race([work,interrupt]);}
  finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort',cancel);
  }
}

export function summarizeUsage(samples) {
  const billing = {inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0};
  let contextInputTokens;
  for (const sample of samples) {
    for (const field of Object.keys(billing)) {
      const value = sample[field] ?? 0;
      if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(billing[field] + value)) {
        throw new ProviderError('USAGE', 'Invalid usage count');
      }
      billing[field] += value;
    }
    if (sample.singleTurn && sample.inputTokens !== undefined) {
      contextInputTokens = Math.max(contextInputTokens ?? 0,sample.inputTokens);
    }
  }
  return {billing,contextInputTokens};
}
