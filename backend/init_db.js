const mysql = require('mysql2/promise');

const dbConfig = {
    host: 'localhost',
    user: 'root',             // Using ROOT to force entry
    password: 'rootpassword', // Matches your new docker-compose.yml
    database: 'viz_upload_db' // We will try to connect to this
};

async function initDB() {
    try {
        console.log("Connecting to database as ROOT...");
        
        // 1. Create Connection (Handle case where DB might not exist yet)
        let connection;
        try {
            connection = await mysql.createConnection(dbConfig);
        } catch (err) {
            // If DB doesn't exist, connect without selecting one
            console.log("Database 'viz_upload_db' might not exist. Creating it...");
            connection = await mysql.createConnection({
                host: 'localhost', 
                user: 'root', 
                password: 'user_password'
            });
            await connection.execute(`CREATE DATABASE IF NOT EXISTS viz_upload_db`);
            await connection.changeUser({ database: 'viz_upload_db' });
        }

        console.log("✅ Connected! Initializing Tables...");

        // 2. Create Tables
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS uploads (
                id INT AUTO_INCREMENT PRIMARY KEY,
                filename VARCHAR(255) NOT NULL,
                file_hash VARCHAR(255) UNIQUE NOT NULL,
                total_size BIGINT NOT NULL,
                total_chunks INT NOT NULL,
                status VARCHAR(50) DEFAULT 'UPLOADING',
                final_hash VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await connection.execute(`
            CREATE TABLE IF NOT EXISTS chunks (
                id INT AUTO_INCREMENT PRIMARY KEY,
                upload_id INT NOT NULL,
                chunk_index INT NOT NULL,
                status VARCHAR(50) DEFAULT 'PENDING',
                uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (upload_id) REFERENCES uploads(id) ON DELETE CASCADE,
                UNIQUE KEY unique_chunk (upload_id, chunk_index)
            )
        `);

        // 3. FIX USER PERMISSIONS (Crucial for Server.js)
        console.log("🔧 Fixing 'user' permissions for the server...");
        try {
            await connection.execute(`CREATE USER IF NOT EXISTS 'user'@'%' IDENTIFIED BY 'user_password'`);
            await connection.execute(`GRANT ALL PRIVILEGES ON viz_upload_db.* TO 'user'@'%'`);
            await connection.execute(`FLUSH PRIVILEGES`);
        } catch (e) {
            console.log("User permission note: " + e.message);
        }

        console.log("✅ Database & Permissions initialized successfully!");
        await connection.end();
        process.exit(0);

    } catch (err) {
        console.error("❌ Error initializing database:", err.message);
        process.exit(1);
    }
}

initDB();