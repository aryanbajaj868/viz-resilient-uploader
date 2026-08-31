/**
 * End-to-end test for the resilient uploader.
 * Simulates the client protocol directly against the running server:
 *   1. RESUME: upload half the chunks, "crash", re-handshake, upload rest, finalize -> verified
 *   2. DEDUP: re-init the same content hash -> alreadyCompleted
 *   3. TAMPER: corrupt one byte on disk before finalize -> 422 integrity failure
 *   4. RACE: two concurrent finalize calls -> exactly one path, no corruption
 *   5. INCOMPLETE: finalize with missing chunks -> 409 refused
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');

const BASE = 'http://localhost:3000';
const CHUNK = 5 * 1024 * 1024;
const results = [];
const check = (name, cond, extra = '') => {
  results.push([name, cond]);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

function makeFile(p, mb) {
  const buf = crypto.randomBytes(mb * 1024 * 1024);
  fs.writeFileSync(p, buf);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function init(fileName, contentHash, size) {
  const { data } = await axios.post(`${BASE}/upload/init`, {
    fileName, contentHash, totalSize: size, totalChunks: Math.ceil(size / CHUNK)
  });
  return data;
}

async function sendChunk(filePath, uploadId, idx) {
  const size = fs.statSync(filePath).size;
  const start = idx * CHUNK, end = Math.min(start + CHUNK, size);
  const buf = Buffer.alloc(end - start);
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  const form = new FormData();
  form.append('chunk', buf, 'chunk.bin');
  form.append('uploadId', String(uploadId));
  form.append('chunkIndex', String(idx));
  await axios.post(`${BASE}/upload/chunk`, form, {
    headers: form.getHeaders(), maxBodyLength: Infinity
  });
}

const finalize = (uploadId) =>
  axios.post(`${BASE}/upload/finalize`, { uploadId }, { validateStatus: () => true });

(async () => {
  // ---------- 1. RESUME + INTEGRITY ----------
  const fileA = '/tmp/testA.bin';
  const hashA = makeFile(fileA, 23); // 23MB -> 5 chunks
  const total = Math.ceil(fs.statSync(fileA).size / CHUNK);

  let { existingUploadId: idA, uploadedChunks } = await init('testA.bin', hashA, fs.statSync(fileA).size);
  check('fresh init returns no uploaded chunks', uploadedChunks.length === 0);

  // Upload chunks 0,1 out of order (1 first), then "crash"
  await sendChunk(fileA, idA, 1);
  await sendChunk(fileA, idA, 0);

  // "Restart": re-handshake with same content hash
  const resume = await init('testA.bin', hashA, fs.statSync(fileA).size);
  check('resume returns same uploadId', resume.existingUploadId === idA);
  check('resume reports exactly chunks {0,1}',
    JSON.stringify([...resume.uploadedChunks].sort()) === '[0,1]');

  // Premature finalize must be refused
  const early = await finalize(idA);
  check('finalize with missing chunks -> 409', early.status === 409, early.data.error);

  // Upload the rest (skip already-done), finalize
  for (let i = 0; i < total; i++) {
    if (!resume.uploadedChunks.includes(i)) await sendChunk(fileA, idA, i);
  }
  // Idempotency: re-send chunk 2, must be skipped not duplicated
  await sendChunk(fileA, idA, 2);

  const fin = await finalize(idA);
  check('finalize succeeds after all chunks', fin.status === 200);
  check('server-side streaming hash matches ground truth',
    fin.data.finalHash === hashA);
  check('integrity verified flag set', fin.data.verified === true);

  // ---------- 2. DEDUP ----------
  const again = await init('renamed-copy.bin', hashA, fs.statSync(fileA).size);
  check('re-init of completed content -> alreadyCompleted', again.alreadyCompleted === true);

  // ---------- 3. TAMPER ----------
  const fileB = '/tmp/testB.bin';
  const hashB = makeFile(fileB, 12); // 12MB -> 3 chunks
  const totalB = Math.ceil(fs.statSync(fileB).size / CHUNK);
  const { existingUploadId: idB } = await init('testB.bin', hashB, fs.statSync(fileB).size);
  for (let i = 0; i < totalB; i++) await sendChunk(fileB, idB, i);

  // Corrupt one byte of the assembled file on the server
  const serverFile = path.join(__dirname, 'uploads', `${idB}.bin`);
  const fdT = fs.openSync(serverFile, 'r+');
  const one = Buffer.alloc(1);
  fs.readSync(fdT, one, 0, 1, 1000);
  one[0] = one[0] ^ 0xff;
  fs.writeSync(fdT, one, 0, 1, 1000);
  fs.closeSync(fdT);

  const tampered = await finalize(idB);
  check('tampered file -> 422 integrity failure', tampered.status === 422);
  check('tamper response includes expected vs actual hashes',
    tampered.data.expected === hashB && tampered.data.actual !== hashB);

  // ---------- 4. DOUBLE-FINALIZE RACE ----------
  const fileC = '/tmp/testC.bin';
  const hashC = makeFile(fileC, 8);
  const totalC = Math.ceil(fs.statSync(fileC).size / CHUNK);
  const { existingUploadId: idC } = await init('testC.bin', hashC, fs.statSync(fileC).size);
  for (let i = 0; i < totalC; i++) await sendChunk(fileC, idC, i);

  const [r1, r2] = await Promise.all([finalize(idC), finalize(idC)]);
  const codes = [r1.status, r2.status].sort();
  check('concurrent finalize: both requests succeed safely (lock serializes them)',
    codes.every(c => c === 200), `statuses: ${codes}`);
  const bothVerified = [r1, r2].every(r => r.data.verified === true);
  check('concurrent finalize: consistent verified result', bothVerified);

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('Test crashed:', e.message); process.exit(1); });
