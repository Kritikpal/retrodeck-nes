#!/usr/bin/env python3
"""Build an original, freely redistributable NES mini-game ROM (NROM-128).
No third-party art, game code, or Nintendo ROMs are used. Requires Pillow for font generation.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public' / 'roms' / 'pixel-chase.nes'

class Asm:
    def __init__(self):
        self.code=bytearray(); self.labels={}; self.fix=[]
    def addr(self): return 0x8000+len(self.code)
    def label(self,name):
        if name in self.labels: raise ValueError(f'duplicate label {name}')
        self.labels[name]=self.addr()
    def emit(self,*b): self.code.extend(b)
    def op(self,opcode,operand=None,mode='imm'):
        self.emit(opcode)
        if operand is None: return
        if isinstance(operand, str):
            offset=len(self.code)
            self.fix.append((offset,operand,mode,self.addr()+ (1 if mode=='rel' else 0)))
            self.emit(0 if mode in ('imm','zp','rel','lo','hi') else 0, *([] if mode in ('imm','zp','rel','lo','hi') else [0]))
        elif mode in ('abs','absx'):
            self.emit(operand&255,(operand>>8)&255)
        else: self.emit(operand&255)
    def patch(self):
        for at,name,mode,relative_base in self.fix:
            value=self.labels[name]
            if mode=='rel':
                delta=value-relative_base
                if not -128<=delta<=127: raise ValueError(f'branch {name} out of range: {delta}')
                self.code[at]=delta&255
            elif mode=='lo': self.code[at]=value&255
            elif mode=='hi': self.code[at]=(value>>8)&255
            elif mode in ('imm','zp'): self.code[at]=value&255
            else: self.code[at:at+2]=bytes([value&255,(value>>8)&255])

# Common opcodes
A=Asm()
def L(name): A.label(name)
def i(op,value=None,mode='imm'): A.op(op,value,mode)
def lda(v): i(0xA9,v)
def ldx(v): i(0xA2,v)
def ldy(v): i(0xA0,v)
def sta(a): i(0x85 if a<256 else 0x8D,a,'zp' if a<256 else 'abs')
def stx(a): i(0x86 if a<256 else 0x8E,a,'zp' if a<256 else 'abs')
def inc(a): i(0xE6 if a<256 else 0xEE,a,'zp' if a<256 else 'abs')
def dec(a): i(0xC6 if a<256 else 0xCE,a,'zp' if a<256 else 'abs')
def and_(v): i(0x29,v)
def cmp(v): i(0xC9,v)
def adc(v): i(0x69,v)
def sbc(v): i(0xE9,v)
def branch(op,name): i(op,name,'rel')
def beq(name): branch(0xF0,name)
def bne(name): branch(0xD0,name)
def bcc(name): branch(0x90,name)
def bcs(name): branch(0xB0,name)
def bpl(name): branch(0x10,name)
def jsr(name): i(0x20,name,'abs')
def jmp(name): i(0x4C,name,'abs')
def bit(a): i(0x2C,a,'abs')
def ldaz(a): i(0xA5,a,'zp')
def ldax(a): i(0xBD,a,'absx')
def stax(a): i(0x9D,a,'absx')
def staz(a): i(0x85,a,'zp')
def lsr(): i(0x4A)
def rolz(a): i(0x26,a,'zp')
def inx(): i(0xE8)
def iny(): i(0xC8)
def dex(): i(0xCA)
def clc(): i(0x18)
def sec(): i(0x38)
def txa(): i(0x8A)
def tax(): i(0xAA)

# Zero page vars: 00/01 ROM pointer, 02 frame flag, 03 buttons,
# 04 x, 05 y, 06 star x, 07 star y, 08 score ones, 09 tens, 0A star index.
L('reset')
i(0x78)  # SEI
i(0xD8)  # CLD
ldx(0x40); stx(0x4017)
ldx(0xFF); i(0x9A)  # TXS
ldx(0); stx(0x2000); stx(0x2001); stx(0x4010)
L('waitv1'); bit(0x2002); bpl('waitv1')
L('waitv2'); bit(0x2002); bpl('waitv2')
lda(0); sta(2); sta(3); sta(8); sta(9); sta(10)
lda(112); sta(4); lda(124); sta(5)
lda(192); sta(6); lda(144); sta(7)
# Palette
lda(0x3F); sta(0x2006); lda(0); sta(0x2006)
ldx(0)
L('palcopy'); ldax('palette'); sta(0x2007); inx(); i(0xE0,32); bne('palcopy')
# Nametable at 0x2000: 4*256 = 1024 bytes. Copy via (zp),Y
lda(0x20); sta(0x2006); lda(0); sta(0x2006)
i(0xA9,'nametable','lo'); sta(0)
i(0xA9,'nametable','hi'); sta(1)
ldx(4); ldy(0)
L('pagecopy'); i(0xB1,0); sta(0x2007); iny(); bne('pagecopy')
inc(1); dex(); bne('pagecopy')
# Reset scroll
lda(0); sta(0x2005); sta(0x2005)
# Clear sprite OAM RAM $0200..$02ff
ldx(0); lda(0xFE)
L('oamclear'); stax(0x0200); inx(); bne('oamclear')
lda(96); sta(0x0201); lda(0); sta(0x0202)
lda(97); sta(0x0205); lda(1); sta(0x0206)
jsr('sprupdate')
# Enable NMI and sprites + background
lda(0x80); sta(0x2000); lda(0x1E); sta(0x2001)
L('main'); ldaz(2); beq('main'); lda(0); sta(2)
jsr('readpad'); jsr('move'); jsr('checkhit'); jsr('sprupdate'); jmp('main')

L('readpad')
lda(1); sta(0x4016); lda(0); sta(0x4016); sta(3)
ldx(8)
L('readbit'); i(0xAD,0x4016,'abs'); lsr(); rolz(3); dex(); bne('readbit')
i(0x60)

L('move')
ldaz(3); and_(8); beq('no_up'); ldaz(5); cmp(66); bcc('no_up'); sec(); sbc(2); sta(5)
L('no_up')
ldaz(3); and_(4); beq('no_down'); ldaz(5); cmp(212); bcs('no_down'); clc(); adc(2); sta(5)
L('no_down')
ldaz(3); and_(2); beq('no_left'); ldaz(4); cmp(14); bcc('no_left'); sec(); sbc(2); sta(4)
L('no_left')
ldaz(3); and_(1); beq('no_right'); ldaz(4); cmp(238); bcs('no_right'); clc(); adc(2); sta(4)
L('no_right'); i(0x60)

L('checkhit')
ldaz(4); clc(); adc(8); i(0xC5,6,'zp'); bcc('not_hit')
ldaz(6); clc(); adc(8); i(0xC5,4,'zp'); bcc('not_hit')
ldaz(5); clc(); adc(8); i(0xC5,7,'zp'); bcc('not_hit')
ldaz(7); clc(); adc(8); i(0xC5,5,'zp'); bcc('not_hit')
inc(8); ldaz(8); cmp(10); bcc('next_star')
lda(0); sta(8); inc(9); ldaz(9); cmp(10); bcc('next_star')
lda(0); sta(9)
L('next_star')
inc(10); ldaz(10); and_(7); sta(10); tax()
ldax('star_x'); sta(6); ldax('star_y'); sta(7)
L('not_hit'); i(0x60)

L('sprupdate')
ldaz(5); sta(0x0200); ldaz(4); sta(0x0203)
ldaz(7); sta(0x0204); ldaz(6); sta(0x0207)
i(0x60)

# NMI occurs once every rendered video frame. Update OAM + score during vblank.
L('nmi')
i(0x48) # PHA
i(0x8A); i(0x48) # TXA PHA
i(0x98); i(0x48) # TYA PHA
lda(0); sta(0x2003); lda(2); sta(0x4014)
# SCORE digits at nametable row5 col17 = 0x20B1
lda(0x20); sta(0x2006); lda(0xB1); sta(0x2006)
ldaz(9); clc(); adc(16); sta(0x2007)
ldaz(8); clc(); adc(16); sta(0x2007)
lda(0); sta(0x2005); sta(0x2005)
lda(1); sta(2)
i(0x68); i(0xA8) # PLA TAY
i(0x68); tax() # PLA TAX
i(0x68); i(0x40) # PLA RTI
L('irq'); i(0x40)

L('palette')
A.emit(*([0x0F,0x21,0x31,0x30]*4))
A.emit(*([0x0F,0x11,0x2A,0x30, 0x0F,0x16,0x27,0x30, 0x0F,0x12,0x22,0x30, 0x0F,0x06,0x27,0x30]))
L('star_x'); A.emit(46, 209, 71, 188, 118, 227, 28, 163)
L('star_y'); A.emit(104, 176, 202, 83, 158, 117, 190, 221)

# Tile map 32x30 plus 64 attribute bytes (palette0 throughout)
tiles=[0]*960
def write_line(row,txt):
    x=(32-len(txt))//2
    for j,c in enumerate(txt.upper()):
        if 0 <= x+j < 32: tiles[row*32+x+j]=max(0,ord(c)-32)
write_line(2,'P I X E L  C H A S E')
write_line(5,'SCORE 00')
write_line(8,'CHASE THE GOLD STAR')
write_line(11,'EACH STAR SCORES 1 POINT')
write_line(23,'MOVE WITH ARROW KEYS')
write_line(25,'OR USE THE TOUCH DPAD')
write_line(27,'A LITTLE HOMEBREW NES GAME')
# Score digits row5 col17/18 must be manually positioned to match NMI address.
# Place the text at x11 exactly (rather than centered x12).
for x in range(32): tiles[5*32+x]=0
for j,c in enumerate('SCORE 00'):
    tiles[5*32+11+j]=ord(c)-32
# digits x17/18 at 0x20B1.
L('nametable'); A.emit(*(tiles+[0]*64))
A.patch()
assert len(A.code) <= 0x3FFA, f'PRG too large: {len(A.code)}'
prg=bytearray([0xFF]*16384)
prg[:len(A.code)] = A.code
for offset, label in ((0x3FFA,'nmi'),(0x3FFC,'reset'),(0x3FFE,'irq')):
    a=A.labels[label]; prg[offset:offset+2]=bytes((a&255,a>>8))

# NES CHR 8x8 pixel tiles. Indices 0..95 are ASCII 32..127.
font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',8)
chrdata=bytearray(8192)
def make_tile(index, rows, color=1):
    offset=index*16
    for y,row in enumerate(rows):
        bitlo=bithi=0
        for x,c in enumerate(row):
            pixel=color if c=='#' else 0
            bitlo|=(pixel&1)<<(7-x)
            bithi|=((pixel>>1)&1)<<(7-x)
        chrdata[offset+y]=bitlo
        chrdata[offset+8+y]=bithi
for ascii_code in range(33,128):
    char=chr(ascii_code)
    im=Image.new('L',(8,8),0)
    d=ImageDraw.Draw(im)
    d.text((0,-1),char,fill=255,font=font,stroke_width=0)
    px=im.load()
    rows=[''.join('#' if px[x,y]>95 else '.' for x in range(8)) for y in range(8)]
    make_tile(ascii_code-32,rows,1)
make_tile(96, [
    '..####..', '.######.', '##.##.##', '########', '########', '##.##.##', '.######.', '..####..'
],3)
make_tile(97, [
    '...##...', '..####..', '########', '.######.', '..####..', '.######.', '.##..##.', '#......#'
],3)
header=b'NES\x1A'+bytes([1,1,0,0])+bytes(8)
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_bytes(header+prg+chrdata)
print(f'Built {OUT}, {OUT.stat().st_size} bytes; reset vector {hex(A.labels["reset"])}; nmi {hex(A.labels["nmi"])}')
