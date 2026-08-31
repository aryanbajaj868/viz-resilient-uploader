// Memory test: assemble a 2GB upload directly on disk (simulating completed
// chunks), register it in the DB, then call finalize while sampling the
// server's RSS. Proves O(1) memory for the streaming hash path.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const axios = require('axios');
const mysql = require('mysql2/promise');

const SIZE = 2 * 1024 * 1024 * 1024; // 2GB
const CHUNK = 5 * 1024 * 1024;

(async () => {
  // Build 2GB file + ground-truth hash, streaming (this test is O(1) too)
  const p = '/tmp/big.bin';
  const hash = crypto.createHash('sha256');
  const ws = fs.createWriteStream(p);
  let written = 0;
  while (written < SIZE) {
    const buf = crypto.randomBytes(8 * 1024 * 1024);
    hash.update(buf);
    if (!ws.write(buf)) await new Promise(r => ws.once('drain', r));
    written += buf.length;
  }
  await new Promise(r => ws.end(r));
  const truth = hash.digest('hex');
  const totalChunks = Math.ceil(SIZE / CHUNK);
  console.log(`2GB file built, sha256=${truth.slice(0,16)}..., chunks=${totalChunks}`);

  // Register upload + chunks directly in DB, link file into uploads dir
  const db = await mysql.createConnection({ host:'localhost', user:'user', password:'user_password', database:'uploader_db' });
  const [r] = await db.execute(
    'INSERT INTO uploads (filename, file_hash, total_size, total_chunks, status) VALUES (?,?,?,?,?)',
    ['big.bin', truth, SIZE, totalChunks, 'UPLOADING']);
  const id = r.insertId;
  const values = Array.from({length: totalChunks}, (_, i) => `(${id},${i},'UPLOADED')`).join(',');
  await db.query(`INSERT INTO chunks (upload_id, chunk_index, status) VALUES ${values}`);
  fs.copyFileSync(p, path.join(__dirname, 'uploads', `${id}.bin`));
  await db.end();

  // Sample server RSS during finalize
  const pid = execSync("pgrep -f 'node server.js'").toString().trim().split('\n')[0];
  const rss = () => parseInt(fs.readFileSync(`/proc/${pid}/status`,'utf8').match(/VmRSS:\s+(\d+)/)[1]) / 1024;
  const before = rss();
  let peak = before;
  const sampler = setInterval(() => { peak = Math.max(peak, rss()); }, 100);

  const t0 = Date.now();
  const res = await axios.post('http://localhost:3000/upload/finalize', { uploadId: id });
  clearInterval(sampler);

  console.log(`finalize: ${((Date.now()-t0)/1000).toFixed(1)}s | verified=${res.data.verified} | hash match=${res.data.finalHash === truth}`);
  console.log(`server RSS before=${before.toFixed(0)}MB, peak during 2GB hash=${peak.toFixed(0)}MB, delta=${(peak-before).toFixed(0)}MB`);
  console.log(peak - before < 200 ? 'PASS: constant-memory finalize (delta < 200MB on a 2048MB file)' : 'FAIL: memory grew with file size');
  fs.unlinkSync(p);
})().catch(e => { console.error(e.message); process.exit(1); });
