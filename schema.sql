-- Create the growtopia database if it doesn't exist
CREATE DATABASE IF NOT EXISTS growtopia;
USE growtopia;

-- Create the peer table for user authentication
CREATE TABLE IF NOT EXISTS peer (
    id INT AUTO_INCREMENT PRIMARY KEY,
    growid VARCHAR(50) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    email VARCHAR(255) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_growid (growid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
