/**
 * The program of the render worker, as source text for `new Worker(code, { eval: true })`: it is plain CommonJS that needs no
 * file of its own, so it works unchanged from `src` (tsx, vitest) and from `dist`. The wasm renderer lives only in this thread;
 * the main thread never draws, so a slow or hostile drawing can be ended with `worker.terminate()`.
 * Job: `{ id, svg, sizes, maskableInner, color }`. Answer: `{ type: 'done', id, files }` or `{ type: 'failed', id, message }`.
 */
export const ICON_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const { initWasm, Resvg } = require(workerData.module);
const ready = initWasm(fs.promises.readFile(workerData.wasm)).then(() => parentPort.postMessage({ type: 'ready' }));
ready.catch((e) => { parentPort.postMessage({ type: 'failed', id: 0, message: String(e && e.message || e) }); });

function render(svg, size) {
  const image = new Resvg(svg, { fitTo: { mode: 'width', value: size }, font: { loadSystemFonts: false } }).render();
  if (image.width !== size || image.height !== size) throw new Error('the icon must be square (use viewBox="0 0 512 512").');
  return new Uint8Array(image.asPng());
}

parentPort.on('message', async (job) => {
  try {
    await ready;
    const files = {};
    for (const size of job.sizes) files['icon-' + size + '.png'] = render(job.svg, size);
    const inner = Buffer.from(render(job.svg, job.maskableInner)).toString('base64');
    const offset = (512 - job.maskableInner) / 2;
    files['icon-512-maskable.png'] = render(
      '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="' + job.color + '"/>'
      + '<image x="' + offset + '" y="' + offset + '" width="' + job.maskableInner + '" height="' + job.maskableInner + '" href="data:image/png;base64,' + inner + '"/></svg>', 512);
    parentPort.postMessage({ type: 'done', id: job.id, files });
  } catch (e) {
    parentPort.postMessage({ type: 'failed', id: job.id, message: String(e && e.message || e) });
  }
});
`;
