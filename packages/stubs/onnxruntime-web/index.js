'use strict';
// §PERF-BOOT — see package.json. transformers' Node build must never reach the
// web ONNX backend; failing loud here beats silently shipping 129 MB.
throw new Error(
  'onnxruntime-web was stubbed out for server installs (129 MB, never executed in Node). '
  + 'If you are seeing this, something imported the web ONNX backend in a Node process — '
  + 'remove the pnpm override in the workspace root package.json to restore the real package.',
);
