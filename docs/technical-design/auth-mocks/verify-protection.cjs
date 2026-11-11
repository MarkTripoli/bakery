// Mock-flow checks only. No authentication service or real credential ceremony is called.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('@playwright/test');
const base='http://127.0.0.1:8799/auth-mocks/index.html';
(async()=>{
 const browser=await chromium.launch(),context=await browser.newContext({permissions:['clipboard-read','clipboard-write']}),page=await context.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const at=hash=>page.waitForFunction(h=>location.hash==='#'+h,hash);
 try{
  await page.setViewportSize({width:390,height:844});await page.goto(base+'?screen=1#two-factor');
  await page.getByRole('button',{name:'Set up authenticator',exact:true}).click();
  await page.locator('#field-current-password').fill('mock-password');await page.getByRole('button',{name:'Continue',exact:true}).click();await at('totp-setup/scan');
  const code=page.locator('#verification-code');assert.equal(await code.getAttribute('inputmode'),'numeric');assert.equal(await code.getAttribute('autocomplete'),'one-time-code');assert.equal(await code.getAttribute('type'),'text');
  assert(await page.locator('.totp-qr').evaluate(i=>i.complete&&i.naturalWidth>0));
  await page.screenshot({path:path.join(__dirname,'totp-scan-phone.png'),fullPage:true});
  await code.fill('012345');assert.equal(await code.inputValue(),'012345');await page.getByRole('button',{name:'Verify and turn on',exact:true}).click();await at('backup-codes');
  assert.equal(await page.locator('.backup-code').count(),8);await page.getByRole('button',{name:'Copy codes',exact:true}).click();await page.getByRole('button',{name:'Copied',exact:true}).waitFor();
  assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/sample codes, not valid for sign-in/);
  const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Download codes',exact:true}).click()]);assert.equal(download.suggestedFilename(),'bakery-demo-backup-codes.txt');
  await page.getByRole('button',{name:'I’ve saved these codes',exact:true}).click();await at('two-factor/enabled');
  // Enabling the mock factor adds its challenge after a password sign-in.
  await page.getByRole('link',{name:'Account and security',exact:true}).click();await page.getByRole('link',{name:'Sign out of this session',exact:true}).click();await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.locator('#field-email').fill('alex@example.com');await page.locator('#field-current-password').fill('mock-password');await page.getByRole('button',{name:'Sign in',exact:true}).click();await at('totp-challenge');
  await page.getByRole('link',{name:'Use a backup code',exact:true}).click();await page.locator('#field-backup-code').fill('h7mk2-9pvx4');await page.getByRole('button',{name:'Verify and sign in',exact:true}).click();await at('organizations');
  // A pending invitation survives the additional factor.
  await page.goto(base+'?screen=1#two-factor/enabled');await page.evaluate(()=>location.hash='invite-login');await at('invite-login');await page.locator('#field-current-password').fill('mock-password');await page.getByRole('button',{name:'Sign in and continue',exact:true}).click();await at('totp-challenge');await page.locator('#verification-code').fill('012345');await page.getByRole('button',{name:'Verify and sign in',exact:true}).click();await at('invite/authenticated');
  await page.goto(base+'?screen=1#backup-codes/regenerate');assert.equal(await page.locator('input[required]').count(),2);await page.getByRole('link',{name:'Cancel',exact:true}).click();await at('two-factor/enabled');
  await page.goto(base+'?screen=1#passkeys');await page.getByRole('button',{name:'Add a passkey',exact:true}).click();await page.locator('#field-current-password').fill('mock-password');await page.getByRole('button',{name:'Continue',exact:true}).click();await at('passkey-add/prompt');
  // The handoff is native: the browser's own prompt completes this step, so the artboard carries no Bakery control for it, only the cancel path.
  assert.equal(await page.getByRole('button',{name:/device check/i}).count(),0);await page.getByRole('link',{name:'Cancel',exact:true}).waitFor();await page.evaluate(()=>location.hash='passkey-add/success');await at('passkey-add/success');await page.getByRole('button',{name:'Manage passkeys',exact:true}).click();await at('passkeys/enabled');
  await page.getByRole('link',{name:'Remove',exact:true}).click();await page.locator('#field-current-password').fill('mock-password');await page.getByRole('button',{name:'Remove passkey',exact:true}).click();await at('passkeys');
  await page.goto(base+'?screen=1#passkeys/blocked');assert.equal(await page.getByRole('button',{name:'Remove passkey',exact:true}).count(),0);
  for(const [id,state] of [['totp-setup','scan'],['totp-challenge','invalid'],['passkeys','enabled']]){
   await page.goto(base+'?screen=1&theme=dark#'+id+'/'+state);await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:path.join(__dirname,id+'-'+state+'-dark-phone.png'),fullPage:true});
  }
  assert.deepEqual(errors,[]);const result={checkedAt:new Date().toISOString(),scope:'Design mocks only',checks:['TOTP setup','six-digit input semantics','leading zeros','backup copy','backup download','saved acknowledgement','post-password factor','backup-code sign-in','invitation continuity','regeneration cancellation','native passkey handoff','passkey removal','last-method guard'],errors};fs.writeFileSync(path.join(__dirname,'protection-verification.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
