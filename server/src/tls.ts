import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate,createPrivateKey } from 'node:crypto';
import selfsigned from 'selfsigned';
import { execFileSync } from 'node:child_process';

function restrictWindowsTls(directory:string,keyFile:string){
 execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`
 $ErrorActionPreference='Stop'
 $paths=([Console]::In.ReadToEnd() | ConvertFrom-Json)
 $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
 foreach($target in $paths){
  if(!(Test-Path -LiteralPath $target)){continue}
  $item=Get-Item -LiteralPath $target
  if($item.PSIsContainer){
   $acl=New-Object System.Security.AccessControl.DirectorySecurity
   $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit, ObjectInherit','None','Allow')
  }else{
   $acl=New-Object System.Security.AccessControl.FileSecurity
   $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')
  }
  $acl.SetAccessRuleProtection($true,$false)
  $acl.AddAccessRule($rule)
  if($item.PSIsContainer){[System.IO.Directory]::SetAccessControl($target,$acl)}
  else{[System.IO.File]::SetAccessControl($target,$acl)}
 }
 `],{input:JSON.stringify([directory,keyFile]),windowsHide:true,stdio:['pipe','pipe','pipe']});
}

export function localTls(location:string){
 const directory=path.join(location,'tls'),certFile=path.join(directory,'cert.pem'),keyFile=path.join(directory,'key.pem');
 if(location!=='memory://'){
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  // Protect existing keys before reading or replacing them; new files inherit this ACL.
  if(process.platform==='win32')restrictWindowsTls(directory,keyFile);
 }
 if(location!=='memory://')try{
  const cert=fs.readFileSync(certFile,'utf8'),key=fs.readFileSync(keyFile,'utf8'),certificate=new X509Certificate(cert);
  if(Date.parse(certificate.validTo)>Date.now()+30*86400000&&Date.parse(certificate.validFrom)<=Date.now()&&certificate.checkHost('localhost')&&certificate.checkIP('127.0.0.1')&&certificate.checkPrivateKey(createPrivateKey(key))){
   fs.chmodSync(keyFile,0o600);
   return {cert,key};
  }
 }catch{/* Missing, unreadable or invalid pair: replace both files. */}
 const generated=selfsigned.generate([{name:'commonName',value:'localhost'}],{keySize:2048,algorithm:'sha256',days:825,extensions:[{name:'basicConstraints',cA:true},{name:'keyUsage',digitalSignature:true,keyEncipherment:true,keyCertSign:true},{name:'extKeyUsage',serverAuth:true},{name:'subjectAltName',altNames:[{type:2,value:'localhost'},{type:7,ip:'127.0.0.1'}]}]});
 if(location!=='memory://'){
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  fs.writeFileSync(keyFile,generated.private,{mode:0o600});
  fs.chmodSync(keyFile,0o600);
  fs.writeFileSync(certFile,generated.cert);
 }
 return {cert:generated.cert,key:generated.private};
}
