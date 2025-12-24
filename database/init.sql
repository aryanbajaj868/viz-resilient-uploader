CREATE DATABASE IF NOT EXISTS viz_upload_db;
USE viz_upload_db;

-- 1. Uploads Table
CREATE TABLE IF NOT EXISTS uploads (
    id VARCHAR(36) PRIMARY KEY,
    filename VARCHAR(255) NOT NULL,
    total_size BIGINT NOT NULL,
    total_chunks INT NOT NULL,
    status ENUM('UPLOADING', 'PROCESSING', 'COMPLETED', 'FAILED') DEFAULT 'UPLOADING',
    final_hash CHAR(64),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Chunks Table
CREATE TABLE IF NOT EXISTS chunks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    upload_id VARCHAR(36) NOT NULL,
    chunk_index INT NOT NULL,
    status ENUM('PENDING', 'UPLOADED') DEFAULT 'PENDING',
    received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (upload_id) REFERENCES uploads(id) ON DELETE CASCADE,
    UNIQUE KEY unique_chunk (upload_id, chunk_index) 
);
