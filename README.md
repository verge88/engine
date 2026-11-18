# Engine — собственный WebGPU 3D-движок

Прототип второй итерации независимого **3D-рендерера** на JavaScript и WebGPU. Геометрия, трансформации, управление камерой, загрузчик glTF и WGSL-шейдеры реализованы в этом репозитории **без Three.js, Babylon.js и других игровых движков**.

> **Статус: прототип v0.2, не готовый AAA-фотореалистичный движок.** Добавлены физически мотивированные отражения от процедурного HDR-окружения, свёртка diffuse/specular IBL и bloom. Настоящий фотореализм требует HDRI-ассетов, локального освещения, глобального освещения и игровых систем.

## Запуск

Нужен **Node.js 20+** и современный браузер с WebGPU (Chrome/Edge; для других браузеров поддержка зависит от платформы). Для WebGPU требуется защищённый контекст: localhost или HTTPS.

~~~bash
git clone https://github.com/verge88/engine.git
cd engine
npm run dev
~~~

Откройте **http://localhost:5173**. Зависимости npm не требуются.

- **ЛКМ + движение мыши** — вращение вокруг точки интереса.
- **Колесо мыши** — приближение/отдаление.
- **WASD / Space / Shift** — перемещение камеры.
- **Открыть модель .glb** или drag-and-drop — загрузка статической glTF 2.0-модели с PBR-материалами.
- **Экспозиция** — управление HDR tone mapping.
- **Bloom** — яркость светового ореола (0 полностью отключает эффект и дополнительные проходы).
- **Солнце** — высота солнца от 5° до 80°; после отпускания ползунка GPU пересчитывает небо и IBL.
- **Демо-сцена** — возврат к образцам материалов.

## Что реализовано

| Система | Первая реализация |
| --- | --- |
| Графический API | WebGPU, WGSL, собственный render loop |
| Геометрия | Vertex/index GPU buffers, куб, плоскость, UV-сфера |
| Сцена | Объекты, TRS/матрицы, произвольные масштабы, несколько мешей |
| Камера | Perspective, orbit/fly-pan, ограничение delta time |
| Материалы | Metallic-roughness PBR: Cook–Torrance/GGX/Schlick-Smith, baseColor, roughness, metallic |
| Текстуры | sRGB base color; linear normal и metallic-roughness; normal mapping через производные |
| Свет | Направленный солнечный свет + IBL из процедурного HDR-неба (cosine irradiance, GGX prefilter, BRDF LUT) |
| Тени | Depth shadow map 2048×2048 с 3×3 PCF |
| HDR | Linear rgba16float, камера-ориентированное кубическое небо, двухпроходный Gaussian bloom, ACES-подобный tone mapping, sRGB |
| Загрузка | GLB и по URL glTF 2.0, иерархия узлов, interleaved buffers, статические triangle meshes |
| Инструменты | Локальный HTTP dev server, встроенные Node.js-тесты, GitHub Actions CI |

### Пример API

~~~js
import { Renderer } from './src/engine/renderer.js';
import { Scene } from './src/engine/scene.js';
import { sphere } from './src/engine/geometry.js';

const renderer = await Renderer.create(document.querySelector('canvas'));
const scene = new Scene();
scene.add(renderer.geometry(sphere(1)), {
  baseColor: [0.9, 0.65, 0.25, 1],
  metallic: 1,
  roughness: 0.2
}, { position: [0, 1, 0] });
// В цикле приложения: renderer.render(scene, camera)
~~~

## Второй этап — GPU-окружение и качество кадра

- **Процедурная кубическая HDR-карта:** вычислительный шейдер генерирует небо размером 256² × 6 граней с солнечным диском и атмосферным градиентом в линейном HDR-пространстве.
- **Рассеянный IBL:** свёртка окружения методом cosine-weighted importance sampling в 32² × 6 irradiance cube.
- **Зеркальный IBL:** предфильтрация окружения по GGX в кубическую карту 128² с 6 mip-уровнями; шероховатость выбирает mip.
- **BRDF LUT:** одноразовая GPU-интеграция split-sum уравнения (128²).
- **Sky/background:** пиксельные лучи строятся из ориентации камеры, поэтому окружение корректно вращается с камерой.
- **Bloom:** half-resolution яркостная выборка + horizontal/vertical Gaussian blur до тональной компрессии. Включает яркий солнечный диск, находящийся в фоне.
- **Динамика:** изменение угла солнца пересобирает sky/irradiance/prefilter GPU-текстуры; BRDF LUT не пересчитывается.

Весь рендеринг работает через WebGPU/WGSL и не использует сторонние 3D-движки. Генерация prefilter/irradiance нагружает GPU только при запуске и после изменений солнца.

## Ограничения текущей версии

- **Не фотореализм production-уровня**: сейчас окружение процедурное, а не загружаемый HDRI-файл. Отражения — только от неба, без самих объектов сцены. Нет локальных reflection probes, многократного GI, ray tracing, TAA, SSR, SSAO и объёмного освещения.
- glTF 2.0: только **статические TRIANGLES**. Нет skinning, morph targets, анимаций, sparse accessors, Draco/Meshopt, KTX2, alpha blending/masking, transmission и иных расширений.
- Открытие с диска поддерживает **самодостаточные .glb**. Для .gltf с внешними файлами используйте программный loadGLTF(url, renderer, scene) и HTTP-сервер.
- Текстурные UV-трансформации и режимы семплеров glTF пока не учитываются. Отдельная AO-карта не подключается, если не упакована в R-канал metallic/roughness-текстуры.
- Тени покрывают фиксированную область около цели камеры; на больших сценах необходимы cascaded shadow maps.
- Объекты и GPU-ресурсы пока не имеют полного управления временем жизни, ECS и сериализации.

## Тестирование

~~~bash
npm test
npm run check
~~~

Тесты проверяют матрицы, нормали, геометрию, GLB-парсер, декодирование accessor, направление солнца, базис камеры, layout uniform-данных для post и mip-уровни GGX. **GPU-компиляция WGSL и визуальные WebGPU-скриншот-тесты пока не входят в CI**; для проверки освещения необходим совместимый GPU и браузер.

## План развития до фотореализма

1. **Рендеринг:** загрузка настоящих HDRI, sky atmosphere with scattering, reflection probes, cascaded shadows, clustered lights. (Процедурные cubemaps/IBL/BRDF LUT готовы.)
2. **Материалы:** glTF material extensions, clearcoat, transmission, anisotropy, нормальные tangent frames/MikkTSpace.
3. **Освещение:** screen-space AO/reflections, volumetrics, GI (probes/SSGI), позже hardware ray tracing там, где доступно.
4. **Качество кадра:** TAA/temporal upscaling, multi-scale bloom, auto-exposure, color grading, anti-aliasing. (Базовый Gaussian bloom уже добавлен.)
5. **Игровые системы:** ECS, сцены/префабы, анимации/скелеты, физика, звук, ввод, скрипты, редактор.
6. **Производительность:** frustum/occlusion culling, instancing, LOD, потоковая загрузка, GPU-профилирование.

### Структура

~~~text
src/
  engine/
    math.js        — 3D-математика
    camera.js      — камера и управление
    geometry.js    — генераторы мешей
    scene.js       — сцена и объекты
    gltf.js        — GLB/glTF 2.0 загрузчик
    renderer.js    — WebGPU рендер-проходы и ресурсы
    environment.js — GPU IBL генерация и управление HDR cubemap
    lighting.js    — направление солнца, базис камеры, uniform layout
    sky.wgsl       — процедурное HDR-небо
    prefilter.wgsl — diffuse irradiance + specular GGX convolution
    brdf.wgsl      — split-sum LUT
    pbr.wgsl       — PBR + shadow map + IBL
    bloom.wgsl     — bright-pass + Gaussian blur
    post.wgsl      — HDR sky + bloom + tonemapping
  main.js          — демо-приложение
  style.css        — интерфейс
scripts/serve.mjs  — локальный статический сервер
tests/             — Node.js-тесты
~~~

Реализация рассчитана на постепенное расширение, а не на подмену готового графического движка готовой библиотекой.
