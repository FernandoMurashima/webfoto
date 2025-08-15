import { Component, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Location } from '@angular/common';
import { Router } from '@angular/router';

type Foto = { thumb: string; full: string; alt: string };

@Component({
  selector: 'app-aniversarios',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './aniversarios.component.html',
  styleUrl: './aniversarios.component.css'
})
export class AniversariosComponent {

  // Miniaturas (thumb) → abre versão em alta (full)
  fotos: Foto[] = [
    {
      thumb: 'assets/trabalhos/covers/aniversarios/01 - Copia.jpg',
      full:  'assets/trabalhos/covers/aniversarios/01.jpg',
      alt:   'Aniversário 01'
    },
    {
      thumb: 'assets/trabalhos/covers/aniversarios/02 - Copia.jpg',
      full:  'assets/trabalhos/covers/aniversarios/02.jpg',
      alt:   'Aniversário 02'
    },
    {
      thumb: 'assets/trabalhos/covers/aniversarios/03 - Copia.jpg',
      full:  'assets/trabalhos/covers/aniversarios/03.jpg',
      alt:   'Aniversário 03'
    },
    {
      thumb: 'assets/trabalhos/covers/aniversarios/04 - Copia.jpg',
      full:  'assets/trabalhos/covers/aniversarios/04.jpg',
      alt:   'Aniversário 04'
    }
  ];

  // Lightbox state
  lightboxAberta = false;
  fotoAtiva = 0;

  constructor(private location: Location, private router: Router) {}

  // Botão Voltar (mantém seu padrão anterior)
  voltar(): void {
    if (window.history.length > 1) {
      this.location.back();
    } else {
      this.router.navigate(['/trabalhos']);
    }
  }

  // Abrir/fechar
  abrirLightbox(index: number): void {
    this.fotoAtiva = index;
    this.lightboxAberta = true;
    document.body.style.overflow = 'hidden'; // bloqueia scroll de fundo
  }
  fecharLightbox(): void {
    this.lightboxAberta = false;
    document.body.style.overflow = '';       // restaura scroll
  }

  // Navegação opcional
  proxima(): void {
    this.fotoAtiva = (this.fotoAtiva + 1) % this.fotos.length;
  }
  anterior(): void {
    this.fotoAtiva = (this.fotoAtiva - 1 + this.fotos.length) % this.fotos.length;
  }

  // Teclado: ESC fecha, setas navegam
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
