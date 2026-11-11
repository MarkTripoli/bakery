export function filterWorkflowRows(rows,{source='all',status='all',query='',sort='name-asc'}={}){
  const term=query.trim().toLocaleLowerCase();
  const filtered=rows.filter(row=>(source==='all'||row.source===source)&&(status==='all'||row.status===status)&&(!term||`${row.name} ${row.description} ${row.owner}`.toLocaleLowerCase().includes(term)));
  return [...filtered].sort((a,b)=>{
    const direction=sort==='name-desc'?-1:1;
    const byName=a.name.localeCompare(b.name)||String(a.id??'').localeCompare(String(b.id??''));
    if(sort==='source')return a.source.localeCompare(b.source)||byName;
    return direction*byName;
  });
}

export function splitRouteHash(hash){
  const separator=hash.indexOf('?');
  return separator<0?[hash,'']:[hash.slice(0,separator),hash.slice(separator+1)];
}
