import { resolve } from 'node:path';
import { createService } from './service.mjs';
import { createHttpServer } from './http.mjs';
import { firebaseIdentity } from './firebase-identity.mjs';

if(process.argv.length>2)throw new Error('Unsupported startup argument. Configure the server through its environment.');
if(process.env.K_SERVICE)throw new Error('Run the stateless hosting relay on Cloud Run. Keep this SQLite API on a single host with a durable disk.');
if(process.env.CLINCH_PUBLIC_ORIGIN&&!process.env.CLINCH_DB)throw new Error('Set CLINCH_DB to the database on your durable disk.');
const host=process.env.CLINCH_HOST??'127.0.0.1';
const port=Number(process.env.CLINCH_PORT??8787);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('CLINCH_PORT must be between 1 and 65535.');
const dbPath=resolve(process.env.CLINCH_DB??'data/clinch.sqlite');
try{
  const useFirebase=process.env.CLINCH_AUTH_PROVIDER==='firebase';
  if(process.env.CLINCH_AUTH_PROVIDER && !['firebase','local'].includes(process.env.CLINCH_AUTH_PROVIDER))throw new Error('Unknown authentication provider.');
  if(useFirebase && process.env.CLINCH_PUBLIC_ORIGIN && process.env.FIREBASE_AUTH_EMULATOR_HOST)throw new Error('Hosted authentication requires the configured Firebase project.');
  const identity=useFirebase?await firebaseIdentity({projectId:process.env.GOOGLE_CLOUD_PROJECT,apiKey:process.env.CLINCH_FIREBASE_API_KEY,emulatorHost:process.env.FIREBASE_AUTH_EMULATOR_HOST}):null;
  const service=await createService({dbPath,ownerPassword:process.env.CLINCH_OWNER_PASSWORD,ownerEmail:process.env.CLINCH_OWNER_EMAIL,identity});
  const webRoot=process.env.CLINCH_WEB_ROOT?resolve(process.env.CLINCH_WEB_ROOT):undefined;
  const server=createHttpServer({service,host,...(webRoot?{webRoot}:{}),publicOrigin:process.env.CLINCH_PUBLIC_ORIGIN,upstreamHost:process.env.CLINCH_UPSTREAM_HOST,relaySecret:process.env.CLINCH_RELAY_SECRET});
  server.listen(port,host,()=>console.log(`Clinch Study Hub: http://${host==='::1'?'[::1]':host}:${port}\nDatabase: ${dbPath}`));
  const shutdown=()=>server.close(()=>{service.close();process.exit(0);});
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
  server.on('error',error=>{console.error(error.message);service.close();process.exitCode=1;});
}catch(error){console.error(error.message);process.exitCode=1;}
