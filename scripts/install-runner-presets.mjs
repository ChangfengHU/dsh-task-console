import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readSpec,userPresetRoot,validateSpec,writePreset } from '../lib/index.js';
for(const id of ['fleet-runner-planner','fleet-runner-operator','fleet-runner-reviewer','fleet-ops-planner','fleet-ops-reviewer']) {
  const spec=validateSpec(JSON.parse(await readFile(new URL('../presets/'+id+'/task-console.json',import.meta.url),'utf8')));
  const current=await readSpec(join(userPresetRoot(),id));
  if(current&&JSON.stringify(current)!==JSON.stringify(spec))throw Error('Existing user preset differs; inspect before updating: '+id);
  await writePreset(spec,[],[]);console.log('Installed '+id);
}
