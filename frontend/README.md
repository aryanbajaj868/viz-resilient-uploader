# VizExperts – Resilient Uploader 🚀

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

**Description:** Sends a 5MB chunk. Uses `fs.createWriteStream({ flags: 'r+', start: offset })` to write directly to the file at the correct position.

### 3. Finalize
**Endpoint:** `POST /upload/finalize`

**Description:** Merges metadata and performs a final SHA-256 integrity check.

---

## 🛡️ Edge Cases Handled

*   **Server Crash**: Database tracks chunk status; progress is never lost.
*   **Race Conditions**: Handled via transaction-locked finalize steps.
*   **Huge Files**: Constant RAM usage ensures the server doesn't crash on 10GB+ files.

---

## 👤 Author

**Aryan Bajaj**  
Metallurgical Engineering, IIT (BHU)

---

**VizExperts Resilient Uploader**  
*Built for reliability, scale, and real-world networks.*
