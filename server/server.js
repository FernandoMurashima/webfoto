const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const mysql = require('mysql2/promise');

const app = express();
const port = Number(process.env.PORT || 3000);
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const tokenSecret = process.env.TOKEN_SECRET || 'troque-este-segredo-em-producao';
const adminLogin = process.env.ADMIN_LOGIN || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD || 'mayara2026';

fs.mkdirSync(uploadDir, { recursive: true });

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
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    callback(null, `${Date.now()}-${crypto.randomUUID()}-${safeName}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: Number(process.env.MAX_PHOTO_SIZE || 25 * 1024 * 1024),
    files: Number(process.env.MAX_PHOTOS_PER_UPLOAD || 40)
  },
  fileFilter: (_req, file, callback) => {
    callback(null, file.mimetype.startsWith('image/'));
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
      original_name VARCHAR(255) NOT NULL,
      stored_name VARCHAR(255) NOT NULL,
      mime_type VARCHAR(120) NOT NULL,
      size_bytes BIGINT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_photo_files_folder
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
    createdAt: photo.created_at
  };
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

function cleanupFiles(files) {
  files.forEach((file) => removeUpload(file.filename));
}

function removeUpload(storedName) {
  if (!storedName) {
    return;
  }

  fs.rm(path.join(uploadDir, storedName), { force: true }, () => {});
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
