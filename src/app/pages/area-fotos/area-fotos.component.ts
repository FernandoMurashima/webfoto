import { CommonModule } from '@angular/common';
import { Component, HostListener, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpEvent, HttpEventType } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { PhotoAccessService, PhotoFile, PhotoFolder, PhotoUser, ZipJob } from '../../services/photo-access.service';

type ActivePanel = 'cliente' | 'admin';
type UploadStatus = 'aguardando' | 'enviando' | 'concluido' | 'erro' | 'cancelado';
type QueueFilter = 'todos' | UploadStatus;

interface UploadQueueItem {
  id: string;
  key: string;
  file: File;
  name: string;
  relativePath: string;
  size: number;
  progress: number;
  status: UploadStatus;
  attempts: number;
  uploadedBytes: number;
  error?: string;
  photo?: PhotoFile;
  subscription?: Subscription;
}

@Component({
  selector: 'app-area-fotos',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './area-fotos.component.html',
  styleUrl: './area-fotos.component.css'
})
export class AreaFotosComponent implements OnDestroy {
  private readonly uploadConcurrency = 4;
  private readonly maxPhotoSize = 60 * 1024 * 1024;
  private readonly allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
  private readonly allowedExtensions = new Set(['jpg', 'jpeg', 'png', 'webp']);

  activePanel: ActivePanel = 'cliente';
  adminLogged = false;
  clientLogged = false;
  loading = false;
  queuePaused = true;
  uploadFinishedNotified = false;
  queueFilter: QueueFilter = 'todos';
  uploadSessionUuid = '';
  selectedFolderId = 0;
  uploadFolderId = 0;
  clientUser?: PhotoUser;
  clientFolder?: PhotoFolder;
  zipJob?: ZipJob;
  zipPolling?: Subscription;
  message = '';
  error = '';

  adminForm = {
    login: '',
    password: ''
  };

  clientForm = {
    login: '',
    password: ''
  };

  folderForm = {
    name: '',
    description: ''
  };

  userForm = {
    name: '',
    login: '',
    password: '',
    folderId: 0
  };

  folders: PhotoFolder[] = [];
  users: PhotoUser[] = [];
  uploadQueue: UploadQueueItem[] = [];

  constructor(private readonly photoAccess: PhotoAccessService) {
    if (this.photoAccess.adminToken) {
      this.adminLogged = true;
      this.loadAdminState(false);
    }

    if (this.photoAccess.clientToken) {
      this.loadClientFolder(false);
    }
  }

  ngOnDestroy(): void {
    this.uploadQueue.forEach((item) => item.subscription?.unsubscribe());
    this.zipPolling?.unsubscribe();
  }

  @HostListener('window:beforeunload', ['$event'])
  protectPendingUploads(event: BeforeUnloadEvent): void {
    if (this.hasUnfinishedUploads) {
      event.preventDefault();
      event.returnValue = 'Existem fotos aguardando ou sendo enviadas.';
    }
  }

  get selectedFolder(): PhotoFolder | undefined {
    return this.folders.find((folder) => folder.id === Number(this.selectedFolderId));
  }

  get userFolderName(): string {
    return this.clientFolder?.name ?? '';
  }

  get hasUnfinishedUploads(): boolean {
    return this.uploadQueue.some((item) => item.status === 'aguardando' || item.status === 'enviando');
  }

  get activeUploads(): number {
    return this.uploadQueue.filter((item) => item.status === 'enviando').length;
  }

  get filteredUploadQueue(): UploadQueueItem[] {
    const items = this.queueFilter === 'todos'
      ? this.uploadQueue
      : this.uploadQueue.filter((item) => item.status === this.queueFilter);

    return items.slice(0, 160);
  }

  get queueSummary() {
    const total = this.uploadQueue.length;
    const waiting = this.countUploads('aguardando');
    const uploading = this.countUploads('enviando');
    const completed = this.countUploads('concluido');
    const failed = this.countUploads('erro');
    const canceled = this.countUploads('cancelado');
    const totalBytes = this.uploadQueue.reduce((sum, item) => sum + item.size, 0);
    const sentBytes = this.uploadQueue.reduce((sum, item) => {
      if (item.status === 'concluido') {
        return sum + item.size;
      }

      return sum + Math.min(item.uploadedBytes, item.size);
    }, 0);
    const percent = totalBytes ? Math.round((sentBytes / totalBytes) * 100) : 0;

    return { total, waiting, uploading, completed, failed, canceled, totalBytes, sentBytes, percent };
  }

  switchPanel(panel: ActivePanel): void {
    this.activePanel = panel;
    this.clearAlerts();
  }

  loginAdmin(): void {
    this.clearAlerts();
    this.loading = true;

    this.photoAccess.loginAdmin(this.adminForm.login, this.adminForm.password).subscribe({
      next: () => {
        this.adminLogged = true;
        this.message = 'Admin conectado. Voce ja pode criar pastas, enviar fotos e liberar acessos.';
        this.loadAdminState(false);
      },
      error: () => {
        this.error = 'Login do admin invalido.';
        this.loading = false;
      }
    });
  }

  logoutAdmin(): void {
    this.photoAccess.logoutAdmin();
    this.adminLogged = false;
    this.adminForm = { login: '', password: '' };
    this.folders = [];
    this.users = [];
    this.clearAlerts();
  }

  loginClient(): void {
    this.clearAlerts();
    this.loading = true;

    this.photoAccess.loginClient(this.clientForm.login, this.clientForm.password).subscribe({
      next: (response) => {
        this.clientUser = response.user;
        this.clientFolder = response.folder;
        this.clientLogged = true;
        this.message = `Bem-vindo(a), ${response.user?.name ?? 'cliente'}.`;
        this.loading = false;
      },
      error: () => {
        this.error = 'Login ou senha nao encontrados.';
        this.loading = false;
      }
    });
  }

  logoutClient(): void {
    this.photoAccess.logoutClient();
    this.zipPolling?.unsubscribe();
    this.clientLogged = false;
    this.clientUser = undefined;
    this.clientFolder = undefined;
    this.zipJob = undefined;
    this.clientForm = { login: '', password: '' };
    this.clearAlerts();
  }

  createZip(): void {
    if (!this.clientFolder) {
      return;
    }

    this.loading = true;
    this.message = 'Preparando o download das fotos. Voce pode acompanhar o progresso abaixo.';
    this.photoAccess.createZip(this.clientFolder.id).subscribe({
      next: (job) => {
        this.zipJob = job;
        this.loading = false;
        this.pollZip(job.uuid);
      },
      error: () => this.showError('Nao foi possivel iniciar o download.')
    });
  }

  downloadZip(): void {
    if (!this.zipJob?.url) {
      return;
    }

    const link = document.createElement('a');
    link.href = this.photoAccess.zipUrl(this.zipJob);
    link.download = 'fotos.zip';
    link.click();
    this.message = 'Download do ZIP iniciado.';
  }

  createFolder(): void {
    this.clearAlerts();
    const name = this.folderForm.name.trim();

    if (!name) {
      this.error = 'Informe o nome da pasta.';
      return;
    }

    this.loading = true;
    this.photoAccess.createFolder(name, this.folderForm.description).subscribe({
      next: (folder) => {
        this.folderForm = { name: '', description: '' };
        this.selectedFolderId = folder.id;
        this.uploadFolderId = folder.id;
        this.userForm.folderId = folder.id;
        this.message = 'Pasta criada com sucesso.';
        this.loadAdminState(false);
      },
      error: () => this.showError('Nao foi possivel criar a pasta.')
    });
  }

  addPhotosFromInput(event: Event): void {
    this.clearAlerts();
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);

    if (!this.uploadFolderId) {
      this.error = 'Escolha uma pasta antes de enviar fotos.';
      input.value = '';
      return;
    }

    if (!files.length) {
      return;
    }

    this.addFilesToQueue(files);
    input.value = '';
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.clearAlerts();

    if (!this.uploadFolderId) {
      this.error = 'Escolha uma pasta antes de enviar fotos.';
      return;
    }

    this.addFilesToQueue(Array.from(event.dataTransfer?.files ?? []));
  }

  allowDrop(event: DragEvent): void {
    event.preventDefault();
  }

  startQueue(): void {
    this.clearAlerts();
    this.uploadFinishedNotified = false;

    if (!this.uploadFolderId) {
      this.error = 'Escolha uma pasta antes de iniciar.';
      return;
    }

    if (!this.uploadQueue.some((item) => item.status === 'aguardando')) {
      this.error = 'Nao ha fotos aguardando envio.';
      return;
    }

    this.queuePaused = false;

    if (!this.uploadSessionUuid) {
      const summary = this.queueSummary;
      this.photoAccess.createUploadSession(Number(this.uploadFolderId), summary.total, summary.totalBytes).subscribe({
        next: (session) => {
          this.uploadSessionUuid = session.uuid;
          this.scheduleUploads();
        },
        error: () => this.showError('Nao foi possivel criar a sessao de upload.')
      });
      return;
    }

    this.scheduleUploads();
  }

  pauseQueue(): void {
    this.queuePaused = true;
    this.message = 'Fila pausada. Os envios em andamento continuam, mas nenhum novo arquivo sera iniciado.';
  }

  resumeQueue(): void {
    this.clearAlerts();
    this.uploadFinishedNotified = false;
    this.queuePaused = false;
    this.scheduleUploads();
  }

  cancelPendingUploads(): void {
    this.uploadQueue
      .filter((item) => item.status === 'aguardando')
      .forEach((item) => {
        item.status = 'cancelado';
        item.progress = 0;
      });
    this.touchQueue();
    this.reportQueueFinishedIfNeeded();
  }

  cancelUpload(item: UploadQueueItem): void {
    if (item.status === 'enviando') {
      item.subscription?.unsubscribe();
    }

    item.status = 'cancelado';
    item.error = undefined;
    item.uploadedBytes = 0;
    item.progress = 0;
    this.touchQueue();
    this.reportQueueFinishedIfNeeded();
    this.scheduleUploads();
  }

  retryUpload(item: UploadQueueItem): void {
    if (item.status !== 'erro') {
      return;
    }

    item.status = 'aguardando';
    item.error = undefined;
    item.progress = 0;
    item.uploadedBytes = 0;
    this.uploadFinishedNotified = false;
    this.queuePaused = false;
    this.touchQueue();
    this.scheduleUploads();
  }

  retryFailedUploads(): void {
    this.uploadQueue
      .filter((item) => item.status === 'erro')
      .forEach((item) => {
        item.status = 'aguardando';
        item.error = undefined;
        item.progress = 0;
        item.uploadedBytes = 0;
      });
    this.uploadFinishedNotified = false;
    this.queuePaused = false;
    this.touchQueue();
    this.scheduleUploads();
  }

  clearCompletedUploads(): void {
    this.uploadQueue = this.uploadQueue.filter((item) => item.status !== 'concluido');
  }

  createUser(): void {
    this.clearAlerts();
    const { name, login, password, folderId } = this.userForm;

    if (!name.trim() || !login.trim() || !password || !folderId) {
      this.error = 'Preencha nome, login, senha e pasta liberada.';
      return;
    }

    this.loading = true;
    this.photoAccess.createUser(name, login, password, Number(folderId)).subscribe({
      next: (user) => {
        this.userForm = { name: '', login: '', password: '', folderId: Number(folderId) };
        this.message = 'Usuario criado e vinculado a pasta.';
        this.users = [user, ...this.users.filter((item) => item.id !== user.id)];
        this.loading = false;
      },
      error: (response) => {
        const message = response?.error?.message ?? 'Nao foi possivel criar o usuario.';
        this.showError(message);
      }
    });
  }

  deletePhoto(photoId: number): void {
    this.loading = true;
    this.photoAccess.deletePhoto(photoId).subscribe({
      next: () => {
        this.message = 'Foto removida.';
        this.loadAdminState(false);
      },
      error: () => this.showError('Nao foi possivel remover a foto.')
    });
  }

  deleteFolder(folderId: number): void {
    this.loading = true;
    this.photoAccess.deleteFolder(folderId).subscribe({
      next: () => {
        this.message = 'Pasta removida junto com os acessos ligados a ela.';
        this.selectedFolderId = 0;
        this.uploadFolderId = 0;
        this.userForm.folderId = 0;
        this.loadAdminState(false);
      },
      error: () => this.showError('Nao foi possivel remover a pasta.')
    });
  }

  deleteUser(userId: number): void {
    this.loading = true;
    this.photoAccess.deleteUser(userId).subscribe({
      next: () => {
        this.message = 'Usuario removido.';
        this.loadAdminState(false);
      },
      error: () => this.showError('Nao foi possivel remover o usuario.')
    });
  }

  downloadPhoto(photo: PhotoFile): void {
    this.photoAccess.downloadPhoto({ ...photo, url: this.photoAccess.photoUrl(photo, this.activePanel === 'admin' ? 'admin' : 'client') });
  }

  photoUrl(photo: PhotoFile, role: 'admin' | 'client'): string {
    return this.photoAccess.photoUrl(photo, role);
  }

  formatSize(size: number): string {
    return this.photoAccess.formatSize(size);
  }

  getFolderName(folderId: number): string {
    return this.folders.find((folder) => folder.id === folderId)?.name ?? 'Pasta removida';
  }

  private loadAdminState(showLoading = true): void {
    if (showLoading) {
      this.loading = true;
    }

    this.photoAccess.getAdminState().subscribe({
      next: (state) => {
        this.folders = state.folders;
        this.users = state.users;
        this.selectedFolderId = this.selectedFolderId || this.folders[0]?.id || 0;
        this.uploadFolderId = this.uploadFolderId || this.folders[0]?.id || 0;
        this.userForm.folderId = this.userForm.folderId || this.folders[0]?.id || 0;
        this.loading = false;
      },
      error: () => {
        this.photoAccess.logoutAdmin();
        this.adminLogged = false;
        this.showError('Sessao do admin expirada. Entre novamente.');
      }
    });
  }

  private addFilesToQueue(files: File[]): void {
    const existingKeys = new Set(this.uploadQueue.map((item) => item.key));
    let added = 0;
    let rejected = 0;

    files.forEach((file) => {
      const relativePath = this.getRelativePath(file);
      const key = `${relativePath || file.name}-${file.size}-${file.lastModified}`;
      const validationError = this.validateFile(file);

      if (existingKeys.has(key)) {
        rejected += 1;
        return;
      }

      existingKeys.add(key);
      const item: UploadQueueItem = {
        id: crypto.randomUUID(),
        key,
        file,
        name: file.name,
        relativePath,
        size: file.size,
        progress: 0,
        status: validationError ? 'erro' : 'aguardando',
        attempts: 0,
        uploadedBytes: 0,
        error: validationError
      };

      this.uploadQueue = [...this.uploadQueue, item];
      validationError ? rejected += 1 : added += 1;
    });

    this.uploadFinishedNotified = false;
    this.message = `${added} foto(s) adicionada(s) a fila.`;

    if (rejected) {
      this.error = `${rejected} arquivo(s) ignorado(s) por duplicidade ou validacao.`;
    }
  }

  private scheduleUploads(): void {
    if (this.queuePaused || !this.uploadSessionUuid) {
      return;
    }

    while (this.activeUploads < this.uploadConcurrency) {
      const next = this.uploadQueue.find((item) => item.status === 'aguardando');

      if (!next) {
        if (!this.activeUploads) {
          this.reportQueueFinishedIfNeeded();
          this.loadAdminState(false);
        }
        return;
      }

      this.uploadSingle(next);
    }
  }

  private uploadSingle(item: UploadQueueItem): void {
    item.status = 'enviando';
    item.attempts += 1;
    item.error = undefined;
    this.touchQueue();

    item.subscription = this.photoAccess
      .uploadPhoto(Number(this.uploadFolderId), this.uploadSessionUuid, item.key, item.file, item.relativePath)
      .subscribe({
        next: (event) => this.handleUploadEvent(item, event),
        error: (response) => {
          item.status = 'erro';
          item.error = response?.error?.message ?? 'Falha no envio.';
          item.uploadedBytes = 0;
          item.progress = 0;
          this.touchQueue();
          this.reportQueueFinishedIfNeeded();
          this.scheduleUploads();
        },
        complete: () => {
          this.touchQueue();
          this.reportQueueFinishedIfNeeded();
          this.scheduleUploads();
        }
      });
  }

  private handleUploadEvent(item: UploadQueueItem, event: HttpEvent<{ photo: PhotoFile }>): void {
    if (event.type === HttpEventType.UploadProgress) {
      const loaded = event.loaded || 0;
      const total = event.total || item.size;
      item.uploadedBytes = Math.min(loaded, item.size);
      item.progress = total ? Math.round((loaded / total) * 100) : item.progress;
      this.touchQueue();
      return;
    }

    if (event.type === HttpEventType.Response) {
      item.status = 'concluido';
      item.progress = 100;
      item.uploadedBytes = item.size;
      item.photo = event.body?.photo;
      this.touchQueue();
    }
  }

  private validateFile(file: File): string | undefined {
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';

    if (!this.allowedExtensions.has(extension)) {
      return 'Formato nao permitido.';
    }

    if (file.type && !this.allowedTypes.has(file.type)) {
      return 'Tipo de imagem nao permitido.';
    }

    if (file.size > this.maxPhotoSize) {
      return `Arquivo maior que ${this.formatSize(this.maxPhotoSize)}.`;
    }

    return undefined;
  }

  private getRelativePath(file: File): string {
    const fileWithPath = file as File & { webkitRelativePath?: string };
    return fileWithPath.webkitRelativePath || file.name;
  }

  private countUploads(status: UploadStatus): number {
    return this.uploadQueue.filter((item) => item.status === status).length;
  }

  private loadClientFolder(showLoading = true): void {
    if (showLoading) {
      this.loading = true;
    }

    this.photoAccess.getClientFolder().subscribe({
      next: (response) => {
        this.clientUser = response.user;
        this.clientFolder = response.folder;
        this.clientLogged = true;
        this.loading = false;
      },
      error: () => {
        this.photoAccess.logoutClient();
        this.clientLogged = false;
        this.loading = false;
      }
    });
  }

  private pollZip(jobUuid: string): void {
    this.zipPolling?.unsubscribe();
    this.zipPolling = new Subscription();

    const tick = () => {
      const sub = this.photoAccess.getZipJob(jobUuid).subscribe({
        next: (job) => {
          this.zipJob = job;

          if (job.status === 'pronto' || job.status === 'erro') {
            this.message = job.status === 'pronto'
              ? 'ZIP pronto. Clique em Baixar ZIP para iniciar o download.'
              : 'Nao foi possivel preparar o ZIP. Tente novamente.';
            return;
          }

          window.setTimeout(tick, 1800);
        },
        error: () => undefined
      });
      this.zipPolling?.add(sub);
    };

    tick();
  }

  private showError(message: string): void {
    this.error = message;
    this.loading = false;
  }

  private clearAlerts(): void {
    this.message = '';
    this.error = '';
  }

  private touchQueue(): void {
    this.uploadQueue = [...this.uploadQueue];
  }

  private reportQueueFinishedIfNeeded(): void {
    const summary = this.queueSummary;
    const finished = summary.total > 0 && !summary.waiting && !summary.uploading;

    if (!finished || this.uploadFinishedNotified) {
      return;
    }

    this.uploadFinishedNotified = true;
    this.queuePaused = true;

    if (summary.failed) {
      this.message = `Envio finalizado com ${summary.completed} concluida(s), ${summary.failed} falha(s) e ${summary.canceled} cancelada(s).`;
      return;
    }

    this.message = `Envio finalizado: ${summary.completed} foto(s) enviada(s) com sucesso.`;
  }
}
