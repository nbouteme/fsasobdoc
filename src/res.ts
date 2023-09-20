// overlay of opaque tiles
export default {
    filter1: "./res/filter1.png",
    filter2: "./res/filter2.png",
    filter3: "./res/filter3.png",
    filter4: "./res/filter4.png",
    filter5: "./res/filter5.png",
    filter6: "./res/filter6.png",
    filter7: "./res/filter7.png",
    filter8: "./res/filter8.png",
    filter9: "./res/filter9.png",
    // used to simulate ambiant occlusion, more specifically near cliffs that go into water
    // don't know the actual rules, if it's procedurally determined or if it's data hardcoded somewhere
    circle: "./res/circle.png",
    // means "bottom of river", the pebbles
    kawazoko: "./res/kawazoko.png",
    // some perlin noise, used to distort what draw on partially transparent tiles.
    noize_kawazoko_1: "./res/noize_kawazoko_1.png",
    // clouds that are draw as reflections of water, but also used for the larger shadows that cover the map
    kumo_env: "./res/kumo_env.png",
};
