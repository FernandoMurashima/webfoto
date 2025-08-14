import { ComponentFixture, TestBed } from '@angular/core/testing';

import { BatizadoComponent } from './batizado.component';

describe('BatizadoComponent', () => {
  let component: BatizadoComponent;
  let fixture: ComponentFixture<BatizadoComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [BatizadoComponent]
    })
    .compileComponents();
    
    fixture = TestBed.createComponent(BatizadoComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
