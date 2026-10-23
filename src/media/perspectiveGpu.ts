import type { FrameScene } from '../domain/scene';
import { projectScreenPoint, screenProjectionWeight } from '../domain/projection';

interface GpuSurface {
  canvas: OffscreenCanvas;
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  vertices: WebGLBuffer;
  texture: WebGLTexture;
  position: number;
  uv: number;
}
const surfaces = new WeakMap<OffscreenCanvas, GpuSurface | null>();

function createSurface(width: number, height: number): GpuSurface | null {
  const canvas = new OffscreenCanvas(width, height);
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true,
    depth: false, stencil: false, preserveDrawingBuffer: true });
  if (!gl) return null;
  const shader = (kind: number, source: string) => {
    const handle = gl.createShader(kind)!;
    gl.shaderSource(handle, source); gl.compileShader(handle);
    if (!gl.getShaderParameter(handle, gl.COMPILE_STATUS)) { gl.deleteShader(handle); throw new Error('3D shader compilation failed'); }
    return handle;
  };
  try {
    const vertex = shader(gl.VERTEX_SHADER, `attribute vec4 position; attribute vec2 uv;
      varying vec2 textureUv; void main() { gl_Position = position; textureUv = uv; }`);
    const fragment = shader(gl.FRAGMENT_SHADER, `precision highp float; uniform sampler2D screen;
      varying vec2 textureUv; void main() { gl_FragColor = texture2D(screen, textureUv); }`);
    const program = gl.createProgram()!; gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); return null; }
    gl.useProgram(program); gl.uniform1i(gl.getUniformLocation(program, 'screen'), 0);
    const texture = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    return { canvas, gl, program, texture, vertices: gl.createBuffer()!, position: gl.getAttribLocation(program, 'position'), uv: gl.getAttribLocation(program, 'uv') };
  } catch {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return null;
  }
}

/** One textured plane; homogeneous clip coordinates keep perspective and alpha exact. */
export function projectGpuSurface(layer: OffscreenCanvas, scene: FrameScene): OffscreenCanvas | null {
  let surface = surfaces.get(layer);
  if (surface === undefined) { surface = createSurface(layer.width, layer.height); surfaces.set(layer, surface); }
  if (!surface || surface.gl.isContextLost()) return null;
  const { gl } = surface;
  const width = layer.width, height = layer.height;
  const data: number[] = [];
  for (const [x, y] of [[0, 0], [width, 0], [0, height], [width, height]]) {
    const point = projectScreenPoint(scene, { x, y });
    const w = screenProjectionWeight(scene, { x, y });
    data.push((point.x / width * 2 - 1) * w, (1 - point.y / height * 2) * w, 0, w, x / width, y / height);
  }
  gl.viewport(0, 0, width, height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(surface.program); gl.bindBuffer(gl.ARRAY_BUFFER, surface.vertices);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(surface.position); gl.vertexAttribPointer(surface.position, 4, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(surface.uv); gl.vertexAttribPointer(surface.uv, 2, gl.FLOAT, false, 24, 16);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, surface.texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, layer);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return surface.canvas;
}
