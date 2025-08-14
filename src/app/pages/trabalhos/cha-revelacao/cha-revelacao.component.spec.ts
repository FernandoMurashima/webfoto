import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ChaRevelacaoComponent } from './cha-revelacao.component';

describe('ChaRevelacaoComponent', () => {
  let component: ChaRevelacaoComponent;
  let fixture: ComponentFixture<ChaRevelacaoComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ChaRevelacaoComponent]
    })
    .compileComponents();
    
    fixture = TestBed.createComponent(ChaRevelacaoComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
