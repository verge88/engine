import { lookAt, multiply, normalize, orthographic } from './math.js';
import { Scene } from './scene.js';

const shaderURL = name => new URL(name, import.meta.url);
const checkedShader = async (device, url) => {
  const response = await fetch(shaderURL(url));
  if (!response.ok) throw new Error('Cannot load shader ' + url + ': HTTP ' + response.status);
  const module = device.createShaderModule({ label: url, code: await response.text() });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter(m => m.type === 'error');
  if (errors.length) throw new Error(url + ': ' + errors.map(e => e.message).join('\n'));
  return module;
};
const makeBuffer = (device, data, usage) => {
  const buffer = device.createBuffer({
    size: Math.max(4, (data.byteLength + 3) & ~3),
    usage: usage | GPUBufferUsage.COPY_DST
  });
  device.queue.writeBuffer(buffer, 0, data);
  return buffer;
};

export class Renderer {
  static async create(canvas) {
    if (!navigator.gpu) throw new Error('WebGPU is unavailable. Use a current Chrome/Edge browser on HTTPS or localhost.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No compatible WebGPU GPU adapter was found.');
    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('Could not create WebGPU canvas context.');
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
    const renderer = new Renderer(canvas, device, context, format);
    await renderer.initialize();
    return renderer;
  }
  constructor(canvas, device, context, format) {
    this.canvas = canvas;
    this.device = device;
    this.context = context;
    this.format = format;
    this.shadowSize = 2048;
    this.hdr = null;
    this.depth = null;
    this.frameUniform = device.createBuffer({ size: 192, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.exposureUniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.surfaceSampler = device.createSampler({
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
      addressModeU: 'repeat', addressModeV: 'repeat'
    });
    this.postSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.shadowSampler = device.createSampler({ compare: 'less-equal', magFilter: 'linear', minFilter: 'linear' });
    this.shadow = device.createTexture({
      label: 'Directional sunlight shadow map',
      size: [this.shadowSize, this.shadowSize],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    this.white = this.solidTexture([255, 255, 255, 255], false);
    this.whiteSRGB = this.solidTexture([255, 255, 255, 255], true);
    this.flatNormal = this.solidTexture([128, 128, 255, 255], false);
  }
  async initialize() {
    const device = this.device;
    const visibility = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    // Shadow pass must NOT bind the depth texture it is currently writing.
    // It has dedicated layouts containing only the uniform buffers used by vsShadow.
    this.shadowFrameLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }
    ] });
    this.shadowObjectLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }
    ] });
    this.shadowFrameGroup = device.createBindGroup({ layout: this.shadowFrameLayout, entries: [
      { binding: 0, resource: { buffer: this.frameUniform } }
    ] });
    this.frameLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } }
    ] });
    this.objectLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility, buffer: { type: 'uniform' } },
      ...[1, 2, 3].map(binding => ({
        binding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' }
      })),
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } }
    ] });
    this.frameGroup = device.createBindGroup({ layout: this.frameLayout, entries: [
      { binding: 0, resource: { buffer: this.frameUniform } },
      { binding: 1, resource: this.shadow.createView() },
      { binding: 2, resource: this.shadowSampler }
    ] });

    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.frameLayout, this.objectLayout] });
    const shadowLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.shadowFrameLayout, this.shadowObjectLayout]
    });
    const pbr = await checkedShader(device, 'pbr.wgsl');
    const vertexBuffers = [{
      arrayStride: 32,
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 1, offset: 12, format: 'float32x3' },
        { shaderLocation: 2, offset: 24, format: 'float32x2' }
      ]
    }];
    this.shadowPipeline = await device.createRenderPipelineAsync({
      label: 'Shadow depth pass', layout: shadowLayout,
      vertex: { module: pbr, entryPoint: 'vsShadow', buffers: vertexBuffers },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less',
        depthBias: 2, depthBiasSlopeScale: 2
      }
    });
    this.mainPipeline = await device.createRenderPipelineAsync({
      label: 'Metallic-roughness PBR pass', layout,
      vertex: { module: pbr, entryPoint: 'vsMain', buffers: vertexBuffers },
      fragment: { module: pbr, entryPoint: 'fsMain', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' }
    });

    const post = await checkedShader(device, 'post.wgsl');
    this.postLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }
    ] });
    this.postPipeline = await device.createRenderPipelineAsync({
      label: 'ACES HDR tone mapping',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.postLayout] }),
      vertex: { module: post, entryPoint: 'vsPost' },
      fragment: { module: post, entryPoint: 'fsPost', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' }
    });
  }
  solidTexture(rgba, srgb) {
    const texture = this.device.createTexture({
      size: [1, 1], format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    this.device.queue.writeTexture({ texture }, new Uint8Array(rgba),
      { bytesPerRow: 4, rowsPerImage: 1 }, [1, 1]);
    return texture;
  }
  textureFromBitmap(bitmap, srgb = false) {
    const texture = this.device.createTexture({
      size: [bitmap.width, bitmap.height], format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
    });
    this.device.queue.copyExternalImageToTexture({ source: bitmap }, { texture },
      [bitmap.width, bitmap.height]);
    return texture;
  }
  geometry(source) {
    if (!(source.vertices instanceof Float32Array) || !(source.indices instanceof Uint32Array) ||
        source.vertices.length % 8 !== 0 || source.indices.length === 0)
      throw new Error('Geometry requires interleaved Float32 vertices and Uint32 indices');
    return {
      vertexBuffer: makeBuffer(this.device, source.vertices, GPUBufferUsage.VERTEX),
      indexBuffer: makeBuffer(this.device, source.indices, GPUBufferUsage.INDEX),
      indexCount: source.indices.length
    };
  }
  prepare(object) {
    if (object._gpu) return object._gpu;
    const device = this.device;
    const uniform = device.createBuffer({ size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const material = object.material;
    const bindGroup = device.createBindGroup({ layout: this.objectLayout, entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: (material.baseColorTexture ?? this.whiteSRGB).createView() },
      { binding: 2, resource: (material.normalTexture ?? this.flatNormal).createView() },
      { binding: 3, resource: (material.metallicRoughnessTexture ?? this.white).createView() },
      { binding: 4, resource: this.surfaceSampler }
    ] });
    const shadowGroup = device.createBindGroup({
      layout: this.shadowObjectLayout,
      entries: [{ binding: 0, resource: { buffer: uniform } }]
    });
    object._gpu = { uniform, bindGroup, shadowGroup };
    return object._gpu;
  }
  resize() {
    const max = this.device.limits.maxTextureDimension2D;
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.min(max, Math.max(1, Math.floor(this.canvas.clientWidth * scale)));
    const height = Math.min(max, Math.max(1, Math.floor(this.canvas.clientHeight * scale)));
    if (this.hdr && this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.hdr?.destroy();
    this.depth?.destroy();
    this.hdr = this.device.createTexture({
      label: 'Linear HDR color',
      size: [width, height], format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    this.depth = this.device.createTexture({
      size: [width, height], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT
    });
    this.postGroup = this.device.createBindGroup({ layout: this.postLayout, entries: [
      { binding: 0, resource: this.hdr.createView() },
      { binding: 1, resource: this.postSampler },
      { binding: 2, resource: { buffer: this.exposureUniform } }
    ] });
  }
  render(scene, camera) {
    this.resize();
    const device = this.device;
    const { position, viewProjection } = camera.frame(this.canvas.width / this.canvas.height);
    const sun = normalize(scene.sunDirection);
    const center = camera.target;
    const lightEye = center.map((p, i) => p + 30 * sun[i]);
    const lightProjection = multiply(
      orthographic(-24, 24, -24, 24, 0.1, 75),
      lookAt(lightEye, center)
    );
    const frame = new Float32Array(48);
    frame.set(viewProjection);
    frame.set(lightProjection, 16);
    frame.set([...position, 1], 32);
    frame.set([...sun, 0], 36);
    frame.set([...scene.sunColor, scene.sunIntensity], 40);
    frame.set([0, 0, 0, scene.exposure], 44);
    device.queue.writeBuffer(this.frameUniform, 0, frame);
    device.queue.writeBuffer(this.exposureUniform, 0, new Float32Array([scene.exposure]));

    const renderables = [];
    for (const obj of scene.objects) {
      if (!obj.visible) continue;
      const gpu = this.prepare(obj);
      const data = new Float32Array(40);
      data.set(Scene.modelMatrix(obj), 0);
      data.set(Scene.normalMatrix(obj), 16);
      data.set(obj.material.baseColor ?? [1, 1, 1, 1], 32);
      data.set([
        obj.material.metallic ?? 0, obj.material.roughness ?? 0.7,
        obj.material.occlusionStrength ?? 1, 0
      ], 36);
      device.queue.writeBuffer(gpu.uniform, 0, data);
      renderables.push([obj.geometry, gpu.bindGroup, gpu.shadowGroup]);
    }

    const encoder = device.createCommandEncoder();
    const shadowPass = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: this.shadow.createView(), depthClearValue: 1,
        depthLoadOp: 'clear', depthStoreOp: 'store'
      }
    });
    shadowPass.setPipeline(this.shadowPipeline);
    shadowPass.setBindGroup(0, this.shadowFrameGroup);
    this.draw(shadowPass, renderables, true);
    shadowPass.end();

    const colorPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.hdr.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear', storeOp: 'store'
      }],
      depthStencilAttachment: {
        view: this.depth.createView(), depthClearValue: 1,
        depthLoadOp: 'clear', depthStoreOp: 'store'
      }
    });
    colorPass.setPipeline(this.mainPipeline);
    colorPass.setBindGroup(0, this.frameGroup);
    this.draw(colorPass, renderables);
    colorPass.end();

    const postPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear', storeOp: 'store'
      }]
    });
    postPass.setPipeline(this.postPipeline);
    postPass.setBindGroup(0, this.postGroup);
    postPass.draw(3);
    postPass.end();
    device.queue.submit([encoder.finish()]);
  }
  draw(pass, renderables, shadow = false) {
    for (const [geometry, bindGroup, shadowGroup] of renderables) {
      pass.setBindGroup(1, shadow ? shadowGroup : bindGroup);
      pass.setVertexBuffer(0, geometry.vertexBuffer);
      pass.setIndexBuffer(geometry.indexBuffer, 'uint32');
      pass.drawIndexed(geometry.indexCount);
    }
  }
}
