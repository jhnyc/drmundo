import * as THREE from 'three';
import { DEFAULT_CHAMPION_ID, getChampionConfig } from '../shared/champions/index.js';
import type {
  ChampionConfig,
  GroundZoneVisualConfig,
  ProjectileVisualConfig
} from '../shared/champions/types.js';
import type { AnimKey, ChampionId } from '../shared/types.js';
import { gltfLoader, objLoader, scene, textureLoader } from './scene.js';

const _pelvisWorld = new THREE.Vector3();

export interface RigDisplayTarget {
  championId?: ChampionId;
  x: number;
  z: number;
  angle: number;
  anim: AnimKey;
  ghostTimer: number;
  healSpeedTimer: number;
  slowTimer: number;
  knockupTimer?: number;
  knockupDuration?: number;
}

type TintableMaterial = THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;

export class ChampionRig {
  public slot: number;
  public root: THREE.Group;
  public championId: ChampionId | null = null;
  public config: ChampionConfig;
  public model: THREE.Group | null = null;
  public pelvisNode: THREE.Object3D | null = null;
  public mixer: THREE.AnimationMixer | null = null;
  public clips = new Map<string, THREE.AnimationClip>();
  public activeAction: THREE.AnimationAction | null = null;
  public currentAnimKey: AnimKey | '' = '';
  public castHiddenMesh: THREE.Mesh | null = null;
  public castHoldTimer = 0;

  private loadToken = 0;
  private shadowDisc: THREE.Mesh;
  private bodyMaterials: TintableMaterial[] = [];
  private flashTintTimer = 0;
  private healTintTimer = 0;
  private ghostTrailEmitTimer = 0;
  private lastTintHex = -1;
  private lastEmissiveInt = -1;
  private lastBodyOpacity = -1;

  constructor(slot: number, initialChampionId: ChampionId = DEFAULT_CHAMPION_ID) {
    this.slot = slot;
    this.config = getChampionConfig(initialChampionId);
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

  private clearCurrentModel(): void {
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer = null;
    }
    this.clips.clear();
    this.activeAction = null;
    this.currentAnimKey = '';
    this.pelvisNode = null;
    this.castHiddenMesh = null;
    this.bodyMaterials = [];
    this.lastTintHex = -1;
    this.lastEmissiveInt = -1;
    this.lastBodyOpacity = -1;

    if (this.model) {
      this.root.remove(this.model);
      this.model = null;
    }
  }

  public async load(championId: ChampionId = this.config.id): Promise<void> {
    if (this.championId === championId && this.model) return;
    const token = ++this.loadToken;
    this.championId = championId;
    this.config = getChampionConfig(championId);

    const modelCfg = this.config.model;
    const shadowScale = Math.max(0.8, this.config.stats.hitboxRadius / 65);
    this.shadowDisc.scale.setScalar(shadowScale);

    const gltf = await gltfLoader.loadAsync(modelCfg.url);
    if (token !== this.loadToken) return;

    this.clearCurrentModel();

    this.model = gltf.scene;
    this.model.scale.setScalar(modelCfg.scale);
    this.model.position.set(0, 0, 0);

    for (const boneName of modelCfg.pelvisBones) {
      const node = this.model.getObjectByName(boneName);
      if (node) {
        this.pelvisNode = node;
        break;
      }
    }

    const hideCfg = modelCfg.castMeshHide;
    this.model.traverse((child: THREE.Object3D) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        mesh.frustumCulled = false;
        mesh.castShadow = true;
        mesh.receiveShadow = false;
        if (mesh.material && !Array.isArray(mesh.material)) {
          const mat = mesh.material.clone() as TintableMaterial;
          mat.side = THREE.DoubleSide;
          mesh.material = mat;
          mesh.receiveShadow = mat.type !== 'MeshBasicMaterial';
          const ud = (mat.userData || {}) as { visible?: boolean; hash?: number };
          if (ud.visible === false) {
            mesh.visible = false;
          } else {
            mesh.visible = true;
            this.bodyMaterials.push(mat);
          }
          if (
            hideCfg &&
            (mat.name === hideCfg.materialName ||
              (hideCfg.materialHash !== undefined && ud.hash === hideCfg.materialHash))
          ) {
            this.castHiddenMesh = mesh;
          }
        }
      }
    });

    this.root.add(this.model);

    this.mixer = new THREE.AnimationMixer(this.model);
    for (const clip of gltf.animations) {
      this.clips.set(clip.name, clip);
    }

    this.playAnim('idle', true);
  }

  public playAnim(animKey: AnimKey, forceRestart = false): void {
    if (!this.mixer) return;
    if (this.currentAnimKey === animKey && !forceRestart) return;

    const clipCfg = this.config.model.clips[animKey] || this.config.model.clips.idle;
    const clip =
      this.clips.get(clipCfg.clipName) ||
      (clipCfg.fallbackClipName ? this.clips.get(clipCfg.fallbackClipName) : undefined) ||
      this.clips.values().next().value;
    if (!clip) return;

    this.currentAnimKey = animKey;
    const nextAction = this.mixer.clipAction(clip);
    nextAction.reset();

    if (clipCfg.loop === 'once') {
      nextAction.setLoop(THREE.LoopOnce, 1);
      nextAction.clampWhenFinished = Boolean(clipCfg.clampWhenFinished ?? true);
    } else {
      nextAction.setLoop(THREE.LoopRepeat, Infinity);
    }
    nextAction.timeScale = clipCfg.timeScale ?? 1.0;

    if (this.activeAction && this.activeAction !== nextAction) {
      nextAction.crossFadeFrom(this.activeAction, 0.12, false);
    }
    nextAction.play();
    this.activeAction = nextAction;
  }

  public triggerCastVisual(): void {
    this.playAnim('q_cast', true);
    if (this.config.model.castMeshHide) {
      this.castHoldTimer = this.config.model.castMeshHide.totalDuration;
    } else {
      this.castHoldTimer = this.config.model.castAnimDuration ?? Math.max(0.45, this.config.q.castTime);
    }
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
    if (serverPlayer?.championId && serverPlayer.championId !== this.championId) {
      void this.load(serverPlayer.championId);
    }

    if (this.mixer) {
      this.mixer.update(dt);
    }

    const hideCfg = this.config.model.castMeshHide;
    if (this.castHoldTimer > 0) {
      this.castHoldTimer = Math.max(0, this.castHoldTimer - dt);
    }

    if (this.castHiddenMesh && hideCfg) {
      if (this.castHoldTimer > 0) {
        this.castHiddenMesh.visible = this.castHoldTimer > hideCfg.visibleBeforeRemaining;
      } else {
        this.castHiddenMesh.visible = true;
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
      this.pelvisNode.getWorldPosition(_pelvisWorld);
      this.root.worldToLocal(_pelvisWorld);
      const factor = this.config.model.pelvisRootMotionFactor;
      this.model.position.x -= _pelvisWorld.x * factor;
      this.model.position.z -= _pelvisWorld.z * factor;
    }

    // Airborne knockup arc (applies cleanly to any GLB champion)
    const knockupTimer = serverPlayer.knockupTimer ?? 0;
    const knockupDuration = serverPlayer.knockupDuration ?? 0;
    const baseShadowScale = Math.max(0.8, this.config.stats.hitboxRadius / 65);
    if (this.model) {
      if (knockupTimer > 0 && knockupDuration > 0) {
        const progress = Math.max(0, Math.min(1, 1 - knockupTimer / knockupDuration));
        const arcY = Math.sin(progress * Math.PI) * 155;
        this.model.position.y = arcY;
        this.shadowDisc.scale.setScalar(baseShadowScale * (1 - 0.35 * Math.sin(progress * Math.PI)));
      } else {
        this.model.position.y = 0;
        this.shadowDisc.scale.setScalar(baseShadowScale);
      }
    }

    const lockRemaining = hideCfg ? hideCfg.lockAnimUntilRemaining : 0.05;
    if (this.currentAnimKey === 'q_cast' && this.castHoldTimer > lockRemaining) {
      // Allow cast animation to play through release
    } else {
      this.playAnim(serverPlayer.anim || 'idle');
    }

    let emissiveHex = 0x000000;
    let colorHex = 0xffffff;
    let emissiveInt = 0.0;
    let bodyOpacity = 1.0;

    if (this.flashTintTimer > 0) {
      emissiveHex = 0xffaa1d;
      colorHex = 0xfff0b5;
      emissiveInt = (this.flashTintTimer / 0.3) * 1.65;
    } else if (this.healTintTimer > 0) {
      emissiveHex = 0x26e658;
      colorHex = 0xc2ffd2;
      emissiveInt = (this.healTintTimer / 0.55) * 1.15;
    } else if (serverPlayer.ghostTimer > 0) {
      emissiveHex = 0x16a8ff;
      colorHex = 0xd4f0ff;
      emissiveInt = 0.52 + Math.sin(performance.now() * 0.014) * 0.14;
      bodyOpacity = 0.86;
    } else if (serverPlayer.slowTimer > 0) {
      emissiveHex = 0x5c2d91;
      colorHex = 0xdcc4ff;
      emissiveInt = 0.32;
    }

    const tintKey = emissiveHex ^ (colorHex << 1);
    if (
      tintKey !== this.lastTintHex ||
      Math.abs(emissiveInt - this.lastEmissiveInt) > 0.005 ||
      bodyOpacity !== this.lastBodyOpacity
    ) {
      this.lastTintHex = tintKey;
      this.lastEmissiveInt = emissiveInt;
      this.lastBodyOpacity = bodyOpacity;
      for (const mat of this.bodyMaterials) {
        if ('emissive' in mat && mat.emissive) {
          mat.emissive.setHex(emissiveHex);
          mat.emissiveIntensity = emissiveInt;
        } else {
          mat.color.setHex(colorHex);
        }
        if (bodyOpacity < 0.99) {
          mat.transparent = true;
          mat.opacity = bodyOpacity;
        } else {
          mat.transparent = false;
          mat.opacity = 1.0;
        }
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

export const championRigs: [ChampionRig, ChampionRig] = [
  new ChampionRig(0, DEFAULT_CHAMPION_ID),
  new ChampionRig(1, DEFAULT_CHAMPION_ID)
];

const projectileTemplateCache = new Map<string, THREE.Group>();
const projectileLoadingPromises = new Map<string, Promise<THREE.Group | null>>();

export function getCachedProjectileTemplate(championId: ChampionId): THREE.Group | null {
  const champ = getChampionConfig(championId);
  if (champ.q.archetype !== 'linear_projectile') return null;
  if (champ.q.projectileVisual.kind !== 'obj_model') return null;

  const key = `${champ.q.projectileVisual.objUrl}|${champ.q.projectileVisual.textureUrl}`;
  const cached = projectileTemplateCache.get(key);
  if (!cached) {
    void loadProjectileTemplate(champ.q.projectileVisual);
    return null;
  }
  return cached;
}

export async function loadProjectileTemplate(visual: ProjectileVisualConfig): Promise<THREE.Group | null> {
  if (visual.kind !== 'obj_model') return null;
  const key = `${visual.objUrl}|${visual.textureUrl}`;
  const existing = projectileTemplateCache.get(key);
  if (existing) return existing;

  const inflight = projectileLoadingPromises.get(key);
  if (inflight) return inflight;

  const promise = (async (): Promise<THREE.Group | null> => {
    try {
      const [weaponObj, weaponTex] = await Promise.all([
        objLoader.loadAsync(visual.objUrl),
        textureLoader.loadAsync(visual.textureUrl)
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
            emissive: new THREE.Color(visual.emissiveHex),
            emissiveIntensity: visual.emissiveIntensity,
            side: THREE.DoubleSide
          });
          mesh.castShadow = true;
        }
      });
      weaponObj.scale.setScalar(visual.scale);
      group.add(weaponObj);
      projectileTemplateCache.set(key, group);
      return group;
    } catch {
      return null;
    } finally {
      projectileLoadingPromises.delete(key);
    }
  })();

  projectileLoadingPromises.set(key, promise);
  return promise;
}

const zoneMeshTemplateCache = new Map<string, THREE.Group>();
const zoneMeshLoadingPromises = new Map<string, Promise<THREE.Group | null>>();

export function getCachedZoneMeshTemplate(championId: ChampionId): THREE.Group | null {
  const champ = getChampionConfig(championId);
  if (champ.q.archetype !== 'delayed_ground_aoe') return null;
  const vis = champ.q.zoneVisual;
  if (!vis.meshUrl || !vis.meshTextureUrl) return null;

  const key = `${vis.meshUrl}|${vis.meshTextureUrl}`;
  const cached = zoneMeshTemplateCache.get(key);
  if (!cached) {
    void loadZoneMeshTemplate(vis);
    return null;
  }
  return cached;
}

export async function loadZoneMeshTemplate(vis: GroundZoneVisualConfig): Promise<THREE.Group | null> {
  if (!vis.meshUrl || !vis.meshTextureUrl) return null;
  const key = `${vis.meshUrl}|${vis.meshTextureUrl}`;
  const existing = zoneMeshTemplateCache.get(key);
  if (existing) return existing;

  const inflight = zoneMeshLoadingPromises.get(key);
  if (inflight) return inflight;

  const promise = (async (): Promise<THREE.Group | null> => {
    try {
      const [spikeObj, spikeTex] = await Promise.all([
        objLoader.loadAsync(vis.meshUrl!),
        textureLoader.loadAsync(vis.meshTextureUrl!)
      ]);
      spikeTex.colorSpace = THREE.SRGBColorSpace;

      const group = new THREE.Group();
      spikeObj.traverse((child: THREE.Object3D) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh;
          mesh.material = new THREE.MeshStandardMaterial({
            map: spikeTex,
            color: vis.spikeColorHex,
            emissive: new THREE.Color(vis.eruptColorHex),
            emissiveIntensity: 0.22,
            roughness: 0.45,
            metalness: 0.2,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 1
          });
          mesh.castShadow = true;
          mesh.receiveShadow = true;
        }
      });
      group.add(spikeObj);
      zoneMeshTemplateCache.set(key, group);
      return group;
    } catch {
      return null;
    } finally {
      zoneMeshLoadingPromises.delete(key);
    }
  })();

  zoneMeshLoadingPromises.set(key, promise);
  return promise;
}
