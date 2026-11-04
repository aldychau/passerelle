import { createApp,HOST,PORT } from './app.js';
import { Store } from './store.js';
const store=await Store.open();
const {app}=await createApp(store);
await app.listen({host:HOST,port:PORT});
console.log('Passerelle : https://localhost:3030');
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{void app.close();});
