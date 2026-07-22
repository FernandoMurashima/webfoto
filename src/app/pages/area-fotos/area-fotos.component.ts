import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PhotoAccessService, PhotoFile, PhotoFolder, PhotoUser } from '../../services/photo-access.service';

type ActivePanel = 'cliente' | 'admin';

@Component({
  selector: 'app-area-fotos',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './area-fotos.component.html',
  styleUrl: './area-fotos.component.css'
})
export class AreaFotosComponent {
  activePanel: ActivePanel = 'cliente';
  adminLogged = false;
  clientLogged = false;
  loading = false;
  selectedFolderId = 0;
  uploadFolderId = 0;
  clientUser?: PhotoUser;
  clientFolder?: PhotoFolder;
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

  constructor(private readonly photoAccess: PhotoAccessService) {
    if (this.photoAccess.adminToken) {
      this.adminLogged = true;
      this.loadAdminState(false);
    }

    if (this.photoAccess.clientToken) {
      this.loadClientFolder(false);
    }
  }

  get selectedFolder(): PhotoFolder | undefined {
    return this.folders.find((folder) => folder.id === Number(this.selectedFolderId));
  }

  get userFolderName(): string {
    return this.clientFolder?.name ?? '';
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
    this.clientLogged = false;
    this.clientUser = undefined;
    this.clientFolder = undefined;
    this.clientForm = { login: '', password: '' };
    this.clearAlerts();
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

  uploadPhotos(event: Event): void {
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

    const images = files.filter((file) => file.type.startsWith('image/'));

    if (!images.length) {
      this.error = 'Selecione arquivos de imagem.';
      input.value = '';
      return;
    }

    this.loading = true;
    this.photoAccess.uploadPhotos(Number(this.uploadFolderId), images).subscribe({
      next: (response) => {
        this.selectedFolderId = Number(this.uploadFolderId);
        this.message = `${response.photos.length} foto(s) enviada(s).`;
        this.loadAdminState(false);
        input.value = '';
      },
      error: () => {
        input.value = '';
        this.showError('Nao foi possivel carregar as fotos.');
      }
    });
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
      next: () => {
        this.userForm = { name: '', login: '', password: '', folderId: Number(folderId) };
        this.message = 'Usuario criado e vinculado a pasta.';
        this.loadAdminState(false);
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

  private showError(message: string): void {
    this.error = message;
    this.loading = false;
  }

  private clearAlerts(): void {
    this.message = '';
    this.error = '';
  }
}
