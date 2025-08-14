import { Component, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, NgForm } from '@angular/forms';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-orcamento',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './orcamento.component.html',
  styleUrl: './orcamento.component.css'
})
export class OrcamentoComponent {
  @ViewChild('f') formRef!: NgForm;

  // Campos
  nome_requisitante = '';
  tipo_evento = '';
  data_desejada: string | null = null;
  horario: string | null = null;
  quantidade_pessoas: number | null = null;
  duracao_horas: number | null = null;
  descricao = '';

  logradouro = '';
  numero = '';
  complemento = '';
  bairro = '';
  cidade = '';
  estado = '';
  cep = '';

  celular = '';
  email = '';

  mensagem = '';

  solicitarOrcamento() {
    if (!this.formRef?.valid) {
      this.mensagem = 'Por favor, preencha os campos obrigatórios.';
      return;
    }

    const assunto = `Solicitação de Orçamento - ${this.nome_requisitante || 'Sem nome'}${
      this.data_desejada ? ` - ${this.data_desejada}` : ''
    }`;

    const linhas = [
      'SOLICITAÇÃO DE ORÇAMENTO',
      '',
      'Dados do solicitante',
      `Nome: ${this.nome_requisitante || '-'}`,
      `E-mail: ${this.email || '-'}`,
      `Celular: ${this.celular || '-'}`,
      '',
      'Evento',
      `Tipo: ${this.tipo_evento || '-'}`,
      `Data desejada: ${this.data_desejada || '-'}`,
      `Horário: ${this.horario || '-'}`,
      `Pessoas: ${this.quantidade_pessoas ?? '-'}`,
      `Duração (h): ${this.duracao_horas ?? '-'}`,
      `Descrição: ${this.descricao || '-'}`,
      '',
      'Endereço',
      `Logradouro: ${this.logradouro || '-'}`,
      `Número: ${this.numero || '-'}`,
      `Complemento: ${this.complemento || '-'}`,
      `Bairro: ${this.bairro || '-'}`,
      `Cidade: ${this.cidade || '-'}`,
      `Estado: ${this.estado || '-'}`,
      `CEP: ${this.cep || '-'}`,
      '',
      'Enviado via site Webfoto'
    ];

    const corpo = linhas.join('\n');
    const to = 'may.casmurashima@gmail.com';
    const mailto = `mailto:${to}?subject=${encodeURIComponent(assunto)}&body=${encodeURIComponent(corpo)}`;

    // Abre o cliente de e-mail do usuário
    window.location.href = mailto;

    this.mensagem = 'Abrimos seu e-mail com a solicitação preenchida. Basta revisar e enviar.';
  }

  cancelar() {
    this.formRef?.resetForm();
    this.mensagem = '';
  }
}
