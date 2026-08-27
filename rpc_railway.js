const { WebSocket } = require('ws');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const TOKENS_FILE = path.join(__dirname, 'tokens.txt');

const RPC_CONFIG = {
  name: 'discord.gg/796',
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

/* ── Quest Worker (REST API) ───────────────────────────────────
   Automatisiert Discord-Quests alle 5 Stunden über die REST API.
   Kein Browser nötig - läuft komplett in Node.js.
────────────────────────────────────────────────────────────── */

const QUEST_CONFIG = {
  enabled: true,
  interval_hours: 5,       // alle 5 Stunden
  video_interval_ms: [7000, 9500],  // Video-Heartbeat Intervall
  max_task_time_ms: 25 * 60 * 1000, // 25 min Timeout pro Quest
  max_failures: 5,
  max_retries: 3,
};

function discordAPI(method, apiPath, token, body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'discord.com',
      path: apiPath,
      method: method,
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    };
    if (data) options.headers['Content-Length'] = Buffer.byteLength(data);

    const req = https.request(options, (res) => {
      let rdata = '';
      res.on('data', (c) => rdata += c);
      res.on('end', () => {
        if (res.statusCode === 429) {
          const retryAfter = JSON.parse(rdata).retry_after || 5;
          console.log(`[Quest] Rate Limited - warte ${retryAfter}s...`);
          setTimeout(() => discordAPI(method, apiPath, token, body).then(resolve).catch(reject), retryAfter * 1000);
          return;
        }
        try {
          const parsed = rdata ? JSON.parse(rdata) : {};
          resolve({ status: res.statusCode, body: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, body: rdata });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('API timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rnd(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function detectQuestType(quest) {
  const cfg = quest.config?.task_config ?? quest.config?.task_config_v2;
  if (!cfg?.tasks) return null;

  const taskKeys = Object.keys(cfg.tasks);
  const typeMap = [
    { match: k => k.includes('VIDEO'), type: 'VIDEO' },
    { match: k => k.startsWith('PLAY'), type: 'GAME' },
    { match: k => k.startsWith('STREAM'), type: 'STREAM' },
    { match: k => k.includes('ACTIVITY'), type: 'ACTIVITY' },
    { match: k => k === 'ACHIEVEMENT_IN_ACTIVITY', type: 'ACHIEVEMENT' },
  ];

  for (const { match, type } of typeMap) {
    const keyName = taskKeys.find(match);
    if (keyName) {
      return {
        type, keyName,
        target: cfg.tasks[keyName]?.target ?? 0,
        appId: cfg.tasks[keyName]?.applications?.[0]?.id ?? quest.config?.application?.id ?? null,
      };
    }
  }
  return null;
}

async function runVideoQuest(token, quest, typeData, index) {
  const questId = quest.id;
  const questName = quest.config?.messages?.quest_name ?? 'Unknown';
  let cur = quest.user_status?.progress?.[typeData.keyName]?.value ?? 0;
  let failCount = 0;
  const startTime = Date.now();

  console.log(`[Account ${index}] [Quest] VIDEO "${questName}" - Ziel: ${typeData.target}s`);

  while (cur < typeData.target) {
    const delayMs = rnd(...QUEST_CONFIG.video_interval_ms);
    await sleep(delayMs);

    const elapsedSec = (delayMs / 1000) + (Math.random() * 0.02 - 0.01);
    cur += elapsedSec;
    const payloadTs = Number(Math.min(typeData.target, cur).toFixed(6));

    try {
      const r = await discordAPI('POST', `/api/v9/quests/${questId}/video-progress`, token, { timestamp: payloadTs });
      failCount = 0;
      if (r.status === 200) {
        const serverVal = r.body?.progress?.[typeData.keyName]?.value;
        if (serverVal > cur) cur = Math.min(typeData.target, serverVal);
        if (r.body?.completed_at) break;
      }
    } catch (e) {
      failCount++;
      if (failCount >= QUEST_CONFIG.max_failures) {
        console.log(`[Account ${index}] [Quest] VIDEO "${questName}" - Zu viele Fehler, überspringe`);
        return false;
      }
    }

    if (Date.now() - startTime > QUEST_CONFIG.max_task_time_ms) {
      console.log(`[Account ${index}] [Quest] VIDEO "${questName}" - Timeout`);
      return false;
    }
  }

  console.log(`[Account ${index}] [Quest] VIDEO "${questName}" - FERTIG!`);
  return true;
}

async function runHeartbeatQuest(token, quest, typeData, index) {
  const questId = quest.id;
  const questName = quest.config?.messages?.quest_name ?? 'Unknown';
  let cur = quest.user_status?.progress?.[typeData.keyName]?.value ?? 0;
  let failCount = 0;
  const startTime = Date.now();

  console.log(`[Account ${index}] [Quest] ${typeData.type} "${questName}" - Ziel: ${typeData.target}`);

  while (cur < typeData.target) {
    await sleep(rnd(19000, 22000));

    try {
      const r = await discordAPI('POST', `/api/v9/quests/${questId}/heartbeat`, token, {
        stream_key: null,
        application_id: String(typeData.appId || ''),
        terminal: false,
      });

      if (r.status === 200) {
        const reported = r.body?.progress?.[typeData.keyName]?.value;
        if (typeof reported === 'number') cur = reported;
        failCount = 0;
        if (cur >= typeData.target) break;
      } else if (r.status >= 400 && r.status < 500) {
        console.log(`[Account ${index}] [Quest] ${typeData.type} "${questName}" - HTTP ${r.status}, überspringe`);
        return false;
      }
    } catch (e) {
      failCount++;
      if (failCount >= QUEST_CONFIG.max_failures) {
        console.log(`[Account ${index}] [Quest] ${typeData.type} "${questName}" - Zu viele Fehler`);
        return false;
      }
    }

    if (Date.now() - startTime > QUEST_CONFIG.max_task_time_ms) {
      console.log(`[Account ${index}] [Quest] ${typeData.type} "${questName}" - Timeout`);
      return false;
    }
  }

  console.log(`[Account ${index}] [Quest] ${typeData.type} "${questName}" - FERTIG!`);
  return true;
}

async function claimReward(token, questId, index) {
  try {
    const r = await discordAPI('POST', `/api/v9/quests/${questId}/claim-reward`, token, {
      platform: 0, location: 11, is_targeted: false,
      metadata_sealed: null, traffic_metadata_sealed: null,
    });
    if (r.body?.claimed_at) {
      console.log(`[Account ${index}] [Quest] Reward geclaimed!`);
      return true;
    }
  } catch (e) {
    console.log(`[Account ${index}] [Quest] Claim fehlgeschlagen: ${e.message}`);
  }
  return false;
}

async function processQuests(token, index) {
  if (!QUEST_CONFIG.enabled) return;

  console.log(`\n[Account ${index}] [Quest] === Quest-Runde gestartet ===`);

  try {
    // Quests abrufen
    const r = await discordAPI('GET', '/api/v9/quests/@me', token);
    if (r.status !== 200) {
      console.log(`[Account ${index}] [Quest] Quests nicht verfügbar (HTTP ${r.status})`);
      return;
    }

    // API-Antwort kann quests als Array oder als Object enthalten
    let quests = [];
    if (Array.isArray(r.body)) {
      quests = r.body;
    } else if (r.body?.quests && Array.isArray(r.body.quests)) {
      quests = r.body.quests;
    } else if (typeof r.body === 'object') {
      quests = Object.values(r.body).filter(q => q && typeof q === 'object' && q.id);
    }

    quests = quests.filter(q => q && !q.user_status?.completed_at && q.id);

    console.log(`[Account ${index}] [Quest] ${quests.length} aktive Quest(s) gefunden`);

    if (!quests.length) {
      console.log(`[Account ${index}] [Quest] Keine verfügbaren Quests`);
      return;
    }

    console.log(`[Account ${index}] [Quest] ${quests.length} Quest(s) gefunden`);

    let completed = 0;
    for (const quest of quests) {
      const typeData = detectQuestType(quest);
      if (!typeData) {
        console.log(`[Account ${index}] [Quest] Unbekannter Typ: ${quest.config?.messages?.quest_name ?? quest.id}`);
        continue;
      }

      // Quest enrollen wenn nötig
      if (!quest.user_status?.enrolled_at) {
        try {
          await discordAPI('POST', `/api/v9/quests/${quest.id}/enroll`, token, {});
          await sleep(rnd(2000, 4000));
        } catch (e) { /* ignore */ }
      }

      let success = false;
      if (typeData.type === 'VIDEO') {
        success = await runVideoQuest(token, quest, typeData, index);
      } else {
        // GAME/STREAM/ACTIVITY/ACHIEVEMENT brauchen Browser-Spoofing
        // which is not possible via REST API alone. Skip these.
        console.log(`[Account ${index}] [Quest] "${quest.config?.messages?.quest_name}" - Typ "${typeData.type}" braucht Browser, überspringe`);
        continue;
      }

      if (success) {
        await sleep(rnd(2500, 5000));
        await claimReward(token, quest.id, index);
        completed++;
      }

      await sleep(rnd(3000, 6000));
    }

    console.log(`[Account ${index}] [Quest] Runde beendet: ${completed}/${quests.length} abgeschlossen`);
  } catch (e) {
    console.log(`[Account ${index}] [Quest] Fehler: ${e.message}`);
  }
}

// Quest-Worker für alle Tokens
async function runQuestCycle(allTokens) {
  console.log(`\n[Quest Worker] Starte Quest-Zyklus für ${allTokens.length} Account(s)...`);
  for (let i = 0; i < allTokens.length; i++) {
    await processQuests(allTokens[i], i + 1);
    await sleep(rnd(5000, 10000)); // Pause zwischen Accounts
  }
  console.log(`[Quest Worker] Zyklus abgeschlossen. Nächster in ${QUEST_CONFIG.interval_hours}h`);
}

// ═══════════════════════════════════════════════════════════════

console.log('=== 24/7 Discord RPC ===');
console.log('RPC CONFIG:', JSON.stringify(RPC_CONFIG, null, 2));
if (VOICE_CONFIG.enabled) console.log('VOICE: Aktiviert (random Server + VC)');
if (QUEST_CONFIG.enabled) console.log(`QUESTS: Aktiviert (alle ${QUEST_CONFIG.interval_hours}h)`);
const tokens = loadTokens();
console.log(`${tokens.length} Account(s)\n`);
const clients = tokens.map((t, i) => new DiscordRPC(t, i + 1));
clients.forEach((c, i) => setTimeout(() => c.connect(), i * 2000));

// Quest-Worker: Start + alle 5 Stunden
if (QUEST_CONFIG.enabled && tokens.length > 0) {
  // Erste Runde nach 30 Sekunden (damit die Verbindungen erst aufgebaut werden)
  setTimeout(() => runQuestCycle(tokens), 30000);
  // Dann alle 5 Stunden
  setInterval(() => runQuestCycle(tokens), QUEST_CONFIG.interval_hours * 60 * 60 * 1000);
}

process.on('SIGINT', () => { clients.forEach(c => c.disconnect()); process.exit(0); });
