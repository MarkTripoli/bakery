// Exports the approved HTML mock's exact layout into small editable Paper visual groups.
// Run: rtk proxy node docs/technical-design/auth-mocks/paper-export.cjs
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {chromium}=require('@playwright/test');
const base='http://127.0.0.1:8799/auth-mocks/index.html';
(async()=>{
 const browser=await chromium.launch(),page=await browser.newPage();const screens=[];
 try{
  await page.goto(base+'?screen=1#login');const selected=new Set((process.env.BAKERY_AUTH_SCREENS||'').split(',').filter(Boolean));const definitions=(await page.evaluate(()=>SCREENS)).filter(s=>!selected.size||selected.has(s.id));
  for(const theme of ['light','dark'])for(const def of definitions)for(const state of def.states)for(const width of [1440,390]){
   await page.setViewportSize({width,height:width===390?844:960});
   await page.goto(base+'?screen=1&theme='+theme+'#'+def.id+'/'+state);
   await page.waitForFunction(({id,state})=>document.querySelector('#app').dataset.screen===id&&document.querySelector('#app').dataset.state===state,{id:def.id,state});
   await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>Promise.all([...document.querySelectorAll('#app img')].map(i=>i.decode())));
   const design=await page.evaluate(({theme,localDir})=>{
    const root=document.querySelector('#app'),out=[],round=v=>Math.round(v*100)/100,esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const colors=theme==='light'?{
     'rgb(245, 246, 248)':'--color-background','rgb(255, 255, 255)':'--color-surface','rgb(238, 240, 244)':'--color-light-subtle','rgb(20, 26, 36)':'--color-foreground','rgb(93, 102, 117)':'--color-muted-foreground','rgb(227, 230, 235)':'--color-border','rgb(138, 147, 159)':'--color-control-border','rgb(11, 99, 198)':'--color-selection','rgb(236, 241, 248)':'--color-accent','rgb(190, 51, 65)':'--color-destructive','rgb(252, 238, 239)':'--color-destructive-surface','rgb(23, 120, 75)':'--color-success','rgb(232, 245, 238)':'--color-success-surface','rgb(143, 90, 11)':'--color-warning','rgb(251, 243, 228)':'--color-warning-surface'
    }:{
     'rgb(11, 14, 20)':'--color-dark-canvas','rgb(18, 22, 30)':'--color-dark-surface','rgb(25, 30, 40)':'--color-dark-subtle','rgb(242, 244, 248)':'--color-dark-fg','rgb(163, 172, 186)':'--color-dark-fg-secondary','rgb(45, 53, 66)':'--color-dark-border','rgb(89, 101, 122)':'--color-dark-control','rgb(110, 170, 240)':'--color-dark-accent-hover','rgb(21, 35, 56)':'--color-dark-accent-surface','rgb(238, 106, 121)':'--color-dark-critical','rgb(51, 24, 32)':'--color-dark-critical-surface','rgb(69, 179, 124)':'--color-dark-success','rgb(15, 38, 28)':'--color-dark-success-surface','rgb(224, 168, 63)':'--color-dark-warning','rgb(42, 32, 16)':'--color-dark-warning-surface','rgb(245, 246, 248)':'--color-background'
    };
    const color=v=>colors[v]?'var('+colors[v]+')':v;
    const px=v=>round(v)+'px';
    const pos=(r,o)=>'position:absolute;left:'+px(r.x-o.x)+';top:'+px(r.y-o.y)+';width:'+px(r.width)+';height:'+px(r.height)+';flex-shrink:0;';
    const type=s=>'font-family:var('+(/mono/i.test(s.fontFamily)?'--font-mono':'--font-sans')+');font-size:'+s.fontSize+';font-weight:'+s.fontWeight+';line-height:'+(s.lineHeight==='normal'?px(parseFloat(s.fontSize)*1.5):s.lineHeight)+';letter-spacing:'+(s.letterSpacing==='normal'?'0px':s.letterSpacing)+';color:'+color(s.color)+';';
    function paintStyle(s){
     let a='';
     if(s.backgroundColor!=='rgba(0, 0, 0, 0)')a+='background-color:'+color(s.backgroundColor)+';';
     for(const side of ['Top','Right','Bottom','Left'])if(parseFloat(s['border'+side+'Width']))a+='border-'+side.toLowerCase()+':'+s['border'+side+'Width']+' '+s['border'+side+'Style']+' '+color(s['border'+side+'Color'])+';';
     if(parseFloat(s.borderTopLeftRadius))a+='border-radius:'+s.borderRadius+';';
     if(s.opacity!=='1')a+='opacity:'+s.opacity+';';
     return a;
    }
    function atom(e,origin){
     if(e.nodeType===Node.TEXT_NODE){
      if(!e.textContent.trim())return '';
      const range=document.createRange(),s=getComputedStyle(e.parentElement),lines=[];
      for(let i=0;i<e.textContent.length;i++){
       range.setStart(e,i);range.setEnd(e,i+1);const r=range.getBoundingClientRect();if(!r.height)continue;
       let line=lines[lines.length-1];if(!line||Math.abs(line.y-r.y)>1){line={x:r.x,y:r.y,right:r.right,height:r.height,text:''};lines.push(line);}
       line.right=Math.max(line.right,r.right);line.text+=e.textContent[i];
      }
      const lh=s.lineHeight==='normal'?parseFloat(s.fontSize)*1.5:parseFloat(s.lineHeight);
      return lines.filter(l=>l.text.trim()).map(l=>'<div layer-name="Text" style="'+pos({x:l.x,y:l.y-(lh-l.height)/2,width:l.right-l.x+3,height:lh},origin)+type(s)+'display:block;white-space:pre;'+(s.textDecorationLine==='underline'?'text-decoration:underline;':'')+'">'+esc(l.text)+'</div>').join('');
     }
     if(e.nodeType!==Node.ELEMENT_NODE)return '';
     const s=getComputedStyle(e),r=e.getBoundingClientRect();if(s.display==='none'||s.visibility==='hidden'||!r.width||!r.height)return '';
     const name=e.getAttribute('aria-label')||e.getAttribute('alt')||e.className?.baseVal||e.className||e.tagName;
     if(e.tagName==='svg'){
      const clone=e.cloneNode(true);clone.setAttribute('style',pos(r,origin)+'color:'+color(s.color)+';display:block;');clone.setAttribute('fill',s.fill);clone.setAttribute('stroke',color(s.stroke));clone.setAttribute('stroke-width',s.strokeWidth);clone.setAttribute('stroke-linecap',s.strokeLinecap);clone.setAttribute('stroke-linejoin',s.strokeLinejoin);clone.setAttribute('width',String(round(r.width)));clone.setAttribute('height',String(round(r.height)));clone.setAttribute('layer-name','Icon');return clone.outerHTML.replaceAll('currentColor',color(s.color));
     }
     if(e.tagName==='IMG'&&e.classList.contains('totp-qr')){
      // Paper ignores image padding; preserve the QR quiet zone with an outer surface.
      const inset=side=>parseFloat(s['padding'+side])+parseFloat(s['border'+side+'Width']);
      const left=inset('Left'),top=inset('Top');
      return '<div layer-name="'+esc(name)+'" style="'+pos(r,origin)+paintStyle(s)+'"><img src="paper-asset://'+localDir+'/'+new URL(e.src).pathname.split('/').pop()+'" style="position:absolute;left:'+px(left)+';top:'+px(top)+';width:'+px(r.width-left-inset('Right'))+';height:'+px(r.height-top-inset('Bottom'))+';object-fit:contain;"></div>';
     }
     if(e.tagName==='IMG')return '<img layer-name="'+esc(name)+'" src="paper-asset://'+localDir+'/'+new URL(e.src).pathname.split('/').pop()+'" style="'+pos(r,origin)+paintStyle(s)+'object-fit:contain;padding:'+s.paddingTop+' '+s.paddingRight+' '+s.paddingBottom+' '+s.paddingLeft+';">';
     if(e.classList.contains('or')){
      const textW=12,gap=16,w=(r.width-textW-gap*2)/2;
      return '<div style="'+pos({x:r.x,y:r.y+r.height/2,width:w,height:1},origin)+'background:'+color(getComputedStyle(e,'::before').backgroundColor)+'"></div><div style="'+pos({x:r.right-w,y:r.y+r.height/2,width:w,height:1},origin)+'background:'+color(getComputedStyle(e,'::after').backgroundColor)+'"></div><div style="'+pos({x:r.x+w+gap,y:r.y,width:textW+3,height:r.height},origin)+type(s)+'white-space:pre;">or</div>';
     }
     if(e.tagName==='INPUT'||e.tagName==='SELECT'){
      let text=e.innerText??e.textContent,ink=s.color;
      if(e.tagName==='INPUT'){text=e.type==='password'?(e.value?'••••••••••••':''):e.value;text=text||e.placeholder;if(!e.value)ink=getComputedStyle(e,'::placeholder').color;}
      if(e.tagName==='SELECT')text=e.options[e.selectedIndex].text;
      const style=pos(r,origin)+paintStyle(s)+type(s)+'color:'+color(ink)+';padding:'+s.paddingTop+' '+s.paddingRight+' '+s.paddingBottom+' '+s.paddingLeft+';white-space:pre;display:block;text-align:'+s.textAlign+';';
      return '<div layer-name="'+esc(name)+'" style="'+style+'">'+esc(text)+'</div>';
     }
     let a=paintStyle(s)?'<div layer-name="'+esc(name)+' surface" style="'+pos(r,origin)+paintStyle(s)+'display:flex;"></div>':'';
     if(e.classList.contains('or')){
      const textW=12,gap=16,w=(r.width-textW-gap*2)/2;
      a+='<div style="'+pos({x:r.x,y:r.y+r.height/2,width:w,height:1},origin)+'background:'+color(getComputedStyle(e,'::before').backgroundColor)+'"></div>';
      a+='<div style="'+pos({x:r.right-w,y:r.y+r.height/2,width:w,height:1},origin)+'background:'+color(getComputedStyle(e,'::after').backgroundColor)+'"></div>';
     }
     for(const child of e.childNodes)a+=atom(child,origin);return a;
    }
    const groupSelector='.form-heading,.field,.item,.notice,.btn,.small-brand,.or,.brand-content>h2,.brand-content>img,.brand-footer,.form-bottom,.context-footer,.settings-topbar,.rail-nav>a,.mobile-settings-nav';
    function visit(e){
     if(e.nodeType!==Node.ELEMENT_NODE)return;
     const s=getComputedStyle(e),r=e.getBoundingClientRect();if(!r.width||!r.height||s.display==='none'||s.visibility==='hidden')return;
     const children=[...e.children],leaf=!children.length||children.every(c=>c.tagName==='BR')||e.tagName==='svg'||e.tagName==='IMG';
     if(e.matches(groupSelector)||leaf){
      const name=(e.getAttribute('aria-label')||e.getAttribute('alt')||e.className?.baseVal||e.className||e.tagName)+': '+e.textContent.trim().slice(0,56);
      const inner=atom(e,r);
      if(inner)out.push({name:String(name),x:round(r.x),y:round(r.y),width:round(r.width),height:round(r.height),html:'<div layer-name="'+esc(name)+'" style="position:relative;display:flex;flex-direction:column;width:'+px(r.width)+';height:'+px(r.height)+';">'+inner+'</div>'});
      return;
     }
     const paint=paintStyle(s);
     if(paint&&e!==root.firstElementChild)out.push({name:(e.className||e.tagName)+' surface',x:round(r.x),y:round(r.y),width:round(r.width),height:round(r.height),html:'<div layer-name="'+esc((e.className||e.tagName)+' surface')+'" style="display:flex;width:'+px(r.width)+';height:'+px(r.height)+';'+paint+'"></div>'});
     for(const child of children)visit(child);
     for(const child of e.childNodes)if(child.nodeType===Node.TEXT_NODE&&child.textContent.trim()){
      const html=atom(child,r);if(html)out.push({name:'Text',x:round(r.x),y:round(r.y),width:round(r.width),height:round(r.height),html:'<div style="position:relative;display:flex;width:'+px(r.width)+';height:'+px(r.height)+';">'+html+'</div>'});
     }
    }
    visit(root.firstElementChild);
    return {width:innerWidth,height:Math.max(root.scrollHeight,innerHeight),background:color(getComputedStyle(root.firstElementChild).backgroundColor),groups:out};
   },{theme,localDir:__dirname});
   for(const g of design.groups){g.key=crypto.createHash('sha256').update(g.html).digest('hex').slice(0,18);assert(g.width>0&&g.height>0);}
   assert(design.groups.length>3);
   screens.push({id:def.id,title:def.title,route:def.route,state,theme,device:width===390?'phone':'desktop',...design});
  }
  const groups=Object.fromEntries(screens.flatMap(s=>s.groups.map(g=>[g.key,{html:g.html,name:g.name,width:g.width,height:g.height}])));
  const records=screens.map(s=>({...s,groups:s.groups.map(({key,x,y,width,height,name})=>({key,x,y,width,height,name}))}));
  fs.writeFileSync(path.join(__dirname,process.env.BAKERY_AUTH_OUTPUT||'paper-source.json'),JSON.stringify({source:base,generatedAt:new Date().toISOString(),screens:records,groups}));
  console.log(JSON.stringify({screens:records.length,visualGroups:Object.keys(groups).length,placements:records.reduce((n,s)=>n+s.groups.length,0)}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
