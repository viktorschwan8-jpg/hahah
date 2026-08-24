const fs = require('fs');
const https = require('https');

const tokens = fs.readFileSync('tokens.txt', 'utf8')
  .split('\n').map(t => t.trim()).filter(t => t && t.length > 20);

function getUserInfo(token) {
  return new Promise((resolve, reject) => {
    const req = https.get('https://discord.com/api/v9/users/@me', {
      headers: { Authorization: token }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
  });
}

async function main() {
  for (let i = 0; i < tokens.length; i++) {
    const info = await getUserInfo(tokens[i]);
    if (info && info.username) {
      const displayName = info.global_name || info.username;
      console.log(`Account ${i+1}: ${displayName} (@${info.username})`);
    } else {
      console.log(`Account ${i+1}: [Token ungültig]`);
    }
  }
}

main();