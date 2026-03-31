const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;

// ── Polyfill fetch untuk Node < 18 ──
async function fetchJson(url, options) {
  return new Promise((resolve, reject) => {
    const body = options && options.body ? options.body : null;
    const reqOptions = {
      method: (options && options.method) || 'GET',
      headers: (options && options.headers) || {},
    };
    if(body) reqOptions.headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request(url, reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode < 400, status: res.statusCode, json: () => JSON.parse(data) }); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    if(body) req.write(body);
    req.end();
  });
}

// ── JSONBin config ──
// Daftar gratis di jsonbin.io, buat bin baru, copy BIN_ID dan API_KEY
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID || 'GANTI_BIN_ID';
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY || 'GANTI_API_KEY';
const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;

// ── In-memory cache ──
let dbCache = null;

function log(tag, msg) {
    const time = new Date().toLocaleTimeString('id-ID');
    console.log(`[${time}] ${tag} ${msg}`);
}

async function readDB() {
    if (dbCache) return dbCache;
    try {
        const res = await fetchJson(JSONBIN_URL + '/latest', {
            headers: { 'X-Master-Key': JSONBIN_API_KEY }
        });
        const json = res.json();
        dbCache = json.record || { users: [], orders: [], chats: {}, bookings: [] };
        return dbCache;
    } catch(e) {
        log('[readDB] ERROR', e.message);
        return { users: [], orders: [], chats: {}, bookings: [] };
    }
}

async function writeDB(data) {
    dbCache = data;
    try {
        await fetchJson(JSONBIN_URL, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Master-Key': JSONBIN_API_KEY
            },
            body: JSON.stringify(data)
        });
    } catch(e) {
        log('[writeDB] ERROR', e.message);
    }
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    log('→', `${req.method} ${req.url}`);

    // ── GET ALL DATA (light - tanpa foto untuk polling) ──
    if (req.url === '/get-data' && req.method === 'GET') {
        try {
            const data = await readDB();
            const chatRooms = Object.keys(data.chats || {}).length;
            const totalMsg  = Object.values(data.chats || {}).reduce((s, arr) => s + arr.length, 0);
            log('[get-data]', `users:${data.users.length} orders:${data.orders.length} chat_rooms:${chatRooms} total_msg:${totalMsg}`);

            // Strip foto dari users untuk hemat bandwidth polling
            const lightData = {
                ...data,
                users: (data.users || []).map(u => {
                    const { photo, ...rest } = u;
                    return { ...rest, hasPhoto: !!photo };
                }),
                // Strip foto dari chat messages juga
                chats: Object.fromEntries(
                    Object.entries(data.chats || {}).map(([roomId, msgs]) => [
                        roomId,
                        msgs.map(m => m.type === 'photo' ? { ...m, data: null, thumbnail: (m.data||'').slice(0,100) } : m)
                    ])
                )
            };

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(lightData));
        } catch(e) {
            log('[get-data] ERROR', e.message);
            res.writeHead(500); res.end(JSON.stringify({ status: 'error' }));
        }
        return;
    }

    // ── GET FULL DATA (dengan foto - untuk load awal) ──
    if (req.url === '/get-data-full' && req.method === 'GET') {
        try {
            const data = await readDB();
            log('[get-data-full]', `users:${data.users.length}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        } catch(e) {
            log('[get-data-full] ERROR', e.message);
            res.writeHead(500); res.end(JSON.stringify({ status: 'error' }));
        }
        return;
    }

    // ── SAVE ALL DATA ──
    if (req.url === '/save-data' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const incoming = JSON.parse(body);
                const db = await readDB();

                if (incoming.users && incoming.users.length > 0) {
                    const existing = db.users || [];
                    incoming.users.forEach(inUser => {
                        const idx = existing.findIndex(u => u.wallet === inUser.wallet);
                        if (idx === -1) existing.push(inUser);
                        else existing[idx] = { ...existing[idx], ...inUser };
                    });
                    db.users = existing;
                }

                if (incoming.orders && incoming.orders.length > 0) {
                    const existing = db.orders || [];
                    incoming.orders.forEach(inOrder => {
                        const idx = existing.findIndex(o => o.id === inOrder.id);
                        if (idx === -1) existing.push(inOrder);
                        else existing[idx] = { ...existing[idx], ...inOrder };
                    });
                    db.orders = existing;
                }

                if (incoming.bookings) db.bookings = incoming.bookings;

                await writeDB(db);
                log('[save-data]', `users:${db.users.length} orders:${db.orders.length}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok' }));
            } catch(e) {
                log('[save-data] ERROR', e.message);
                res.writeHead(400); res.end(JSON.stringify({ status: 'error', msg: e.message }));
            }
        });
        return;
    }

    // ── SEND CHAT MESSAGE ──
    if (req.url === '/send-chat' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { orderId, msg } = JSON.parse(body);
                if (!orderId) throw new Error('Missing orderId');
                if (!msg || !msg.text) throw new Error('Missing msg');

                const db = await readDB();
                if (!db.chats) db.chats = {};
                if (!db.chats[orderId]) db.chats[orderId] = [];
                db.chats[orderId].push(msg);
                await writeDB(db);

                const total = db.chats[orderId].length;
                log('[send-chat] ✅', `room:${orderId.slice(-6)} dari:"${msg.senderNama}" teks:"${(msg.text||'').slice(0,30)}" | total: ${total}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok', total }));
            } catch(e) {
                log('[send-chat] ERROR', e.message);
                res.writeHead(400); res.end(JSON.stringify({ status: 'error', msg: e.message }));
            }
        });
        return;
    }

    // ── SAVE ALAMAT ──
    if (req.url === '/save-alamat' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { wallet, alamatDetail } = JSON.parse(body);
                if (!wallet) throw new Error('Missing wallet');
                const db = await readDB();
                const idx = db.users.findIndex(u => u.wallet === wallet);
                if (idx !== -1) {
                    db.users[idx].alamatDetail = alamatDetail;
                    const a = alamatDetail;
                    db.users[idx].alamat = [a.kota, a.provinsi].filter(Boolean).join(', ') || db.users[idx].alamat;
                    await writeDB(db);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'ok' }));
                } else {
                    throw new Error('User tidak ditemukan');
                }
            } catch(e) {
                log('[save-alamat] ERROR', e.message);
                res.writeHead(400); res.end(JSON.stringify({ status: 'error', msg: e.message }));
            }
        });
        return;
    }

    res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
    console.log(`🚀 TukangChan Server aktif di port ${PORT}`);
    console.log(`📦 JSONBin ID: ${JSONBIN_BIN_ID}`);
});
