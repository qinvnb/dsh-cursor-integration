import {z} from 'zod';
import {createTypertRemoteInfo} from '@deepseek-ai/dsh-typert-protocol/remote-info';
const catalogRequest={mode:'strict',typeSymbol:'dsh-cursor-integration#ModelCatalogRequest',
  create:()=>z.object({ref:z.string(),draftKey:z.string().optional()}),
  jsonSchema:{type:'object',properties:{ref:{type:'string'},draftKey:{type:'string'}},required:['ref']}};
const proxyPortCodec={mode:'strict',typeSymbol:'string',create:()=>z.string(),jsonSchema:{type:'string'}};
const proxySettingsResult={mode:'strict',typeSymbol:'dsh-cursor-integration#ProxySettings',create:()=>z.json(),jsonSchema:{}};
const connectionPatch={mode:'strict',typeSymbol:'dsh-cursor-integration#ConnectionSettingsPatch',
  create:()=>z.object({port:z.string().optional(),agentHttpProtocol:z.enum(['http2','http1']).optional(),proxyAgentRetries:z.boolean().optional()}),
  jsonSchema:{type:'object',properties:{port:{type:'string'},agentHttpProtocol:{enum:['http2','http1']},proxyAgentRetries:{type:'boolean'}}}};
export const remoteInfo = createTypertRemoteInfo({package: 'dsh-cursor-integration', methods: {
  'cursorIntegrationUsage/getProxySettings': {
    service:'cursorIntegrationUsage',description:'Read the Cursor proxy port from the DSH profile.',invocation:{kind:'direct'},
    parameters:[],result:proxySettingsResult,
  },
  'cursorIntegrationUsage/setProxyPort': {
    service:'cursorIntegrationUsage',description:'Save the Cursor proxy port through ConfigEditor.',invocation:{kind:'direct'},
    parameters:[{name:'port',source:'json',codec:proxyPortCodec,strictCodec:proxyPortCodec}],result:proxySettingsResult,
  },
  'cursorIntegrationUsage/setConnectionSettings': {
    service:'cursorIntegrationUsage',description:'Save the Cursor proxy port or agent HTTP protocol through ConfigEditor.',invocation:{kind:'direct'},
    parameters:[{name:'patch',source:'json',codec:connectionPatch,strictCodec:connectionPatch}],result:proxySettingsResult,
  },
  ...Object.fromEntries(['getCompactionSettings','getRouteChecks','startRouteChecks','stopRouteChecks'].map(name=>['cursorIntegrationUsage/'+name,{
    service:'cursorIntegrationUsage',description:name,invocation:{kind:'direct'},parameters:[],
    result:{mode:'strict',typeSymbol:'dsh-cursor-integration#RouteChecks',create:()=>z.json(),description:'Model connectivity check status',jsonSchema:{}}
  }])),
  'cursorIntegrationUsage/setCompactionThreshold': {
    service:'cursorIntegrationUsage',description:'Update the native DSH compaction threshold through ConfigEditor.',invocation:{kind:'direct'},
    parameters:[{name:'ratio',source:'json',codec:{mode:'strict',typeSymbol:'number',create:()=>z.number(),jsonSchema:{type:'number'}},strictCodec:{mode:'strict',typeSymbol:'number',create:()=>z.number(),jsonSchema:{type:'number'}}}],
    result:{mode:'strict',typeSymbol:'dsh-cursor-integration#CompactionSettings',create:()=>z.json(),jsonSchema:{}},
  },
  'cursorIntegrationUsage/getModelCatalog': {
    service:'cursorIntegrationUsage',description:'Read the Cursor model capabilities for the selected credential.',invocation:{kind:'direct'},
    parameters:[{name:'request',source:'json',codec:catalogRequest,strictCodec:catalogRequest}],
    result:{mode:'strict',typeSymbol:'dsh-cursor-integration#ModelCatalog',create:()=>z.json(),jsonSchema:{}},
  },
  'cursorIntegrationUsage/getDisplayState': {
    service:'cursorIntegrationUsage',description:'Read the cached account for this session.', invocation:{kind:'direct'},parameters:[{name:'sessionId',source:'json',codec:{mode:'strict',typeSymbol:'string',create:()=>z.string(),jsonSchema:{type:'string'}},strictCodec:{mode:'strict',typeSymbol:'string',create:()=>z.string(),jsonSchema:{type:'string'}}}],result:{mode:'strict',typeSymbol:'dsh-cursor-integration#DisplayState',create:()=>z.json(),jsonSchema:{}}
  },
  'cursorIntegrationUsage/getSnapshot': {
    service: 'cursorIntegrationUsage', description: 'Read Cursor account meters and aggregate local DSH token counts.',
    invocation: {kind: 'direct'}, parameters: [],
    result: {mode: 'strict', typeSymbol: 'dsh-cursor-integration#Snapshot', create: () => z.json(), description: 'Credential-free usage snapshot.', jsonSchema: {}},
  },
  'cursorIntegrationUsage/getAllSnapshots': {
    service:'cursorIntegrationUsage',description:'Query usage for all saved Cursor credentials without changing the active credential.',
    invocation:{kind:'direct'},parameters:[],
    result:{mode:'strict',typeSymbol:'dsh-cursor-integration#AllSnapshots',create:()=>z.json(),description:'Masked credential labels and account usage.',jsonSchema:{}},
  },
  'cursorIntegrationUsage/selectKey': {
    service:'cursorIntegrationUsage',description:'Activate one saved Cursor credential by reference without returning the secret.',
    invocation:{kind:'direct'},parameters:[{name:'id',source:'json',codec:{mode:'strict',typeSymbol:'string',create:()=>z.string(),jsonSchema:{type:'string'}},strictCodec:{mode:'strict',typeSymbol:'string',create:()=>z.string(),jsonSchema:{type:'string'}}}],
    result:{mode:'strict',typeSymbol:'dsh-cursor-integration#SelectKey',create:()=>z.json(),description:'Selection result and credential labels.',jsonSchema:{}},
  },
}}, z);
export const TYPERT = {package: 'dsh-cursor-integration', face: 'host', schemas: [],
  get invocations() {return remoteInfo.descriptors;}, model: {services: [], events: [], objects: []}};
