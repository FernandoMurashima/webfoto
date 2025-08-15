import { Component, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Location } from '@angular/common';
import { Router } from '@angular/router';

type Foto = { thumb: string; full: string; alt: string };

@Component({
  selector: 'app-cha-revelacao',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './cha-revelacao.component.html',
  styleUrls: ['./cha-revelacao.component.css']
})
export class ChaRevelacaoComponent {
  fotos: Foto[] = [
    {
      thumb: 'assets/trabalhos/covers/cha-revelacao/01 - Copia.jpg',
      full:  'assets/trabalhos/covers/cha-revelacao/01.jpg',
      alt:   'Chá Revelação 01'
    },
    {
      thumb: 'assets/trabalhos/covers/cha-revelacao/02 - Copia.jpg',
      full:  'assets/trabalhos/covers/cha-revelacao/02.jpg',
      alt:   'Chá Revelação 02'
    },
    {
      thumb: 'assets/trabalhos/covers/cha-revelacao/03 - Copia.jpg',
      full:  'assets/trabalhos/covers/cha-revelacao/03.jpg',
      alt:   'Chá Revelação 03'
    },
    {
      thumb: 'assets/trabalhos/covers/cha-revelacao/04 - Copia.jpg',
      full:  'assets/trabalhos/covers/cha-revelacao/04.jpg',
      alt:   'Chá Revelação 04'
    }
  ];

  lightboxAberta = false;
  fotoAtiva = 0;

  constructor(private location: Location, private router: Router) {}

  voltar(): void {
    if (window.history.length > 1) {
      this.location.back();
    } else {
      this.router.navigate(['/trabalhos']);
    }
  }

  abrirLightbox(index: number): void {
    this.fotoAtiva = index;
    this.lightboxAberta = true;
    document.body.style.overflow = 'hidden';
  }
  fecharLightbox(): void {
    this.lightboxAberta = false;
    document.body.style.overflow = '';
  }

  proxima(): void {
    this.fotoAtiva = (this.fotoAtiva + 1) % this.fotos.length;
  }
  anterior(): void {
    this.fotoAtiva = (this.fotoAtiva - 1 + this.fotos.length) % this.fotos.length;
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(ev: KeyboardEvent) {
    if (!this.lightboxAberta) return;
    if (ev.key === 'Escape') this.fecharLightbox();
    if (ev.key === 'ArrowRight') this.proxima();
    if (ev.key === 'ArrowLeft') this.anterior();
  }

  get fotoFullAtual(): Foto {
    return this.fotos[this.fotoAtiva];
  }
}
