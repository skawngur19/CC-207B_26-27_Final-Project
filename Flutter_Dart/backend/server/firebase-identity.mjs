import { ApiError } from './service.mjs';

// Credentials and network access are only used when the operator selects this provider.
export async function firebaseIdentity({projectId,apiKey,emulatorHost}) {
  if (!projectId || !apiKey) throw new Error('Firebase authentication requires a project ID and Web API key.');
  if (emulatorHost && !/^(localhost|127\.0\.0\.1):\d+$/.test(emulatorHost)) throw new Error('The Auth emulator must use loopback.');
  const [{initializeApp},{getAuth}]=await Promise.all([import('firebase-admin/app'),import('firebase-admin/auth')]);
  const admin=getAuth(initializeApp({projectId}));
  const url=(emulatorHost?'http://'+emulatorHost+'/identitytoolkit.googleapis.com':'https://identitytoolkit.googleapis.com')+'/v1/accounts:signInWithPassword?key='+encodeURIComponent(apiKey);
  return {
    async login(email,password) {
      const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({email,password,returnSecureToken:true}),signal:AbortSignal.timeout(10000)});
      if (!response.ok) {
        if (response.status>=500)throw new ApiError(503,'IDENTITY_UNAVAILABLE','The identity service is temporarily unavailable.');
        throw new ApiError(401,'INVALID_CREDENTIALS','Email, password, or selected role is incorrect.');
      }
      const {idToken}=await response.json();
      const decoded=await admin.verifyIdToken(idToken,true);
      return {uid:decoded.uid,authTime:decoded.auth_time};
    },
    async active(uid,authTime) {
      try {
        const user=await admin.getUser(uid);
        return !user.disabled && (!user.tokensValidAfterTime || Math.floor(Date.parse(user.tokensValidAfterTime)/1000)<=authTime);
      } catch(e) {
        if(e.code==='auth/user-not-found')return false;
        throw new ApiError(503,'IDENTITY_UNAVAILABLE','Identity verification is temporarily unavailable.');
      }
    },
    async create({id,email,name,password}) {
      try { await admin.createUser({uid:id,email,password,displayName:name}); }
      catch(e) {
        if(e.code==='auth/email-already-exists')throw new ApiError(409,'EMAIL_EXISTS','An account already uses that email.');
        throw new ApiError(503,'IDENTITY_UNAVAILABLE','The identity service could not provision the account.');
      }
    },
    async rollback(id) { await admin.deleteUser(id); }
  };
}
