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
  assert.deepEqual(settings.get(), {available:true,port:'7890',agentHttpProtocol:'http2',proxyAgentRetries:false});
  assert.deepEqual(await settings.set('7891'), {available:true,port:'7891',agentHttpProtocol:'http2',proxyAgentRetries:false});
  assert.deepEqual(override, {proxyUrl:'http://[::1]:7891',providers});
  assert.ok((await settings.set('7891.5')).error);
  assert.equal(writes, 1);
  assert.deepEqual(await settings.set(''), {available:true,port:'',agentHttpProtocol:'http2',proxyAgentRetries:false});
  assert.deepEqual(settings.get(), {available:true,port:'',agentHttpProtocol:'http2',proxyAgentRetries:false});
  assert.deepEqual(override, {proxyUrl:'',providers});
  assert.ok((await settings.setConnection({agentHttpProtocol:'invalid'})).error);
  assert.ok((await settings.setConnection({proxyAgentRetries:'yes'})).error);
  assert.equal(writes, 2);
  assert.deepEqual(await settings.setConnection({agentHttpProtocol:'http1'}),
    {available:true,port:'',agentHttpProtocol:'http1',proxyAgentRetries:false});
  assert.deepEqual(override, {proxyUrl:'',providers,agentHttpProtocol:'http1'});
  assert.equal((await settings.set('7891')).agentHttpProtocol, 'http1');
  assert.deepEqual(await settings.setConnection({proxyAgentRetries:true}),
    {available:true,port:'7891',agentHttpProtocol:'http1',proxyAgentRetries:true});
  assert.deepEqual(override, {proxyUrl:'http://127.0.0.1:7891',providers,agentHttpProtocol:'http1',proxyAgentRetries:true});
});

test('the connection control saves only the changed values without submitting the account form', async () => {
  const hooks = [];
  const submitted = [];
  let index = 0;
  let mounted = false;
  const React = {
    createElement:(type, props, ...children) => ({type,props:props??{},children:children.flat(Infinity)}),
    useEffect(effect) {
      if (!mounted) {mounted = true;effect();}
    },
    useRef:() => ({current:null}),
    useState(initial) {
      const slot = index++;
      if (!(slot in hooks)) hooks[slot] = initial;
      return [hooks[slot], value => {hooks[slot] = value;}];
    },
  };
  let config={available:true,port:'7890',agentHttpProtocol:'http2',proxyAgentRetries:false};
  const api = {
    getProxySettings:async () => ({ok:true,value:config}),
    setConnectionSettings:async patch => {
      submitted.push(JSON.stringify(patch));
      config={...config,...patch};
      return {ok:true,value:config};
    },
  };
  const Menu=() => null;
  const context = {React,Menu,Icon:() => null,IconChevronDownOutlineRegular:() => null};
  const code = readFileSync(new URL('./client/settings.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replaceAll('export function ', 'function ');
  runInNewContext(code + '\nglobalThis.Control=ConnectionControl;', context);
  const nodes = value => value && typeof value === 'object' ? [value,...value.children.flatMap(nodes)] : [];
  function render() {
    index = 0;
    const tree = nodes(context.Control({api}));
    return {input:tree.find(node => node.type === 'input'),
      checkbox:tree.find(node => node.type === 'input' && node.props.type === 'checkbox'),
      button:tree.find(node => node.type === 'button'),
      menu:tree.find(node => node.type === Menu)};
  }
  assert.equal(render().input.props.disabled, true);
  assert.equal(render().checkbox.props.disabled, true);
  await Promise.resolve();
  assert.equal(render().input.props.value, '7890');
  assert.equal(render().checkbox.props.checked, false);
  assert.equal(render().button.props.disabled, true);
  render().input.props.onChange({target:{value:'7891'}});
  const {button} = render();
  assert.equal(button.props.type, 'button');
  assert.equal(button.props.disabled, false);
  await button.props.onClick();
  assert.deepEqual(submitted, ['{"port":"7891"}']);
  assert.equal(render().input.props.value, '7891');
  render().menu.props.onSelect('http1');
  await render().button.props.onClick();
  assert.deepEqual(submitted, ['{"port":"7891"}','{"agentHttpProtocol":"http1"}']);
  assert.equal(render().menu.props.selectedId, 'http1');
  assert.equal(render().input.props.value, '7891');
  render().checkbox.props.onChange({target:{checked:true}});
  assert.equal(render().button.props.disabled, false);
  await render().button.props.onClick();
  assert.deepEqual(submitted, ['{"port":"7891"}','{"agentHttpProtocol":"http1"}','{"proxyAgentRetries":true}']);
  assert.equal(render().checkbox.props.checked, true);
});
