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
  status: 'aguardando' | 'processando' | 'pronto' | 'erro' | 'expirado';
  totalFiles: number;
  processedFiles: number;
  percent: number;
  size: number;
  url?: string;
  error?: string;
  expiresAt?: string;
  createdAt: string;
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
