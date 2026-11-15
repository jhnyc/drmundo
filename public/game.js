import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { audio } from './audio.js';

// ============================================================================
// CONSTANTS & GAME CONFIG (1 Three.js World Unit = 1 League of Legends Unit)
// ============================================================================
const LOL_SCALE = 1 / 0.0085; // 117.6470588 — converts Khada 0.0085 scale back to 1:1 LoL units
const PIT_RADIUS = 820;
const Q_RANGE = 1050;
const Q_RADIUS = 60;
const FLASH_RANGE = 425;
const INV_SQRT2 = Math.SQRT1_2;

const SPELL_ICONS = {
  flash: '/assets/icons/summoner_flash.png',
  heal: '/assets/icons/summoner_heal.png',
  ghost: '/assets/icons/summoner_ghost.png'
};

const SPELL_NAMES = {
  flash: 'Flash',
  heal: 'Heal',
  ghost: 'Ghost'
};

// ============================================================================
// CLIENT APPLICATION STATE
// ============================================================================
const state = {
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

// ============================================================================
// THREE.JS SCENE, CAMERA & RENDERER SETUP
// ============================================================================
const container = document.getElementById('game-canvas-container');
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

function updateCameraTransform(dt = 0.016) {
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

const wardMixers = [];
let voidParticles = null;
let cleaverTemplateMesh = null;

async function buildBaronPitEnvironment() {
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
    let angleDiffFromRiver = Math.atan2(
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

  // 2. Subtle Pit Boundary Ring & Classic Mundo Dodgeball Dividing Line on Floor
  // Dividing line runs along x + z = 0 from (-790, +790) to (+790, -790)
  const lineLength = PIT_RADIUS * 1.92;
  const lineGeo = new THREE.PlaneGeometry(26, lineLength);
  lineGeo.rotateX(-Math.PI / 2);
  lineGeo.rotateY(-Math.PI / 4); // Align along (-1, +1) direction (x + z = 0)
  const lineMat = new THREE.MeshBasicMaterial({
    color: 0x0ac8b9,
    transparent: true,
    opacity: 0.48,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const dividingLineMesh = new THREE.Mesh(lineGeo, lineMat);
  dividingLineMesh.position.y = 2.5;
  arenaGroup.add(dividingLineMesh);

  // Inner bright core of dividing line
  const coreLineGeo = new THREE.PlaneGeometry(6, lineLength);
  coreLineGeo.rotateX(-Math.PI / 2);
  coreLineGeo.rotateY(-Math.PI / 4);
  const coreLineMat = new THREE.MeshBasicMaterial({
    color: 0xcdfafa,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const coreLineMesh = new THREE.Mesh(coreLineGeo, coreLineMat);
  coreLineMesh.position.y = 3.0;
  arenaGroup.add(coreLineMesh);

  // Subtle playable pit boundary ring
  const ringGeo = new THREE.RingGeometry(PIT_RADIUS - 8, PIT_RADIUS + 4, 96);
  ringGeo.rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x9b59b6,
    transparent: true,
    opacity: 0.28,
    side: THREE.DoubleSide,
    depthWrite: false
  });
  const pitRing = new THREE.Mesh(ringGeo, ringMat);
  pitRing.position.y = 2.0;
  arenaGroup.add(pitRing);

  // 3. Load Official 3D Control Wards (jammerdevice.glb) & Stealth Wards (sightward.obj)
  // placed along the Baron Pit centerline (x + z = 0), just like League of Legends Mundo Dodgeball!
  try {
    const [wardGltf, sightWardObj, sightWardTex] = await Promise.all([
      gltfLoader.loadAsync('/assets/models/jammerdevice.glb'),
      objLoader.loadAsync('/assets/models/sightward.obj'),
      textureLoader.loadAsync('/assets/models/sightward_tx.png')
    ]);
    sightWardTex.colorSpace = THREE.SRGBColorSpace;

    sightWardObj.traverse(child => {
      if (child.isMesh) {
        child.material = new THREE.MeshStandardMaterial({
          map: sightWardTex,
          roughness: 0.6,
          metalness: 0.2,
          side: THREE.DoubleSide
        });
        child.castShadow = true;
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
        cw.traverse(ch => {
          if (ch.isMesh) {
            ch.material.side = THREE.DoubleSide;
            ch.castShadow = true;
            ch.frustumCulled = false;
          }
        });
        arenaGroup.add(cw);

        if (cwGltf.animations && cwGltf.animations.length > 0) {
          const mixer = new THREE.AnimationMixer(cw);
          const idleClip = cwGltf.animations.find(a => a.name.includes('Idle')) || cwGltf.animations[0];
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

      // Small ward ground glow ring
      const wRingGeo = new THREE.RingGeometry(18, 28, 24);
      wRingGeo.rotateX(-Math.PI / 2);
      const wRingMat = new THREE.MeshBasicMaterial({
        color: i % 2 === 0 ? 0xff3b5c : 0x2ecc71,
        transparent: true,
        opacity: 0.45,
        side: THREE.DoubleSide,
        depthWrite: false
      });
      const wRing = new THREE.Mesh(wRingGeo, wRingMat);
      wRing.position.set(wx, 3, wz);
      arenaGroup.add(wRing);
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
// LOAD AUTHENTIC DR. MUNDO 3D RIGS & INFECTED BONESAW (Q) MESH
// ============================================================================
class MundoChampionRig {
  constructor(slot) {
    this.slot = slot;
    this.root = new THREE.Group();
    scene.add(this.root);

    this.model = null;
    this.pelvisNode = null;
    this.mixer = null;
    this.clips = new Map();
    this.activeAction = null;
    this.currentAnimKey = '';
    this.weaponMesh = null;
    this.weaponHideTimer = 0;

    // Team indicator circle under feet (Blue for slot 0, Red for slot 1)
    const ringColor = slot === 0 ? 0x26a9ff : 0xff4254;
    const ringGeo = new THREE.RingGeometry(56, 68, 48);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: ringColor,
      transparent: true,
      opacity: 0.78,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    this.teamRing = new THREE.Mesh(ringGeo, ringMat);
    this.teamRing.position.y = 3;
    this.root.add(this.teamRing);

    // Soft drop shadow disc
    const shadowGeo = new THREE.CircleGeometry(54, 32);
    shadowGeo.rotateX(-Math.PI / 2);
    const shadowMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.45,
      depthWrite: false
    });
    this.shadowDisc = new THREE.Mesh(shadowGeo, shadowMat);
    this.shadowDisc.position.y = 1.5;
    this.root.add(this.shadowDisc);

    // Ghost / Slow / Heal aura ring
    const auraGeo = new THREE.RingGeometry(68, 86, 48);
    auraGeo.rotateX(-Math.PI / 2);
    this.auraMat = new THREE.MeshBasicMaterial({
      color: 0x0ac8b9,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.auraRing = new THREE.Mesh(auraGeo, this.auraMat);
    this.auraRing.position.y = 5;
    this.root.add(this.auraRing);

    // Set initial spawn position
    if (slot === 0) {
      this.root.position.set(-300, 0, -300);
      this.root.rotation.y = Math.PI * 0.25;
    } else {
      this.root.position.set(300, 0, 300);
      this.root.rotation.y = -Math.PI * 0.75;
    }
  }

  async load() {
    const gltf = await gltfLoader.loadAsync('/assets/models/drmundo.glb');
    this.model = gltf.scene;
    // Convert Khada 0.0085 world scale back to 1:1 League of Legends units
    this.model.scale.setScalar(LOL_SCALE);
    this.model.position.set(0, 0, 0);
    this.pelvisNode = this.model.getObjectByName('Pelvis') || this.model.getObjectByName('Root');

    // Configure submeshes using material.userData.visible from Riot's skin data
    this.model.traverse(child => {
      if (child.isMesh) {
        child.frustumCulled = false;
        child.castShadow = true;
        child.receiveShadow = true;
        if (child.material) {
          child.material = child.material.clone();
          child.material.side = THREE.DoubleSide;
          const ud = child.material.userData || {};
          if (ud.visible === false) {
            child.visible = false;
          } else {
            child.visible = true;
          }
          if (child.material.name === 'Weapon' || ud.hash === 1865621569) {
            this.weaponMesh = child;
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

  resolveClipName(animKey) {
    switch (animKey) {
      case 'idle':
        return 'DrMundo_Idle01.anm';
      case 'run':
        return 'DrMundo_Run.anm';
      case 'run_haste':
        return this.clips.has('Run_Homeguard') ? 'Run_Homeguard' : 'DrMundo_Run.anm';
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

  playAnim(animKey, forceRestart = false) {
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
      nextAction.timeScale = 1.32;
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

  triggerQThrowVisual() {
    this.playAnim('q_cast', true);
    // Hide hand weapon briefly after windup while cleaver is flying
    this.weaponHideTimer = 0.55;
  }

  update(dt, serverPlayer) {
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

    // Keep Dr. Mundo's visual mesh centered right over his hitbox ring
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

    // Update buff/debuff aura ring under feet
    if (serverPlayer.ghostTimer > 0) {
      this.auraMat.color.setHex(0x0ac8b9);
      this.auraMat.opacity = 0.7;
      this.auraRing.scale.setScalar(1 + Math.sin(performance.now() * 0.012) * 0.08);
    } else if (serverPlayer.healSpeedTimer > 0) {
      this.auraMat.color.setHex(0x2ecc71);
      this.auraMat.opacity = 0.75;
    } else if (serverPlayer.slowTimer > 0) {
      this.auraMat.color.setHex(0x9b59b6);
      this.auraMat.opacity = 0.65;
    } else {
      this.auraMat.opacity = 0;
    }
  }
}

const mundoRigs = [new MundoChampionRig(0), new MundoChampionRig(1)];

async function loadCleaverProjectileTemplate() {
  const [weaponObj, weaponTex] = await Promise.all([
    objLoader.loadAsync('/assets/models/Weapon.obj'),
    textureLoader.loadAsync('/assets/models/drmundo_base_weapon_tx_cm.png')
  ]);
  weaponTex.colorSpace = THREE.SRGBColorSpace;

  const group = new THREE.Group();
  weaponObj.traverse(child => {
    if (child.isMesh) {
      child.geometry.center();
      child.material = new THREE.MeshStandardMaterial({
        map: weaponTex,
        roughness: 0.3,
        metalness: 0.55,
        emissive: new THREE.Color(0x1b4d2e),
        emissiveIntensity: 0.35,
        side: THREE.DoubleSide
      });
      child.castShadow = true;
    }
  });
  weaponObj.scale.setScalar(1.45);
  group.add(weaponObj);

  cleaverTemplateMesh = group;
}

// ============================================================================
// FLYING INFECTED BONESAW (Q) PROJECTILES & VFX SYSTEM
// ============================================================================
const activeProjectileMeshes = new Map();
const transientVfx = [];

function syncProjectiles(dt) {
  const seenIds = new Set();

  for (const proj of state.serverProjectiles) {
    seenIds.add(proj.id);
    let entry = activeProjectileMeshes.get(proj.id);
    if (!entry) {
      const meshGroup = new THREE.Group();
      const spinner = cleaverTemplateMesh
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

function spawnRingBurstVfx(x, z, colorHex, startR = 20, endR = 135, duration = 0.42) {
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
    update(dt) {
      const t = this.age / this.duration;
      const s = 1 + (scaleRatio - 1) * (1 - Math.pow(1 - t, 2));
      this.mesh.scale.setScalar(s);
      mat.opacity = 0.9 * (1 - t);
    }
  });
}

function spawnMoveClickIndicator(x, z) {
  spawnRingBurstVfx(x, z, 0x2ecc71, 12, 48, 0.32);
}

function spawnFlashVfx(fromX, fromZ, toX, toZ) {
  spawnRingBurstVfx(fromX, fromZ, 0xffdf5d, 25, 130, 0.38);
  spawnRingBurstVfx(toX, toZ, 0xffdf5d, 15, 145, 0.42);

  // Golden vertical light pillar at destination
  const cylGeo = new THREE.CylinderGeometry(35, 55, 220, 20, 1, true);
  const cylMat = new THREE.MeshBasicMaterial({
    color: 0xffe670,
    transparent: true,
    opacity: 0.75,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const pillar = new THREE.Mesh(cylGeo, cylMat);
  pillar.position.set(toX, 110, toZ);
  scene.add(pillar);

  transientVfx.push({
    mesh: pillar,
    age: 0,
    duration: 0.35,
    update() {
      const t = this.age / this.duration;
      pillar.scale.set(1 + t * 0.6, 1, 1 + t * 0.6);
      cylMat.opacity = 0.75 * (1 - t);
    }
  });
}

function spawnHealVfx(x, z) {
  spawnRingBurstVfx(x, z, 0x2ecc71, 30, 165, 0.55);
  const cylGeo = new THREE.CylinderGeometry(52, 52, 240, 24, 1, true);
  const cylMat = new THREE.MeshBasicMaterial({
    color: 0x39ff6b,
    transparent: true,
    opacity: 0.68,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const beam = new THREE.Mesh(cylGeo, cylMat);
  beam.position.set(x, 120, z);
  scene.add(beam);

  transientVfx.push({
    mesh: beam,
    age: 0,
    duration: 0.55,
    update() {
      const t = this.age / this.duration;
      cylMat.opacity = 0.68 * (1 - t);
    }
  });
}

function updateTransientVfx(dt) {
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

function updateSkillshotIndicator() {
  const myPlayer = state.serverPlayers[state.mySlot];
  if (!state.showSkillshotIndicator || !myPlayer || !myPlayer.alive || state.roomState !== 'playing') {
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
const combatTextLayer = document.getElementById('combat-text-layer');

function worldToScreen(x, y, z) {
  const vec = new THREE.Vector3(x, y, z);
  vec.project(camera);
  return {
    x: (vec.x * 0.5 + 0.5) * window.innerWidth,
    y: (-vec.y * 0.5 + 0.5) * window.innerHeight
  };
}

function spawnFloatingCombatText(x, z, text, cssClass = 'magic-dmg') {
  const pos = worldToScreen(x, 195, z);
  const el = document.createElement('div');
  el.className = `floating-combat-text ${cssClass}`;
  el.textContent = text;
  el.style.left = `${pos.x}px`;
  el.style.top = `${pos.y}px`;
  combatTextLayer.appendChild(el);
  setTimeout(() => el.remove(), 1100);
}

function updateFloatingHealthBars() {
  const inMatch = state.roomState === 'playing' || state.roomState === 'countdown' || state.roomState === 'round_end';

  for (let i = 0; i < 2; i++) {
    const fhb = document.getElementById(`fhb-${i}`);
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

    document.getElementById(`fhb-name-${i}`).textContent = p.name;
    const pct = Math.max(0, Math.min(100, (p.hp / p.maxHp) * 100));
    document.getElementById(`fhb-fill-${i}`).style.width = `${pct}%`;
    document.getElementById(`fhb-trail-${i}`).style.width = `${pct}%`;

    // Status pills (SLOWED / GHOSTED / HEALED)
    const statusRow = document.getElementById(`fhb-status-${i}`);
    const pills = [];
    if (p.slowTimer > 0) pills.push('<span class="fhb-status-pill slowed">Slowed</span>');
    if (p.ghostTimer > 0) pills.push('<span class="fhb-status-pill ghosted">Ghosted</span>');
    if (p.healSpeedTimer > 0) pills.push('<span class="fhb-status-pill healed">Healed</span>');
    const html = pills.join('');
    if (statusRow.innerHTML !== html) {
      statusRow.innerHTML = html;
    }
  }
}

function updateInGameHud() {
  const p0 = state.serverPlayers[0];
  const p1 = state.serverPlayers[1];
  const me = state.serverPlayers[state.mySlot];

  if (p0) {
    document.getElementById('hud-blue-name').textContent = p0.name;
    document.getElementById('hud-blue-score').textContent = p0.score || 0;
    // Update minimap dot 0
    const mx = 50 + (p0.x / PIT_RADIUS) * 20;
    const my = 50 + (p0.z / PIT_RADIUS) * 20;
    const dot0 = document.getElementById('minimap-dot-0');
    dot0.style.left = `${mx}%`;
    dot0.style.top = `${my}%`;
  }
  if (p1) {
    document.getElementById('hud-red-name').textContent = p1.name;
    document.getElementById('hud-red-score').textContent = p1.score || 0;
    const mx = 50 + (p1.x / PIT_RADIUS) * 20;
    const my = 50 + (p1.z / PIT_RADIUS) * 20;
    const dot1 = document.getElementById('minimap-dot-1');
    dot1.style.left = `${mx}%`;
    dot1.style.top = `${my}%`;
  }

  document.getElementById('hud-round-label').textContent = `ROUND ${state.round} (BO${state.bestOf})`;

  if (!me) return;

  const thrown = me.stats?.cleaversThrown || 0;
  const hits = me.stats?.cleaversHit || 0;
  const acc = thrown > 0 ? Math.round((hits / thrown) * 100) : 0;
  document.getElementById('hud-accuracy-label').textContent = `Cleaver Acc: ${acc}% (${hits}/${thrown})`;
  document.getElementById('hud-stat-hits').textContent = `${hits}`;

  // Move speed calculation
  let ms = 385;
  if (me.ghostTimer > 0) ms = Math.round(ms * 1.38);
  if (me.healSpeedTimer > 0) ms = Math.round(ms * 1.30);
  if (me.slowTimer > 0) ms = Math.round(ms * 0.60);
  document.getElementById('hud-stat-ms').textContent = `${ms}`;

  // HP Bar
  const hpPct = Math.max(0, Math.min(100, (me.hp / me.maxHp) * 100));
  document.getElementById('hud-hp-bar-fill').style.width = `${hpPct}%`;
  document.getElementById('hud-hp-bar-text').textContent = `${Math.round(me.hp)} / ${me.maxHp} (+16.0/s)`;

  // Q Cooldown
  const cdQ = document.getElementById('hud-cd-q');
  if (me.qCd > 0) {
    cdQ.classList.remove('hidden');
    cdQ.textContent = me.qCd >= 1 ? me.qCd.toFixed(1) : me.qCd.toFixed(1);
  } else {
    cdQ.classList.add('hidden');
  }

  // Summoner Spells D and F icons & cooldowns
  const spD = me.spells?.[0] || 'flash';
  const spF = me.spells?.[1] || 'ghost';
  document.getElementById('hud-img-d').src = SPELL_ICONS[spD] || SPELL_ICONS.flash;
  document.getElementById('hud-img-f').src = SPELL_ICONS[spF] || SPELL_ICONS.ghost;

  const cdD = document.getElementById('hud-cd-d');
  if (me.spellCd?.[0] > 0) {
    cdD.classList.remove('hidden');
    cdD.textContent = Math.ceil(me.spellCd[0]);
  } else {
    cdD.classList.add('hidden');
  }

  const cdF = document.getElementById('hud-cd-f');
  if (me.spellCd?.[1] > 0) {
    cdF.classList.remove('hidden');
    cdF.textContent = Math.ceil(me.spellCd[1]);
  } else {
    cdF.classList.add('hidden');
  }
}

// ============================================================================
// ANNOUNCER BANNER & TOAST NOTIFICATIONS
// ============================================================================
let announcerTimeout = null;
function showAnnouncerBanner(title, subtitle = '', durationMs = 2000) {
  const banner = document.getElementById('announcer-banner');
  document.getElementById('announcer-title').textContent = title;
  document.getElementById('announcer-sub').textContent = subtitle;
  banner.classList.remove('hidden');
  if (announcerTimeout) clearTimeout(announcerTimeout);
  announcerTimeout = setTimeout(() => {
    banner.classList.add('hidden');
  }, durationMs);
}

function showToast(message) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'hex-toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

// ============================================================================
// SUMMONER SPELL PICKER UI LOGIC (FLASH, HEAL, GHOST ON D & F)
// ============================================================================
function renderSpellPickerUI(containerId, spellsArray) {
  const containerEl = document.getElementById(containerId);
  if (!containerEl) return;
  const cards = containerEl.querySelectorAll('.spell-option-card');
  cards.forEach(card => {
    const sp = card.getAttribute('data-spell');
    const badge = card.querySelector('.spell-key-badge');
    card.classList.remove('selected-d', 'selected-f');
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

function bindSpellPickerEvents(containerId) {
  const containerEl = document.getElementById(containerId);
  if (!containerEl) return;
  containerEl.querySelectorAll('.spell-option-card').forEach(card => {
    card.addEventListener('click', () => {
      const clickedSpell = card.getAttribute('data-spell');
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
// WEBSOCKET NETWORKING & ROOM / PASSCODE / SHAREABLE LINK MANAGEMENT
// ============================================================================
function getShareableRoomUrl(includePasscode = true) {
  const url = new URL(window.location.origin);
  url.searchParams.set('room', state.roomId || '');
  if (includePasscode && state.passcode) {
    url.searchParams.set('pass', state.passcode);
  }
  return url.toString();
}

function sendWs(payload) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload));
  }
}

function connectWebSocket() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${window.location.host}`);
  state.ws = ws;

  ws.addEventListener('open', () => {
    state.connected = true;
    refreshRoomsList();

    // Check if URL has ?room=CODE (&pass=PASSCODE)
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    const passParam = params.get('pass') || '';
    if (roomParam) {
      document.getElementById('input-join-code').value = roomParam.toUpperCase();
      if (passParam) {
        document.getElementById('input-join-passcode').value = passParam;
      }
      sendWs({
        type: 'join_room',
        roomId: roomParam.toUpperCase(),
        passcode: passParam,
        name: document.getElementById('input-player-name').value || 'Mundo Challenger',
        spells: state.mySpells
      });
    }
  });

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    handleServerMessage(msg);
  });

  ws.addEventListener('close', () => {
    state.connected = false;
    setTimeout(connectWebSocket, 1500);
  });
}

function renderEquippedPairHtml(spells = ['flash', 'ghost']) {
  return spells.map((sp, i) => `
    <div class="equipped-spell-box">
      <img src="${SPELL_ICONS[sp] || SPELL_ICONS.flash}" alt="${sp}" />
      <span>[${i === 0 ? 'D' : 'F'}] ${SPELL_NAMES[sp] || 'Flash'}</span>
    </div>
  `).join('');
}

function updateLobbyDOM(lobby) {
  state.roomState = lobby.state;
  state.bestOf = lobby.settings?.bestOf || 3;
  state.botEnabled = lobby.botEnabled;

  document.getElementById('lobby-room-code').textContent = lobby.roomId;
  document.getElementById('lobby-room-passcode').textContent = lobby.passcode ? lobby.passcode : 'NONE (OPEN)';
  document.getElementById('lobby-share-url').textContent = getShareableRoomUrl(true);
  document.getElementById('hud-room-code-label').textContent = `ROOM: ${lobby.roomId}`;

  const p0 = lobby.players?.[0];
  const p1 = lobby.players?.[1];

  document.getElementById('slot-0-name').textContent = p0 ? `${p0.name}${state.mySlot === 0 ? ' (You)' : ''}` : 'Waiting...';
  document.getElementById('slot-0-spells').innerHTML = renderEquippedPairHtml(p0?.spells || ['flash', 'ghost']);

  const btnBot = document.getElementById('btn-toggle-bot');
  if (p1) {
    document.getElementById('slot-1-name').textContent = `${p1.name}${state.mySlot === 1 ? ' (You)' : ''}`;
    document.getElementById('slot-1-sub').textContent = p1.isBot
      ? 'AI Challenger Bot • Ready for 1v1'
      : 'Dr. Mundo — The Madman of Zaun';
    document.getElementById('slot-1-spells').innerHTML = renderEquippedPairHtml(p1.spells || ['flash', 'ghost']);
    if (p1.isBot && state.mySlot === 0) {
      btnBot.style.display = 'inline-block';
      btnBot.textContent = 'Remove AI Bot';
    } else {
      btnBot.style.display = 'none';
    }
  } else {
    document.getElementById('slot-1-name').textContent = 'Waiting for Opponent...';
    document.getElementById('slot-1-sub').textContent = 'Share room link above or click + Add AI Bot';
    document.getElementById('slot-1-spells').innerHTML = renderEquippedPairHtml(['flash', 'ghost']);
    btnBot.style.display = state.mySlot === 0 ? 'inline-block' : 'none';
    btnBot.textContent = '+ Add AI Bot';
  }

  const startBtn = document.getElementById('btn-start-match');
  const statusHint = document.getElementById('lobby-status-hint');
  if (p0 && p1) {
    startBtn.disabled = false;
    statusHint.textContent = 'Both Mundos ready in the Baron Pit!';
  } else {
    startBtn.disabled = false;
    statusHint.textContent = 'Waiting for Player 2 (or click + Add AI Bot to start now)';
  }

  // Toggle visibility of Lobby vs In-Game HUD
  const lobbyOverlay = document.getElementById('lobby-overlay');
  const ingameHud = document.getElementById('ingame-hud');
  const gameoverModal = document.getElementById('gameover-modal');

  if (lobby.state === 'lobby') {
    lobbyOverlay.classList.remove('hidden');
    document.getElementById('home-view').classList.add('hidden');
    document.getElementById('room-view').classList.remove('hidden');
    ingameHud.classList.add('hidden');
    gameoverModal.classList.add('hidden');
  } else {
    lobbyOverlay.classList.add('hidden');
    ingameHud.classList.remove('hidden');
  }
}

let lastCountdownInt = -1;

function handleGameEvents(events = []) {
  for (const ev of events) {
    if (ev.type === 'round_countdown') {
      document.getElementById('gameover-modal').classList.add('hidden');
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
      spawnFlashVfx(ev.fromX, ev.fromZ, ev.toX, ev.toZ);
    } else if (ev.type === 'spell_heal') {
      audio.playHeal();
      spawnHealVfx(ev.x, ev.z);
      spawnFloatingCombatText(ev.x, ev.z, `+${ev.amount} HP`, 'heal-text');
    } else if (ev.type === 'spell_ghost') {
      audio.playGhost();
      spawnRingBurstVfx(ev.x, ev.z, 0x0ac8b9, 25, 145, 0.45);
    } else if (ev.type === 'round_kill') {
      const winnerName = state.serverPlayers[ev.winnerSlot]?.name || 'Dr. Mundo';
      audio.playTauntVo();
      if (ev.matchOver) {
        const iWon = ev.winnerSlot === state.mySlot;
        const modal = document.getElementById('gameover-modal');
        const titleEl = document.getElementById('gameover-title');
        const subEl = document.getElementById('gameover-subtitle');
        const statsEl = document.getElementById('gameover-stats');

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

function handleServerMessage(msg) {
  if (msg.type === 'error_msg') {
    showToast(msg.message || 'Error');
    if (msg.code === 'INVALID_PASSCODE' && msg.roomId) {
      document.getElementById('input-join-code').value = msg.roomId;
      document.getElementById('input-join-passcode').focus();
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

async function refreshRoomsList() {
  try {
    const res = await fetch('/api/rooms');
    const data = await res.json();
    const listEl = document.getElementById('active-rooms-list');
    if (!data.rooms || data.rooms.length === 0) {
      listEl.innerHTML = `
        <div class="room-list-item">
          <div class="room-list-meta">
            <strong>No active rooms yet</strong>
            <small>Create a room on the left or start Instant 1v1 vs Bot!</small>
          </div>
        </div>
      `;
      return;
    }

    listEl.innerHTML = data.rooms.map(r => `
      <div class="room-list-item">
        <div class="room-list-meta">
          <strong>${r.id} • ${r.hostName}'s Pit ${r.hasPasscode ? '🔒' : '🟢'}</strong>
          <small>${r.playerCount}/2 Players • Best of ${r.bestOf} • ${r.state.toUpperCase()}</small>
        </div>
        <button class="hex-btn sm btn-quick-join" data-code="${r.id}" data-locked="${r.hasPasscode}">Join</button>
      </div>
    `).join('');

    listEl.querySelectorAll('.btn-quick-join').forEach(btn => {
      btn.addEventListener('click', () => {
        const code = btn.getAttribute('data-code');
        const locked = btn.getAttribute('data-locked') === 'true';
        document.getElementById('input-join-code').value = code;
        if (locked && !document.getElementById('input-join-passcode').value) {
          document.getElementById('input-join-passcode').focus();
          showToast(`Enter the passcode for room ${code}`);
          return;
        }
        sendWs({
          type: 'join_room',
          roomId: code,
          passcode: document.getElementById('input-join-passcode').value.trim(),
          name: document.getElementById('input-player-name').value.trim() || 'Dr. Mundo',
          spells: state.mySpells
        });
      });
    });
  } catch {}
}

// ============================================================================
// UI BUTTON BINDINGS & PLAYER INPUTS (LEAGUE OF LEGENDS CONTROLS)
// ============================================================================
document.getElementById('btn-create-room').addEventListener('click', () => {
  audio.ensureContext();
  sendWs({
    type: 'create_room',
    name: document.getElementById('input-player-name').value.trim() || 'Dr. Mundo',
    passcode: document.getElementById('input-create-passcode').value.trim(),
    bestOf: Number(document.getElementById('select-best-of').value),
    cooldownMode: document.getElementById('select-cd-mode').value,
    spells: state.mySpells,
    withBot: false
  });
});

document.getElementById('btn-practice-bot').addEventListener('click', () => {
  audio.ensureContext();
  sendWs({
    type: 'create_room',
    name: document.getElementById('input-player-name').value.trim() || 'Dr. Mundo',
    passcode: document.getElementById('input-create-passcode').value.trim(),
    bestOf: Number(document.getElementById('select-best-of').value),
    cooldownMode: document.getElementById('select-cd-mode').value,
    spells: state.mySpells,
    withBot: true
  });
  setTimeout(() => {
    sendWs({ type: 'start_match' });
  }, 150);
});

document.getElementById('btn-join-room').addEventListener('click', () => {
  audio.ensureContext();
  const code = document.getElementById('input-join-code').value.trim().toUpperCase();
  if (!code) {
    showToast('Please enter a Room Code');
    return;
  }
  sendWs({
    type: 'join_room',
    roomId: code,
    passcode: document.getElementById('input-join-passcode').value.trim(),
    name: document.getElementById('input-player-name').value.trim() || 'Dr. Mundo',
    spells: state.mySpells
  });
});

document.getElementById('btn-refresh-rooms').addEventListener('click', refreshRoomsList);

document.getElementById('btn-copy-share-link').addEventListener('click', async () => {
  const link = getShareableRoomUrl(true);
  await navigator.clipboard.writeText(link).catch(() => {});
  showToast('Copied Shareable Room Link to clipboard!');
});

document.getElementById('btn-copy-code-pass').addEventListener('click', async () => {
  const linkNoPass = getShareableRoomUrl(false);
  const text = `Baron Pit Dr. Mundo 1v1 — Room Code: ${state.roomId}${state.passcode ? ` | Passcode: ${state.passcode}` : ''} | Link: ${linkNoPass}`;
  await navigator.clipboard.writeText(text).catch(() => {});
  showToast('Copied Room Code & Passcode details!');
});

document.getElementById('btn-hud-copy-link').addEventListener('click', async () => {
  const link = getShareableRoomUrl(true);
  await navigator.clipboard.writeText(link).catch(() => {});
  showToast('Copied Shareable Room Link!');
});

document.getElementById('btn-toggle-bot').addEventListener('click', () => {
  sendWs({ type: 'toggle_bot' });
});

document.getElementById('btn-start-match').addEventListener('click', () => {
  if (!state.serverPlayers[1] && !state.botEnabled) {
    // Automatically add bot if host clicks Start alone so they can immediately play!
    sendWs({ type: 'toggle_bot' });
    setTimeout(() => sendWs({ type: 'start_match' }), 80);
  } else {
    sendWs({ type: 'start_match' });
  }
});

document.getElementById('btn-leave-room').addEventListener('click', () => {
  window.location.href = window.location.pathname;
});

document.getElementById('btn-hud-lobby').addEventListener('click', () => {
  sendWs({ type: 'return_to_lobby' });
});

document.getElementById('btn-rematch').addEventListener('click', () => {
  document.getElementById('gameover-modal').classList.add('hidden');
  sendWs({ type: 'rematch' });
});

document.getElementById('btn-back-lobby').addEventListener('click', () => {
  document.getElementById('gameover-modal').classList.add('hidden');
  sendWs({ type: 'return_to_lobby' });
});

document.getElementById('btn-mute-audio').addEventListener('click', (e) => {
  audio.muted = !audio.muted;
  e.currentTarget.textContent = audio.muted ? 'Sound: OFF' : 'Sound: ON';
});

// HUD Ability clicks & hover skillshot indicator
const hudSlotQ = document.getElementById('hud-slot-q');
hudSlotQ.addEventListener('mouseenter', () => { state.showSkillshotIndicator = true; });
hudSlotQ.addEventListener('mouseleave', () => { state.showSkillshotIndicator = false; });
hudSlotQ.addEventListener('click', () => {
  sendWs({ type: 'cast_q', x: state.mouseWorld.x, z: state.mouseWorld.z });
});
document.getElementById('hud-slot-d').addEventListener('click', () => {
  sendWs({ type: 'cast_spell', spellIndex: 0, x: state.mouseWorld.x, z: state.mouseWorld.z });
});
document.getElementById('hud-slot-f').addEventListener('click', () => {
  sendWs({ type: 'cast_spell', spellIndex: 1, x: state.mouseWorld.x, z: state.mouseWorld.z });
});

// Mouse tracking & Right-Click to Move (Exact League of Legends controls)
function updateMouseWorldPosition(clientX, clientY) {
  state.mouseScreen.x = (clientX / window.innerWidth) * 2 - 1;
  state.mouseScreen.y = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(state.mouseScreen, camera);
  raycaster.ray.intersectPlane(groundRayPlane, state.mouseWorld);
}

window.addEventListener('mousemove', (e) => {
  updateMouseWorldPosition(e.clientX, e.clientY);
});

window.addEventListener('contextmenu', (e) => {
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

// Also allow Left-Click when holding Shift or clicking on canvas if desired
renderer.domElement.addEventListener('mousedown', (e) => {
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
window.addEventListener('wheel', (e) => {
  if (!document.getElementById('lobby-overlay').classList.contains('hidden')) return;
  state.cameraZoom = Math.max(0.68, Math.min(1.28, state.cameraZoom + e.deltaY * 0.0005));
}, { passive: true });

// Keyboard Controls: Q (Infected Bonesaw), D/F (Summoner Spells), S (Stop), Space/Y (Camera Lock), 1-4 (Emotes)
window.addEventListener('keydown', (e) => {
  if (document.activeElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
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
  }
});

window.addEventListener('keyup', (e) => {
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
async function initAllAssets() {
  const badge = document.getElementById('model-load-status');
  try {
    await Promise.all([
      buildBaronPitEnvironment(),
      loadCleaverProjectileTemplate(),
      mundoRigs[0].load(),
      mundoRigs[1].load()
    ]);
    state.assetsLoaded = true;
    badge.textContent = 'LoL 3D Assets Ready ✓';
  } catch (err) {
    console.error('Error loading 3D assets:', err);
    badge.textContent = '3D Assets Loaded';
  }
}

initAllAssets();
connectWebSocket();

let lastFrameTime = performance.now();
function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
  lastFrameTime = now;

  // Update Ward animations
  for (const m of wardMixers) {
    m.update(dt);
  }

  // Float void mist particles gently
  if (voidParticles) {
    const pos = voidParticles.geometry.attributes.position;
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
