import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { get } from 'node:https';
process.chdir(path.resolve(import.meta.dirname,'..'));
if(Number(process.versions.node.split('.')[0])<24)throw new Error('Node.js 24 ou supérieur est nécessaire.');
const sources=['shared/src','server/src','web/src','server/vite.config.ts','web/vite.config.ts','web/index.html','package-lock.json','package.json','tsconfig.base.json','server/tsconfig.json','web/tsconfig.json','shared/tsconfig.json'];
function newest(file){const s=statSync(file);return s.isDirectory()?Math.max(s.mtimeMs,...readdirSync(file).map(n=>newest(path.join(file,n)))):s.mtimeMs;}
const command=process.platform==='win32'?'cmd.exe':'sh';
function npm(args){return spawn(command,process.platform==='win32'?['/d','/s','/c',`npm ${args}`]:['-c',`npm ${args}`],{stdio:'inherit',windowsHide:true});}
function wait(child){return new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('Commande interrompue. Voir le message ci-dessus.')));});}
if(!existsSync('node_modules')){
 console.log('Premier lancement : téléchargement des dépendances (npm ci). Une connexion Internet est nécessaire. Patientez…');
 await wait(npm('ci'));
}
if(!existsSync('server/dist/index.js')||!existsSync('web/dist/index.html')||Math.max(...sources.map(newest))>Math.min(statSync('server/dist/index.js').mtimeMs,statSync('web/dist/index.html').mtimeMs)){
 console.log('Préparation de Passerelle…');await wait(npm('run build'));
}
const server=npm('start'),serverDone=wait(server).then(()=>null,error=>error);let exited=false;server.on('exit',()=>{exited=true;});
for(let attempt=0;attempt<60&&!exited;attempt++){
 try{const ca=readFileSync(path.join(process.env.PASSERELLE_DATA ?? path.join(process.env.LOCALAPPDATA ?? '.', 'Passerelle'),'tls','cert.pem'));
  const ready=await new Promise((resolve,reject)=>{const request=get('https://127.0.0.1:3030/api/session',{ca,timeout:1000},response=>{response.resume();resolve(response.statusCode===200);});request.on('timeout',()=>request.destroy(new Error('Timeout')));request.on('error',reject);});if(ready){
  const open=spawn('cmd.exe',['/d','/c','start','','https://localhost:3030'],{stdio:'ignore',windowsHide:true});open.on('error',()=>console.log('Ouvrez https://localhost:3030 dans votre navigateur.'));open.unref();break;
 }}catch{}
 await new Promise(resolve=>setTimeout(resolve,500));
}
console.log('Gardez cette fenêtre ouverte. Fermez-la ou appuyez sur Ctrl+C pour arrêter Passerelle.');
const error=await serverDone;if(error)throw error;
