import {z} from 'zod';
import {createTypertRemoteInfo} from '@deepseek-ai/dsh-typert-protocol/remote-info';
export const remoteInfo = createTypertRemoteInfo({package: 'dsh-cursor-integration', methods: {
  ...Object.fromEntries(['getRouteChecks','startRouteChecks','stopRouteChecks'].map(name=>['cursorIntegrationUsage/'+name,{
    service:'cursorIntegrationUsage',description:name,invocation:{kind:'direct'},parameters:[],
    result:{mode:'strict',typeSymbol:'dsh-cursor-integration#RouteChecks',create:()=>z.json(),description:'Model connectivity check status',jsonSchema:{}}
  }])),
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
