"""Trace one flat palette PNG to SVG with vtracer: scenes_trace.py in.png out.svg."""

import sys

import vtracer

src, dst = sys.argv[1], sys.argv[2]
vtracer.convert_image_to_svg_py(
    src,
    dst,
    colormode="color",
    hierarchical="stacked",
    mode="spline",
    filter_speckle=6,
    color_precision=8,
    layer_difference=8,
    corner_threshold=60,
    length_threshold=5.0,
    max_iterations=10,
    splice_threshold=45,
    path_precision=1,
)
