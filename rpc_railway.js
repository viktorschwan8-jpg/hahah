const { Client, RichPresence } = require('discord.js-selfbot-v13');
const fs = require('fs');
const path = require('path');

const TOKENS_FILE = path.join(__dirname, 'tokens.txt');

// RPC Config - identisch zu Vencord CustomRPC
const RPC_CONFIG = {
  APPLICATION_ID: '1539180940050300978',
  name: 'discord.gg/976',
  details: '',
  state: '',
  type: 'LISTENING',
  largeImage: 'https://i.postimg.cc/jSRYrNdC/standard(4).gif',
  largeImageText: 'discord.gg/976',
  smallImage: '',
  smallImageText: '',
  buttons: [
    { label: 'Join 976', url: 'https://discord.gg/976' }
  ],
  startTimestamp: 0,
  endTimestamp: 9999,
};

function loadTokens() {
  if (process.env.TOKENS) {
    return process.env.TOKENS.split(',').map(t => t.trim()).filter(t => t.length > 20);
  }
  if (!fs.existsSync(TOKENS_FILE)) {
    console.log('[ERROR] Keine Tokens gefunden!');
    process.exit(1);
  }
  return fs.readFileSync(TOKENS_FILE, 'utf8')
    .split('\n')
    .map(t => t.trim())
    .filter(t => t && t.length > 20);
}

function createRPC(client) {
  const rpc = new RichPresence(client)
    .setApplicationId(RPC_CONFIG.APPLICATION_ID)
    .setName(RPC_CONFIG.name)
    .setType(RPC_CONFIG.type);

  if (RPC_CONFIG.details) rpc.setDetails(RPC_CONFIG.details);
  if (RPC_CONFIG.state) rpc.setState(RPC_CONFIG.state);
  if (RPC_CONFIG.largeImage) rpc.setAssetsLargeImage(RPC_CONFIG.largeImage);
  if (RPC_CONFIG.largeImageText) rpc.setAssetsLargeText(RPC_CONFIG.largeImageText);
  if (RPC_CONFIG.smallImage) rpc.setAssetsSmallImage(RPC_CONFIG.smallImage);
  if (RPC_CONFIG.smallImageText) rpc.setAssetsSmallText(RPC_CONFIG.smallImageText);
  if (RPC_CONFIG.startTimestamp) rpc.setStartTimestamp(RPC_CONFIG.startTimestamp);
  if (RPC_CONFIG.endTimestamp) rpc.setEndTimestamp(RPC_CONFIG.endTimestamp);
  if (RPC_CONFIG.buttons && RPC_CONFIG.buttons.length > 0) {
    rpc.setButtons(
      ...RPC_CONFIG.buttons.map(b => ({ name: b.label, url: b.url }))
    );
  }

  return rpc;
}

async function startAccount(token, index) {
  const client = new Client({ checkUpdate: false });

  client.on('ready', () => {
    console.log(`[Account ${index}] READY: ${client.user?.username}`);
    const rpc = createRPC(client);
    client.user?.setActivity(rpc);
    console.log(`[Account ${index}] RPC gesetzt!`);
  });

  client.on('error', (err) => {
    console.error(`[Account ${index}] Error: ${err.message}`);
  });

  client.on('disconnect', () => {
    console.log(`[Account ${index}] Disconnected - Reconnect in 5s...`);
    setTimeout(() => {
      client.login(token).catch(e => console.error(`[Account ${index}] Login Fehler:`, e.message));
    }, 5000);
  });

  try {
    await client.login(token);
  } catch (err) {
    console.error(`[Account ${index}] Login Fehler: ${err.message}`);
  }
}

// MAIN
console.log('=== 24/7 Discord RPC (discord.js-selfbot-v13) ===');
const tokens = loadTokens();
console.log(`${tokens.length} Accounts gefunden\n`);

tokens.forEach((token, i) => startAccount(token, i + 1));

process.on('SIGINT', () => {
  console.log('\nShutdown...');
  process.exit(0);
});
