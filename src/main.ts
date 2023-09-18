import sob from "../player_sob.bin";
//import sob from "../enemy_gc_sob.bin";
//import sob from "../enemy_both_sob.bin";
//import sob from "../enemy_both2_sob.bin";

import playersch from "../player.sch.bin";
import ennemysch from "../enemy_sch.bin";
import gals from "../gals.sch.bin";
import gals2 from "../gals2.sch.bin";

import objsch from "../objbasesch.bin";

import scl from "../objscl.bin";

import "./spl"

const canv = document.getElementById('spriteCanvas') as HTMLCanvasElement;
canv.width = 128;
canv.height = 128;

const spriteSheet = document.getElementById('spritesheetCanvas') as HTMLCanvasElement;
spriteSheet.width = 256;
spriteSheet.height = 256;

const fromArgb = (...[a, r, g, b]: number[]) => [a, r, g, b];

const c5to8 = (v: number) => (v << 3) | (v >> 2);

const decodePixel = (val: number) => [
    c5to8((val >> 10) & 0x1f),
    c5to8((val >> 5) & 0x1f),
    c5to8((val) & 0x1f),
    0xFF
];

/*0, 1, 2, 3: objsch
4, 5, 6, 7: ennemies
8, 9: npc? (gals2)
a, b: link body
c, d, e, f: other npc gals*/
const getSpritesheetForPage = (p: number) => {
    return [
        [objsch, 0], // 0
        [objsch, 1], // 1
        [objsch, 2], // 2 
        [objsch, 4], // 3

        [ennemysch, 0], [ennemysch, 1], [ennemysch, 2], [ennemysch, 3], // ennemies
        [gals2, 0], [gals2, 1], // gals2

        [playersch, 0],
        [playersch, 1],
        [gals, 0], [gals, 1], [gals, 2], [gals, 3], // gals
    ][p] as [Uint8Array, number];
};

const color = new Uint8Array(4);
const paletteColor = (pixel: number, inputPalette: Uint8Array, paletteNum: number) => {

    pixel *= 2;
    paletteNum *= 32;

    let rawColorData = (inputPalette[paletteNum + pixel]) + ((inputPalette[paletteNum + pixel + 1]) << 8);
    const cc = decodePixel(rawColorData);
    for (let i = 0; i < 4; ++i)
        color[i] = cc[i];
    if (pixel == 0)
        color[3] = 0;
    return color;
};

const sctx = spriteSheet.getContext('2d', { willReadFrequently: true })!;
const ctx = canv.getContext('2d')!;
const renderSpriteSheet = (sp: Uint8Array, plt: Uint8Array, pltnum = 0) => {
    let i = 0;
    const width = 256;

    sctx.clearRect(0, 0, width, width);
    const data = sctx.getImageData(0, 0, width, width)!;
    const setPixel = (x: number, y: number, [a, r, g, b]: number[]) => {
        let ptr = y * width + x;
        ptr *= 4;
        data.data[ptr + 0] = r;
        data.data[ptr + 1] = g;
        data.data[ptr + 2] = b;
        data.data[ptr + 3] = a;
    };
    while (i < sp.byteLength) {
        let x = (i / 32) * 8;
        let y = 0;

        //If past the width of image drop it down and increment height
        while (x >= width) {
            y += 8;
            x -= width;
        }

        //For each byte in the 8x8 tile
        for (let curY = 0; curY < 8; curY++) {
            for (let curX = 0; curX < 4; curX++) {
                //Do low nibble
                let firstPixel = (sp[i + curX + (curY * 4)] & 0x0F);

                //Do high nibble
                let secondPixel = ((sp[i + curX + (curY * 4)] & 0xF0) >> 4);

                let colour = paletteColor(firstPixel, plt, pltnum);
                setPixel(x + (curX * 2), y + curY, fromArgb(colour[3], colour[2], colour[1], colour[0]));

                colour = paletteColor(secondPixel, plt, pltnum);
                setPixel(x + (curX * 2) + 1, y + curY, fromArgb(colour[3], colour[2], colour[1], colour[0]));
                //console.log(paletteNum * height)
            }
        }

        //Next 8x8 tile
        i += 32;
    }
    sctx.putImageData(data, 0, 0);
};

// note for the walk cycles (repeating animations that have exactly 7 frames)
// the game plays animations at 30fps, each frame is held for 4 video frames
// EXCEPT the walk cycle where the frame at index 1 is held for 6 video frames

type Character = {
    // 6 bytes
    // Byte 0
    y_offset: number; // 8 bits, used as an actual "3d" height too

    // Byte1
    // number of 8 pixel blocks
    block_shape: number; // square c or 0 | wide 8 | high 4 

    // Byte 2
    x_offset: number; // 0 is center, -128 is left, 127 is right

    // Byte 3
    flip_x: boolean; // 0
    flip_y: boolean; // 1
    block_size: number; // 2 3

    // byte 4
    block_offset: number; // 8 pixel blocks, go to next row when reaching the end of the current 256 pixels row (every 0x20)
    // byte 5 [4 bits: palette select, 4 bits: page select]
    palette: number;
    page: number; // which 64 pixel slice
};

type Sprite = {
    chars: Character[];
};

const parseAttr = (n: number) => {
    if (n & 0xF) {
        console.warn('unknown', n & 0xF);
    }
    return ({
        flip_x: ((n >> 4) & 1) != 0,
        flip_y: ((n >> 5) & 1) != 0,
        block_size: (n >> 6) & 3
    });
};

const parseChars = (obj: Uint8Array) => {
    const dv = new DataView(obj.buffer);
    let chars: Character[] = [];
    for (let i = 0; i < obj.length; i += 6) {
        if (obj[i + 1] & 0x3F) {
            console.warn('unk2', obj[i + 1] & 0x3F);
        }
        chars.push({
            y_offset: dv.getInt8(i),
            block_shape: obj[i + 1] >> 6,
            x_offset: dv.getInt8(i + 2),
            ...parseAttr(obj[i + 3]),
            block_offset: obj[i + 4],
            palette: obj[i + 5] >> 4,
            page: obj[i + 5] & 0xF
        });
    }
    return chars;
};

const parseObjAttributes = (obj: Uint8Array) => {
    const dv = new DataView(obj.buffer);
    const spriteCount = dv.getUint16(0, true);
    let sprites: Sprite[] = [];
    for (let i = 0; i < spriteCount; ++i) {
        const begin = dv.getUint16(i * 2 + 2, true);
        const end = dv.getUint16(i * 2 + 4, true);
        sprites.push({
            chars: parseChars(obj.slice(begin, end))
        });
    }
    return sprites;
};

const shapes = (sh: number, si: number) => [[
    [1, 1],
    [2, 2],
    [4, 4],
    [8, 8]
], [
    [2, 1],
    [4, 1],
    [4, 2],
    [8, 4]
], [
    [1, 2],
    [1, 4],
    [2, 4],
    [4, 8]
]][sh][si] as [number, number];
const inp = document.getElementById("palette") as HTMLInputElement;

//const draw = document.getElementById("draw") as HTMLInputElement;
//const skip = document.getElementById("skip") as HTMLInputElement;
//const clear = document.getElementById("clear") as HTMLInputElement;

let currentlyRendererd: Uint8Array | null = null;
let pl: boolean | null = null;
const drawSprite = (sprites: Sprite[], idx: number) => {
    const sprite = sprites[idx];

    const [x, y] = [48, 48];
    //if (clear.checked)
    ctx.clearRect(0, 0, 128, 128);

    //sprite.chars.sort((a, b) => b.y_offset - a.y_offset);
    //let n = +draw.value;
    //let m = +skip.value;
    //let n = 8;
    //let m = 5;
    for (let k = sprite.chars.length - 1; k != -1; --k) {
        //if (m != 0) {
        //    m--;
        //    continue;
        //}

        const c = sprite.chars[k];
        const sk = shapes(c.block_shape, c.block_size);
        const [dx, dy] = [sk[0] * 8, sk[1] * 8];
        const sx = (c.block_offset & 0x1f) << 3;
        let sy = (c.block_offset >> 5) << 3;
        let xf = 1;
        let xb = 0;
        if (c.flip_x) {
            xf = -1;
            xb = -dx;
        }
        let yf = 1;
        let yb = 0;
        if (c.flip_y) {
            yf = -1;
            yb = -dy;
        }
        const [sc, yoff] = getSpritesheetForPage(c.page);
        sy += yoff * 64;

        // this is just a hack for a correct palette, you shouldn't have this in your renderers
        const islink = sc == playersch || (c.page == 0 && c.block_offset < 0x40);
        if (currentlyRendererd != sc || pl != islink) {
            renderSpriteSheet(sc, scl, +inp.value || c.palette);
            currentlyRendererd = sc;
            pl = islink;
        }
        ctx.save();
        let xf2 = xf;
        let yf2 = yf;
        ctx.scale(xf2, yf2);
        xf2 *= c.flip_x ? -1 : 1;
        yf2 *= c.flip_y ? -1 : 1;
        ctx.drawImage(spriteSheet, sx, sy, dx, dy, xb + (xf * (x + xf2 * c.x_offset)), yb + (yf * (y + yf2 * c.y_offset)), dx, dy);
        ctx.restore();
    }
};

addEventListener('load', () => {
    renderSpriteSheet(playersch, scl, 12);
    const inp = document.getElementById("palette") as HTMLInputElement;
    const inp2 = document.getElementById("sprite") as HTMLInputElement;
    inp!.onchange = (ev) => {
        renderSpriteSheet(playersch, scl, inp.value === undefined ? 12 : +inp.value);
        currentlyRendererd = playersch;
        pl = true;
    };
    const sprites = parseObjAttributes(sob);
    inp2.max = '' + sprites.length;
    console.log([...new Set(sprites.flatMap(e => e.chars.flatMap(e => e.page)))].map(e => e.toString(16)));
    //draw!.onchange =
    //    skip!.onchange =
    inp2!.onchange = () => {
        drawSprite(sprites, inp2.value === undefined ? 827 : +inp2.value);
    };

    drawSprite(sprites, 16);

});