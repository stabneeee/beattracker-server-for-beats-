const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const dbPath = path.join(__dirname, 'data', 'db.json');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

function readDb() {
  try { if (fs.existsSync(dbPath)) return JSON.parse(fs.readFileSync(dbPath, 'utf8')); } catch(e) {}
  return { beats: [], events: [], files: [] };
}
function writeDb(data) { fs.writeFileSync(dbPath, JSON.stringify(data, null, 2)); }

app.use(cors());
app.use(express.json());

app.get('/t/:beatId/open.gif', (req, res) => {
  const db = readDb();
  if (db.beats.find(b => b.id === req.params.beatId)) {
    db.events.push({ id: uuidv4(), beat_id: req.params.beatId, type: 'email_open', data: null, ip: req.ip, created_at: Math.floor(Date.now()/1000) });
    writeDb(db);
  }
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' });
  res.send(gif);
});

app.get('/t/:beatId/download/:fileId', (req, res) => {
  const db = readDb();
  const file = db.files.find(f => f.id === req.params.fileId && f.beat_id === req.params.beatId);
  if (!file) return res.status(404).send('Not found');
  db.events.push({ id: uuidv4(), beat_id: req.params.beatId, type: 'download', data: JSON.stringify({ filename: file.filename }), ip: req.ip, created_at: Math.floor(Date.now()/1000) });
  writeDb(db);
  res.redirect(`/files/${req.params.fileId}/${file.filename}`);
});

app.post('/t/:beatId/play', (req, res) => {
  const db = readDb();
  db.events.push({ id: uuidv4(), beat_id: req.params.beatId, type: 'play', data: JSON.stringify(req.body), ip: req.ip, created_at: Math.floor(Date.now()/1000) });
  writeDb(db);
  res.json({ ok: true });
});

app.post('/api/beats', (req, res) => {
  const { title, artist_name, artist_email, notes, files } = req.body;
  const db = readDb();
  const id = uuidv4();
  db.beats.push({ id, title, artist_name, artist_email, notes: notes||'', sent_at: Math.floor(Date.now()/1000) });
  const fileRecords = [];
  if (files && files.length) {
    for (const f of files) {
      const fid = uuidv4();
      db.files.push({ id: fid, beat_id: id, filename: f.filename, size: f.size||0 });
      fileRecords.push({ id: fid, filename: f.filename, downloadUrl: `${BASE_URL}/t/${id}/download/${fid}` });
    }
  }
  writeDb(db);
  res.json({ id, trackingPixel: `${BASE_URL}/t/${id}/open.gif`, downloadLinks: fileRecords, playerUrl: `${BASE_URL}/listen/${id}` });
});

app.get('/api/beats', (req, res) => {
  const db = readDb();
  const result = db.beats.sort((a,b) => b.sent_at - a.sent_at).map(b => {
    const events = db.events.filter(e => e.beat_id === b.id).sort((a,b) => b.created_at - a.created_at);
    const files = db.files.filter(f => f.beat_id === b.id).map(f => ({ ...f, downloadUrl: `${BASE_URL}/t/${b.id}/download/${f.id}` }));
    const plays = events.filter(e => e.type === 'play');
    const maxPercent = plays.reduce((max, e) => { try { return Math.max(max, JSON.parse(e.data||'{}').percent||0); } catch { return max; } }, 0);
    return { ...b, files, stats: { email_opens: events.filter(e => e.type==='email_open').length, downloads: events.filter(e => e.type==='download').length, play_count: plays.filter(e => { try { return JSON.parse(e.data||'{}').action==='start'; } catch { return false; } }).length, max_listen_percent: maxPercent, last_open: events.find(e => e.type==='email_open')?.created_at||null }, events: events.slice(0,50) };
  });
  res.json(result);
});

app.delete('/api/beats/:id', (req, res) => {
  const db = readDb();
  db.beats = db.beats.filter(b => b.id !== req.params.id);
  db.events = db.events.filter(e => e.beat_id !== req.params.id);
  db.files = db.files.filter(f => f.beat_id !== req.params.id);
  writeDb(db);
  res.json({ ok: true });
});

app.post('/api/beats/:id/email-template', (req, res) => {
  const db = readDb();
  const beat = db.beats.find(b => b.id === req.params.id);
  if (!beat) return res.status(404).json({ error: 'Not found' });
  const files = db.files.filter(f => f.beat_id === beat.id);
  const downloadLinks = files.map(f => `<a href="${BASE_URL}/t/${beat.id}/download/${f.id}" style="display:inline-block;margin:8px 0;padding:10px 20px;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:4px">⬇ ${f.filename}</a>`).join('<br>');
  const message = req.body.message || `Salut ${beat.artist_name},\n\nJe t'envoie cette nouvelle prod. Écoute et dis-moi ce que t'en penses.`;
  const pixel = `<img src="${BASE_URL}/t/${beat.id}/open.gif" width="1" height="1" style="display:none" alt="">`;
  const html = `${pixel}<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#f0f0f0;padding:40px;border-radius:12px"><p style="font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#666;margin:0 0 8px">Nouvelle production</p><h1 style="font-size:28px;font-weight:800;margin:0 0 32px;color:#fff">${beat.title}</h1><p style="color:#aaa;line-height:1.6;margin:0 0 28px;white-space:pre-line">${message}</p><a href="${BASE_URL}/listen/${beat.id}" style="display:inline-block;padding:14px 28px;background:#fff;color:#000;text-decoration:none;border-radius:6px;font-weight:700;font-size:14px;margin-bottom:24px">▶ ÉCOUTER EN LIGNE</a><br>${downloadLinks}</div>`;
  res.json({ html, subject: `New Beat: ${beat.title}` });
});

app.get('/listen/:beatId', (req, res) => {
  const db = readDb();
  const beat = db.beats.find(b => b.id === req.params.beatId);
  if (!beat) return res.status(404).send('Not found');
  const files = db.files.filter(f => f.beat_id === beat.id);
  const audioItems = files.map(f => `{id:"${f.id}",name:"${f.filename.replace(/"/g,'')}"}`).join(',');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${beat.title}</title><style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0a0a0a;color:#fff;font-family:Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}.card{background:#111;border:1px solid #222;border-radius:16px;padding:40px;max-width:480px;width:90%}h1{font-size:24px;font-weight:800;margin-bottom:24px}.track{background:#0a0a0a;border:1px solid #222;border-radius:10px;padding:16px;margin-bottom:12px}.track-name{font-size:13px;font-weight:600;margin-bottom:10px}.controls{display:flex;align-items:center;gap:10px}.play-btn{width:34px;height:34px;border-radius:50%;background:#b5ff4d;border:none;cursor:pointer;font-size:12px}.progress-bar{flex:1;height:4px;background:#222;border-radius:2px;cursor:pointer}.progress-fill{height:100%;background:#b5ff4d;border-radius:2px;width:0%}.time{font-size:10px;color:#555}.dl{display:block;margin-top:8px;font-size:11px;color:#555;text-decoration:none;text-align:center}</style></head><body><div class="card"><h1>${beat.title}</h1><div id="t"></div></div><script>const B='${BASE_URL}',ID='${beat.id}',F=[${audioItems}];let ca=null,ci=null,r={};function fmt(s){return Math.floor(s/60)+':'+(Math.floor(s%60)+'').padStart(2,'0')}function tr(a,fid,p,d){fetch(B+'/t/'+ID+'/play',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fileId:fid,percent:p,duration:d,action:a})}).catch(()=>{})}F.forEach(f=>{const el=document.createElement('div');el.className='track';el.innerHTML='<div class="track-name">'+f.name+'</div><div class="controls"><button class="play-btn" id="b'+f.id+'">▶</button><div class="progress-bar" id="pb'+f.id+'"><div class="progress-fill" id="pf'+f.id+'"></div></div><span class="time" id="tm'+f.id+'">0:00</span></div><a class="dl" href="'+B+'/t/'+ID+'/download/'+f.id+'">⬇ Télécharger</a>';document.getElementById('t').appendChild(el);const audio=new Audio(B+'/files/'+f.id+'/'+f.name),btn=document.getElementById('b'+f.id),pf=document.getElementById('pf'+f.id),pb=document.getElementById('pb'+f.id),tm=document.getElementById('tm'+f.id);btn.addEventListener('click',()=>{if(ca&&ca!==audio){ca.pause();document.getElementById('b'+ci).textContent='▶';}if(audio.paused){audio.play();btn.textContent='⏸';ca=audio;ci=f.id;if(!r[f.id]){tr('start',f.id,0,audio.duration);r[f.id]=1;}}else{audio.pause();btn.textContent='▶';}});audio.addEventListener('timeupdate',()=>{if(!audio.duration)return;const p=Math.round(audio.currentTime/audio.duration*100);pf.style.width=p+'%';tm.textContent=fmt(audio.currentTime)+' / '+fmt(audio.duration);[25,50,75,90].forEach(x=>{if(p>=x&&!r[f.id+x]){r[f.id+x]=1;tr('progress',f.id,x,audio.duration);}});});audio.addEventListener('ended',()=>{btn.textContent='▶';tr('end',f.id,100,audio.duration);});pb.addEventListener('click',e=>{if(!audio.duration)return;const rc=pb.getBoundingClientRect();audio.currentTime=(e.clientX-rc.left)/rc.width*audio.duration;});});</script></body></html>`);
});

const multer = require('multer');
const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
const storage = multer.diskStorage({ destination: (req, file, cb) => { const d=path.join(uploadsDir,req.params.fileId);fs.mkdirSync(d,{recursive:true});cb(null,d); }, filename: (req, file, cb) => cb(null, file.originalname) });
const upload = multer({ storage, limits: { fileSize: 100*1024*1024 } });
app.post('/api/upload/:beatId/:fileId', upload.single('file'), (req, res) => res.json({ ok: true }));
app.use('/files', express.static(uploadsDir));

app.listen(PORT, () => console.log(`BeatTracker on ${BASE_URL}`));
