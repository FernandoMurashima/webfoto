import { CanDeactivateFn } from '@angular/router';

export interface PendingUploadAware {
  hasUnfinishedUploads: boolean;
}

export const pendingUploadGuard: CanDeactivateFn<PendingUploadAware> = (component) => {
  if (!component.hasUnfinishedUploads) {
    return true;
  }

  return window.confirm('Existem fotos ainda nao enviadas. Deseja sair mesmo assim?');
};
