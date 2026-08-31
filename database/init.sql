-- Schema for the resilient uploader. Loaded automatically by docker-compose
-- on first startup. Must stay in sync with backend/init_db.js.
CREATE DATABASE IF NOT EXISTS uploader_db;
USE uploader_db;

CREATE TABLE IF NOT EXISTS uploads (
    id INT AUTO_INCREMENT PRIMARY KEY,
    filename VARCHAR(255) NOT NULL,
    file_hash CHAR(64) UNIQUE NOT NULL,   -- SHA-256 of file content, declared by client at handshake
    total_size BIGINT NOT NULL,
    total_chunks INT NOT NULL,
    status VARCHAR(50) DEFAULT 'UPLOADING',
    final_hash CHAR(64),                  -- SHA-256 computed server-side at finalize
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chunks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    upload_id INT NOT NULL,
    chunk_index INT NOT NULL,
    status VARCHAR(50) DEFAULT 'PENDING',
    received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (upload_id) REFERENCES uploads(id) ON DELETE CASCADE,
    UNIQUE KEY unique_chunk (upload_id, chunk_index)
);

-- App user matching backend defaults / docker-compose
CREATE USER IF NOT EXISTS 'user'@'%' IDENTIFIED BY 'user_password';
GRANT ALL PRIVILEGES ON uploader_db.* TO 'user'@'%';
FLUSH PRIVILEGES;
