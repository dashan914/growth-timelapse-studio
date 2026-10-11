import * as THREE from 'three';
import { kelvinToLinearRGB } from './lighting.js';

const managedTextures = new WeakSet();
const reflectionHooks = new WeakSet();
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const round = (value, step) => Math.round(value / step) * step;

/** A small procedural lighting proxy, never a panorama recovered from a photo.
 * Geometry/white-balance changes are quantized for cache reuse; intensity is a
 * cheap material uniform so brightness/grade/animation do not rebuild PMREM.
 */
export function printEnvironmentDescriptor(options = {}, photoName = '') {
  const name = String(photoName).toLowerCase();
  return {
    kind: name.includes('p1s') ? 'p1s' : name.includes('h2c') ? 'h2c' : 'room',
    temperature: round(clamp(finite(options.colorTemperature, 6500), 2000, 12000), 100),
    azimuth: round(finite(options.lightAzimuth, -45), 5),
    elevation: round(clamp(finite(options.lightElevation, 55), 10, 85), 5),
    sky: options.ambientSkyColor || '#e6ebf4',
    ground: options.ambientGroundColor || '#68656a',
    fill: options.fillColor || '#e2eafa',
  };
}

export const printEnvironmentKey = descriptor => JSON.stringify(descriptor);
export const isManagedPrintEnvironmentTexture = texture => managedTextures.has(texture);
export function printReflectionIntensity(options = {}) {
  return clamp(0.12 * finite(options.keyIntensity, 1.3) / 1.3, 0.03, 0.25);
}

export function createPrintEnvironmentScene(descriptor) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0.015, 0.018, 0.023);
  const wallColor = new THREE.Color(descriptor.sky).multiplyScalar(descriptor.kind === 'room' ? 0.16 : 0.07);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20), new THREE.MeshBasicMaterial({ color: wallColor, side: THREE.BackSide, toneMapped: false }));
  scene.add(wall);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshBasicMaterial({ color: new THREE.Color(descriptor.ground).multiplyScalar(0.12), side: THREE.DoubleSide, toneMapped: false }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -9.9; scene.add(floor);
  const azimuth = THREE.MathUtils.degToRad(descriptor.azimuth), elevation = THREE.MathUtils.degToRad(descriptor.elevation);
  const color = new THREE.Color().fromArray(kelvinToLinearRGB(descriptor.temperature)).multiplyScalar(2);
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(descriptor.kind === 'p1s' ? 5 : 6, descriptor.kind === 'p1s' ? 0.65 : 4), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, toneMapped: false }));
  panel.position.set(Math.sin(azimuth) * Math.cos(elevation) * 8, Math.sin(elevation) * 8, Math.cos(azimuth) * Math.cos(elevation) * 8);
  panel.lookAt(0, 0, 0); scene.add(panel);
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(5, 4), new THREE.MeshBasicMaterial({ color: new THREE.Color(descriptor.fill).multiplyScalar(0.45), side: THREE.DoubleSide, toneMapped: false }));
  fill.position.set(-panel.position.x * 0.7, 3, -panel.position.z * 0.7); fill.lookAt(0, 0, 0); scene.add(fill);
  scene.userData.source = 'procedural-lighting-proxy';
  return scene;
}

/** Keep existing hemisphere diffuse light; this additional proxy contributes
 * reflected highlights only, so it cannot wash out every model surface.
 */
export function installPrintReflections(material) {
  if (!material?.isMeshStandardMaterial || reflectionHooks.has(material)) return;
  reflectionHooks.add(material);
  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    const maps = THREE.ShaderChunk.lights_fragment_maps.replace('iblIrradiance += getIBLIrradiance( geometryNormal );', '// Procedural room: specular only; existing hemisphere supplies diffuse.');
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_maps>', maps);
  };
  material.customProgramCacheKey = () => `${previousKey()}|print-specular-environment-v1`;
}

/** Small bounded cache. The injected generator factory enables GPU-free tests. */
export class PrintEnvironmentCache {
  constructor(renderer, { maxEntries = 4, generatorFactory = value => new THREE.PMREMGenerator(value) } = {}) {
    this.renderer = renderer; this.maxEntries = maxEntries; this.generatorFactory = generatorFactory; this.entries = new Map();
  }
  get(descriptor) {
    const key = printEnvironmentKey(descriptor);
    if (this.entries.has(key)) {
      const target = this.entries.get(key); this.entries.delete(key); this.entries.set(key, target); return target.texture;
    }
    this.generator ||= this.generatorFactory(this.renderer);
    const scene = createPrintEnvironmentScene(descriptor);
    let target;
    try { target = this.generator.fromScene(scene, 0.04, 0.1, 40); }
    finally { scene.traverse(node => { node.geometry?.dispose(); for (const material of Array.isArray(node.material) ? node.material : node.material ? [node.material] : []) material.dispose(); }); }
    managedTextures.add(target.texture);
    this.entries.set(key, target);
    while (this.entries.size > this.maxEntries) { const first = this.entries.keys().next().value; this.entries.get(first).dispose(); this.entries.delete(first); }
    return target.texture;
  }
  dispose() { this.entries.forEach(target => target.dispose()); this.entries.clear(); this.generator?.dispose(); }
}
