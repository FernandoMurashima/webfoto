import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-batizado',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './batizado.component.html',
  styleUrl: './batizado.component.css'
})
export class BatizadoComponent {
  fotos = [
    'assets/trabalhos/covers/batizado/01.jpg',
    'assets/trabalhos/covers/batizado/02.jpg',
    'assets/trabalhos/covers/batizado/03.jpg',
    'assets/trabalhos/covers/batizado/04.jpg'
  ];
}
