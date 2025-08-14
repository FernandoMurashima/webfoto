import { Routes } from '@angular/router';
import { HomeComponent } from './pages/home/home.component';
import { SobreComponent } from './pages/sobre/sobre.component';
import { ContatoComponent } from './pages/contato/contato.component';
import { TrabalhosComponent } from './pages/trabalhos/trabalhos.component';
import { OrcamentoComponent } from './pages/orcamento/orcamento.component';

import { AniversariosComponent } from './pages/trabalhos/aniversarios/aniversarios.component';
import { ChaRevelacaoComponent } from './pages/trabalhos/cha-revelacao/cha-revelacao.component';
import { BatizadoComponent } from './pages/trabalhos/batizado/batizado.component';

export const routes: Routes = [
  { path: '', component: HomeComponent },
  { path: 'sobre', component: SobreComponent },
  { path: 'trabalhos', component: TrabalhosComponent },
  { path: 'orcamento', component: OrcamentoComponent },
  { path: 'contato', component: ContatoComponent }, // pode manter por enquanto
  { path: 'trabalhos/aniversarios', component: AniversariosComponent },
  { path: 'trabalhos/cha-revelacao', component: ChaRevelacaoComponent },
  { path: 'trabalhos/batizado', component: BatizadoComponent },
  { path: '**', redirectTo: '' }
];
