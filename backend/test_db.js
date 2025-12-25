const mysql = require('mysql2/promise');

const config = {
    host: 'localhost',
    user: 'root',
    password: 'rootpassword', // The password you confirmed
    database: 'viz_upload_db'
};

(async () => {
    try {
        console.log("1. Attempting connection...");
        const conn = await mysql.createConnection(config);
        console.log("2. Connection successful!");
        
        console.log("3. Checking for 'uploads' table...");
        const [rows] = await conn.execute("SHOW TABLES LIKE 'uploads'");
        if (rows.length > 0) {
            console.log("✅ SUCCESS: Table 'uploads' exists.");
        } else {
            console.log("❌ ERROR: Connected, but table 'uploads' is missing.");
        }
        await conn.end();
    } catch (err) {
        console.error("\n❌ CONNECTION FAILED:");
        console.error("Error Code:", err.code);
        console.error("Message:", err.message);
        
        if (err.code === 'ER_NOT_SUPPORTED_AUTH_MODE') {
            console.log("\nFIX: The database is using a password format Node.js doesn't understand.");
            console.log("Run the ALTER USER command again.");
        }
        if (err.code === 'ECONNREFUSED') {
            console.log("\nFIX: The database is not running. Run 'docker-compose up -d'.");
        }
        if (err.code === 'ER_ACCESS_DENIED_ERROR') {
            console.log("\nFIX: Wrong password. Double check 'rootpassword'.");
        }
    }
})();