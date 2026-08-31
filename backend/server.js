const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const fileUpload = require('express-fileupload');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const StreamZip = require('node-stream-zip');

const app = express();
const PORT = process.env.PORT || 3000;
const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB — must match the client
const STALE_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000; // cleanup threshold
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;      // hourly

app.use(cors());
app.use(express.json());
// Cap request size at chunk size + form-data overhead. Chunks are held in
// memory only for the duration of one request (bounded at ~5MB), then
// written to disk at their byte offset.
app.use(fileUpload({ limits: { fileSize: CHUNK_SIZE + 1024 * 1024 } }));

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// Database config comes from the environment; defaults match docker-compose.yml
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'user',
    password: process.env.DB_PASSWORD || 'user_password',
    database: process.env.DB_NAME || 'uploader_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Streaming SHA-256: O(1) memory regardless of file size.
function hashFileStream(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (d) => hash.update(d));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

// --- ROUTES ---

// 1. Handshake: client sends the SHA-256 of the FILE CONTENT. This is both
//    the resume identity and the integrity baseline verified at finalize.
app.post('/upload/init', async (req, res) => {
    try {
        const { fileName, contentHash, totalSize, totalChunks } = req.body;
        if (!fileName || !contentHash || !totalSize || !totalChunks) {
            return res.status(400).json({ error: 'fileName, contentHash, totalSize, totalChunks are required' });
        }
        if (!/^[a-f0-9]{64}$/i.test(contentHash)) {
            return res.status(400).json({ error: 'contentHash must be a hex SHA-256 digest' });
        }

        const [rows] = await pool.execute(
            'SELECT id, status FROM uploads WHERE file_hash = ?',
            [contentHash]
        );

        let uploadId;
        if (rows.length > 0) {
            uploadId = rows[0].id;
            if (rows[0].status === 'COMPLETED') {
                return res.json({ existingUploadId: uploadId, alreadyCompleted: true, uploadedChunks: [] });
            }
        } else {
            const [result] = await pool.execute(
                'INSERT INTO uploads (filename, file_hash, total_size, total_chunks, status) VALUES (?, ?, ?, ?, ?)',
                [fileName, contentHash, totalSize, totalChunks, 'UPLOADING']
            );
            uploadId = result.insertId;
        }

        const [chunkRows] = await pool.execute(
            'SELECT chunk_index FROM chunks WHERE upload_id = ? AND status = "UPLOADED"',
            [uploadId]
        );
        res.json({ existingUploadId: uploadId, uploadedChunks: chunkRows.map(r => r.chunk_index) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// 2. Chunk upload — idempotent. Writes at byte offset so out-of-order and
//    concurrent chunks land in the right place.
app.post('/upload/chunk', async (req, res) => {
    try {
        if (!req.files || !req.files.chunk) {
            return res.status(400).json({ error: 'No chunk file uploaded' });
        }
        const chunk = req.files.chunk;
        const uploadId = parseInt(req.body.uploadId);
        const chunkIdx = parseInt(req.body.chunkIndex);
        if (!Number.isInteger(uploadId) || !Number.isInteger(chunkIdx) || chunkIdx < 0) {
            return res.status(400).json({ error: 'uploadId and chunkIndex must be non-negative integers' });
        }

        const [uploadRows] = await pool.execute(
            'SELECT total_chunks, status FROM uploads WHERE id = ?', [uploadId]
        );
        if (uploadRows.length === 0) return res.status(404).json({ error: 'Unknown uploadId' });
        if (uploadRows[0].status === 'COMPLETED') {
            return res.status(409).json({ error: 'Upload already completed' });
        }
        if (chunkIdx >= uploadRows[0].total_chunks) {
            return res.status(400).json({ error: 'chunkIndex out of range' });
        }

        const [existing] = await pool.execute(
            'SELECT status FROM chunks WHERE upload_id = ? AND chunk_index = ?',
            [uploadId, chunkIdx]
        );
        if (existing.length > 0 && existing[0].status === 'UPLOADED') {
            return res.json({ message: 'Chunk already uploaded (skipped)' });
        }

        // Positional write at index * CHUNK_SIZE.
        // NOTE: must NOT use append mode ('a'/'a+') — on Linux, append mode
        // ignores the position argument and every write lands at EOF, which
        // silently corrupts out-of-order chunks. O_RDWR|O_CREAT creates the
        // file if missing WITHOUT truncating, and honors explicit offsets.
        const filePath = path.join(UPLOAD_DIR, `${uploadId}.bin`);
        const fd = await fs.promises.open(
            filePath,
            fs.constants.O_RDWR | fs.constants.O_CREAT
        );
        try {
            await fd.write(chunk.data, 0, chunk.data.length, chunkIdx * CHUNK_SIZE);
        } finally {
            await fd.close();
        }

        await pool.execute(
            'INSERT INTO chunks (upload_id, chunk_index, status) VALUES (?, ?, "UPLOADED") ON DUPLICATE KEY UPDATE status="UPLOADED"',
            [uploadId, chunkIdx]
        );
        res.json({ message: 'Chunk uploaded successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// 3. Finalize — transactional and verifying.
//    - Row lock (SELECT ... FOR UPDATE) prevents double-finalize races.
//    - Refuses to finalize unless every chunk is present.
//    - Streams a SHA-256 of the assembled file and compares it to the
//      content hash the client declared at handshake. Mismatch => FAILED.
app.post('/upload/finalize', async (req, res) => {
    const uploadId = parseInt(req.body.uploadId);
    if (!Number.isInteger(uploadId)) {
        return res.status(400).json({ error: 'uploadId must be an integer' });
    }
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const [rows] = await conn.execute(
            'SELECT id, file_hash, total_chunks, status FROM uploads WHERE id = ? FOR UPDATE',
            [uploadId]
        );
        if (rows.length === 0) {
            await conn.rollback();
            return res.status(404).json({ error: 'Unknown uploadId' });
        }
        const upload = rows[0];
        if (upload.status === 'COMPLETED') {
            await conn.rollback();
            return res.json({ message: 'Already finalized', verified: true });
        }

        const [[{ uploaded }]] = await conn.execute(
            'SELECT COUNT(*) AS uploaded FROM chunks WHERE upload_id = ? AND status = "UPLOADED"',
            [uploadId]
        );
        if (uploaded !== upload.total_chunks) {
            await conn.rollback();
            return res.status(409).json({
                error: `Upload incomplete: ${uploaded}/${upload.total_chunks} chunks received`
            });
        }

        const filePath = path.join(UPLOAD_DIR, `${uploadId}.bin`);
        const finalHash = await hashFileStream(filePath); // O(1) memory

        if (finalHash !== upload.file_hash.toLowerCase()) {
            await conn.execute(
                'UPDATE uploads SET status = "FAILED", final_hash = ? WHERE id = ?',
                [finalHash, uploadId]
            );
            await conn.commit();
            return res.status(422).json({
                error: 'Integrity verification failed',
                expected: upload.file_hash,
                actual: finalHash,
                verified: false
            });
        }

        // ZIP peek (best-effort; node-stream-zip reads entries via the
        // central directory, so this is cheap even for large archives)
        let zipContents = null;
        try {
            const zip = new StreamZip.async({ file: filePath });
            zipContents = Object.keys(await zip.entries()).slice(0, 5);
            await zip.close();
        } catch { /* not a zip — fine */ }

        await conn.execute(
            'UPDATE uploads SET status = "COMPLETED", final_hash = ? WHERE id = ?',
            [finalHash, uploadId]
        );
        await conn.commit();
        res.json({ message: 'Upload completed', finalHash, verified: true, zipContents });
    } catch (err) {
        await conn.rollback().catch(() => {});
        console.error(err);
        res.status(500).json({ error: err.message });
    } finally {
        conn.release();
    }
});

// Cleanup job: hourly, removes uploads stuck in a non-COMPLETED state for
// >24h (DB rows cascade to chunks; file removed from disk), plus any
// orphaned .bin files with no DB row.
async function cleanupStaleUploads() {
    try {
        const [stale] = await pool.execute(
            'SELECT id FROM uploads WHERE status != "COMPLETED" AND created_at < NOW() - INTERVAL 24 HOUR'
        );
        for (const { id } of stale) {
            await fs.promises.unlink(path.join(UPLOAD_DIR, `${id}.bin`)).catch(() => {});
            await pool.execute('DELETE FROM uploads WHERE id = ?', [id]); // chunks cascade
        }

        const [allRows] = await pool.execute('SELECT id FROM uploads');
        const known = new Set(allRows.map(r => `${r.id}.bin`));
        for (const f of await fs.promises.readdir(UPLOAD_DIR)) {
            if (f.endsWith('.bin') && !known.has(f)) {
                const st = await fs.promises.stat(path.join(UPLOAD_DIR, f)).catch(() => null);
                if (st && Date.now() - st.mtimeMs > STALE_UPLOAD_TTL_MS) {
                    await fs.promises.unlink(path.join(UPLOAD_DIR, f)).catch(() => {});
                }
            }
        }
        if (stale.length) console.log(`Cleanup: removed ${stale.length} stale upload(s)`);
    } catch (err) {
        console.error('Cleanup job error:', err.message);
    }
}
setInterval(cleanupStaleUploads, CLEANUP_INTERVAL_MS);

app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
});

module.exports = { app, pool }; // for tests
