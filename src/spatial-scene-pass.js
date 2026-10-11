import * as THREE from 'three';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { fixedPixelJitterPattern, pixelJitterProjection } from './spatial-sampling.js';

/** Current-frame spatial integration, before sRGB encoding or depth of field.
 * Analytic extrusion intersections run in a fragment shader; hardware MSAA
 * only samples their proxy quad, so it cannot resolve the actual silhouette.
 * Keep the central scene depth for optics and accumulate NEW jittered color
 * samples on the GPU. No frame history, CPU readback or idle-only replacement.
 */
export class SpatialSceneRenderPass extends RenderPass {
  constructor(scene, camera, { samples = 4 } = {}) {
    super(scene, camera);
    this.samples = samples;
    this.preserveDepth = true;
    this._sampleTarget = null;
    this._sumTarget = null;
    this._copy = new THREE.ShaderMaterial({
      uniforms: { image: { value: null }, weight: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}',
      fragmentShader: 'uniform sampler2D image;uniform float weight;varying vec2 vUv;void main(){gl_FragColor=texture2D(image,vUv)*weight;}',
      depthTest: false, depthWrite: false, toneMapped: false,
      blending: THREE.NoBlending,
      blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
    });
    this._quad = new FullScreenQuad(this._copy);
  }

  _targets(buffer) {
    if (this._sampleTarget?.samples !== buffer.samples) {
      this._sampleTarget?.dispose();
      this._sampleTarget = new THREE.WebGLRenderTarget(buffer.width, buffer.height, {
        type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: true, samples: buffer.samples,
      });
      this._sampleTarget.texture.name = 'PreviewAA.currentSample';
    }
    this._sumTarget ||= new THREE.WebGLRenderTarget(buffer.width, buffer.height, {
      type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
    });
    this._sumTarget.texture.name = 'PreviewAA.currentFrame';
    this.setSize(buffer.width, buffer.height);
  }

  setSize(width, height) {
    this._sampleTarget?.setSize(width, height);
    this._sumTarget?.setSize(width, height);
  }

  render(renderer, writeBuffer, readBuffer) {
    const pattern = this.samples === 1 ? null : fixedPixelJitterPattern(this.samples);
    if (pattern) this._targets(readBuffer);
    const projection = this.camera.projectionMatrix.clone();
    const inverse = this.camera.projectionMatrixInverse.clone();
    const target = renderer.getRenderTarget(), autoClear = renderer.autoClear;
    const shadowAutoUpdate = renderer.shadowMap.autoUpdate;
    const color = renderer.getClearColor(new THREE.Color()).clone(), alpha = renderer.getClearAlpha();
    const override = this.scene.overrideMaterial;
    try {
      renderer.autoClear = false;
      if (this.overrideMaterial !== null) this.scene.overrideMaterial = this.overrideMaterial;
      if (this.clearColor !== null) renderer.setClearColor(this.clearColor, alpha);
      if (this.clearAlpha !== null) renderer.setClearAlpha(this.clearAlpha);
      // Optics need central depth. Unblurred frames can skip this extra scene
      // draw entirely; the four color samples have identical coverage quality.
      if (!pattern || this.preserveDepth) {
        renderer.setRenderTarget(readBuffer);
        if (this.clear) renderer.clear(renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil);
        else if (this.clearDepth) renderer.clearDepth();
        renderer.render(this.scene, this.camera);
        if (!pattern) return;
        renderer.shadowMap.autoUpdate = false;
      }
      const sampleColor = renderer.getClearColor(new THREE.Color()).clone(), sampleAlpha = renderer.getClearAlpha();
      renderer.setRenderTarget(this._sumTarget);
      renderer.setClearColor(0, 0); renderer.clear();
      for (const jitter of pattern) {
        this.camera.projectionMatrix.fromArray(pixelJitterProjection(projection, readBuffer.width, readBuffer.height, jitter));
        this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
        renderer.setRenderTarget(this._sampleTarget);
        renderer.setClearColor(sampleColor, sampleAlpha); renderer.clear();
        renderer.render(this.scene, this.camera);
        renderer.shadowMap.autoUpdate = false;
        renderer.setRenderTarget(this._sumTarget);
        this._copy.blending = THREE.CustomBlending;
        this._copy.uniforms.image.value = this._sampleTarget.texture;
        this._copy.uniforms.weight.value = jitter.weight;
        this._quad.render(renderer);
      }
      renderer.setRenderTarget(readBuffer);
      this._copy.blending = THREE.NoBlending;
      this._copy.uniforms.image.value = this._sumTarget.texture;
      this._copy.uniforms.weight.value = 1;
      this._quad.render(renderer);
    } finally {
      this.camera.projectionMatrix.copy(projection);
      this.camera.projectionMatrixInverse.copy(inverse);
      this.scene.overrideMaterial = override;
      renderer.shadowMap.autoUpdate = shadowAutoUpdate;
      renderer.setClearColor(color, alpha);
      renderer.autoClear = autoClear;
      renderer.setRenderTarget(target);
    }
  }

  dispose() {
    this._sampleTarget?.dispose(); this._sumTarget?.dispose();
    this._copy.dispose(); this._quad.dispose();
    this._sampleTarget = this._sumTarget = null;
  }
}
