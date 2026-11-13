import {build} from 'esbuild';
import {mkdir,writeFile} from 'node:fs/promises';
const result=await build({
  entryPoints:['client/index.js'],bundle:true,write:false,format:'cjs',
  platform:'browser',external:['react','@deepseek-ai/dsh-client-ui-primitives'],minify:false,
});
await mkdir('src',{recursive:true});
const code=result.outputFiles[0].text;
await writeFile('src/client.js',
  "window.__ModuleLoader__.load({id:'dsh-cursor-integration',factory(require){\n"+
  "const module={exports:{}};const exports=module.exports;\n"+code+
  "\nreturn module.exports;}});\n");
