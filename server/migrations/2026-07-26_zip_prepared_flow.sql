DELIMITER $$

CREATE PROCEDURE add_column_if_missing(IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_definition TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = p_table AND COLUMN_NAME = p_column
  ) THEN
    SET @sql = CONCAT('ALTER TABLE ', p_table, ' ADD COLUMN ', p_column, ' ', p_definition);
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$

CREATE PROCEDURE add_index_if_missing(IN p_table VARCHAR(64), IN p_index VARCHAR(64), IN p_columns TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = p_table AND INDEX_NAME = p_index
  ) THEN
    SET @sql = CONCAT('CREATE INDEX ', p_index, ' ON ', p_table, ' (', p_columns, ')');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$

DELIMITER ;

CALL add_column_if_missing('photo_folders', 'publication_status', "VARCHAR(40) NOT NULL DEFAULT 'rascunho'");
CALL add_column_if_missing('photo_folders', 'active_zip_job_id', 'INT NULL');
CALL add_column_if_missing('photo_folders', 'zip_ready_at', 'DATETIME NULL');

CALL add_column_if_missing('zip_jobs', 'source_type', "VARCHAR(40) NOT NULL DEFAULT 'photos'");
CALL add_column_if_missing('zip_jobs', 'original_filename', 'VARCHAR(255) NULL');
CALL add_column_if_missing('zip_jobs', 'total_bytes', 'BIGINT NOT NULL DEFAULT 0');
CALL add_column_if_missing('zip_jobs', 'processed_bytes', 'BIGINT NOT NULL DEFAULT 0');
CALL add_column_if_missing('zip_jobs', 'progress_percent', 'DECIMAL(6,2) NOT NULL DEFAULT 0');
CALL add_column_if_missing('zip_jobs', 'output_path', 'VARCHAR(600) NULL');
CALL add_column_if_missing('zip_jobs', 'sha256', 'VARCHAR(64) NULL');
CALL add_column_if_missing('zip_jobs', 'created_by', 'INT NULL');
CALL add_column_if_missing('zip_jobs', 'started_at', 'DATETIME NULL');
CALL add_column_if_missing('zip_jobs', 'finished_at', 'DATETIME NULL');

CREATE TABLE IF NOT EXISTS uploads (
  id INT AUTO_INCREMENT PRIMARY KEY,
  uuid VARCHAR(64) NOT NULL UNIQUE,
  folder_id INT NOT NULL,
  user_id INT NULL,
  upload_type VARCHAR(40) NOT NULL,
  original_filename VARCHAR(255) NOT NULL,
  temporary_path VARCHAR(600) NOT NULL,
  final_path VARCHAR(600) NULL,
  total_size BIGINT NOT NULL,
  uploaded_size BIGINT NOT NULL DEFAULT 0,
  chunk_size BIGINT NOT NULL,
  total_chunks INT NOT NULL,
  uploaded_chunks INT NOT NULL DEFAULT 0,
  status VARCHAR(40) NOT NULL DEFAULT 'enviando',
  sha256 VARCHAR(64) NULL,
  error_message TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  completed_at DATETIME NULL,
  INDEX idx_uploads_folder_status (folder_id, status),
  CONSTRAINT fk_uploads_folder
    FOREIGN KEY (folder_id) REFERENCES photo_folders(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS upload_chunks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  upload_id INT NOT NULL,
  chunk_number INT NOT NULL,
  size_bytes BIGINT NOT NULL,
  sha256 VARCHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_upload_chunk (upload_id, chunk_number),
  CONSTRAINT fk_upload_chunks_upload
    FOREIGN KEY (upload_id) REFERENCES uploads(id)
    ON DELETE CASCADE
);

CALL add_index_if_missing('zip_jobs', 'idx_zip_jobs_folder_status', 'folder_id, status');

DROP PROCEDURE add_column_if_missing;
DROP PROCEDURE add_index_if_missing;
