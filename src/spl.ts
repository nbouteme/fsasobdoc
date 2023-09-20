import map from "../map.bin";
import sch from "../bgl_sch.bin"; // TODO: have to append the "generic" char data
import scl from "../bgl_scl.bin";
import spl from "../bga_spl.bin";

import anim_a_sch from "../bg_anim_sch.bin";
import anim_b_sch from "../bg_anim_b_sch.bin";

import res from "./res";

type Animation = {
    source: number; // y offset in blocks
    height: number; // in blocks
    dest?: number;
    frame_count: number;
};

// this is just a guess on how the animations work
const anim_a: Animation[] = [
    {
        source: 0,
        height: 2,
        frame_count: 4,
    },
    {
        source: 16,
        height: 2,
        frame_count: 8,
        dest: 44
    },
    {
        source: 16,
        height: 4,
        frame_count: 8,
    },
    {
        source: 32,
        height: 4,
        frame_count: 8,
    },
];

const anim_b: Animation[] = [
    {
        source: 0,
        height: 4,
        frame_count: 8,
        dest: 28
    },
    {
        source: 32,
        height: 4,
        frame_count: 8,
        dest: 28
    },

];

// concat/swap endian
const con = (a: number, b: number) => ((a << 8) & 0xFF00) | (b & 0xFF);

// converts a palette color (RGB555) to RGBA3
const trgba3 = (x: number) => {
    const b = x & 0xFF;
    const a = x >> 8;

    return (((a << 8) >> 10) & 0x1f) | ((b & 0x1f) << 10) | (con(a, b) & 0x3e0) | 0x8000;
};

// FSA is hardcoded to make 3 colors of the palette slightly transparent, see usage
const tr = (x: number) => (((((x >> 0xb) & 0xF) | 0x40) << 8) & 0xFF00) | ((((x >> 1) & 0xf) | ((x >> 2) & 0xf0)) & 0xFF);

function convertPalette(plt: Uint16Array) {
    for (let i = 0; i < 16; ++i) {
        for (let j = 0; j < 16; ++j) {
            const ptr = i * 16 + j;
            if (i == 0) {
                plt[ptr] = 0;
                continue;
            }
            plt[ptr] = trgba3(plt[ptr]);
        }
    }

    // FSA is hardcoded to do this
    plt[13 * 16 + 8] = tr(plt[13 * 16 + 8]);
    plt[13 * 16 + 9] = tr(plt[13 * 16 + 9]);
    plt[13 * 16 + 10] = tr(plt[13 * 16 + 10]);
}

const canv = document.createElement('canvas');
canv.width = 512;
canv.height = 512;
document.body.appendChild(canv);
const gl = canv.getContext('webgl2', { alpha: false })!;

const fromArgb = (...[a, r, g, b]: number[]) => [a, r, g, b];

const c5to8 = (v: number) => (v << 3) | (v >> 2);

const decodePixel = (val: number) => [
    c5to8((val >> 10) & 0x1f),
    c5to8((val >> 5) & 0x1f),
    c5to8((val) & 0x1f),
    0xFF
];

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

const square = [
    0, 0, 1, 0, 1, -1,
    0, 0, 1, -1, 0, -1,
];

const squareBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, squareBuffer);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(square), gl.STATIC_DRAW);
gl.bindBuffer(gl.ARRAY_BUFFER, null);

const vao = gl.createVertexArray();
gl.bindVertexArray(vao);
gl.bindBuffer(gl.ARRAY_BUFFER, squareBuffer);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(
    0, 2,
    gl.FLOAT, false,
    0, 0);
gl.bindVertexArray(null);

class Shader {
    constructor(public gl: WebGL2RenderingContext,
        private vs_src: string,
        private fs_src: string) {
    }

    prog?: WebGLProgram;
    load() {
        const vs_src = this.vs_src;
        const fs_src = this.fs_src;
        const prog = this.gl.createProgram();
        if (!prog)
            throw new Error("Program creation failed");
        const compileShader = (s: string, t: number) => {
            const shader = this.gl.createShader(t);
            if (!shader)
                throw new Error("Shader creation failed");
            this.gl.shaderSource(shader, s);
            this.gl.compileShader(shader);
            if (this.gl.getShaderInfoLog(shader)) {
                const sloc = this.gl.getShaderInfoLog(shader);
                console.log(sloc);
            }
            return shader;
        };
        const vs = compileShader(vs_src, this.gl.VERTEX_SHADER);
        const fs = compileShader(fs_src, this.gl.FRAGMENT_SHADER);
        this.gl.attachShader(prog, vs);
        this.gl.attachShader(prog, fs);
        this.gl.validateProgram(prog);
        this.gl.linkProgram(prog);
        if (this.gl.getProgramInfoLog(prog)) {
            const sloc = this.gl.getProgramInfoLog(prog);
            console.log(sloc);
        }
        this.prog = prog;
    }
}

// Note: renderer might be incorrect for out of bounds access as it uses
// texelFetch and was only tested on Nvidia, where it returns 0 contrary to AMD which applies wrapping rules

const vprolog = `#version 300 es
precision highp float;
in vec2 pos;
uniform vec2 tile_size;
uniform vec2 map_size;
uniform vec2 map_dims; // in tiles
uniform highp usampler2D tile_layout;
uniform highp usampler2D map;
uniform float time;
`;

const fprolog = `#version 300 es
precision highp float;
precision highp int;
out vec4 color;
uniform highp usampler2D map;
uniform highp usampler2D character_data;
uniform highp usampler2D palette_data;
uniform highp usampler2D tile_layout;

// gamecube extensions
uniform highp sampler2D sfilter;
uniform highp sampler2D kawa;
uniform highp sampler2D cloud;
uniform highp sampler2D noise;

`;

const vshader = `${vprolog}

out vec2 uv;
out vec2 map_uv;
flat out int id;
flat out int tileid;
flat out uint pal;


// this maps linear space coordinates into "block" coordinates
ivec2 computeMapPos(ivec2 p, int b, int bcc) {
    ivec2 bb = p / b;
    ivec2 rr = p & (b - 1);

    int bs = b * b;
    int ti = rr.y * b + rr.x;
    int bidx = bb.y * bcc + bb.x;
    int off = bs * bidx + ti;
    int nx = off & ((b * bcc) - 1);
    int ny = ~~(off / (b * bcc));
    return ivec2(nx, ny);
}

void main() {
    // local coordinates
    vec2 spos = pos * tile_size * 2.0f;
    spos /= map_size;
    // global coordinates
    id = gl_InstanceID;
    // half tile position, the 8x8 tile responsible for rendering only a quarter of an actual tile
    ivec2 tls = textureSize(tile_layout, 0);
    ivec2 htilepos = ivec2(id & 0x3F, id >> 6);
    ivec2 itilepos = htilepos >> 1; // figure out in which 16x16 tile we are
    int tileoff = (htilepos.y & 1) * 2 + (htilepos.x & 1); // figure out which of the 4th of that tile we're in
    vec2 fhtilepos = vec2(htilepos);
    vec2 xy = tile_size * fhtilepos;

    xy /= map_size;
    xy -= 0.5f;
    xy *= 2.0f;
    xy.y = -xy.y;
    map_uv = (fhtilepos) / map_size;

    spos += xy;

    ivec2 mappos = computeMapPos(itilepos, 16, 2); // a map has 2 columns of 16 tiles
    int tileid = int(texelFetch(map, mappos, 0).r);
    int tile_desc_x = ((tileid & 0xf) << 2) + tileoff;
    int tile_desc_y = (tileid >> 4);

    uint s = texelFetch(tile_layout, ivec2(tile_desc_x, tile_desc_y), 0).r; // this should be accessed like a 1D array, but lets keep things "visual"
    uint posdata = s & 0x3ffu; // character data position
    uint cd_x = (posdata & 0xfu) << 3u; // character data position
    uint cd_y = (posdata >> 4u) << 3u;
    uv = vec2(cd_x, cd_y); // change to float to have interpolation
    vec2 nuv = vec2(pos.x, -pos.y); 
    uint flips = (s >> 10u) & 3u;
    if ((flips & 1u) == 1u)
        nuv.x = 1.0f - nuv.x;
    if ((flips & 2u) == 2u)
        nuv.y = 1.0f - nuv.y;
    uv += tile_size * nuv; // map the other vertices to the rest of the 8x8 tile
    map_uv += tile_size * nuv;
    pal = (s >> 12u);
    gl_Position = vec4(spos.x, spos.y, 0.0f, 1.0f);
}`;

const fshader = `${fprolog}
in vec2 uv;
in vec2 map_uv;
flat in int id;
flat in uint pal;


// from Dolphin
uint c5to8(uint v) {
    return (v << 3u) | (v >> 2u);
}


uint c3to8(uint v) {
  // Swizzle bits: 00000123 -> 12312312
  return (v << 5u) | (v << 2u) | (v >> 1u);
}

uint c4to8(uint v) {
  // Swizzle bits: 00001234 -> 12341234
  return (v << 4u) | v;
}

uvec4 DecodePixel_RGB5A3(uint val)
{
  uint r, g, b, a;
  if ((val & 0x8000u) != 0u)
  {
    r = c5to8((val >> 10u) & 0x1fu);
    g = c5to8((val >> 5u) & 0x1fu);
    b = c5to8((val)&0x1fu);
    a = 0xFFu;
  }
  else
  {
    a = c3to8((val >> 12u) & 0x7u);
    r = c4to8((val >> 8u) & 0xfu);
    g = c4to8((val >> 4u) & 0xfu);
    b = c4to8((val)&0xfu);
  }
  return uvec4(r, g, b, a);
}


uint sampleCharacter() {
    // character data is layout in blocks of 8x8, where each by represents 2 pixels, which means a block is made of 8 sequential bytes
    ivec2 iuv = ivec2(uv);
    // so first, we have to figure out which 8x8 block we're in (16 is 128 / blocksize (8))
    int bindex = (iuv.y >> 3) * 16 + (iuv.x >> 3);
    // then which pixel within that block;
    int pidx = ((iuv.y & 7) << 3) + (iuv.x & 7);
    // so the offset to the precise byte we need to read is
    //                                                          can probably simplify the arithmetic
    int byteoffset = (bindex << 5) + (pidx >> 1);
    // so the coordinate in the texture is
    //ivec2 bytecoord = ivec2(byteoffset & 0xFF, (byteoffset >> 8) << 1);
    ivec2 bytecoord = ivec2((byteoffset & 0x7f), (byteoffset >> 7));
        // so we get that byte
    uint byte = texelFetch(character_data, bytecoord, 0).r;
    // which nibble to get depends on the pixel index
    byte = (byte >> uint((pidx & 1) << 2)) & 0xFu;
    ivec2 kk = ivec2(byte, pal);
    uint col = texelFetch(palette_data, kk, 0).r;
    return col;
}

void main() {
    uint pcol = sampleCharacter();
    //ivec2 htilepos = ivec2(id & 0x3F, id >> 6);

    //float fil = texture(sfilter, (map_uv * 16.0f)).r;
    float fil = texelFetch(sfilter, ivec2(gl_FragCoord.x, -gl_FragCoord.y) & 0x7f, 0).r;
    vec4 p = vec4(DecodePixel_RGB5A3(pcol));
    if (p.a != 255.0f)
        fil = 1.0f;
    color = mix(vec4(0, 0, 0, 1), p / 255.0f, fil);

    //color = vec4(DecodePixel_RGB5A3(pcol)) / 255.0f;
}`;

const tilemapshader = new Shader(gl, vshader, fshader);
tilemapshader.load();
const kawazokoshader = new Shader(gl, `${vprolog}
out vec2 uv;
void main() {
    uv = vec2(pos.x, -pos.y);
    gl_Position = vec4((pos.x * 2.0f) - 1.0f, -(pos.y * 2.0f) - 1.0f, 0.0f, 1.0f);
}
`, `${fprolog}
in vec2 uv;
uniform vec2 map_dims; // in tiles
uniform vec3 cam_offset; // x, y and zoom (actually pixel density...)
uniform float time;
void main() {
    vec2 suv = vec2(uv.x, -uv.y);
    vec4 random = texture(noise, suv * 4.0f - time);
    suv += random.xy * (1.0f / 128.0f);
    vec4 sam = texture(kawa, suv * 4.0f);
    vec4 cl = texture(cloud, suv * (2.0f) - time * 0.15 - cam_offset.xy);
    vec4 a = vec4(ivec4(0x00, 0x50, 0x78, 120)) / 255.0f;
    vec4 b = vec4(ivec4(0x38, 0x60, 0xa8, 255)) / 255.0f;
    vec3 m = mix(a.xyz, b.xyz, sam.x) + a.aaa * cl.a;
    color = vec4(m.x, m.y, m.z, 1.0f);
}`);
kawazokoshader.load();

const cloudshadowshader = new Shader(gl, `${vprolog}
out vec2 uv;
void main() {
    uv = vec2(pos.x, -pos.y);
    gl_Position = vec4((pos.x * 2.0f) - 1.0f, -(pos.y * 2.0f) - 1.0f, 0.0f, 1.0f);
}
`, `${fprolog}
in vec2 uv;
uniform float time;
void main() {
    vec2 suv = vec2(uv.x, -uv.y);
    vec4 cl = texture(cloud, suv - time * 0.45);
    color = vec4(0, 0, 0, cl.a * 47.0f / 255.0f);
}`);
cloudshadowshader.load();


let currentTime = 0;
let currentTimeLoc: WebGLUniformLocation;
let currentTimeLoc2: WebGLUniformLocation;
let camOffsetLoc: WebGLUniformLocation;
const drawMap = () => {
    gl.bindVertexArray(vao);

    // draw kawazoko
    gl.useProgram(kawazokoshader.prog!);
    gl.uniform1f(currentTimeLoc, currentTime * 0.0000625);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // draw tilemap
    gl.useProgram(tilemapshader.prog!);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, 64 * 64);

    // draw cloud shadows
    gl.useProgram(cloudshadowshader.prog!);
    gl.uniform1f(currentTimeLoc2, currentTime * 0.0000625);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.useProgram(null);
    gl.bindVertexArray(null);
};

addEventListener("load", () => {
    const framerateinput = document.getElementById('fr') as HTMLInputElement;
    let lastTime = 0;
    let interval = 1000 / (+framerateinput.value); // Approximately 62.5ms
    framerateinput.onchange = () => {
        interval = 1000 / (+framerateinput.value);
    };

    const inputGetter = ((id: string) => {
        const e = document.getElementById(id) as HTMLInputElement;
        let v = +e.value;
        e.onchange = () => v = +e.value;
        return () => v;
    });

    const anima = inputGetter('anima');
    const animb = inputGetter('animb');

    let currentFrame = 0;

    // inaccuracy: Both are animated at the same framerate here, but it
    // seems like the game animates A slower (3FPS?) than B (4FPS?)
    function animate(time: number) {
        requestAnimationFrame(animate);

        const deltaTime = time - lastTime;

        if (deltaTime > interval) {
            if (anima() != -1) {
                let anim = anim_a[anima()];
                doAnimation(anim_a_sch, anim, currentFrame % anim.frame_count);
            }
            if (animb() != -1) {
                let anim = anim_b[animb()];
                doAnimation(anim_b_sch, anim, currentFrame % anim.frame_count);
            }
            currentFrame++;
            currentTime = time;
            //drawMap();
            lastTime = time - (deltaTime % interval);
        }
    }

    requestAnimationFrame(animate);
    requestAnimationFrame(function redraw(time: number) {
        requestAnimationFrame(redraw);
        currentTime = time;
        drawMap();
    });


    const ivec2 = (x: any, y?: any) => y !== undefined ? ({ x, y }) : x;
    const texelFetch = (d: [DataView, number, number, number], p: { x: number, y: number; }, i: number) => {
        switch (d[1]) {
            case 1: {
                return { r: d[0].getUint8(p.y * d[2] + p.x) };
            }
            case 2: {
                return { r: d[0].getUint16((p.y * d[2] + p.x) * 2, true) };
            }
        }
        throw "";
    };
    const paddedsch = new Uint8Array(128 * 512);
    paddedsch.set(sch);

    const character_data: Parameters<typeof texelFetch>[0] = [new DataView(paddedsch.buffer), 1, 128, 512];
    const palette_data: Parameters<typeof texelFetch>[0] = [new DataView(scl.buffer), 2, 16, 16];
    const tile_layout: Parameters<typeof texelFetch>[0] = [new DataView(spl.buffer), 2, 64, 64];
    //const inps = document.querySelectorAll('input');
    const tileid = 0x015b;//int(texelFetch(map, itilepos, 0).r);
    const tile_desc_x = ((tileid & 0x3f) << 2) + 0;
    const tile_desc_y = (tileid >> 6) << 2;
    const ss = texelFetch(tile_layout, ivec2(tile_desc_x, tile_desc_y), 0).r; // this should be accessed like a 1D array, but lets keep things "visual"
    console.log(ss, ss.toString(16).padStart(4, '0'));

    const sampleCharacter = (uv: { x: number, y: number; }) => {
        // character data is layout in blocks of 8x8, where each by represents 2 pixels, which means a block is made of 32 sequential bytes
        const iuv = ivec2(uv);
        // so first, we have to figure out which 8x8 block we're in (16 is 128 / blocksize (8))
        const bindex = (iuv.y >> 3) * 16 + (iuv.x >> 3);
        // then which pixel within that block;
        const pidx = ((iuv.y & 7) << 3) + (iuv.x & 7);
        // so the offset to the precise byte we need to read is
        const byteoffset = (bindex << 5) + (pidx >> 1);
        // so the coordinate in the texture is
        const bytecoord = ivec2(byteoffset & 0xff, (byteoffset >> 8) << 1);
        let byte = texelFetch(character_data, bytecoord, 0).r;
        // which nibble to get depends on the pixel index
        byte = (byte >> ((pidx & 1) << 2)) & 0xF;
        const kk = ivec2(byte, (0));
        const col = texelFetch(palette_data, kk, 0).r;
        return col | ((+(byte == 0)) << 15);
    };

    //const canv = document.createElement('canvas');
    //canv.width = 128;
    //canv.height = 512;
    //document.body.appendChild(canv);

    //const ctx = canv.getContext('2d')!;
    const doRender = () => {

        // const pd = ctx.getImageData(0, 0, 128, 512)!;
        // for (let y = 0; y < 512; ++y) {
        //     for (let x = 0; x < 128; ++x) {
        //         const p = sampleCharacter({ x, y });
        //         const [b, g, r, a] = decodePixel(p);
        //         pd.data[(pd.width * y + x) * 4 + 0] = r;
        //         pd.data[(pd.width * y + x) * 4 + 1] = g;
        //         pd.data[(pd.width * y + x) * 4 + 2] = b;
        //         pd.data[(pd.width * y + x) * 4 + 3] = a * (1 - (p >> 15));
        //     }
        // }
        // ctx.putImageData(pd, 0, 0);
    };

    const computeBlockPos = (p: [number, number], b: number = 16, bcc = 2) => {
        const bb = [~~(p[0] / b), ~~(p[1] / b)];
        const rr = [p[0] & (b - 1), p[1] & (b - 1)];

        const bs = b * b;
        const ti = rr[1] * b + rr[0];
        const bidx = bb[1] * bcc + bb[0];
        const off = bs * bidx + ti;
        const nx = off & ((b * bcc) - 1);
        const ny = ~~(off / (b * bcc));
        return [...p, nx, ny];
    };
    let kkk: number[][] = [];
    for (let y = 0; y < 4; ++y) {
        for (let x = 0; x < 4; ++x) {
            kkk.push(computeBlockPos([x, y], 2));
        }
    }
    console.log(kkk);

    //doRender();
    //return;
    for (let s of [tilemapshader, kawazokoshader, cloudshadowshader]) {
        gl.useProgram(s.prog!);
        gl.uniform2fv(gl.getUniformLocation(s.prog!, "tile_size")!, [8, 8]);
        gl.uniform2fv(gl.getUniformLocation(s.prog!, "map_size")!, [512, 512]);
        gl.uniform2fv(gl.getUniformLocation(s.prog!, "map_dims")!, [64, 64]);

        gl.uniform1i(gl.getUniformLocation(s.prog!, "map")!, 0);
        gl.uniform1i(gl.getUniformLocation(s.prog!, "character_data")!, 1);
        gl.uniform1i(gl.getUniformLocation(s.prog!, "palette_data")!, 2);
        gl.uniform1i(gl.getUniformLocation(s.prog!, "tile_layout")!, 3);

        gl.uniform1i(gl.getUniformLocation(s.prog!, "sfilter")!, 4);
        gl.uniform1i(gl.getUniformLocation(s.prog!, "kawa")!, 5);
        gl.uniform1i(gl.getUniformLocation(s.prog!, "cloud")!, 6);
        gl.uniform1i(gl.getUniformLocation(s.prog!, "noise")!, 7);
    }

    currentTimeLoc = gl.getUniformLocation(kawazokoshader.prog!, "time")!;
    camOffsetLoc = gl.getUniformLocation(kawazokoshader.prog!, "cam_offset")!;
    currentTimeLoc2 = gl.getUniformLocation(cloudshadowshader.prog!, "time")!;

    gl.activeTexture(gl.TEXTURE0);
    const mapTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, mapTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, 32, 32, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, new Uint16Array(map.buffer));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.activeTexture(gl.TEXTURE1);
    const charTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, charTex);
    //const paddedsch = new Uint8Array(128 * 512);
    //paddedsch.set(sch);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, 128, 384, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, paddedsch);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    function doAnimation(data: Uint8Array, anim: Animation, frame: number) {
        if (anim.dest === undefined) // haven't looked up where that animation goes yet
            return;
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, charTex);
        const blocks_per_column = 16;
        const frame_size_in_blocks = anim.height * blocks_per_column; // height times number of blocks in a sch sheet

        const offset_to_animation_in_blocks = (anim.source * blocks_per_column);
        const offset_to_frame_in_blocks = offset_to_animation_in_blocks + frame_size_in_blocks * frame;
        const dest_offset_in_blocks = (anim.dest * blocks_per_column);

        const frame_size_in_bytes = frame_size_in_blocks * 32;
        const offset_to_frame_in_bytes = offset_to_frame_in_blocks * 32;
        const dest_offset_in_bytes = dest_offset_in_blocks * 32;

        // one block is 32 bytes, so the offset
        //paddedsch.set(data.slice(offset_to_frame_in_bytes, offset_to_frame_in_bytes + frame_size_in_bytes), dest_offset_in_bytes);
        //for (let i = 0; i < paddedsch.byteLength; ++i)
        //paddedsch[i] = 0;
        paddedsch.set(data.slice(offset_to_frame_in_bytes, offset_to_frame_in_bytes + frame_size_in_bytes), dest_offset_in_bytes);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, 128, 384, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, paddedsch);
        //gl.texImage2D
        //gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, anim.dest / 8, 128, 8 * )
    }


    gl.activeTexture(gl.TEXTURE2);
    const paletteTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, paletteTexture);
    let kk = new Uint16Array(scl.buffer);
    convertPalette(kk);
    const mapfile = document.getElementById('mapfile') as HTMLInputElement;

    mapfile!.onchange = async () => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, mapTex);
        const data = await mapfile.files?.[0].arrayBuffer();
        if (!data)
            return;
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, 32, 32, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, new Uint16Array(data));
    };

    const schfile = document.getElementById('schfile') as HTMLInputElement;
    schfile!.onchange = async () => {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, charTex);
        const data = await schfile.files?.[0].arrayBuffer();
        if (!data)
            return;
        paddedsch.set(new Uint8Array(data));
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, 128, 384, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, paddedsch);
    };

    const sclfile = document.getElementById('sclfile') as HTMLInputElement;
    sclfile!.onchange = async () => {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, paletteTexture);
        const data = await sclfile.files?.[0].arrayBuffer();
        if (!data)
            return;
        kk = new Uint16Array(data);
        convertPalette(kk);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, 16, 16, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, kk);
    };


    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, 16, 16, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, kk);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.activeTexture(gl.TEXTURE3);
    const layoutTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, layoutTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, 64, 64, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, new Uint16Array(spl.buffer));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    const loadPngTexture = async (t: string, idx: number, wraps: number = gl.REPEAT, wrapt: number = gl.REPEAT, fil: number = gl.NEAREST) => {
        const img = new Image();
        await new Promise((r, e) => { img.onload = r, img.onerror = e; img.src = t; });

        gl.activeTexture(gl.TEXTURE0 + idx);
        const layoutTexture = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, layoutTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, fil);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, fil);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wraps);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapt);
    };
    loadPngTexture(res.filter1, 4);
    loadPngTexture(res.kawazoko, 5, gl.REPEAT, gl.REPEAT, gl.LINEAR);
    loadPngTexture(res.kumo_env, 6, gl.REPEAT, gl.REPEAT, gl.LINEAR);
    loadPngTexture(res.noize_kawazoko_1, 7, gl.REPEAT, gl.REPEAT, gl.LINEAR);

    function updateCam() {
        gl.useProgram(kawazokoshader.prog!);
        gl.uniform3fv(camOffsetLoc, [scrollX / innerWidth, scrollY / innerHeight, devicePixelRatio]);
    }
    window.addEventListener("scroll", updateCam);
    window.addEventListener("resize", updateCam);
    updateCam();
    gl.useProgram(null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    drawMap();
});
