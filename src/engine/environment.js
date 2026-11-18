import { normalize } from './math.js';

export const ENV_SIZE = 256;
export const IRRADIANCE_SIZE = 32;
export const SPECULAR_SIZE = 128;
export const SPECULAR_MIPS = 6;
export const BRDF_SIZE = 128;

export function roughnessAtMip(mip, mipCount = SPECULAR_MIPS) {
  if (!Number.isInteger(mip) || mip < 0 || mip >= mipCount || mipCount < 2)
    throw new RangeError('Invalid environment mip level');
  return mip / (mipCount - 1);
}

const cubeTexture = (device, size, mipLevelCount = 1) => device.createTexture({
  size: [size, size, 6],
  mipLevelCount,
  dimension: '2d',
  format: 'rgba16float',
  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
});

const storageCubeView = (texture, mipLevel = 0) => texture.createView({
  dimension: '2d-array', baseMipLevel: mipLevel, mipLevelCount: 1,
  baseArrayLayer: 0, arrayLayerCount: 6
});

async function moduleFromURL(device, name) {
  const response = await fetch(new URL(name, import.meta.url));
  if (!response.ok) throw new Error('Environment shader unavailable: ' + name);
  const module = device.createShaderModule({ label: name, code: await response.text() });
  const errors = (await module.getCompilationInfo()).messages.filter(item => item.type === 'error');
  if (errors.length) throw new Error(name + ': ' + errors.map(item => item.message).join('\n'));
  return module;
}

export class Environment {
  static async create(device, sun = [0.45, 0.85, 0.32]) {
    const environment = new Environment(device);
    await environment.initialize();
    environment.regenerate(sun);
    return environment;
  }
  constructor(device) {
    this.device = device;
    this.sky = cubeTexture(device, ENV_SIZE);
    this.irradiance = cubeTexture(device, IRRADIANCE_SIZE);
    this.specular = cubeTexture(device, SPECULAR_SIZE, SPECULAR_MIPS);
    this.brdf = device.createTexture({
      size: [BRDF_SIZE, BRDF_SIZE], format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
    });
    this.sampler = device.createSampler({
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'
    });
    this.skyUniform = device.createBuffer({
      size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.directionKey = '';
  }
  async initialize() {
    const d = this.device;
    const [skyShader, prefilterShader, brdfShader] = await Promise.all([
      moduleFromURL(d, 'sky.wgsl'),
      moduleFromURL(d, 'prefilter.wgsl'),
      moduleFromURL(d, 'brdf.wgsl')
    ]);
    this.skyPipeline = await d.createComputePipelineAsync({
      label: 'Procedural HDR sky cubemap',
      layout: 'auto', compute: { module: skyShader, entryPoint: 'csSky' }
    });
    this.irradiancePipeline = await d.createComputePipelineAsync({
      label: 'Cosine-weighted diffuse irradiance',
      layout: 'auto', compute: { module: prefilterShader, entryPoint: 'csIrradiance' }
    });
    this.specularPipeline = await d.createComputePipelineAsync({
      label: 'GGX reflection prefilter',
      layout: 'auto', compute: { module: prefilterShader, entryPoint: 'csSpecular' }
    });
    this.brdfPipeline = await d.createComputePipelineAsync({
      label: 'Split-sum BRDF integration',
      layout: 'auto', compute: { module: brdfShader, entryPoint: 'csBRDF' }
    });

    this.skyGroup = d.createBindGroup({
      layout: this.skyPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.skyUniform } },
        { binding: 1, resource: storageCubeView(this.sky) }
      ]
    });

    const prefilterEntries = (size, count, roughness, target, mip, pipeline) => {
      const params = d.createBuffer({
        size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      const values = new ArrayBuffer(16);
      const view = new DataView(values);
      view.setFloat32(0, roughness, true);
      view.setUint32(4, count, true);
      d.queue.writeBuffer(params, 0, values);
      const group = d.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: params } },
          { binding: 1, resource: this.sky.createView({ dimension: 'cube' }) },
          { binding: 2, resource: this.sampler },
          { binding: 3, resource: storageCubeView(target, mip) }
        ]
      });
      return { size, group, params };
    };
    this.irradianceJob = prefilterEntries(
      IRRADIANCE_SIZE, 96, 1, this.irradiance, 0, this.irradiancePipeline
    );
    this.specularJobs = Array.from({ length: SPECULAR_MIPS }, (_, mip) =>
      prefilterEntries(
        SPECULAR_SIZE >> mip, 96, roughnessAtMip(mip),
        this.specular, mip, this.specularPipeline
      ));

    this.brdfGroup = d.createBindGroup({
      layout: this.brdfPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: this.brdf.createView() }]
    });
    // BRDF is sun-independent; generate once.
    const encoder = d.createCommandEncoder();
    const pass = encoder.beginComputePass({ label: 'Integrate environment BRDF once' });
    pass.setPipeline(this.brdfPipeline);
    pass.setBindGroup(0, this.brdfGroup);
    pass.dispatchWorkgroups(Math.ceil(BRDF_SIZE / 8), Math.ceil(BRDF_SIZE / 8));
    pass.end();
    d.queue.submit([encoder.finish()]);
  }
  regenerate(sun) {
    const normalized = normalize(sun);
    if (normalized.length !== 3 || !normalized.every(Number.isFinite) ||
        Math.hypot(...normalized) < 0.5) {
      throw new Error('The sun direction must be a nonzero finite vec3');
    }
    const key = normalized.map(v => v.toFixed(5)).join(',');
    if (this.directionKey === key) return false;
    this.directionKey = key;
    this.device.queue.writeBuffer(this.skyUniform, 0,
      new Float32Array([...normalized, 0, 1, 1, 1, 1]));

    const encoder = this.device.createCommandEncoder({ label: 'Rebuild HDR image-based lighting' });
    const dispatch = (pipeline, group, size) => {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8), 6);
      pass.end();
    };
    dispatch(this.skyPipeline, this.skyGroup, ENV_SIZE);
    dispatch(this.irradiancePipeline, this.irradianceJob.group, IRRADIANCE_SIZE);
    for (const job of this.specularJobs) dispatch(this.specularPipeline, job.group, job.size);
    this.device.queue.submit([encoder.finish()]);
    return true;
  }
  destroy() {
    this.sky.destroy();
    this.irradiance.destroy();
    this.specular.destroy();
    this.brdf.destroy();
    this.skyUniform.destroy();
    this.irradianceJob?.params.destroy();
    for (const job of this.specularJobs ?? []) job.params.destroy();
  }
}
