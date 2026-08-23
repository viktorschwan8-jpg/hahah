# 24/7 Discord RPC

## Lokal starten (PC)
```cmd
cd D:\247selfbot
node rpc.js
```

Oder doppelklick auf `start_rpc.bat`

## Auf Railway deployen

### Schritt 1: GitHub Repo erstellen
1. Gehe zu https://github.com/new
2. Name: z.B. `247selfbot`
3. Public oder Private
4. "Create repository"

### Schritt 2: Dateien hochladen
```cmd
cd D:\247selfbot
git init
git add .
git commit -m "init"
git remote add origin https://github.com/DEIN_USERNAME/247selfbot.git
git push -u origin main
```

ACHTUNG: Benenne `package_railway.json` in `package.json` um VOR dem Push!
(Da rpc_railway.js der Hauptscript fuer Railway ist)

### Schritt 3: Railway Projekt
1. Gehe zu https://railway.com/new
2. "Deploy from GitHub Repo"
3. Wähle dein Repo aus
4. Environment Variable setzen:
   - Name: `TOKENS`
   - Wert: Token1,Token2,Token3... (alle Tokens komma-getrennt)
5. Deploy!

## RPC Config anpassen
In `rpc.js` oder `rpc_railway.js`:
```js
const RPC_CONFIG = {
  state: 'Online via Deathcord',
  details: '24/7 Active',
  largeImageKey: 'deathcord_logo',
  largeImageText: 'Deathcord',
  smallImageKey: 'online',
  smallImageText: 'Online',
  instance: false,
};

const STATUS = 'online'; // online, idle, dnd, invisible
```

## Troubleshooting
- Tokens in accsliste.txt pruefen
- Bei Railway: Tokens als Environment Variable setzen
- Console-Logs pruefen
