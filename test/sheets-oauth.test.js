const {test}=require('node:test');const assert=require('node:assert/strict');
const {sheetsTokenProvider}=require('../dist/googlesheets/oauth');
const {parseSheetsConnectionString}=require('../dist/googlesheets/parseConnectionString');
const {An5SheetsAdapter}=require('../dist/googlesheets/adapter');
test('Sheets refreshes expired OAuth once for concurrent requests and uses new bearer token',async()=>{
 const config=parseSheetsConnectionString('googlesheets://fixture;accessToken=old;refreshToken=refresh;oauthClientId=client;oauthClientSecret=secret;tokenExpiresAt=0');
 const previous=global.fetch;let refreshes=0;
 global.fetch=async(url,options)=>{
  if(String(url).includes('oauth2.googleapis.com')){refreshes++;assert.equal(new URLSearchParams(options.body).get('refresh_token'),'refresh');await new Promise(resolve=>setTimeout(resolve,5));return Response.json({access_token:'new-token',expires_in:3600})}
  assert.equal(options.headers.Authorization,'Bearer new-token');return Response.json({sheets:[]});
 };
 try{const adapter=new An5SheetsAdapter(config);const api=await adapter.getSheets();await Promise.all([api.spreadsheets.get({}),api.spreadsheets.get({})]);assert.equal(refreshes,1)}finally{global.fetch=previous}
});
test('revoked refresh tokens produce a safe reconnect error and token-only auth stays compatible',async()=>{
 const previous=global.fetch;global.fetch=async()=>new Response('private-fixture',{status:400});
 try{const get=sheetsTokenProvider({spreadsheetId:'fixture',refreshToken:'private-fixture',oauthClientId:'client'});await assert.rejects(get(),error=>/Reconnect/.test(error.message)&&!error.message.includes('private-fixture'));assert.equal(await sheetsTokenProvider({spreadsheetId:'fixture',accessToken:'valid'})(),'valid')}finally{global.fetch=previous}
});
test('Sheets retries an unauthorized request once after refreshing a token',async()=>{
 const previous=global.fetch;let calls=0,refreshes=0;
 global.fetch=async(url,options)=>{
  if(String(url).includes('oauth2.googleapis.com')){refreshes++;return Response.json({access_token:'fresh',expires_in:3600})}
  calls++;if(calls===1)return new Response('',{status:401});
  assert.equal(options.headers.Authorization,'Bearer fresh');return Response.json({sheets:[]});
 };
 try{const api=await new An5SheetsAdapter({spreadsheetId:'fixture',accessToken:'stale',refreshToken:'offline',oauthClientId:'client'}).getSheets();await api.spreadsheets.get({});assert.equal(calls,2);assert.equal(refreshes,1)}finally{global.fetch=previous}
});
test('browser connections accept user tokens and reject desktop or service account credentials',()=>{
 const previous=global.window;global.window={};
 try{
  assert.doesNotThrow(()=>new An5SheetsAdapter({spreadsheetId:'fixture',accessToken:'user-token'}));
  for(const credentials of [{refreshToken:'offline',oauthClientId:'client'},{oauthClientSecret:'desktop-secret',accessToken:'token'},{clientEmail:'fixture@example.test',privateKey:'private-fixture'}]) assert.throws(()=>new An5SheetsAdapter({spreadsheetId:'fixture',...credentials}),/user access token/);
 }finally{if(previous===undefined)delete global.window;else global.window=previous}
});
