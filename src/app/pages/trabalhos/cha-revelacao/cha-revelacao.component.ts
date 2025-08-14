import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-cha-revelacao',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './cha-revelacao.component.html',
  styleUrl: './cha-revelacao.component.css'
})
export class ChaRevelacaoComponent {
  fotos = [
    'assets/trabalhos/covers/cha-revelacao/01.jpg',
    'assets/trabalhos/covers/cha-revelacao/02.jpg',
    'assets/trabalhos/covers/cha-revelacao/03.jpg',
    'assets/trabalhos/covers/cha-revelacao/04.jpg'
  ];
}
