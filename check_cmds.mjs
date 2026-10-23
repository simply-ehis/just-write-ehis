const fs = require('fs');
const api = fs.readFileSync('src/lib/api.ts', 'utf-8');
const cmds = [...api.matchAll(/safeInvoke(?:<[\s\S]{0,400}?>)?\(\s*"([a-z0-9_]+)"/g)].map(m => m[1]);
console.log('tts_stream commands:', cmds.filter(c => c.includes('tts_stream')));
console.log('tts_render_set_speed:', cmds.filter(c => c.includes('tts_render_set_speed')));