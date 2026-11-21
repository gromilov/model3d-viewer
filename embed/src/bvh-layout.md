# Ray tracing: data layout

The contract between the CPU builder and the GPU tracer. Both sides are written
against this document, so a change here is a change in two files.

All geometry is in the viewer's **normalised space**: `(rawPosition - centre) * scale`
where `centre` and `scale` are the mesh's bounding-sphere normalisation. That is
the space the existing camera already orbits in, so the traced image frames
exactly like the rasterised one. Nothing else is transformed.

## Textures

Two `RGBA32F` textures, `NEAREST` filtered, no mips.

### `uNodes` — the tree

Two texels per node. Node `i` occupies texels `2i` and `2i + 1`.

    texel 2i    : ( minX, minY, minZ, leftOrFirst )
    texel 2i + 1: ( maxX, maxY, maxZ, count )

`count` is the number of primitives in a **leaf**; `0` marks an **internal** node,
and then `leftOrFirst` is the index of its first child. Children are stored
contiguously, so the second child is `leftOrFirst + 1`.

A leaf's primitives are at `[leftOrFirst, leftOrFirst + count)` in `uPrims`.

Node 0 is the root. The tree is built depth-first with a node budget; a node that
exceeds the budget becomes a leaf regardless of how many primitives it holds, so a
pathological model degrades in quality rather than failing to build.

### `uPrims` — the primitives

Three texels per primitive. Primitive `j` occupies texels `3j`, `3j + 1`, `3j + 2`.

    texel 3j    : ( p0x, p0y, p0z, type )
    texel 3j + 1: ( p1x, p1y, p1z, radius )
    texel 3j + 2: ( p2x, p2y, p2z, slot )

| `type` | shape | `p0` | `p1` | `p2` | `radius` |
|---|---|---|---|---|---|
| `0` | triangle | v0 | v1 | v2 | unused |
| `1` | capsule (stroke) | a | b | unused | the stroke's half-width |

`slot` is the palette slot, an integer in `0..7`, used to look up the filament's
colour and surface in the shader.

A capsule is `a` to `b` swept by a sphere of `radius`. For a sliced plate the
stroke's half-extent across the line is the radius; its height may differ, and the
tracer accepts that approximation rather than storing a second radius, because at
0.2 mm layer height the two are within a few per cent.

## Capsule intersection

The tracer needs distance to a capsule. The exact form: closest approach between
the ray and the segment, then a sphere test against each endpoint if the closest
point lies beyond the segment.

Given ray `o + t*d` and segment `a` to `b`:

    ba = b - a
    oa = o - a
    baba = dot(ba, ba)
    bard = dot(ba, d)
    baoa = dot(ba, oa)
    rdoa = dot(d, oa)
    oaoa = dot(oa, oa)
    A = baba - bard*bard
    B = baba*rdoa - baoa*bard
    C = baba*oaoa - baoa*baoa - r*r*baba

If `A ~= 0` the ray is parallel to the capsule's axis and only the end caps can be
hit. Otherwise the discriminant `B*B - A*C` decides. The nearest non-negative root
is a candidate; clamp the hit parameter along the axis to decide whether it lands in
the cylinder or needs a cap test.

This is the standard Inigo Quilez form and is worth following exactly rather than
re-deriving: the degenerate cases (zero-length stroke, ray parallel to the axis)
are the ones that produce black speckles when handled loosely.

## Sampling

Progressive: each pass traces `N` samples per pixel and adds them to an `RGBA16F`
accumulation target with `blendFunc(ONE, ONE)`. The presented image divides by the
sample count. The camera is frozen while accumulating, so the image converges
instead of smearing.

Each sample jitters its ray inside the pixel by a low-discrepancy offset (a
Halton sequence indexed by sample number, or the same golden-ratio rotation every
pass) — random jitter per pass would need a random seed per pass and is no better
once the camera is fixed.
