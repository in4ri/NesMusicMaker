// A minimal 6502 assembler: just enough to build the NSF player routine
// readably, with labels and branch fix-ups.

type Fixup = { pos: number; label: string; kind: 'abs' | 'rel' };

export class Asm6502 {
  private readonly bytes: number[] = [];
  private readonly labels = new Map<string, number>();
  private readonly fixups: Fixup[] = [];

  constructor(readonly origin: number) {}

  get pc() {
    return this.origin + this.bytes.length;
  }

  label(name: string) {
    if (this.labels.has(name)) throw new Error(`Duplicate label ${name}`);
    this.labels.set(name, this.pc);
    return this;
  }

  addr(name: string) {
    const a = this.labels.get(name);
    if (a === undefined) throw new Error(`Unknown label ${name}`);
    return a;
  }

  byte(...values: number[]) {
    for (const v of values) this.bytes.push(v & 0xff);
    return this;
  }

  private abs(opcode: number, target: number | string) {
    this.bytes.push(opcode);
    if (typeof target === 'string') {
      this.fixups.push({ pos: this.bytes.length, label: target, kind: 'abs' });
      this.bytes.push(0, 0);
    } else {
      this.bytes.push(target & 0xff, (target >> 8) & 0xff);
    }
    return this;
  }

  private branch(opcode: number, label: string) {
    this.bytes.push(opcode);
    this.fixups.push({ pos: this.bytes.length, label, kind: 'rel' });
    this.bytes.push(0);
    return this;
  }

  // Loads/stores
  ldaImm(v: number) { return this.byte(0xa9, v); }
  ldaZp(zp: number) { return this.byte(0xa5, zp); }
  ldaIndY(zp: number) { return this.byte(0xb1, zp); }
  ldaAbsX(a: number | string) { return this.abs(0xbd, a); }
  staZp(zp: number) { return this.byte(0x85, zp); }
  staAbs(a: number | string) { return this.abs(0x8d, a); }
  staAbsX(a: number | string) { return this.abs(0x9d, a); }
  staAbsY(a: number | string) { return this.abs(0x99, a); }
  ldxImm(v: number) { return this.byte(0xa2, v); }
  ldyImm(v: number) { return this.byte(0xa0, v); }
  ldyZp(zp: number) { return this.byte(0xa4, zp); }
  styZp(zp: number) { return this.byte(0x84, zp); }
  styAbs(a: number | string) { return this.abs(0x8c, a); }
  // Arithmetic/logic
  incZp(zp: number) { return this.byte(0xe6, zp); }
  decZp(zp: number) { return this.byte(0xc6, zp); }
  inx() { return this.byte(0xe8); }
  andImm(v: number) { return this.byte(0x29, v); }
  cmpImm(v: number) { return this.byte(0xc9, v); }
  cpyImm(v: number) { return this.byte(0xc0, v); }
  tax() { return this.byte(0xaa); }
  tay() { return this.byte(0xa8); }
  // Flow
  beq(l: string) { return this.branch(0xf0, l); }
  bne(l: string) { return this.branch(0xd0, l); }
  bcs(l: string) { return this.branch(0xb0, l); }
  jsr(a: number | string) { return this.abs(0x20, a); }
  jmp(a: number | string) { return this.abs(0x4c, a); }
  rts() { return this.byte(0x60); }

  assemble(): Uint8Array {
    for (const f of this.fixups) {
      const target = this.addr(f.label);
      if (f.kind === 'abs') {
        this.bytes[f.pos] = target & 0xff;
        this.bytes[f.pos + 1] = target >> 8;
      } else {
        const rel = target - (this.origin + f.pos + 1);
        if (rel < -128 || rel > 127) throw new Error(`Branch to ${f.label} out of range`);
        this.bytes[f.pos] = rel & 0xff;
      }
    }
    return Uint8Array.from(this.bytes);
  }
}
