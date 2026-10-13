// Minimal 6502 interpreter + NSF bank-switching memory map, for testing the NSF player.
// Only implements the opcodes our player uses; anything else throws.

export class NsfMachine {
  a = 0;
  x = 0;
  y = 0;
  pc = 0;
  sp = 0xfd;
  z = false;
  n = false;
  c = false;
  ram = new Uint8Array(0x800);
  banks = [0, 0, 0, 0, 0, 0, 0, 0];
  apuWrites: [number, number][] = [];

  constructor(readonly data: Uint8Array, initialBanks: number[]) {
    this.banks = [...initialBanks];
  }

  read(addr: number): number {
    if (addr < 0x2000) return this.ram[addr & 0x7ff];
    if (addr >= 0x8000) {
      const slot = (addr - 0x8000) >> 12;
      const off = this.banks[slot] * 0x1000 + (addr & 0xfff);
      return this.data[off] ?? 0;
    }
    return 0;
  }

  write(addr: number, v: number) {
    if (addr < 0x2000) this.ram[addr & 0x7ff] = v;
    else if (addr >= 0x4000 && addr <= 0x4017) this.apuWrites.push([addr - 0x4000, v]);
    else if (addr >= 0x5ff8 && addr <= 0x5fff) this.banks[addr - 0x5ff8] = v;
  }

  private setZN(v: number) {
    this.z = v === 0;
    this.n = (v & 0x80) !== 0;
    return v;
  }
  private fetch() {
    const v = this.read(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }
  private fetch16() {
    const lo = this.fetch();
    return lo | (this.fetch() << 8);
  }
  private push(v: number) {
    this.ram[0x100 + this.sp] = v;
    this.sp = (this.sp - 1) & 0xff;
  }
  private pop() {
    this.sp = (this.sp + 1) & 0xff;
    return this.ram[0x100 + this.sp];
  }
  private branch(cond: boolean) {
    const off = this.fetch();
    if (cond) this.pc = (this.pc + (off < 0x80 ? off : off - 0x100)) & 0xffff;
  }
  private compare(reg: number, v: number) {
    this.c = reg >= v;
    this.setZN((reg - v) & 0xff);
  }

  /** Call a subroutine and run until it returns. */
  call(addr: number, maxSteps = 100000) {
    this.push(0xff);
    this.push(0xfe); // return to $FFFF sentinel
    this.pc = addr;
    for (let i = 0; i < maxSteps; i++) {
      if (this.pc === 0xffff) return;
      this.step();
    }
    throw new Error('Subroutine did not return');
  }

  step() {
    const op = this.fetch();
    switch (op) {
      case 0xa9: this.a = this.setZN(this.fetch()); break;
      case 0xa5: this.a = this.setZN(this.read(this.fetch())); break;
      case 0xb1: {
        const zp = this.fetch();
        const base = this.read(zp) | (this.read((zp + 1) & 0xff) << 8);
        this.a = this.setZN(this.read((base + this.y) & 0xffff));
        break;
      }
      case 0xbd: this.a = this.setZN(this.read((this.fetch16() + this.x) & 0xffff)); break;
      case 0x85: this.write(this.fetch(), this.a); break;
      case 0x8d: this.write(this.fetch16(), this.a); break;
      case 0x9d: this.write((this.fetch16() + this.x) & 0xffff, this.a); break;
      case 0x99: this.write((this.fetch16() + this.y) & 0xffff, this.a); break;
      case 0xa2: this.x = this.setZN(this.fetch()); break;
      case 0xa0: this.y = this.setZN(this.fetch()); break;
      case 0xa4: this.y = this.setZN(this.read(this.fetch())); break;
      case 0x84: this.write(this.fetch(), this.y); break;
      case 0x8c: this.write(this.fetch16(), this.y); break;
      case 0xe6: { const zp = this.fetch(); this.write(zp, this.setZN((this.read(zp) + 1) & 0xff)); break; }
      case 0xc6: { const zp = this.fetch(); this.write(zp, this.setZN((this.read(zp) - 1) & 0xff)); break; }
      case 0xe8: this.x = this.setZN((this.x + 1) & 0xff); break;
      case 0x29: this.a = this.setZN(this.a & this.fetch()); break;
      case 0xc9: this.compare(this.a, this.fetch()); break;
      case 0xc0: this.compare(this.y, this.fetch()); break;
      case 0xaa: this.x = this.setZN(this.a); break;
      case 0xa8: this.y = this.setZN(this.a); break;
      case 0xf0: this.branch(this.z); break;
      case 0xd0: this.branch(!this.z); break;
      case 0xb0: this.branch(this.c); break;
      case 0x20: {
        const target = this.fetch16();
        const ret = (this.pc - 1) & 0xffff;
        this.push(ret >> 8);
        this.push(ret & 0xff);
        this.pc = target;
        break;
      }
      case 0x60: {
        const lo = this.pop();
        this.pc = ((lo | (this.pop() << 8)) + 1) & 0xffff;
        break;
      }
      case 0x4c: this.pc = this.fetch16(); break;
      default:
        throw new Error(`Unimplemented opcode $${op.toString(16)} at $${((this.pc - 1) & 0xffff).toString(16)}`);
    }
  }
}

export function loadNsf(file: Uint8Array) {
  const header = file.subarray(0, 0x80);
  const le16 = (o: number) => header[o] | (header[o + 1] << 8);
  const banks = Array.from(header.subarray(0x70, 0x78));
  const machine = new NsfMachine(file.subarray(0x80), banks);
  return { machine, init: le16(0x0a), play: le16(0x0c), header };
}
