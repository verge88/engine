import { normalize } from './math.js';
import { buildCascades, CASCADE_COUNT, CASCADE_SHADOW_SIZE } from './cascades.js';
import { cameraBasis } from './lighting.js';
import { makeScreenUniform } from './lighting.js';
import { packPointLights, POINT_LIGHT_BYTES } from './point-lights.js';
import { Environment } from './environment.js';
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
    renderer.environment = await Environment.create(device);
    await renderer.initialize();
    return renderer;
  }
  constructor(canvas, device, context, format) {
    this.canvas = canvas;
    this.device = device;
    this.context = context;
    this.format = format;
    this.shadowSize = CASCADE_SHADOW_SIZE;
    this.shadowCount = CASCADE_COUNT;
    this.hdr = null;
    this.depth = null;
    this.bloomA = null;
    this.bloomB = null;
    this.normalDepth = null;
    this.indirect = null;
    this.reflections = null;
    this.pointLightBuffer = device.createBuffer({
      label: 'Dynamic PBR point lights (16)',
      size: POINT_LIGHT_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.frameUniform = device.createBuffer({ size: 352, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.exposureUniform = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.surfaceSampler = device.createSampler({
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
      addressModeU: 'repeat', addressModeV: 'repeat'
    });
    this.postSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.shadowSampler = device.createSampler({ compare: 'less-equal', magFilter: 'linear', minFilter: 'linear' });
    this.shadow = device.createTexture({
      label: 'Directional sunlight shadow map',
      size: [this.shadowSize, this.shadowSize, this.shadowCount],
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
    this.shadowFrameBuffers = Array.from({ length: this.shadowCount }, () =>
      device.createBuffer({
        size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      }));
    this.shadowFrameGroups = this.shadowFrameBuffers.map(buffer => device.createBindGroup({
      layout: this.shadowFrameLayout,
      entries: [{ binding: 0, resource: { buffer } }]
    }));
    this.frameLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'depth', viewDimension: '2d-array' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: 'cube' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: 'cube' } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d' } },
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 7, visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'read-only-storage' } }
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
      { binding: 1, resource: this.shadow.createView({ dimension: '2d-array' }) },
      { binding: 2, resource: this.shadowSampler },
      { binding: 3, resource: this.environment.irradiance.createView({ dimension: 'cube' }) },
      { binding: 4, resource: this.environment.specular.createView({ dimension: 'cube' }) },
      { binding: 5, resource: this.environment.brdf.createView() },
      { binding: 6, resource: this.environment.sampler },
      { binding: 7, resource: { buffer: this.pointLightBuffer } }
    ] });

    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.frameLayout, this.objectLayout] });
    const shadowLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.shadowFrameLayout, this.shadowObjectLayout]
    });
    const [pbr, shadowShader] = await Promise.all([
      checkedShader(device, 'pbr.wgsl'), checkedShader(device, 'shadow.wgsl')
    ]);
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
      vertex: { module: shadowShader, entryPoint: 'vsShadow', buffers: vertexBuffers },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less',
        depthBias: 2, depthBiasSlopeScale: 2
      }
    });
    this.mainPipeline = await device.createRenderPipelineAsync({
      label: 'Metallic-roughness PBR pass', layout,
      vertex: { module: pbr, entryPoint: 'vsMain', buffers: vertexBuffers },
      fragment: { module: pbr, entryPoint: 'fsMain', targets: [
        { format: 'rgba16float' },
        { format: 'rgba16float' }
      ] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' }
    });

    const post = await checkedShader(device, 'post.wgsl');
    this.postLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: 'cube' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d' } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d' } },
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d' } }
    ] });
    this.postPipeline = await device.createRenderPipelineAsync({
      label: 'ACES HDR tone mapping',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.postLayout] }),
      vertex: { module: post, entryPoint: 'vsPost' },
      fragment: { module: post, entryPoint: 'fsPost', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' }
    });

    const bloom = await checkedShader(device, 'bloom.wgsl');
    this.bloomLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: 'cube' } }
    ] });
    const bloomPipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bloomLayout]
    });
    const makeBloomPipeline = (entryPoint, label) => device.createRenderPipelineAsync({
      label, layout: bloomPipelineLayout,
      vertex: { module: bloom, entryPoint: 'vsFullscreen' },
      fragment: { module: bloom, entryPoint, targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' }
    });
    [this.extractPipeline, this.blurHPipeline, this.blurVPipeline] = await Promise.all([
      makeBloomPipeline('fsExtract', 'HDR bright-pass extraction'),
      makeBloomPipeline('fsBlurH', 'Gaussian bloom horizontal'),
      makeBloomPipeline('fsBlurV', 'Gaussian bloom vertical')
    ]);

    const screen = await checkedShader(device, 'screen-space.wgsl');
    this.screenLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }
    ] });
    const screenLayout = device.createPipelineLayout({ bindGroupLayouts: [this.screenLayout] });
    const createScreenPipeline = (name, label) => device.createRenderPipelineAsync({
      label, layout: screenLayout,
      vertex: { module: screen, entryPoint: 'vsFull' },
      fragment: { module: screen, entryPoint: name, targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' }
    });
    [this.indirectPipeline, this.reflectionPipeline] = await Promise.all([
      createScreenPipeline('fsIndirect', 'Half-res screen-space bounce and occlusion'),
      createScreenPipeline('fsReflection', 'Half-res screen-space reflections')
    ]);
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
    this.bloomA?.destroy();
    this.bloomB?.destroy();
    this.normalDepth?.destroy();
    this.indirect?.destroy();
    this.reflections?.destroy();
    this.hdr = this.device.createTexture({
      label: 'Linear HDR color',
      size: [width, height], format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    this.depth = this.device.createTexture({
      size: [width, height], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT
    });
    this.normalDepth = this.device.createTexture({
      label: 'World normal and view depth G-buffer',
      size: [width, height], format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    const bloomSize = [Math.max(1, Math.ceil(width / 2)), Math.max(1, Math.ceil(height / 2))];
    const bloomTexture = label => this.device.createTexture({
      label, size: bloomSize, format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    });
    this.bloomA = bloomTexture('Half-resolution bloom A');
    this.bloomB = bloomTexture('Half-resolution bloom B');
    this.indirect = bloomTexture('Half-res indirect light and occlusion');
    this.reflections = bloomTexture('Half-res screen-space reflections');

    this.screenGroup = this.device.createBindGroup({
      layout: this.screenLayout,
      entries: [
        { binding: 0, resource: this.hdr.createView() },
        { binding: 1, resource: this.normalDepth.createView() },
        { binding: 2, resource: this.postSampler },
        { binding: 3, resource: { buffer: this.exposureUniform } }
      ]
    });

    const sky = this.environment.sky.createView({ dimension: 'cube' });
    const bloomGroup = texture => this.device.createBindGroup({
      layout: this.bloomLayout,
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: this.postSampler },
        { binding: 2, resource: { buffer: this.exposureUniform } },
        { binding: 3, resource: sky }
      ]
    });
    this.extractGroup = bloomGroup(this.hdr);
    this.blurHGroup = bloomGroup(this.bloomA);
    this.blurVGroup = bloomGroup(this.bloomB);
    this.postGroup = this.device.createBindGroup({ layout: this.postLayout, entries: [
      { binding: 0, resource: this.hdr.createView() },
      { binding: 1, resource: this.postSampler },
      { binding: 2, resource: { buffer: this.exposureUniform } },
      { binding: 3, resource: sky },
      { binding: 4, resource: this.bloomA.createView() },
      { binding: 5, resource: this.indirect.createView() },
      { binding: 6, resource: this.reflections.createView() }
    ] });
  }
  render(scene, camera) {
    this.resize();
    const device = this.device;
    const { position, viewProjection } = camera.frame(this.canvas.width / this.canvas.height);
    const sun = normalize(scene.sunDirection);
    this.environment.regenerate(sun);
    const cascades = buildCascades({
      eye: position, target: camera.target,
      aspect: this.canvas.width / this.canvas.height,
      sunDirection: sun, shadowSize: this.shadowSize
    });
    const { forward } = cameraBasis(position, camera.target);
    // WGSL Frame uniform: 1 MVP + 3 cascade VP matrices + 6 vec4 = 352 bytes.
    const frame = new Float32Array(88);
    frame.set(viewProjection, 0);
    for (let i = 0; i < this.shadowCount; i++) {
      frame.set(cascades.matrices[i], 16 + i * 16);
      device.queue.writeBuffer(this.shadowFrameBuffers[i], 0, cascades.matrices[i]);
    }
    frame.set([...position, 1], 64);
    frame.set([...forward, 0], 68);
    frame.set([...sun, 0], 72);
    frame.set([...scene.sunColor, scene.sunIntensity], 76);
    frame.set([0, 0, 0, scene.exposure], 80);
    frame.set([...cascades.splits, 0], 84);
    device.queue.writeBuffer(this.frameUniform, 0, frame);
    device.queue.writeBuffer(this.exposureUniform, 0,
      makeScreenUniform(scene, position, camera.target, this.canvas.width / this.canvas.height));
    device.queue.writeBuffer(this.pointLightBuffer, 0, packPointLights(scene.pointLights));

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
    for (let i = 0; i < this.shadowCount; i++) {
      const shadowPass = encoder.beginRenderPass({
        label: 'Cascaded shadow map ' + (i + 1),
        colorAttachments: [],
        depthStencilAttachment: {
          view: this.shadow.createView({
            dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1
          }),
          depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store'
        }
      });
      shadowPass.setPipeline(this.shadowPipeline);
      shadowPass.setBindGroup(0, this.shadowFrameGroups[i]);
      this.draw(shadowPass, renderables, true);
      shadowPass.end();
    }

    const colorPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.hdr.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear', storeOp: 'store'
      }, {
        view: this.normalDepth.createView(),
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

    this.fullscreenPass(encoder, this.indirectPipeline, this.screenGroup,
      this.indirect.createView(), scene.aoStrength > 0 || scene.giStrength > 0);
    this.fullscreenPass(encoder, this.reflectionPipeline, this.screenGroup,
      this.reflections.createView(), scene.ssrStrength > 0);

    if (scene.bloomStrength > 0) {
      this.fullscreenPass(encoder, this.extractPipeline, this.extractGroup, this.bloomA.createView());
      this.fullscreenPass(encoder, this.blurHPipeline, this.blurHGroup, this.bloomB.createView());
      this.fullscreenPass(encoder, this.blurVPipeline, this.blurVGroup, this.bloomA.createView());
    }

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
  fullscreenPass(encoder, pipeline, group, target, enabled = true) {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: target, clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear', storeOp: 'store'
      }]
    });
    if (enabled) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
    }
    pass.end();
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
