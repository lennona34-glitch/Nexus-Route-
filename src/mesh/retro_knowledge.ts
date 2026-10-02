/**
 * Nexus Route - Retro Computing & Democraft Reference Bank
 * Curated reference data, hardware registers, and assembly starter routines
 * for Atari ST (68000), Commodore Amiga (68000), Commodore 64 (6502),
 * Sinclair ZX Spectrum (Z80), and Faust DSP audio synthesis.
 */

export interface RetroSystemInfo {
  name: string;
  cpu: string;
  soundChip: string;
  graphicsChip: string;
  registers: Record<string, string>;
  boilerplate: {
    language: string;
    extension: string;
    description: string;
    code: string;
  };
}

export const RETRO_SYSTEMS: Record<string, RetroSystemInfo> = {
  atari_st: {
    name: 'Atari 520ST / 1040ST / Falcon',
    cpu: 'Motorola 68000 @ 8 MHz',
    soundChip: 'Yamaha YM2149 PSG (3 audio channels + noise)',
    graphicsChip: 'Atari ST Shifter (320x200 16 colors / 640x200 4 colors / 640x400 mono)',
    registers: {
      '$FF8201': 'Video Base High address byte',
      '$FF8203': 'Video Base Mid address byte',
      '$FF820D': 'Video Base Low address byte (STE)',
      '$FF8240': 'Color Palette Register 0 (Background)',
      '$FF8242-$FF825E': 'Color Palette Registers 1-15 (12-bit ST, 4096 colors on STE)',
      '$FF8800': 'YM2149 PSG Register Select / Read data',
      '$FF8802': 'YM2149 PSG Register Write data',
      '$FFFA01': 'MFP 68901 Interrupt Mask A',
      '$FFFA09': 'MFP 68901 Interrupt Enable A',
      '$FFFA1B': 'MFP 68901 Timer B Control (HBL raster interrupts)',
      '$FFFA21': 'MFP 68901 Timer B Data (raster scanline count)',
    },
    boilerplate: {
      language: 'Motorola 68000 Assembly',
      extension: 's',
      description: 'Atari ST Hardware Copper-Style Palette Rainbow on Timer B',
      code: `; ==========================================================
; ATARI ST - Fullscreen Color Rainbow / Raster Interrupt
; Target: Devpac / VASM 68000
; ==========================================================
        SECTION TEXT
        OPT     D+,X+

Start:  clr.l   -(sp)           ; Supervisor mode entry
        move.w  #$20,-(sp)
        trap    #1
        addq.l  #6,sp
        move.l  d0,OldSP

        ; Save old VBL and MFP vectors
        move.l  $70.w,OldVBL
        move.b  $fffa1b,OldTimerB_Ctrl
        move.b  $fffa21,OldTimerB_Data

        ; Set custom VBL interrupt
        move.l  #VBLRoutine,$70.w

WaitKey:
        move.w  #$ff,-(sp)      ; Bconin(2) - poll keyboard
        move.w  #6,-(sp)
        trap    #1
        addq.l  #4,sp
        tst.l   d0
        beq.s   WaitKey

Restore:
        move.l  OldVBL,$70.w
        move.b  OldTimerB_Ctrl,$fffa1b
        move.b  OldTimerB_Data,$fffa21
        move.w  #$777,$ff8240   ; Restore background white

        ; Exit supervisor mode
        move.l  OldSP,-(sp)
        move.w  #$20,-(sp)
        trap    #1
        addq.l  #6,sp

        clr.w   -(sp)           ; Pterm(0)
        trap    #1

; --- Vertical Blank Interrupt Handler ---
VBLRoutine:
        clr.b   $fffa1b         ; Stop Timer B
        move.l  #TimerBRoutine,$120.w ; Point Timer B vector
        move.b  #1,$fffa21      ; Interrupt every 1 scanline
        move.b  #8,$fffa1b      ; Start Timer B in event count mode
        clr.w   ColorIndex
        rte

; --- Timer B Raster Interrupt Handler ---
TimerBRoutine:
        movem.l d0/a0,-(sp)
        move.w  ColorIndex,d0
        lea     RainbowPalette(pc),a0
        move.w  (a0,d0.w*2),$ff8240.w ; Inject scanline color directly into shifter
        addq.w  #1,ColorIndex
        cmpi.w  #32,ColorIndex
        bne.s   .skipReset
        clr.w   ColorIndex
.skipReset:
        bclr    #0,$fffa0f      ; Acknowledge Timer B interrupt in MFP ISRA
        movem.l (sp)+,d0/a0
        rte

        SECTION DATA
RainbowPalette:
        dc.w    $000,$100,$200,$300,$400,$500,$600,$700
        dc.w    $710,$720,$730,$740,$750,$760,$770,$670
        dc.w    $570,$470,$370,$270,$170,$070,$071,$072
        dc.w    $073,$074,$075,$076,$077,$067,$057,$047

        SECTION BSS
OldSP:          ds.l    1
OldVBL:         ds.l    1
OldTimerB_Ctrl: ds.b    1
OldTimerB_Data: ds.b    1
ColorIndex:     ds.w    1
        EVEN
`
    }
  },

  c64: {
    name: 'Commodore 64 (C64)',
    cpu: 'MOS Technology 6510/8500 @ 0.985 MHz (PAL) / 1.023 MHz (NTSC)',
    soundChip: 'MOS 6581/8580 SID (3 voices, 4 waveforms, multi-mode resonant filter)',
    graphicsChip: 'MOS 6567/6569 VIC-II (320x200 bitmap, 40x25 text, 8 hardware sprites, raster irq)',
    registers: {
      '$D011': 'VIC-II Control Register 1 (Screen enable, vertical scroll, bit 7 = raster line 8)',
      '$D012': 'VIC-II Raster Line compare register',
      '$D016': 'VIC-II Control Register 2 (Multi-color mode, horizontal scroll)',
      '$D019': 'VIC-II Interrupt Request Register (Write 1s to acknowledge)',
      '$D01A': 'VIC-II Interrupt Mask Register (Bit 0 = Raster IRQ enable)',
      '$D020': 'Border Color register (0-15)',
      '$D021': 'Background Color 0 register (0-15)',
      '$D400-$D406': 'SID Voice 1 Frequency, Pulse Width, Waveform Control, Attack/Decay/Sustain/Release',
      '$D407-$D40D': 'SID Voice 2 Controls',
      '$D40E-$D414': 'SID Voice 3 Controls',
      '$D418': 'SID Master Volume (bits 0-3) and Filter Mode selector',
      '$0314-$0315': 'Standard C64 IRQ Vector in RAM',
    },
    boilerplate: {
      language: 'MOS 6502 Assembly (ACME / KickAssembler / ca65)',
      extension: 'asm',
      description: 'Commodore 64 Clean Double Raster-Split with SID Noise Synth Routine',
      code: `; ==========================================================
; COMMODORE 64 - Raster Split & SID Bass Synth
; Target: ACME / KickAssembler 6502
; ==========================================================
* = $0801
        ; BASIC Header: 10 SYS 2064 ($0810)
        !byte $0b, $08, $0a, $00, $9e, $32, $30, $36, $34, $00, $00, $00

Start:
        sei             ; Disable interrupts while wiring vectors
        lda #$7f
        sta $dc0d       ; Disable CIA 1 timer interrupts
        sta $dd0d       ; Disable CIA 2 timer interrupts
        lda $dc0d       ; Acknowledge any pending CIA IRQ
        lda $dd0d

        ; Configure Memory Map: RAM + I/O + Kernal ($35 = I/O visible, Kernal/Basic disabled)
        lda #$35
        sta $01

        ; Setup SID Chip for an 80s bassline hit
        lda #$0f        ; Max volume, no filter
        sta $d418
        lda #$00        ; Attack: 0, Decay: 9
        sta $d405
        lda #$00        ; Sustain: 0, Release: 9
        sta $d406
        lda #$21        ; Sawtooth wave + Gate Bit (Trigger sound)
        sta $d404
        lda #$12        ; Note Freq Low (approx C-2)
        sta $d400
        lda #$1c        ; Note Freq High
        sta $d401

        ; Setup VIC-II Raster Interrupt
        lda #$01
        sta $d01a       ; Enable raster IRQ in VIC-II mask
        lda #$32        ; Line $32 (50 - top of visible screen)
        sta $d012
        lda $d011
        and #$7f        ; Clear raster bit 8
        sta $d011

        lda #<RasterTop
        sta $0314       ; Vector Low
        lda #>RasterTop
        sta $0315       ; Vector High

        cli             ; Re-enable interrupts
Loop:
        jmp Loop        ; Endless loop - graphics update via raster IRQ

; --- Raster Routine Top (Line 50) ---
RasterTop:
        inc $d019       ; Acknowledge VIC-II interrupt
        lda #$06        ; Deep Blue border
        sta $d020
        lda #$0e        ; Light Blue background
        sta $d021

        ; Prep next split at scanline $B0 (Middle of screen)
        lda #$b0
        sta $d012
        lda #<RasterBottom
        sta $0314
        lda #>RasterBottom
        sta $0315
        jmp $ea81       ; Return to standard Kernal IRQ handler

; --- Raster Routine Bottom (Line 176) ---
RasterBottom:
        inc $d019       ; Acknowledge VIC-II interrupt
        lda #$00        ; Black border
        sta $d020
        lda #$02        ; Red background
        sta $d021

        ; Reset split back to line 50 for the next frame
        lda #$32
        sta $d012
        lda #<RasterTop
        sta $0314
        lda #>RasterTop
        sta $0315
        jmp $ea81
`
    }
  },

  spectrum: {
    name: 'Sinclair ZX Spectrum 48K / 128K',
    cpu: 'Zilog Z80A @ 3.5 MHz',
    soundChip: 'Single 1-bit Beeper Port $FE (48K) / AY-3-8912 3-Voice Sound (128K)',
    graphicsChip: 'Sinclair ULA (256x192 bitmap, 32x24 attribute cells with INK, PAPER, BRIGHT, FLASH)',
    registers: {
      'Port $FE': 'Write: bits 0-2 = Border Color (0-7), bit 4 = Ear/MIC Beeper audio pulse. Read: Keyboard rows',
      'Port $FFFD': '128K AY-3-8912 Register Select',
      'Port $BFFD': '128K AY-3-8912 Register Data Write',
      '$4000-$57FF': 'Screen pixel bitmap memory (interleaved 3 scanline thirds)',
      '$5800-$5AFF': 'Color Attribute RAM (32x24 cells: Bit 7=Flash, 6=Bright, 3-5=Paper, 0-2=Ink)',
    },
    boilerplate: {
      language: 'Zilog Z80 Assembly (SjASMPlus / Pasmo / sjasm)',
      extension: 'z80',
      description: 'ZX Spectrum Rainbow Border Strobe & Fast Beeper Frequency Modulator',
      code: `; ==========================================================
; ZX SPECTRUM 48K/128K - Rainbow Border & Beeper Routine
; Target: SjASMPlus / Pasmo Z80
; ==========================================================
        ORG     $8000

Start:
        di                      ; Disable maskable interrupts
        ld      a, 0            ; Initial border color
        out     ($fe), a

MainLoop:
        ld      b, 255          ; Delay loop length
.innerLoop:
        ; Pulse the beeper line (bit 4) while rotating border color (bits 0-2)
        ld      a, r            ; Grab random refresh register for color noise
        and     7               ; Mask colors 0-7
        or      %00010000       ; Set bit 4 = Beeper Speaker HIGH
        out     ($fe), a

        ; Short delay for audible frequency pitch
        ld      c, 32
.delay1:
        dec     c
        jr      nz, .delay1

        and     %11101111       ; Clear bit 4 = Beeper Speaker LOW
        out     ($fe), a

        ld      c, 32
.delay2:
        dec     c
        jr      nz, .delay2

        djnz    .innerLoop

        ; Check Space key on half-row $7FFE to quit
        ld      a, $7f
        in      a, ($fe)
        rra                     ; Space is bit 0
        jr      c, MainLoop

Exit:
        ei                      ; Restore interrupts
        ret
`
    }
  },

  amiga: {
    name: 'Commodore Amiga 500 / 1200 / 2000',
    cpu: 'Motorola 68000 / 68020 / 68030',
    soundChip: 'Paula (4-channel hardware DMA 8-bit PCM audio, 2 left / 2 right stereo)',
    graphicsChip: 'OCS / ECS / AGA (Copper coprocessor, Blitter hardware 2D accelerator, Denise/Lisa)',
    registers: {
      '$DFF080': 'COP1LCH - Copper First Location (High 32-bit pointer)',
      '$DFF088': 'COPJMP1 - Copper Restart Jump 1 strobe',
      '$DFF096': 'DMACON - DMA Control (Bit 15=Set/Clear, Bit 9=DMAEN, Bit 7=COPEN, Bit 6=BLITEN)',
      '$DFF09A': 'INTENA - Interrupt Enable Register',
      '$DFF180': 'COLOR00 - Background color (12-bit RGB $0RGB)',
      '$DFF040': 'BLTCON0 - Blitter Control Register 0 (minterms & channels)',
      '$DFF058': 'BLTSIZE - Blitter Start (height x width in words)',
    },
    boilerplate: {
      language: 'Motorola 68000 Assembly',
      extension: 's',
      description: 'Commodore Amiga OCS Hardware Copper Rainbow Gradient',
      code: `; ==========================================================
; AMIGA OCS - Pure Hardware Copper List Gradient
; Target: ASM-One / Barfly / VASM 68000
; ==========================================================
CUSTOM      EQU $dff000
DMACON      EQU $096
COP1LCH     EQU $080
COPJMP1     EQU $088
COLOR00     EQU $180

Start:  move.l  4.w,a6          ; ExecBase pointer
        lea     GfxName(pc),a1
        jsr     -408(a6)        ; OldOpenLibrary()
        move.l  d0,GfxBase
        move.l  d0,a4
        move.l  34(a4),OldCopper ; Save current Workbench copper list

        ; Take control of hardware
        lea     CUSTOM,a5
        move.w  #$03e0,DMACON(a5) ; Disable bitplane, sprite, blitter DMA

        ; Install custom Copper List in Chip RAM
        move.l  #CopperList,COP1LCH(a5)
        clr.w   COPJMP1(a5)     ; Strobe Copper Jump
        move.w  #$8280,DMACON(a5) ; Enable DMA + Copper DMA

WaitMouse:
        btst    #6,$bfe001      ; Left mouse button down?
        bne.s   WaitMouse

Restore:
        move.l  OldCopper(pc),COP1LCH(a5)
        clr.w   COPJMP1(a5)
        move.w  #$83e0,DMACON(a5) ; Re-enable system DMA

        move.l  4.w,a6
        move.l  GfxBase(pc),a1
        jsr     -414(a6)        ; CloseLibrary()
        clr.l   d0
        rts

        SECTION ChipData,DATA_C ; MUST be in Chip RAM for Copper DMA!
CopperList:
        dc.w    COLOR00,$000    ; Start background black
        ; Wait scanlines and stream rainbow gradient
        dc.w    $4007,$fffe, COLOR00,$102
        dc.w    $4807,$fffe, COLOR00,$204
        dc.w    $5007,$fffe, COLOR00,$306
        dc.w    $5807,$fffe, COLOR00,$508
        dc.w    $6007,$fffe, COLOR00,$70a
        dc.w    $6807,$fffe, COLOR00,$90c
        dc.w    $7007,$fffe, COLOR00,$b0e
        dc.w    $7807,$fffe, COLOR00,$d1f
        dc.w    $8007,$fffe, COLOR00,$f3e
        dc.w    $8807,$fffe, COLOR00,$f5b
        dc.w    $9007,$fffe, COLOR00,$f78
        dc.w    $9807,$fffe, COLOR00,$f95
        dc.w    $a007,$fffe, COLOR00,$fa2
        dc.w    $a807,$fffe, COLOR00,$f80
        dc.w    $b007,$fffe, COLOR00,$a50
        dc.w    $b807,$fffe, COLOR00,$630
        dc.w    $c007,$fffe, COLOR00,$210
        dc.w    $c807,$fffe, COLOR00,$000
        dc.w    $ffff,$fffe     ; End of Copper List

        SECTION Variables,DATA
GfxName:    dc.b    "graphics.library",0
            EVEN
GfxBase:    dc.l    0
OldCopper:  dc.l    0
`
    }
  },

  faust_dsp: {
    name: 'Faust Audio DSP (FAUST)',
    cpu: 'Universal Audio DSP / C++ / WebAssembly / VST',
    soundChip: 'Floating-point Audio DSP Engine',
    graphicsChip: 'N/A',
    registers: {},
    boilerplate: {
      language: 'FAUST Functional DSP',
      extension: 'dsp',
      description: 'Roland TB-303 Acid Bassline Diode Ladder Filter & Resonant Squelch',
      code: `import("stdfaust.lib");

// --- TB-303 Emulation Core in Faust ---
// Squelchy resonant 18dB/octave / 24dB diode ladder approximation
freq      = hslider("v:Acid/freq[style:knob]", 110, 30, 2000, 0.5);
cutoff    = hslider("v:Acid/cutoff[style:knob]", 800, 100, 8000, 1);
resonance = hslider("v:Acid/resonance[style:knob]", 0.85, 0.0, 0.98, 0.01);
envMod    = hslider("v:Acid/envMod[style:knob]", 0.75, 0.0, 1.0, 0.01);
drive     = hslider("v:Acid/drive[style:knob]", 2.0, 1.0, 10.0, 0.1);
waveform  = checkbox("v:Acid/Saw_Pulse_Toggle"); // 0=Saw, 1=Pulse

// Oscillator: Sawtooth or Square wave
osc = select2(waveform, os.sawtooth(freq), os.pulsetrain(freq, 0.5));

// Exponential Envelope Generator
gate = button("v:Acid/Trigger");
env = en.ar(0.005, 0.28, gate) : *(envMod);
dynamicCutoff = cutoff * (1.0 + env * 4.0) : min(16000) : max(40);

// Resonant Diode Filter
filter = ve.moogLadder(dynamicCutoff, resonance);

// Overdrive Saturation
overdrive(x) = ma.tanh(x * drive) / drive;

process = osc : filter : overdrive <: _, _;
`
    }
  }
};

/**
 * Helper to retrieve code sample or register details for a requested system
 */
export function getRetroSystem(query: string): RetroSystemInfo | undefined {
  const q = query.toLowerCase();
  if (q.includes('atari') || q.includes('st') || q.includes('ym2149') || q.includes('tos') || q.includes('gem')) return RETRO_SYSTEMS.atari_st;
  if (q.includes('c64') || q.includes('commodore 64') || q.includes('sid') || q.includes('vic')) return RETRO_SYSTEMS.c64;
  if (q.includes('spectrum') || q.includes('speccy') || q.includes('zx') || q.includes('z80') || q.includes('sinclair')) return RETRO_SYSTEMS.spectrum;
  if (q.includes('amiga') || q.includes('copper') || q.includes('blitter') || q.includes('paula')) return RETRO_SYSTEMS.amiga;
  if (q.includes('faust') || q.includes('dsp') || q.includes('303') || q.includes('filter')) return RETRO_SYSTEMS.faust_dsp;
  return undefined;
}
