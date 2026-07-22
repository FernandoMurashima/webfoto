import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, tap } from 'rxjs';

export interface PhotoFile {
  id: number;
  name: string;
  type: string;
  size: number;
  url: string;
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
