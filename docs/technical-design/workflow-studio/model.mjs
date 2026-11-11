// Interaction prototype only. Server validation/authorization remains the production authority.
export const actions={
 'rpi.research':{title:'Research',input:'taskId',inputType:'string',outputs:{artifact:'ArtifactRef'}},
 'rpi.plan':{title:'Plan',input:'research',inputType:'ArtifactRef',outputs:{artifact:'ArtifactRef'}},
 'quality.integration':{title:'Integration checks',input:'candidate',inputType:'ArtifactRef',outputs:{artifact:'ArtifactRef',allRequired:'boolean'}},
 'flow.condition':{title:'Condition',input:'evidence',inputType:'ArtifactRef',outputs:{yes:'ArtifactRef',no:'ArtifactRef'}},
 'flow.wait':{title:'Wait',input:'context',inputType:'ArtifactRef',outputs:{artifact:'ArtifactRef'}},
 'harness.implement':{title:'Implementation',input:'planArtifact',inputType:'ArtifactRef',outputs:{artifact:'ArtifactRef',headSha:'string'}},
 'quality.check':{title:'Required checks',input:'revision',inputType:'string',outputs:{artifact:'ArtifactRef',allRequired:'boolean'}},
 'review.independent':{title:'Independent review',input:'evidence',inputType:'ArtifactRef',outputs:{artifact:'ArtifactRef',blockingFindings:'number'}},
 'harness.repair':{title:'Repair findings',input:'findings',inputType:'ArtifactRef',outputs:{artifact:'ArtifactRef'}},
 'agent.freeform':{title:'Agent step',input:'request',inputType:'string',outputs:{artifact:'ArtifactRef'}},
};
export const skills=[
 {title:'Research',action:'rpi.research',revision:'research-v1',description:'Turn a question into an evidence-backed brief.'},
 {title:'Plan',action:'rpi.plan',revision:'plan-v1',description:'Turn research into a clear implementation plan.'},
 {title:'Implementation',action:'harness.implement',revision:'implementation-v1',description:'Build from a plan and return a candidate.'},
 {title:'Independent review',action:'review.independent',revision:'review-v1',description:'Review the exact candidate and its checks.'},
 {title:'Repair findings',action:'harness.repair',revision:'repair-v1',description:'Resolve findings before checks and fresh review.'},
];
export const initial={apiVersion:'bakery.dev/v1',kind:'workflow',name:'software-delivery',description:'Illustrative workflow for testing the authoring interface.',inputs:{taskId:{type:'string',description:'Task identifier supplied by the trigger.'},repositoryId:{type:'string',description:'Repository authorized for this run.'}},limits:{maxCostUsd:12,maxRepairCycles:2},steps:[
 {id:'research',uses:'rpi.research',skillRevision:'research-v1',with:{taskId:'$input.taskId'},timeout:'30m'},
 {id:'implement',uses:'harness.implement',skillRevision:'implementation-v1',needs:['research'],with:{planArtifact:'$step.research.artifact'},timeout:'2h'},
 {id:'checks',uses:'quality.check',needs:['implement'],with:{revision:'$step.implement.headSha'},timeout:'45m'},
 {id:'review',uses:'review.independent',skillRevision:'review-v1',needs:['checks'],with:{evidence:'$step.checks.artifact'},timeout:'30m'},
]};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const issue=(path,code,message)=>({path,code,message});

const runnableExtensions={javascript:new Set(['js','mjs']),python:new Set(['py'])};
export function validateSkillPackage(files){
 const errors=[],add=(path,code,message)=>errors.push(issue(path,code,message));
 if(!Array.isArray(files)||!files.length)return [issue('/files','FILES','A skill package must include SKILL.md.')];
 if(files.length>256)add('/files','LIMIT','A skill package can contain at most 256 files.');
 const seen=new Set();let bytes=0,hasEntry=false;
 files.forEach((file,index)=>{
  const base='/files/'+index,path=file?.path;
  if(!object(file)){add(base,'SHAPE','Each skill file must be an object.');return;}
  if(typeof path!=='string'||!path||path.startsWith('/')||path.includes('\\')||path.split('/').some(part=>!part||part==='.'||part==='..')||path.length>240)add(base+'/path','PATH','Use a safe relative POSIX path up to 240 characters.');
  else{
   const key=path.normalize('NFC').toLocaleLowerCase('en-US');
   if(seen.has(key))add(base+'/path','DUPLICATE_PATH','File paths must be unique after Unicode normalization and case folding.');
   seen.add(key);hasEntry||=path==='SKILL.md';
  }
  if(typeof file.content!=='string')add(base+'/content','CONTENT','The inline editor requires text content.');
  else bytes+=new TextEncoder().encode(file.content).length;
  if(file.executable===true){
   const extension=typeof path==='string'?path.split('.').pop().toLowerCase():'';
   if(!runnableExtensions[file.language]?.has(extension))add(base+'/executable','RUNTIME','Runnable files must be JavaScript (.js or .mjs) or Python (.py).');
  }
 });
 if(!hasEntry)add('/files','ENTRY','A skill package must include SKILL.md at its root.');
 if(bytes>10*1024*1024)add('/files','LIMIT','A skill package can contain at most 10 MiB of text.');
 const entry=files.find(file=>file?.path==='SKILL.md');
 if(entry&&typeof entry.content==='string'&&!entry.content.trim())add('/files/SKILL.md','CONTENT','SKILL.md must contain meaningful instructions.');
 return errors;
}

// JSON.parse discards duplicate member names. A bounded lexical pass detects them first.
export function parseDocument(source){
 if(new TextEncoder().encode(source).length>256*1024)throw Error('File exceeds the prototype’s 256 KiB limit.');
 const tokens=source.match(/"(?:[^"\\]|\\.)*"|[{}\[\],:]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|\S/g)||[];
 let i=0;
 function value(depth=0){
  if(depth>32)throw Error('JSON nesting exceeds 32 levels.');
  const t=tokens[i++];
  if(t==='{'){const keys=new Set();while(tokens[i]!=='}'&&i<tokens.length){const key=JSON.parse(tokens[i++]);if(typeof key!=='string')throw Error('Object keys must be strings.');if(keys.has(key))throw Error(`Duplicate JSON member: ${key}`);keys.add(key);if(tokens[i++]!==':')throw Error('Expected a colon after a field name.');value(depth+1);if(tokens[i]===',')i++;else if(tokens[i]!=='}')throw Error('Expected a comma between object fields.');}i++;}
  else if(t==='['){while(tokens[i]!==']'&&i<tokens.length){value(depth+1);if(tokens[i]===',')i++;else if(tokens[i]!==']')throw Error('Expected a comma between array items.');}i++;}
 }
 value();return JSON.parse(source);
}
export function validate(doc,library=skills){
 const errors=[];const add=(p,c,m)=>errors.push(issue(p,c,m));
 if(!object(doc))return [issue('','SHAPE','Workflow must be a JSON object.')];
 if(doc.apiVersion!=='bakery.dev/v1')return [issue('/apiVersion','UNSUPPORTED_VERSION','Keep the original file read-only. This prototype supports bakery.dev/v1.')];
 const allowed=['apiVersion','kind','name','description','inputs','limits','steps'];
 for(const key of Object.keys(doc))if(!allowed.includes(key))add('/'+key,'UNKNOWN_FIELD',`Unknown workflow field “${key}”. Original source is retained.`);
 if(doc.kind!=='workflow')add('/kind','SHAPE','kind must be workflow.');
 if(typeof doc.name!=='string'||!doc.name.trim())add('/name','REQUIRED','Name is required.');
 if(typeof doc.description!=='string'||!doc.description.trim())add('/description','REQUIRED','Describe the workflow’s purpose.');
 if(!object(doc.inputs))add('/inputs','SHAPE','Inputs must be a described object.');
 if(!object(doc.limits)||!Number.isFinite(doc.limits.maxCostUsd)||doc.limits.maxCostUsd<=0)add('/limits/maxCostUsd','LIMIT','Set a positive, finite budget ceiling.');
 const ids=new Set();let count=0;
 function steps(list,path,ancestors=new Map()){
  if(!Array.isArray(list)||!list.length){add(path,'STEPS','Add at least one step.');return;}
  const upstream=new Map(ancestors);
  for(let idx=0;idx<list.length;idx++){
   if(++count>100){add(path,'LIMIT','The prototype supports at most 100 steps.');return;}
   const s=list[idx],p=path+'/'+idx;
   if(!object(s)){add(p,'SHAPE','Step must be an object.');continue;}
   if(typeof s.id!=='string'||!/^[a-z][a-z0-9_]*$/.test(s.id))add(p+'/id','ID','Use a stable ID of lowercase letters, numbers and underscores.');
   if(ids.has(s.id))add(p+'/id','DUPLICATE_ID',`Step ID “${s.id}” is duplicated.`);ids.add(s.id);
   for(const key of Object.keys(s))if(!['id','uses','needs','with','timeout','skillRevision','repeat','label','repository'].includes(key))add(p+'/'+key,'UNKNOWN_FIELD',`Unknown step field “${key}”.`);
   for(const key of ['label','repository'])if(s[key]!==undefined&&(typeof s[key]!=='string'||!s[key].trim()))add(p+'/'+key,'SHAPE',`${key} must be non-empty text when provided.`);
   if(s.needs!==undefined&&!Array.isArray(s.needs))add(p+'/needs','SHAPE','needs must be an array of earlier step IDs.');
   for(const dep of Array.isArray(s.needs)?s.needs:[])if(!upstream.has(dep))add(p+'/needs','FORWARD_REFERENCE',`“${dep}” must be an earlier step in this region.`);
   if(s.repeat){
    if(!object(s.repeat)||!Number.isInteger(s.repeat.max)||s.repeat.max<1||s.repeat.max>10)add(p+'/repeat/max','LOOP_LIMIT','Choose 1–10 maximum repeat cycles.');
    if(typeof s.repeat.until!=='string'||!s.repeat.until.trim())add(p+'/repeat/until','CONDITION','A repeat needs an explicit stop condition.');
    if(count<=100)steps(s.repeat.steps,p+'/repeat/steps',upstream);
    upstream.set(s.id,{outputs:{artifact:'ArtifactRef'}});continue;
   }
   if(s.timeout!==undefined&&(typeof s.timeout!=='string'||!/^([1-9][0-9]*)(s|m|h)$/.test(s.timeout)))add(p+'/timeout','TIMEOUT','Choose a positive duration such as 30m or 2h.');
   const a=Object.hasOwn(actions,s.uses)?actions[s.uses]:null;
   if(!a){add(p+'/uses','UNKNOWN_ACTION','Choose a registered action.');continue;}
   if(!s.uses.startsWith('quality.')&&!s.uses.startsWith('flow.')&&!library.some(k=>k.revision===s.skillRevision&&k.action===s.uses))add(p+'/skillRevision','MISSING_SKILL','Link an accessible skill revision compatible with this action.');
   if(!object(s.with)||!(a.input in s.with))add(p+'/with/'+a.input,'INPUT','Map this required input.');
   for(const [field,val] of Object.entries(object(s.with)?s.with:{})){
    if(field!==a.input){add(p+'/with/'+field,'UNKNOWN_FIELD',`“${field}” is not an input for this action.`);continue;}
    if(typeof val!=='string'){add(p+'/with/'+field,'INPUT_TYPE','This input requires a string or an upstream reference.');continue;}
    if(!val.trim()){add(p+'/with/'+field,'INPUT','Map a value for this required input.');continue;}
    if(val.startsWith('$step.')){
     const m=/^\$step\.([a-z][a-z0-9_]*)\.([a-zA-Z][a-zA-Z0-9]*)$/.exec(val);const source=m&&upstream.get(m[1]);
     if(!source)add(p+'/with/'+field,'REFERENCE','Choose an earlier output in this region.');
     else if(source.outputs[m[2]]!==a.inputType)add(p+'/with/'+field,'TYPE_MISMATCH',`This input needs ${a.inputType}; choose a compatible output.`);
    }else if(val.startsWith('$input.')){const input=object(doc.inputs)&&doc.inputs[val.slice(7)];if(!input||input.type!==a.inputType)add(p+'/with/'+field,'INPUT_REFERENCE','Choose a compatible workflow input.');}
    else if(a.inputType!=='string')add(p+'/with/'+field,'TYPE_MISMATCH','Choose an ArtifactRef from an earlier step.');
   }
   upstream.set(s.id,a);
  }
 }
 steps(doc.steps,'/steps');return errors;
}
export function compatibleSources(doc,index){const action=actions[doc.steps[index]?.uses];if(!action)return [];return doc.steps.slice(0,index).flatMap(s=>Object.entries(actions[s.uses]?.outputs||{}).filter(([,type])=>type===action.inputType).map(([field])=>({value:`$step.${s.id}.${field}`,label:`${actions[s.uses].title} → ${field}`})));}
export function mapInput(doc,targetId,value){const next=structuredClone(doc),target=next.steps.find(s=>s.id===targetId),action=actions[target?.uses];if(!action)throw Error('This target has no action input.');const previous=target.with?.[action.input];const oldSource=typeof previous==='string'&&previous.startsWith('$step.')?previous.split('.')[1]:null;const newSource=typeof value==='string'&&value.startsWith('$step.')?value.split('.')[1]:null;target.with={...target.with,[action.input]:value};target.needs=[...new Set([...(target.needs||[]).filter(id=>id!==oldSource),...(newSource?[newSource]:[])])];return next;}
export function connect(doc,sourceId,targetId,output,library=skills){if(sourceId===targetId)throw Error('Choose a different target step.');const next=mapInput(doc,targetId,`$step.${sourceId}.${output}`);const errors=validate(next,library);if(errors.length)throw Error(errors[0].message);return next;}
