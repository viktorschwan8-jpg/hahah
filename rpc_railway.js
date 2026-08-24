const { WebSocket } = require('ws');
const https = require('https');
const fs = require('fs');
const path = require('path');

const TOKENS_FILE = path.join(__dirname, 'tokens.txt');

const RPC_CONFIG = {
  name: 'discord.gg/976',
  type: 0,
  details: '',
  state: '',
  application_id: '',
  assets: {},
  buttons: [],
  button_urls: [],
};

const VOICE_CONFIG = {
  enabled: true,
  self_mute: false,
  self_deaf: false,
  rotate_minutes: 20,
};

const STATUS = 'dnd';

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

function discordGet(token, apiPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'discord.com',
      path: apiPath,
      method: 'GET',
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else if (res.statusCode === 429) {
          const retryAfter = JSON.parse(data).retry_after || 5;
          console.log(`[Voice] Rate Limited - warte ${retryAfter}s...`);
          setTimeout(() => discordGet(token, apiPath).then(resolve).catch(reject), retryAfter * 1000);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getGuilds(token) {
  const guilds = await discordGet(token, '/api/v9/users/@me/guilds');
  return guilds;
}

async function getVoiceChannels(token, guildId) {
  const channels = await discordGet(token, `/api/v9/guilds/${guildId}/channels`);
  return channels.filter(c => c.type === 2);
}

async function joinRandomVoiceChannel(token, index) {
  try {
    const guilds = await getGuilds(token);
    if (!guilds || guilds.length === 0) {
      console.log(`[Account ${index}] Keine Server gefunden`);
      return null;
    }

    const randomGuild = guilds[Math.floor(Math.random() * guilds.length)];
    console.log(`[Account ${index}] Server: ${randomGuild.name} (${randomGuild.id})`);

    const voiceChannels = await getVoiceChannels(token, randomGuild.id);
    if (!voiceChannels || voiceChannels.length === 0) {
      console.log(`[Account ${index}] Keine Voice Channels in ${randomGuild.name}`);
      return null;
    }

    // Shuffle channels
    const shuffled = voiceChannels.sort(() => Math.random() - 0.5);
    return { guildId: randomGuild.id, channels: shuffled, guildName: randomGuild.name };
  } catch (err) {
    console.error(`[Account ${index}] Voice Fehler: ${err.message}`);
    return null;
  }
}

class DiscordRPC {
  constructor(token, index) {
    this.token = token;
    this.index = index;
    this.ws = null;
    this.seq = null;
    this.heartbeatInterval = null;
    this.reconnectAttempts = 0;
    this.currentGuildId = null;
    this.currentChannelId = null;
    this.userId = null;
    this.voiceRotateTimer = null;
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
      state: RPC_CONFIG.state || undefined,
      details: RPC_CONFIG.details || undefined,
    };

    if (RPC_CONFIG.application_id) {
      activity.application_id = RPC_CONFIG.application_id;
    }
    if (RPC_CONFIG.assets && Object.keys(RPC_CONFIG.assets).length > 0) {
      activity.assets = RPC_CONFIG.assets;
    }
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

  voiceJoin(guildId, channelId) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        op: 4,
        d: {
          guild_id: guildId,
          channel_id: channelId,
          self_mute: VOICE_CONFIG.self_mute,
          self_deaf: VOICE_CONFIG.self_deaf,
        },
      }));
      this.currentGuildId = guildId;
      this.currentChannelId = channelId;
    }
  }

  voiceLeave() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        op: 4,
        d: {
          guild_id: null,
          channel_id: null,
          self_mute: false,
          self_deaf: false,
        },
      }));
      this.currentGuildId = null;
      this.currentChannelId = null;
    }
  }

  async joinRandomVC() {
    if (!VOICE_CONFIG.enabled) return;

    if (this.voiceRotateTimer) clearTimeout(this.voiceRotateTimer);
    this.voiceLeave();

    const info = await joinRandomVoiceChannel(this.token, this.index);
    if (!info) return;

    const MAX_ATTEMPTS = Math.min(info.channels.length, 8);
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const vc = info.channels[i];
      console.log(`[Account ${this.index}] Versuch ${i+1}/${MAX_ATTEMPTS}: ${vc.name} @ ${info.guildName}`);
      this.voiceJoin(info.guildId, vc.id);

      // Wait 3 seconds to check if join was successful
      await new Promise(r => setTimeout(r, 3000));

      if (this.currentChannelId) {
        console.log(`[Account ${this.index}] ERFOLG: ${vc.name} @ ${info.guildName}`);
        const rotateMs = VOICE_CONFIG.rotate_minutes * 60 * 1000;
        this.voiceRotateTimer = setTimeout(() => {
          console.log(`[Account ${this.index}] Rotation nach ${VOICE_CONFIG.rotate_minutes}min - neuer Server...`);
          this.joinRandomVC();
        }, rotateMs);
        return;
      }
      console.log(`[Account ${this.index}] Konnte nicht rein - naechster Channel...`);
    }
    console.log(`[Account ${this.index}] Kein Channel funktioniert in ${info.guildName} - naechster Server in 30s...`);
    setTimeout(() => this.joinRandomVC(), 30000);
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
              this.userId = msg.d.user?.id;
              console.log(`[Account ${this.index}] READY: ${msg.d.user?.username}`);
              setTimeout(() => this.setPresence(), 2000);
              if (VOICE_CONFIG.enabled) {
                setTimeout(() => this.joinRandomVC(), 4000);
              }
            }
            if (msg.t === 'VOICE_STATE_UPDATE' && msg.d.user_id === this.userId) {
              if (msg.d.channel_id === null && this.currentChannelId) {
                console.log(`[Account ${this.index}] Aus Voice gekickt/disconnectet - neuer Join in 10s...`);
                this.currentGuildId = null;
                this.currentChannelId = null;
                setTimeout(() => this.joinRandomVC(), 10000);
              }
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
        this.reconnectAttempts++;
        const delay = Math.min(3000 * this.reconnectAttempts, 60000);
        console.log(`[Account ${this.index}] Reconnect in ${delay/1000}s...`);
        setTimeout(() => this.connect(), delay);
      });

      this.ws.on('error', (err) => console.error(`[Account ${this.index}] Error: ${err.message}`));
    } catch (err) {
      console.error(`[Account ${this.index}] Fehler: ${err.message}`);
      setTimeout(() => this.connect(), 5000);
    }
  }

  cleanup() {
    if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }
    if (this.voiceRotateTimer) { clearTimeout(this.voiceRotateTimer); this.voiceRotateTimer = null; }
  }

  disconnect() {
    this.cleanup();
    this.ws?.close(1000);
  }
}

console.log('=== 24/7 Discord RPC ===');
console.log('RPC CONFIG:', JSON.stringify(RPC_CONFIG, null, 2));
if (VOICE_CONFIG.enabled) console.log('VOICE: Aktiviert (random Server + VC)');
const tokens = loadTokens();
console.log(`${tokens.length} Account(s)\n`);
const clients = tokens.map((t, i) => new DiscordRPC(t, i + 1));
clients.forEach((c, i) => setTimeout(() => c.connect(), i * 2000));

process.on('SIGINT', () => { clients.forEach(c => c.disconnect()); process.exit(0); });
