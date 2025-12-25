const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const fileUpload = require('express-fileupload');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const StreamZip = require('node-stream-zip');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(fileUpload());

// Ensure uploads directory exists
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR);
}

// Database Connection
const pool = mysql.createPool({
    host: 'localhost', // Or '127.0.0.1'
    user: 'user',      // Ensure these match your docker-compose.yml
    password: 'user_password',
    database: 'viz_upload_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// --- ROUTES ---

// 1. Handshake (Initialize Upload)
app.post('/upload/init', async (req, res) => {
    try {
        const { fileName, fileHash, totalSize, totalChunks } = req.body;

        // Check if file exists in DB
        const [rows] = await pool.execute(
            'SELECT id, status FROM uploads WHERE file_hash = ?', 
            [fileHash]
        );

        let uploadId;
        if (rows.length > 0) {
            // Resume existing upload
            uploadId = rows[0].id;
        } else {
            // Start new upload
            const [result] = await pool.execute(
                'INSERT INTO uploads (filename, file_hash, total_size, total_chunks, status) VALUES (?, ?, ?, ?, ?)',
                [fileName, fileHash, totalSize, totalChunks, 'UPLOADING']
            );
            uploadId = result.insertId;
        }

        // Get list of already uploaded chunks
        const [chunkRows] = await pool.execute(
            'SELECT chunk_index FROM chunks WHERE upload_id = ? AND status = "UPLOADED"',
            [uploadId]
        );
        
        const uploadedChunks = chunkRows.map(row => row.chunk_index);

        res.json({ existingUploadId: uploadId, uploadedChunks });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// 2. Upload Chunk
app.post('/upload/chunk', async (req, res) => {
    try {
        if (!req.files || !req.files.chunk) {
            return res.status(400).json({ error: 'No chunk file uploaded' });
        }

        const chunk = req.files.chunk;
        const { uploadId, chunkIndex } = req.body;
        const chunkIdx = parseInt(chunkIndex);
        
        // Check if chunk already exists (Idempotency)
        const [existing] = await pool.execute(
            'SELECT status FROM chunks WHERE upload_id = ? AND chunk_index = ?',
            [uploadId, chunkIdx]
        );

        if (existing.length > 0 && existing[0].status === 'UPLOADED') {
            return res.json({ message: 'Chunk already uploaded (Skipped)' });
        }

        // Append chunk to file using Stream (Memory Efficient)
        const filePath = path.join(UPLOAD_DIR, `${uploadId}.bin`);
        const chunkBuffer = chunk.data; // express-fileupload puts small chunks in RAM, but we append immediately

        // Use fs.open to append at specific position (or just append)
        // Since we are doing sequential uploads mostly, append works. 
        // For strict random access writes, we use 'r+' and position.
        
        // Simpler approach for this assignment: Write to separate chunk files or specific offset?
        // To be truly resilient to out-of-order, we should write to offset.
        
        const fd = await fs.promises.open(filePath, 'a+'); // 'a+' creates if not exists
        // Calculate offset: index * 5MB
        const offset = chunkIdx * (5 * 1024 * 1024);
        
        await fd.write(chunkBuffer, 0, chunkBuffer.length, offset);
        await fd.close();

        // Mark as uploaded in DB
        await pool.execute(
            'INSERT INTO chunks (upload_id, chunk_index, status) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE status="UPLOADED"',
            [uploadId, chunkIdx, 'UPLOADED']
        );

        res.json({ message: 'Chunk uploaded successfully' });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// 3. Finalize
app.post('/upload/finalize', async (req, res) => {
    try {
        const { uploadId, fileName } = req.body;
        const filePath = path.join(UPLOAD_DIR, `${uploadId}.bin`);

        // 1. Calculate Final Hash
        const fileBuffer = fs.readFileSync(filePath); // For 1GB, streams are better, but this is simple for demo
        const finalHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

        // 2. Peek inside ZIP (Bonus)
        let zipContents = [];
        try {
            const zip = new StreamZip.async({ file: filePath });
            const entries = await zip.entries();
            zipContents = Object.keys(entries).slice(0, 5); // Just first 5 files
            await zip.close();
        } catch (e) {
            console.log("Not a valid zip or peek failed", e.message);
        }

        // 3. Update DB
        await pool.execute(
            'UPDATE uploads SET status = ?, final_hash = ? WHERE id = ?',
            ['COMPLETED', finalHash, uploadId]
        );

        res.json({ message: 'Upload completed', finalHash, zipContents });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Cleanup Job (Every hour)
setInterval(async () => {
    console.log("Running cleanup job...");
    // Logic to delete old files would go here
}, 3600000);

app.listen(PORT, () => {
    console.log(`Backend Server running on http://localhost:${PORT}`);
});