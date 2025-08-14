import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-trabalhos',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './trabalhos.component.html',
  styleUrl: './trabalhos.component.css'
})
export class TrabalhosComponent {}
