import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { audio } from './audio.js';
import type {
  AnimKey,
  BestOfFormat,
  ClientToServerMessage,
  CooldownMode,
  GameEvent,
  PlayerSnapshot,
  ProjectileSnapshot,
  RoomLobbyPayload,
  RoomState,
  ServerToClientMessage,
  SummonerSpellId
} from '../shared/types.js';

// ============================================================================
// CONSTANTS & GAME CONFIG (1 Three.js World Unit = 1 League of Legends Unit)
// ============================================================================
const LOL_SCALE = 1 / 0.0085; // 117.6470588 — converts Khada 0.0085 scale back to 1:1 LoL units
const PIT_RADIUS = 820;
const Q_RANGE = 1050;
const Q_RADIUS = 60;
const INV_SQRT2 = Math.SQRT1_2;

const SPELL_ICONS: Record<SummonerSpellId, string> = {
  flash: '/assets/icons/summoner_flash.png',
  heal: '/assets/icons/summoner_heal.png',
  ghost: '/assets/icons/summoner_ghost.png'
};

const SPELL_NAMES: Record<SummonerSpellId, string> = {
  flash: 'Flash',
  heal: 'Heal',
  ghost: 'Ghost'
};

// ============================================================================
// CLIENT APPLICATION STATE
// ============================================================================
interface ClientState {
  ws: WebSocket | null;
  connected: boolean;
  roomId: string | null;
  passcode: string;
  mySlot: number;
  mySpells: [SummonerSpellId, SummonerSpellId];
  roomState: RoomState;
  round: number;
  bestOf: BestOfFormat;
  botEnabled: boolean;
  cameraLocked: boolean;
  cameraZoom: number;
  cameraFocus: THREE.Vector3;
  mouseScreen: THREE.Vector2;
  mouseWorld: THREE.Vector3;
  showSkillshotIndicator: boolean;
  serverPlayers: [PlayerSnapshot | null, PlayerSnapshot | null];
  serverProjectiles: ProjectileSnapshot[];
  assetsLoaded: boolean;
}

const state: ClientState = {
  ws: null,
  connected: false,
  roomId: null,
  passcode: '',
  mySlot: 0,
  mySpells: ['flash', 'ghost'],
  roomState: 'lobby',
  round: 1,
  bestOf: 3,
  botEnabled: false,
  cameraLocked: false,
  cameraZoom: 1.0,
  cameraFocus: new THREE.Vector3(0, 0, 0),
  mouseScreen: new THREE.Vector2(0, 0),
  mouseWorld: new THREE.Vector3(0, 0, 0),
  showSkillshotIndicator: false,
  serverPlayers: [null, null],
  serverProjectiles: [],
  assetsLoaded: false
};

// Helper for typed DOM queries
function getEl<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

// ============================================================================
// THREE.JS SCENE, CAMERA & RENDERER SETUP
// ============================================================================
const container = getEl<HTMLDivElement>('game-canvas-container');
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance'
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050b14);
scene.fog = new THREE.FogExp2(0x07101e, 0.00014);

// Authentic League of Legends ~55-degree isometric camera
const camera = new THREE.PerspectiveCamera(
  36,
  window.innerWidth / window.innerHeight,
  30,
  12000
);

function updateCameraTransform(dt = 0.016): void {
  const myPlayer = state.serverPlayers[state.mySlot];
  if (state.cameraLocked && myPlayer && state.roomState === 'playing') {
    const targetX = myPlayer.x * 0.45;
    const targetZ = myPlayer.z * 0.45;
    state.cameraFocus.x += (targetX - state.cameraFocus.x) * Math.min(1, dt * 8);
    state.cameraFocus.z += (targetZ - state.cameraFocus.z) * Math.min(1, dt * 8);
  } else {
    state.cameraFocus.x += (0 - state.cameraFocus.x) * Math.min(1, dt * 5);
    state.cameraFocus.z += (0 - state.cameraFocus.z) * Math.min(1, dt * 5);
  }

  const distY = 2050 * state.cameraZoom;
  const distZ = 1380 * state.cameraZoom;
  camera.position.set(
    state.cameraFocus.x,
    distY,
    state.cameraFocus.z + distZ
  );
  camera.lookAt(state.cameraFocus.x, 0, state.cameraFocus.z - 55);
}
updateCameraTransform();

// Lighting matching Summoner's Rift Baron Pit (cool moonlight + purple Void glow)
const ambientLight = new THREE.AmbientLight(0xd6e4ff, 1.55);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xfff4e0, 1.85);
dirLight.position.set(-700, 1900, 950);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(2048, 2048);
dirLight.shadow.camera.near = 200;
dirLight.shadow.camera.far = 4500;
const dCam = 1350;
dirLight.shadow.camera.left = -dCam;
dirLight.shadow.camera.right = dCam;
dirLight.shadow.camera.top = dCam;
dirLight.shadow.camera.bottom = -dCam;
dirLight.shadow.bias = -0.0005;
scene.add(dirLight);

// Purple Void lighting emanating from Baron Pit fissures & back spawn alcove
const baronVoidLight = new THREE.PointLight(0xb24bf3, 3.2, 1650, 1.4);
baronVoidLight.position.set(420, 180, -420);
scene.add(baronVoidLight);

const riverRimLight = new THREE.PointLight(0x0ac8b9, 1.8, 1500, 1.5);
riverRimLight.position.set(-550, 160, 550);
scene.add(riverRimLight);

// Invisible ground raycast plane at Y = 0
const groundRayPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const raycaster = new THREE.Raycaster();

// ============================================================================
// LOADERS (GLTF + KTX2 + MESHOPT + OBJ + TEXTURE)
// ============================================================================
const textureLoader = new THREE.TextureLoader();
const ktx2Loader = new KTX2Loader()
  .setTranscoderPath('/three/examples/jsm/libs/basis/')
  .detectSupport(renderer);

const gltfLoader = new GLTFLoader();
gltfLoader.setKTX2Loader(ktx2Loader);
gltfLoader.setMeshoptDecoder(MeshoptDecoder);

const objLoader = new OBJLoader();

// ============================================================================
// BUILD AUTHENTIC 3D SUMMONER'S RIFT BARON PIT ENVIRONMENT
// ============================================================================
const arenaGroup = new THREE.Group();
scene.add(arenaGroup);

const wardMixers: THREE.AnimationMixer[] = [];
let voidParticles: THREE.Points | null = null;
let cleaverTemplateMesh: THREE.Group | null = null;

async function buildBaronPitEnvironment(): Promise<void> {
  // 1. Load authentic Summoner's Rift Baron Pit ground texture (2048x2048)
  const groundTex = await textureLoader.loadAsync('/assets/map/baron_pit_ground_clean.png');
  groundTex.colorSpace = THREE.SRGBColorSpace;
  groundTex.anisotropy = renderer.capabilities.getMaxAnisotropy();

  // In baron_pit_ground_clean.png (2048x2048):
  // Circular Baron Pit floor center is at pixel (1210, 790) -> u = 0.5908, v = 0.6143
  // Inner pit radius is ~385px -> 385/2048 = 0.188 of texture width.
  // For world PIT_RADIUS = 820, plane size = 820 / 0.188 = 4360 units.
  const planeSize = 4450;
  const offsetX = -(0.5908 - 0.5) * planeSize; // -404
  const offsetZ = (0.6143 - 0.5) * planeSize;  // +508

  const groundGeo = new THREE.PlaneGeometry(planeSize, planeSize, 160, 160);
  groundGeo.rotateX(-Math.PI / 2);

  // Sculpt 3D elevation on the outer Baron Pit horseshoe cliff walls while keeping
  // the inner Baron Pit floor (r <= 835) and SW river mouth flat at y = 0!
  const posAttr = groundGeo.attributes.position;
  for (let i = 0; i < posAttr.count; i++) {
    const vx = posAttr.getX(i) + offsetX;
    const vz = posAttr.getZ(i) + offsetZ;
    const r = Math.hypot(vx, vz);
    // River entrance is in South-West (-X, +Z -> angle around +3*PI/4 = +2.356 rad)
    const angle = Math.atan2(vz, vx);
    const angleDiffFromRiver = Math.atan2(
      Math.sin(angle - 2.35619),
      Math.cos(angle - 2.35619)
    );
    const absRiverAngle = Math.abs(angleDiffFromRiver);

    // Horseshoe cliff wraps where absRiverAngle > 0.85 rad (~49 degrees)
    let wallFactor = 0;
    if (absRiverAngle > 0.78) {
      wallFactor = Math.min(1, (absRiverAngle - 0.78) / 0.45);
    }

    let y = 0;
    if (r > 830 && wallFactor > 0) {
      const rimT = Math.min(1, (r - 830) / 340);
      const smooth = rimT * rimT * (3 - 2 * rimT);
      y = smooth * 215 * wallFactor;
    }
    posAttr.setXYZ(i, vx, y, vz);
  }
  groundGeo.computeVertexNormals();

  const groundMat = new THREE.MeshStandardMaterial({
    map: groundTex,
    roughness: 0.88,
    metalness: 0.06
  });
  const groundMesh = new THREE.Mesh(groundGeo, groundMat);
  groundMesh.receiveShadow = true;
  arenaGroup.add(groundMesh);

  // 2. Load Official 3D Control Wards (jammerdevice.glb) & Stealth Wards (sightward.obj)
  // placed along the Baron Pit centerline (x + z = 0), just like League of Legends Mundo Dodgeball!
  try {
    const [, sightWardObj, sightWardTex] = await Promise.all([
      gltfLoader.loadAsync('/assets/models/jammerdevice.glb'),
      objLoader.loadAsync('/assets/models/sightward.obj'),
      textureLoader.loadAsync('/assets/models/sightward_tx.png')
    ]);
    sightWardTex.colorSpace = THREE.SRGBColorSpace;

    sightWardObj.traverse((child: THREE.Object3D) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        mesh.material = new THREE.MeshStandardMaterial({
          map: sightWardTex,
          roughness: 0.6,
          metalness: 0.2,
          side: THREE.DoubleSide
        });
        mesh.castShadow = true;
      }
    });

    const wardOffsets = [-640, -425, -215, 0, 215, 425, 640];
    for (let i = 0; i < wardOffsets.length; i++) {
      const t = wardOffsets[i];
      const wx = -t * INV_SQRT2;
      const wz = t * INV_SQRT2;

      if (i % 2 === 0) {
        // Control Ward (jammerdevice.glb)
        const cwGltf = await gltfLoader.loadAsync('/assets/models/jammerdevice.glb');
        const cw = cwGltf.scene;
        cw.scale.setScalar(LOL_SCALE * 0.95);
        cw.position.set(wx, 2, wz);
        cw.rotation.y = Math.PI / 4;
        cw.traverse((ch: THREE.Object3D) => {
          if ((ch as THREE.Mesh).isMesh) {
            const mesh = ch as THREE.Mesh;
            if (!Array.isArray(mesh.material)) {
              mesh.material.side = THREE.DoubleSide;
            }
            mesh.castShadow = true;
            mesh.frustumCulled = false;
          }
        });
        arenaGroup.add(cw);

        if (cwGltf.animations && cwGltf.animations.length > 0) {
          const mixer = new THREE.AnimationMixer(cw);
          const idleClip =
            cwGltf.animations.find((a: THREE.AnimationClip) => a.name.includes('Idle')) ||
            cwGltf.animations[0];
          if (idleClip) mixer.clipAction(idleClip).play();
          wardMixers.push(mixer);
        }
      } else {
        // Stealth Ward (sightward.obj)
        const sw = sightWardObj.clone();
        sw.scale.setScalar(0.85);
        sw.position.set(wx, 2, wz);
        sw.rotation.y = -Math.PI / 4;
        arenaGroup.add(sw);
      }
    }
  } catch (err) {
    console.warn('Ward models load warning:', err);
  }

  // 4. Floating Void Mist Particles inside Baron Pit
  const pCount = 90;
  const pGeo = new THREE.BufferGeometry();
  const pPositions = new Float32Array(pCount * 3);
  for (let i = 0; i < pCount; i++) {
    const r = Math.random() * PIT_RADIUS * 0.95;
    const theta = Math.random() * Math.PI * 2;
    pPositions[i * 3] = Math.cos(theta) * r;
    pPositions[i * 3 + 1] = 10 + Math.random() * 140;
    pPositions[i * 3 + 2] = Math.sin(theta) * r;
  }
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPositions, 3));
  const pMat = new THREE.PointsMaterial({
    color: 0xc26eff,
    size: 16,
    transparent: true,
    opacity: 0.42,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  voidParticles = new THREE.Points(pGeo, pMat);
  arenaGroup.add(voidParticles);
}

// ============================================================================
// OFFICIAL COMMUNITYDRAGON VFX TEXTURES
// ============================================================================
interface VfxTextureBank {
  flashBurst: THREE.Texture | null;
  flashHalo: THREE.Texture | null;
  flashSpark: THREE.Texture | null;
  skybeamGlow: THREE.Texture | null;
  healBolts: THREE.Texture | null;
  healSparkles: THREE.Texture | null;
  healWisps: THREE.Texture | null;
  ghostTrail: THREE.Texture | null;
  hasteShockwave: THREE.Texture | null;
  recallRing: THREE.Texture | null;
}

const vfxTextures: VfxTextureBank = {
  flashBurst: null,
  flashHalo: null,
  flashSpark: null,
  skybeamGlow: null,
  healBolts: null,
  healSparkles: null,
  healWisps: null,
  ghostTrail: null,
  hasteShockwave: null,
  recallRing: null
};

async function loadVfxTextures(): Promise<void> {
  const loadTex = async (url: string): Promise<THREE.Texture | null> => {
    try {
      const t = await textureLoader.loadAsync(url);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    } catch {
      return null;
    }
  };

  const [
    flashBurst,
    flashHalo,
    flashSpark,
    skybeamGlow,
    healBolts,
    healSparkles,
    healWisps,
    ghostTrail,
    hasteShockwave,
    recallRing
  ] = await Promise.all([
    loadTex('/assets/vfx/flash_burst.png'),
    loadTex('/assets/vfx/flash_halo.png'),
    loadTex('/assets/vfx/flash_spark.png'),
    loadTex('/assets/vfx/skybeam_glow.png'),
    loadTex('/assets/vfx/heal_bolts.png'),
    loadTex('/assets/vfx/heal_sparkles.png'),
    loadTex('/assets/vfx/heal_wisps.png'),
    loadTex('/assets/vfx/ghost_trail.png'),
    loadTex('/assets/vfx/haste_shockwave.png'),
    loadTex('/assets/vfx/recall_ring.png')
  ]);

  vfxTextures.flashBurst = flashBurst;
  vfxTextures.flashHalo = flashHalo;
  vfxTextures.flashSpark = flashSpark;
  vfxTextures.skybeamGlow = skybeamGlow;
  vfxTextures.healBolts = healBolts;
  vfxTextures.healSparkles = healSparkles;
  vfxTextures.healWisps = healWisps;
  vfxTextures.ghostTrail = ghostTrail;
  vfxTextures.hasteShockwave = hasteShockwave;
  vfxTextures.recallRing = recallRing;
}

// ============================================================================
// LOAD AUTHENTIC DR. MUNDO 3D RIGS & INFECTED BONESAW (Q) MESH
// ============================================================================
interface RigDisplayTarget {
  x: number;
  z: number;
  angle: number;
  anim: AnimKey;
  ghostTimer: number;
  healSpeedTimer: number;
  slowTimer: number;
}

class MundoChampionRig {
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

    // Soft natural League of Legends drop shadow disc under champion feet
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

    // Set initial spawn position
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
    // Convert Khada 0.0085 world scale back to 1:1 League of Legends units
    this.model.scale.setScalar(LOL_SCALE);
    this.model.position.set(0, 0, 0);
    this.pelvisNode =
      this.model.getObjectByName('Pelvis') || this.model.getObjectByName('Root') || null;

    // Configure submeshes using material.userData.visible from Riot's skin data
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

    // Register all 60 animations from drmundo.glb
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
        // In League of Legends, Ghost uses Dr. Mundo's standard running stride at higher playback speed
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
    // Hide hand weapon briefly after windup while cleaver is flying
    this.weaponHideTimer = 0.55;
  }

  public triggerFlashBlink(toX: number, toZ: number): void {
    // Instant teleport blink (no lerp sliding across the ground!) + golden body flash
    this.root.position.x = toX;
    this.root.position.z = toZ;
    this.flashTintTimer = 0.30;
  }

  public triggerHealOverlay(): void {
    this.healTintTimer = 0.55;
  }

  public update(dt: number, serverPlayer: RigDisplayTarget | null): void {
    if (this.mixer) {
      this.mixer.update(dt);
    }

    if (this.weaponMesh) {
      if (this.weaponHideTimer > 0) {
        this.weaponHideTimer -= dt;
        // Hide cleaver in hand during release frames (0.05s..0.40s into throw)
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

    // Smoothly interpolate position & rotation toward authoritative 60Hz snapshot
    const lerpFactor = Math.min(1, dt * 22);
    this.root.position.x += (serverPlayer.x - this.root.position.x) * lerpFactor;
    this.root.position.z += (serverPlayer.z - this.root.position.z) * lerpFactor;

    // Shortest-angle rotation interpolation
    const diffAngle = Math.atan2(
      Math.sin(serverPlayer.angle - this.root.rotation.y),
      Math.cos(serverPlayer.angle - this.root.rotation.y)
    );
    this.root.rotation.y += diffAngle * Math.min(1, dt * 18);

    // Keep Dr. Mundo's visual mesh centered right over his hitbox
    if (this.model && this.pelvisNode) {
      this.root.updateMatrixWorld(true);
      const pelvisWorld = new THREE.Vector3();
      this.pelvisNode.getWorldPosition(pelvisWorld);
      const rootLocal = this.root.worldToLocal(pelvisWorld.clone());
      this.model.position.x -= rootLocal.x * 0.85;
      this.model.position.z -= rootLocal.z * 0.85;
    }

    // Sync animation state
    if (this.currentAnimKey === 'q_cast' && this.weaponHideTimer > 0.1) {
      // Let q_cast throw animation play through its release
    } else {
      this.playAnim(serverPlayer.anim || 'idle');
    }

    // Update League of Legends champion body shader overlays for Flash, Heal, Ghost, and Slow
    let emissiveHex = 0x000000;
    let emissiveInt = 0.0;
    let bodyOpacity = 1.0;

    if (this.flashTintTimer > 0) {
      // Fiery golden-amber Flash body glow (matching flash_screenshot.png)
      emissiveHex = 0xffaa1d;
      emissiveInt = (this.flashTintTimer / 0.30) * 1.65;
    } else if (this.healTintTimer > 0) {
      // Vibrant emerald-green Heal body glow (matching heal_screenshot.jpg)
      emissiveHex = 0x26e658;
      emissiveInt = (this.healTintTimer / 0.55) * 1.15;
    } else if (serverPlayer.ghostTimer > 0) {
      // Spectral cyan-blue & green Ghost phase glow (matching ghost_example.png)
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

    // Emit continuous League of Legends Ghost wind stream ribbons & green/cyan wisps while Ghost is active!
    if (serverPlayer.ghostTimer > 0) {
      this.ghostTrailEmitTimer -= dt;
      if (this.ghostTrailEmitTimer <= 0) {
        this.ghostTrailEmitTimer = 0.042;
        spawnGhostTrailStep(
          this.root.position.x,
          this.root.position.z,
          this.root.rotation.y
        );
      }
    } else {
      this.ghostTrailEmitTimer = 0;
    }
  }
}

const mundoRigs: [MundoChampionRig, MundoChampionRig] = [
  new MundoChampionRig(0),
  new MundoChampionRig(1)
];

async function loadCleaverProjectileTemplate(): Promise<void> {
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

// ============================================================================
// FLYING INFECTED BONESAW (Q) PROJECTILES & VFX SYSTEM
// ============================================================================
interface ActiveProjectileEntry {
  meshGroup: THREE.Group;
  spinner: THREE.Object3D;
}

interface TransientVfxEntry {
  mesh: THREE.Object3D;
  age: number;
  duration: number;
  update(dt: number): void;
}

const activeProjectileMeshes = new Map<number, ActiveProjectileEntry>();
const transientVfx: TransientVfxEntry[] = [];

function syncProjectiles(dt: number): void {
  const seenIds = new Set<number>();

  for (const proj of state.serverProjectiles) {
    seenIds.add(proj.id);
    let entry = activeProjectileMeshes.get(proj.id);
    if (!entry) {
      const meshGroup = new THREE.Group();
      const spinner: THREE.Object3D = cleaverTemplateMesh
        ? cleaverTemplateMesh.clone()
        : new THREE.Mesh(
            new THREE.BoxGeometry(22, 55, 140),
            new THREE.MeshStandardMaterial({ color: 0xd0e8ff, metalness: 0.8 })
          );
      meshGroup.add(spinner);

      // Team-colored ground shadow/indicator under flying cleaver
      const ringGeo = new THREE.RingGeometry(42, 56, 24);
      ringGeo.rotateX(-Math.PI / 2);
      const ringMat = new THREE.MeshBasicMaterial({
        color: proj.ownerSlot === state.mySlot ? 0x26a9ff : 0xff4254,
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
        depthWrite: false
      });
      const groundRing = new THREE.Mesh(ringGeo, ringMat);
      groundRing.position.y = -62;
      meshGroup.add(groundRing);

      meshGroup.position.set(proj.x, 65, proj.z);
      meshGroup.rotation.y = Math.atan2(proj.dirX, proj.dirZ);
      scene.add(meshGroup);

      entry = { meshGroup, spinner };
      activeProjectileMeshes.set(proj.id, entry);
    } else {
      entry.meshGroup.position.x += (proj.x - entry.meshGroup.position.x) * Math.min(1, dt * 30);
      entry.meshGroup.position.z += (proj.z - entry.meshGroup.position.z) * Math.min(1, dt * 30);
      entry.meshGroup.rotation.y = Math.atan2(proj.dirX, proj.dirZ);
    }

    // Spin the Infected Bonesaw end-over-end in flight!
    entry.spinner.rotation.x += dt * 24;
  }

  for (const [id, entry] of activeProjectileMeshes.entries()) {
    if (!seenIds.has(id)) {
      scene.remove(entry.meshGroup);
      activeProjectileMeshes.delete(id);
    }
  }
}

function spawnRingBurstVfx(
  x: number,
  z: number,
  colorHex: number,
  startR = 20,
  endR = 135,
  duration = 0.42
): void {
  const geo = new THREE.RingGeometry(startR, startR + 18, 36);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: colorHex,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, 6, z);
  scene.add(mesh);

  const scaleRatio = endR / Math.max(1, startR);
  transientVfx.push({
    mesh,
    age: 0,
    duration,
    update() {
      const t = this.age / this.duration;
      const s = 1 + (scaleRatio - 1) * (1 - Math.pow(1 - t, 2));
      this.mesh.scale.setScalar(s);
      mat.opacity = 0.9 * (1 - t);
    }
  });
}

function spawnMoveClickIndicator(x: number, z: number): void {
  spawnRingBurstVfx(x, z, 0x2ecc71, 12, 48, 0.32);
}

function createSkybeamMesh(
  x: number,
  z: number,
  colorHex: number,
  width: number,
  height: number
): { group: THREE.Group; mats: THREE.MeshBasicMaterial[] } {
  const group = new THREE.Group();
  group.position.set(x, 0, z);

  const mats: THREE.MeshBasicMaterial[] = [];
  const angles = [0, Math.PI / 3, (2 * Math.PI) / 3];
  for (const ang of angles) {
    const geo = new THREE.PlaneGeometry(width, height);
    geo.translate(0, height * 0.5, 0);
    const mat = new THREE.MeshBasicMaterial({
      map: vfxTextures.skybeamGlow || undefined,
      color: colorHex,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const plane = new THREE.Mesh(geo, mat);
    plane.rotation.y = ang;
    group.add(plane);
    mats.push(mat);
  }
  return { group, mats };
}

function spawnSparkleParticle(
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  colorHex: number,
  size: number,
  duration: number
): void {
  const mat = new THREE.SpriteMaterial({
    map: vfxTextures.flashSpark || vfxTextures.healSparkles || undefined,
    color: colorHex,
    transparent: true,
    opacity: 1.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const sprite = new THREE.Sprite(mat);
  sprite.position.set(x, y, z);
  sprite.scale.setScalar(size);
  scene.add(sprite);

  transientVfx.push({
    mesh: sprite,
    age: 0,
    duration,
    update(dt: number) {
      const t = this.age / this.duration;
      sprite.position.x += vx * dt;
      sprite.position.y += vy * dt;
      sprite.position.z += vz * dt;
      const pulse = 0.8 + 0.35 * Math.sin(this.age * 28);
      sprite.scale.setScalar(size * (1 - t * 0.55) * pulse);
      mat.opacity = Math.max(0, 1 - Math.pow(t, 1.5));
    }
  });
}

function spawnFlashBurstAtPoint(x: number, z: number, isDestination: boolean): void {
  // 1. Tall, thin golden-white vertical skybeam ray (exact match to flash_screenshot.png)
  const beamWidth = isDestination ? 44 : 38;
  const beamHeight = isDestination ? 560 : 480;
  const { group: beamGroup, mats: beamMats } = createSkybeamMesh(
    x,
    z,
    0xfff088,
    beamWidth,
    beamHeight
  );
  scene.add(beamGroup);

  transientVfx.push({
    mesh: beamGroup,
    age: 0,
    duration: 0.42,
    update() {
      const t = this.age / this.duration;
      const widthScale = Math.max(0.15, 1 - t * 0.75);
      beamGroup.scale.set(widthScale, 1 + t * 0.12, widthScale);
      for (const m of beamMats) {
        m.opacity = 0.95 * Math.pow(1 - t, 1.6);
      }
    }
  });

  // 2. Golden starburst & warm amber ground glow at feet
  const burstGroup = new THREE.Group();
  burstGroup.position.set(x, 4, z);

  const haloGeo = new THREE.PlaneGeometry(185, 185);
  haloGeo.rotateX(-Math.PI / 2);
  const haloMat = new THREE.MeshBasicMaterial({
    map: vfxTextures.flashHalo || vfxTextures.flashBurst || undefined,
    color: 0xffb82e,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  burstGroup.add(new THREE.Mesh(haloGeo, haloMat));

  const starGeo = new THREE.PlaneGeometry(155, 155);
  starGeo.rotateX(-Math.PI / 2);
  const starMat = new THREE.MeshBasicMaterial({
    map: vfxTextures.flashBurst || undefined,
    color: 0xfff59e,
    transparent: true,
    opacity: 0.98,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const starMesh = new THREE.Mesh(starGeo, starMat);
  starMesh.position.y = 2;
  burstGroup.add(starMesh);

  scene.add(burstGroup);

  transientVfx.push({
    mesh: burstGroup,
    age: 0,
    duration: 0.38,
    update() {
      const t = this.age / this.duration;
      const s = 0.75 + 0.85 * (1 - Math.pow(1 - t, 2));
      burstGroup.scale.setScalar(s);
      haloMat.opacity = 0.9 * (1 - t);
      starMat.opacity = 0.98 * Math.pow(1 - t, 1.4);
    }
  });

  // 3. Golden 4-point star sparkles around the burst core
  const sparkCount = 14;
  for (let i = 0; i < sparkCount; i++) {
    const angle = (i / sparkCount) * Math.PI * 2 + Math.random() * 0.4;
    const r = 18 + Math.random() * 68;
    const sx = x + Math.cos(angle) * r;
    const sz = z + Math.sin(angle) * r;
    const sy = 14 + Math.random() * 85;
    const speed = 45 + Math.random() * 95;
    spawnSparkleParticle(
      sx,
      sy,
      sz,
      Math.cos(angle) * speed,
      35 + Math.random() * 75,
      Math.sin(angle) * speed,
      0xffe97d,
      34 + Math.random() * 24,
      0.32 + Math.random() * 0.22
    );
  }
}

function spawnFlashVfx(
  slot: number,
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number
): void {
  // Instantly snap champion rig to destination and apply golden body flash
  const rig = mundoRigs[slot];
  if (rig) {
    rig.triggerFlashBlink(toX, toZ);
  }

  // Spawn origin & destination golden skybeams, ground bursts & star sparkles
  spawnFlashBurstAtPoint(fromX, fromZ, false);
  spawnFlashBurstAtPoint(toX, toZ, true);

  // Trail of golden sparkles connecting origin -> destination (matching flash_screenshot.png)
  const dx = toX - fromX;
  const dz = toZ - fromZ;
  const trailCount = 14;
  for (let i = 0; i < trailCount; i++) {
    const frac = (i + 0.5) / trailCount;
    const jitterX = (Math.random() - 0.5) * 42;
    const jitterZ = (Math.random() - 0.5) * 42;
    const px = fromX + dx * frac + jitterX;
    const pz = fromZ + dz * frac + jitterZ;
    const py = 35 + Math.random() * 95;
    spawnSparkleParticle(
      px,
      py,
      pz,
      (Math.random() - 0.5) * 40,
      25 + Math.random() * 55,
      (Math.random() - 0.5) * 40,
      0xffdf55,
      28 + Math.random() * 18,
      0.28 + frac * 0.22
    );
  }
}

function spawnHealVfx(slot: number, x: number, z: number): void {
  const rig = mundoRigs[slot];
  if (rig) {
    rig.triggerHealOverlay();
  }

  const healGroup = new THREE.Group();
  healGroup.position.set(x, 5, z);

  // 1. Vibrant emerald-green jagged ground starburst (matching heal_screenshot.jpg)
  const burstGeo1 = new THREE.PlaneGeometry(230, 230);
  burstGeo1.rotateX(-Math.PI / 2);
  const burstMat1 = new THREE.MeshBasicMaterial({
    map: vfxTextures.flashBurst || undefined,
    color: 0x2eff5e,
    transparent: true,
    opacity: 0.95,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const burstMesh1 = new THREE.Mesh(burstGeo1, burstMat1);
  healGroup.add(burstMesh1);

  const burstGeo2 = new THREE.PlaneGeometry(210, 210);
  burstGeo2.rotateX(-Math.PI / 2);
  burstGeo2.rotateY(Math.PI / 4);
  const burstMat2 = new THREE.MeshBasicMaterial({
    map: vfxTextures.flashBurst || undefined,
    color: 0x7dffaa,
    transparent: true,
    opacity: 0.88,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const burstMesh2 = new THREE.Mesh(burstGeo2, burstMat2);
  burstMesh2.position.y = 2;
  healGroup.add(burstMesh2);

  // 2. Swirling emerald energy ribbons wrapping around champion's waist/feet
  const boltGeo = new THREE.CylinderGeometry(88, 64, 95, 28, 1, true);
  const boltMat = new THREE.MeshBasicMaterial({
    map: vfxTextures.healBolts || vfxTextures.healWisps || undefined,
    color: 0x39ff7a,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const boltCylinder = new THREE.Mesh(boltGeo, boltMat);
  boltCylinder.position.y = 48;
  healGroup.add(boltCylinder);

  scene.add(healGroup);

  transientVfx.push({
    mesh: healGroup,
    age: 0,
    duration: 0.62,
    update(dt: number) {
      const t = this.age / this.duration;
      const expand = 0.65 + 0.85 * (1 - Math.pow(1 - t, 2.2));
      burstMesh1.scale.setScalar(expand);
      burstMesh2.scale.setScalar(expand * 0.92);
      burstMesh2.rotation.y += dt * 1.8;
      boltCylinder.rotation.y -= dt * 4.5;
      boltCylinder.scale.set(0.85 + t * 0.55, 1 + t * 0.3, 0.85 + t * 0.55);

      const fade = Math.pow(1 - t, 1.4);
      burstMat1.opacity = 0.95 * fade;
      burstMat2.opacity = 0.85 * fade;
      boltMat.opacity = 0.9 * fade;
    }
  });

  // 3. Rising emerald-green & cyan-mint heal sparkles floating up around champion
  for (let i = 0; i < 16; i++) {
    const angle = (i / 16) * Math.PI * 2 + Math.random() * 0.3;
    const r = 24 + Math.random() * 64;
    spawnSparkleParticle(
      x + Math.cos(angle) * r,
      18 + Math.random() * 70,
      z + Math.sin(angle) * r,
      Math.cos(angle) * 28,
      85 + Math.random() * 75,
      Math.sin(angle) * 28,
      i % 3 === 0 ? 0x5effd8 : 0x44ff6e,
      30 + Math.random() * 20,
      0.42 + Math.random() * 0.25
    );
  }
}

function spawnGhostVfx(slot: number, x: number, z: number): void {
  // Initial spectral cyan-blue & green wind shockwave burst around Dr. Mundo's torso
  const group = new THREE.Group();
  group.position.set(x, 65, z);

  const cylGeo = new THREE.CylinderGeometry(82, 54, 125, 24, 1, true);
  const cylMat = new THREE.MeshBasicMaterial({
    map: vfxTextures.hasteShockwave || vfxTextures.ghostTrail || undefined,
    color: 0x22d8ff,
    transparent: true,
    opacity: 0.92,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const shockMesh = new THREE.Mesh(cylGeo, cylMat);
  group.add(shockMesh);

  scene.add(group);

  transientVfx.push({
    mesh: group,
    age: 0,
    duration: 0.45,
    update(dt: number) {
      const t = this.age / this.duration;
      shockMesh.rotation.y += dt * 7.5;
      group.scale.set(0.8 + t * 0.75, 1 + t * 0.25, 0.8 + t * 0.75);
      cylMat.opacity = 0.92 * Math.pow(1 - t, 1.3);
    }
  });
}

function spawnGhostTrailStep(x: number, z: number, facingAngle: number): void {
  // Continuous spectral cyan-blue wind ribbons & emerald-green orb wisps behind champion
  // (exact match to ghost_example.png)
  const backX = -Math.sin(facingAngle);
  const backZ = -Math.cos(facingAngle);
  const sideX = Math.cos(facingAngle);
  const sideZ = -Math.sin(facingAngle);

  // 1. Curved cyan-blue wind stream ribbon trailing from torso/legs
  const ribbonGeo = new THREE.PlaneGeometry(92, 42);
  const ribbonMat = new THREE.MeshBasicMaterial({
    map: vfxTextures.ghostTrail || vfxTextures.hasteShockwave || undefined,
    color: 0x24c8ff,
    transparent: true,
    opacity: 0.68,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const ribbon = new THREE.Mesh(ribbonGeo, ribbonMat);
  const lateralOffset = (Math.random() - 0.5) * 48;
  const heightOffset = 35 + Math.random() * 85;
  ribbon.position.set(
    x + backX * 28 + sideX * lateralOffset,
    heightOffset,
    z + backZ * 28 + sideZ * lateralOffset
  );
  ribbon.rotation.y = facingAngle + Math.PI / 2;
  ribbon.rotation.z = (Math.random() - 0.5) * 0.35;
  scene.add(ribbon);

  transientVfx.push({
    mesh: ribbon,
    age: 0,
    duration: 0.36,
    update(dt: number) {
      const t = this.age / this.duration;
      ribbon.position.x += backX * 95 * dt;
      ribbon.position.z += backZ * 95 * dt;
      ribbon.scale.set(1 + t * 0.45, Math.max(0.2, 1 - t * 0.6), 1);
      ribbonMat.opacity = 0.68 * (1 - t);
    }
  });

  // 2. Trailing toxic-green & cyan-blue spectral wisp orb (visible behind Mundo's canister in ghost_example.png)
  const isGreenOrb = Math.random() < 0.62;
  const orbMat = new THREE.SpriteMaterial({
    map: vfxTextures.flashHalo || vfxTextures.flashSpark || undefined,
    color: isGreenOrb ? 0x22ff68 : 0x1ec8ff,
    transparent: true,
    opacity: 0.72,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const orb = new THREE.Sprite(orbMat);
  const orbLat = (Math.random() - 0.5) * 44;
  orb.position.set(
    x + backX * 36 + sideX * orbLat,
    65 + Math.random() * 65,
    z + backZ * 36 + sideZ * orbLat
  );
  const startScale = isGreenOrb ? 54 : 42;
  orb.scale.setScalar(startScale);
  scene.add(orb);

  transientVfx.push({
    mesh: orb,
    age: 0,
    duration: 0.44,
    update(dt: number) {
      const t = this.age / this.duration;
      orb.position.x += backX * 70 * dt;
      orb.position.y += 18 * dt;
      orb.position.z += backZ * 70 * dt;
      orb.scale.setScalar(startScale * (1 - t * 0.45));
      orbMat.opacity = 0.72 * Math.pow(1 - t, 1.3);
    }
  });
}

function updateTransientVfx(dt: number): void {
  for (let i = transientVfx.length - 1; i >= 0; i--) {
    const vfx = transientVfx[i];
    vfx.age += dt;
    if (vfx.age >= vfx.duration) {
      scene.remove(vfx.mesh);
      transientVfx.splice(i, 1);
    } else {
      vfx.update(dt);
    }
  }
}

// ============================================================================
// SKILLSHOT INDICATOR (HOLD SHIFT+Q OR HOVER Q BUTTON)
// ============================================================================
const indicatorGroup = new THREE.Group();
indicatorGroup.visible = false;
scene.add(indicatorGroup);

const indLineGeo = new THREE.PlaneGeometry(Q_RADIUS * 2, Q_RANGE);
indLineGeo.translate(0, Q_RANGE / 2, 0);
indLineGeo.rotateX(-Math.PI / 2);
const indLineMat = new THREE.MeshBasicMaterial({
  color: 0x0ac8b9,
  transparent: true,
  opacity: 0.32,
  side: THREE.DoubleSide,
  depthWrite: false
});
const indLineMesh = new THREE.Mesh(indLineGeo, indLineMat);
indLineMesh.position.y = 4;
indicatorGroup.add(indLineMesh);

function updateSkillshotIndicator(): void {
  const myPlayer = state.serverPlayers[state.mySlot];
  if (
    !state.showSkillshotIndicator ||
    !myPlayer ||
    !myPlayer.alive ||
    state.roomState !== 'playing'
  ) {
    indicatorGroup.visible = false;
    return;
  }
  indicatorGroup.visible = true;
  indicatorGroup.position.set(myPlayer.x, 0, myPlayer.z);
  const dx = state.mouseWorld.x - myPlayer.x;
  const dz = state.mouseWorld.z - myPlayer.z;
  indicatorGroup.rotation.y = Math.atan2(dx, dz) + Math.PI;
}

// ============================================================================
// FLOATING 3D->2D HEALTH BARS, COMBAT TEXT & IN-GAME HUD
// ============================================================================
const combatTextLayer = getEl<HTMLDivElement>('combat-text-layer');

function worldToScreen(x: number, y: number, z: number): { x: number; y: number } {
  const vec = new THREE.Vector3(x, y, z);
  vec.project(camera);
  return {
    x: (vec.x * 0.5 + 0.5) * window.innerWidth,
    y: (-vec.y * 0.5 + 0.5) * window.innerHeight
  };
}

function spawnFloatingCombatText(x: number, z: number, text: string, cssClass = 'magic-dmg'): void {
  const pos = worldToScreen(x, 195, z);
  const el = document.createElement('div');
  el.className = `floating-combat-text ${cssClass}`;
  el.textContent = text;
  el.style.left = `${pos.x}px`;
  el.style.top = `${pos.y}px`;
  combatTextLayer.appendChild(el);
  setTimeout(() => el.remove(), 1100);
}

function updateFloatingHealthBars(): void {
  const inMatch =
    state.roomState === 'playing' ||
    state.roomState === 'countdown' ||
    state.roomState === 'round_end';

  for (let i = 0; i < 2; i++) {
    const fhb = getEl(`fhb-${i}`);
    const p = state.serverPlayers[i];
    const rig = mundoRigs[i];
    if (!inMatch || !p || !p.alive) {
      fhb.style.display = 'none';
      continue;
    }

    fhb.style.display = 'block';
    fhb.className = `lol-floating-bar ${i === state.mySlot ? 'self' : 'enemy'}`;

    const screenPos = worldToScreen(rig.root.position.x, 225, rig.root.position.z);
    fhb.style.left = `${screenPos.x}px`;
    fhb.style.top = `${screenPos.y}px`;

    getEl(`fhb-name-${i}`).textContent = p.name;
    const pct = Math.max(0, Math.min(100, (p.hp / p.maxHp) * 100));
    getEl(`fhb-fill-${i}`).style.width = `${pct}%`;
    getEl(`fhb-trail-${i}`).style.width = `${pct}%`;

    // Status pills (SLOWED / GHOSTED / HEALED)
    const statusRow = getEl(`fhb-status-${i}`);
    const pills: string[] = [];
    if (p.slowTimer > 0) pills.push('<span class="fhb-status-pill slowed">Slowed</span>');
    if (p.ghostTimer > 0) pills.push('<span class="fhb-status-pill ghosted">Ghosted</span>');
    if (p.healSpeedTimer > 0) pills.push('<span class="fhb-status-pill healed">Healed</span>');
    const html = pills.join('');
    if (statusRow.innerHTML !== html) {
      statusRow.innerHTML = html;
    }
  }
}

function updateInGameHud(): void {
  const p0 = state.serverPlayers[0];
  const p1 = state.serverPlayers[1];
  const me = state.serverPlayers[state.mySlot];

  if (p0) {
    getEl('hud-blue-name').textContent = p0.name;
    getEl('hud-blue-score').textContent = String(p0.score || 0);
    // Update minimap dot 0
    const mx = 50 + (p0.x / PIT_RADIUS) * 20;
    const my = 50 + (p0.z / PIT_RADIUS) * 20;
    const dot0 = getEl('minimap-dot-0');
    dot0.style.left = `${mx}%`;
    dot0.style.top = `${my}%`;
  }
  if (p1) {
    getEl('hud-red-name').textContent = p1.name;
    getEl('hud-red-score').textContent = String(p1.score || 0);
    const mx = 50 + (p1.x / PIT_RADIUS) * 20;
    const my = 50 + (p1.z / PIT_RADIUS) * 20;
    const dot1 = getEl('minimap-dot-1');
    dot1.style.left = `${mx}%`;
    dot1.style.top = `${my}%`;
  }

  getEl('hud-round-label').textContent = `ROUND ${state.round} (BO${state.bestOf})`;

  if (!me) return;

  const thrown = me.stats?.cleaversThrown || 0;
  const hits = me.stats?.cleaversHit || 0;
  const acc = thrown > 0 ? Math.round((hits / thrown) * 100) : 0;
  getEl('hud-accuracy-label').textContent = `Cleaver Acc: ${acc}% (${hits}/${thrown})`;
  getEl('hud-stat-hits').textContent = `${hits}`;

  // Move speed calculation
  let ms = 385;
  if (me.ghostTimer > 0) ms = Math.round(ms * 1.38);
  if (me.healSpeedTimer > 0) ms = Math.round(ms * 1.30);
  if (me.slowTimer > 0) ms = Math.round(ms * 0.60);
  getEl('hud-stat-ms').textContent = `${ms}`;

  // HP Bar
  const hpPct = Math.max(0, Math.min(100, (me.hp / me.maxHp) * 100));
  getEl('hud-hp-bar-fill').style.width = `${hpPct}%`;
  getEl('hud-hp-bar-text').textContent = `${Math.round(me.hp)} / ${me.maxHp}`;
  getEl('hud-hp-regen').textContent = '+16.0';

  // Q Cooldown
  const cdQ = getEl('hud-cd-q');
  if (me.qCd > 0) {
    cdQ.classList.remove('hidden');
    cdQ.textContent = me.qCd.toFixed(1);
  } else {
    cdQ.classList.add('hidden');
  }

  // Summoner Spells D and F icons & cooldowns
  const spD: SummonerSpellId = me.spells?.[0] || 'flash';
  const spF: SummonerSpellId = me.spells?.[1] || 'ghost';
  getEl<HTMLImageElement>('hud-img-d').src = SPELL_ICONS[spD] || SPELL_ICONS.flash;
  getEl<HTMLImageElement>('hud-img-f').src = SPELL_ICONS[spF] || SPELL_ICONS.ghost;

  const cdD = getEl('hud-cd-d');
  if (me.spellCd?.[0] > 0) {
    cdD.classList.remove('hidden');
    cdD.textContent = String(Math.ceil(me.spellCd[0]));
  } else {
    cdD.classList.add('hidden');
  }

  const cdF = getEl('hud-cd-f');
  if (me.spellCd?.[1] > 0) {
    cdF.classList.remove('hidden');
    cdF.textContent = String(Math.ceil(me.spellCd[1]));
  } else {
    cdF.classList.add('hidden');
  }
}

// ============================================================================
// ANNOUNCER BANNER & TOAST NOTIFICATIONS
// ============================================================================
let announcerTimeout: ReturnType<typeof setTimeout> | null = null;
function showAnnouncerBanner(title: string, subtitle = '', durationMs = 2000): void {
  const banner = getEl('announcer-banner');
  getEl('announcer-title').textContent = title;
  getEl('announcer-sub').textContent = subtitle;
  banner.classList.remove('hidden');
  if (announcerTimeout) clearTimeout(announcerTimeout);
  announcerTimeout = setTimeout(() => {
    banner.classList.add('hidden');
  }, durationMs);
}

function showToast(message: string): void {
  const toastContainer = getEl('toast-container');
  const toast = document.createElement('div');
  toast.className = 'hex-toast';
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

// ============================================================================
// SUMMONER SPELL PICKER UI LOGIC (FLASH, HEAL, GHOST ON D & F)
// ============================================================================
function renderSpellPickerUI(
  containerId: string,
  spellsArray: [SummonerSpellId, SummonerSpellId]
): void {
  const containerEl = document.getElementById(containerId);
  if (!containerEl) return;
  const cards = containerEl.querySelectorAll<HTMLElement>('.spell-option-card');
  cards.forEach((card) => {
    const sp = card.getAttribute('data-spell') as SummonerSpellId | null;
    const badge = card.querySelector<HTMLElement>('.spell-key-badge');
    card.classList.remove('selected-d', 'selected-f');
    if (!badge) return;
    if (spellsArray[0] === sp) {
      card.classList.add('selected-d');
      badge.style.display = 'flex';
      badge.textContent = 'D';
    } else if (spellsArray[1] === sp) {
      card.classList.add('selected-f');
      badge.style.display = 'flex';
      badge.textContent = 'F';
    } else {
      badge.style.display = 'none';
    }
  });
}

function bindSpellPickerEvents(containerId: string): void {
  const containerEl = document.getElementById(containerId);
  if (!containerEl) return;
  containerEl.querySelectorAll<HTMLElement>('.spell-option-card').forEach((card) => {
    card.addEventListener('click', () => {
      const clickedSpell = (card.getAttribute('data-spell') || 'flash') as SummonerSpellId;
      if (state.mySpells[0] === clickedSpell || state.mySpells[1] === clickedSpell) {
        // Clicking an already-equipped spell swaps D and F!
        state.mySpells = [state.mySpells[1], state.mySpells[0]];
      } else {
        // Replace F with newly clicked spell (keeping D)
        state.mySpells = [state.mySpells[0], clickedSpell];
      }
      renderSpellPickerUI('home-spell-picker', state.mySpells);
      renderSpellPickerUI('lobby-spell-picker', state.mySpells);
      if (state.roomId) {
        sendWs({ type: 'select_spells', spells: state.mySpells });
      }
    });
  });
}

bindSpellPickerEvents('home-spell-picker');
bindSpellPickerEvents('lobby-spell-picker');

// ============================================================================
// CUSTOM HEXTECH DROPDOWN COMPONENT (NO NATIVE HTML5 SELECT)
// ============================================================================
function getDropdownValue(id: string): string {
  const el = document.getElementById(id);
  return el?.getAttribute('data-value') || '';
}

function initHexDropdowns(): void {
  const dropdowns = document.querySelectorAll<HTMLElement>('.hex-dropdown');

  const closeAllDropdowns = (except?: HTMLElement): void => {
    dropdowns.forEach((dd) => {
      if (dd !== except) {
        dd.classList.remove('open');
        const trig = dd.querySelector<HTMLElement>('.hex-dropdown-trigger');
        if (trig) trig.setAttribute('aria-expanded', 'false');
      }
    });
  };

  dropdowns.forEach((dd) => {
    const trigger = dd.querySelector<HTMLButtonElement>('.hex-dropdown-trigger');
    const label = dd.querySelector<HTMLElement>('.hex-dropdown-label');
    const options = dd.querySelectorAll<HTMLElement>('.hex-dropdown-option');
    if (!trigger || !label) return;

    trigger.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      audio.ensureContext();
      const isOpen = dd.classList.contains('open');
      closeAllDropdowns(dd);
      if (isOpen) {
        dd.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
      } else {
        dd.classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');
      }
    });

    options.forEach((opt) => {
      opt.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        const val = opt.getAttribute('data-value') || '';
        dd.setAttribute('data-value', val);
        label.textContent = opt.textContent || '';
        options.forEach((o) => o.classList.remove('selected'));
        opt.classList.add('selected');
        dd.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
      });
    });
  });

  window.addEventListener('click', () => {
    closeAllDropdowns();
  });

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeAllDropdowns();
    }
  });
}

initHexDropdowns();

// ============================================================================
// WEBSOCKET NETWORKING & ROOM / PASSCODE / SHAREABLE LINK MANAGEMENT
// ============================================================================
function getShareableRoomUrl(includePasscode = true): string {
  const url = new URL(window.location.origin);
  url.searchParams.set('room', state.roomId || '');
  if (includePasscode && state.passcode) {
    url.searchParams.set('pass', state.passcode);
  }
  return url.toString();
}

function sendWs(payload: ClientToServerMessage): void {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload));
  }
}

function connectWebSocket(): void {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${window.location.host}`);
  state.ws = ws;

  ws.addEventListener('open', () => {
    state.connected = true;

    // Check if URL has ?room=CODE (&pass=PASSCODE)
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    const passParam = params.get('pass') || '';
    if (roomParam) {
      getEl<HTMLInputElement>('input-join-code').value = roomParam.toUpperCase();
      if (passParam) {
        getEl<HTMLInputElement>('input-join-passcode').value = passParam;
      }
      sendWs({
        type: 'join_room',
        roomId: roomParam.toUpperCase(),
        passcode: passParam,
        name: getEl<HTMLInputElement>('input-player-name').value || 'Mundo Challenger',
        spells: state.mySpells
      });
    }
  });

  ws.addEventListener('message', (ev: MessageEvent<string>) => {
    const msg = JSON.parse(ev.data) as ServerToClientMessage;
    handleServerMessage(msg);
  });

  ws.addEventListener('close', () => {
    state.connected = false;
    setTimeout(connectWebSocket, 1500);
  });
}

function renderEquippedPairHtml(
  spells: [SummonerSpellId, SummonerSpellId] = ['flash', 'ghost']
): string {
  return spells
    .map(
      (sp, i) => `
    <div class="equipped-spell-box">
      <img src="${SPELL_ICONS[sp] || SPELL_ICONS.flash}" alt="${sp}" />
      <span>[${i === 0 ? 'D' : 'F'}] ${SPELL_NAMES[sp] || 'Flash'}</span>
    </div>
  `
    )
    .join('');
}

function updateLobbyDOM(lobby: RoomLobbyPayload): void {
  state.roomState = lobby.state;
  state.bestOf = lobby.settings?.bestOf || 3;
  state.botEnabled = lobby.botEnabled;

  getEl('lobby-room-code').textContent = lobby.roomId;
  getEl('lobby-room-passcode').textContent = lobby.passcode ? lobby.passcode : 'NONE (OPEN)';
  getEl('lobby-share-url').textContent = getShareableRoomUrl(true);

  const p0 = lobby.players?.[0];
  const p1 = lobby.players?.[1];

  getEl('slot-0-name').textContent = p0
    ? `${p0.name}${state.mySlot === 0 ? ' (You)' : ''}`
    : 'Waiting...';
  getEl('slot-0-spells').innerHTML = renderEquippedPairHtml(p0?.spells || ['flash', 'ghost']);

  const btnBot = getEl<HTMLButtonElement>('btn-toggle-bot');
  if (p1) {
    getEl('slot-1-name').textContent = `${p1.name}${state.mySlot === 1 ? ' (You)' : ''}`;
    getEl('slot-1-sub').textContent = p1.isBot
      ? 'AI Challenger Bot • Ready for 1v1'
      : 'Dr. Mundo — The Madman of Zaun';
    getEl('slot-1-spells').innerHTML = renderEquippedPairHtml(p1.spells || ['flash', 'ghost']);
    if (p1.isBot && state.mySlot === 0) {
      btnBot.style.display = 'inline-block';
      btnBot.textContent = 'Remove AI Bot';
    } else {
      btnBot.style.display = 'none';
    }
  } else {
    getEl('slot-1-name').textContent = 'Waiting for Opponent...';
    getEl('slot-1-sub').textContent = 'Share room link above or click + Add AI Bot';
    getEl('slot-1-spells').innerHTML = renderEquippedPairHtml(['flash', 'ghost']);
    btnBot.style.display = state.mySlot === 0 ? 'inline-block' : 'none';
    btnBot.textContent = '+ Add AI Bot';
  }

  const startBtn = getEl<HTMLButtonElement>('btn-start-match');
  const statusHint = getEl('lobby-status-hint');
  if (p0 && p1) {
    startBtn.disabled = false;
    statusHint.textContent = 'Both Mundos ready in the Baron Pit!';
  } else {
    startBtn.disabled = false;
    statusHint.textContent = 'Waiting for Player 2 (or click + Add AI Bot to start now)';
  }

  // Toggle visibility of Lobby vs In-Game HUD
  const lobbyOverlay = getEl('lobby-overlay');
  const ingameHud = getEl('ingame-hud');
  const gameoverModal = getEl('gameover-modal');

  if (lobby.state === 'lobby') {
    lobbyOverlay.classList.remove('hidden');
    getEl('home-view').classList.add('hidden');
    getEl('room-view').classList.remove('hidden');
    ingameHud.classList.add('hidden');
    gameoverModal.classList.add('hidden');
  } else {
    lobbyOverlay.classList.add('hidden');
    ingameHud.classList.remove('hidden');
  }
}

let lastCountdownInt = -1;

function handleGameEvents(events: GameEvent[] = []): void {
  for (const ev of events) {
    if (ev.type === 'round_countdown') {
      getEl('gameover-modal').classList.add('hidden');
      showAnnouncerBanner(`ROUND ${ev.round}`, 'GET READY IN BARON PIT', 2200);
      audio.playCountdownTick(false);
    } else if (ev.type === 'fight_start') {
      showAnnouncerBanner('FIGHT!', 'DODGE & THROW INFECTED BONESAWS', 1400);
      audio.playCountdownTick(true);
    } else if (ev.type === 'q_windup') {
      const rig = mundoRigs[ev.slot];
      if (rig) rig.triggerQThrowVisual();
      audio.playCleaverThrow();
    } else if (ev.type === 'q_hit') {
      audio.playCleaverHit();
      spawnRingBurstVfx(ev.x, ev.z, 0xd67eff, 25, 115, 0.35);
      spawnFloatingCombatText(ev.x, ev.z, `-${ev.damage}`, 'magic-dmg');
      const attacker = state.serverPlayers[ev.attackerSlot];
      if (attacker) {
        spawnFloatingCombatText(attacker.x, attacker.z, `+${ev.refund} HP`, 'heal-text');
      }
    } else if (ev.type === 'q_miss') {
      audio.playCleaverMiss();
      spawnRingBurstVfx(ev.x, ev.z, 0x95a5a6, 10, 45, 0.22);
    } else if (ev.type === 'spell_flash') {
      audio.playFlash();
      spawnFlashVfx(ev.slot, ev.fromX, ev.fromZ, ev.toX, ev.toZ);
    } else if (ev.type === 'spell_heal') {
      audio.playHeal();
      spawnHealVfx(ev.slot, ev.x, ev.z);
      spawnFloatingCombatText(ev.x, ev.z, `+${ev.amount} HP`, 'heal-text');
    } else if (ev.type === 'spell_ghost') {
      audio.playGhost(ev.duration);
      spawnGhostVfx(ev.slot, ev.x, ev.z);
    } else if (ev.type === 'round_kill') {
      const winnerName = state.serverPlayers[ev.winnerSlot]?.name || 'Dr. Mundo';
      audio.playTauntVo();
      if (ev.matchOver) {
        const iWon = ev.winnerSlot === state.mySlot;
        const modal = getEl('gameover-modal');
        const titleEl = getEl('gameover-title');
        const subEl = getEl('gameover-subtitle');
        const statsEl = getEl('gameover-stats');

        titleEl.textContent = iWon ? 'VICTORY' : 'DEFEAT';
        titleEl.className = iWon ? 'victory' : 'defeat';
        subEl.textContent = `${winnerName} wins the Baron Pit 1v1 (${ev.scores[0]} - ${ev.scores[1]})!`;

        const me = state.serverPlayers[state.mySlot];
        const thrown = me?.stats?.cleaversThrown || 0;
        const hits = me?.stats?.cleaversHit || 0;
        const acc = thrown > 0 ? Math.round((hits / thrown) * 100) : 0;
        statsEl.innerHTML = `
          <div><b>Final Series Score:</b> ${ev.scores[0]} – ${ev.scores[1]}</div>
          <div><b>Your Bonesaw Accuracy:</b> ${acc}% (${hits} Hit / ${thrown} Thrown)</div>
          <div><b>Total Bonesaw Damage Dealt:</b> ${me?.stats?.damageDealt || 0}</div>
        `;
        setTimeout(() => modal.classList.remove('hidden'), 1100);
      } else {
        showAnnouncerBanner(
          ev.winnerSlot === state.mySlot ? 'ROUND WON!' : 'ROUND LOST',
          `${winnerName} scores! (${ev.scores[0]} - ${ev.scores[1]})`,
          2800
        );
      }
    }
  }
}

function handleServerMessage(msg: ServerToClientMessage): void {
  if (msg.type === 'error_msg') {
    showToast(msg.message || 'Error');
    if (msg.code === 'INVALID_PASSCODE' && msg.roomId) {
      getEl<HTMLInputElement>('input-join-code').value = msg.roomId;
      getEl<HTMLInputElement>('input-join-passcode').focus();
    }
    return;
  }

  if (msg.type === 'joined_room') {
    state.roomId = msg.roomId;
    state.mySlot = msg.slot;
    state.passcode = msg.passcode || '';
    audio.playChooseVo();

    // Update browser URL cleanly so user can copy from address bar too
    const newUrl = new URL(window.location.href);
    newUrl.searchParams.set('room', state.roomId);
    if (state.passcode) {
      newUrl.searchParams.set('pass', state.passcode);
    } else {
      newUrl.searchParams.delete('pass');
    }
    window.history.replaceState({}, '', newUrl.toString());

    updateLobbyDOM(msg.lobby);
    return;
  }

  if (msg.type === 'room_update') {
    if (msg.passcode !== undefined) state.passcode = msg.passcode;
    updateLobbyDOM(msg);
    return;
  }

  if (msg.type === 'game_events') {
    handleGameEvents(msg.events);
    return;
  }

  if (msg.type === 'state_snapshot') {
    state.roomState = msg.state;
    state.round = msg.round;
    state.serverPlayers = msg.players;
    state.serverProjectiles = msg.projectiles || [];

    if (msg.state === 'countdown') {
      const sec = Math.ceil(msg.countdownTimer);
      if (sec > 0 && sec !== lastCountdownInt) {
        lastCountdownInt = sec;
        showAnnouncerBanner(`${sec}`, `ROUND ${msg.round} STARTING`, 900);
        audio.playCountdownTick(false);
      }
    } else {
      lastCountdownInt = -1;
    }

    if (msg.events && msg.events.length > 0) {
      handleGameEvents(msg.events);
    }

    updateInGameHud();
  }
}

// ============================================================================
// UI BUTTON BINDINGS & PLAYER INPUTS (LEAGUE OF LEGENDS CONTROLS)
// ============================================================================
getEl('btn-create-room').addEventListener('click', () => {
  audio.ensureContext();
  sendWs({
    type: 'create_room',
    name: getEl<HTMLInputElement>('input-player-name').value.trim() || 'Dr. Mundo',
    passcode: getEl<HTMLInputElement>('input-create-passcode').value.trim(),
    bestOf: Number(getDropdownValue('dropdown-best-of') || 3),
    cooldownMode: (getDropdownValue('dropdown-cd-mode') || 'fast') as CooldownMode,
    spells: state.mySpells,
    withBot: false
  });
});

getEl('btn-practice-bot').addEventListener('click', () => {
  audio.ensureContext();
  sendWs({
    type: 'create_room',
    name: getEl<HTMLInputElement>('input-player-name').value.trim() || 'Dr. Mundo',
    passcode: getEl<HTMLInputElement>('input-create-passcode').value.trim(),
    bestOf: Number(getDropdownValue('dropdown-best-of') || 3),
    cooldownMode: (getDropdownValue('dropdown-cd-mode') || 'fast') as CooldownMode,
    spells: state.mySpells,
    withBot: true
  });
  setTimeout(() => {
    sendWs({ type: 'start_match' });
  }, 150);
});

getEl('btn-join-room').addEventListener('click', () => {
  audio.ensureContext();
  const code = getEl<HTMLInputElement>('input-join-code').value.trim().toUpperCase();
  if (!code) {
    showToast('Please enter a Room Code');
    return;
  }
  sendWs({
    type: 'join_room',
    roomId: code,
    passcode: getEl<HTMLInputElement>('input-join-passcode').value.trim(),
    name: getEl<HTMLInputElement>('input-player-name').value.trim() || 'Dr. Mundo',
    spells: state.mySpells
  });
});

getEl('input-join-code').addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') getEl('btn-join-room').click();
});
getEl('input-join-passcode').addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') getEl('btn-join-room').click();
});

getEl('btn-copy-share-link').addEventListener('click', async () => {
  const link = getShareableRoomUrl(true);
  await navigator.clipboard.writeText(link).catch(() => {});
  showToast('Copied Shareable Room Link to clipboard!');
});

getEl('btn-copy-code-pass').addEventListener('click', async () => {
  const linkNoPass = getShareableRoomUrl(false);
  const text = `Baron Pit Dr. Mundo 1v1 — Room Code: ${state.roomId}${state.passcode ? ` | Passcode: ${state.passcode}` : ''} | Link: ${linkNoPass}`;
  await navigator.clipboard.writeText(text).catch(() => {});
  showToast('Copied Room Code & Passcode details!');
});

getEl('btn-toggle-bot').addEventListener('click', () => {
  sendWs({ type: 'toggle_bot' });
});

getEl('btn-start-match').addEventListener('click', () => {
  if (!state.serverPlayers[1] && !state.botEnabled) {
    // Automatically add bot if host clicks Start alone so they can immediately play!
    sendWs({ type: 'toggle_bot' });
    setTimeout(() => sendWs({ type: 'start_match' }), 80);
  } else {
    sendWs({ type: 'start_match' });
  }
});

getEl('btn-leave-room').addEventListener('click', () => {
  window.location.href = window.location.pathname;
});

getEl('btn-rematch').addEventListener('click', () => {
  getEl('gameover-modal').classList.add('hidden');
  sendWs({ type: 'rematch' });
});

getEl('btn-back-lobby').addEventListener('click', () => {
  getEl('gameover-modal').classList.add('hidden');
  sendWs({ type: 'return_to_lobby' });
});

getEl('btn-mute-audio').addEventListener('click', (e: MouseEvent) => {
  audio.muted = !audio.muted;
  const target = e.currentTarget as HTMLButtonElement | null;
  if (target) {
    target.textContent = audio.muted ? 'Sound: OFF' : 'Sound: ON';
  }
});

// HUD Ability clicks & hover skillshot indicator
const hudSlotQ = getEl('hud-slot-q');
hudSlotQ.addEventListener('mouseenter', () => {
  state.showSkillshotIndicator = true;
});
hudSlotQ.addEventListener('mouseleave', () => {
  state.showSkillshotIndicator = false;
});
hudSlotQ.addEventListener('click', () => {
  sendWs({ type: 'cast_q', x: state.mouseWorld.x, z: state.mouseWorld.z });
});
getEl('hud-slot-d').addEventListener('click', () => {
  sendWs({ type: 'cast_spell', spellIndex: 0, x: state.mouseWorld.x, z: state.mouseWorld.z });
});
getEl('hud-slot-f').addEventListener('click', () => {
  sendWs({ type: 'cast_spell', spellIndex: 1, x: state.mouseWorld.x, z: state.mouseWorld.z });
});

// Mouse tracking & Right-Click to Move (Exact League of Legends controls)
function updateMouseWorldPosition(clientX: number, clientY: number): void {
  state.mouseScreen.x = (clientX / window.innerWidth) * 2 - 1;
  state.mouseScreen.y = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(state.mouseScreen, camera);
  raycaster.ray.intersectPlane(groundRayPlane, state.mouseWorld);
}

window.addEventListener('mousemove', (e: MouseEvent) => {
  updateMouseWorldPosition(e.clientX, e.clientY);
});

window.addEventListener('contextmenu', (e: MouseEvent) => {
  e.preventDefault();
  if (state.roomState !== 'playing') return;
  audio.ensureContext();
  updateMouseWorldPosition(e.clientX, e.clientY);
  sendWs({
    type: 'move',
    x: state.mouseWorld.x,
    z: state.mouseWorld.z
  });
  spawnMoveClickIndicator(state.mouseWorld.x, state.mouseWorld.z);
  audio.playMoveClick();
});

// Also allow Right-Click mousedown responsiveness
renderer.domElement.addEventListener('mousedown', (e: MouseEvent) => {
  audio.ensureContext();
  if (e.button === 2) {
    updateMouseWorldPosition(e.clientX, e.clientY);
    if (state.roomState === 'playing') {
      sendWs({
        type: 'move',
        x: state.mouseWorld.x,
        z: state.mouseWorld.z
      });
      spawnMoveClickIndicator(state.mouseWorld.x, state.mouseWorld.z);
      audio.playMoveClick();
    }
  }
});

// Mouse wheel zoom
window.addEventListener(
  'wheel',
  (e: WheelEvent) => {
    if (!getEl('lobby-overlay').classList.contains('hidden')) return;
    state.cameraZoom = Math.max(0.68, Math.min(1.28, state.cameraZoom + e.deltaY * 0.0005));
  },
  { passive: true }
);

// Keyboard Controls: Q (Infected Bonesaw), D/F (Summoner Spells), S (Stop), Space/Y (Camera Lock), 1-4 (Emotes)
window.addEventListener('keydown', (e: KeyboardEvent) => {
  if (
    document.activeElement &&
    ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)
  ) {
    return;
  }

  const key = e.key.toLowerCase();
  if (key === 'q') {
    if (e.shiftKey) {
      state.showSkillshotIndicator = true;
    }
    sendWs({
      type: 'cast_q',
      x: state.mouseWorld.x,
      z: state.mouseWorld.z
    });
  } else if (key === 'd') {
    sendWs({
      type: 'cast_spell',
      spellIndex: 0,
      x: state.mouseWorld.x,
      z: state.mouseWorld.z
    });
  } else if (key === 'f') {
    sendWs({
      type: 'cast_spell',
      spellIndex: 1,
      x: state.mouseWorld.x,
      z: state.mouseWorld.z
    });
  } else if (key === 's') {
    sendWs({ type: 'stop' });
  } else if (key === 'y') {
    state.cameraLocked = !state.cameraLocked;
    showToast(`Camera Lock: ${state.cameraLocked ? 'ON' : 'OFF'}`);
  } else if (e.code === 'Space') {
    state.cameraLocked = true;
  } else if (key === '1') {
    sendWs({ type: 'emote', emote: 'joke' });
  } else if (key === '2') {
    sendWs({ type: 'emote', emote: 'taunt' });
    audio.playTauntVo();
  } else if (key === '3') {
    sendWs({ type: 'emote', emote: 'dance' });
  } else if (key === '4') {
    sendWs({ type: 'emote', emote: 'laugh' });
  } else if (key === 'b') {
    sendWs({ type: 'emote', emote: 'recall' });
    audio.playRecall();
  }
});

window.addEventListener('keyup', (e: KeyboardEvent) => {
  if (e.code === 'Space') {
    state.cameraLocked = false;
  }
  if (e.key.toLowerCase() === 'q') {
    state.showSkillshotIndicator = false;
  }
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ============================================================================
// INITIALIZE ASSETS & MAIN 60FPS RENDER LOOP
// ============================================================================
async function initAllAssets(): Promise<void> {
  try {
    await Promise.all([
      loadVfxTextures(),
      buildBaronPitEnvironment(),
      loadCleaverProjectileTemplate(),
      mundoRigs[0].load(),
      mundoRigs[1].load()
    ]);
    state.assetsLoaded = true;
  } catch (err) {
    console.error('Error loading 3D assets:', err);
  }
}

void initAllAssets();
connectWebSocket();

let lastFrameTime = performance.now();
function animate(now: number): void {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
  lastFrameTime = now;

  // Update Ward animations
  for (const m of wardMixers) {
    m.update(dt);
  }

  // Float void mist particles gently
  if (voidParticles) {
    const pos = voidParticles.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      let y = pos.getY(i) + dt * 14;
      if (y > 165) y = 10;
      pos.setY(i, y);
    }
    pos.needsUpdate = true;
    voidParticles.rotation.y += dt * 0.04;
  }

  // Update Dr. Mundo 3D rigs
  if (state.roomState === 'lobby' && !state.serverPlayers[0] && !state.serverPlayers[1]) {
    // Showcase both Dr. Mundos in the background Baron Pit while in the Home/Lobby menu!
    mundoRigs[0].update(dt, {
      x: -300,
      z: -300,
      angle: Math.PI * 0.25,
      anim: 'idle',
      ghostTimer: 0,
      healSpeedTimer: 0,
      slowTimer: 0
    });
    mundoRigs[1].update(dt, {
      x: 300,
      z: 300,
      angle: -Math.PI * 0.75,
      anim: 'idle',
      ghostTimer: 0,
      healSpeedTimer: 0,
      slowTimer: 0
    });
  } else {
    mundoRigs[0].update(dt, state.serverPlayers[0]);
    mundoRigs[1].update(dt, state.serverPlayers[1]);
  }

  syncProjectiles(dt);
  updateTransientVfx(dt);
  updateSkillshotIndicator();
  updateCameraTransform(dt);
  updateFloatingHealthBars();

  renderer.render(scene, camera);
}
requestAnimationFrame(animate);
