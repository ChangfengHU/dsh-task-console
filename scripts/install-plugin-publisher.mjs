import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readSpec,userPresetRoot,validateSpec,writePreset } from '../lib/index.js';
for(const id of ['plugin-publisher','plugin-publisher-reviewer','plugin-publisher-planner']) {
 const spec=validateSpec(JSON.parse(await readFile(new URL('../presets/'+id+'/task-console.json',import.meta.url),'utf8')));
 const current=await readSpec(join(userPresetRoot(),id));
 const comparable={...spec};if(current?.taskExpertise===undefined)delete comparable.taskExpertise;
 if(current&&JSON.stringify(current)!==JSON.stringify(comparable))throw Error('Existing user preset differs; inspect before updating: '+id);
 await writePreset(spec,[],[]);console.log('Installed '+id);
}
