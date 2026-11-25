import {ProviderError} from './provider.js';

let sdkOwner;

// Both routes use the same SDK module, so set its local-agent default once per plugin load.
export function createCursorSdkLoader(agentHttpProtocol, importSdk = () => import('@cursor/sdk')) {
  let pending, sdk, closed = false;
  const disposed = () => new ProviderError('DISPOSED', 'Cursor SDK loader closed');
  const loader = {
    async load() {
      if (closed) throw disposed();
      return pending ??= importSdk().then(loaded => {
        if (closed) throw disposed();
        loaded.Cursor.configure({local:{useHttp1ForAgent:agentHttpProtocol === 'http1'}});
        sdk = loaded;
        sdkOwner = loader;
        return sdk;
      });
    },
    close() {
      closed = true;
      if (sdkOwner !== loader) return;
      sdkOwner = undefined;
      sdk.Cursor.configure({local:{useHttp1ForAgent:null}});
    },
  };
  return loader;
}
