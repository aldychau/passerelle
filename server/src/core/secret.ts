import crypto from 'node:crypto';
// SecretBox d’Atelier simplifié : AES-GCM et contexte authentifié, sans comptes.
export class SecretBox {
 constructor(private key: Buffer) { if(key.length!==32) throw new Error('Clé invalide'); }
 seal(value:string,context:string):string {
  const iv=crypto.randomBytes(12), c=crypto.createCipheriv('aes-256-gcm',this.key,iv); c.setAAD(Buffer.from(context));
  return [iv,Buffer.concat([c.update(value,'utf8'),c.final()]),c.getAuthTag()].map(b=>b.toString('base64url')).join('.');
 }
 open(value:string,context:string):string {
  const [iv,data,tag]=value.split('.').map(s=>Buffer.from(s,'base64url'));
  if(!iv||!data||!tag) throw new Error('Secret illisible');
  const c=crypto.createDecipheriv('aes-256-gcm',this.key,iv);c.setAAD(Buffer.from(context));c.setAuthTag(tag);
  return Buffer.concat([c.update(data),c.final()]).toString('utf8');
 }
}
