import { HttpClient, HttpEvent, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, tap } from 'rxjs';

export interface PhotoFile {
  id: number;
  name: string;
  type: string;
  size: number;
  url: string;
  status: string;
  uploadKey?: string;
  relativePath?: string;
  createdAt: string;
}

export interface PhotoFolder {
  id: number;
  name: string;
  description: string;
  publicationStatus: 'rascunho' | 'processando' | 'pronto' | 'publicado' | 'arquivado';
  activeZipJobId?: number;
  zipReadyAt?: string;
  photos: PhotoFile[];
  createdAt: string;
}

export interface PhotoUser {
  id: number;
  name: string;
  login: string;
  folderId: number;
  createdAt: string;
}

export interface PhotoAccessState {
  folders: PhotoFolder[];
  users: PhotoUser[];
}

export interface UploadSession {
  id: number;
  uuid: string;
  folderId: number;
  totalFiles: number;
  totalBytes: number;
  completedFiles: number;
  failedFiles: number;
  status: string;
  createdAt: string;
}

export interface ZipJob {
  id: number;
  uuid: string;
  folderId: number;
  status: 'aguardando_upload' | 'enviando' | 'upload_concluido' | 'aguardando_zip' | 'gerando_zip' | 'pronto' | 'erro' | 'cancelado' | 'expirado';
  sourceType?: 'photos' | 'uploaded_zip';
  originalFilename?: string;
  totalFiles: number;
  processedFiles: number;
  totalBytes?: number;
  processedBytes?: number;
  percent: number;
  size: number;
  sha256?: string;
  url?: string;
  error?: string;
  expiresAt?: string;
  createdAt: string;
}

export interface ZipStatus {
  status: ZipJob['status'];
  processed_files: number;
  total_files: number;
  processed_bytes: number;
  total_bytes: number;
  progress_percent: number;
  zip_size_bytes: number;
  original_filename?: string;
  sha256?: string;
  message: string;
  error_message?: string;
  created_at?: string;
  started_at?: string;
  finished_at?: string;
}

export interface ChunkUploadStatus {
  status: string;
  uploaded_chunks: number;
  uploaded_chunk_numbers: number[];
  total_chunks: number;
  uploaded_bytes: number;
  total_bytes: number;
  percent: number;
  error_message?: string;
  zip?: ZipJob;
}

export interface StartChunkUploadResponse {
  upload_id: string;
  chunk_size: number;
  uploaded_chunks: number[];
}

interface LoginResponse {
  token: string;
  user?: PhotoUser;
  folder?: PhotoFolder;
}

@Injectable({
  providedIn: 'root'
})
export class PhotoAccessService {
  private readonly apiUrl = '/api';
  private readonly adminTokenKey = 'mayara-admin-token';
  private readonly clientTokenKey = 'mayara-client-token';

  constructor(private readonly http: HttpClient) {}

  get adminToken(): string {
    return localStorage.getItem(this.adminTokenKey) ?? '';
  }

  get clientToken(): string {
    return localStorage.getItem(this.clientTokenKey) ?? '';
  }

  loginAdmin(login: string, password: string): Observable<LoginResponse> {
    return this.http.post<LoginResponse>(`${this.apiUrl}/admin/login`, { login, password }).pipe(
      tap((response) => localStorage.setItem(this.adminTokenKey, response.token))
    );
  }

  logoutAdmin(): void {
    localStorage.removeItem(this.adminTokenKey);
  }

  loginClient(login: string, password: string): Observable<LoginResponse> {
    return this.http.post<LoginResponse>(`${this.apiUrl}/client/login`, { login, password }).pipe(
      tap((response) => localStorage.setItem(this.clientTokenKey, response.token))
    );
  }

  logoutClient(): void {
    localStorage.removeItem(this.clientTokenKey);
  }

  getAdminState(): Observable<PhotoAccessState> {
    return this.http.get<PhotoAccessState>(`${this.apiUrl}/admin/state`, {
      headers: this.authHeaders(this.adminToken)
    });
  }

  getClientFolder(): Observable<{ user: PhotoUser; folder: PhotoFolder }> {
    return this.http.get<{ user: PhotoUser; folder: PhotoFolder }>(`${this.apiUrl}/client/folder`, {
      headers: this.authHeaders(this.clientToken)
    });
  }

  createFolder(name: string, description: string): Observable<PhotoFolder> {
    return this.http.post<PhotoFolder>(
      `${this.apiUrl}/admin/folders`,
      { name: name.trim(), description: description.trim() },
      { headers: this.authHeaders(this.adminToken) }
    );
  }

  createUploadSession(folderId: number, totalFiles: number, totalBytes: number): Observable<UploadSession> {
    return this.http.post<UploadSession>(
      `${this.apiUrl}/admin/folders/${folderId}/upload-sessions`,
      { totalFiles, totalBytes },
      { headers: this.authHeaders(this.adminToken) }
    );
  }

  startChunkUpload(folderId: number, file: File): Observable<StartChunkUploadResponse> {
    return this.http.post<StartChunkUploadResponse>(
      `${this.apiUrl}/admin/uploads/iniciar`,
      {
        folder_id: folderId,
        filename: file.name,
        total_size: file.size,
        total_chunks: 0,
        upload_type: 'zip'
      },
      { headers: this.authHeaders(this.adminToken) }
    );
  }

  startZipUpload(folderId: number, file: File, totalChunks: number): Observable<StartChunkUploadResponse> {
    return this.http.post<StartChunkUploadResponse>(
      `${this.apiUrl}/admin/uploads/iniciar`,
      {
        folder_id: folderId,
        filename: file.name,
        total_size: file.size,
        total_chunks: totalChunks,
        upload_type: 'zip'
      },
      { headers: this.authHeaders(this.adminToken) }
    );
  }

  uploadChunk(uploadId: string, chunkNumber: number, chunk: Blob): Observable<HttpEvent<ChunkUploadStatus>> {
    return this.http.post<ChunkUploadStatus>(
      `${this.apiUrl}/admin/uploads/${uploadId}/chunks/${chunkNumber}`,
      chunk,
      {
        headers: this.authHeaders(this.adminToken).set('Content-Type', 'application/octet-stream'),
        observe: 'events',
        reportProgress: true
      }
    );
  }

  getChunkUploadStatus(uploadId: string): Observable<ChunkUploadStatus> {
    return this.http.get<ChunkUploadStatus>(`${this.apiUrl}/admin/uploads/${uploadId}/status`, {
      headers: this.authHeaders(this.adminToken)
    });
  }

  finalizeChunkUpload(uploadId: string): Observable<ChunkUploadStatus> {
    return this.http.post<ChunkUploadStatus>(
      `${this.apiUrl}/admin/uploads/${uploadId}/finalizar`,
      {},
      { headers: this.authHeaders(this.adminToken) }
    );
  }

  cancelChunkUpload(uploadId: string): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/admin/uploads/${uploadId}`, {
      headers: this.authHeaders(this.adminToken)
    });
  }

  uploadPhoto(
    folderId: number,
    sessionUuid: string,
    uploadKey: string,
    file: File,
    relativePath: string
  ): Observable<HttpEvent<{ photo: PhotoFile; duplicate?: boolean }>> {
    const formData = new FormData();
    formData.append('photo', file);
    formData.append('sessionUuid', sessionUuid);
    formData.append('uploadKey', uploadKey);
    formData.append('relativePath', relativePath);

    return this.http.post<{ photo: PhotoFile; duplicate?: boolean }>(
      `${this.apiUrl}/admin/folders/${folderId}/photos/upload`,
      formData,
      {
        headers: this.authHeaders(this.adminToken),
        observe: 'events',
        reportProgress: true
      }
    );
  }

  uploadPhotos(folderId: number, files: File[]): Observable<{ photos: PhotoFile[] }> {
    const formData = new FormData();
    files.forEach((file) => formData.append('photos', file));

    return this.http.post<{ photos: PhotoFile[] }>(`${this.apiUrl}/admin/folders/${folderId}/photos`, formData, {
      headers: this.authHeaders(this.adminToken)
    });
  }

  deletePhoto(photoId: number): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/admin/photos/${photoId}`, {
      headers: this.authHeaders(this.adminToken)
    });
  }

  deleteFolder(folderId: number): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/admin/folders/${folderId}`, {
      headers: this.authHeaders(this.adminToken)
    });
  }

  getAdminZipStatus(folderId: number): Observable<ZipStatus> {
    return this.http.get<ZipStatus>(`${this.apiUrl}/admin/folders/${folderId}/zip-status`, {
      headers: this.authHeaders(this.adminToken)
    });
  }

  createAdminZip(folderId: number): Observable<ZipJob> {
    return this.http.post<ZipJob>(
      `${this.apiUrl}/admin/folders/${folderId}/zip-jobs`,
      {},
      { headers: this.authHeaders(this.adminToken) }
    );
  }

  publishFolder(folderId: number): Observable<PhotoFolder> {
    return this.http.post<PhotoFolder>(
      `${this.apiUrl}/admin/folders/${folderId}/publish`,
      {},
      { headers: this.authHeaders(this.adminToken) }
    );
  }

  unpublishFolder(folderId: number): Observable<PhotoFolder> {
    return this.http.post<PhotoFolder>(
      `${this.apiUrl}/admin/folders/${folderId}/unpublish`,
      {},
      { headers: this.authHeaders(this.adminToken) }
    );
  }

  deleteFolderZip(folderId: number): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/admin/folders/${folderId}/zip`, {
      headers: this.authHeaders(this.adminToken)
    });
  }

  createUser(name: string, login: string, password: string, folderId: number): Observable<PhotoUser> {
    return this.http.post<PhotoUser>(
      `${this.apiUrl}/admin/users`,
      { name: name.trim(), login: login.trim(), password, folderId },
      { headers: this.authHeaders(this.adminToken) }
    );
  }

  deleteUser(userId: number): Observable<void> {
    return this.http.delete<void>(`${this.apiUrl}/admin/users/${userId}`, {
      headers: this.authHeaders(this.adminToken)
    });
  }

  createZip(folderId: number): Observable<ZipJob> {
    return this.http.post<ZipJob>(
      `${this.apiUrl}/client/folders/${folderId}/zip-jobs`,
      {},
      { headers: this.authHeaders(this.clientToken) }
    );
  }

  getZipJob(jobUuid: string): Observable<ZipJob> {
    return this.http.get<ZipJob>(`${this.apiUrl}/client/zip-jobs/${jobUuid}`, {
      headers: this.authHeaders(this.clientToken)
    });
  }

  zipUrl(job: ZipJob): string {
    return `${job.url ?? ''}?token=${encodeURIComponent(this.clientToken)}`;
  }

  folderDownloadUrl(folderId: number): string {
    return `${this.apiUrl}/client/folders/${folderId}/download?token=${encodeURIComponent(this.clientToken)}`;
  }

  downloadPhoto(photo: PhotoFile): void {
    const link = document.createElement('a');
    link.href = photo.url;
    link.download = photo.name;
    link.click();
  }

  formatSize(size: number): string {
    if (size < 1024 * 1024) {
      return `${Math.max(1, Math.round(size / 1024))} KB`;
    }

    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }

  photoUrl(photo: PhotoFile, role: 'admin' | 'client'): string {
    const token = role === 'admin' ? this.adminToken : this.clientToken;
    return `${photo.url}?token=${encodeURIComponent(token)}`;
  }

  private authHeaders(token: string): HttpHeaders {
    return new HttpHeaders({ Authorization: `Bearer ${token}` });
  }
}
