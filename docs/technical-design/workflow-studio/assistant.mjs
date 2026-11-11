// Shared by the chat review and its runnable contract check.
const display = value => value === undefined ? 'not set' : typeof value === 'string' ? value : JSON.stringify(value);
const equal = (a,b) => {
  if (Object.is(a,b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value,index)=>equal(value,b[index]));
  const keys=Object.keys(a);
  return keys.length===Object.keys(b).length && keys.every(key=>Object.hasOwn(b,key)&&equal(a[key],b[key]));
};
function fields(before, after, path = '') {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key => {
    const a=before[key], b=after[key], name=path ? path+'.'+key : key;
    if(equal(a,b))return [];
    if(a && b && typeof a==='object' && typeof b==='object' && !Array.isArray(a) && !Array.isArray(b))return fields(a,b,name);
    return [{name, before:a, after:b}];
  });
}
export function workflowChanges(before, after) {
  const changes = [];
  for (const field of fields(Object.fromEntries(Object.entries(before).filter(([key])=>key!=='steps')), Object.fromEntries(Object.entries(after).filter(([key])=>key!=='steps')))) {
    const labels={name:'Workflow name',description:'Description', 'limits.maxCostUsd':'Budget (USD)', inputs:'Workflow inputs'};
    changes.push({kind:field.name==='name'?'Rename':'Update',id:null,label:labels[field.name]||field.name,detail:display(field.before)+' → '+display(field.after)});
  }
  for (const step of after.steps) {
    const old = before.steps.find(s => s.id === step.id);
    if (old && equal(old,step)) continue;
    const names = (step.needs || []).map(id => after.steps.find(s => s.id === id)?.label || id);
    const changed=old?fields(old,step):[];
    if(old&&!changed.length)continue;
    const detail = !old ? (names.length ? 'After '+names.join(' + ') : 'Uses workflow input') : changed.map(f=>{
      const label={timeout:'Timeout',skillRevision:'Skill version',label:'Name',repository:'Repository',needs:'Waits for'}[f.name]||f.name;
      return label+': '+display(f.before)+' → '+display(f.after);
    }).join('; ');
    changes.push({kind:old ? 'Update' : 'Add', id:step.id, label:step.label || step.id, detail});
  }
  for (const step of before.steps) if (!after.steps.some(s => s.id === step.id)) changes.push({kind:'Remove', id:step.id, label:step.label || step.id, detail:'Remove from this draft'});
  const sharedBefore=before.steps.filter(s=>after.steps.some(n=>n.id===s.id)).map(s=>s.id),sharedAfter=after.steps.filter(s=>before.steps.some(n=>n.id===s.id)).map(s=>s.id);
  if(!equal(sharedBefore,sharedAfter))changes.push({kind:'Update',id:null,label:'Step order',detail:sharedBefore.join(' → ')+' becomes '+sharedAfter.join(' → ')});
  return changes;
}

export function explainWorkflow(doc, selected, library) {
  const name = s => s.label || s.id;
  const step = doc.steps.find(s => s.id === selected);
  const describe = s => {
    const skill = library.find(k => k.revision === s.skillRevision);
    const needs = (s.needs || []).map(id => name(doc.steps.find(n => n.id === id) || {id}));
    return name(s)+' '+(s.repeat ? 'repeats up to '+s.repeat.max+' times' : 'uses '+(skill?.title || 'a registered action'))+(s.repository ? ' in '+s.repository : '')+(needs.length ? ' after '+needs.join(' and ') : ' when the workflow starts')+'.';
  };
  if (step) return describe(step);
  if (selected === 'trigger') return 'When started is the manual trigger. It passes your task input to the workflow. Live webhooks and schedules are configured separately.';
  if (!doc.steps.length) return 'This draft has no steps yet. Start with a skill, or ask me to research an issue and make a plan.';
  return doc.steps.map(describe).join('\n\n');
}
