import assert from 'node:assert/strict';
import test from 'node:test';
import {createCursorSdkLoader} from './src/sdk-transport.js';

test('both routes load one SDK configuration and reloading can switch from SSE to HTTP/2', async () => {
  const settings = [];
  let imports=0;
  const sdk = {Cursor:{configure:options => settings.push(options.local.useHttp1ForAgent)}};
  const load = async () => {imports++;return sdk;};
  const sse = createCursorSdkLoader('http1',load);
  const [direct,proxy] = await Promise.all([sse.load(),sse.load()]);
  assert.equal(direct,sdk);
  assert.equal(proxy,sdk);
  assert.equal(imports,1);
  assert.deepEqual(settings,[true]);

  const http2 = createCursorSdkLoader('http2',load);
  await http2.load();
  sse.close();
  assert.deepEqual(settings,[true,false]);
  http2.close();
  assert.deepEqual(settings,[true,false,null]);
});

test('an SDK import that finishes after unload cannot change the protocol', async () => {
  const sdk = {Cursor:{configure:() => assert.fail('unloaded configuration was applied')}};
  let completeImport;
  const loader = createCursorSdkLoader('http1',() => new Promise(resolve => {completeImport=resolve;}));
  const pending = loader.load();
  loader.close();
  completeImport(sdk);
  await assert.rejects(pending,{code:'DISPOSED'});
  await assert.rejects(loader.load(),{code:'DISPOSED'});
});
