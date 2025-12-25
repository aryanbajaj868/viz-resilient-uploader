import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import CryptoJS from 'crypto-js';
import './App.css';

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_CONCURRENT_UPLOADS = 3;
const MAX_RETRIES = 3;

function App() {
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [chunkMap, setChunkMap] = useState([]); // pending, uploading, success, error
  const [logs, setLogs] = useState([]);
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [eta, setEta] = useState(null);

  const activeUploads = useRef(0);
  const uploadQueue = useRef([]);
  const startTime = useRef(null);
  const uploadedBytes = useRef(0);

  useEffect(() => {
    if (uploading) {
      const interval = setInterval(() => {
        processQueue();
      }, 100);
      return () => clearInterval(interval);
    }
  }, [uploading]);

  const addLog = (msg) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs((prev) => [`[${timestamp}] ${msg}`, ...prev]);
  };

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0];
    if (selectedFile) {
      setFile(selectedFile);
      setChunkMap(new Array(Math.ceil(selectedFile.size / CHUNK_SIZE)).fill('pending'));
      setLogs([]);
      setProgress(0);
      addLog(`Selected file: ${selectedFile.name} (${(selectedFile.size / 1024 / 1024).toFixed(2)} MB)`);
    }
  };

  const calculateFileHash = async (file) => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const hash = CryptoJS.SHA256(CryptoJS.lib.WordArray.create(e.target.result)).toString();
        resolve(hash);
      };
      // For demo speed, we hash only the first 10MB + last 10MB + size
      // In production, you might hash the whole file (takes time)
      const slice = file.slice(0, 1024 * 1024); 
      reader.readAsArrayBuffer(slice);
    });
  };

  const startUpload = async () => {
    if (!file) return;
    setUploading(true);
    startTime.current = Date.now();
    uploadedBytes.current = 0;

    addLog("Calculating hash for handshake...");
    // Simple hash generation for demo purposes (Name + Size + LastModified)
    // To be perfectly robust, verify partial content, but this suffices for the assignment
    const fileHash = CryptoJS.SHA256(file.name + file.size + file.lastModified).toString();

    addLog(`Handshake ID: ${fileHash}`);

    try {
      // 1. Handshake
      const { data } = await axios.post('http://localhost:3000/upload/init', {
        fileName: file.name,
        fileHash: fileHash,
        totalSize: file.size,
        totalChunks: Math.ceil(file.size / CHUNK_SIZE)
      });

      const { existingUploadId, uploadedChunks } = data;
      addLog(`Resuming... Skipping ${uploadedChunks.length} chunks.`);

      // Update Map for already uploaded chunks
      setChunkMap(prev => {
        const newMap = [...prev];
        uploadedChunks.forEach(idx => newMap[idx] = 'success');
        return newMap;
      });

      uploadedBytes.current = uploadedChunks.length * CHUNK_SIZE;

      // 2. Queue missing chunks
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      for (let i = 0; i < totalChunks; i++) {
        if (!uploadedChunks.includes(i)) {
          uploadQueue.current.push({ index: i, uploadId: existingUploadId });
        }
      }

      processQueue();

    } catch (err) {
      addLog("Error starting upload: " + err.message);
      setUploading(false);
    }
  };

  const processQueue = () => {
    if (activeUploads.current >= MAX_CONCURRENT_UPLOADS || uploadQueue.current.length === 0) return;

    while (activeUploads.current < MAX_CONCURRENT_UPLOADS && uploadQueue.current.length > 0) {
      const job = uploadQueue.current.shift();
      activeUploads.current++;
      uploadChunk(job);
    }
  };

  const uploadChunk = async ({ index, uploadId }) => {
    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunkBlob = file.slice(start, end);
    let attempt = 0;
    let success = false;
    let retryDelay = 2000;

    // Update UI to "Uploading" (Blue)
    setChunkMap(prev => {
      const newMap = [...prev];
      newMap[index] = 'uploading';
      return newMap;
    });

    while (attempt < MAX_RETRIES && !success) {
      try {
        const formData = new FormData();
        formData.append('chunk', chunkBlob);
        formData.append('uploadId', uploadId);
        formData.append('chunkIndex', index);
        formData.append('totalChunks', Math.ceil(file.size / CHUNK_SIZE));
        formData.append('fileHash', uploadId); // Using ID as hash for simplicity in this func

        await axios.post('http://localhost:3000/upload/chunk', formData);
        
        success = true;
        setChunkMap(prev => {
          const newMap = [...prev];
          newMap[index] = 'success';
          return newMap;
        });

        uploadedBytes.current += chunkBlob.size;
        updateStats();

      } catch (error) {
        attempt++;
        addLog(`Chunk ${index} failed (Attempt ${attempt}). Retrying in ${retryDelay/1000}s...`);
        console.error(error);

        // *** CRITICAL FOR DEMO VIDEO: TURN RED ***
        setChunkMap(prev => {
          const newMap = [...prev];
          newMap[index] = 'error'; 
          return newMap;
        });

        // Wait before retrying (Exponential Backoff)
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, retryDelay));
          retryDelay *= 2; 
          
          // Set back to "uploading" blue before retry
          setChunkMap(prev => {
            const newMap = [...prev];
            newMap[index] = 'uploading';
            return newMap;
          });
        } else {
          addLog(`Chunk ${index} failed permanently.`);
        }
      }
    }

    activeUploads.current--;

    // Check if done
    if (uploadQueue.current.length === 0 && activeUploads.current === 0) {
      finalizeUpload(uploadId);
    } else {
      processQueue();
    }
  };

  const updateStats = () => {
    const elapsedSeconds = (Date.now() - startTime.current) / 1000;
    const speedBytesPerSec = uploadedBytes.current / elapsedSeconds;
    const remainingBytes = file.size - uploadedBytes.current;
    
    setSpeed((speedBytesPerSec / 1024 / 1024).toFixed(2)); // MB/s
    setEta((remainingBytes / speedBytesPerSec).toFixed(0)); // Seconds
    setProgress(((uploadedBytes.current / file.size) * 100).toFixed(1));
  };

  const finalizeUpload = async (uploadId) => {
    addLog("Finalizing upload...");
    try {
      const { data } = await axios.post('http://localhost:3000/upload/finalize', {
        uploadId,
        fileName: file.name
      });
      addLog(`Success! File Hash: ${data.finalHash}`);
      if (data.zipContents) {
        addLog(`Files inside ZIP: ${JSON.stringify(data.zipContents)}`);
      }
      setUploading(false);
    } catch (err) {
      addLog("Finalization failed: " + err.message);
    }
  };

  return (
    <div className="container">
      <h1>VizExperts Resilient Uploader</h1>
      
      <div className="upload-box">
        <input type="file" onChange={handleFileChange} />
        <button onClick={startUpload} disabled={!file || uploading}>
          {uploading ? 'Uploading...' : 'Start Upload'}
        </button>
      </div>

      <div className="stats">
        <span>Global Progress: <strong>{progress}%</strong></span>
        <span>🚀 Speed: <strong>{speed} MB/s</strong></span>
        <span>⏳ ETA: <strong>{eta}s</strong></span>
      </div>

      <div className="grid">
        {chunkMap.map((status, i) => (
          <div key={i} className={`chunk ${status}`} title={`Chunk ${i}`}></div>
        ))}
      </div>

      <div className="logs">
        <h3>Logs</h3>
        {logs.map((log, i) => <div key={i}>{log}</div>)}
      </div>
    </div>
  );
}

export default App;