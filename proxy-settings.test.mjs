import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {proxySettings,readProxyPort,updateProxyPort} from './src/proxy-settings.js';

test('proxy settings display only the port, including the HTTP default', () => {
  assert.equal(readProxyPort('http://127.0.0.1:7890'), '7890');
  assert.equal(readProxyPort('http://[::1]:80'), '80');
  assert.equal(readProxyPort(''), '');
});

test('changing a proxy port preserves the existing host or uses local loopback', () => {
  assert.equal(updateProxyPort(undefined, ' 7890 '), 'http://127.0.0.1:7890');
  assert.equal(updateProxyPort('http://[::1]:7890', '7891'), 'http://[::1]:7891');
  assert.equal(updateProxyPort('http://127.0.0.1:7890', '80'), 'http://127.0.0.1');
  assert.equal(updateProxyPort('http://127.0.0.1:7890', ' '), '');
});

test('proxy settings reject URLs and invalid ports', () => {
  for (const invalid of ['0','65536','-1','1.5','1e3','http://127.0.0.1:7890']) {
    assert.throws(() => updateProxyPort(undefined, invalid), RangeError);
  }
});

test('the proxy port is saved through ConfigEditor without replacing the account or model configuration', async () => {
  const entry = {options:{id:'cursor-integration'}};
  const providers = {cursor:{apiKeyEnv:'CURSOR_TEST',models:['test-model']}};
  const inherited = {proxyUrl:'http://[::1]:7890'};
  let override = {providers};
  let writes = 0;
  const editor = {
    configuration:() => [{entry,override,inherited}],
    async edit(target, change) {
      assert.equal(target, entry);
      override = change(override, inherited);
      writes++;
    },
  };
  const settings = proxySettings(editor, 'cursor-integration');
  assert.deepEqual(settings.get(), {available:true,port:'7890'});
  assert.deepEqual(await settings.set('7891'), {available:true,port:'7891'});
  assert.deepEqual(override, {proxyUrl:'http://[::1]:7891',providers});
  assert.ok((await settings.set('7891.5')).error);
  assert.equal(writes, 1);
  assert.deepEqual(await settings.set(''), {available:true,port:''});
  assert.deepEqual(settings.get(), {available:true,port:''});
  assert.deepEqual(override, {proxyUrl:'',providers});
});

test('the port control reads and saves through its own RPC without submitting the settings form', async () => {
  const hooks = [];
  const submitted = [];
  let index = 0;
  let mounted = false;
  const React = {
    createElement:(type, props, ...children) => ({type,props:props??{},children:children.flat(Infinity)}),
    useEffect(effect) {
      if (!mounted) {mounted = true;effect();}
    },
    useState(initial) {
      const slot = index++;
      if (!(slot in hooks)) hooks[slot] = initial;
      return [hooks[slot], value => {hooks[slot] = value;}];
    },
  };
  const api = {
    getProxySettings:async () => ({ok:true,value:{available:true,port:'7890'}}),
    setProxyPort:async port => {
      submitted.push(port);
      return {ok:true,value:{available:true,port}};
    },
  };
  const context = {React,Icon:() => null};
  const code = readFileSync(new URL('./client/settings.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replaceAll('export function ', 'function ');
  runInNewContext(code + '\nglobalThis.Control=ProxyPortControl;', context);
  const nodes = value => value && typeof value === 'object' ? [value,...value.children.flatMap(nodes)] : [];
  function render() {
    index = 0;
    const tree = nodes(context.Control({api}));
    return {input:tree.find(node => node.type === 'input'),button:tree.find(node => node.type === 'button')};
  }
  assert.equal(render().input.props.disabled, true);
  await Promise.resolve();
  assert.equal(render().input.props.value, '7890');
  assert.equal(render().button.props.disabled, true);
  render().input.props.onChange({target:{value:'7891'}});
  const {button} = render();
  assert.equal(button.props.type, 'button');
  assert.equal(button.props.disabled, false);
  await button.props.onClick();
  assert.deepEqual(submitted, ['7891']);
  assert.equal(render().input.props.value, '7891');
});
