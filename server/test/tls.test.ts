import { it,expect,vi } from 'vitest';
import { mkdtempSync,readFileSync,writeFileSync,rmSync,unlinkSync,statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { get } from 'node:https';
import { execFileSync } from 'node:child_process';
import { localTls } from '../src/tls.js';
import { Store } from '../src/store.js';
import { createApp,HOST,PORT } from '../src/app.js';

it.skipIf(process.platform!=='win32')('restreint les ACL Windows, y compris une clé réutilisée avec des droits partagés',()=>{
 const directory=mkdtempSync(path.join(tmpdir(),"passerelle tls ' ACL-"));
 const aclScript=(script:string)=>execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
  "$ErrorActionPreference='Stop'; $root=[Console]::In.ReadToEnd(); $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; "+script
 ],{input:directory,encoding:'utf8',windowsHide:true});
 const check=()=>{
  const result=JSON.parse(aclScript(`
   $result=@(foreach($p in @('tls','tls/key.pem')){
    $acl=Get-Acl -LiteralPath (Join-Path $root $p)
    $rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))
    [pscustomobject]@{OnlyUser=($rules.Count -gt 0 -and @($rules | Where-Object {$_.IdentityReference -ne $sid -or $_.AccessControlType -ne 'Allow'}).Count -eq 0); Protected=$acl.AreAccessRulesProtected}
   }); ConvertTo-Json -InputObject $result
  `));
  expect(result.map((entry:{OnlyUser:boolean})=>entry.OnlyUser)).toEqual([true,true]);
  expect(result[0].Protected).toBe(true);
 };
 try{
  const first=localTls(directory);check();
  aclScript(`
   foreach($p in @('tls','tls/key.pem')){
    $target=Join-Path $root $p; $acl=Get-Acl -LiteralPath $target
    $everyone=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($everyone,'ReadAndExecute','Allow')))
    if($p -eq 'tls'){[System.IO.Directory]::SetAccessControl($target,$acl)}
    else{[System.IO.File]::SetAccessControl($target,$acl)}
   }
  `);
  expect(localTls(directory)).toEqual(first);check();
 }finally{rmSync(directory,{recursive:true,force:true});}
},30000);

it('génère, réutilise et renouvelle une paire locale valide',()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'passerelle-tls-'));
 try{
  const first=localTls(directory),certificate=new X509Certificate(first.cert);
  expect(certificate.subject).toBe('CN=localhost');
  expect(certificate.subjectAltName).toBe('DNS:localhost, IP Address:127.0.0.1');
  expect(certificate.publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
  expect(Date.parse(certificate.validTo)-Date.parse(certificate.validFrom)).toBe(825*86400000);
  expect(localTls(directory)).toEqual(first);
  if(process.platform!=='win32')expect(statSync(path.join(directory,'tls/key.pem')).mode&0o777).toBe(0o600);
  for(const days of [796,826]){
   const previous=localTls(directory);
   vi.spyOn(Date,'now').mockReturnValue(Date.parse(new X509Certificate(previous.cert).validFrom)+days*86400000);
   const renewed=localTls(directory);vi.restoreAllMocks();
   expect(renewed.cert).not.toBe(previous.cert);
  }
  writeFileSync(path.join(directory,'tls/cert.pem'),'invalid');
  const repaired=localTls(directory);expect(()=>new X509Certificate(repaired.cert)).not.toThrow();
  unlinkSync(path.join(directory,'tls/key.pem'));expect(localTls(directory).cert).not.toBe(repaired.cert);
  expect(readFileSync(path.join(directory,'tls/key.pem'),'utf8')).toContain('PRIVATE KEY');
 }finally{vi.restoreAllMocks();rmSync(directory,{recursive:true,force:true});}
});

it('écoute en TLS sur la boucle locale et redirige les pages IP avant OAuth',async()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'passerelle-listen-')),memory=await Store.open('memory://');
 const {app}=await createApp(new Store(memory.db,memory.secrets,directory));
 try{
  await app.listen({host:HOST,port:0});
  expect(PORT).toBe(3030);
  expect(app.server.address()).toMatchObject({address:'127.0.0.1',family:'IPv4'});
  const response=await new Promise<{status:number|undefined;body:string}>((resolve,reject)=>{
   const address=app.server.address();if(!address||typeof address==='string')throw new Error('Missing socket');
   get('https://127.0.0.1:'+address.port+'/api/session',{ca:readFileSync(path.join(directory,'tls/cert.pem')),headers:{host:'127.0.0.1:3030'}},res=>{
    let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body}));
   }).on('error',reject);
  });
  expect(response.status).toBe(200);expect(JSON.parse(response.body).callback).toBe('https://localhost:3030/oauth/etsy/callback');
  const ip={host:'127.0.0.1:3030'};
  for(const url of ['/','/index.html?x=1','/oauth/etsy/callback?state=x&code=y','//evil.test/path']){
   const redirect=await app.inject({url,headers:ip});expect(redirect.statusCode).toBe(302);expect(redirect.headers.location).toBe('https://localhost:3030'+url);
  }
  expect((await app.inject({url:'/',headers:{host:'localhost:3030'}})).statusCode).toBe(200);
  const session=await app.inject({url:'/api/session',headers:ip});expect(session.statusCode).toBe(200);
  expect((await app.inject({method:'POST',url:'/api/shops',headers:{...ip,origin:'http://127.0.0.1:3030','x-csrf-token':session.json().csrf},payload:{}})).statusCode).toBe(403);
 }finally{await app.close();rmSync(directory,{recursive:true,force:true});}
});
