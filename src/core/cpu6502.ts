// MOS 6502 CPU core as found in the NES's 2A03 (no decimal mode).
// Implements all official opcodes plus the stable unofficial ones that NSF
// music drivers occasionally use. Cycle counts are approximate (page-cross
// penalties included, no dummy reads) — enough to budget routine run time.

type Mode = 'imp' | 'acc' | 'imm' | 'zp' | 'zpx' | 'zpy' | 'abs' | 'abx' | 'aby' | 'ind' | 'izx' | 'izy' | 'rel';

interface OpInfo {
  name: string;
  mode: Mode;
  cycles: number;
  /** Adds a cycle when indexing crosses a page (read instructions only). */
  penalty: boolean;
}

const OPS: (OpInfo | undefined)[] = new Array(256);

function def(code: number, name: string, mode: Mode, cycles: number, penalty = false) {
  OPS[code] = { name, mode, cycles, penalty };
}

// Main ALU group (aaa bbb 01).
const ALU: [string, number][] = [['ORA', 0x00], ['AND', 0x20], ['EOR', 0x40], ['ADC', 0x60], ['STA', 0x80], ['LDA', 0xa0], ['CMP', 0xc0], ['SBC', 0xe0]];
for (const [name, base] of ALU) {
  const store = name === 'STA';
  def(base + 0x01, name, 'izx', 6);
  def(base + 0x05, name, 'zp', 3);
  if (!store) def(base + 0x09, name, 'imm', 2);
  def(base + 0x0d, name, 'abs', 4);
  def(base + 0x11, name, 'izy', store ? 6 : 5, !store);
  def(base + 0x15, name, 'zpx', 4);
  def(base + 0x19, name, 'aby', store ? 5 : 4, !store);
  def(base + 0x1d, name, 'abx', store ? 5 : 4, !store);
}
// Shifts and increments.
for (const [name, base] of [['ASL', 0x00], ['ROL', 0x20], ['LSR', 0x40], ['ROR', 0x60]] as [string, number][]) {
  def(base + 0x0a, name, 'acc', 2);
  def(base + 0x06, name, 'zp', 5);
  def(base + 0x16, name, 'zpx', 6);
  def(base + 0x0e, name, 'abs', 6);
  def(base + 0x1e, name, 'abx', 7);
}
for (const [name, base] of [['DEC', 0xc0], ['INC', 0xe0]] as [string, number][]) {
  def(base + 0x06, name, 'zp', 5);
  def(base + 0x16, name, 'zpx', 6);
  def(base + 0x0e, name, 'abs', 6);
  def(base + 0x1e, name, 'abx', 7);
}
// Branches.
for (const [name, code] of [['BPL', 0x10], ['BMI', 0x30], ['BVC', 0x50], ['BVS', 0x70], ['BCC', 0x90], ['BCS', 0xb0], ['BNE', 0xd0], ['BEQ', 0xf0]] as [string, number][]) {
  def(code, name, 'rel', 2);
}
// Everything else official.
def(0x00, 'BRK', 'imp', 7);
def(0x24, 'BIT', 'zp', 3); def(0x2c, 'BIT', 'abs', 4);
def(0x18, 'CLC', 'imp', 2); def(0xd8, 'CLD', 'imp', 2); def(0x58, 'CLI', 'imp', 2); def(0xb8, 'CLV', 'imp', 2);
def(0x38, 'SEC', 'imp', 2); def(0xf8, 'SED', 'imp', 2); def(0x78, 'SEI', 'imp', 2);
def(0xe0, 'CPX', 'imm', 2); def(0xe4, 'CPX', 'zp', 3); def(0xec, 'CPX', 'abs', 4);
def(0xc0, 'CPY', 'imm', 2); def(0xc4, 'CPY', 'zp', 3); def(0xcc, 'CPY', 'abs', 4);
def(0xca, 'DEX', 'imp', 2); def(0x88, 'DEY', 'imp', 2); def(0xe8, 'INX', 'imp', 2); def(0xc8, 'INY', 'imp', 2);
def(0x4c, 'JMP', 'abs', 3); def(0x6c, 'JMP', 'ind', 5); def(0x20, 'JSR', 'abs', 6);
def(0xa2, 'LDX', 'imm', 2); def(0xa6, 'LDX', 'zp', 3); def(0xb6, 'LDX', 'zpy', 4); def(0xae, 'LDX', 'abs', 4); def(0xbe, 'LDX', 'aby', 4, true);
def(0xa0, 'LDY', 'imm', 2); def(0xa4, 'LDY', 'zp', 3); def(0xb4, 'LDY', 'zpx', 4); def(0xac, 'LDY', 'abs', 4); def(0xbc, 'LDY', 'abx', 4, true);
def(0x86, 'STX', 'zp', 3); def(0x96, 'STX', 'zpy', 4); def(0x8e, 'STX', 'abs', 4);
def(0x84, 'STY', 'zp', 3); def(0x94, 'STY', 'zpx', 4); def(0x8c, 'STY', 'abs', 4);
def(0xea, 'NOP', 'imp', 2);
def(0x48, 'PHA', 'imp', 3); def(0x08, 'PHP', 'imp', 3); def(0x68, 'PLA', 'imp', 4); def(0x28, 'PLP', 'imp', 4);
def(0x40, 'RTI', 'imp', 6); def(0x60, 'RTS', 'imp', 6);
def(0xaa, 'TAX', 'imp', 2); def(0xa8, 'TAY', 'imp', 2); def(0xba, 'TSX', 'imp', 2);
def(0x8a, 'TXA', 'imp', 2); def(0x9a, 'TXS', 'imp', 2); def(0x98, 'TYA', 'imp', 2);

// Unofficial opcodes.
for (const c of [0x1a, 0x3a, 0x5a, 0x7a, 0xda, 0xfa]) def(c, 'NOP', 'imp', 2);
for (const c of [0x80, 0x82, 0x89, 0xc2, 0xe2]) def(c, 'NOP', 'imm', 2);
for (const c of [0x04, 0x44, 0x64]) def(c, 'NOP', 'zp', 3);
for (const c of [0x14, 0x34, 0x54, 0x74, 0xd4, 0xf4]) def(c, 'NOP', 'zpx', 4);
def(0x0c, 'NOP', 'abs', 4);
for (const c of [0x1c, 0x3c, 0x5c, 0x7c, 0xdc, 0xfc]) def(c, 'NOP', 'abx', 4, true);
def(0xa7, 'LAX', 'zp', 3); def(0xb7, 'LAX', 'zpy', 4); def(0xaf, 'LAX', 'abs', 4); def(0xbf, 'LAX', 'aby', 4, true);
def(0xa3, 'LAX', 'izx', 6); def(0xb3, 'LAX', 'izy', 5, true); def(0xab, 'LAX', 'imm', 2);
def(0x87, 'SAX', 'zp', 3); def(0x97, 'SAX', 'zpy', 4); def(0x8f, 'SAX', 'abs', 4); def(0x83, 'SAX', 'izx', 6);
def(0xeb, 'SBC', 'imm', 2);
for (const [name, base] of [['SLO', 0x00], ['RLA', 0x20], ['SRE', 0x40], ['RRA', 0x60], ['DCP', 0xc0], ['ISC', 0xe0]] as [string, number][]) {
  def(base + 0x03, name, 'izx', 8);
  def(base + 0x07, name, 'zp', 5);
  def(base + 0x0f, name, 'abs', 6);
  def(base + 0x13, name, 'izy', 8);
  def(base + 0x17, name, 'zpx', 6);
  def(base + 0x1b, name, 'aby', 7);
  def(base + 0x1f, name, 'abx', 7);
}
def(0x0b, 'ANC', 'imm', 2); def(0x2b, 'ANC', 'imm', 2);
def(0x4b, 'ALR', 'imm', 2); def(0x6b, 'ARR', 'imm', 2); def(0xcb, 'AXS', 'imm', 2);

export class Cpu6502 {
  a = 0;
  x = 0;
  y = 0;
  s = 0xfd;
  pc = 0;
  c = 0;
  z = 0;
  i = 1;
  d = 0;
  v = 0;
  n = 0;
  cycles = 0;
  /** Set when the CPU hits a jam (KIL) opcode; it stops executing. */
  jammed = false;

  constructor(
    private readonly read: (addr: number) => number,
    private readonly write: (addr: number, value: number) => void,
  ) {}

  get p() {
    return (this.n << 7) | (this.v << 6) | 0x20 | (this.d << 3) | (this.i << 2) | (this.z << 1) | this.c;
  }

  set p(value: number) {
    this.n = (value >> 7) & 1;
    this.v = (value >> 6) & 1;
    this.d = (value >> 3) & 1;
    this.i = (value >> 2) & 1;
    this.z = (value >> 1) & 1;
    this.c = value & 1;
  }

  private rd(addr: number) {
    return this.read(addr & 0xffff) & 0xff;
  }

  private wr(addr: number, value: number) {
    this.write(addr & 0xffff, value & 0xff);
  }

  private fetch() {
    const v = this.rd(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }

  private push(v: number) {
    this.wr(0x100 | this.s, v);
    this.s = (this.s - 1) & 0xff;
  }

  private pull() {
    this.s = (this.s + 1) & 0xff;
    return this.rd(0x100 | this.s);
  }

  private zn(v: number) {
    this.z = v === 0 ? 1 : 0;
    this.n = (v >> 7) & 1;
    return v;
  }

  /** Effective address for a memory addressing mode (adds page-cross cycles when `penalty`). */
  private address(mode: Mode, penalty: boolean): number {
    switch (mode) {
      case 'imm': {
        const a = this.pc;
        this.pc = (this.pc + 1) & 0xffff;
        return a;
      }
      case 'zp':
        return this.fetch();
      case 'zpx':
        return (this.fetch() + this.x) & 0xff;
      case 'zpy':
        return (this.fetch() + this.y) & 0xff;
      case 'abs': {
        const lo = this.fetch();
        return lo | (this.fetch() << 8);
      }
      case 'abx':
      case 'aby': {
        const lo = this.fetch();
        const base = lo | (this.fetch() << 8);
        const a = (base + (mode === 'abx' ? this.x : this.y)) & 0xffff;
        if (penalty && (a & 0xff00) !== (base & 0xff00)) this.cycles++;
        return a;
      }
      case 'ind': {
        const lo = this.fetch();
        const ptr = lo | (this.fetch() << 8);
        // 6502 bug: the high byte is read from the same page.
        const hiAddr = (ptr & 0xff00) | ((ptr + 1) & 0xff);
        return this.rd(ptr) | (this.rd(hiAddr) << 8);
      }
      case 'izx': {
        const zp = (this.fetch() + this.x) & 0xff;
        return this.rd(zp) | (this.rd((zp + 1) & 0xff) << 8);
      }
      case 'izy': {
        const zp = this.fetch();
        const base = this.rd(zp) | (this.rd((zp + 1) & 0xff) << 8);
        const a = (base + this.y) & 0xffff;
        if (penalty && (a & 0xff00) !== (base & 0xff00)) this.cycles++;
        return a;
      }
      default:
        return 0;
    }
  }

  private adc(value: number) {
    const sum = this.a + value + this.c;
    this.v = (~(this.a ^ value) & (this.a ^ sum) & 0x80) !== 0 ? 1 : 0;
    this.c = sum > 0xff ? 1 : 0;
    this.a = this.zn(sum & 0xff);
  }

  private compare(reg: number, value: number) {
    this.c = reg >= value ? 1 : 0;
    this.zn((reg - value) & 0xff);
  }

  private branch(cond: boolean) {
    const off = this.fetch();
    if (!cond) return;
    const target = (this.pc + (off < 0x80 ? off : off - 0x100)) & 0xffff;
    this.cycles += (target & 0xff00) !== (this.pc & 0xff00) ? 2 : 1;
    this.pc = target;
  }

  /** Read-modify-write helper: applies `fn` to the operand (accumulator or memory). */
  private rmw(mode: Mode, addr: number, fn: (v: number) => number) {
    if (mode === 'acc') {
      this.a = fn(this.a);
      return this.a;
    }
    const result = fn(this.rd(addr));
    this.wr(addr, result);
    return result;
  }

  private asl = (v: number) => {
    this.c = (v >> 7) & 1;
    return this.zn((v << 1) & 0xff);
  };
  private lsr = (v: number) => {
    this.c = v & 1;
    return this.zn(v >> 1);
  };
  private rol = (v: number) => {
    const r = ((v << 1) | this.c) & 0xff;
    this.c = (v >> 7) & 1;
    return this.zn(r);
  };
  private ror = (v: number) => {
    const r = (v >> 1) | (this.c << 7);
    this.c = v & 1;
    return this.zn(r);
  };

  /** Push a return address and jump, as a JSR from outside the program would. */
  callFrom(target: number, returnTo: number) {
    const ret = (returnTo - 1) & 0xffff;
    this.push(ret >> 8);
    this.push(ret & 0xff);
    this.pc = target;
  }

  /** Execute one instruction; returns the cycles it took. */
  step(): number {
    if (this.jammed) return 2;
    const before = this.cycles;
    const opcode = this.fetch();
    const op = OPS[opcode];
    if (!op) {
      // KIL/JAM opcodes ($02, $12, …) lock up a real 6502.
      if ((opcode & 0x0f) === 0x02 && opcode !== 0x82 && opcode !== 0xa2 && opcode !== 0xc2 && opcode !== 0xe2) this.jammed = true;
      this.cycles += 2;
      return 2;
    }
    this.cycles += op.cycles;
    const mode = op.mode;
    const needsAddr = mode !== 'imp' && mode !== 'acc' && mode !== 'rel';
    const addr = needsAddr ? this.address(mode, op.penalty) : 0;

    switch (op.name) {
      case 'LDA': this.a = this.zn(this.rd(addr)); break;
      case 'LDX': this.x = this.zn(this.rd(addr)); break;
      case 'LDY': this.y = this.zn(this.rd(addr)); break;
      case 'STA': this.wr(addr, this.a); break;
      case 'STX': this.wr(addr, this.x); break;
      case 'STY': this.wr(addr, this.y); break;
      case 'ORA': this.a = this.zn(this.a | this.rd(addr)); break;
      case 'AND': this.a = this.zn(this.a & this.rd(addr)); break;
      case 'EOR': this.a = this.zn(this.a ^ this.rd(addr)); break;
      case 'ADC': this.adc(this.rd(addr)); break;
      case 'SBC': this.adc(this.rd(addr) ^ 0xff); break;
      case 'CMP': this.compare(this.a, this.rd(addr)); break;
      case 'CPX': this.compare(this.x, this.rd(addr)); break;
      case 'CPY': this.compare(this.y, this.rd(addr)); break;
      case 'BIT': {
        const v = this.rd(addr);
        this.z = (this.a & v) === 0 ? 1 : 0;
        this.n = (v >> 7) & 1;
        this.v = (v >> 6) & 1;
        break;
      }
      case 'ASL': this.rmw(mode, addr, this.asl); break;
      case 'LSR': this.rmw(mode, addr, this.lsr); break;
      case 'ROL': this.rmw(mode, addr, this.rol); break;
      case 'ROR': this.rmw(mode, addr, this.ror); break;
      case 'INC': this.rmw(mode, addr, (v) => this.zn((v + 1) & 0xff)); break;
      case 'DEC': this.rmw(mode, addr, (v) => this.zn((v - 1) & 0xff)); break;
      case 'INX': this.x = this.zn((this.x + 1) & 0xff); break;
      case 'INY': this.y = this.zn((this.y + 1) & 0xff); break;
      case 'DEX': this.x = this.zn((this.x - 1) & 0xff); break;
      case 'DEY': this.y = this.zn((this.y - 1) & 0xff); break;
      case 'TAX': this.x = this.zn(this.a); break;
      case 'TAY': this.y = this.zn(this.a); break;
      case 'TXA': this.a = this.zn(this.x); break;
      case 'TYA': this.a = this.zn(this.y); break;
      case 'TSX': this.x = this.zn(this.s); break;
      case 'TXS': this.s = this.x; break;
      case 'PHA': this.push(this.a); break;
      case 'PHP': this.push(this.p | 0x10); break;
      case 'PLA': this.a = this.zn(this.pull()); break;
      case 'PLP': this.p = this.pull(); break;
      case 'CLC': this.c = 0; break;
      case 'SEC': this.c = 1; break;
      case 'CLI': this.i = 0; break;
      case 'SEI': this.i = 1; break;
      case 'CLD': this.d = 0; break;
      case 'SED': this.d = 1; break;
      case 'CLV': this.v = 0; break;
      case 'BPL': this.branch(!this.n); break;
      case 'BMI': this.branch(!!this.n); break;
      case 'BVC': this.branch(!this.v); break;
      case 'BVS': this.branch(!!this.v); break;
      case 'BCC': this.branch(!this.c); break;
      case 'BCS': this.branch(!!this.c); break;
      case 'BNE': this.branch(!this.z); break;
      case 'BEQ': this.branch(!!this.z); break;
      case 'JMP': this.pc = addr; break;
      case 'JSR': {
        const ret = (this.pc - 1) & 0xffff;
        this.push(ret >> 8);
        this.push(ret & 0xff);
        this.pc = addr;
        break;
      }
      case 'RTS': {
        const lo = this.pull();
        this.pc = ((lo | (this.pull() << 8)) + 1) & 0xffff;
        break;
      }
      case 'RTI': {
        this.p = this.pull();
        const lo = this.pull();
        this.pc = lo | (this.pull() << 8);
        break;
      }
      case 'BRK': {
        this.pc = (this.pc + 1) & 0xffff;
        this.push(this.pc >> 8);
        this.push(this.pc & 0xff);
        this.push(this.p | 0x10);
        this.i = 1;
        this.pc = this.rd(0xfffe) | (this.rd(0xffff) << 8);
        break;
      }
      case 'NOP': break;
      // Unofficial
      case 'LAX': this.a = this.x = this.zn(this.rd(addr)); break;
      case 'SAX': this.wr(addr, this.a & this.x); break;
      case 'DCP': this.compare(this.a, this.rmw(mode, addr, (v) => (v - 1) & 0xff)); break;
      case 'ISC': this.adc(this.rmw(mode, addr, (v) => (v + 1) & 0xff) ^ 0xff); break;
      case 'SLO': this.a = this.zn(this.a | this.rmw(mode, addr, this.asl)); break;
      case 'RLA': this.a = this.zn(this.a & this.rmw(mode, addr, this.rol)); break;
      case 'SRE': this.a = this.zn(this.a ^ this.rmw(mode, addr, this.lsr)); break;
      case 'RRA': this.adc(this.rmw(mode, addr, this.ror)); break;
      case 'ANC':
        this.a = this.zn(this.a & this.rd(addr));
        this.c = this.n;
        break;
      case 'ALR':
        this.a = this.lsr(this.a & this.rd(addr));
        break;
      case 'ARR': {
        const v = (this.a & this.rd(addr)) >> 1 | (this.c << 7);
        this.a = this.zn(v);
        this.c = (v >> 6) & 1;
        this.v = ((v >> 6) ^ (v >> 5)) & 1;
        break;
      }
      case 'AXS': {
        const t = (this.a & this.x) - this.rd(addr);
        this.c = t >= 0 ? 1 : 0;
        this.x = this.zn(t & 0xff);
        break;
      }
    }
    return this.cycles - before;
  }
}
