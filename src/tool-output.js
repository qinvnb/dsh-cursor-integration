import { open, realpath, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

const outputName = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.txt$/i;
const reply = (text, isError = false) => ({ content: [{type:'text', text}], isError });

// The SDK stores large MCP results under a project derived from its private cwd.
export function sdkOutputReader(cwd, projects = join(homedir(), '.cursor', 'projects')) {
  const root = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-'), 'agent-tools');
  return args => {
    const file = args.file_path;
    if (typeof file !== 'string' || !isAbsolute(file) || !outputName.test(basename(file)) || relative(root, dirname(file)) !== '') return;
    return readOutput(file, args);
  };
}

async function readOutput(file, {offset = 1, limit = 200}) {
  let handle;
  try {
    const info = await lstat(file, {bigint:true});
    if (!info.isFile() || info.nlink !== 1n || relative(file, await realpath(file)) !== '') throw Error();
    handle = await open(file, 'r');
    const opened = await handle.stat({bigint:true});
    if (opened.dev !== info.dev || opened.ino !== info.ino || opened.nlink !== 1n) throw Error();
    let line = 0, text = '';
    const start = Math.max(1, offset);
    for await (const value of handle.readLines()) {
      if (++line < start) continue;
      if (line >= start + limit || text.length >= 12000) {
        text += '\n[More output available from line ' + line + ']';
        break;
      }
      text += line + '\t' + (value.length > 4000 ? value.slice(0,4000) + ' [line truncated]' : value) + '\n';
    }
    return reply(text);
  } catch {
    return reply('This Cursor tool output is unavailable. Inspect the original command output on the devbox.', true);
  } finally {
    await handle?.close();
  }
}
