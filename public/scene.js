import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { INV_SQRT2, LOL_SCALE, PIT_RADIUS, getEl, state } from './state.js';
const container = getEl('game-canvas-container');
export const renderer = new THREE.WebGLRenderer({
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
export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050b14);
scene.fog = new THREE.FogExp2(0x07101e, 0.00014);
// Authentic League of Legends ~55-degree isometric camera
export const camera = new THREE.PerspectiveCamera(36, window.innerWidth / window.innerHeight, 30, 12000);
export function updateCameraTransform(dt = 0.016) {
    const myPlayer = state.serverPlayers[state.mySlot];
    if (state.cameraLocked && myPlayer && state.roomState === 'playing') {
        const targetX = myPlayer.x * 0.45;
        const targetZ = myPlayer.z * 0.45;
        state.cameraFocus.x += (targetX - state.cameraFocus.x) * Math.min(1, dt * 8);
        state.cameraFocus.z += (targetZ - state.cameraFocus.z) * Math.min(1, dt * 8);
    }
    else {
        state.cameraFocus.x += (0 - state.cameraFocus.x) * Math.min(1, dt * 5);
        state.cameraFocus.z += (0 - state.cameraFocus.z) * Math.min(1, dt * 5);
    }
    const distY = 2050 * state.cameraZoom;
    const distZ = 1380 * state.cameraZoom;
    camera.position.set(state.cameraFocus.x, distY, state.cameraFocus.z + distZ);
    camera.lookAt(state.cameraFocus.x, 0, state.cameraFocus.z - 55);
}
updateCameraTransform();
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
const baronVoidLight = new THREE.PointLight(0xb24bf3, 3.2, 1650, 1.4);
baronVoidLight.position.set(420, 180, -420);
scene.add(baronVoidLight);
const riverRimLight = new THREE.PointLight(0x0ac8b9, 1.8, 1500, 1.5);
riverRimLight.position.set(-550, 160, 550);
scene.add(riverRimLight);
export const groundRayPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
export const raycaster = new THREE.Raycaster();
export const textureLoader = new THREE.TextureLoader();
const ktx2Loader = new KTX2Loader()
    .setTranscoderPath('/three/examples/jsm/libs/basis/')
    .detectSupport(renderer);
export const gltfLoader = new GLTFLoader();
gltfLoader.setKTX2Loader(ktx2Loader);
gltfLoader.setMeshoptDecoder(MeshoptDecoder);
export const objLoader = new OBJLoader();
export const arenaGroup = new THREE.Group();
scene.add(arenaGroup);
export const wardMixers = [];
export let voidParticles = null;
export async function buildBaronPitEnvironment() {
    const groundTex = await textureLoader.loadAsync('/assets/map/baron_pit_ground_clean.png');
    groundTex.colorSpace = THREE.SRGBColorSpace;
    groundTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const planeSize = 4450;
    const offsetX = -(0.5908 - 0.5) * planeSize;
    const offsetZ = (0.6143 - 0.5) * planeSize;
    const groundGeo = new THREE.PlaneGeometry(planeSize, planeSize, 160, 160);
    groundGeo.rotateX(-Math.PI / 2);
    const posAttr = groundGeo.attributes.position;
    for (let i = 0; i < posAttr.count; i++) {
        const vx = posAttr.getX(i) + offsetX;
        const vz = posAttr.getZ(i) + offsetZ;
        const r = Math.hypot(vx, vz);
        const angle = Math.atan2(vz, vx);
        const angleDiffFromRiver = Math.atan2(Math.sin(angle - 2.35619), Math.cos(angle - 2.35619));
        const absRiverAngle = Math.abs(angleDiffFromRiver);
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
    try {
        const [, sightWardObj, sightWardTex] = await Promise.all([
            gltfLoader.loadAsync('/assets/models/jammerdevice.glb'),
            objLoader.loadAsync('/assets/models/sightward.obj'),
            textureLoader.loadAsync('/assets/models/sightward_tx.png')
        ]);
        sightWardTex.colorSpace = THREE.SRGBColorSpace;
        sightWardObj.traverse((child) => {
            if (child.isMesh) {
                const mesh = child;
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
                const cwGltf = await gltfLoader.loadAsync('/assets/models/jammerdevice.glb');
                const cw = cwGltf.scene;
                cw.scale.setScalar(LOL_SCALE * 0.95);
                cw.position.set(wx, 2, wz);
                cw.rotation.y = Math.PI / 4;
                cw.traverse((ch) => {
                    if (ch.isMesh) {
                        const mesh = ch;
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
                    const idleClip = cwGltf.animations.find((a) => a.name.includes('Idle')) ||
                        cwGltf.animations[0];
                    if (idleClip)
                        mixer.clipAction(idleClip).play();
                    wardMixers.push(mixer);
                }
            }
            else {
                const sw = sightWardObj.clone();
                sw.scale.setScalar(0.85);
                sw.position.set(wx, 2, wz);
                sw.rotation.y = -Math.PI / 4;
                arenaGroup.add(sw);
            }
        }
    }
    catch (err) {
        console.warn('Ward models load warning:', err);
    }
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
export const vfxTextures = {
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
export async function loadVfxTextures() {
    const loadTex = async (url) => {
        try {
            const t = await textureLoader.loadAsync(url);
            t.colorSpace = THREE.SRGBColorSpace;
            return t;
        }
        catch {
            return null;
        }
    };
    const [flashBurst, flashHalo, flashSpark, skybeamGlow, healBolts, healSparkles, healWisps, ghostTrail, hasteShockwave, recallRing] = await Promise.all([
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
