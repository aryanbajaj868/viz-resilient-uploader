# Resilient Uploader 🚀

A robust, fault-tolerant file upload system designed to reliably handle large files (1GB+) over unstable networks. This project implements a custom chunked upload protocol with concurrency control, resumability, automatic retries, and constant-memory streaming on the backend.

---

## ✨ Features

*   **Smart Chunking Engine**: Files are split into 5MB blocks to prevent browser memory overload and enable fine-grained retry & recovery.
*   **Resiliency & Recovery**: Automatic retry on failures using **Exponential Backoff** (2s → 4s → 8s). Uploads pause gracefully during network loss and resume automatically.
*   **Resume Capability (Handshake)**: Client sends a file hash before upload. The server responds with already-uploaded chunk indices, allowing the client to upload only missing data.
*   **Concurrency Control**: Limits the browser to 3 concurrent uploads to prevent UI freezing and server overload.
*   **Stream-Based Backend I/O**: Uses `fs.createWriteStream` with byte offsets. Ensures **O(1) memory usage** regardless of file size (tested up to 10GB+).
*   **Integrity Verification**: A final SHA-256 hash is computed after upload to ensure file correctness and prevent corruption.
*   **ZIP Peek Functionality**: Inspect ZIP contents immediately after upload without requiring a full extraction on the server.
*   **Real-Time Dashboard**: Includes a chunk grid (Pending/Success/Retry), live upload speed (MB/s), and Estimated Time Remaining (ETA).
*   **Auto-Cleanup**: A background job runs every hour to remove orphaned/incomplete uploads older than 24 hours.

---

## 🛠️ Tech Stack

| Component | Technology |
| :--- | :--- |
| **Frontend** | React.js, Axios, Crypto-JS (SHA-256) |
| **Backend** | Node.js, Express.js, Native Node Streams |
| **Database** | MySQL 8.0 (Promise-based `mysql2`) |
| **DevOps** | Docker, Docker Compose |

---

## 🏗️ Setup and Installation

### 1. Start the Database
The application requires a MySQL database. Use Docker to spin it up quickly:
```bash
docker-compose up -d
```
Wait ~15 seconds for MySQL to initialize before starting the backend.

### 2. Start the Backend
```bash
cd backend
npm install
npx nodemon server.js
```
The server will be available at http://localhost:3000.

### 3. Start the Frontend
```bash
cd frontend
npm install
npm start
```
The application will run at http://localhost:3001.

---

## 🧪 How to Test Resiliency (Demo)

Follow these steps to see the fault-tolerant nature of the system:

1. **Start Upload**: Select a large file (>100MB) and click Start Upload.
2. **Trigger Network Loss**: Open Browser DevTools → Network Tab → Set Throttling to Offline.
3. **Observation**: The upload pauses; failed chunks turn red in the UI.
4. **Restore Connection**: Set Throttling back to No Throttling.
5. **Observation**: The upload resumes automatically from the exact point of failure. No duplicate data is sent.

---

## 📑 API Documentation

### 1. Handshake (Resumability)
**Endpoint:** `POST /upload/init`

**Description:** Client sends the file hash. Server checks the database and returns a list of missing chunks.

### 2. Chunk Upload (Idempotent)
**Endpoint:** `POST /upload/chunk`

**Description:** Sends a 5MB chunk. Idempotent: re-sending an uploaded chunk is a no-op (unique key on `(upload_id, chunk_index)`). Written at byte offset `index * 5MB` via a positional `write()` on an `O_RDWR|O_CREAT` descriptor, so out-of-order and concurrent chunks assemble correctly.

### 3. Finalize
**Endpoint:** `POST /upload/finalize`

**Description:** Runs inside a DB transaction with `SELECT ... FOR UPDATE` on the upload row (safe under concurrent finalize calls). Refuses with 409 unless every chunk is present, then streams a SHA-256 of the file and compares it to the client-declared hash — 422 on mismatch, COMPLETED on match.

---

## 🛡️ Edge Cases Handled

*   **Server Crash**: Database tracks chunk status; progress is never lost.
*   **Race Conditions**: Handled via transaction-locked finalize steps.
*   **Huge Files**: Constant RAM usage ensures the server doesn't crash on 10GB+ files.

## ✅ Automated Tests

`cd backend && npm test` runs an end-to-end suite against a live server + MySQL:

| Test | Verifies |
| --- | --- |
| Interrupt + resume | Re-handshake returns exactly the uploaded chunk set; only missing chunks re-sent |
| Out-of-order chunks | Chunk 1 uploaded before chunk 0 still assembles a hash-correct file |
| Idempotent chunks | Re-sending an uploaded chunk is skipped, not duplicated |
| Premature finalize | 409 with received/total count when chunks are missing |
| Integrity (happy path) | Server streaming hash == client content hash == ground truth |
| Tamper detection | One flipped byte on disk → 422 with expected vs actual hashes |
| Double-finalize race | Two concurrent finalize calls serialize safely via row lock |
| Content dedup | Re-initiating a completed file short-circuits with `alreadyCompleted` |

`npm run test:memory` builds a 2GB file and samples server RSS during finalize (last run: **+3MB delta**, proving the O(1) claim).

## ⚖️ Trade-offs & Design Decisions

1.  **MySQL vs. NoSQL:**
    * *Decision:* Used MySQL (Relational) for strict consistency and ACID compliance on transactions.
    * *Trade-off:* For extremely high-scale systems (millions of concurrent chunks), a NoSQL DB like Redis or Cassandra might offer faster write speeds for chunk tracking, but MySQL ensures data integrity which was prioritized here.

2.  **Local Filesystem vs. Cloud Storage:**
    * *Decision:* Wrote chunks directly to the local disk (\`fs.writeStream\`).
    * *Trade-off:* This works perfectly for a single server but wouldn't scale horizontally. In a production cloud environment, we would stream directly to AWS S3 using multi-part uploads to handle stateless scaling.

3.  **Polling vs. WebSockets:**
    * *Decision:* The frontend calculates progress based on successful HTTP responses.
    * *Trade-off:* WebSockets would provide "real-time" server status, but they add complexity and require stateful connections. The current request-response model is more robust against network drops (stateless).

## 🔮 Future Enhancements

1.  **Cloud Integration:** Replace local disk storage with an S3-compatible object store for infinite scalability.
2.  **User Authentication:** Add JWT-based auth so users can only see and resume their own files.
3.  **Compression:** Implement server-side compression (gzip) for non-zip files to save storage space.
4.  **Expiry Policies:** Allow users to set a "Time to Live" (TTL) for files, automatically cleaning them up after downloading.

---

## 👤 Author

**Aryan Bajaj**  
IIT BHU Varanasi

---

**Resilient Uploader**  
*Built for reliability, scale, and real-world networks.*
