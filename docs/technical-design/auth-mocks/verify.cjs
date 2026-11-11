const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const base = process.env.BAKERY_AUTH_BASE || 'http://127.0.0.1:8799/auth-mocks/index.html';
(async () => {
 const browser = await chromium.launch();
 const page = await browser.newPage();
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 let cases=0; const captures=[];
 try {
  await page.goto(base+'?screen=1&theme=light#login');
  const screens=await page.evaluate(()=>SCREENS.map(s=>({id:s.id,states:s.states})));
  for (const width of [320,390,744,1280,1440]) {
   await page.setViewportSize({width,height:width<744?844:960});
   for (const {id,states} of screens) {
    for (const state of (width===320||width===1440?states:['default'])) {
     await page.goto(base+'?screen=1&theme=light#'+id+'/'+state);
     await page.waitForFunction(({id,state})=>document.querySelector('#app').dataset.screen===id&&document.querySelector('#app').dataset.state===state,{id,state});
     await page.evaluate(()=>document.fonts.ready);
     await page.evaluate(()=>Promise.all([...document.querySelectorAll('#app img')].map(i=>i.decode())));
     const result=await page.evaluate(()=>({
      heading:document.querySelector('#app h1')?.textContent,
      overflow:document.documentElement.scrollWidth-innerWidth,
      missingImages:[...document.querySelectorAll('#app img')].filter(i=>!i.complete||!i.naturalWidth).length,
      badLinks:[...document.querySelectorAll('#app a[href^="#"],#app [data-go]')].map(e=>e.dataset.go||e.getAttribute('href').slice(1)).filter(t=>!SCREENS.some(s=>s.id===t.split('/')[0])),
      unlabeled:[...document.querySelectorAll('#app input,#app select')].filter(i=>!i.labels?.length&&!i.getAttribute('aria-label')).length
     }));
     assert(result.heading,id+'/'+state+' missing heading');
     assert(result.overflow<=1,id+'/'+state+' overflows at '+width+': '+result.overflow);
     assert.equal(result.missingImages,0,id+' missing image');
     assert.deepEqual(result.badLinks,[],id+' invalid flow link');
     assert.equal(result.unlabeled,0,id+' unlabeled input');
     cases++;
     if(state==='default'&&(width===390||width===1440)){
      const image=id+'-'+(width===390?'phone':'desktop')+'.png';
      await page.screenshot({path:path.join(__dirname,image),fullPage:true});
      captures.push(image);
     }
    }
   }
  }
  for(const width of [320,768,1440]){
   await page.setViewportSize({width,height:960});
   for(const id of screens.map(s=>s.id)){
    await page.goto(base+'?screen=1&theme=dark&rtl=1&long=1&pseudo=1#'+id);
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);
    assert(overflow<=1,id+' dark/RTL/expanded overflow at '+width);cases++;
   }
  }
  await page.setViewportSize({width:390,height:844});
  await page.goto(base+'?screen=1#login');
  await page.locator('#field-email').fill('alex@example.com');
  await page.locator('#field-current-password').fill('example-only-password');
  await page.getByRole('button',{name:'Show password',exact:true}).click();
  assert.equal(await page.locator('#field-current-password').getAttribute('type'),'text');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.waitForFunction(hash => location.hash === hash, '#organizations');
  await page.goto(base+'?screen=1#invite');
  await page.getByRole('button',{name:'Create your account',exact:true}).click();
  await page.waitForFunction(hash => location.hash === hash, '#register');
  await page.locator('#field-name').fill('Alex Morgan');
  await page.locator('#field-new-password').fill('example-only-password');
  await page.getByRole('button',{name:'Create account',exact:true}).click();
  await page.waitForFunction(hash => location.hash === hash, '#verify');
  await page.getByRole('link',{name:'Preview: open verification link'}).click();
  await page.getByRole('button',{name:'Continue to invitation'}).click();
  await page.getByRole('button',{name:'Accept invitation',exact:true}).click();
  await page.waitForFunction(hash => location.hash === hash, '#invite/accepted');
  await page.goto(base+'?screen=1#forgot');
  await page.locator('#field-email').fill('alex@example.com');
  await page.getByRole('button',{name:'Send reset link'}).click();
  await page.waitForFunction(hash => location.hash === hash, '#forgot/sent');
  await page.getByRole('link',{name:'Preview: open reset link'}).click();
  await page.locator('#field-new-password').fill('another-example-password');
  await page.getByRole('button',{name:'Update password'}).click();
  await page.waitForFunction(hash => location.hash === hash, '#reset/success');
  await page.goto(base+'?screen=1#consent');
  await page.getByRole('button',{name:'Deny',exact:true}).click();
  await page.waitForFunction(hash => location.hash === hash, '#consent/denied');
  await page.goto(base+'?screen=1#sessions');
  await page.getByRole('button',{name:'Sign out all other sessions'}).click();
  await page.getByRole('button',{name:'Sign out 2 sessions'}).click();
  await page.waitForFunction(hash => location.hash === hash, '#revoke/success');
  for(const width of [320,390,1440]){
   await page.setViewportSize({width,height:960});
   await page.goto(base+'#login');
   await page.waitForFunction(()=>window.bakeryAuthReady);
   await page.locator('#screen-select').selectOption('invite');
   await page.waitForFunction(hash => location.hash === hash, '#invite');
   await page.locator('#state-select').selectOption('expired');
   await page.waitForFunction(hash => location.hash === hash, '#invite/expired');
   assert((await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth))<=1,'gallery overflows '+width);
   assert([844,960].includes(await page.locator('#preview').evaluate(e=>e.getBoundingClientRect().height)),'preview must retain a fixed device height');
   await page.screenshot({path:path.join(__dirname,'gallery-'+width+'.png'),fullPage:true});
  }
  assert.deepEqual(errors,[]);
  const result={checkedAt:new Date().toISOString(),screens:screens.length,states:screens.reduce((n,s)=>n+s.states.length,0),layoutCases:cases,widths:[320,390,744,1280,1440],stress:'Dark, RTL, long names and expanded text at 320, 768, 1440',interactions:['password reveal','sign in','invitation registration and acceptance','password recovery','OAuth denial','session revocation','gallery navigation'],captures,errors};
  fs.writeFileSync(path.join(__dirname,'verification.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({...result,captures:captures.length}));
 } finally {await browser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
