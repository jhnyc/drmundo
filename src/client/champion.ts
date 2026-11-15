import * as THREE from 'three';
import type { AnimKey } from '../shared/types.js';
import { gltfLoader, objLoader, scene, textureLoader } from './scene.js';
import { LOL_SCALE } from './state.js';

export interface RigDisplayTarget {
  x: number;
  z: number;
  angle: number;
  anim: AnimKey;
  ghostTimer: number;
  healSpeedTimer: number;
  slowTimer: number;
}

export class MundoChampionRig {
  public slot: number;
  public root: THREE.Group;
  public model: THREE.Group | null = null;
  public pelvisNode: THREE.Object3D | null = null;
  public mixer: THREE.AnimationMixer | null = null;
  public clips = new Map<string, THREE.AnimationClip>();
  public activeAction: THREE.AnimationAction | null = null;
  public currentAnimKey = '';
  public weaponMesh: THREE.Mesh | null = null;
  public weaponHideTimer = 0;

  private shadowDisc: THREE.Mesh;
  private bodyMaterials: THREE.MeshStandardMaterial[] = [];
  private flashTintTimer = 0;
  private healTintTimer = 0;
  private ghostTrailEmitTimer = 0;

  constructor(slot: number) {
    this.slot = slot;
    this.root = new THREE.Group();
    scene.add(this.root);

    const shadowGeo = new THREE.CircleGeometry(52, 32);
    shadowGeo.rotateX(-Math.PI / 2);
    const shadowMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.42,
      depthWrite: false
    });
    this.shadowDisc = new THREE.Mesh(shadowGeo, shadowMat);
    this.shadowDisc.position.y = 1.5;
    this.root.add(this.shadowDisc);

    if (slot === 0) {
      this.root.position.set(-300, 0, -300);
      this.root.rotation.y = Math.PI * 0.25;
    } else {
      this.root.position.set(300, 0, 300);
      this.root.rotation.y = -Math.PI * 0.75;
    }
  }

  public async load(): Promise<void> {
    const gltf = await gltfLoader.loadAsync('/assets/models/drmundo.glb');
    this.model = gltf.scene;
    this.model.scale.setScalar(LOL_SCALE);
    this.model.position.set(0, 0, 0);
    this.pelvisNode =
      this.model.getObjectByName('Pelvis') || this.model.getObjectByName('Root') || null;

    this.model.traverse((child: THREE.Object3D) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        mesh.frustumCulled = false;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        if (mesh.material && !Array.isArray(mesh.material)) {
          const mat = mesh.material.clone() as THREE.MeshStandardMaterial;
          mat.side = THREE.DoubleSide;
          mesh.material = mat;
          const ud = (mat.userData || {}) as { visible?: boolean; hash?: number };
          if (ud.visible === false) {
            mesh.visible = false;
          } else {
            mesh.visible = true;
            this.bodyMaterials.push(mat);
          }
          if (mat.name === 'Weapon' || ud.hash === 1865621569) {
            this.weaponMesh = mesh;
          }
        }
      }
    });

    this.root.add(this.model);

    this.mixer = new THREE.AnimationMixer(this.model);
    for (const clip of gltf.animations) {
      this.clips.set(clip.name, clip);
    }

    this.playAnim('idle');
  }

  public resolveClipName(animKey: string): string {
    switch (animKey) {
      case 'idle':
        return 'DrMundo_Idle01.anm';
      case 'run':
      case 'run_haste':
        return 'DrMundo_Run.anm';
      case 'q_cast':
        return this.clips.has('Spell1_0.anm') ? 'Spell1_0.anm' : 'Spell1';
      case 'death':
        return 'Death';
      case 'taunt':
        return 'Taunt';
      case 'joke':
        return 'Joke';
      case 'dance':
        return 'Dance_Loop';
      case 'laugh':
        return 'Laugh';
      case 'recall':
        return 'Recall';
      default:
        return 'DrMundo_Idle01.anm';
    }
  }

  public playAnim(animKey: string, forceRestart = false): void {
    if (!this.mixer) return;
    if (this.currentAnimKey === animKey && !forceRestart) return;

    const clipName = this.resolveClipName(animKey);
    const clip = this.clips.get(clipName) || this.clips.values().next().value;
    if (!clip) return;

    this.currentAnimKey = animKey;
    const nextAction = this.mixer.clipAction(clip);
    nextAction.reset();

    if (animKey === 'death') {
      nextAction.setLoop(THREE.LoopOnce, 1);
      nextAction.clampWhenFinished = true;
      nextAction.timeScale = 1.0;
    } else if (animKey === 'q_cast') {
      nextAction.setLoop(THREE.LoopOnce, 1);
      nextAction.clampWhenFinished = true;
      nextAction.timeScale = 1.65;
    } else if (animKey === 'run_haste') {
      nextAction.setLoop(THREE.LoopRepeat, Infinity);
      nextAction.timeScale = 1.38;
    } else if (animKey === 'run') {
      nextAction.setLoop(THREE.LoopRepeat, Infinity);
      nextAction.timeScale = 1.12;
    } else {
      nextAction.setLoop(THREE.LoopRepeat, Infinity);
      nextAction.timeScale = 1.0;
    }

    if (this.activeAction && this.activeAction !== nextAction) {
      nextAction.crossFadeFrom(this.activeAction, 0.12, false);
    }
    nextAction.play();
    this.activeAction = nextAction;
  }

  public triggerQThrowVisual(): void {
    this.playAnim('q_cast', true);
    this.weaponHideTimer = 0.55;
  }

  public triggerFlashBlink(toX: number, toZ: number): void {
    this.root.position.x = toX;
    this.root.position.z = toZ;
    this.flashTintTimer = 0.3;
  }

  public triggerHealOverlay(): void {
    this.healTintTimer = 0.55;
  }

  public update(
    dt: number,
    serverPlayer: RigDisplayTarget | null,
    onGhostTrailStep?: (x: number, z: number, facingAngle: number) => void
  ): void {
    if (this.mixer) {
      this.mixer.update(dt);
    }

    if (this.weaponMesh) {
      if (this.weaponHideTimer > 0) {
        this.weaponHideTimer -= dt;
        this.weaponMesh.visible = this.weaponHideTimer > 0.35 || this.weaponHideTimer <= 0;
      } else {
        this.weaponMesh.visible = true;
      }
    }

    if (this.flashTintTimer > 0) this.flashTintTimer = Math.max(0, this.flashTintTimer - dt);
    if (this.healTintTimer > 0) this.healTintTimer = Math.max(0, this.healTintTimer - dt);

    if (!serverPlayer) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;

    const lerpFactor = Math.min(1, dt * 22);
    this.root.position.x += (serverPlayer.x - this.root.position.x) * lerpFactor;
    this.root.position.z += (serverPlayer.z - this.root.position.z) * lerpFactor;

    const diffAngle = Math.atan2(
      Math.sin(serverPlayer.angle - this.root.rotation.y),
      Math.cos(serverPlayer.angle - this.root.rotation.y)
    );
    this.root.rotation.y += diffAngle * Math.min(1, dt * 18);

    if (this.model && this.pelvisNode) {
      this.root.updateMatrixWorld(true);
      const pelvisWorld = new THREE.Vector3();
      this.pelvisNode.getWorldPosition(pelvisWorld);
      const rootLocal = this.root.worldToLocal(pelvisWorld.clone());
      this.model.position.x -= rootLocal.x * 0.85;
      this.model.position.z -= rootLocal.z * 0.85;
    }

    if (this.currentAnimKey === 'q_cast' && this.weaponHideTimer > 0.1) {
      // Let q_cast throw animation play through its release
    } else {
      this.playAnim(serverPlayer.anim || 'idle');
    }

    let emissiveHex = 0x000000;
    let emissiveInt = 0.0;
    let bodyOpacity = 1.0;

    if (this.flashTintTimer > 0) {
      emissiveHex = 0xffaa1d;
      emissiveInt = (this.flashTintTimer / 0.3) * 1.65;
    } else if (this.healTintTimer > 0) {
      emissiveHex = 0x26e658;
      emissiveInt = (this.healTintTimer / 0.55) * 1.15;
    } else if (serverPlayer.ghostTimer > 0) {
      emissiveHex = 0x16a8ff;
      emissiveInt = 0.52 + Math.sin(performance.now() * 0.014) * 0.14;
      bodyOpacity = 0.86;
    } else if (serverPlayer.slowTimer > 0) {
      emissiveHex = 0x5c2d91;
      emissiveInt = 0.32;
    }

    for (const mat of this.bodyMaterials) {
      if (mat.emissive) {
        mat.emissive.setHex(emissiveHex);
        mat.emissiveIntensity = emissiveInt;
      }
      if (bodyOpacity < 0.99) {
        mat.transparent = true;
        mat.opacity = bodyOpacity;
      } else {
        mat.opacity = 1.0;
      }
    }

    if (serverPlayer.ghostTimer > 0) {
      this.ghostTrailEmitTimer -= dt;
      if (this.ghostTrailEmitTimer <= 0) {
        this.ghostTrailEmitTimer = 0.042;
        onGhostTrailStep?.(this.root.position.x, this.root.position.z, this.root.rotation.y);
      }
    } else {
      this.ghostTrailEmitTimer = 0;
    }
  }
}

export const mundoRigs: [MundoChampionRig, MundoChampionRig] = [
  new MundoChampionRig(0),
  new MundoChampionRig(1)
];

export let cleaverTemplateMesh: THREE.Group | null = null;

export async function loadCleaverProjectileTemplate(): Promise<void> {
  const [weaponObj, weaponTex] = await Promise.all([
    objLoader.loadAsync('/assets/models/Weapon.obj'),
    textureLoader.loadAsync('/assets/models/drmundo_base_weapon_tx_cm.png')
  ]);
  weaponTex.colorSpace = THREE.SRGBColorSpace;

  const group = new THREE.Group();
  weaponObj.traverse((child: THREE.Object3D) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      mesh.geometry.center();
      mesh.material = new THREE.MeshStandardMaterial({
        map: weaponTex,
        roughness: 0.3,
        metalness: 0.55,
        emissive: new THREE.Color(0x1b4d2e),
        emissiveIntensity: 0.35,
        side: THREE.DoubleSide
      });
      mesh.castShadow = true;
    }
  });
  weaponObj.scale.setScalar(1.45);
  group.add(weaponObj);

  cleaverTemplateMesh = group;
}
