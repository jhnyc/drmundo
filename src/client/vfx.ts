import * as THREE from 'three';
import { CHAMPION_LIST, getChampionConfig } from '../shared/champions/index.js';
import type { ChampionId } from '../shared/types.js';
import {
  championRigs,
  getCachedProjectileTemplate,
  getCachedZoneMeshTemplate
} from './champion.js';
import { camera, renderer, scene, textureLoader, vfxTextures } from './scene.js';
import { state } from './state.js';

interface ActiveProjectileEntry {
  meshGroup: THREE.Group;
  spinner: THREE.Object3D;
  spinAxis: 'x' | 'y' | 'z';
  spinSpeed: number;
  materials: THREE.Material[];
}

interface ActiveGroundZoneEntry {
  group: THREE.Group;
  crackMesh: THREE.Mesh;
  fillMesh: THREE.Mesh;
  outerRing: THREE.Mesh;
  rockTimer: number;
  materials: THREE.Material[];
}

interface TransientVfxEntry {
  mesh: THREE.Object3D;
  age: number;
  duration: number;
  update(dt: number): void;
  onDispose?: () => void;
}

const activeProjectileMeshes = new Map<number, ActiveProjectileEntry>();
const activeGroundZoneMeshes = new Map<number, ActiveGroundZoneEntry>();
const transientVfx: TransientVfxEntry[] = [];
const seenProjIds = new Set<number>();
const seenZoneIds = new Set<number>();

// Cached champion VFX textures keyed by URL
const champTextureCache = new Map<string, THREE.Texture>();
// Retain prewarmed materials so Three.js WebGLPrograms refcounts stay > 0 permanently
const prewarmedVfxMats: THREE.Material[] = [];

/**
 * Create a single-pass transparent MeshBasicMaterial so DoubleSide VFX quads
 * never trigger Three.js two-pass BackSide/FrontSide shader splits at runtime.
 */
function createVfxBasicMat(
  params: THREE.MeshBasicMaterialParameters
): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    forceSinglePass: true,
    ...params
  });
}

// Single pooled THREE.Points particle system for all rock debris (1 draw call, zero allocations)
const MAX_DEBRIS = 96;
const debrisPositions = new Float32Array(MAX_DEBRIS * 3);
const debrisVelocities = new Float32Array(MAX_DEBRIS * 3);
const debrisAges = new Float32Array(MAX_DEBRIS);
const debrisDurations = new Float32Array(MAX_DEBRIS);
let debrisActiveCount = 0;

for (let i = 0; i < MAX_DEBRIS; i++) {
  debrisPositions[i * 3 + 1] = -9999;
}

const debrisGeo = new THREE.BufferGeometry();
const debrisPosAttr = new THREE.BufferAttribute(debrisPositions, 3);
debrisPosAttr.setUsage(THREE.DynamicDrawUsage);
debrisGeo.setAttribute('position', debrisPosAttr);

const debrisMat = new THREE.PointsMaterial({
  color: 0xc2b0d8,
  size: 26,
  sizeAttenuation: true,
  transparent: true,
  opacity: 0.9,
  depthWrite: false
});
const debrisPoints = new THREE.Points(debrisGeo, debrisMat);
debrisPoints.frustumCulled = false;
debrisPoints.visible = false;
scene.add(debrisPoints);

function extractTopLeftShardTexture(sourceTex: THREE.Texture): THREE.CanvasTexture | null {
  const img = sourceTex.image as HTMLImageElement | HTMLCanvasElement | undefined;
  if (!img || !img.width || !img.height) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, img.width / 2, img.height / 2, 0, 0, 64, 64);
  const cropped = new THREE.CanvasTexture(canvas);
  cropped.colorSpace = THREE.SRGBColorSpace;
  return cropped;
}

export async function loadChampionVfxTextures(): Promise<void> {
  const urls = new Set<string>();
  for (const champ of CHAMPION_LIST) {
    if (champ.q.archetype === 'delayed_ground_aoe') {
      const zv = champ.q.zoneVisual;
      if (zv.crackTextureUrl) urls.add(zv.crackTextureUrl);
      if (zv.indicatorTextureUrl) urls.add(zv.indicatorTextureUrl);
      if (zv.smokeTextureUrl) urls.add(zv.smokeTextureUrl);
      if (zv.auraTextureUrl) urls.add(zv.auraTextureUrl);
      if (zv.rockTextureUrl) urls.add(zv.rockTextureUrl);
    }
  }

  await Promise.all(
    Array.from(urls).map(async (url) => {
      try {
        const tex = await textureLoader.loadAsync(url);
        tex.colorSpace = THREE.SRGBColorSpace;
        champTextureCache.set(url, tex);

        if (url.includes('rockshards') && !debrisMat.map) {
          const singleTile = extractTopLeftShardTexture(tex);
          if (singleTile) {
            debrisMat.map = singleTile;
            debrisMat.needsUpdate = true;
          }
        }
      } catch {}
    })
  );
}

// Shared reusable geometries (never disposed per-effect, zero runtime allocations)
const sharedUnitRingGeo = new THREE.RingGeometry(0.7, 0.93, 28);
sharedUnitRingGeo.rotateX(-Math.PI / 2);

const sharedZoneOuterRingGeo = new THREE.RingGeometry(0.93, 1.0, 56);
sharedZoneOuterRingGeo.rotateX(-Math.PI / 2);

const sharedZoneRimCylinderGeo = new THREE.CylinderGeometry(1, 1, 16, 48, 1, true);

const sharedZoneFillGeo = new THREE.CircleGeometry(1, 48);
sharedZoneFillGeo.rotateX(-Math.PI / 2);

const sharedZoneDecalGeo = new THREE.PlaneGeometry(2.15, 2.15);
sharedZoneDecalGeo.rotateX(-Math.PI / 2);

const sharedSmokeRayGeo = new THREE.PlaneGeometry(0.85, 1.65);
sharedSmokeRayGeo.translate(0, 0.825, 0);

const sharedFallbackSpikeGeo = new THREE.ConeGeometry(16, 120, 5);
sharedFallbackSpikeGeo.translate(0, 60, 0);

const sharedProjFallbackGeo = new THREE.BoxGeometry(22, 55, 140);
const sharedOrbGeo = new THREE.SphereGeometry(1, 14, 12);

const sharedRingBurstGeo = new THREE.RingGeometry(1, 1.35, 36);
sharedRingBurstGeo.rotateX(-Math.PI / 2);

const sharedSkybeamGeo = new THREE.PlaneGeometry(1, 1);
sharedSkybeamGeo.translate(0, 0.5, 0);

const sharedFlashHaloGeo = new THREE.PlaneGeometry(185, 185);
sharedFlashHaloGeo.rotateX(-Math.PI / 2);

const sharedFlashStarGeo = new THREE.PlaneGeometry(155, 155);
sharedFlashStarGeo.rotateX(-Math.PI / 2);

const sharedHealBurst1Geo = new THREE.PlaneGeometry(230, 230);
sharedHealBurst1Geo.rotateX(-Math.PI / 2);

const sharedHealBurst2Geo = new THREE.PlaneGeometry(210, 210);
sharedHealBurst2Geo.rotateX(-Math.PI / 2);
sharedHealBurst2Geo.rotateY(Math.PI / 4);

const sharedHealBoltGeo = new THREE.CylinderGeometry(88, 64, 95, 28, 1, true);
const sharedGhostCylGeo = new THREE.CylinderGeometry(82, 54, 125, 24, 1, true);
const sharedGhostRibbonGeo = new THREE.PlaneGeometry(92, 42);

export function syncProjectiles(dt: number): void {
  seenProjIds.clear();

  for (const proj of state.serverProjectiles) {
    seenProjIds.add(proj.id);
    let entry = activeProjectileMeshes.get(proj.id);
    if (!entry) {
      const champ = getChampionConfig(proj.championId);
      const meshGroup = new THREE.Group();
      const materials: THREE.Material[] = [];
      let spinner: THREE.Object3D;
      let spinAxis: 'x' | 'y' | 'z' = 'x';
      let spinSpeed = 24;

      const qCfg = champ.q;
      if (qCfg.archetype === 'linear_projectile') {
        const vis = qCfg.projectileVisual;
        if (vis.kind === 'obj_model') {
          const tpl = getCachedProjectileTemplate(proj.championId);
          if (tpl) {
            spinner = tpl.clone();
          } else {
            const fallbackMat = new THREE.MeshStandardMaterial({ color: 0xd0e8ff, metalness: 0.8 });
            materials.push(fallbackMat);
            spinner = new THREE.Mesh(sharedProjFallbackGeo, fallbackMat);
          }
          spinAxis = vis.spinAxis;
          spinSpeed = vis.spinSpeed;
        } else {
          const orbMat = new THREE.MeshStandardMaterial({
            color: vis.coreColorHex,
            emissive: new THREE.Color(vis.glowColorHex),
            emissiveIntensity: 1.2,
            roughness: 0.2
          });
          materials.push(orbMat);
          const orbMesh = new THREE.Mesh(sharedOrbGeo, orbMat);
          orbMesh.scale.setScalar(vis.radius * 0.55);
          spinner = orbMesh;
          spinAxis = 'y';
          spinSpeed = 10;
        }
      } else {
        const fallbackMat = new THREE.MeshStandardMaterial({ color: 0xd0e8ff, metalness: 0.8 });
        materials.push(fallbackMat);
        spinner = new THREE.Mesh(sharedProjFallbackGeo, fallbackMat);
      }

      meshGroup.add(spinner);

      const ringMat = createVfxBasicMat({
        color: proj.ownerSlot === state.mySlot ? 0x26a9ff : 0xff4254,
        opacity: 0.55
      });
      materials.push(ringMat);
      const groundRing = new THREE.Mesh(sharedUnitRingGeo, ringMat);
      groundRing.scale.setScalar(proj.radius);
      groundRing.position.y = -62;
      meshGroup.add(groundRing);

      meshGroup.position.set(proj.x, 65, proj.z);
      meshGroup.rotation.y = Math.atan2(proj.dirX, proj.dirZ);
      scene.add(meshGroup);

      entry = { meshGroup, spinner, spinAxis, spinSpeed, materials };
      activeProjectileMeshes.set(proj.id, entry);
    } else {
      entry.meshGroup.position.x += proj.dirX * proj.speed * dt;
      entry.meshGroup.position.z += proj.dirZ * proj.speed * dt;
      const corr = Math.min(1, dt * 18);
      entry.meshGroup.position.x += (proj.x - entry.meshGroup.position.x) * corr;
      entry.meshGroup.position.z += (proj.z - entry.meshGroup.position.z) * corr;
      entry.meshGroup.rotation.y = Math.atan2(proj.dirX, proj.dirZ);
    }

    entry.spinner.rotation[entry.spinAxis] += dt * entry.spinSpeed;
  }

  for (const [id, entry] of activeProjectileMeshes.entries()) {
    if (!seenProjIds.has(id)) {
      scene.remove(entry.meshGroup);
      for (const m of entry.materials) m.dispose();
      activeProjectileMeshes.delete(id);
    }
  }
}

export function spawnCastAuraVfx(championId: ChampionId, x: number, z: number): void {
  const champ = getChampionConfig(championId);
  if (champ.q.archetype !== 'delayed_ground_aoe') return;
  const auraUrl = champ.q.zoneVisual.auraTextureUrl;
  const auraTex = auraUrl ? champTextureCache.get(auraUrl) : undefined;
  if (!auraTex) {
    spawnRingBurstVfx(x, z, champ.accentHex, 30, 120, 0.3);
    return;
  }

  const mat = createVfxBasicMat({
    map: auraTex,
    color: champ.q.zoneVisual.eruptColorHex,
    opacity: 0.85,
    blending: THREE.AdditiveBlending
  });
  const mesh = new THREE.Mesh(sharedZoneDecalGeo, mat);
  mesh.position.set(x, 4, z);
  mesh.scale.setScalar(55);
  scene.add(mesh);

  transientVfx.push({
    mesh,
    age: 0,
    duration: 0.36,
    update() {
      const t = this.age / this.duration;
      mesh.scale.setScalar(55 + t * 48);
      mat.opacity = 0.85 * (1 - t);
    },
    onDispose() {
      mat.dispose();
    }
  });
}

function spawnRockDebrisParticle(
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  _size: number,
  duration: number
): void {
  for (let i = 0; i < MAX_DEBRIS; i++) {
    if (debrisDurations[i] <= 0) {
      const idx = i * 3;
      debrisPositions[idx] = x;
      debrisPositions[idx + 1] = y;
      debrisPositions[idx + 2] = z;
      debrisVelocities[idx] = vx;
      debrisVelocities[idx + 1] = vy;
      debrisVelocities[idx + 2] = vz;
      debrisAges[i] = 0;
      debrisDurations[i] = duration;
      debrisActiveCount += 1;
      debrisPoints.visible = true;
      debrisPosAttr.needsUpdate = true;
      return;
    }
  }
}

function updateRockDebrisPool(dt: number): void {
  if (debrisActiveCount === 0) return;

  let active = 0;
  for (let i = 0; i < MAX_DEBRIS; i++) {
    const dur = debrisDurations[i];
    if (dur <= 0) continue;

    debrisAges[i] += dt;
    const idx = i * 3;
    if (debrisAges[i] >= dur) {
      debrisDurations[i] = 0;
      debrisPositions[idx + 1] = -9999;
      continue;
    }

    active += 1;
    debrisVelocities[idx + 1] -= 420 * dt;
    debrisPositions[idx] += debrisVelocities[idx] * dt;
    debrisPositions[idx + 1] = Math.max(4, debrisPositions[idx + 1] + debrisVelocities[idx + 1] * dt);
    debrisPositions[idx + 2] += debrisVelocities[idx + 2] * dt;
  }

  debrisActiveCount = active;
  debrisPosAttr.needsUpdate = true;
  if (active === 0) {
    debrisPoints.visible = false;
  }
}

export function syncGroundZones(dt: number): void {
  seenZoneIds.clear();

  for (const zone of state.serverGroundZones) {
    seenZoneIds.add(zone.id);
    let entry = activeGroundZoneMeshes.get(zone.id);
    const isAlly = zone.ownerSlot === state.mySlot;
    const champ = getChampionConfig(zone.championId);
    const zv = champ.q.archetype === 'delayed_ground_aoe' ? champ.q.zoneVisual : null;

    if (!entry) {
      const group = new THREE.Group();
      group.position.set(zone.x, 2.5, zone.z);

      const materials: THREE.Material[] = [];
      const teamColor = isAlly ? 0x26a9ff : 0xff2b3d;

      // 1. Official Riot ground crack fissures decal (blended dark into pit floor)
      const crackTex = zv?.crackTextureUrl ? champTextureCache.get(zv.crackTextureUrl) : undefined;
      const crackMat = createVfxBasicMat({
        map: crackTex || undefined,
        color: isAlly ? 0x6f558f : 0x804658,
        opacity: 0.72
      });
      materials.push(crackMat);
      const crackMesh = new THREE.Mesh(sharedZoneDecalGeo, crackMat);
      crackMesh.scale.setScalar(zone.radius);
      crackMesh.rotation.y = (zone.id * 1.37) % (Math.PI * 2);
      group.add(crackMesh);

      // 2. Official Riot indicator rim glow cylinder + crisp outer team circle
      const indTex = zv?.indicatorTextureUrl ? champTextureCache.get(zv.indicatorTextureUrl) : undefined;
      if (indTex) {
        const indMat = createVfxBasicMat({
          map: indTex,
          color: isAlly ? 0x9b6eff : 0xff3048,
          opacity: 0.95,
          blending: THREE.AdditiveBlending
        });
        materials.push(indMat);
        const indRim = new THREE.Mesh(sharedZoneRimCylinderGeo, indMat);
        indRim.scale.set(zone.radius, 1.4, zone.radius);
        indRim.position.y = 8;
        group.add(indRim);
      }

      const outerMat = createVfxBasicMat({
        color: teamColor,
        opacity: 0.92
      });
      materials.push(outerMat);
      const outerRing = new THREE.Mesh(sharedZoneOuterRingGeo, outerMat);
      outerRing.scale.setScalar(zone.radius);
      outerRing.position.y = 1.2;
      group.add(outerRing);

      // 3. Expanding detonation timer fill
      const fillMat = createVfxBasicMat({
        color: isAlly ? 0x6236ff : 0xff1e3c,
        opacity: 0.22,
        blending: THREE.AdditiveBlending
      });
      materials.push(fillMat);
      const fillMesh = new THREE.Mesh(sharedZoneFillGeo, fillMat);
      fillMesh.position.y = 0.6;
      group.add(fillMesh);

      scene.add(group);
      entry = { group, crackMesh, fillMesh, outerRing, rockTimer: 0, materials };
      activeGroundZoneMeshes.set(zone.id, entry);
    }

    const progress =
      zone.duration > 0 ? Math.max(0.05, Math.min(1, 1 - zone.remaining / zone.duration)) : 1;
    entry.fillMesh.scale.setScalar(zone.radius * progress);

    // Subtle ground tremor + pebble bounce right before eruption
    const tremor = progress * 3.5;
    entry.crackMesh.position.set(
      (Math.random() - 0.5) * tremor,
      0,
      (Math.random() - 0.5) * tremor
    );

    entry.rockTimer -= dt;
    if (entry.rockTimer <= 0) {
      entry.rockTimer = 0.085;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * zone.radius * 0.85;
      spawnRockDebrisParticle(
        zone.x + Math.cos(a) * r,
        6,
        zone.z + Math.sin(a) * r,
        (Math.random() - 0.5) * 40,
        75 + Math.random() * 70,
        (Math.random() - 0.5) * 40,
        16 + Math.random() * 14,
        0.28
      );
    }
  }

  for (const [id, entry] of activeGroundZoneMeshes.entries()) {
    if (!seenZoneIds.has(id)) {
      scene.remove(entry.group);
      for (const m of entry.materials) m.dispose();
      activeGroundZoneMeshes.delete(id);
    }
  }
}

export function spawnZoneEruptionVfx(
  championId: ChampionId,
  x: number,
  z: number,
  radius: number
): void {
  const champ = getChampionConfig(championId);
  const zv = champ.q.archetype === 'delayed_ground_aoe' ? champ.q.zoneVisual : null;
  const eruptColor = zv?.eruptColorHex ?? 0xb833ff;

  spawnRingBurstVfx(x, z, eruptColor, radius * 0.3, radius * 1.15, 0.38);

  // 1. Lingering shattered ground crack crater
  const crackTex = zv?.crackTextureUrl ? champTextureCache.get(zv.crackTextureUrl) : undefined;
  if (crackTex) {
    const craterMat = createVfxBasicMat({
      map: crackTex,
      color: 0x735b8a,
      opacity: 0.8
    });
    const crater = new THREE.Mesh(sharedZoneDecalGeo, craterMat);
    crater.position.set(x, 2.5, z);
    crater.scale.setScalar(radius);
    crater.rotation.y = Math.random() * Math.PI * 2;
    scene.add(crater);

    transientVfx.push({
      mesh: crater,
      age: 0,
      duration: 0.85,
      update() {
        const t = this.age / this.duration;
        craterMat.opacity = 0.92 * (1 - Math.pow(t, 1.8));
      },
      onDispose() {
        craterMat.dispose();
      }
    });
  }

  // 2. Official Riot 3D Rupture spike cluster mesh (chogath_q_spikes.obj)
  const spikeTemplate = getCachedZoneMeshTemplate(championId);
  const spikeGroup = new THREE.Group();
  spikeGroup.position.set(x, 0, z);
  const baseRadius = zv?.meshBaseRadius || 116.5;
  const horizScale = radius / baseRadius;
  const vertScale = horizScale * 1.45;
  const spikeMats: THREE.Material[] = [];

  if (spikeTemplate) {
    const clone = spikeTemplate.clone();
    clone.traverse((child: THREE.Object3D) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        if (mesh.material && !Array.isArray(mesh.material)) {
          const mat = mesh.material.clone();
          mesh.material = mat;
          spikeMats.push(mat);
        }
      }
    });
    clone.rotation.y = Math.random() * Math.PI * 2;
    spikeGroup.add(clone);
  } else {
    const fallbackMat = new THREE.MeshStandardMaterial({
      color: zv?.spikeColorHex ?? 0xdfd0f7,
      emissive: new THREE.Color(eruptColor),
      emissiveIntensity: 0.5,
      transparent: true,
      opacity: 0.96
    });
    spikeMats.push(fallbackMat);
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(sharedFallbackSpikeGeo, fallbackMat);
      const a = (i / 8) * Math.PI * 2;
      const r = i === 0 ? 0 : baseRadius * 0.55;
      m.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      spikeGroup.add(m);
    }
  }

  spikeGroup.scale.set(horizScale, 0.05, horizScale);
  spikeGroup.position.y = -95;
  scene.add(spikeGroup);

  transientVfx.push({
    mesh: spikeGroup,
    age: 0,
    duration: 0.72,
    update() {
      const t = this.age / this.duration;
      let yFactor: number;
      if (t < 0.14) {
        // Violent upward eruption
        const k = t / 0.14;
        yFactor = 1 - Math.pow(1 - k, 3);
      } else if (t < 0.58) {
        // Hold jagged spikes protruding from ground
        yFactor = 1;
      } else {
        // Sink cleanly back into earth
        const k = (t - 0.58) / 0.42;
        yFactor = Math.max(0.05, 1 - k * k);
      }
      spikeGroup.scale.set(horizScale, vertScale * yFactor, horizScale);
      spikeGroup.position.y = -95 * (1 - yFactor);
      const opacity = t > 0.7 ? Math.max(0, 1 - (t - 0.7) / 0.3) : 1;
      for (const m of spikeMats) {
        m.opacity = opacity;
      }
    },
    onDispose() {
      for (const m of spikeMats) m.dispose();
    }
  });

  // 3. Official Riot Void smoke rays shooting up from the rupture (single shared material)
  const smokeTex = zv?.smokeTextureUrl ? champTextureCache.get(zv.smokeTextureUrl) : undefined;
  if (smokeTex) {
    const smokeGroup = new THREE.Group();
    smokeGroup.position.set(x, 0, z);
    const smokeMat = createVfxBasicMat({
      map: smokeTex,
      color: eruptColor,
      opacity: 0.72,
      blending: THREE.AdditiveBlending
    });
    for (let i = 0; i < 3; i++) {
      const plane = new THREE.Mesh(sharedSmokeRayGeo, smokeMat);
      plane.rotation.y = (i * Math.PI) / 3;
      plane.scale.set(radius * 1.4, radius * 1.35, 1);
      smokeGroup.add(plane);
    }
    scene.add(smokeGroup);

    transientVfx.push({
      mesh: smokeGroup,
      age: 0,
      duration: 0.48,
      update() {
        const t = this.age / this.duration;
        smokeGroup.scale.set(1 + t * 0.25, 1 + t * 0.35, 1 + t * 0.25);
        smokeMat.opacity = 0.72 * Math.pow(1 - t, 1.4);
      },
      onDispose() {
        smokeMat.dispose();
      }
    });
  }

  // 4. Flying rock shards & Void sparkles
  for (let i = 0; i < 14; i++) {
    const angle = (i / 14) * Math.PI * 2 + Math.random() * 0.35;
    const r = Math.random() * radius * 0.75;
    spawnRockDebrisParticle(
      x + Math.cos(angle) * r,
      18,
      z + Math.sin(angle) * r,
      Math.cos(angle) * (65 + Math.random() * 90),
      200 + Math.random() * 170,
      Math.sin(angle) * (65 + Math.random() * 90),
      22 + Math.random() * 18,
      0.55 + Math.random() * 0.22
    );
  }
}

export function spawnRingBurstVfx(
  x: number,
  z: number,
  colorHex: number,
  startR = 20,
  endR = 135,
  duration = 0.42
): void {
  const mat = createVfxBasicMat({
    color: colorHex,
    opacity: 0.9,
    blending: THREE.AdditiveBlending
  });
  const mesh = new THREE.Mesh(sharedRingBurstGeo, mat);
  mesh.position.set(x, 6, z);
  const baseScale = Math.max(1, startR);
  mesh.scale.setScalar(baseScale);
  scene.add(mesh);

  const scaleRatio = endR / baseScale;
  transientVfx.push({
    mesh,
    age: 0,
    duration,
    update() {
      const t = this.age / this.duration;
      const s = baseScale * (1 + (scaleRatio - 1) * (1 - Math.pow(1 - t, 2)));
      this.mesh.scale.setScalar(s);
      mat.opacity = 0.9 * (1 - t);
    },
    onDispose() {
      mat.dispose();
    }
  });
}

let moveArrowBladeGeo: THREE.BufferGeometry | null = null;
let moveArrowTexture: THREE.CanvasTexture | null = null;

function getMoveArrowAssets(): { geo: THREE.BufferGeometry; tex: THREE.CanvasTexture } {
  if (!moveArrowBladeGeo) {
    const segments = 12;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i <= segments; i++) {
      const s = i / segments;
      const r = 46 * (1 - s) + 3 * s;
      const y = 44 * Math.pow(1 - s, 1.55) + 2;

      let halfW: number;
      if (s < 0.65) {
        const k = s / 0.65;
        halfW = 10.5 * (1 - k) + 4.2 * k;
      } else if (s < 0.78) {
        const k = (s - 0.65) / 0.13;
        halfW = 4.2 * (1 - k) + 8.8 * k;
      } else {
        const k = (s - 0.78) / 0.22;
        halfW = 8.8 * (1 - k) + 0.3 * k;
      }

      positions.push(r, y, -halfW);
      uvs.push(s, 0);
      positions.push(r, y, halfW);
      uvs.push(s, 1);

      if (i < segments) {
        const base = i * 2;
        indices.push(base, base + 1, base + 2);
        indices.push(base + 1, base + 3, base + 2);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    moveArrowBladeGeo = geo;
  }

  if (!moveArrowTexture) {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    const grad = ctx.createLinearGradient(0, 0, 0, 64);
    grad.addColorStop(0, '#0b5c0b');
    grad.addColorStop(0.14, '#38ff24');
    grad.addColorStop(0.5, '#7bff52');
    grad.addColorStop(0.86, '#38ff24');
    grad.addColorStop(1, '#0b5c0b');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);

    ctx.fillStyle = 'rgba(10, 70, 10, 0.75)';
    ctx.fillRect(0, 0, 4, 64);
    ctx.fillRect(60, 0, 4, 64);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    moveArrowTexture = tex;
  }

  return { geo: moveArrowBladeGeo, tex: moveArrowTexture };
}

export function spawnMoveClickIndicator(x: number, z: number): void {
  const { geo, tex } = getMoveArrowAssets();
  const group = new THREE.Group();
  group.position.set(x, 2, z);

  const mat = createVfxBasicMat({
    map: tex,
    color: 0xffffff,
    opacity: 0.96
  });

  const angles = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  for (const ang of angles) {
    const blade = new THREE.Mesh(geo, mat);
    blade.rotation.y = ang;
    group.add(blade);
  }

  scene.add(group);

  const duration = 0.34;
  transientVfx.push({
    mesh: group,
    age: 0,
    duration,
    update() {
      const t = this.age / this.duration;
      const ease = 1 - Math.pow(1 - t, 2);
      const s = 1.05 - 0.68 * ease;
      group.scale.setScalar(s);
      mat.opacity = t < 0.45 ? 0.96 : 0.96 * (1 - (t - 0.45) / 0.55);
    },
    onDispose() {
      mat.dispose();
    }
  });
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
    const mat = createVfxBasicMat({
      map: vfxTextures.skybeamGlow || undefined,
      color: colorHex,
      opacity: 0.92,
      blending: THREE.AdditiveBlending
    });
    const plane = new THREE.Mesh(sharedSkybeamGeo, mat);
    plane.scale.set(width, height, 1);
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
    },
    onDispose() {
      mat.dispose();
    }
  });
}

function spawnFlashBurstAtPoint(x: number, z: number, isDestination: boolean): void {
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
    },
    onDispose() {
      for (const m of beamMats) m.dispose();
    }
  });

  const burstGroup = new THREE.Group();
  burstGroup.position.set(x, 4, z);

  const haloMat = createVfxBasicMat({
    map: vfxTextures.flashHalo || vfxTextures.flashBurst || undefined,
    color: 0xffb82e,
    opacity: 0.9,
    blending: THREE.AdditiveBlending
  });
  burstGroup.add(new THREE.Mesh(sharedFlashHaloGeo, haloMat));

  const starMat = createVfxBasicMat({
    map: vfxTextures.flashBurst || undefined,
    color: 0xfff59e,
    opacity: 0.98,
    blending: THREE.AdditiveBlending
  });
  const starMesh = new THREE.Mesh(sharedFlashStarGeo, starMat);
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
    },
    onDispose() {
      haloMat.dispose();
      starMat.dispose();
    }
  });

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

export function spawnFlashVfx(
  slot: number,
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number
): void {
  const rig = championRigs[slot];
  if (rig) {
    rig.triggerFlashBlink(toX, toZ);
  }

  spawnFlashBurstAtPoint(fromX, fromZ, false);
  spawnFlashBurstAtPoint(toX, toZ, true);

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

export function spawnHealVfx(slot: number, x: number, z: number): void {
  const rig = championRigs[slot];
  if (rig) {
    rig.triggerHealOverlay();
  }

  const healGroup = new THREE.Group();
  healGroup.position.set(x, 5, z);

  const burstMat1 = createVfxBasicMat({
    map: vfxTextures.flashBurst || undefined,
    color: 0x2eff5e,
    opacity: 0.95,
    blending: THREE.AdditiveBlending
  });
  const burstMesh1 = new THREE.Mesh(sharedHealBurst1Geo, burstMat1);
  healGroup.add(burstMesh1);

  const burstMat2 = createVfxBasicMat({
    map: vfxTextures.flashBurst || undefined,
    color: 0x7dffaa,
    opacity: 0.88,
    blending: THREE.AdditiveBlending
  });
  const burstMesh2 = new THREE.Mesh(sharedHealBurst2Geo, burstMat2);
  burstMesh2.position.y = 2;
  healGroup.add(burstMesh2);

  const boltMat = createVfxBasicMat({
    map: vfxTextures.healBolts || vfxTextures.healWisps || undefined,
    color: 0x39ff7a,
    opacity: 0.9,
    blending: THREE.AdditiveBlending
  });
  const boltCylinder = new THREE.Mesh(sharedHealBoltGeo, boltMat);
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
    },
    onDispose() {
      burstMat1.dispose();
      burstMat2.dispose();
      boltMat.dispose();
    }
  });

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

export function spawnGhostVfx(_slot: number, x: number, z: number): void {
  const group = new THREE.Group();
  group.position.set(x, 65, z);

  const cylMat = createVfxBasicMat({
    map: vfxTextures.hasteShockwave || vfxTextures.ghostTrail || undefined,
    color: 0x22d8ff,
    opacity: 0.92,
    blending: THREE.AdditiveBlending
  });
  const shockMesh = new THREE.Mesh(sharedGhostCylGeo, cylMat);
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
    },
    onDispose() {
      cylMat.dispose();
    }
  });
}

export function spawnGhostTrailStep(x: number, z: number, facingAngle: number): void {
  const backX = -Math.sin(facingAngle);
  const backZ = -Math.cos(facingAngle);
  const sideX = Math.cos(facingAngle);
  const sideZ = -Math.sin(facingAngle);

  const ribbonMat = createVfxBasicMat({
    map: vfxTextures.ghostTrail || vfxTextures.hasteShockwave || undefined,
    color: 0x24c8ff,
    opacity: 0.68,
    blending: THREE.AdditiveBlending
  });
  const ribbon = new THREE.Mesh(sharedGhostRibbonGeo, ribbonMat);
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
    },
    onDispose() {
      ribbonMat.dispose();
    }
  });

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
    },
    onDispose() {
      orbMat.dispose();
    }
  });
}

export function updateTransientVfx(dt: number): void {
  updateRockDebrisPool(dt);
  for (let i = transientVfx.length - 1; i >= 0; i--) {
    const vfx = transientVfx[i];
    vfx.age += dt;
    if (vfx.age >= vfx.duration) {
      scene.remove(vfx.mesh);
      vfx.onDispose?.();
      transientVfx.splice(i, 1);
    } else {
      vfx.update(dt);
    }
  }
}

/**
 * Compile and keep alive all VFX shader programs + GPU textures during startup
 * loading so casting abilities or summoner spells never triggers mid-match stutters.
 */
export function prewarmAllVfxShaders(): void {
  if (prewarmedVfxMats.length > 0) return;

  for (const tex of Object.values(vfxTextures)) {
    if (tex) renderer.initTexture(tex);
  }
  for (const tex of champTextureCache.values()) {
    renderer.initTexture(tex);
  }

  const warmupGroup = new THREE.Group();
  warmupGroup.position.set(0, 5, 0);
  warmupGroup.scale.setScalar(0.0001);

  const basicNormal = createVfxBasicMat({
    map: vfxTextures.flashBurst || undefined
  });
  const basicAdd = createVfxBasicMat({
    map: vfxTextures.skybeamGlow || undefined,
    blending: THREE.AdditiveBlending
  });
  const basicAddSolid = createVfxBasicMat({
    color: 0xffffff,
    blending: THREE.AdditiveBlending
  });
  const basicSolidRing = createVfxBasicMat({
    color: 0xffffff
  });
  const spriteAdd = new THREE.SpriteMaterial({
    map: vfxTextures.flashSpark || undefined,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  prewarmedVfxMats.push(basicNormal, basicAdd, basicAddSolid, basicSolidRing, spriteAdd);

  warmupGroup.add(new THREE.Mesh(sharedZoneDecalGeo, basicNormal));
  warmupGroup.add(new THREE.Mesh(sharedSmokeRayGeo, basicAdd));
  warmupGroup.add(new THREE.Mesh(sharedZoneFillGeo, basicAddSolid));
  warmupGroup.add(new THREE.Mesh(sharedRingBurstGeo, basicSolidRing));
  warmupGroup.add(new THREE.Sprite(spriteAdd));

  for (const champ of CHAMPION_LIST) {
    const projTpl = getCachedProjectileTemplate(champ.id);
    if (projTpl) {
      const clone = projTpl.clone();
      clone.traverse((child: THREE.Object3D) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh && mesh.material && !Array.isArray(mesh.material)) {
          prewarmedVfxMats.push(mesh.material);
        }
      });
      warmupGroup.add(clone);
    }
    const zoneTpl = getCachedZoneMeshTemplate(champ.id);
    if (zoneTpl) {
      const clone = zoneTpl.clone();
      clone.traverse((child: THREE.Object3D) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh && mesh.material && !Array.isArray(mesh.material)) {
          prewarmedVfxMats.push(mesh.material);
        }
      });
      warmupGroup.add(clone);
    }
  }

  warmupGroup.traverse((child: THREE.Object3D) => {
    child.frustumCulled = false;
  });

  const prevDebrisVis = debrisPoints.visible;
  debrisPoints.visible = true;
  scene.add(warmupGroup);
  renderer.compile(scene, camera);
  // Perform one micro draw pass so ANGLE/Metal also builds final GPU pipelines upfront
  renderer.render(scene, camera);
  scene.remove(warmupGroup);
  debrisPoints.visible = prevDebrisVis;
}

// ============================================================================
// DYNAMIC SKILLSHOT INDICATOR (LINE OR GROUND AOE CIRCLE PER CHAMPION)
// ============================================================================
const lineIndicatorGroup = new THREE.Group();
lineIndicatorGroup.visible = false;
scene.add(lineIndicatorGroup);

const lineIndicatorMat = createVfxBasicMat({
  color: 0x0ac8b9,
  opacity: 0.32
});
const lineGeoCache = new Map<string, THREE.PlaneGeometry>();
const lineIndicatorMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), lineIndicatorMat);
lineIndicatorMesh.position.y = 4;
lineIndicatorGroup.add(lineIndicatorMesh);

const circleRangeRingGeo = new THREE.RingGeometry(0.985, 1.0, 64);
circleRangeRingGeo.rotateX(-Math.PI / 2);
const circleRangeRingMat = createVfxBasicMat({
  color: 0x0ac8b9,
  opacity: 0.42
});
const circleRangeMesh = new THREE.Mesh(circleRangeRingGeo, circleRangeRingMat);
circleRangeMesh.visible = false;
circleRangeMesh.position.y = 3;
scene.add(circleRangeMesh);

const circleTargetGroup = new THREE.Group();
circleTargetGroup.visible = false;
scene.add(circleTargetGroup);

const circleTargetFillMat = createVfxBasicMat({
  color: 0xb833ff,
  opacity: 0.25
});
const circleTargetFill = new THREE.Mesh(sharedZoneFillGeo, circleTargetFillMat);
circleTargetFill.position.y = 4;
circleTargetGroup.add(circleTargetFill);

const circleTargetRimMat = createVfxBasicMat({
  color: 0x0ac8b9,
  opacity: 0.88
});
const circleTargetRim = new THREE.Mesh(sharedZoneOuterRingGeo, circleTargetRimMat);
circleTargetRim.position.y = 4.5;
circleTargetGroup.add(circleTargetRim);

export function updateSkillshotIndicator(): void {
  const myPlayer = state.serverPlayers[state.mySlot];
  if (
    !state.showSkillshotIndicator ||
    !myPlayer ||
    !myPlayer.alive ||
    state.roomState !== 'playing'
  ) {
    lineIndicatorGroup.visible = false;
    circleRangeMesh.visible = false;
    circleTargetGroup.visible = false;
    return;
  }

  const champ = getChampionConfig(myPlayer.championId);
  const ind = champ.q.indicator;

  if (ind.shape === 'line') {
    circleRangeMesh.visible = false;
    circleTargetGroup.visible = false;
    lineIndicatorGroup.visible = true;

    const key = `${ind.width}x${ind.range}`;
    let geo = lineGeoCache.get(key);
    if (!geo) {
      geo = new THREE.PlaneGeometry(ind.width, ind.range);
      geo.translate(0, ind.range / 2, 0);
      geo.rotateX(-Math.PI / 2);
      lineGeoCache.set(key, geo);
    }
    if (lineIndicatorMesh.geometry !== geo) {
      lineIndicatorMesh.geometry = geo;
    }
    lineIndicatorMat.color.setHex(ind.colorHex);

    lineIndicatorGroup.position.set(myPlayer.x, 0, myPlayer.z);
    const dx = state.mouseWorld.x - myPlayer.x;
    const dz = state.mouseWorld.z - myPlayer.z;
    lineIndicatorGroup.rotation.y = Math.atan2(dx, dz) + Math.PI;
    return;
  }

  lineIndicatorGroup.visible = false;
  circleRangeMesh.visible = true;
  circleRangeMesh.position.set(myPlayer.x, 3, myPlayer.z);
  circleRangeMesh.scale.setScalar(ind.range);
  circleRangeRingMat.color.setHex(0x0ac8b9);

  circleTargetGroup.visible = true;
  const dx = state.mouseWorld.x - myPlayer.x;
  const dz = state.mouseWorld.z - myPlayer.z;
  const dist = Math.hypot(dx, dz);
  const clampedDist = Math.min(dist, ind.range);
  const tx = dist > 1e-3 ? myPlayer.x + (dx / dist) * clampedDist : myPlayer.x;
  const tz = dist > 1e-3 ? myPlayer.z + (dz / dist) * clampedDist : myPlayer.z;

  circleTargetGroup.position.set(tx, 0, tz);
  circleTargetFill.scale.setScalar(ind.radius);
  circleTargetRim.scale.setScalar(ind.radius);
  circleTargetFillMat.color.setHex(ind.colorHex);
  circleTargetRimMat.color.setHex(0x0ac8b9);
}
