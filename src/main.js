import { Renderer } from './engine/renderer.js';
import { OrbitCamera } from './engine/camera.js';
import { Scene } from './engine/scene.js';
import { cube, plane, sphere } from './engine/geometry.js';
import { fromYaw, clamp } from './engine/math.js';
import { sunDirectionAtElevation } from './engine/lighting.js';
import { loadGLB } from './engine/gltf.js';

const canvas = document.querySelector('#viewport');
const status = document.querySelector('#status');
const fpsLabel = document.querySelector('#fps');
const exposure = document.querySelector('#exposure');
const exposureValue = document.querySelector('#exposure-value');
const bloom = document.querySelector('#bloom');
const bloomValue = document.querySelector('#bloom-value');
const sun = document.querySelector('#sun');
const sunValue = document.querySelector('#sun-value');
const ao = document.querySelector('#ao');
const gi = document.querySelector('#gi');
const ssr = document.querySelector('#ssr');
const applyControls = scene => {
  scene.exposure = Number(exposure.value);
  scene.bloomStrength = Number(bloom.value);
  scene.sunDirection = sunDirectionAtElevation(Number(sun.value));
  scene.aoStrength = Number(ao.value);
  scene.giStrength = Number(gi.value);
  scene.ssrStrength = Number(ssr.value);
};

const setStatus = message => { status.textContent = message; };
function demoScene(renderer) {
  const scene = new Scene();
  scene.add(renderer.geometry(plane(60)), {
    baseColor: [0.37, 0.41, 0.46, 1], metallic: 0.05, roughness: 0.87
  }, { position: [0, -0.02, 0] });

  const ball = renderer.geometry(sphere(0.88, 64, 40));
  const block = renderer.geometry(cube(1));
  const materials = [
    { baseColor: [0.72, 0.75, 0.78, 1], metallic: 1, roughness: 0.12 },
    { baseColor: [0.95, 0.57, 0.25, 1], metallic: 1, roughness: 0.23 },
    { baseColor: [0.92, 0.34, 0.21, 1], metallic: 0.05, roughness: 0.37 },
    { baseColor: [0.16, 0.48, 0.86, 1], metallic: 0.65, roughness: 0.48 },
    { baseColor: [0.78, 0.82, 0.88, 1], metallic: 0.15, roughness: 0.78 }
  ];
  for (let i = 0; i < materials.length; i++) {
    const x = (i - 2) * 2.45;
    scene.add(block, {
      baseColor: [0.065, 0.075, 0.095, 1], metallic: 0.35, roughness: 0.52
    }, { position: [x, 0.12, 0], scale: [2, 0.24, 2] });
    scene.add(ball, materials[i], { position: [x, 1.13, 0] });
  }
  const sculpture = scene.add(block, {
    baseColor: [0.52, 0.79, 0.84, 1], metallic: 0.86, roughness: 0.2
  }, { position: [0, 2.7, -3.8], scale: [0.8, 0.8, 0.8] });
  const lamps = [
    scene.addPointLight({
      position: [-4.2, 3.0, 2.0], color: [1.0, 0.20, 0.09], intensity: 52, range: 9
    }),
    scene.addPointLight({
      position: [3.8, 2.5, 1.5], color: [0.08, 0.42, 1.0], intensity: 60, range: 9
    }),
    scene.addPointLight({
      position: [0.0, 3.5, -4.1], color: [0.27, 1.0, 0.48], intensity: 35, range: 6
    })
  ];
  return { scene, sculpture, lamps };
}

async function start() {
  const renderer = await Renderer.create(canvas);
  const camera = new OrbitCamera(canvas);
  let demo = demoScene(renderer);
  let scene = demo.scene;
  let sculpture = demo.sculpture;
  let lamps = demo.lamps;
  let lastTime = performance.now(), count = 0, accumulator = 0;
  setStatus('GPU готов · 16 point lights + SSR + AO/GI · HDRI/CSM сохранены');

  renderer.device.lost.then(info => {
    setStatus('GPU-устройство потеряно: ' + info.message + ' · Перезагрузите страницу');
  });

  const resetDemo = () => {
    demo = demoScene(renderer);
    scene = demo.scene;
    sculpture = demo.sculpture;
    lamps = demo.lamps;
    camera.target = [0, 0.8, 0];
    camera.yaw = 0.55;
    camera.pitch = 0.35;
    camera.distance = 12;
    applyControls(scene);
    setStatus('Демо-сцена восстановлена');
  };
  document.querySelector('#demo').addEventListener('click', resetDemo);
  const loadModel = async file => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.glb')) {
      setStatus('Поддерживается локальный формат .glb (glTF 2.0)');
      return;
    }
    setStatus('Загрузка ' + file.name + '…');
    try {
      const imported = new Scene();
      const result = await loadGLB(file, renderer, imported);
      scene = imported;
      sculpture = null;
      lamps = [];
      applyControls(scene);
      camera.target = result.center;
      camera.distance = clamp(result.recommendedDistance, 1.5, 80);
      setStatus(file.name + ' · объектов: ' + result.count + ' · PBR');
    } catch (error) {
      console.error(error);
      setStatus('Ошибка модели: ' + error.message);
    }
  };
  const hdriPicker = document.querySelector('#hdri');
  const loadHDRI = async file => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.hdr')) {
      setStatus('Поддерживаются Radiance RGBE-файлы формата .hdr');
      return;
    }
    setStatus('Загрузка HDRI ' + file.name + '…');
    try {
      const { width, height } = await renderer.environment.loadHDRI(file);
      setStatus('HDRI: ' + file.name + ' (' + width + '×' + height + ') · GGX IBL готов');
    } catch (error) {
      console.error(error);
      setStatus('Ошибка HDRI: ' + error.message);
    }
  };
  hdriPicker.addEventListener('change', () => {
    void loadHDRI(hdriPicker.files?.[0]);
    hdriPicker.value = '';
  });
  document.querySelector('#reset-hdri').addEventListener('click', () => {
    renderer.environment.useProcedural(scene.sunDirection);
    setStatus('Процедурное HDR-небо восстановлено');
  });

  const picker = document.querySelector('#model');
  picker.addEventListener('change', () => {
    void loadModel(picker.files?.[0]);
    picker.value = '';
  });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file?.name.toLowerCase().endsWith('.hdr')) {
      void loadHDRI(file);
    } else {
      void loadModel(file);
    }
  });
  exposure.addEventListener('input', () => {
    exposureValue.textContent = Number(exposure.value).toFixed(2);
    scene.exposure = Number(exposure.value);
  });
  bloom.addEventListener('input', () => {
    bloomValue.textContent = Number(bloom.value).toFixed(2);
    scene.bloomStrength = Number(bloom.value);
  });
  for (const [control, prop] of [
    [ao, 'aoStrength'],
    [gi, 'giStrength'],
    [ssr, 'ssrStrength']
  ]) {
    const output = document.querySelector('#' + control.id + '-value');
    control.addEventListener('input', () => {
      scene[prop] = Number(control.value);
      output.textContent = Number(control.value).toFixed(2);
    });
  }
  sun.addEventListener('input', () => {
    sunValue.textContent = sun.value + '°';
  });
  // Rebuilding irradiance/specular maps is expensive: update on slider release.
  sun.addEventListener('change', () => {
    scene.sunDirection = sunDirectionAtElevation(Number(sun.value));
    setStatus(renderer.environment.mode === 'hdri'
      ? 'Направление солнца обновлено для теней · HDRI сохранено'
      : 'Процедурное небо и IBL обновлены · солнце ' + sun.value + '°');
  });

  function frame(time) {
    const dt = Math.min((time - lastTime) / 1000, 0.05);
    lastTime = time;
    try {
      camera.update(dt);
      if (sculpture) sculpture.rotation = fromYaw(time * 0.00035);
      if (lamps.length) {
        const t = time * 0.0006;
        lamps[0].position[0] = -4.2 + Math.sin(t) * 0.6;
        lamps[1].position[2] = 1.5 + Math.cos(t * 0.75) * 0.9;
        lamps[2].position[1] = 3.5 + Math.sin(t * 0.8) * 0.4;
      }
      renderer.render(scene, camera);
    } catch (error) {
      console.error(error);
      setStatus('Ошибка рендеринга: ' + error.message);
      return;
    }
    count++;
    accumulator += dt;
    if (accumulator >= 0.8) {
      fpsLabel.textContent = Math.round(count / accumulator) + ' FPS';
      count = 0;
      accumulator = 0;
    }
    requestAnimationFrame(frame);
  }
  resetDemo();
  requestAnimationFrame(frame);
}
start().catch(error => {
  console.error(error);
  setStatus('Не удалось запустить движок: ' + error.message);
});
