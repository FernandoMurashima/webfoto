const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const mysql = require('mysql2/promise');
const archiver = require('archiver');

const app = express();
const port = Number(process.env.PORT || 3000);
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const zipDir = process.env.ZIP_DIR || path.join(__dirname, 'zips');
const tokenSecret = process.env.TOKEN_SECRET || 'troque-este-segredo-em-producao';
const adminLogin = process.env.ADMIN_LOGIN || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD || 'mayara2026';
const maxPhotoSize = Number(process.env.MAX_PHOTO_SIZE || 25 * 1024 * 1024);
const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const allowedExtensions = new Set(['jpg', 'jpeg', 'png', 'webp']);

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(zipDir, { recursive: true });

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'webfoto',
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true
});

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, uploadDir),
  filename: (_req, file, callback) => {
    const extension = getExtension(file.originalname);
    callback(null, `${crypto.randomUUID()}.${extension || 'bin'}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: maxPhotoSize,
    files: Number(process.env.MAX_PHOTOS_PER_UPLOAD || 40)
  },
  fileFilter: (_req, file, callback) => {
    const extension = getExtension(file.originalname);
    callback(null, allowedMimeTypes.has(file.mimetype) && allowedExtensions.has(extension));
  }
});

app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }

  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/admin/login', (req, res) => {
  const { login, password } = req.body || {};

  if (login !== adminLogin || password !== adminPassword) {
    res.status(401).json({ message: 'Login invalido.' });
    return;
  }

  res.json({ token: createToken({ role: 'admin' }) });
});

app.get('/api/admin/state', requireAuth('admin'), async (_req, res, next) => {
  try {
    const [folders, users] = await Promise.all([getFoldersWithPhotos(), getUsers()]);
    res.json({ folders, users });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/folders', requireAuth('admin'), async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const description = String(req.body?.description || '').trim();

    if (!name) {
      res.status(400).json({ message: 'Informe o nome da pasta.' });
      return;
    }

    const [result] = await pool.execute(
      'INSERT INTO photo_folders (name, description) VALUES (:name, :description)',
      { name, description }
    );
    const folder = await getFolderById(result.insertId);
    res.status(201).json(folder);
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/folders/:folderId/photos', requireAuth('admin'), upload.array('photos'), async (req, res, next) => {
  try {
    const folderId = Number(req.params.folderId);
    const folder = await getFolderById(folderId);

    if (!folder) {
      cleanupFiles(req.files || []);
      res.status(404).json({ message: 'Pasta nao encontrada.' });
      return;
    }

    const files = req.files || [];
    const photos = [];

    for (const file of files) {
      const [result] = await pool.execute(
        `INSERT INTO photo_files (folder_id, original_name, stored_name, mime_type, size_bytes)
         VALUES (:folderId, :originalName, :storedName, :mimeType, :sizeBytes)`,
        {
          folderId,
          originalName: file.originalname,
          storedName: file.filename,
          mimeType: file.mimetype,
          sizeBytes: file.size
        }
      );
      photos.push(await getPhotoById(result.insertId));
    }

    res.status(201).json({ photos });
  } catch (error) {
    cleanupFiles(req.files || []);
    next(error);
  }
});

app.post('/api/admin/folders/:folderId/upload-sessions', requireAuth('admin'), async (req, res, next) => {
  try {
    const folderId = Number(req.params.folderId);
    const folder = await getFolderById(folderId);

    if (!folder) {
      res.status(404).json({ message: 'Pasta nao encontrada.' });
      return;
    }

    const totalFiles = Number(req.body?.totalFiles || 0);
    const totalBytes = Number(req.body?.totalBytes || 0);
    const uuid = crypto.randomUUID();
    const [result] = await pool.execute(
      `INSERT INTO upload_sessions (uuid, folder_id, total_files, total_bytes, status)
       VALUES (:uuid, :folderId, :totalFiles, :totalBytes, 'aguardando')`,
      { uuid, folderId, totalFiles, totalBytes }
    );

    console.log(`upload_session_started uuid=${uuid} folder=${folderId} files=${totalFiles}`);
    res.status(201).json(await getUploadSessionById(result.insertId));
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/upload-sessions/:sessionUuid', requireAuth('admin'), async (req, res, next) => {
  try {
    const session = await getUploadSessionByUuid(req.params.sessionUuid);

    if (!session) {
      res.sendStatus(404);
      return;
    }

    const [photos] = await pool.execute(
      'SELECT * FROM photo_files WHERE upload_session_id = :sessionId ORDER BY created_at DESC, id DESC',
      { sessionId: session.id }
    );

    res.json({
      ...mapUploadSession(session),
      photos: photos.map(mapPhoto)
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/folders/:folderId/photos/upload', requireAuth('admin'), upload.single('photo'), async (req, res, next) => {
  try {
    const folderId = Number(req.params.folderId);
    const folder = await getFolderById(folderId);
    const file = req.file;
    const uploadKey = String(req.body?.uploadKey || '').trim();
    const sessionUuid = String(req.body?.sessionUuid || '').trim();
    const relativePath = sanitizeRelativePath(String(req.body?.relativePath || file?.originalname || ''));

    if (!folder) {
      cleanupFiles(file ? [file] : []);
      res.status(404).json({ message: 'Pasta nao encontrada.' });
      return;
    }

    if (!file) {
      res.status(400).json({ message: 'Informe uma foto valida.' });
      return;
    }

    if (!uploadKey || !sessionUuid) {
      cleanupFiles([file]);
      res.status(400).json({ message: 'Sessao e chave de upload sao obrigatorias.' });
      return;
    }

    const validationError = validateUploadedFile(file);

    if (validationError) {
      cleanupFiles([file]);
      await markSessionFailure(sessionUuid);
      res.status(400).json({ message: validationError });
      return;
    }

    const session = await getUploadSessionByUuid(sessionUuid);

    if (!session || Number(session.folder_id) !== folderId) {
      cleanupFiles([file]);
      res.status(404).json({ message: 'Sessao de upload nao encontrada.' });
      return;
    }

    const existing = await getPhotoByUploadKey(folderId, uploadKey);

    if (existing) {
      cleanupFiles([file]);
      res.status(200).json({ photo: existing, duplicate: true });
      return;
    }

    const [result] = await pool.execute(
      `INSERT INTO photo_files
        (folder_id, upload_session_id, upload_key, original_name, relative_path, stored_name, mime_type, size_bytes, status)
       VALUES
        (:folderId, :sessionId, :uploadKey, :originalName, :relativePath, :storedName, :mimeType, :sizeBytes, 'recebida')`,
      {
        folderId,
        sessionId: session.id,
        uploadKey,
        originalName: file.originalname,
        relativePath,
        storedName: file.filename,
        mimeType: file.mimetype,
        sizeBytes: file.size
      }
    );

    await updateSessionCounters(session.id);
    console.log(`photo_received id=${result.insertId} folder=${folderId} session=${sessionUuid}`);
    res.status(201).json({ photo: await getPhotoById(result.insertId) });
  } catch (error) {
    cleanupFiles(req.file ? [req.file] : []);

    if (error.code === 'ER_DUP_ENTRY') {
      const photo = await getPhotoByUploadKey(Number(req.params.folderId), String(req.body?.uploadKey || ''));
      res.status(200).json({ photo, duplicate: true });
      return;
    }

    next(error);
  }
});

app.delete('/api/admin/photos/:photoId', requireAuth('admin'), async (req, res, next) => {
  try {
    const photo = await getPhotoRecord(Number(req.params.photoId));

    if (!photo) {
      res.sendStatus(204);
      return;
    }

    await pool.execute('DELETE FROM photo_files WHERE id = :id', { id: photo.id });
    removeUpload(photo.stored_name);
    res.sendStatus(204);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/admin/folders/:folderId', requireAuth('admin'), async (req, res, next) => {
  try {
    const folderId = Number(req.params.folderId);
    const [photos] = await pool.execute('SELECT stored_name FROM photo_files WHERE folder_id = :folderId', { folderId });
    await pool.execute('DELETE FROM photo_folders WHERE id = :folderId', { folderId });
    photos.forEach((photo) => removeUpload(photo.stored_name));
    res.sendStatus(204);
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/users', requireAuth('admin'), async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const login = String(req.body?.login || '').trim();
    const password = String(req.body?.password || '');
    const folderId = Number(req.body?.folderId);

    if (!name || !login || !password || !folderId) {
      res.status(400).json({ message: 'Preencha nome, login, senha e pasta.' });
      return;
    }

    const folder = await getFolderById(folderId);

    if (!folder) {
      res.status(404).json({ message: 'Pasta nao encontrada.' });
      return;
    }

    const passwordHash = hashPassword(password);
    const [result] = await pool.execute(
      `INSERT INTO photo_users (name, login, password_hash, folder_id)
       VALUES (:name, :login, :passwordHash, :folderId)`,
      { name, login, passwordHash, folderId }
    );

    res.status(201).json(await getUserById(result.insertId));
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      res.status(409).json({ message: 'Ja existe um usuario com este login.' });
      return;
    }

    next(error);
  }
});

app.delete('/api/admin/users/:userId', requireAuth('admin'), async (req, res, next) => {
  try {
    await pool.execute('DELETE FROM photo_users WHERE id = :id', { id: Number(req.params.userId) });
    res.sendStatus(204);
  } catch (error) {
    next(error);
  }
});

app.post('/api/client/login', async (req, res, next) => {
  try {
    const login = String(req.body?.login || '').trim();
    const password = String(req.body?.password || '');
    const [rows] = await pool.execute('SELECT * FROM photo_users WHERE login = :login', { login });
    const user = rows[0];

    if (!user || !verifyPassword(password, user.password_hash)) {
      res.status(401).json({ message: 'Login invalido.' });
      return;
    }

    const token = createToken({ role: 'client', userId: user.id, folderId: user.folder_id });
    const folder = await getFolderById(user.folder_id);
    res.json({ token, user: mapUser(user), folder });
  } catch (error) {
    next(error);
  }
});

app.get('/api/client/folder', requireAuth('client'), async (req, res, next) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM photo_users WHERE id = :id', { id: req.auth.userId });
    const user = rows[0];

    if (!user) {
      res.status(401).json({ message: 'Usuario nao encontrado.' });
      return;
    }

    const folder = await getFolderById(user.folder_id);
    res.json({ user: mapUser(user), folder });
  } catch (error) {
    next(error);
  }
});

app.post('/api/client/folders/:folderId/zip-jobs', requireAuth('client'), async (req, res, next) => {
  try {
    const folderId = Number(req.params.folderId);

    if (Number(req.auth.folderId) !== folderId) {
      res.sendStatus(403);
      return;
    }

    const [photos] = await pool.execute('SELECT * FROM photo_files WHERE folder_id = :folderId ORDER BY id', { folderId });
    const uuid = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString().slice(0, 19).replace('T', ' ');
    const [result] = await pool.execute(
      `INSERT INTO zip_jobs (uuid, folder_id, status, total_files, processed_files, expires_at)
       VALUES (:uuid, :folderId, 'aguardando', :totalFiles, 0, :expiresAt)`,
      { uuid, folderId, totalFiles: photos.length, expiresAt }
    );

    const job = await getZipJobById(result.insertId);
    console.log(`zip_started uuid=${uuid} folder=${folderId}`);
    setImmediate(() => buildZipJob(uuid).catch((error) => console.error('zip_failed', error)));
    res.status(201).json(job);
  } catch (error) {
    next(error);
  }
});

app.get('/api/client/zip-jobs/:jobUuid', requireAuth('client'), async (req, res, next) => {
  try {
    const job = await getZipJobByUuid(req.params.jobUuid);

    if (!job || Number(job.folder_id) !== Number(req.auth.folderId)) {
      res.sendStatus(404);
      return;
    }

    res.json(mapZipJob(job));
  } catch (error) {
    next(error);
  }
});

app.get('/api/zip-jobs/:jobUuid/file', requireAuth('client'), async (req, res, next) => {
  try {
    const job = await getZipJobByUuid(req.params.jobUuid);

    if (!job || Number(job.folder_id) !== Number(req.auth.folderId) || job.status !== 'pronto') {
      res.sendStatus(404);
      return;
    }

    const filePath = path.join(zipDir, job.stored_name);

    if (!fs.existsSync(filePath)) {
      res.sendStatus(404);
      return;
    }

    res.download(filePath, `fotos-${job.uuid}.zip`);
  } catch (error) {
    next(error);
  }
});

app.get('/api/photos/:photoId/file', requirePhotoAccess, async (req, res, next) => {
  try {
    const photo = await getPhotoRecord(Number(req.params.photoId));

    if (!photo) {
      res.sendStatus(404);
      return;
    }

    if (req.auth.role === 'client' && Number(req.auth.folderId) !== Number(photo.folder_id)) {
      res.sendStatus(403);
      return;
    }

    const filePath = path.join(uploadDir, photo.stored_name);

    if (!fs.existsSync(filePath)) {
      res.sendStatus(404);
      return;
    }

    res.setHeader('Content-Type', photo.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(photo.original_name)}"`);
    res.sendFile(filePath);
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ message: 'Erro interno no servidor.' });
});

async function start() {
  await ensureSchema();
  app.listen(port, '0.0.0.0', () => {
    console.log(`Webfoto API listening on port ${port}`);
  });
}

async function ensureSchema() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS photo_folders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(160) NOT NULL,
      description TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS photo_files (
      id INT AUTO_INCREMENT PRIMARY KEY,
      folder_id INT NOT NULL,
      upload_session_id INT NULL,
      upload_key VARCHAR(255) NULL,
      original_name VARCHAR(255) NOT NULL,
      relative_path VARCHAR(500) NULL,
      stored_name VARCHAR(255) NOT NULL,
      mime_type VARCHAR(120) NOT NULL,
      size_bytes BIGINT NOT NULL,
      status VARCHAR(40) NOT NULL DEFAULT 'recebida',
      processing_error TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_photo_files_folder
        FOREIGN KEY (folder_id) REFERENCES photo_folders(id)
        ON DELETE CASCADE
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS upload_sessions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      uuid VARCHAR(64) NOT NULL UNIQUE,
      folder_id INT NOT NULL,
      total_files INT NOT NULL DEFAULT 0,
      total_bytes BIGINT NOT NULL DEFAULT 0,
      completed_files INT NOT NULL DEFAULT 0,
      failed_files INT NOT NULL DEFAULT 0,
      status VARCHAR(40) NOT NULL DEFAULT 'aguardando',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_upload_sessions_folder
        FOREIGN KEY (folder_id) REFERENCES photo_folders(id)
        ON DELETE CASCADE
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS zip_jobs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      uuid VARCHAR(64) NOT NULL UNIQUE,
      folder_id INT NOT NULL,
      status VARCHAR(40) NOT NULL DEFAULT 'aguardando',
      total_files INT NOT NULL DEFAULT 0,
      processed_files INT NOT NULL DEFAULT 0,
      size_bytes BIGINT NOT NULL DEFAULT 0,
      stored_name VARCHAR(255) NULL,
      error_message TEXT NULL,
      expires_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_zip_jobs_folder
        FOREIGN KEY (folder_id) REFERENCES photo_folders(id)
        ON DELETE CASCADE
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS photo_users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(160) NOT NULL,
      login VARCHAR(120) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      folder_id INT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_photo_users_folder
        FOREIGN KEY (folder_id) REFERENCES photo_folders(id)
        ON DELETE CASCADE
    )
  `);

  await addColumnIfMissing('photo_files', 'upload_session_id', 'INT NULL');
  await addColumnIfMissing('photo_files', 'upload_key', 'VARCHAR(255) NULL');
  await addColumnIfMissing('photo_files', 'relative_path', 'VARCHAR(500) NULL');
  await addColumnIfMissing('photo_files', 'status', "VARCHAR(40) NOT NULL DEFAULT 'recebida'");
  await addColumnIfMissing('photo_files', 'processing_error', 'TEXT NULL');
  await addUniqueIndexIfMissing('photo_files', 'uniq_photo_upload_key', 'folder_id, upload_key');
}

async function getFoldersWithPhotos() {
  const [folders] = await pool.execute('SELECT * FROM photo_folders ORDER BY created_at DESC, id DESC');
  const [photos] = await pool.execute('SELECT * FROM photo_files ORDER BY created_at DESC, id DESC');

  return folders.map((folder) => ({
    ...mapFolder(folder),
    photos: photos.filter((photo) => photo.folder_id === folder.id).map(mapPhoto)
  }));
}

async function getFolderById(id) {
  const [folders] = await pool.execute('SELECT * FROM photo_folders WHERE id = :id', { id });
  const folder = folders[0];

  if (!folder) {
    return undefined;
  }

  const [photos] = await pool.execute('SELECT * FROM photo_files WHERE folder_id = :id ORDER BY created_at DESC, id DESC', { id });
  return { ...mapFolder(folder), photos: photos.map(mapPhoto) };
}

async function getUsers() {
  const [rows] = await pool.execute('SELECT * FROM photo_users ORDER BY created_at DESC, id DESC');
  return rows.map(mapUser);
}

async function getUserById(id) {
  const [rows] = await pool.execute('SELECT * FROM photo_users WHERE id = :id', { id });
  return rows[0] ? mapUser(rows[0]) : undefined;
}

async function getPhotoRecord(id) {
  const [rows] = await pool.execute('SELECT * FROM photo_files WHERE id = :id', { id });
  return rows[0];
}

async function getPhotoById(id) {
  const photo = await getPhotoRecord(id);
  return photo ? mapPhoto(photo) : undefined;
}

async function getPhotoByUploadKey(folderId, uploadKey) {
  const [rows] = await pool.execute(
    'SELECT * FROM photo_files WHERE folder_id = :folderId AND upload_key = :uploadKey',
    { folderId, uploadKey }
  );
  return rows[0] ? mapPhoto(rows[0]) : undefined;
}

async function getUploadSessionById(id) {
  const [rows] = await pool.execute('SELECT * FROM upload_sessions WHERE id = :id', { id });
  return rows[0] ? mapUploadSession(rows[0]) : undefined;
}

async function getUploadSessionByUuid(uuid) {
  const [rows] = await pool.execute('SELECT * FROM upload_sessions WHERE uuid = :uuid', { uuid });
  return rows[0];
}

async function updateSessionCounters(sessionId) {
  const [rows] = await pool.execute(
    `SELECT
      COUNT(*) AS completed_files,
      COALESCE(SUM(size_bytes), 0) AS completed_bytes
     FROM photo_files
     WHERE upload_session_id = :sessionId`,
    { sessionId }
  );
  const completedFiles = Number(rows[0]?.completed_files || 0);

  await pool.execute(
    `UPDATE upload_sessions
     SET completed_files = :completedFiles,
         status = CASE
           WHEN total_files > 0 AND :completedFiles >= total_files THEN 'concluida'
           ELSE 'processando'
         END
     WHERE id = :sessionId`,
    { completedFiles, sessionId }
  );
}

async function markSessionFailure(sessionUuid) {
  if (!sessionUuid) {
    return;
  }

  await pool.execute(
    `UPDATE upload_sessions
     SET failed_files = failed_files + 1,
         status = IF(status = 'concluida', status, 'processando')
     WHERE uuid = :sessionUuid`,
    { sessionUuid }
  );
}

async function getZipJobById(id) {
  const [rows] = await pool.execute('SELECT * FROM zip_jobs WHERE id = :id', { id });
  return rows[0] ? mapZipJob(rows[0]) : undefined;
}

async function getZipJobByUuid(uuid) {
  const [rows] = await pool.execute('SELECT * FROM zip_jobs WHERE uuid = :uuid', { uuid });
  return rows[0];
}

async function buildZipJob(jobUuid) {
  const job = await getZipJobByUuid(jobUuid);

  if (!job) {
    return;
  }

  const storedName = `${job.uuid}.zip`;
  const outputPath = path.join(zipDir, storedName);

  await pool.execute(
    "UPDATE zip_jobs SET status = 'processando', stored_name = :storedName WHERE uuid = :uuid",
    { storedName, uuid: job.uuid }
  );

  try {
    const [photos] = await pool.execute('SELECT * FROM photo_files WHERE folder_id = :folderId ORDER BY id', {
      folderId: job.folder_id
    });
    const output = fs.createWriteStream(outputPath);
    
    const archive = archiver('zip', {
      zlib: { level: 1 },
      forceZip64: true
    });
    
    let processed = 0;

    archive.pipe(output);

    for (const photo of photos) {
      const filePath = path.join(uploadDir, photo.stored_name);

      if (fs.existsSync(filePath)) {
        archive.file(filePath, { name: sanitizeZipEntry(photo.relative_path || photo.original_name) });
      }

      processed += 1;
      await pool.execute('UPDATE zip_jobs SET processed_files = :processed WHERE uuid = :uuid', {
        processed,
        uuid: job.uuid
      });
    }

    await new Promise((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);

      archive.finalize();
    });

    console.log(`zip_closed uuid=${job.uuid} size=${fs.statSync(outputPath).size}`);

    const size = fs.statSync(outputPath).size;
    
    await pool.execute(
      "UPDATE zip_jobs SET status = 'pronto', size_bytes = :size, processed_files = total_files WHERE uuid = :uuid",
      { size, uuid: job.uuid }
    );
    console.log(`zip_ready uuid=${job.uuid} size=${size}`);
  } catch (error) {
    await pool.execute(
      "UPDATE zip_jobs SET status = 'erro', error_message = :message WHERE uuid = :uuid",
      { message: error.message, uuid: job.uuid }
    );
    removeZip(storedName);
  }
}

function mapFolder(folder) {
  return {
    id: folder.id,
    name: folder.name,
    description: folder.description || '',
    photos: [],
    createdAt: folder.created_at
  };
}

function mapUser(user) {
  return {
    id: user.id,
    name: user.name,
    login: user.login,
    folderId: user.folder_id,
    createdAt: user.created_at
  };
}

function mapPhoto(photo) {
  return {
    id: photo.id,
    name: photo.original_name,
    type: photo.mime_type,
    size: Number(photo.size_bytes),
    url: `/api/photos/${photo.id}/file`,
    status: photo.status || 'recebida',
    uploadKey: photo.upload_key || undefined,
    relativePath: photo.relative_path || photo.original_name,
    createdAt: photo.created_at
  };
}

function mapUploadSession(session) {
  return {
    id: session.id,
    uuid: session.uuid,
    folderId: session.folder_id,
    totalFiles: Number(session.total_files),
    totalBytes: Number(session.total_bytes),
    completedFiles: Number(session.completed_files),
    failedFiles: Number(session.failed_files),
    status: session.status,
    createdAt: session.created_at
  };
}

function mapZipJob(job) {
  const totalFiles = Number(job.total_files || 0);
  const processedFiles = Number(job.processed_files || 0);

  return {
    id: job.id,
    uuid: job.uuid,
    folderId: job.folder_id,
    status: job.status,
    totalFiles,
    processedFiles,
    percent: totalFiles ? Math.round((processedFiles / totalFiles) * 100) : 0,
    size: Number(job.size_bytes || 0),
    url: job.status === 'pronto' ? `/api/zip-jobs/${job.uuid}/file` : undefined,
    error: job.error_message || undefined,
    expiresAt: job.expires_at || undefined,
    createdAt: job.created_at
  };
}

async function addColumnIfMissing(table, column, definition) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS found
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND COLUMN_NAME = :column`,
    { table, column }
  );

  if (!Number(rows[0].found)) {
    await pool.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function addUniqueIndexIfMissing(table, indexName, columns) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS found
     FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND INDEX_NAME = :indexName`,
    { table, indexName }
  );

  if (!Number(rows[0].found)) {
    await pool.execute(`CREATE UNIQUE INDEX ${indexName} ON ${table} (${columns})`);
  }
}

function requireAuth(role) {
  return (req, res, next) => {
    const auth = readAuth(req);

    if (!auth || auth.role !== role) {
      res.sendStatus(401);
      return;
    }

    req.auth = auth;
    next();
  };
}

function requirePhotoAccess(req, res, next) {
  const auth = readAuth(req);

  if (!auth || !['admin', 'client'].includes(auth.role)) {
    res.sendStatus(401);
    return;
  }

  req.auth = auth;
  next();
}

function readAuth(req) {
  const header = req.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  return verifyToken(token);
}

function createToken(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 1000 * 60 * 60 * 12 })).toString('base64url');
  const signature = crypto.createHmac('sha256', tokenSecret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return undefined;
  }

  try {
    const [body, signature] = token.split('.');
    const expected = crypto.createHmac('sha256', tokenSecret).update(body).digest('base64url');

    if (Buffer.byteLength(signature) !== Buffer.byteLength(expected)) {
      return undefined;
    }

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return undefined;
    }

    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp > Date.now() ? payload : undefined;
  } catch {
    return undefined;
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, hash] = String(storedHash).split(':');

  if (!salt || !hash) {
    return false;
  }

  const calculated = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), calculated);
}

function validateUploadedFile(file) {
  const extension = getExtension(file.originalname);

  if (!allowedExtensions.has(extension)) {
    return 'Formato de arquivo nao permitido.';
  }

  if (!allowedMimeTypes.has(file.mimetype)) {
    return 'Tipo de imagem nao permitido.';
  }

  if (file.size > maxPhotoSize) {
    return 'Arquivo maior que o limite permitido.';
  }

  return undefined;
}

function getExtension(fileName) {
  return String(fileName || '').split('.').pop()?.toLowerCase() || '';
}

function sanitizeRelativePath(value) {
  const clean = String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .map((part) => part.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120))
    .join('/');

  return clean || `foto-${crypto.randomUUID()}`;
}

function sanitizeZipEntry(value) {
  return sanitizeRelativePath(value).replace(/^\/+/, '');
}

function cleanupFiles(files) {
  files.forEach((file) => removeUpload(file.filename));
}

function removeUpload(storedName) {
  if (!storedName) {
    return;
  }

  fs.rm(path.join(uploadDir, storedName), { force: true }, () => {});
}

function removeZip(storedName) {
  if (!storedName) {
    return;
  }

  fs.rm(path.join(zipDir, storedName), { force: true }, () => {});
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
