import * as THREE from 'three';
import { cleaverTemplateMesh, mundoRigs } from './champion.js';
import { scene, vfxTextures } from './scene.js';
import { Q_RADIUS, Q_RANGE, state } from './state.js';

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

export function syncProjectiles(dt: number): void {
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

    entry.spinner.rotation.x += dt * 24;
  }

  for (const [id, entry] of activeProjectileMeshes.entries()) {
    if (!seenIds.has(id)) {
      scene.remove(entry.meshGroup);
      activeProjectileMeshes.delete(id);
    }
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

    // Subtle dark border on outer and inner ends
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

  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    color: 0xffffff,
    transparent: true,
    opacity: 0.96,
    side: THREE.DoubleSide,
    depthWrite: false
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
  const rig = mundoRigs[slot];
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
  const rig = mundoRigs[slot];
  if (rig) {
    rig.triggerHealOverlay();
  }

  const healGroup = new THREE.Group();
  healGroup.position.set(x, 5, z);

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

export function spawnGhostTrailStep(x: number, z: number, facingAngle: number): void {
  const backX = -Math.sin(facingAngle);
  const backZ = -Math.cos(facingAngle);
  const sideX = Math.cos(facingAngle);
  const sideZ = -Math.sin(facingAngle);

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

export function updateTransientVfx(dt: number): void {
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

export function updateSkillshotIndicator(): void {
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
