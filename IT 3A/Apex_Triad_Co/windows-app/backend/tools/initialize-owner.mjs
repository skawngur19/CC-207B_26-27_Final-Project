import {createService} from '../server/service.mjs';
import {existsSync, mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

if (process.platform!=='win32') throw Error('Initialize this installation from Windows.');
const root=fileURLToPath(new URL('../',import.meta.url));
const data=join(root,'data');
const dbPath=process.env.CLINCH_DB??join(data,'clinch.sqlite');
const handoff=process.env.CLINCH_OWNER_ACCESS_FILE??join(data,'owner-access.xml');
mkdirSync(data,{recursive:true});
process.env.CLINCH_OWNER_ACCESS_FILE=handoff;
const newOwner=!existsSync(handoff);
if (newOwner && existsSync(dbPath)) throw Error('This database already exists. Use its existing Owner account.');
// Only Windows reads and writes the DPAPI credential. Never pass passwords in
// a process argument, print them to logs, or embed a bootstrap key in a client.
const generate=newOwner?{email:'owner-'+randomBytes(8).toString('hex')+'@clinch.invalid',
  password:randomBytes(24).toString('base64url')}:null;
const writeCredential=`
  $record=[Console]::In.ReadToEnd() | ConvertFrom-Json
  $secret=ConvertTo-SecureString $record.password -AsPlainText -Force
  $c=[System.Management.Automation.PSCredential]::new($record.email,$secret)
  $c | Export-Clixml -LiteralPath $env:CLINCH_OWNER_ACCESS_FILE -NoClobber
`;
const readCredential=`
  $c=Import-Clixml -LiteralPath $env:CLINCH_OWNER_ACCESS_FILE
  [Console]::Write((@{email=$c.UserName;password=$c.GetNetworkCredential().Password} | ConvertTo-Json -Compress))
`;
const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
  "$ErrorActionPreference='Stop';"+(generate?writeCredential:'')+readCredential],{
  cwd:root,input:generate?JSON.stringify(generate):'',encoding:'utf8',windowsHide:true});
if(result.status!==0) throw Error('Windows could not protect or read the Owner credentials for this user.');
const {email,password}=JSON.parse(result.stdout);
if (!email || !password) throw Error('Windows could not unlock the saved Owner credentials.');
const service=await createService({dbPath,ownerEmail:email,ownerPassword:password});
try {
  // Re-running this operation verifies the saved credential. It cannot reset an existing Owner.
  for (const client of ['browser','native']) {
    const session=await service.login({role:'owner',email,password,client});
    if(service.authenticate(session.token,client).user.id!=='owner') throw Error('Unexpected account binding.');
    service.logout(session.token);
  }
  console.log('Owner credentials verified for the website and Windows app. Use View Connected Demo Login.cmd to read them.');
} finally { service.close(); }
