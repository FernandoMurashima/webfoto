import { Routes } from '@angular/router';
import { HomeComponent } from './pages/home/home.component';
import { SobreComponent } from './pages/sobre/sobre.component';
import { ContatoComponent } from './pages/contato/contato.component';
import { TrabalhosComponent } from './pages/trabalhos/trabalhos.component';
import { OrcamentoComponent } from './pages/orcamento/orcamento.component';

export const routes: Routes = [
  { path: '', component: HomeComponent },
  { path: 'sobre', component: SobreComponent },
  { path: 'trabalhos', component: TrabalhosComponent },
  { path: 'orcamento', component: OrcamentoComponent },
  { path: 'contato', component: ContatoComponent }, // pode manter por enquanto
  { path: '**', redirectTo: '' }
];
