const { WebSocket } = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Railway liest Tokens aus Environment Variables
// Format: TOKEN1,_TOKEN2,_TOKEN3 (komma-getrennt)
// Oder: Eine Tokens.txt Datei im Project

const TOKENS_FILE = path.join(__dirname, 'tokens.txt');

// RPC Config
const RPC_CONFIG = {
  state: 'Online via Deathcord',
  details: '24/7 Active',
  largeImageKey: 'deathcord_logo',
  largeImageText: 'Deathcord',
  smallImageKey: 'online',
  smallImageText: 'Online',
  instance: false,
};

const STATUS = 'online';

// Tokens laden
function loadTokens() {
  // Zuerst Environment Variable versuchen (fuer Railway)
  if (process.env.TOKENS) {
    return process.env.TOKENS.split(',').map(t => t.trim()).filter(t => t.length > 20);
  }
  // Sonst tokens.txt
  if (!fs.existsSync(TOKENS_FILE)) {
    console.log('[ERROR] Keine Tokens gefunden!');
    console.log('[ERROR] Setze TOKENS Env Var oder erstelle tokens.txt');
    process.exit(1);
  }
  return fs.readFileSync(TOKENS_FILE, 'utf8')
    .split('\n')
    .map(t => t.trim())
    .filter(t => t && t.length > 20);
}

class DiscordRPC {
  constructor(token, index) {
    this.token = token;
    this.index = index;
    this.ws = null;
    this.sequence = null;
    this.sessionId = null;
    this.heartbeatInterval = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 999;
    this.connected = false;
  }

  getGateway() {
    return new Promise((resolve, reject) => {
      https.get('https://discord.com/api/v9/gateway', (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(JSON.parse(data).url));
      }).on('error', reject);
    });
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
          client_event_source: null
        },
        presence: {
          status: STATUS,
          since: 0,
          activities: [{
            name: 'Custom RPC',
            type: 0,
            state: RPC_CONFIG.state,
            details: RPC_CONFIG.details,
            assets: {
              large_image: RPC_CONFIG.largeImageKey,
              large_text: RPC_CONFIG.largeImageText,
              small_image: RPC_CONFIG.smallImageKey,
              small_text: RPC_CONFIG.smallImageText
            },
            instance: RPC_CONFIG.instance,
            timestamps: { start: Date.now() }
          }],
          afk: false
        },
        compress: false,
        intents: 0
      }
    };
  }

  heartbeat() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ op: 1, d: this.sequence }));
    }
  }

  setPresence() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        op: 3,
        d: {
          status: STATUS,
          since: 0,
          activities: [{
            name: 'Custom RPC',
            type: 0,
            state: RPC_CONFIG.state,
            details: RPC_CONFIG.details,
            assets: {
              large_image: RPC_CONFIG.largeImageKey,
              large_text: RPC_CONFIG.largeImageText,
              small_image: RPC_CONFIG.smallImageKey,
              small_text: RPC_CONFIG.smallImageText
            },
            instance: RPC_CONFIG.instance,
            timestamps: { start: Date.now() }
          }],
          afk: false
        }
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
        this.connected = true;
        this.reconnectAttempts = 0;
      });
      
      this.ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.s !== null) this.sequence = msg.s;
        
        switch (msg.op) {
          case 10:
            if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = setInterval(() => this.heartbeat(), msg.d.heartbeat_interval);
            this.ws.send(JSON.stringify(this.identify()));
            break;
          case 11:
            break;
          case 0:
            if (msg.t === 'READY') {
              this.sessionId = msg.d.session_id;
              console.log(`[Account ${this.index}] READY: ${msg.d.user?.username}`);
              setTimeout(() => this.setPresence(), 2000);
            }
            break;
          case 9:
            console.log(`[Account ${this.index}] Invalid Session - Restart in 5s`);
            this.cleanup();
            setTimeout(() => this.connect(), 5000);
            break;
          case 7:
            console.log(`[Account ${this.index}] Reconnect`);
            this.cleanup();
            setTimeout(() => this.connect(), 1000);
            break;
        }
      });
      
      this.ws.on('close', (code) => {
        console.log(`[Account ${this.index}] Closed: ${code}`);
        this.connected = false;
        this.cleanup();
        
        if (code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60000);
          setTimeout(() => this.connect(), delay);
        }
      });
      
      this.ws.on('error', (err) => {
        console.error(`[Account ${this.index}] Error: ${err.message}`);
      });
      
    } catch (err) {
      console.error(`[Account ${this.index}] Fehler: ${err.message}`);
      setTimeout(() => this.connect(), 5000);
    }
  }

  cleanup() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  disconnect() {
    this.cleanup();
    if (this.ws) {
      this.ws.close(1000);
      this.ws = null;
    }
  }
}

// MAIN
console.log('=== 24/7 Discord RPC (Railway) ===');
const tokens = loadTokens();
console.log(`${tokens.length} Accounts gefunden\n`);

const clients = tokens.map((token, i) => new DiscordRPC(token, i + 1));
clients.forEach(client => client.connect());

process.on('SIGINT', () => {
  console.log('\nShutdown...');
  clients.forEach(client => client.disconnect());
  process.exit(0);
});
