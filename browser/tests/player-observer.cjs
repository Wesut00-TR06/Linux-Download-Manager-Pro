const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const messages = [];
class XHR {
  addEventListener(_, cb){this.loaded=cb;}
  open(){return 'original-open';}
}
const window = {addEventListener(){},postMessage:m=>messages.push(m)};
const context = vm.createContext({window,XMLHttpRequest:XHR,URL,TextDecoder,Uint8Array,JSON,atob,setInterval(){},
 location:{href:'https://river-3-329.kinescopecdn.net/embed',origin:'https://river-3-329.kinescopecdn.net'}});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../chromium/player-manifest-observer.js'),'utf8'),context);
const xhr=new XHR();
assert.equal(xhr.open('GET','/opaque'),'original-open');
xhr.status=200;xhr.responseURL='https://cdn.example/opaque';xhr.responseType='';
xhr.responseText='<html>not a playlist</html>';xhr.loaded();assert.equal(messages.length,0);
xhr.responseText='#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nsegment.png\n';
xhr.loaded();assert.equal(messages[0].url,xhr.responseURL);
xhr.status=403;xhr.loaded();assert.equal(messages.length,1);

// Test Kinescope encrypted payload decoding
const key = "RySdvcyu5iTUxn97vn4HwoniwgxaCynA";
const playlist = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttps://kinescopecdn.net/seg1.ts\n";
const bytes = Buffer.from(playlist, 'utf8');
const enc = Buffer.alloc(bytes.length);
for (let i = 0; i < bytes.length; i++) {
  enc[i] = bytes[i] ^ key.charCodeAt(i % key.length);
}
const b64 = enc.toString('base64');
const p = b64.split('').reverse().join('');
xhr.status=200;
xhr.responseURL='https://river-1-216.kinescopecdn.net/index.m3u8';
xhr.responseText=JSON.stringify({p, v: 1});
xhr.loaded();
assert.equal(messages.length, 2);
assert.equal(messages[1].url, 'https://river-1-216.kinescopecdn.net/index.m3u8');

console.log('Playlist body and Kinescope decryption checks passed.');
