import React, { useState, useRef } from 'react';
import axios from 'axios';
import CryptoJS from 'crypto-js';
import './App.css'; 

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB standard
const CONCURRENCY_LIMIT = 3; // Limit of 3 concurrent uploads

function App() {
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState('IDLE'); 
  const [progress, setProgress] = useState(0);
  const [chunkStatus, setChunkStatus] = useState([]); // Visual map of chunks
  const [logs, setLogs] = useState([]);
  
  // NEW: Metrics State
  const [speed, setSpeed] = useState(0); // Bytes per second
  const [eta, setEta] = useState(null); // Seconds remaining

  // Refs for managing state without re-renders affecting logic
  const activeUploads = useRef(0);
  const chunkQueue = useRef([]);
  const uploadIdRef = useRef(null);
  const totalChunksRef = useRef(0);
  const abortedRef = useRef(false);
  
  // NEW: Ref to track speed calculations
  const lastProgressRef = useRef({ time: 0, loaded: 0 });

  const log = (msg) => setLogs(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev]);

  const handleFileChange = (e) => {
    if (e.target.files[0]) {
      setFile(e.target.files[0]);
      setStatus('IDLE');
      setProgress(0);
      setChunkStatus([]);
      setLogs([]);
      setSpeed(0);
      setEta(null);
    }
  };

  // 1. Calculate Partial Hash (First 10MB + Size) for Handshake
  const calculateHash = async (file) => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      const blob = file.slice(0, 10 * 1024 * 1024); 
      reader.onload = (e) => {
        const wordArray = CryptoJS.lib.WordArray.create(e.target.result);
        const hash = CryptoJS.SHA256(wordArray).toString();
        resolve(hash + "-" + file.size);
      };
      reader.readAsArrayBuffer(blob);
    });
  };

  const startUpload = async () => {
    if (!file) return;
    abortedRef.current = false;
    setStatus('UPLOADING');
    log('Starting upload...');
    
    // Initialize Speed Tracker
    lastProgressRef.current = { time: Date.now(), loaded: 0 };

    try {
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      totalChunksRef.current = totalChunks;
      const fileHash = await calculateHash(file);
      
      // Initialize Grid Status (Gray = Pending)
      const initialStatus = new Array(totalChunks).fill('PENDING');
      setChunkStatus(initialStatus);

      // 2. HANDSHAKE: Check if we can resume
      const { data } = await axios.post('http://localhost:3000/upload/handshake', {
        filename: file.name,
        totalSize: file.size,
        totalChunks,
        fileHash
      });

      uploadIdRef.current = data.uploadId;
      log(`Handshake ID: ${data.uploadId}`);

      // Resume Logic: Mark existing chunks as DONE
      if (data.uploadedChunks.length > 0) {
        log(`Resuming... Skipping ${data.uploadedChunks.length} chunks.`);
        data.uploadedChunks.forEach(idx => {
            initialStatus[idx] = 'UPLOADED';
        });
        setChunkStatus([...initialStatus]);
        // Update progress immediately for resumed files
        const uploadedCount = data.uploadedChunks.length;
        setProgress(Math.round((uploadedCount / totalChunks) * 100));
        // Manually update "loaded" bytes so speed calculation doesn't spike
        lastProgressRef.current.loaded = uploadedCount * CHUNK_SIZE;
      }

      // 3. FILL QUEUE with only missing chunks
      chunkQueue.current = [];
      for (let i = 0; i < totalChunks; i++) {
        if (initialStatus[i] !== 'UPLOADED') {
          chunkQueue.current.push(i);
        }
      }

      // 4. START CONCURRENCY WORKERS
      processQueue();

    } catch (err) {
      log(`Error: ${err.message}`);
      setStatus('FAILED');
    }
  };

  // 5. WORKER QUEUE LOGIC
  const processQueue = () => {
    if (abortedRef.current) return;

    // Check completion
    const allDone = chunkStatus.every(s => s === 'UPLOADED');
    if (allDone && chunkQueue.current.length === 0 && activeUploads.current === 0) {
        finalizeUpload();
        return;
    }

    // Spawn workers up to limit
    while (activeUploads.current < CONCURRENCY_LIMIT && chunkQueue.current.length > 0) {
      const chunkIndex = chunkQueue.current.shift();
      uploadChunk(chunkIndex);
    }
  };

  const uploadChunk = async (index, retryCount = 0) => {
    activeUploads.current++;
    updateChunkState(index, 'UPLOADING'); // Blue

    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end); // Blob.slice()

    try {
      // Streaming Upload Request
      await axios.post('http://localhost:3000/upload/chunk', chunk, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-upload-id': uploadIdRef.current,
          'x-chunk-index': index,
          'x-total-chunks': totalChunksRef.current
        }
      });

      updateChunkState(index, 'UPLOADED'); // Green
      activeUploads.current--;
      processQueue(); 

    } catch (err) {
      // 6. RETRY LOGIC (Exponential Backoff)
      if (retryCount < 3) {
        const delay = Math.pow(2, retryCount) * 1000;
        log(`Chunk ${index} failed. Retrying in ${delay}ms...`);
        updateChunkState(index, 'ERROR'); // Red
        setTimeout(() => {
            activeUploads.current--; 
            uploadChunk(index, retryCount + 1); 
        }, delay);
      } else {
        log(`Chunk ${index} failed permanently.`);
        updateChunkState(index, 'ERROR');
        setStatus('FAILED');
        abortedRef.current = true;
      }
    }
  };

  const updateChunkState = (index, state) => {
    setChunkStatus(prev => {
      const newStatus = [...prev];
      newStatus[index] = state;
      updateProgress(newStatus);
      return newStatus;
    });
  };

  // NEW: Updated Progress Logic with Speed & ETA
  const updateProgress = (currentStatus) => {
    const uploadedChunks = currentStatus.filter(s => s === 'UPLOADED').length;
    const total = totalChunksRef.current;
    const uploadedBytes = uploadedChunks * CHUNK_SIZE; // Approximate bytes done

    if (total > 0) {
        setProgress(Math.round((uploadedChunks / total) * 100));

        // Calculate Speed & ETA (Throttled to update every 1s roughly)
        const now = Date.now();
        const timeDiff = (now - lastProgressRef.current.time) / 1000; // Seconds passed

        if (timeDiff >= 1) {
            const bytesDiff = uploadedBytes - lastProgressRef.current.loaded;
            const currentSpeed = bytesDiff / timeDiff; // Bytes per second
            
            // Only update if speed is positive (avoids weird dips)
            if (currentSpeed > 0) {
                setSpeed(currentSpeed);
                const remainingBytes = file.size - uploadedBytes;
                const currentEta = remainingBytes / currentSpeed;
                setEta(Math.ceil(currentEta));
            }
            
            // Update reference for next calculation
            lastProgressRef.current = { time: now, loaded: uploadedBytes };
        }
    }
  };

  const finalizeUpload = async () => {
    log('Finalizing upload...');
    try {
        const { data } = await axios.post('http://localhost:3000/upload/finalize', {
            uploadId: uploadIdRef.current
        });
        log(`Success! File Hash: ${data.hash}`);
        log(`Files inside ZIP: ${JSON.stringify(data.files)}`);
        setStatus('COMPLETED');
        setSpeed(0);
        setEta(0);
    } catch (err) {
        log('Finalization failed.');
        setStatus('FAILED');
    }
  };

  // Format bytes helper
  const formatSpeed = (bytesPerSec) => {
    if (bytesPerSec === 0) return '0 MB/s';
    return (bytesPerSec / 1024 / 1024).toFixed(2) + ' MB/s';
  };

  return (
    <div className="App">
      <h1>VizExperts Resilient Uploader</h1>
      
      <div className="upload-box">
        <input type="file" onChange={handleFileChange} />
        <button onClick={startUpload} disabled={!file || status === 'UPLOADING' || status === 'COMPLETED'}>
            {status === 'UPLOADING' ? 'Uploading...' : 'Start Upload'}
        </button>
      </div>

      <div className="status-bar">
        <h3>Global Progress: {progress}%</h3>
        
        {/* NEW: Metrics Display */}
        <div className="metrics">
            <span>🚀 Speed: {formatSpeed(speed)}</span>
            <span>⏳ ETA: {eta !== null ? `${eta}s` : '--'}</span>
        </div>

        <div className="progress-bar-bg">
            <div className="progress-bar-fill" style={{ width: `${progress}%` }}></div>
        </div>
      </div>

      {/* CHUNK GRID */}
      <div className="chunk-grid">
        {chunkStatus.map((s, i) => (
            <div key={i} className={`chunk-box ${s}`} title={`Chunk ${i}: ${s}`}></div>
        ))}
      </div>

      <div className="logs">
        <h4>Logs</h4>
        {logs.map((l, i) => <div key={i}>{l}</div>)}
      </div>
    </div>
  );
}

export default App;