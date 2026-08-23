# Third-party notices

## SuperSplat selection design

The inspection-point circle selector in `src/gaussian-circle-selector.ts` adapts the centers-mode GPU selection layout used by [PlayCanvas SuperSplat](https://github.com/playcanvas/supersplat): four Gaussian selection decisions are packed into one RGBA8 output texel. The product-specific predicate is a single-click fixed 5px-radius circle (not a draggable brush), and the selected centers are used for PCA normal fitting.

SuperSplat is distributed under the MIT License. Copyright belongs to its respective contributors. This notice does not change the license of this repository.
