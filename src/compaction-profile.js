import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';

const compactionId = 'compaction-basic';
const compactionRow = rows => rows.find(row=>row.id===compactionId && !row.group);

export function isPendingCompactionConflict(error) {
  const [header,...entries] = String(error?.message??'').trim().split(/\r?\n/);
  return /^dsh: warning: \d+ entr(?:y|ies) did not activate$/.test(header) &&
    entries.length>0 && entries.every(line=>/^compaction-basic \(.+\): pending \(waiting for service: .+\)$/.test(line));
}

// The desktop ConfigEditor checks required ids across all loader trees. A
// pending agent preset can share this id with the running desktop engine.
export async function editDesktopCompaction(editor, root, ratio) {
  const profile = root?.get('profileContext');
  if (!profile || editor.documentPath!==profile.patchPath) throw new Error('Compaction profile unavailable');
  const hostRequire = createRequire(profile.installAnchor);
  const importHost = name=>import(pathToFileURL(hostRequire.resolve(name)));
  const [boot, atomic, include] = await Promise.all([
    importHost('@deepseek-ai/dsh-app-boot'),
    importHost('@deepseek-ai/dsh-atomic-write'),
    importHost('@deepseek-ai/cordis-plugin-include'),
  ]);
  const editorRequire = createRequire(hostRequire.resolve('@deepseek-ai/dsh-config-editor'));
  const {parseDocument,isMap,isSeq} = editorRequire('yaml');
  const yaml = editorRequire('js-yaml');

  const save = ()=>atomic.withFileLock(join(profile.dir,'package.json'),async()=>{
    const path = profile.patchPath;
    const entry = editor.entries().find(candidate=>candidate.options.id===compactionId);
    const engine = entry?.fiber?.ctx.get('compaction');
    if (!engine) throw new Error('Desktop compaction engine unavailable');

    const before = await readFile(path,'utf8');
    const loaded = boot.loadProfileDirectory('dsh',profile.dir,profile.installAnchor);
    const beforePatches = boot.readProfilePatches('dsh',profile,loaded);
    const oldRow = compactionRow(boot.composeEntries([beforePatches]));
    if (!oldRow || oldRow.disabled===true) throw new Error('Desktop compaction profile unavailable');
    const current = oldRow.config??{};
    const next = {...current,thresholdRatio:ratio};
    const document = parseDocument(before,{customTags:[{tag:'tag:yaml.org,2002:js',resolve:value=>value}]});
    if (document.errors.length || !isSeq(document.contents)) throw new Error('Desktop compaction profile is not editable');
    const rowIndex = document.contents.items.findLastIndex((row,index)=>
      isMap(row) && document.getIn([index,'id'])===compactionId && !row.has('insert') &&
      (!row.has('name') || document.getIn([index,'name'])===oldRow.name));
    if (rowIndex<0) document.add(document.createNode({id:compactionId,config:next}));
    else if (isMap(document.getIn([rowIndex,'config'],true))) {
      document.setIn([rowIndex,'config','thresholdRatio'],ratio);
    } else document.setIn([rowIndex,'config'],document.createNode(next));

    const updated = String(document);
    const patches = boot.readProfilePatches('dsh',profile,{
      ...loaded,patches:yaml.load(updated,{schema:include.entryListSchema}),
    });
    const target = compactionRow(boot.composeEntries([patches]));
    if (!target || !isDeepStrictEqual(target.config,next)) throw new Error('Desktop compaction is overridden by another configuration');
    entry.fiber.resolveConfig(next);
    if (await readFile(path,'utf8')!==before) throw new Error('Desktop compaction profile changed during save');
    await atomic.writeFileAtomic(path,updated,{mode:0o600});
    try {
      await boot.reconcileProfilePatches(root,patches,'dsh');
      const active = editor.entries().find(candidate=>candidate.options.id===compactionId)?.fiber?.ctx.get('compaction');
      if (active?.config?.thresholdRatio!==ratio) throw new Error('Desktop compaction engine did not adopt the new threshold');
    } catch(error) {
      await atomic.writeFileAtomic(path,before,{mode:0o600});
      await boot.reconcileProfilePatches(root,beforePatches,'dsh');
      throw error;
    }
  });
  const hmr = root.get('hmr');
  await (hmr ? hmr.runExclusive(save) : save());
}
