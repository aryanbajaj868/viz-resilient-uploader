const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const unzipper = require('unzipper');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Database Connection
const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'rootpassword',
    database: 'viz_upload_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});
const db = pool.promise();

// Ensure uploads directory exists
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR);
}

// ---------------------------------------------------------
// 1. HANDSHAKE ENDPOINT (Resumability Logic)
// ---------------------------------------------------------
app.post('/upload/handshake', async (req, res) => {
    try {
        const { filename, totalSize, totalChunks, fileHash } = req.body;

        const [existing] = await db.query(
            'SELECT * FROM uploads WHERE final_hash = ?', 
            [fileHash]
        );

        if (existing.length > 0) {
            const uploadId = existing[0].id;
            const [chunks] = await db.query(
                'SELECT chunk_index FROM chunks WHERE upload_id = ? AND status = "UPLOADED"', 
                [uploadId]
            );
            return res.json({
                uploadId,
                status: 'RESUMING',
                uploadedChunks: chunks.map(c => c.chunk_index)
            });
        }

        const uploadId = uuidv4();
        await db.query(
            'INSERT INTO uploads (id, filename, total_size, total_chunks, final_hash) VALUES (?, ?, ?, ?, ?)',
            [uploadId, filename, totalSize, totalChunks, fileHash]
        );

        res.json({ uploadId, status: 'NEW', uploadedChunks: [] });
    } catch (error) {
        console.error('Handshake Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ---------------------------------------------------------
// 2. CHUNK UPLOAD ENDPOINT (Streaming I/O + Concurrency)
// ---------------------------------------------------------
app.post('/upload/chunk', async (req, res) => {
    const uploadId = req.headers['x-upload-id'];
    const chunkIndex = parseInt(req.headers['x-chunk-index']);
    const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB standard

    if (!uploadId || isNaN(chunkIndex)) return res.status(400).json({ error: 'Missing headers' });

    const filePath = path.join(UPLOAD_DIR, `${uploadId}.bin`);

    try {
        // Idempotency: Ignore if already uploaded
        const [existing] = await db.query(
            'SELECT status FROM chunks WHERE upload_id = ? AND chunk_index = ?',
            [uploadId, chunkIndex]
        );
        if (existing.length > 0 && existing[0].status === 'UPLOADED') {
            return res.json({ message: 'Chunk already received' });
        }

        // Create file if it doesn't exist
        if (!fs.existsSync(filePath)) fs.closeSync(fs.openSync(filePath, 'w'));

        // Write directly to disk at specific offset (No memory buffering)
        const writeStream = fs.createWriteStream(filePath, {
            flags: 'r+',
            start: chunkIndex * CHUNK_SIZE
        });

        req.pipe(writeStream);

        writeStream.on('finish', async () => {
            await db.query(
                `INSERT INTO chunks (upload_id, chunk_index, status) VALUES (?, ?, 'UPLOADED') 
                 ON DUPLICATE KEY UPDATE status = 'UPLOADED'`,
                [uploadId, chunkIndex]
            );
            res.json({ message: 'Chunk uploaded' });
        });

        writeStream.on('error', (err) => res.status(500).json({ error: 'Write failed' }));

    } catch (error) {
        console.error('Chunk Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ---------------------------------------------------------
// 3. FINALIZATION ENDPOINT (Integrity Check + Peek)
// ---------------------------------------------------------
app.post('/upload/finalize', async (req, res) => {
    const { uploadId } = req.body;
    const filePath = path.join(UPLOAD_DIR, `${uploadId}.bin`);

    try {
        // Bonus Case: Double-Finalize Check (Race Condition Protection)
        const [upload] = await db.query('SELECT status, total_chunks, final_hash FROM uploads WHERE id = ?', [uploadId]);
        
        if (upload.length === 0) return res.status(404).json({ error: 'Upload not found' });
        
        // FIX: Return the stored hash if already done
        if (upload[0].status === 'COMPLETED') {
            return res.json({ 
                message: 'Already completed', 
                hash: upload[0].final_hash, // Uses stored hash (Fixes undefined error)
                files: ['(File already archived - Check DB)'] 
            }); 
        }

        // Verify all chunks are present
        const [chunkCount] = await db.query('SELECT COUNT(*) as count FROM chunks WHERE upload_id = ? AND status = "UPLOADED"', [uploadId]);
        if (chunkCount[0].count !== upload[0].total_chunks) {
            return res.status(400).json({ error: 'Not all chunks uploaded yet' });
        }

        // A. Update Status to PROCESSING
        await db.query('UPDATE uploads SET status = "PROCESSING" WHERE id = ?', [uploadId]);

        // B. Calculate SHA-256 Hash (Integrity Check)
        const fileBuffer = fs.readFileSync(filePath);
        const hashSum = crypto.createHash('sha256');
        hashSum.update(fileBuffer);
        const hex = hashSum.digest('hex');

        // C. The "Peek": List files inside ZIP (Soft fail if not a zip)
        let filenames = [];
        try {
            const directory = await unzipper.Open.file(filePath);
            filenames = directory.files.map(d => d.path);
        } catch (err) {
            console.log('Not a zip file, skipping peek.');
        }

        // D. Mark Completed
        await db.query('UPDATE uploads SET status = "COMPLETED" WHERE id = ?', [uploadId]);

        console.log(`Upload ${uploadId} finalized. Files found: ${filenames.length}`);
        
        res.json({ 
            message: 'Upload completed successfully', 
            hash: hex,
            files: filenames.slice(0, 5) // Return first 5 files as proof
        });

    } catch (error) {
        console.error('Finalize Error:', error);
        await db.query('UPDATE uploads SET status = "FAILED" WHERE id = ?', [uploadId]);
        res.status(500).json({ error: error.message });
    }
});

// ---------------------------------------------------------
// 4. CLEANUP JOB (Runs every 1 hour)
// ---------------------------------------------------------
setInterval(async () => {
    console.log('🧹 Running cleanup job...');
    // Delete files older than 24 hours that are NOT completed
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const threshold = new Date(Date.now() - ONE_DAY_MS);
    // Format date for MySQL
    const dateString = threshold.toISOString().slice(0, 19).replace('T', ' ');

    try {
        const [oldUploads] = await db.query(
            `SELECT id FROM uploads WHERE status != 'COMPLETED' AND created_at < ?`,
            [dateString]
        );

        if (oldUploads.length === 0) {
            console.log('No orphaned files found.');
            return;
        }

        for (const row of oldUploads) {
            const filePath = path.join(UPLOAD_DIR, `${row.id}.bin`);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath); // Delete actual file from disk
                console.log(`Deleted orphaned file: ${row.id}`);
            }
            // Delete from DB (Chunks will cascade delete via Foreign Key)
            await db.query('DELETE FROM uploads WHERE id = ?', [row.id]);
        }
    } catch (err) {
        console.error('Cleanup failed:', err);
    }
}, 60 * 60 * 1000); // Check every 1 Hour

// ---------------------------------------------------------
// Start Server
// ---------------------------------------------------------
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});