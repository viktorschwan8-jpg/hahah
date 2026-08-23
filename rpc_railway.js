const { WebSocket } = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

const TOKENS_FILE = path.join(__dirname, 'tokens.txt');

const RPC_CONFIG = {
  name: 'discord.gg/976',
  type: 0,
  details: '24/7 Active',
  state: 'discord.gg/976',
  application_id: '',
  assets: {},
  buttons: [],
  button_urls: [],
};

const STATUS = 'online';

function loadTokens() {
  if (process.env.TOKENS) {
    return process.env.TOKENS.split(',').map(t => t.trim()).filter(t => t.length > 20);
  }
  if (!fs.existsSync(TOKENS_FILE)) {
    console.log('[ERROR] Keine Tokens!');
    process.exit(1);
  }
  return fs.readFileSync(TOKENS_FILE, 'utf8')
    .split('\n').map(t => t.trim()).filter(t => t && t.length > 20);
}

class DiscordRPC {
  constructor(token, index) {
    this.token = token;
    this.index = index;
    this.ws = null;
    this.seq = null;
    this.heartbeatInterval = null;
    this.reconnectAttempts = 0;
  }

  getGateway() {
    return new Promise((resolve, reject) => {
      https.get('https://discord.com/api/v9/gateway', (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(JSON.parse(data).url));
      }).on('error', reject);
    });
  }

  buildActivity() {
    const activity = {
      name: RPC_CONFIG.name,
      type: RPC_CONFIG.type,
      application_id: RPC_CONFIG.application_id,
      state: RPC_CONFIG.state || undefined,
      details: RPC_CONFIG.details || undefined,
      assets: RPC_CONFIG.assets,
      flags: 1 << 0,
    };

    if (RPC_CONFIG.buttons && RPC_CONFIG.buttons.length > 0) {
      activity.buttons = RPC_CONFIG.buttons.map((label, i) => ({ label, url: RPC_CONFIG.button_urls[i] }));
      activity.metadata = { button_urls: RPC_CONFIG.button_urls };
    }

    return activity;
  }

  identify() {
    return {
      op: 2,
      d: {
        token: this.token,
        capabilities: 253,
        properties: {
          os: 'windows',
          browser: 'chrome',
          device: 'deathcord-247',
          system_locale: 'de',
          browser_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          browser_version: '120.0.0.0',
          os_version: '10',
          referrer: '',
          referring_domain: '',
          release_channel: 'stable',
          client_build_number: 252039,
          client_event_source: null,
        },
        presence: {
          status: STATUS,
          since: 0,
          activities: [this.buildActivity()],
          afk: false,
        },
        compress: false,
        intents: 0,
      },
    };
  }

  heartbeat() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ op: 1, d: this.seq }));
    }
  }

  setPresence() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        op: 3,
        d: {
          status: STATUS,
          since: 0,
          activities: [this.buildActivity()],
          afk: false,
        },
      }));
      console.log(`[Account ${this.index}] RPC gesetzt!`);
    }
  }

  async connect() {
    try {
      const url = await this.getGateway();
      console.log(`[Account ${this.index}] Verbinde...`);
      this.ws = new WebSocket(`${url}?v=9&encoding=json`);

      this.ws.on('open', () => {
        console.log(`[Account ${this.index}] Verbunden!`);
        this.reconnectAttempts = 0;
      });

      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.s !== null) this.seq = msg.s;

        switch (msg.op) {
          case 10:
            if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = setInterval(() => this.heartbeat(), msg.d.heartbeat_interval);
            this.ws.send(JSON.stringify(this.identify()));
            break;
          case 0:
            if (msg.t === 'READY') {
              console.log(`[Account ${this.index}] READY: ${msg.d.user?.username}`);
              setTimeout(() => this.setPresence(), 2000);
            }
            break;
          case 9:
            console.log(`[Account ${this.index}] Invalid Session - Restart 5s`);
            this.cleanup();
            setTimeout(() => this.connect(), 5000);
            break;
          case 7:
            this.cleanup();
            setTimeout(() => this.connect(), 1000);
            break;
        }
      });

      this.ws.on('close', (code) => {
        console.log(`[Account ${this.index}] Closed: ${code}`);
        this.cleanup();
        if (code !== 1000) {
          this.reconnectAttempts++;
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60000);
          setTimeout(() => this.connect(), delay);
        }
      });

      this.ws.on('error', (err) => console.error(`[Account ${this.index}] Error: ${err.message}`));
    } catch (err) {
      console.error(`[Account ${this.index}] Fehler: ${err.message}`);
      setTimeout(() => this.connect(), 5000);
    }
  }

  cleanup() {
    if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }
  }

  disconnect() {
    this.cleanup();
    this.ws?.close(1000);
  }
}

console.log('=== 24/7 Discord RPC ===');
console.log('RPC CONFIG:', JSON.stringify(RPC_CONFIG, null, 2));
const tokens = loadTokens();
console.log(`${tokens.length} Account(s)\n`);
const clients = tokens.map((t, i) => new DiscordRPC(t, i + 1));
clients.forEach(c => c.connect());

process.on('SIGINT', () => { clients.forEach(c => c.disconnect()); process.exit(0); });
