import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-aniversarios',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './aniversarios.component.html',
  styleUrl: './aniversarios.component.css'
})
export class AniversariosComponent {
  fotos = [
    'assets/trabalhos/covers/aniversarios/01.jpg',
    'assets/trabalhos/covers/aniversarios/02.jpg',
    'assets/trabalhos/covers/aniversarios/03.jpg',
    'assets/trabalhos/covers/aniversarios/04.jpg'
  ];
}
