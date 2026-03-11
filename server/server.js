const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// DB setup
const dbPath = path.join(__dirname, 'data', 'beats.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS beats (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    artist_name TEXT NOT NULL,
    artist_email TEXT NOT NULL,
    file_url TEXT,
    sent_at INTEGER DEFAULT (unixepoch()),
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    beat_id TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT,
    ip TEXT,
    user_agent TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (beat_id) REFERENCES beats(id)
  );

  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    beat_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    original_path TEXT,
    size INTEGER,
    uploaded_at INTEGER DEFAULT (unixepoch())
  );
`);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../dashboard')));

// ─── Pixel tracking (email open) ──────────────────────────────────
app.get('/t/:beatId/open.gif', (req, res) => {
  const { beatId } = req.params;
  const beat = db.prepare('SELECT id FROM beats WHERE id = ?').get(beatId);
  if (beat) {
    db.prepare(`INSERT INTO events (beat_id, type, ip, user_agent) VALUES (?, 'email_open', ?, ?)`)
      .run(beatId, req.ip, req.get('user-agent') || '');
  }
  // Return 1x1 transparent GIF
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache' });
  res.send(gif);
});

// ─── Download tracking ────────────────────────────────────────────
app.get('/t/:beatId/download/:fileId', (req, res) => {
  const { beatId, fileId } = req.params;
  const file = db.prepare('SELECT * FROM files WHERE id = ? AND beat_id = ?').get(fileId, beatId);
  if (!file) return res.status(404).json({ error: 'File not found' });

  db.prepare(`INSERT INTO events (beat_id, type, data, ip, user_agent) VALUES (?, 'download', ?, ?, ?)`)
    .run(beatId, JSON.stringify({ fileId, filename: file.filename }), req.ip, req.get('user-agent') || '');

  res.redirect(`/files/${fileId}/${file.filename}`);
});

// ─── Audio play tracking ──────────────────────────────────────────
app.post('/t/:beatId/play', (req, res) => {
  const { beatId } = req.params;
  const { fileId, percent, duration, action } = req.body; // action: start | progress | end
  db.prepare(`INSERT INTO events (beat_id, type, data, ip, user_agent) VALUES (?, 'play', ?, ?, ?)`)
    .run(beatId, JSON.stringify({ fileId, percent, duration, action }), req.ip, req.get('user-agent') || '');
  res.json({ ok: true });
});

// ─── Link click tracking ──────────────────────────────────────────
app.get('/t/:beatId/click', (req, res) => {
  const { beatId } = req.params;
  const { url } = req.query;
  db.prepare(`INSERT INTO events (beat_id, type, data, ip, user_agent) VALUES (?, 'click', ?, ?, ?)`)
    .run(beatId, JSON.stringify({ url }), req.ip, req.get('user-agent') || '');
  res.redirect(url || '/');
});

// ─── API: Create beat send ────────────────────────────────────────
app.post('/api/beats', (req, res) => {
  const { title, artist_name, artist_email, notes, files } = req.body;
  const id = uuidv4();
  db.prepare('INSERT INTO beats (id, title, artist_name, artist_email, notes) VALUES (?, ?, ?, ?, ?)')
    .run(id, title, artist_name, artist_email, notes || '');

  const fileRecords = [];
  if (files && files.length) {
    for (const f of files) {
      const fid = uuidv4();
      db.prepare('INSERT INTO files (id, beat_id, filename, original_path, size) VALUES (?, ?, ?, ?, ?)')
        .run(fid, id, f.filename, f.path || '', f.size || 0);
      fileRecords.push({ id: fid, filename: f.filename, downloadUrl: `${BASE_URL}/t/${id}/download/${fid}` });
    }
  }

  res.json({
    id,
    trackingPixel: `${BASE_URL}/t/${id}/open.gif`,
    downloadLinks: fileRecords,
    playerUrl: `${BASE_URL}/listen/${id}`,
    clickUrl: (url) => `${BASE_URL}/t/${id}/click?url=${encodeURIComponent(url)}`
  });
});

// ─── API: Get all beats ───────────────────────────────────────────
app.get('/api/beats', (req, res) => {
  const beats = db.prepare('SELECT * FROM beats ORDER BY sent_at DESC').all();
  const result = beats.map(b => {
    const events = db.prepare('SELECT * FROM events WHERE beat_id = ? ORDER BY created_at DESC').all(b.id);
    const files = db.prepare('SELECT * FROM files WHERE beat_id = ?').all(b.id);

    const emailOpens = events.filter(e => e.type === 'email_open');
    const downloads = events.filter(e => e.type === 'download');
    const plays = events.filter(e => e.type === 'play');
    const playStarts = plays.filter(e => { try { return JSON.parse(e.data)?.action === 'start'; } catch { return false; } });
    const playEnds = plays.filter(e => { try { return JSON.parse(e.data)?.action === 'end'; } catch { return false; } });
    const maxPercent = plays.reduce((max, e) => {
      try { const d = JSON.parse(e.data); return Math.max(max, d?.percent || 0); } catch { return max; }
    }, 0);

    return {
      ...b,
      files: files.map(f => ({ ...f, downloadUrl: `${BASE_URL}/t/${b.id}/download/${f.id}` })),
      stats: {
        email_opens: emailOpens.length,
        last_open: emailOpens[0]?.created_at || null,
        downloads: downloads.length,
        last_download: downloads[0]?.created_at || null,
        play_count: playStarts.length,
        completed_plays: playEnds.length,
        max_listen_percent: maxPercent,
        last_play: plays[0]?.created_at || null,
      },
      events: events.slice(0, 50)
    };
  });
  res.json(result);
});

// ─── API: Get single beat ─────────────────────────────────────────
app.get('/api/beats/:id', (req, res) => {
  const beat = db.prepare('SELECT * FROM beats WHERE id = ?').get(req.params.id);
  if (!beat) return res.status(404).json({ error: 'Not found' });
  const events = db.prepare('SELECT * FROM events WHERE beat_id = ? ORDER BY created_at DESC').all(beat.id);
  const files = db.prepare('SELECT * FROM files WHERE beat_id = ?').all(beat.id);
  res.json({ ...beat, events, files: files.map(f => ({ ...f, downloadUrl: `${BASE_URL}/t/${beat.id}/download/${f.id}` })) });
});

// ─── Generate email template ──────────────────────────────────────
app.post('/api/beats/:id/email-template', (req, res) => {
  const beat = db.prepare('SELECT * FROM beats WHERE id = ?').get(req.params.id);
  if (!beat) return res.status(404).json({ error: 'Not found' });
  const files = db.prepare('SELECT * FROM files WHERE beat_id = ?').all(beat.id);

  const downloadLinks = files.map(f =>
    `<a href="${BASE_URL}/t/${beat.id}/download/${f.id}" style="display:inline-block;margin:8px 0;padding:10px 20px;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:4px;font-family:monospace">⬇ ${f.filename}</a>`
  ).join('<br>');

  const playerLink = `${BASE_URL}/listen/${beat.id}`;
  const pixel = `<img src="${BASE_URL}/t/${beat.id}/open.gif" width="1" height="1" style="display:none" alt="">`;

  const html = `${pixel}
<div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#f0f0f0;padding:40px;border-radius:12px">
  <p style="font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#666;margin:0 0 8px">Nouvelle production</p>
  <h1 style="font-size:28px;font-weight:800;margin:0 0 32px;color:#fff">${beat.title}</h1>
  <p style="color:#aaa;line-height:1.6;margin:0 0 28px">${req.body.message || `Salut ${beat.artist_name},\n\nJe t'envoie cette nouvelle prod. Écoute et dis-moi ce que t'en penses.`}</p>
  <a href="${playerLink}" style="display:inline-block;padding:14px 28px;background:#fff;color:#000;text-decoration:none;border-radius:6px;font-weight:700;font-size:14px;letter-spacing:1px;margin-bottom:24px">▶ ÉCOUTER EN LIGNE</a>
  <br>
  ${downloadLinks}
  <hr style="border:none;border-top:1px solid #222;margin:32px 0">
  <p style="font-size:11px;color:#444;margin:0">Beat ID: ${beat.id.slice(0, 8)}</p>
</div>`;

  res.json({ html, subject: `New Beat: ${beat.title}` });
});

// ─── Listener page (hosted audio player) ─────────────────────────
app.get('/listen/:beatId', (req, res) => {
  const beat = db.prepare('SELECT * FROM beats WHERE id = ?').get(req.params.beatId);
  if (!beat) return res.status(404).send('Not found');
  const files = db.prepare('SELECT * FROM files WHERE beat_id = ?').all(beat.id);

  const audioItems = files.map(f => `{id:"${f.id}",name:"${f.filename.replace(/"/g, '')}"}`).join(',');

  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${beat.title}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0a0a0a;color:#fff;font-family:'Helvetica Neue',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
  .card{background:#111;border:1px solid #1e1e1e;border-radius:16px;padding:40px;max-width:480px;width:90%}
  .label{font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#555;margin-bottom:8px}
  h1{font-size:26px;font-weight:800;margin-bottom:32px}
  .track{background:#0a0a0a;border:1px solid #1e1e1e;border-radius:10px;padding:20px;margin-bottom:12px;cursor:pointer;transition:border-color .2s}
  .track:hover{border-color:#333}
  .track.active{border-color:#4ade80}
  .track-name{font-size:14px;font-weight:600;margin-bottom:12px}
  .controls{display:flex;align-items:center;gap:12px}
  .play-btn{width:36px;height:36px;border-radius:50%;background:#4ade80;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0}
  .progress-bar{flex:1;height:4px;background:#222;border-radius:2px;cursor:pointer;position:relative}
  .progress-fill{height:100%;background:#4ade80;border-radius:2px;width:0%;transition:width .1s}
  .time{font-size:11px;color:#555;font-variant-numeric:tabular-nums}
  .download-btn{display:block;margin-top:8px;padding:8px 0;font-size:12px;color:#555;text-decoration:none;letter-spacing:1px;text-transform:uppercase;transition:color .2s;text-align:center}
  .download-btn:hover{color:#fff}
</style>
</head>
<body>
<div class="card">
  <div class="label">Nouvelle production</div>
  <h1>${beat.title}</h1>
  <div id="tracks"></div>
</div>
<script>
const BASE='${BASE_URL}';
const BEAT_ID='${beat.id}';
const FILES=[${audioItems}];
let currentAudio=null, currentId=null, reported={};

function fmt(s){const m=Math.floor(s/60);return m+':'+(Math.floor(s%60)+'').padStart(2,'0')}
function track(action,fileId,percent,duration){
  fetch(BASE+'/t/'+BEAT_ID+'/play',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({fileId,percent,duration,action})}).catch(()=>{});
}

FILES.forEach(f=>{
  const el=document.createElement('div');
  el.className='track';
  el.id='track-'+f.id;
  el.innerHTML='<div class="track-name">'+f.name+'</div><div class="controls"><button class="play-btn" id="btn-'+f.id+'">▶</button><div class="progress-bar" id="pb-'+f.id+'"><div class="progress-fill" id="pf-'+f.id+'"></div></div><span class="time" id="tm-'+f.id+'">0:00</span></div><a class="download-btn" href="'+BASE+'/t/'+BEAT_ID+'/download/'+f.id+'">⬇ Télécharger</a>';
  document.getElementById('tracks').appendChild(el);

  const audio=new Audio(BASE+'/files/'+f.id+'/'+f.name);
  const btn=document.getElementById('btn-'+f.id);
  const pf=document.getElementById('pf-'+f.id);
  const pb=document.getElementById('pb-'+f.id);
  const tm=document.getElementById('tm-'+f.id);

  btn.addEventListener('click',()=>{
    if(currentAudio&&currentAudio!==audio){currentAudio.pause();document.getElementById('btn-'+currentId).textContent='▶';document.getElementById('track-'+currentId).classList.remove('active');}
    if(audio.paused){audio.play();btn.textContent='⏸';el.classList.add('active');currentAudio=audio;currentId=f.id;
      if(!reported[f.id+'_start']){track('start',f.id,0,audio.duration);reported[f.id+'_start']=true;}
    }else{audio.pause();btn.textContent='▶';el.classList.remove('active');}
  });

  audio.addEventListener('timeupdate',()=>{
    if(!audio.duration)return;
    const pct=Math.round((audio.currentTime/audio.duration)*100);
    pf.style.width=pct+'%';
    tm.textContent=fmt(audio.currentTime)+' / '+fmt(audio.duration);
    [25,50,75,90].forEach(p=>{if(pct>=p&&!reported[f.id+'_'+p]){reported[f.id+'_'+p]=true;track('progress',f.id,p,audio.duration);}});
  });

  audio.addEventListener('ended',()=>{
    btn.textContent='▶';el.classList.remove('active');
    track('end',f.id,100,audio.duration);
  });

  pb.addEventListener('click',e=>{
    if(!audio.duration)return;
    const r=pb.getBoundingClientRect();
    audio.currentTime=((e.clientX-r.left)/r.width)*audio.duration;
  });
});
</script>
</body>
</html>`);
});

// ─── Serve uploaded files ──────────────────────────────────────────
app.use('/files', express.static(path.join(__dirname, 'uploads')));

// ─── Upload file ──────────────────────────────────────────────────
const multer = require('multer');
const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(uploadsDir, req.params.fileId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

app.post('/api/upload/:beatId/:fileId', upload.single('file'), (req, res) => {
  const { beatId, fileId } = req.params;
  db.prepare('UPDATE files SET original_path = ?, size = ? WHERE id = ? AND beat_id = ?')
    .run(req.file.path, req.file.size, fileId, beatId);
  res.json({ ok: true, path: req.file.path });
});

// Dashboard SPA fallback
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../dashboard/index.html')));

app.listen(PORT, () => console.log(`BeatTracker running on ${BASE_URL}`));
