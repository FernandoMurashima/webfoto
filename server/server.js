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
const chunkTempDir = process.env.UPLOAD_TEMP_DIR || path.join(__dirname, 'upload-temp');
const tokenSecret = process.env.TOKEN_SECRET || 'troque-este-segredo-em-producao';
const adminLogin = process.env.ADMIN_LOGIN || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD || 'WebFoto@2026#Admin!7';
const maxPhotoSize = Number(process.env.MAX_PHOTO_SIZE || 25 * 1024 * 1024);
const chunkSize = Number(process.env.UPLOAD_CHUNK_SIZE || 20 * 1024 * 1024);
const maxZipSize = Number(process.env.MAX_ZIP_UPLOAD_SIZE || 20 * 1024 * 1024 * 1024);
const maxUploadChunks = Number(process.env.MAX_UPLOAD_CHUNKS || 2000);
const uploadTempRetentionHours = Number(process.env.UPLOAD_TEMP_RETENTION_HOURS || 48);
const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const allowedExtensions = new Set(['jpg', 'jpeg', 'png', 'webp']);
const allowedZipMimeTypes = new Set(['application/zip', 'application/x-zip-compressed', 'application/octet-stream']);

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(zipDir, { recursive: true });
fs.mkdirSync(chunkTempDir, { recursive: true });

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

app.post('/api/admin/uploads/iniciar', requireAuth('admin'), async (req, res, next) => {
  try {
    const folderId = Number(req.body?.folder_id);
    const originalFilename = String(req.body?.filename || '').trim();
    const totalSize = Number(req.body?.total_size || 0);
    const totalChunks = Number(req.body?.total_chunks || 0);
    const uploadType = String(req.body?.upload_type || '').trim();
    const extension = getExtension(originalFilename);

    if (uploadType !== 'zip') {
      res.status(400).json({ message: 'Tipo de upload nao permitido.' });
      return;
    }

    if (!folderId || !(await getFolderById(folderId))) {
      res.status(404).json({ message: 'Pasta nao encontrada.' });
      return;
    }

    if (!originalFilename || extension !== 'zip' || !totalSize || totalSize > maxZipSize) {
      res.status(400).json({ message: 'Informe um arquivo ZIP valido dentro do limite permitido.' });
      return;
    }

    if (!totalChunks || totalChunks !== Math.ceil(totalSize / chunkSize) || totalChunks > maxUploadChunks) {
      res.status(400).json({ message: 'Quantidade de partes invalida.' });
      return;
    }

    await ensureFreeDisk(zipDir, totalSize * 2);

    const uuid = crypto.randomUUID();
    const temporaryPath = path.join(chunkTempDir, uuid);
    fs.mkdirSync(temporaryPath, { recursive: true });

    const [result] = await pool.execute(
      `INSERT INTO uploads
        (uuid, folder_id, user_id, upload_type, original_filename, temporary_path, total_size,
         uploaded_size, chunk_size, total_chunks, uploaded_chunks, status)
       VALUES
        (:uuid, :folderId, 0, :uploadType, :originalFilename, :temporaryPath, :totalSize,
         0, :chunkSize, :totalChunks, 0, 'enviando')`,
      { uuid, folderId, uploadType, originalFilename: sanitizeDownloadName(originalFilename), temporaryPath, totalSize, chunkSize, totalChunks }
    );

    await pool.execute(
      "UPDATE photo_folders SET publication_status = 'processando' WHERE id = :folderId AND publication_status <> 'publicado'",
      { folderId }
    );

    console.log(`upload_started uuid=${uuid} folder=${folderId} type=${uploadType} size=${totalSize}`);
    res.status(201).json({ upload_id: uuid, chunk_size: chunkSize, uploaded_chunks: [], id: result.insertId });
  } catch (error) {
    next(error);
  }
});

app.post(
  '/api/admin/uploads/:uploadId/chunks/:chunkNumber',
  requireAuth('admin'),
  express.raw({ type: 'application/octet-stream', limit: `${Math.ceil(chunkSize / 1024 / 1024) + 1}mb` }),
  async (req, res, next) => {
    try {
      const upload = await getUploadByUuid(req.params.uploadId);
      const chunkNumber = Number(req.params.chunkNumber);
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      if (!upload || upload.status === 'cancelado') {
        res.status(404).json({ message: 'Upload nao encontrado.' });
        return;
      }

      if (upload.status !== 'enviando') {
        res.status(409).json({ message: 'Upload nao esta aceitando partes.', status: upload.status });
        return;
      }

      if (!Number.isInteger(chunkNumber) || chunkNumber < 0 || chunkNumber >= Number(upload.total_chunks)) {
        res.status(400).json({ message: 'Numero da parte invalido.' });
        return;
      }

      const expectedSize = expectedChunkSize(upload, chunkNumber);

      if (!body.length || body.length !== expectedSize) {
        res.status(400).json({ message: 'Tamanho da parte invalido.' });
        return;
      }

      fs.mkdirSync(upload.temporary_path, { recursive: true });
      const chunkPath = getChunkPath(upload.temporary_path, chunkNumber);
      const sha256 = crypto.createHash('sha256').update(body).digest('hex');
      const existing = await getUploadChunk(upload.id, chunkNumber);

      if (existing) {
        if (existing.sha256 === sha256 && Number(existing.size_bytes) === body.length) {
          res.json(await getUploadStatusPayload(upload.uuid));
          return;
        }

        res.status(409).json({ message: 'Parte duplicada com conteudo diferente.' });
        return;
      }

      fs.writeFileSync(chunkPath, body, { flag: 'wx' });

      await pool.execute(
        `INSERT INTO upload_chunks (upload_id, chunk_number, size_bytes, sha256)
         VALUES (:uploadId, :chunkNumber, :sizeBytes, :sha256)`,
        { uploadId: upload.id, chunkNumber, sizeBytes: body.length, sha256 }
      );
      await refreshChunkUploadCounters(upload.id);

      res.status(201).json(await getUploadStatusPayload(upload.uuid));
    } catch (error) {
      if (error.code === 'EEXIST') {
        res.status(409).json({ message: 'Parte duplicada.' });
        return;
      }

      next(error);
    }
  }
);

app.get('/api/admin/uploads/:uploadId/status', requireAuth('admin'), async (req, res, next) => {
  try {
    const status = await getUploadStatusPayload(req.params.uploadId);

    if (!status) {
      res.sendStatus(404);
      return;
    }

    res.json(status);
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/uploads/:uploadId/finalizar', requireAuth('admin'), async (req, res, next) => {
  try {
    const upload = await getUploadByUuid(req.params.uploadId);

    if (!upload) {
      res.sendStatus(404);
      return;
    }

    const result = await finalizeChunkUpload(upload);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/admin/uploads/:uploadId', requireAuth('admin'), async (req, res, next) => {
  try {
    const upload = await getUploadByUuid(req.params.uploadId);

    if (!upload) {
      res.sendStatus(204);
      return;
    }

    await pool.execute("UPDATE uploads SET status = 'cancelado', error_message = NULL WHERE id = :id", { id: upload.id });
    fs.rm(upload.temporary_path, { recursive: true, force: true }, () => {});
    console.log(`upload_cancelled uuid=${upload.uuid} folder=${upload.folder_id}`);
    res.sendStatus(204);
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

app.get('/api/admin/folders/:folderId/zip-status', requireAuth('admin'), async (req, res, next) => {
  try {
    const folderId = Number(req.params.folderId);
    const job = await getLatestZipJobForFolder(folderId);

    if (!job) {
      res.json({
        status: 'aguardando_upload',
        processed_files: 0,
        total_files: 0,
        processed_bytes: 0,
        total_bytes: 0,
        progress_percent: 0,
        zip_size_bytes: 0,
        message: 'Selecione as fotos ou envie um ZIP pronto.'
      });
      return;
    }

    res.json(mapZipStatus(job));
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/folders/:folderId/zip-jobs', requireAuth('admin'), async (req, res, next) => {
  try {
    const folderId = Number(req.params.folderId);
    const job = await createPhotoZipJob(folderId, true);
    setImmediate(() => buildZipJob(job.uuid).catch((error) => console.error('zip_failed', error)));
    res.status(201).json(mapZipJob(job));
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/folders/:folderId/publish', requireAuth('admin'), async (req, res, next) => {
  try {
    const folderId = Number(req.params.folderId);
    const ready = await getReadyZipForFolder(folderId);

    if (!ready || !(await fileExistsWithSize(ready.output_path || path.join(zipDir, ready.stored_name)))) {
      res.status(409).json({
        error: 'ZIP_NOT_READY',
        message: 'O album ainda esta sendo preparado. Aguarde a conclusao do arquivo ZIP.',
        status: ready?.status || 'aguardando_upload'
      });
      return;
    }

    await pool.execute(
      "UPDATE photo_folders SET publication_status = 'publicado', active_zip_job_id = :jobId, zip_ready_at = NOW() WHERE id = :folderId",
      { jobId: ready.id, folderId }
    );
    res.json(await getFolderById(folderId));
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/folders/:folderId/unpublish', requireAuth('admin'), async (req, res, next) => {
  try {
    const folderId = Number(req.params.folderId);
    await pool.execute(
      "UPDATE photo_folders SET publication_status = IF(active_zip_job_id IS NULL, 'rascunho', 'pronto') WHERE id = :folderId",
      { folderId }
    );
    res.json(await getFolderById(folderId));
  } catch (error) {
    next(error);
  }
});

app.delete('/api/admin/folders/:folderId/zip', requireAuth('admin'), async (req, res, next) => {
  try {
    const folderId = Number(req.params.folderId);
    const job = await getReadyZipForFolder(folderId);

    if (!job) {
      res.sendStatus(204);
      return;
    }

    await pool.execute("UPDATE photo_folders SET active_zip_job_id = NULL, publication_status = 'rascunho' WHERE id = :folderId", { folderId });
    await pool.execute("UPDATE zip_jobs SET status = 'cancelado' WHERE id = :id AND status = 'pronto'", { id: job.id });
    removeZip(job.stored_name);
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

    const folder = await getFolderRecord(folderId);
    const job = await getLatestZipJobForFolder(folderId);

    if (!folder || folder.publication_status !== 'publicado' || !job || job.status !== 'pronto') {
      res.status(409).json({
        error: 'ZIP_NOT_READY',
        message: 'O arquivo ainda esta sendo preparado.',
        status: job?.status || folder?.publication_status || 'rascunho',
        progress_percent: Number(job?.progress_percent || 0)
      });
      return;
    }

    res.json(mapZipJob(job));
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

    if (!(await fileExistsWithSize(job.output_path || path.join(zipDir, job.stored_name)))) {
      res.sendStatus(404);
      return;
    }

    await streamZipDownload(req, res, job, job.original_filename || `fotos-${job.uuid}.zip`);
  } catch (error) {
    next(error);
  }
});

app.get('/api/client/folders/:folderId/download', requireAuth('client'), async (req, res, next) => {
  try {
    const folderId = Number(req.params.folderId);

    if (Number(req.auth.folderId) !== folderId) {
      res.sendStatus(403);
      return;
    }

    const folder = await getFolderRecord(folderId);
    const job = await getReadyZipForFolder(folderId);

    if (!folder || folder.publication_status !== 'publicado' || !job || job.status !== 'pronto') {
      res.status(409).json({
        error: 'ZIP_NOT_READY',
        message: 'O arquivo ainda esta sendo preparado.',
        status: job?.status || folder?.publication_status || 'rascunho',
        progress_percent: Number(job?.progress_percent || 0)
      });
      return;
    }

    await streamZipDownload(req, res, job, sanitizeDownloadName(job.original_filename || `${folder.name}.zip`));
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
  res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : 'Erro interno no servidor.' });
});

async function start() {
  await ensureSchema();
  await resumeInterruptedZipJobs();
  scheduleTempCleanup();
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
      publication_status VARCHAR(40) NOT NULL DEFAULT 'rascunho',
      active_zip_job_id INT NULL,
      zip_ready_at DATETIME NULL,
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
      status VARCHAR(40) NOT NULL DEFAULT 'aguardando_zip',
      source_type VARCHAR(40) NOT NULL DEFAULT 'photos',
      original_filename VARCHAR(255) NULL,
      total_files INT NOT NULL DEFAULT 0,
      processed_files INT NOT NULL DEFAULT 0,
      total_bytes BIGINT NOT NULL DEFAULT 0,
      processed_bytes BIGINT NOT NULL DEFAULT 0,
      progress_percent DECIMAL(6,2) NOT NULL DEFAULT 0,
      size_bytes BIGINT NOT NULL DEFAULT 0,
      stored_name VARCHAR(255) NULL,
      output_path VARCHAR(600) NULL,
      sha256 VARCHAR(64) NULL,
      error_message TEXT NULL,
      expires_at DATETIME NULL,
      created_by INT NULL,
      started_at DATETIME NULL,
      finished_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_zip_jobs_folder
        FOREIGN KEY (folder_id) REFERENCES photo_folders(id)
        ON DELETE CASCADE
    )
  `);

  await pool.execute(`
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
    )
  `);

  await pool.execute(`
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
  await addColumnIfMissing('photo_folders', 'publication_status', "VARCHAR(40) NOT NULL DEFAULT 'rascunho'");
  await addColumnIfMissing('photo_folders', 'active_zip_job_id', 'INT NULL');
  await addColumnIfMissing('photo_folders', 'zip_ready_at', 'DATETIME NULL');
  await addColumnIfMissing('zip_jobs', 'source_type', "VARCHAR(40) NOT NULL DEFAULT 'photos'");
  await addColumnIfMissing('zip_jobs', 'original_filename', 'VARCHAR(255) NULL');
  await addColumnIfMissing('zip_jobs', 'total_bytes', 'BIGINT NOT NULL DEFAULT 0');
  await addColumnIfMissing('zip_jobs', 'processed_bytes', 'BIGINT NOT NULL DEFAULT 0');
  await addColumnIfMissing('zip_jobs', 'progress_percent', 'DECIMAL(6,2) NOT NULL DEFAULT 0');
  await addColumnIfMissing('zip_jobs', 'output_path', 'VARCHAR(600) NULL');
  await addColumnIfMissing('zip_jobs', 'sha256', 'VARCHAR(64) NULL');
  await addColumnIfMissing('zip_jobs', 'created_by', 'INT NULL');
  await addColumnIfMissing('zip_jobs', 'started_at', 'DATETIME NULL');
  await addColumnIfMissing('zip_jobs', 'finished_at', 'DATETIME NULL');
  await addIndexIfMissing('zip_jobs', 'idx_zip_jobs_folder_status', 'folder_id, status');
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

async function getFolderRecord(id) {
  const [folders] = await pool.execute('SELECT * FROM photo_folders WHERE id = :id', { id });
  return folders[0];
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

  const [sessions] = await pool.execute('SELECT * FROM upload_sessions WHERE id = :sessionId', { sessionId });
  const session = sessions[0];

  if (session && Number(session.total_files) > 0 && completedFiles >= Number(session.total_files)) {
    await pool.execute(
      "UPDATE photo_folders SET publication_status = 'processando' WHERE id = :folderId AND publication_status <> 'publicado'",
      { folderId: session.folder_id }
    );
    const job = await createPhotoZipJob(Number(session.folder_id), false);
    setImmediate(() => buildZipJob(job.uuid).catch((error) => console.error('zip_failed', error)));
  }
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

async function getLatestZipJobForFolder(folderId) {
  const [rows] = await pool.execute(
    `SELECT * FROM zip_jobs
     WHERE folder_id = :folderId
     ORDER BY FIELD(status, 'pronto', 'gerando_zip', 'aguardando_zip', 'erro', 'cancelado'), created_at DESC, id DESC
     LIMIT 1`,
    { folderId }
  );
  return rows[0];
}

async function getReadyZipForFolder(folderId) {
  const folder = await getFolderRecord(folderId);

  if (folder?.active_zip_job_id) {
    const [activeRows] = await pool.execute('SELECT * FROM zip_jobs WHERE id = :id AND status = "pronto"', {
      id: folder.active_zip_job_id
    });

    if (activeRows[0]) {
      return activeRows[0];
    }
  }

  const [rows] = await pool.execute(
    `SELECT * FROM zip_jobs
     WHERE folder_id = :folderId AND status = 'pronto'
     ORDER BY finished_at DESC, id DESC
     LIMIT 1`,
    { folderId }
  );
  return rows[0];
}

async function createPhotoZipJob(folderId, forceNew) {
  const folder = await getFolderById(folderId);

  if (!folder) {
    throw Object.assign(new Error('Pasta nao encontrada.'), { statusCode: 404 });
  }

  const [running] = await pool.execute(
    `SELECT * FROM zip_jobs
     WHERE folder_id = :folderId AND source_type = 'photos' AND status IN ('aguardando_zip', 'gerando_zip')
     ORDER BY id DESC LIMIT 1`,
    { folderId }
  );

  if (running[0]) {
    return running[0];
  }

  const [summary] = await pool.execute(
    `SELECT COUNT(*) AS total_files, COALESCE(SUM(size_bytes), 0) AS total_bytes
     FROM photo_files WHERE folder_id = :folderId`,
    { folderId }
  );
  const totalFiles = Number(summary[0]?.total_files || 0);

  if (!totalFiles) {
    throw Object.assign(new Error('Nao ha fotos nesta pasta.'), { statusCode: 400 });
  }

  const uuid = crypto.randomUUID();
  const [result] = await pool.execute(
    `INSERT INTO zip_jobs
      (uuid, folder_id, status, source_type, original_filename, total_files, processed_files, total_bytes, processed_bytes, progress_percent)
     VALUES
      (:uuid, :folderId, 'aguardando_zip', 'photos', :originalFilename, :totalFiles, 0, :totalBytes, 0, 0)`,
    {
      uuid,
      folderId,
      originalFilename: sanitizeDownloadName(`${folder.name}.zip`),
      totalFiles,
      totalBytes: Number(summary[0]?.total_bytes || 0)
    }
  );

  await pool.execute(
    "UPDATE photo_folders SET publication_status = 'processando' WHERE id = :folderId AND publication_status <> 'publicado'",
    { folderId }
  );

  return getZipJobByUuid(uuid);
}

async function buildZipJob(jobUuid) {
  let job = await getZipJobByUuid(jobUuid);

  if (!job) {
    return;
  }

  const storedName = `${job.uuid}.zip`;
  const outputPath = path.join(zipDir, storedName);
  await ensureFreeDisk(zipDir, Number(job.total_bytes || 0) || 1);
  const [claim] = await pool.execute(
    `UPDATE zip_jobs
     SET status = 'gerando_zip', stored_name = :storedName, output_path = :outputPath, started_at = COALESCE(started_at, NOW())
     WHERE uuid = :uuid AND status = 'aguardando_zip'`,
    { storedName, outputPath, uuid: job.uuid }
  );

  if (!claim.affectedRows) {
    return;
  }

  job = await getZipJobByUuid(jobUuid);

  try {
    const [photos] = await pool.execute('SELECT * FROM photo_files WHERE folder_id = :folderId ORDER BY id', {
      folderId: job.folder_id
    });
    const totalFiles = photos.length;
    const totalBytes = photos.reduce((sum, photo) => sum + Number(photo.size_bytes || 0), 0);
    const output = fs.createWriteStream(outputPath);

    const archive = archiver('zip', {
      zlib: { level: 1 },
      forceZip64: true
    });

    let processed = 0;
    let processedBytes = 0;

    archive.pipe(output);
    console.log(`zip_started uuid=${job.uuid} folder=${job.folder_id}`);

    await pool.execute(
      `UPDATE zip_jobs
       SET total_files = :totalFiles, total_bytes = :totalBytes, processed_files = 0,
           processed_bytes = 0, progress_percent = 0, size_bytes = 0
       WHERE uuid = :uuid`,
      { totalFiles, totalBytes, uuid: job.uuid }
    );

    for (const photo of photos) {
      const filePath = path.join(uploadDir, photo.stored_name);

      if (fs.existsSync(filePath)) {
        archive.file(filePath, { name: sanitizeZipEntry(photo.relative_path || photo.original_name) });
      } else {
        throw new Error(`Arquivo de origem ausente: ${photo.original_name}`);
      }

      processed += 1;
      processedBytes += Number(photo.size_bytes || 0);
      const progress = totalFiles ? Math.min(99, (processed / totalFiles) * 100) : 0;
      const currentZipSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
      await pool.execute(
        `UPDATE zip_jobs
         SET processed_files = :processed, processed_bytes = :processedBytes,
             progress_percent = :progress, size_bytes = :currentZipSize
         WHERE uuid = :uuid`,
        {
        processed,
        processedBytes,
        progress,
        currentZipSize,
        uuid: job.uuid
        }
      );
      console.log(`zip_progress uuid=${job.uuid} processed=${processed} total=${totalFiles} percent=${progress.toFixed(2)}`);
    }

    await new Promise((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);

      archive.finalize();
    });

    console.log(`zip_closed uuid=${job.uuid} size=${fs.statSync(outputPath).size}`);

    const size = fs.statSync(outputPath).size;
    const sha256 = await hashFile(outputPath);

    if (!size) {
      throw new Error('ZIP gerado com tamanho zero.');
    }

    await pool.execute(
      `UPDATE zip_jobs
       SET status = 'pronto', size_bytes = :size, processed_files = total_files,
           processed_bytes = total_bytes, progress_percent = 100, sha256 = :sha256, finished_at = NOW()
       WHERE uuid = :uuid`,
      { size, sha256, uuid: job.uuid }
    );
    await pool.execute(
      "UPDATE photo_folders SET active_zip_job_id = :jobId, publication_status = IF(publication_status = 'publicado', 'publicado', 'pronto'), zip_ready_at = NOW() WHERE id = :folderId",
      { jobId: job.id, folderId: job.folder_id }
    );
    console.log(`zip_ready uuid=${job.uuid} size=${size}`);
  } catch (error) {
    await pool.execute(
      "UPDATE zip_jobs SET status = 'erro', error_message = :message, finished_at = NOW() WHERE uuid = :uuid",
      { message: error.message, uuid: job.uuid }
    );
    await pool.execute(
      "UPDATE photo_folders SET publication_status = IF(publication_status = 'publicado', 'publicado', 'rascunho') WHERE id = :folderId AND active_zip_job_id IS NULL",
      { folderId: job.folder_id }
    );
    console.error(`zip_error uuid=${job.uuid} message=${error.message}`);
    removeZip(storedName);
  }
}

async function getUploadByUuid(uuid) {
  const [rows] = await pool.execute('SELECT * FROM uploads WHERE uuid = :uuid', { uuid });
  return rows[0];
}

async function getUploadChunk(uploadId, chunkNumber) {
  const [rows] = await pool.execute(
    'SELECT * FROM upload_chunks WHERE upload_id = :uploadId AND chunk_number = :chunkNumber',
    { uploadId, chunkNumber }
  );
  return rows[0];
}

async function getUploadStatusPayload(uuid) {
  const upload = await getUploadByUuid(uuid);

  if (!upload) {
    return undefined;
  }

  const [chunks] = await pool.execute(
    'SELECT chunk_number FROM upload_chunks WHERE upload_id = :uploadId ORDER BY chunk_number',
    { uploadId: upload.id }
  );
  const uploadedChunks = Number(upload.uploaded_chunks || chunks.length);
  const uploadedBytes = Number(upload.uploaded_size || 0);
  const totalBytes = Number(upload.total_size || 0);

  return {
    status: upload.status,
    uploaded_chunks: uploadedChunks,
    uploaded_chunk_numbers: chunks.map((chunk) => Number(chunk.chunk_number)),
    total_chunks: Number(upload.total_chunks),
    uploaded_bytes: uploadedBytes,
    total_bytes: totalBytes,
    percent: totalBytes ? Math.round((uploadedBytes / totalBytes) * 10000) / 100 : 0,
    error_message: upload.error_message || undefined
  };
}

async function refreshChunkUploadCounters(uploadId) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS uploaded_chunks, COALESCE(SUM(size_bytes), 0) AS uploaded_size
     FROM upload_chunks WHERE upload_id = :uploadId`,
    { uploadId }
  );
  await pool.execute(
    `UPDATE uploads
     SET uploaded_chunks = :uploadedChunks, uploaded_size = :uploadedSize,
         status = IF(:uploadedChunks >= total_chunks, 'upload_concluido', 'enviando')
     WHERE id = :uploadId AND status IN ('enviando', 'upload_concluido')`,
    {
      uploadedChunks: Number(rows[0]?.uploaded_chunks || 0),
      uploadedSize: Number(rows[0]?.uploaded_size || 0),
      uploadId
    }
  );
}

async function finalizeChunkUpload(upload) {
  const [claim] = await pool.execute(
    "UPDATE uploads SET status = 'validando' WHERE id = :id AND status IN ('enviando', 'upload_concluido', 'erro')",
    { id: upload.id }
  );

  if (!claim.affectedRows) {
    return getUploadStatusPayload(upload.uuid);
  }

  try {
    await refreshChunkUploadCounters(upload.id);
    upload = await getUploadByUuid(upload.uuid);
    await ensureFreeDisk(zipDir, Number(upload.total_size || 0) * 1.1);

    if (Number(upload.uploaded_chunks) !== Number(upload.total_chunks) || Number(upload.uploaded_size) !== Number(upload.total_size)) {
      throw new Error('Upload incompleto. Existem partes ausentes.');
    }

    const storedName = `${crypto.randomUUID()}.zip`;
    const finalPath = path.join(zipDir, storedName);
    const hash = crypto.createHash('sha256');
    const output = fs.createWriteStream(finalPath, { flags: 'wx' });

    for (let chunkNumber = 0; chunkNumber < Number(upload.total_chunks); chunkNumber += 1) {
      const chunkPath = getChunkPath(upload.temporary_path, chunkNumber);

      if (!fs.existsSync(chunkPath)) {
        throw new Error(`Parte ausente: ${chunkNumber}`);
      }

      await appendChunkToOutput(chunkPath, output, hash);
    }

    await new Promise((resolve, reject) => {
      output.end();
      output.on('finish', resolve);
      output.on('error', reject);
    });

    const stat = fs.statSync(finalPath);

    if (stat.size !== Number(upload.total_size) || stat.size <= 0) {
      throw new Error('Tamanho final do ZIP divergente.');
    }

    const sha256 = hash.digest('hex');
    const [jobResult] = await pool.execute(
      `INSERT INTO zip_jobs
        (uuid, folder_id, status, source_type, original_filename, stored_name, output_path,
         total_files, processed_files, total_bytes, processed_bytes, progress_percent, size_bytes,
         sha256, started_at, finished_at)
       VALUES
        (:uuid, :folderId, 'pronto', 'uploaded_zip', :originalFilename, :storedName, :outputPath,
         0, 0, :totalBytes, :totalBytes, 100, :sizeBytes, :sha256, NOW(), NOW())`,
      {
        uuid: crypto.randomUUID(),
        folderId: upload.folder_id,
        originalFilename: upload.original_filename,
        storedName,
        outputPath: finalPath,
        totalBytes: stat.size,
        sizeBytes: stat.size,
        sha256
      }
    );

    await pool.execute(
      "UPDATE uploads SET status = 'pronto', final_path = :finalPath, sha256 = :sha256, completed_at = NOW() WHERE id = :id",
      { finalPath, sha256, id: upload.id }
    );
    await pool.execute(
      "UPDATE photo_folders SET active_zip_job_id = :jobId, publication_status = IF(publication_status = 'publicado', 'publicado', 'pronto'), zip_ready_at = NOW() WHERE id = :folderId",
      { jobId: jobResult.insertId, folderId: upload.folder_id }
    );
    fs.rm(upload.temporary_path, { recursive: true, force: true }, () => {});
    console.log(`upload_zip_ready uuid=${upload.uuid} folder=${upload.folder_id} size=${stat.size}`);
    return { ...(await getUploadStatusPayload(upload.uuid)), zip: await getZipJobById(jobResult.insertId) };
  } catch (error) {
    await pool.execute("UPDATE uploads SET status = 'erro', error_message = :message WHERE id = :id", {
      message: error.message,
      id: upload.id
    });
    throw error;
  }
}

function appendChunkToOutput(chunkPath, output, hash) {
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(chunkPath);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    output.on('error', reject);
    input.on('end', resolve);
    input.pipe(output, { end: false });
  });
}

function expectedChunkSize(upload, chunkNumber) {
  const totalChunks = Number(upload.total_chunks);
  const configuredChunkSize = Number(upload.chunk_size);
  const totalSize = Number(upload.total_size);

  if (chunkNumber === totalChunks - 1) {
    return totalSize - configuredChunkSize * (totalChunks - 1);
  }

  return configuredChunkSize;
}

function getChunkPath(temporaryPath, chunkNumber) {
  const safeBase = path.resolve(temporaryPath);
  const safePath = path.resolve(safeBase, `${chunkNumber}.part`);

  if (!safePath.startsWith(safeBase + path.sep)) {
    throw new Error('Caminho temporario invalido.');
  }

  return safePath;
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function fileExistsWithSize(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.size > 0;
  } catch {
    return false;
  }
}

async function ensureFreeDisk(targetPath, requiredBytes) {
  if (!fs.promises.statfs) {
    return;
  }

  try {
    const stats = await fs.promises.statfs(targetPath);
    const freeBytes = Number(stats.bavail || stats.bfree) * Number(stats.bsize);
    const reserve = 512 * 1024 * 1024;

    if (freeBytes < requiredBytes + reserve) {
      throw Object.assign(new Error('Nao ha espaco suficiente no servidor para concluir esta operacao.'), { statusCode: 507 });
    }
  } catch (error) {
    if (error.statusCode) {
      throw error;
    }
  }
}

async function streamZipDownload(req, res, job, downloadName) {
  const filePath = job.output_path || path.join(zipDir, job.stored_name);

  if (!filePath || !fs.existsSync(filePath)) {
    res.status(404).json({ message: 'ZIP nao encontrado no servidor.' });
    return;
  }

  const stat = fs.statSync(filePath);

  if (!stat.size) {
    res.status(409).json({ error: 'ZIP_NOT_READY', message: 'O arquivo ainda esta sendo preparado.' });
    return;
  }

  const range = req.headers.range;
  const safeName = sanitizeDownloadName(downloadName || `album-${job.folder_id}.zip`);
  console.log(`download_started folder=${job.folder_id} job=${job.uuid} size=${stat.size} range=${range || 'full'}`);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.setHeader('Accept-Ranges', 'bytes');

  let start = 0;
  let end = stat.size - 1;
  let statusCode = 200;

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);

    if (!match) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      res.sendStatus(416);
      return;
    }

    start = match[1] ? Number(match[1]) : 0;
    end = match[2] ? Number(match[2]) : stat.size - 1;

    if (start >= stat.size || end >= stat.size || start > end) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      res.sendStatus(416);
      return;
    }

    statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  }

  res.status(statusCode);
  res.setHeader('Content-Length', end - start + 1);

  const input = fs.createReadStream(filePath, { start, end });
  req.on('close', () => {
    if (!res.writableEnded) {
      console.log(`download_disconnected folder=${job.folder_id} job=${job.uuid}`);
      input.destroy();
    }
  });
  input.on('error', (error) => {
    console.error(`download_error folder=${job.folder_id} job=${job.uuid} message=${error.message}`);
    if (!res.headersSent) {
      res.sendStatus(500);
    }
  });
  input.pipe(res);
}

async function resumeInterruptedZipJobs() {
  const [rows] = await pool.execute(
    "SELECT uuid FROM zip_jobs WHERE status IN ('aguardando_zip', 'gerando_zip') ORDER BY id LIMIT 3"
  );

  for (const row of rows) {
    await pool.execute("UPDATE zip_jobs SET status = 'aguardando_zip' WHERE uuid = :uuid", { uuid: row.uuid });
    setImmediate(() => buildZipJob(row.uuid).catch((error) => console.error('zip_resume_failed', error)));
  }
}

function scheduleTempCleanup() {
  const run = () => cleanupExpiredUploads().catch((error) => console.error('upload_cleanup_error', error));
  run();
  setInterval(run, 1000 * 60 * 60);
}

async function cleanupExpiredUploads() {
  const [rows] = await pool.execute(
    `SELECT * FROM uploads
     WHERE status IN ('cancelado', 'erro', 'enviando', 'upload_concluido')
       AND updated_at < DATE_SUB(NOW(), INTERVAL :hours HOUR)`,
    { hours: uploadTempRetentionHours }
  );

  for (const upload of rows) {
    fs.rm(upload.temporary_path, { recursive: true, force: true }, () => {});
    await pool.execute("UPDATE uploads SET status = 'cancelado', error_message = COALESCE(error_message, 'Upload temporario removido por retencao.') WHERE id = :id", {
      id: upload.id
    });
    console.log(`upload_cleanup uuid=${upload.uuid} folder=${upload.folder_id}`);
  }
}

function mapFolder(folder) {
  return {
    id: folder.id,
    name: folder.name,
    description: folder.description || '',
    publicationStatus: folder.publication_status || 'rascunho',
    activeZipJobId: folder.active_zip_job_id || undefined,
    zipReadyAt: folder.zip_ready_at || undefined,
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
  const percent = Number(job.progress_percent || (totalFiles ? (processedFiles / totalFiles) * 100 : 0));

  return {
    id: job.id,
    uuid: job.uuid,
    folderId: job.folder_id,
    status: job.status,
    sourceType: job.source_type || 'photos',
    originalFilename: job.original_filename || undefined,
    totalFiles,
    processedFiles,
    totalBytes: Number(job.total_bytes || 0),
    processedBytes: Number(job.processed_bytes || 0),
    percent: Math.round(percent * 100) / 100,
    size: Number(job.size_bytes || 0),
    sha256: job.sha256 || undefined,
    url: job.status === 'pronto' ? `/api/client/folders/${job.folder_id}/download` : undefined,
    error: job.error_message || undefined,
    expiresAt: job.expires_at || undefined,
    createdAt: job.created_at
  };
}

function mapZipStatus(job) {
  return {
    status: job.status,
    processed_files: Number(job.processed_files || 0),
    total_files: Number(job.total_files || 0),
    processed_bytes: Number(job.processed_bytes || 0),
    total_bytes: Number(job.total_bytes || 0),
    progress_percent: Number(job.progress_percent || 0),
    zip_size_bytes: Number(job.size_bytes || 0),
    original_filename: job.original_filename || undefined,
    sha256: job.sha256 || undefined,
    message: zipStatusMessage(job.status),
    error_message: job.error_message || undefined,
    created_at: job.created_at,
    started_at: job.started_at || undefined,
    finished_at: job.finished_at || undefined
  };
}

function zipStatusMessage(status) {
  const messages = {
    aguardando_upload: 'Selecione as fotos ou envie um ZIP pronto.',
    enviando: 'Enviando arquivos...',
    upload_concluido: 'Upload concluido. Validando arquivo.',
    aguardando_zip: 'Upload concluido. Preparando o ZIP...',
    gerando_zip: 'Preparando arquivo ZIP',
    pronto: 'ZIP pronto para download',
    erro: 'Nao foi possivel preparar o arquivo.',
    cancelado: 'Processamento cancelado.'
  };
  return messages[status] || status;
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

async function addIndexIfMissing(table, indexName, columns) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS found
     FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND INDEX_NAME = :indexName`,
    { table, indexName }
  );

  if (!Number(rows[0].found)) {
    await pool.execute(`CREATE INDEX ${indexName} ON ${table} (${columns})`);
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

function sanitizeDownloadName(value) {
  const base = path.basename(String(value || 'album.zip')).replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 180);
  return base.toLowerCase().endsWith('.zip') ? base : `${base || 'album'}.zip`;
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
